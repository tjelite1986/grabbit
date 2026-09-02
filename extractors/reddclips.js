// Extractor for reddclips.com — a Reddit video/image mirror.
//
// Every page is server-rendered by vike and embeds its own data as JSON in
// <script id="vike_pageContext">, which carries the post's Reddit author
// (the "u/<name>" credit) and the subreddit it was posted in ("r/<name>").
// yt-dlp's generic extractor finds the mp4 but neither of those, so clips
// landed under the creator "generic" with no tags at all. Slashes inside that
// JSON are double-escaped ("\\/video\\/x.mp4"), so every URL needs unescaping.
//
// Single post:  /r/<subreddit>/<postId>   (also reachable as /embed/r/...)
// Videos are served from api.reddclips.com; images straight from i.redd.it.

const generic = require('./generic');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE = 'https://reddclips.com';
const API = 'https://api.reddclips.com';

function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function match(url) {
  try {
    return new URL(url).hostname.replace(/^(www|m)\./, '') === 'reddclips.com';
  } catch {
    return false;
  }
}

// The site escapes every slash inside its embedded JSON, so a parsed value
// still reads "https:\/\/i.redd.it\/x.jpeg". Undo that.
function unslash(s) {
  return String(s == null ? '' : s).replace(/\\\//g, '/');
}

// The page's own data blob, or null when the page carries none (a 404, or a
// listing route we don't handle).
function pageContext(html) {
  const m = html.match(/<script id="vike_pageContext" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// The media URL is relative for videos (/video/<hash>.mp4, served by the API
// host) and absolute for images (i.redd.it).
function mediaUrl(raw) {
  const u = unslash(raw);
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : API + (u.startsWith('/') ? u : '/' + u);
}

function extOf(url, fallback) {
  const m = String(url || '').split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : fallback;
}

// Turn one post object from the page data into a download job. The subreddit
// becomes the clip's tag and the Reddit author becomes its profile name — the
// two things the site states about a post and yt-dlp never sees.
function jobFromPost(post, subreddit) {
  const sub = String(post.subreddit || subreddit || '').trim();
  const creator = String(post.author || '').trim() || (sub ? `r/${sub}` : 'reddclips');
  const id = String(post.id || '');
  const url = mediaUrl(post.mediaUrl);
  if (!url) throw new Error('no media on this post');
  const isImage = post.mediaType === 'image';
  const ext = extOf(url, isImage ? 'jpg' : 'mp4');
  const title = String(post.title || '').trim() || id;
  const sourceUrl = sub && id ? `${BASE}/r/${sub}/${id}` : null;
  return {
    kind: 'direct',
    id,
    creator,
    title,
    // buildCaption appends the hashtags and the source link to this.
    description: title,
    tags: sub ? [sub.toLowerCase()] : [],
    mediaType: isImage ? 'image' : 'video',
    ext,
    thumbnail: unslash(post.thumbnail) || null,
    duration: Number.isFinite(post.duration) ? post.duration : null,
    sourceUrl,
    filename: `${creator}-${id}.${ext}`,
    downloadUrl: url,
    headers: { 'User-Agent': UA, Referer: sourceUrl || BASE + '/' },
  };
}

async function resolve(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const ctx = pageContext(await res.text());
  const data = (ctx && ctx.data) || {};
  // A listing page (or anything else without a post) is not ours to resolve —
  // hand it to yt-dlp rather than failing outright.
  if (!data.post) return generic.resolve(url);
  const job = jobFromPost(data.post, data.subreddit);
  // Fall back to the pasted URL when the post carries no canonical one, so the
  // caption's Source line and the downloaded-registry always have a link.
  if (!job.sourceUrl) job.sourceUrl = url;
  return job;
}

module.exports = { name: 'reddclips', domain: 'reddclips.com', match, resolve };
