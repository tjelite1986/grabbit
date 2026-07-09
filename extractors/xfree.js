// Extractor for xfree.com (www.xfree.com)
//
// Nuxt site behind Cloudflare with a JA3/TLS block: plain fetch gets 403, so
// pages are fetched with a Chrome-impersonating client (curl_cffi via python).
// The CDN (cdn.xfree.com) is NOT gated, so the actual file downloads with a
// normal request. Each /video?id=<id> page exposes one `full.mp4` + an og:title
// caption. Profile pages (/​<handle>) server-render only the first batch of
// video ids; the rest load via a Cloudflare-challenge-gated XHR we can't reach,
// so whole-profile is limited to the clips present in the page.

const { spawn } = require('child_process');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REFERER = 'https://www.xfree.com/';
const PYTHON = process.env.PYTHON_BIN || 'python3';

function match(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'xfree.com';
  } catch {
    return false;
  }
}

function isProfile(url) {
  try {
    const p = new URL(url).pathname;
    return /^\/[A-Za-z0-9_.-]+\/?$/.test(p) && p !== '/video' && p !== '/';
  } catch {
    return false;
  }
}

// Fetch a page through a Chrome-impersonating client to clear the TLS block.
function impersonateFetch(url) {
  return new Promise((resolve, reject) => {
    const code =
      'import sys\nfrom curl_cffi import requests\n' +
      'r=requests.get(sys.argv[1],impersonate="chrome124",timeout=30)\n' +
      'sys.stdout.write(r.text)';
    const p = spawn(PYTHON, ['-c', code, url]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => {
      if (c === 0 && out) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `impersonate fetch exited ${c}`));
    });
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/');
}

function videoIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get('id');
  } catch {
    return null;
  }
}

// Build a job from a rendered /video page.
function jobFromVideoPage(html, idHint, fallbackCreator) {
  const mp4 = (html.match(/https:\/\/cdn\.xfree\.com\/[^"\\ )]+\.mp4/) || [])[0];
  if (!mp4) throw new Error('no video file found on page');
  const ogTitle = decodeEntities((html.match(/og:title"[^>]*content="([^"]*)"/i) || [])[1] || '');
  const poster = (html.match(/og:image"[^>]*content="([^"]*)"/i) || [])[1] || null;

  const handle = (ogTitle.match(/@([A-Za-z0-9_.]+)/) || [])[1] || fallbackCreator || 'xfree';
  // og:title is "<caption> - @handle's Sex Reel On xfree.com ...". Strip the
  // generic tail; some clips have no caption (the whole title is the tail).
  let caption = ogTitle
    .replace(/\s*[-–—]\s*@[A-Za-z0-9_.][\s\S]*$/, '')
    .replace(/@[A-Za-z0-9_.]+['’]?s?\s+Sex\s+Reel[\s\S]*$/i, '')
    .replace(/\s*[-–—]?\s*On xfree\.com[\s\S]*$/i, '')
    .trim();
  if (!caption || caption.startsWith('@')) caption = '';
  const id = String(idHint || (mp4.match(/(\d{4,})/) || [])[1] || 'video');

  return {
    kind: 'direct',
    id,
    creator: handle,
    title: caption || id,
    description: caption,
    tags: [],
    sourceUrl: `https://www.xfree.com/video?id=${id}`,
    thumbnail: poster,
    filename: `${handle}-${id}.mp4`,
    downloadUrl: mp4,
    headers: { 'User-Agent': UA, Referer: REFERER },
  };
}

async function resolve(url) {
  const id = videoIdFromUrl(url);
  const html = await impersonateFetch(url);
  return jobFromVideoPage(html, id, null);
}

async function resolveProfile(url) {
  const creator = (new URL(url).pathname.match(/^\/([A-Za-z0-9_.-]+)/) || [])[1] || 'xfree';
  const html = await impersonateFetch(url);
  // Video ids the page exposes (5+ digits avoids junk like "1234").
  const ids = [...new Set((html.match(/id=(\d{5,})/g) || []).map((m) => m.slice(3)))];
  if (!ids.length) throw new Error('no videos found on this profile page');

  const items = [];
  for (const id of ids) {
    try {
      const page = await impersonateFetch(`https://www.xfree.com/video?id=${id}`);
      items.push(jobFromVideoPage(page, id, creator));
    } catch {
      /* skip a clip that fails to resolve */
    }
  }
  if (!items.length) throw new Error('could not resolve any videos for this profile');
  return { creator, items };
}

module.exports = { name: 'xfree', domain: 'xfree.com', profiles: 'limited', match, isProfile, resolve, resolveProfile };
