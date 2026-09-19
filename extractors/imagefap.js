// imagefap.com extractor — photo galleries at /pictures/<gid>/<name> and /gallery/<gid>.
//
// imagefap's full-image URLs are signed and spread across paginated photo pages,
// so we enumerate them with gallery-dl (`-g`), which yields one signed full-image
// URL per line (tokens stay valid for hours). Lightweight thumbnails come from
// the gallery pages' own thumb URLs, matched to the full URLs by image id. Every
// download sends a Referer (the CDN is picky on full images).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const GALLERY_DL = process.env.GALLERY_DL_BIN || 'gallery-dl';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.imagefap.com/' };

// Validate the real host (not a substring) so a URL like
// https://attacker.com/imagefap.com/pictures/1 can't point us at another host.
function match(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (h === 'imagefap.com' || h.endsWith('.imagefap.com')) && /^\/(pictures|gallery)\//i.test(u.pathname);
  } catch {
    return false;
  }
}
function isProfile(url) {
  return match(url);
}

// "/pictures/<gid>/<Name>" -> "Name" (spaces restored). This is the gallery's
// own name, not its uploader, and /gallery/<id> — the other form match()
// accepts — carries no slug at all. Only used as a last resort now.
function nameFromUrl(url) {
  const m = url.match(/\/pictures\/\d+\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]).replace(/[_+]+/g, ' ').trim() || null;
  return null;
}

// Both accepted URL forms serve the same page, and it names the uploader twice:
// once as text under the gallery title, once as a link to their profile. Read
// it from there so /gallery/<id> and /pictures/<gid>/<name> agree.
function creatorFromHtml(html) {
  const text = html.match(/Uploaded by\s*([^<\n]+)/i);
  if (text && text[1].trim()) return text[1].trim();
  const link = html.match(/profile\.php\?user=([^"'&<>\s]+)/i);
  if (link) {
    try {
      return decodeURIComponent(link[1]).trim() || null;
    } catch {
      return link[1].trim() || null;
    }
  }
  return null;
}

// The page title is the gallery's name. It is not the creator, so it rides
// along as the description instead — that is what reaches the .md sidecar.
function titleFromHtml(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() || null : null;
}

// The gallery id, carried on every item so a whole gallery saved to the posts
// import becomes carousel posts instead of one post per picture.
function albumIdFromUrl(url) {
  const m = url.match(/\/(?:pictures|gallery)\/(\d+)/i);
  return m ? m[1] : null;
}

function idFromUrl(u) {
  const m = u.split('?')[0].match(/\/(\d+)\.[a-z0-9]+$/i);
  return m ? m[1] : u.split('?')[0].split('/').pop() || 'img';
}
function extFromUrl(u, fb) {
  const m = u.split('?')[0].match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : fb;
}

// Enumerate every full-image URL via gallery-dl -g.
function galleryUrls(url) {
  return new Promise((resolve, reject) => {
    const home =
      process.env.HOME && fs.existsSync(process.env.HOME) ? process.env.HOME : os.tmpdir();
    // `--` ends option parsing so the URL can never be read as a flag.
    const p = spawn(GALLERY_DL, ['-g', '--', url], { env: { ...process.env, HOME: home } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const urls = out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//.test(s));
      if (urls.length) return resolve(urls);
      reject(new Error(err.trim().split('\n').pop() || `gallery-dl exited ${code}`));
    });
  });
}

// Map image id -> thumb URL by walking the gallery pages (cheap, ~24/page), and
// take the uploader and gallery name off the first page while it is already in
// hand — no page is fetched for them that was not fetched anyway.
async function galleryPages(url) {
  const base = url.split('?')[0];
  const map = {};
  let creator = null;
  let title = null;
  for (let page = 0; page < 60; page++) {
    let html;
    try {
      const r = await fetch(`${base}?page=${page}&view=0`, { headers: { 'User-Agent': UA } });
      if (!r.ok) break;
      html = await r.text();
    } catch {
      break;
    }
    if (page === 0) {
      creator = creatorFromHtml(html);
      title = titleFromHtml(html);
    }
    const thumbs = html.match(/https?:\/\/[a-z0-9]*\.imagefap\.com\/images\/thumb\/[^"'\s]+/gi) || [];
    let added = 0;
    for (const t of thumbs) {
      const id = idFromUrl(t);
      if (id && !(id in map)) {
        map[id] = t;
        added++;
      }
    }
    if (added === 0) break; // no new images -> past the last page
  }
  return { thumbs: map, creator, title };
}

async function resolveProfile(url) {
  const [urls, page] = await Promise.all([
    galleryUrls(url),
    galleryPages(url).catch(() => ({ thumbs: {}, creator: null, title: null })),
  ]);
  const thumbs = page.thumbs || {};
  // The page is the only source that answers for both URL forms; the slug is
  // the gallery's name and exists on one of them, so it is the fallback.
  const creator = page.creator || nameFromUrl(url) || 'imagefap';
  const description = page.title || nameFromUrl(url) || null;
  const albumId = albumIdFromUrl(url);
  const items = urls.map((u) => {
    const id = idFromUrl(u);
    return {
      kind: 'direct',
      mediaType: 'image',
      downloadUrl: u,
      headers: HEADERS,
      id,
      title: id,
      thumbnail: thumbs[id] || u,
      creator,
      description,
      sourceUrl: url,
      albumId,
      ext: extFromUrl(u, 'jpg'),
    };
  });
  if (!items.length) throw new Error('No images found in this imagefap gallery');
  return { creator, items };
}

async function resolve(url) {
  const r = await resolveProfile(url);
  return r.items[0];
}

module.exports = { name: 'imagefap', domain: 'imagefap.com', profiles: true, match, resolve, isProfile, resolveProfile };
