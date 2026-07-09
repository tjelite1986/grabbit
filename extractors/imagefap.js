// imagefap.com extractor — photo galleries at /pictures/<gid>/<name>.
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

// "/pictures/<gid>/<Name>" -> "Name" (spaces restored) as the album creator.
function creatorFromUrl(url) {
  const m = url.match(/\/pictures\/\d+\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]).replace(/[_+]+/g, ' ').trim() || 'imagefap';
  return 'imagefap';
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

// Map image id -> thumb URL by walking the gallery pages (cheap, ~24/page).
async function thumbMap(url) {
  const base = url.split('?')[0];
  const map = {};
  for (let page = 0; page < 60; page++) {
    let html;
    try {
      const r = await fetch(`${base}?page=${page}&view=0`, { headers: { 'User-Agent': UA } });
      if (!r.ok) break;
      html = await r.text();
    } catch {
      break;
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
  return map;
}

async function resolveProfile(url) {
  const [urls, thumbs] = await Promise.all([galleryUrls(url), thumbMap(url).catch(() => ({}))]);
  const creator = creatorFromUrl(url);
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
      sourceUrl: url,
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
