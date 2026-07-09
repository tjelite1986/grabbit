// Extractor for onlytik.com
//
// onlytik is a server-rendered TikTok-style site. The CDN mp4 has NO secret
// suffix — `https://cdn2.onlytik.com/videos/<id>.mp4` works directly with a
// Referer. Metadata comes from `GET /api/user?uid=<name>` which returns the
// user object plus a `videos` array (each: video_id, desc(HTML w/ #hashtags),
// url, username, likes). That single call returns ALL of a user's clips, so it
// powers both single-video and whole-profile downloads.

const { titleFrom } = require('./util');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://onlytik.com/';

function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function match(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'onlytik.com';
  } catch {
    return false;
  }
}

// A bare /@user (no video id) or /@user/ is a profile listing.
function isProfile(url) {
  try {
    return /^\/@[A-Za-z0-9_.]+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function creatorFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/^\/@([A-Za-z0-9_.]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function videoIdFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/^\/@[A-Za-z0-9_.]+\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchUser(name) {
  const res = await fetchT(`https://onlytik.com/api/user?uid=${encodeURIComponent(name)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`user API HTTP ${res.status}`);
  return res.json();
}

// Build a download job from an onlytik video object.
function jobFromVideo(v, creator) {
  const id = v.video_id;
  const url = v.url || `https://cdn2.onlytik.com/videos/${id}.mp4`;
  const base = url.replace(/\/videos\/.*$/, '');
  const desc = stripHtml(v.desc);
  const tags = (desc.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase());
  return {
    kind: 'direct',
    id,
    creator,
    title: titleFrom(desc, tags, id),
    description: desc,
    tags,
    sourceUrl: `https://onlytik.com/@${creator}/${id}`,
    thumbnail: `${base}/preview/${id}.jpg`,
    filename: `${creator}-${id}.mp4`,
    downloadUrl: url,
    headers: { 'User-Agent': UA, Referer: REFERER },
  };
}

// Single video: prefer the API (gives hashtags); fall back to scraping the page.
async function resolve(url) {
  const creator = creatorFromUrl(url);
  const wantId = videoIdFromUrl(url);
  if (creator) {
    try {
      const data = await fetchUser(creator);
      const name = data.username || creator;
      const vids = data.videos || [];
      const v = wantId ? vids.find((x) => x.video_id === wantId) : vids[0];
      if (v) return jobFromVideo(v, name);
    } catch {
      /* fall through to page scrape */
    }
  }

  // Fallback: scrape the rendered page (homepage, or a clip not in the list).
  const res = await fetchT(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const mp4 = html.match(/https?:\/\/cdn\d*\.onlytik\.com\/videos\/([A-Za-z0-9]+)\.mp4/);
  const id = mp4 ? mp4[1] : (html.match(/data-item-id="([A-Za-z0-9]+)"/) || [])[1];
  if (!id) throw new Error('could not find video id on page');
  const base = mp4 ? mp4[0].replace(/\/videos\/.*$/, '') : 'https://cdn2.onlytik.com';
  return jobFromVideo({ video_id: id, url: `${base}/videos/${id}.mp4`, desc: '' }, creator || 'onlytik');
}

// Whole profile: every clip the user has.
async function resolveProfile(url) {
  const creator = creatorFromUrl(url);
  if (!creator) throw new Error('not a profile URL');
  const data = await fetchUser(creator);
  const name = data.username || creator;
  const items = (data.videos || []).map((v) => jobFromVideo(v, name));
  if (!items.length) throw new Error('no videos found for this profile');
  return { creator: name, bio: data.bio || null, items };
}

module.exports = { name: 'onlytik', domain: 'onlytik.com', profiles: true, match, isProfile, resolve, resolveProfile };
