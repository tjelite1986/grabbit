// Extractor for tik.porn
//
// Next.js site. Model/profile pages (e.g. /lillie-lucas.xuy) embed __NEXT_DATA__
// with the profile {id, type, name}. The API lists a profile's clips:
//   GET https://apiv2.tik.porn/get<type>videos?<type>id=<id>&limit=&offset=
//   -> data.videos.content[], each with a signed direct `download_url` (mp4),
//      `action_name`, `keywords`, `poster_url`. download_url is time-limited, so
//      it is always resolved fresh at download time.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://tik.porn/';

function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function match(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'tik.porn';
  } catch {
    return false;
  }
}

// Model pages look like /<slug>.<entropy> (e.g. /lillie-lucas.xuy); videos are
// /video/<id>. Treat the dotted-slug form as a profile.
function isProfile(url) {
  try {
    const p = new URL(url).pathname;
    return /^\/[A-Za-z0-9-]+\.[A-Za-z0-9]+\/?$/.test(p) && !p.startsWith('/video/');
  } catch {
    return false;
  }
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__ on page');
  return JSON.parse(m[1]);
}

// tik.porn has no real caption, but each clip has a descriptive SEO meta_title
// like "Lillie Lucas Teasing and Upskirt Leaked Solo PAWG | Tik.Porn". Strip the
// creator prefix and the "| Tik.Porn" suffix to get a readable title.
function metaTitle(v, creatorName) {
  const mt =
    v.video_text && v.video_text.meta_title && v.video_text.meta_title.default
      ? v.video_text.meta_title.default.text
      : '';
  let t = String(mt || '').replace(/\s*\|\s*Tik\.?\s*Porn\s*$/i, '');
  if (creatorName) {
    const esc = creatorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('^' + esc + '\\s+', 'i'), '');
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t || v.action_name || String(v.video_id);
}

// Build a job from an apiv2 video object. creatorName is the original profile
// name (used only to strip it out of the meta title).
function jobFromApiVideo(v, creator, creatorName) {
  const id = String(v.video_id);
  const keywords = Array.isArray(v.keywords) ? v.keywords : [];
  const tags = keywords.map((k) => '#' + String(k).toLowerCase().replace(/[^a-z0-9]+/g, ''));
  return {
    kind: 'direct',
    id,
    creator,
    title: metaTitle(v, creatorName || creator),
    description: '',
    tags,
    sourceUrl: `https://tik.porn/video/${id}`,
    thumbnail: v.poster_url || v.medium_thumb || null,
    filename: `${creator}-${id}.mp4`,
    downloadUrl: v.download_url || v.mp4_url,
    headers: { 'User-Agent': UA, Referer: REFERER },
  };
}

async function fetchProfile(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const data = nextData(await res.text());
  const profile = data && data.props && data.props.pageProps && data.props.pageProps.profile;
  if (!profile || !profile.id || !profile.type) throw new Error('no profile found on page');
  return profile;
}

async function resolveProfile(url) {
  const profile = await fetchProfile(url);
  const type = profile.type;
  const creator = profile.name || profile.slug || 'tikporn';

  const items = [];
  const limit = 60;
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const api =
      `https://apiv2.tik.porn/get${type}videos` +
      `?${type}id=${encodeURIComponent(profile.id)}&limit=${limit}&offset=${offset}&sort=recent`;
    const res = await fetchT(api, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) break;
    const j = await res.json();
    const content = (j && j.data && j.data.videos && j.data.videos.content) || [];
    for (const v of content) if (v.download_url || v.mp4_url) items.push(jobFromApiVideo(v, creator, creator));
    offset += content.length;
    if (content.length < limit) break;
  }
  if (!items.length) throw new Error('no videos found for this profile');

  // Only append the video id where two clips would otherwise share a title.
  const counts = {};
  for (const it of items) counts[it.title] = (counts[it.title] || 0) + 1;
  for (const it of items) if (counts[it.title] > 1) it.title = `${it.title} ${it.id}`;

  return { creator, items };
}

// Single video page /video/<id>: find the clip in the page's __NEXT_DATA__.
async function resolve(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const wantId = (new URL(url).pathname.match(/\/video\/(\d+)/) || [])[1];

  // Walk __NEXT_DATA__ for a video object carrying a downloadable URL.
  let found = null;
  (function walk(o) {
    if (found || !o || typeof o !== 'object') return;
    const id = o.video_id != null ? String(o.video_id) : null;
    const dl = o.download_url || o.downloadLink || (o.source && o.source.src);
    if (id && dl && (!wantId || id === wantId)) {
      found = o;
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(nextData(html));

  if (!found) throw new Error('could not find video on page');
  // Normalise to the apiv2 shape jobFromApiVideo expects.
  const creator =
    (found.pornstars && found.pornstars[0] && found.pornstars[0].name) ||
    (found.user && found.user.name) ||
    'tikporn';
  return jobFromApiVideo(
    {
      video_id: found.video_id,
      action_name: found.action_name || (found.action && found.action.name) || '',
      keywords: found.keywords || [],
      poster_url: found.poster_url || found.poster || null,
      download_url: found.download_url || found.downloadLink || (found.source && found.source.src),
      video_text: found.video_text,
    },
    creator,
    creator
  );
}

module.exports = { name: 'tikporn', domain: 'tik.porn', profiles: true, match, isProfile, resolve, resolveProfile };
