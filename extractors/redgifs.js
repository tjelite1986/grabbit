// Extractor for redgifs.com.
//
// yt-dlp already downloads a redgifs clip, but it reads the page's <title> —
// which is the literal string "RedGifs" on every single video. Every clip
// therefore landed as "<creator>_-_RedGifs.mp4", and both importers dedup on
// that file name, so the second clip from a creator silently replaced the
// first. It also loses the site's tags, its poster image and its user pages.
//
// The site's own API says all of it, and needs nothing but a temporary token
// anyone can ask for:
//   GET /v2/auth/temporary          -> { token }        (~24 h, IP + UA bound)
//   GET /v2/gifs/<id>               -> { gif, user }
//   GET /v2/gallery/<id>            -> { id, gifs: [] } (a multi-image post)
//   GET /v2/users/<name>/search     -> { gifs, pages }  (paged, newest first)
//
// URL forms handled:
//   /watch/<id>, /ifr/<id>          a single gif (video OR image)
//   /users/<name>                   a whole-profile download
//   media.redgifs.com/<Name>*.mp4   a bare CDN file (mapped back to its id)
//
// AUDIO: `urls.hd` is the only variant that carries the audio track. The site's
// player streams `urls.silent` (a muted copy, for autoplay), so a URL copied
// out of the network tab points at a file with no sound — that suffix is
// stripped back to the id here and the hd file is fetched instead. The API's
// own `hasAudio` flag is NOT reliable (clips flagged false have been measured
// with real audio), which is why nothing here branches on it: hd is always
// taken, and whatever audio the source has comes with it.

const generic = require('./generic');
const { cleanTitle } = require('./util');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE = 'https://www.redgifs.com';
const API = 'https://api.redgifs.com/v2';
// The user listing caps a page at 100; stop after this many pages so a huge
// creator cannot walk forever. Galleries expand a listing (one post can be a
// dozen pictures), so the item count is capped too — the whole list is held in
// memory and sent to the browser as one payload.
const PAGE_SIZE = 100;
const MAX_PAGES = 40;
const MAX_ITEMS = 2000;

function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------- auth token

let cached = { token: null, expires: 0 };

// The token is a JWT whose `exp` is ~24 h out. Read it rather than guessing,
// and renew a minute early so a request never starts on an expiring token.
function expiryOf(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
    return Number(payload.exp) * 1000 - 60000;
  } catch {
    return Date.now() + 30 * 60 * 1000;
  }
}

async function token(force) {
  if (!force && cached.token && Date.now() < cached.expires) return cached.token;
  const res = await fetchT(`${API}/auth/temporary`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`redgifs auth failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.token) throw new Error('redgifs auth returned no token');
  cached = { token: data.token, expires: expiryOf(data.token) };
  return cached.token;
}

// The token is bound to the caller's IP *and* User-Agent, so every API call
// must send the same UA the token was minted with. A 401 means it was revoked
// early (or the UA drifted); mint a fresh one once and retry.
async function api(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchT(`${API}${path}`, {
      headers: { 'User-Agent': UA, Authorization: `Bearer ${await token(attempt > 0)}` },
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 404) throw new Error('This gif no longer exists on redgifs');
    if (!res.ok) throw new Error(`redgifs API HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('redgifs API rejected the temporary token');
}

// ------------------------------------------------------------ URL recognition

function match(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'redgifs.com' || h.endsWith('.redgifs.com');
  } catch {
    return false;
  }
}

// A CDN file is named after the gif in CamelCase, with a variant suffix:
// LooseAmusedBluetonguelizard-mobile.mp4, ...-silent.mp4, ...-large.jpg.
// The id is the stem, lowercased.
const CDN_SUFFIX = /-(mobile|silent|poster|thumbnail|small|medium|large|large2|hd|sd)$/i;

