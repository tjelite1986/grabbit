// erome.com extractor — albums at /a/<id> holding a mix of images and videos.
//
// An album is treated as a "profile" (multi-item) so the whole-album download UI
// works. Each item carries a mediaType ('image' | 'video'); the server routes
// images into elite-v2's posts import and videos like any other clip. The album
// page's own title and #tags ride along on every item as description/tags, so
// the saved caption matches the site (and the posts importer turns the hashtags
// into real post tags). Items also carry the album id, which groups a whole
// album into one carousel post instead of one post per picture. The CDN rejects
// requests without a Referer (videos 403 otherwise), so every job sends one.

const { cleanTitle } = require('./util');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.erome.com/' };

// Validate the real host (not a substring) to avoid SSRF via a crafted path.
function match(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (h === 'erome.com' || h.endsWith('.erome.com')) && /^\/a\/[A-Za-z0-9]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

function isProfile(url) {
  return match(url);
}

async function fetchAlbum(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`erome HTTP ${r.status}`);
  return r.text();
}

// The album id from /a/<id> — the grouping key for the whole album.
function albumIdFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/^\/a\/([A-Za-z0-9]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// The page is server-rendered Blade output, so titles and tags arrive HTML-
// escaped (&#039;, &amp;, a trailing &nbsp; after the username).
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, hex) => {
      const cp = parseInt(hex, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d{1,7});/g, (m, dec) => {
      const cp = Number(dec);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// Drop the site's SEO suffix ("... - Porn Videos & Photos - EroMe"), which is
// baked into the <title> and — on albums whose owner never named them — into
// the <h1> as well. Without this it would end up in every caption.
function stripSiteSuffix(text) {
  return String(text || '')
    .replace(/\s*-\s*Porn Videos.*$/i, '')
    .replace(/(\s*-\s*EroMe)+\s*$/i, '')
    .trim();
}

// The album's own caption: <h1 class="album-title-page">.
function albumTitle(html) {
  const m = html.match(/<h1[^>]*class="album-title-page"[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripSiteSuffix(decodeEntities(m[1].replace(/<[^>]+>/g, ' '))) : '';
}

// Album owner: the uploader link in the album header, else the <title>.
function albumUser(html) {
  const link = html.match(/id="user_name"[^>]*>([^<]*)</i);
  if (link) {
    const name = decodeEntities(link[1]);
    if (name) return name;
  }
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return 'erome';
  return stripSiteSuffix(decodeEntities(m[1])) || 'erome';
}

// "#Big tits" -> "#bigtits": the site shows multi-word tags, but a hashtag in a
// caption has to be a single token to survive as one tag on the elite-v2 side.
function normalizeTag(label) {
  const slug = decodeEntities(label)
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '');
  return slug ? '#' + slug : null;
}

// The album's tag list: <a class="album-tag" href="/search?q=...">#Big tits</a>.
function albumTags(html) {
  const out = [];
  const re = /<a[^>]*class="album-tag"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = normalizeTag(m[1]);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// Media id = the CDN filename without extension/query (and without a _720p tag).
function idFromUrl(u) {
  const base = u.split('?')[0].split('/').pop() || 'item';
  return base.replace(/\.[a-z0-9]+$/i, '').replace(/_\d+p$/i, '') || 'item';
}

function extFromUrl(u, fallback) {
  const m = u.split('?')[0].match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : fallback;
}

// Per-item title: the album caption reads far better than a CDN id, but every
// item of an album shares it — keep the media id on the end so the saved files
// stay unique (both importers dedup on the name).
function itemTitle(title, id) {
  const t = cleanTitle(title, 80);
  return t ? `${t} ${id}` : id;
}

async function albumItems(url) {
  const html = await fetchAlbum(url);
  const creator = albumUser(html);
  const title = albumTitle(html);
  const tags = albumTags(html);
  const albumId = albumIdFromUrl(url);
  // Album-wide metadata every item carries: the caption becomes the clip/post
  // description and the tags become its hashtags.
  const meta = { creator, sourceUrl: url, description: title, tags, albumId };
  // Each media-group div is one item: a <source> mp4 (video) or a `.img`
  // data-src (full image). Video groups carry only a poster, not data-src.
  const blocks = html.split('<div class="media-group"').slice(1);
  const items = [];
  const seen = new Set();
  for (const b of blocks) {
    const vid = b.match(/<source[^>]+src="(https:\/\/[^"]+\.mp4)"/i);
    if (vid) {
      const dl = vid[1];
      if (seen.has(dl)) continue;
      seen.add(dl);
      const poster = b.match(/poster="([^"]+)"/i);
      items.push({
        kind: 'direct',
        mediaType: 'video',
        downloadUrl: dl,
        headers: HEADERS,
        id: idFromUrl(dl),
        title: itemTitle(title, idFromUrl(dl)),
        thumbnail: poster ? poster[1] : null,
        ext: 'mp4',
        ...meta,
      });
      continue;
    }
    const img = b.match(/<div class="img"\s+data-src="(https:\/\/[^"]+)"/i);
    if (img) {
      const dl = img[1];
      if (seen.has(dl)) continue;
      seen.add(dl);
      items.push({
        kind: 'direct',
        mediaType: 'image',
        downloadUrl: dl,
        headers: HEADERS,
        id: idFromUrl(dl),
        title: itemTitle(title, idFromUrl(dl)),
        thumbnail: dl,
        ext: extFromUrl(dl, 'jpg'),
        ...meta,
      });
    }
  }
  return { creator, title, items };
}

async function resolveProfile(url) {
  const r = await albumItems(url);
  if (!r.items.length) throw new Error('No media found in this erome album');
  return r;
}

async function resolve(url) {
  const r = await albumItems(url);
  if (!r.items.length) throw new Error('No media found in this erome album');
  return r.items[0];
}

module.exports = { name: 'erome', domain: 'erome.com', profiles: true, match, resolve, isProfile, resolveProfile };
