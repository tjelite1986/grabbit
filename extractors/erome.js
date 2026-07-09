// erome.com extractor — albums at /a/<id> holding a mix of images and videos.
//
// An album is treated as a "profile" (multi-item) so the whole-album download UI
// works. Each item carries a mediaType ('image' | 'video'); the server routes
// images into the photos library and videos like any other clip. The CDN rejects
// requests without a Referer (videos 403 otherwise), so every job sends one.

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

// Album owner from the <title> ("<user> - Porn Videos & Photos - EroMe").
function albumUser(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (!m) return 'erome';
  return m[1].replace(/\s*-\s*Porn Videos.*$/i, '').replace(/\s*-\s*EroMe\s*$/i, '').trim() || 'erome';
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

async function albumItems(url) {
  const html = await fetchAlbum(url);
  const creator = albumUser(html);
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
        title: idFromUrl(dl),
        thumbnail: poster ? poster[1] : null,
        creator,
        sourceUrl: url,
        ext: 'mp4',
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
        title: idFromUrl(dl),
        thumbnail: dl,
        creator,
        sourceUrl: url,
        ext: extFromUrl(dl, 'jpg'),
      });
    }
  }
  return { creator, items };
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