// The gif id a URL points at, or null when the URL names something else
// (a user page, a niche, the front page).
function gifIdFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = decodeURIComponent(u.pathname);
    if (host === 'media.redgifs.com' || host === 'thumbs.redgifs.com') {
      const m = path.match(/^\/([A-Za-z0-9-]+?)(?:\.[A-Za-z0-9]{2,5})?$/);
      if (!m) return null;
      return m[1].replace(CDN_SUFFIX, '').toLowerCase() || null;
    }
    const m = path.match(/^\/(?:watch|ifr|i)\/([A-Za-z0-9]+)/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

// /users/<name>, with or without a trailing section.
function userFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/^\/users\/([A-Za-z0-9_.-]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// A user page is many gifs and a gallery post is many pictures — both are
// "profiles" to the rest of grabbit. Only the gif's own data says whether it
// is a gallery, so every gif URL claims it here and resolveProfile throws for
// the single-media ones, which sends the caller back to resolve().
function isProfile(url) {
  return !!userFromUrl(url) || !!gifIdFromUrl(url);
}

// ------------------------------------------------------------------- jobs

// Cap a string to a byte budget without splitting a character.
function clampBytes(text, max) {
  let out = '';
  let used = 0;
  for (const ch of String(text || '')) {
    const size = Buffer.byteLength(ch);
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

// "Big Dick" -> "#bigdick": the site shows multi-word tags, but a hashtag in a
// caption ends at the first space, so the words are joined.
function hashtags(tags) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const clean = '#' + String(t).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (clean.length > 1 && !out.includes(clean)) out.push(clean);
  }
  return out;
}

const VIDEO_EXT = /^(mp4|m4v|mov|webm)$/;

function extOf(url, fallback) {
  const m = String(url || '').split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : fallback;
}

// Turn one gif object from the API into a download job.
function jobFromGif(gif) {
  const id = String(gif.id || '').toLowerCase();
  if (!id) throw new Error('redgifs item without an id');
  const urls = gif.urls || {};
  // hd is the full-quality file and the only one that carries audio; sd is the
  // -mobile copy, used only when hd is missing.
  const downloadUrl = urls.hd || urls.sd;
  if (!downloadUrl) throw new Error('redgifs gave no media URL for this gif');
  // Classify by the file, not by the site's `type` field: an image post and a
  // video post are both "gifs" here, and the extension is what the pipeline
  // has to agree with.
  const ext = extOf(downloadUrl, gif.type === 2 ? 'jpg' : 'mp4');
  const isImage = !VIDEO_EXT.test(ext);
  const creator = String(gif.userName || '').trim() || 'redgifs';
  const tagNames = Array.isArray(gif.tags) ? gif.tags.filter(Boolean).map(String) : [];
  const caption = cleanTitle(gif.description, 200);
  // Most redgifs posts carry no caption at all, and the ones that do reuse it
  // across a whole series. Both importers dedup on the saved file name, which
  // is built from the creator and the title, so the id always rides along to
  // keep every saved file distinct. The caption itself stays clean in
  // `description`, which is what the library displays.
  const label = caption ? clampBytes(caption, 80).trim() : tagNames.join(' ');
  const title = label ? `${label} ${id}` : id;
  const sourceUrl = `${BASE}/watch/${id}`;
  return {
    kind: 'direct',
    id,
    creator,
    title,
    // buildCaption appends the hashtags and the source link to this.
    description: caption,
    tags: hashtags(tagNames),
    mediaType: isImage ? 'image' : 'video',
    ext,
    thumbnail: urls.poster || urls.thumbnail || null,
    duration: Number.isFinite(gif.duration) ? gif.duration : null,
    // The site's own claim about an audio track. Advisory only — see the note
    // at the top: it under-reports, so the download never branches on it.
    hasAudio: !!gif.hasAudio,
    // The lighter copy the card plays as a moving preview (~6 MB against the
    // hd file's ~35 MB for the same clip). Only for a video: for an image post
    // `sd` is just a smaller JPEG, which is not something to play.
    preview: !isImage && urls.sd && urls.sd !== downloadUrl ? urls.sd : undefined,
    sourceUrl,
    filename: `${creator}-${id}.${ext}`,
    downloadUrl,
    headers: { 'User-Agent': UA, Referer: BASE + '/' },
    // A multi-image post: groups the whole set into one carousel post instead
    // of one post per picture.
    albumId: gif.gallery ? String(gif.gallery) : undefined,
  };
}

// --------------------------------------------------------------- resolving

async function fetchGif(id) {
  const data = await api(`/gifs/${encodeURIComponent(id)}`);
  if (!data || !data.gif) throw new Error('redgifs returned no gif for this link');
  return data.gif;
}

async function resolve(url) {
  const id = gifIdFromUrl(url);
  // A user page, a niche, the front page — not ours to resolve as one file.
  // Hand it to yt-dlp rather than failing outright.
  if (!id) return generic.resolve(url);
  const gif = await fetchGif(id);
  // A gallery has no single file: the whole set comes back from
  // resolveProfile, which every caller tries first. Answering with the cover
  // picture keeps a direct resolve of one working rather than failing.
  return jobFromGif(gif);
}

// Every picture of one gallery post. Throws for a post holding a single file,
// which is resolve()'s job.
async function resolveGallery(url) {
  const gif = await fetchGif(gifIdFromUrl(url));
  if (!gif.gallery) throw new Error('This post holds a single file');
  const data = await api(`/gallery/${encodeURIComponent(gif.gallery)}`);
  const gifs = data && Array.isArray(data.gifs) ? data.gifs : [];
  const items = [];
  for (const g of gifs) {
    try {
      // The gallery listing omits userName on its entries, so the post's own
      // uploader is carried onto every picture — otherwise the whole set would
      // save under "redgifs" instead of the creator.
      items.push(jobFromGif({ ...g, userName: g.userName || gif.userName, gallery: gif.gallery }));
    } catch {
      // a gallery entry the API doesn't name a file for — skip it
    }
  }
  if (items.length < 2) throw new Error('This post holds a single file');
  return { creator: items[0].creator, title: items[0].description || `Gallery ${gif.id}`, items };
}

// One page of a creator's gifs, newest first.
async function listPage(user, page) {
  const q = new URLSearchParams({ order: 'new', count: String(PAGE_SIZE), page: String(page) });
  const data = await api(`/users/${encodeURIComponent(user)}/search?${q}`);
  return {
    gifs: data && Array.isArray(data.gifs) ? data.gifs : [],
    pages: Number(data && data.pages) || 1,
  };
}

// Every gif of a creator. Galleries are left as their cover picture here: the
// listing does not carry a gallery's other pictures, and one extra API call
// per post would turn a 400-clip profile into 400 extra requests.
async function resolveUser(user) {
  const items = [];
  const seen = new Set();
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, MAX_PAGES) && items.length < MAX_ITEMS; page++) {
    const listing = await listPage(user, page);
    pages = listing.pages;
    if (!listing.gifs.length) break;
    for (const gif of listing.gifs) {
      const id = String(gif.id || '').toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        items.push(jobFromGif(gif));
      } catch {
        // a gif the listing doesn't name a file for — skip it
      }
      if (items.length >= MAX_ITEMS) break;
    }
  }
  if (!items.length) throw new Error(`no gifs found for redgifs user ${user}`);
  // The listing lowercases nothing: use the name the gifs are credited to, so
  // saved files match a single-clip grab from the same creator.
  return { creator: items[0].creator, title: items[0].creator, items };
}

async function resolveProfile(url) {
  const user = userFromUrl(url);
  return user ? resolveUser(user) : resolveGallery(url);
}

module.exports = {
  name: 'redgifs',
  domain: 'redgifs.com',
  profiles: true,
  match,
  isProfile,
  resolve,
  resolveProfile,
};
