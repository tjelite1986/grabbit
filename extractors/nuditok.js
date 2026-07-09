// Extractor for nuditok.com
//
// The page is a SPA. The .mp4 URL embedded in the HTML/JSON-LD is a stub that
// 404s; the real URL comes from the API. nuditok uses several id formats
// (e.g. "RxE9", or a 16-hex hash whose URL slug is truncated to 8 chars), so we
// never parse the id from the slug. Single video:
//   1. Fetch the page (short /s/<id> links and og-preview pages work too, since
//      they all embed a stub like cdn2.nuditok.com/videos/<id>.mp4).
//   2. Read the full id from that stub.
//   3. GET /api/v1/videos/<id> returns JSON with the real `video_url`.
// Whole profile: GET /api/v1/users/<name>/videos?offset=N (paginated, each item
// already carries a working `video_url`). The CDN serves files with a Referer.

const { titleFrom } = require('./util');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://nuditok.com/';

// fetch with a timeout so a hanging upstream fails fast instead of stalling.
function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function match(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'nuditok.com';
  } catch {
    return false;
  }
}

// A bare /@user (no slug/id) is a profile listing.
function isProfile(url) {
  try {
    return /^\/@[^/]+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function creatorFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/^\/@([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// Build a download job from a nuditok video object (same shape from the single
// /videos/<id> endpoint and the /users/<name>/videos list).
function jobFromVideo(d) {
  const username = d.username || 'nuditok';
  const description = (d.description || '').trim();
  const tags = (description.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase());
  return {
    kind: 'direct',
    id: d.hash,
    creator: username,
    title: titleFrom(description, tags, d.hash),
    description,
    tags,
    sourceUrl: d.slug_url ? `https://nuditok.com${d.slug_url}` : `https://nuditok.com/@${username}`,
    thumbnail: d.cover_url || d.preview_url,
    filename: `${username}-${d.hash}.mp4`,
    downloadUrl: d.video_url,
    headers: { 'User-Agent': UA, Referer: REFERER },
  };
}

async function findHash(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  // The stub mp4 id is bare alphanumerics; the real URL adds a "-<suffix>", so
  // restricting to [A-Za-z0-9] avoids matching the suffixed real URL by mistake.
  const m = html.match(/\/videos\/([A-Za-z0-9]+)\.mp4/);
  if (!m) throw new Error('could not find video id in page');
  return m[1];
}

async function resolve(url) {
  const hash = await findHash(url);
  const res = await fetchT(`https://nuditok.com/api/v1/videos/${hash}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);
  const json = await res.json();
  const d = json && json.data;
  if (!d || !d.video_url) throw new Error('API response missing video_url');
  return jobFromVideo(d);
}

async function resolveProfile(url) {
  const creator = creatorFromUrl(url);
  if (!creator) throw new Error('not a profile URL');

  const items = [];
  let offset = 0;
  for (let page = 0; page < 200; page++) {
    const res = await fetchT(
      `https://nuditok.com/api/v1/users/${encodeURIComponent(creator)}/videos?offset=${offset}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!res.ok) break;
    const data = (await res.json()).data;
    const vids = (data && data.videos) || [];
    for (const v of vids) if (v.video_url) items.push(jobFromVideo(v));
    offset += vids.length;
    if (!data || !data.has_more || !vids.length) break;
  }
  if (!items.length) throw new Error('no videos found for this profile');
  return { creator: items[0].creator || creator, items };
}

module.exports = { name: 'nuditok', domain: 'nuditok.com', profiles: true, match, isProfile, resolve, resolveProfile };
