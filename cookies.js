// Cookie-file store for yt-dlp (--cookies), enabling private/member-only
// content on sites that need a logged-in session.
//
// Files live in DATA_DIR/cookies as Netscape cookies.txt files:
//   default.txt      -> used for every site that has no dedicated file
//   <domain>.txt     -> used for that domain (and its subdomains)
//
// yt-dlp rewrites the cookie file it is given, so concurrent jobs sharing one
// file could corrupt it — every invocation therefore gets its own throwaway
// temp copy (session updates are intentionally discarded).

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const COOKIES_DIR = path.join(DATA_DIR, 'cookies');

try {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
} catch {
  /* created on demand otherwise */
}

// A user-supplied name -> one safe lowercase file stem ('default' or a domain).
function sanitizeCookieName(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.-]+/g, '')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return n || 'default';
}

function cookieFilePath(name) {
  return path.join(COOKIES_DIR, `${sanitizeCookieName(name)}.txt`);
}

function listCookieFiles() {
  try {
    return fs
      .readdirSync(COOKIES_DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const st = fs.statSync(path.join(COOKIES_DIR, f));
        return { name: f.replace(/\.txt$/, ''), size: st.size, updatedAt: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function saveCookieFile(name, text) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  fs.writeFileSync(cookieFilePath(name), String(text));
}

function deleteCookieFile(name) {
  fs.rmSync(cookieFilePath(name), { force: true });
}

// The stored cookie file that applies to a URL: the most specific domain file
// (walking up the hostname's labels), else default.txt, else null.
function cookieFileFor(url) {
  let host = '';
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    /* fall through to default */
  }
  const labels = host.split('.').filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    const p = cookieFilePath(labels.slice(i).join('.'));
    if (fs.existsSync(p)) return p;
  }
  const def = cookieFilePath('default');
  return fs.existsSync(def) ? def : null;
}

// yt-dlp args for a URL: a per-invocation temp copy of the matching cookie
// file (or no args). Call cleanup() after the process exits.
function cookieArgs(url) {
  const src = cookieFileFor(url);
  if (!src) return { args: [], cleanup() {} };
  const tmp = path.join(
    os.tmpdir(),
    `grabbit-ck-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  try {
    fs.copyFileSync(src, tmp);
  } catch {
    return { args: [], cleanup() {} };
  }
  return {
    args: ['--cookies', tmp],
    cleanup() {
      fs.rm(tmp, { force: true }, () => {});
    },
  };
}

module.exports = {
  COOKIES_DIR,
  sanitizeCookieName,
  listCookieFiles,
  saveCookieFile,
  deleteCookieFile,
  cookieFileFor,
  cookieArgs,
};
