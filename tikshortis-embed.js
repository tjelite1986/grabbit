'use strict';
// Grabbit 2.2: TikShortis inside the hub.
//
// TIKSHORTIS_EMBED_URL names the TikShortis app's own address. Set, the hub
// gets a TikShortis page that shows that app in a frame: its own pages, its
// own sign-in, its own database and media. Grabbit stores nothing of it and
// proxies nothing; the frame talks to TikShortis directly. Unset (or not a
// plain https address) means the page and its config entry do not exist, so
// switching the integration off is removing the variable and restarting.
//
// TikShortis must allow the frame: its EMBED_FRAME_ANCESTORS has to name this
// hub's origin, otherwise the browser shows an empty frame.

const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

// -> { origin, url } or null. Only an origin (an optional trailing slash is
// dropped); a path, query, credentials or another scheme turns it off.
function parseEmbedUrl(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\/$/, '').toLowerCase();
  if (!s) return null;
  if (!ORIGIN_RE.test(s) && !LOCAL_RE.test(s)) return null;
  return { origin: s, url: `${s}/` };
}

// A path inside TikShortis for the frame, from the hub's address. Anything
// that is not a plain absolute path (another origin, "//host", a scheme,
// backslashes, control characters) falls back to the start page.
function framePath(raw) {
  const p = String(raw == null ? '' : raw);
  if (!p.startsWith('/') || p.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(p) || p.length > 2000) return '/';
  try {
    const u = new URL(p, 'https://x.invalid');
    if (u.origin !== 'https://x.invalid') return '/';
    return u.pathname + u.search;
  } catch {
    return '/';
  }
}

module.exports = { parseEmbedUrl, framePath };
