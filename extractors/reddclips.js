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
// Subreddit:    /r/<subreddit>            -> a whole-profile download, paged
//               through api.reddclips.com/posts/<sub> with an opaque `after`
//               cursor (the site's own listing call).
// Videos are served from api.reddclips.com; images straight from i.redd.it.
// There is no /u/<name> page — the author is stated per post, not browsable.

const generic = require('./generic');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE = 'https://reddclips.com';
const API = 'https://api.reddclips.com';
// The listing API caps a page at 100 posts; stop after this many pages so a
// huge subreddit cannot walk forever.
const PAGE_SIZE = 100;
const MAX_PAGES = 40;

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

// A bare /r/<subreddit> (no post id) is a listing of many posts.
function subredditFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/^\/r\/([A-Za-z0-9_]+)\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function isProfile(url) {
  return !!subredditFromUrl(url);
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

// Extensions the video pipeline can actually put in an .mp4 container.
const VIDEO_EXT = /^(mp4|m4v|mov|webm)$/;

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
  const ext = extOf(url, post.mediaType === 'image' ? 'jpg' : 'mp4');
  // Classify by the file, not by the site's label: a fifth of the posts here
  // are typed "video" but served as an animated .gif on i.redd.it, and the
  // video pipeline would stream-copy one into an .mp4 container, fail, and
  // leave a gif wearing an .mp4 name. The image path keeps it a .gif.
  const isImage = !VIDEO_EXT.test(ext);
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

// One page of a subreddit's listing. `after` is the opaque cursor the previous
// page handed back (base64 of an offset, but treat it as opaque).
async function listPage(subreddit, after) {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (after) q.set('after', after);
  const res = await fetchT(`${API}/posts/${encodeURIComponent(subreddit)}?${q}`, {
    headers: { 'User-Agent': UA, Referer: BASE + '/' },
  });
  if (!res.ok) throw new Error(`listing fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return {
    posts: Array.isArray(data.posts) ? data.posts : [],
    after: (data.cursors && data.cursors.after) || null,
  };
}

async function resolveProfile(url) {
  const subreddit = subredditFromUrl(url);
  if (!subreddit) throw new Error('Not a subreddit listing');
  const items = [];
  const seen = new Set();
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listing = await listPage(subreddit, after);
    let added = 0;
    for (const post of listing.posts) {
      const id = String(post.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        items.push(jobFromPost(post, subreddit));
        added++;
      } catch {
        // a post whose media the listing doesn't name — skip it
      }
    }
    // The cursor is an offset into a ranking that shifts between calls, so a
    // page of nothing but repeats means we've reached the end (or gone round).
    if (!listing.after || !added) break;
    after = listing.after;
  }
  if (!items.length) throw new Error('no posts found in this subreddit');
  // A subreddit has no single author: every post keeps the creator the site
  // credits it to, and the listing itself is named rather than attributed —
  // a profile-level creator here would overwrite all of them with one name.
  return { creator: null, title: `r/${subreddit}`, items };
}

module.exports = {
  name: 'reddclips',
  domain: 'reddclips.com',
  profiles: true,
  match,
  isProfile,
  resolve,
  resolveProfile,
};
