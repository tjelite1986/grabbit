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
//               A post can hold a gallery of images ("mediaType":"gallery"),
//               which resolves to one item per picture, grouped by albumId.
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
// Galleries multiply a listing (one post can be a dozen pictures), so cap what
// a single subreddit resolves to — the whole list is held in memory and sent
// to the browser as one payload.
const MAX_ITEMS = 2000;

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

// /r/<subreddit>/<postId>, with or without the /embed prefix.
function postUrl(url) {
  try {
    return /^\/(?:embed\/)?r\/[A-Za-z0-9_]+\/[A-Za-z0-9]+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// A subreddit is many posts and a gallery post is many pictures — both are
// "profiles" to the rest of grabbit. Only the post's own data says whether it
// is a gallery, so every post URL claims it here and resolveProfile throws for
// the single-media ones, which sends the caller back to resolve().
function isProfile(url) {
  return !!subredditFromUrl(url) || postUrl(url);
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

// Cap a string to a byte budget without splitting a character. Gallery titles
// carry a "(n of m)" suffix that has to survive the server's own title
// truncation, so the caption in front of it is clamped by bytes, not by length.
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
  const caption = String(post.title || '').trim();
  // Two posts by one author routinely share a caption (a repost, a series),
  // and both importers dedup on the saved file name — which is built from the
  // creator and the title, so a bare caption would silently drop the second
  // post. The post id on the end keeps every saved file distinct; the caption
  // itself stays clean in `description`, which is what the library displays.
  const title = caption ? `${clampBytes(caption, 80).trim()} ${id}` : id;
  const sourceUrl = sub && id ? `${BASE}/r/${sub}/${id}` : null;
  return {
    kind: 'direct',
    id,
    creator,
    title,
    // buildCaption appends the hashtags and the source link to this.
    description: caption || id,
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

// A gallery post as one job per picture. They share the post's caption, so
// each title carries its position — the importers dedup on the file name, and
// two pictures of one post would otherwise write to the same one. albumId
// groups the whole set into a single carousel post instead of one post each.
function galleryJobs(post, subreddit) {
  const base = jobFromPost(post, subreddit);
  const pics = post.galleryItems.filter((it) => it && it.url);
  const caption = clampBytes(base.description, 70).trim();
  return pics.map((it, i) => {
    const url = mediaUrl(it.url);
    const ext = extOf(url, 'jpg');
    const where = `(${i + 1} of ${pics.length}) ${post.id}`;
    return {
      ...base,
      id: String(it.id || `${base.id}-${i}`),
      title: caption ? `${caption} ${where}` : where,
      mediaType: VIDEO_EXT.test(ext) ? 'video' : 'image',
      ext,
      downloadUrl: url,
      thumbnail: url,
      duration: null,
      filename: `${base.creator}-${it.id}.${ext}`,
      albumId: post.id,
    };
  });
}

// Every downloadable item in a post: a gallery's pictures, or the one media a
// plain post carries.
function jobsFromPost(post, subreddit) {
  if (Array.isArray(post.galleryItems) && post.galleryItems.length) {
    return galleryJobs(post, subreddit);
  }
  return [jobFromPost(post, subreddit)];
}

// The post object behind a /r/<sub>/<id> URL.
async function fetchPost(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const ctx = pageContext(await res.text());
  const data = (ctx && ctx.data) || {};
  return data.post ? { post: data.post, subreddit: data.subreddit } : null;
}

async function resolve(url) {
  const found = await fetchPost(url);
  // A listing page (or anything else without a post) is not ours to resolve —
  // hand it to yt-dlp rather than failing outright.
  if (!found) return generic.resolve(url);
  // A gallery has no single file: the whole set comes back from
  // resolveProfile, which every caller tries first. Answering with the cover
  // picture keeps a direct resolve of one working rather than failing.
  const job = jobsFromPost(found.post, found.subreddit)[0];
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

// Every picture of one gallery post. Throws for a post holding a single file,
// which is resolve()'s job.
async function resolveGallery(url) {
  const found = await fetchPost(url);
  if (!found) throw new Error('No post on this page');
  const items = jobsFromPost(found.post, found.subreddit);
  if (items.length < 2) throw new Error('This post holds a single file');
  // One author for the whole gallery, unlike a subreddit listing.
  return { creator: items[0].creator, title: found.post.title || null, items };
}

// Every post of a subreddit, galleries expanded into their pictures.
async function resolveSubreddit(subreddit) {
  const items = [];
  const seen = new Set();
  let after = null;
  for (let page = 0; page < MAX_PAGES && items.length < MAX_ITEMS; page++) {
    const listing = await listPage(subreddit, after);
    let added = 0;
    for (const post of listing.posts) {
      const id = String(post.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        // The listing carries each gallery's pictures too, so a whole-subreddit
        // grab takes every one of them, not just the cover.
        items.push(...jobsFromPost(post, subreddit));
        added++;
      } catch {
        // a post whose media the listing doesn't name — skip it
      }
      if (items.length >= MAX_ITEMS) break;
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

async function resolveProfile(url) {
  const subreddit = subredditFromUrl(url);
  return subreddit ? resolveSubreddit(subreddit) : resolveGallery(url);
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
