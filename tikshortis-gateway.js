'use strict';
// Grabbit 3.0 phase 1: the TikShortis gateway.
//
// The hub's native TikShortis pages talk to TikShortis' own HTTP API through
// this gateway, mounted at /api/tik/*. TikShortis keeps its backend, database,
// accounts and media; Grabbit stores none of its data and makes no copy of it.
//
// Why a gateway and not the browser calling TikShortis directly:
//   - one origin: the hub's CSP, the service worker rule (never touch /api/) and
//     Grabbit's own cross-site check cover TikShortis too, with no CORS on
//     TikShortis and no TikShortis cookie in a page it did not serve;
//   - the TikShortis session is held server-side, sealed in a Grabbit cookie
//     (see sealSession), so a page script can never read it;
//   - every request is checked against an allowlist of method + path, so the
//     hub cannot reach a TikShortis route this module does not use, and the
//     admin token can never be sent from a browser;
//   - responses are checked on the way back: only JSON and media types pass,
//     clips that are not in TikShortis' general channel are dropped, and media
//     is served with a sandbox CSP so nothing from upstream runs on this origin.
//
// Accounts: Grabbit's own sign-in (the owner password) gates /api/tik like every
// /api route. The TikShortis account is linked separately and explicitly: the
// owner enters that account's email and password once, the gateway signs in to
// TikShortis with them and keeps only the resulting session. Nothing is ever
// matched or merged by user name.

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const TIK_COOKIE = 'grabbit_tik';
const COOKIE_PATH = '/api/tik';
const SESSION_DAYS = 30;
const UPSTREAM_COOKIE = 'tikshortis_session';

// --- Settings ------------------------------------------------------------------

// TIKSHORTIS_API_URL: where Grabbit reaches TikShortis, normally the LAN port
// (http://host:port), never through a public proxy. Origin only.
function parseApiUrl(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\/$/, '');
  if (!s) return null;
  if (!/^https?:\/\/[a-z0-9.\-[\]:]+$/i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.username || u.password || (u.pathname && u.pathname !== '/')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

// --- Sealed session cookie -------------------------------------------------------
// AES-256-GCM under a key derived from Grabbit's auth secret. The cookie holds
// the TikShortis session token and nothing a page could use: it is HttpOnly,
// SameSite=Strict, scoped to /api/tik, and useless without Grabbit's own
// sign-in, which the gateway requires first. A changed secret (new password)
// makes every sealed cookie unreadable, which simply unlinks the account.
function keyFrom(secret) {
  return crypto.createHmac('sha256', String(secret)).update('grabbit-tik-v1').digest();
}
function sealSession(secret, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
function openSession(secret, sealed) {
  try {
    const raw = Buffer.from(String(sealed || ''), 'base64url');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    if (!out || typeof out.t !== 'string' || !out.t) return null;
    if (typeof out.exp === 'number' && out.exp < Date.now()) return null;
    return out;
  } catch {
    return null;
  }
}

function cookieHeader(req, value, maxAgeSec) {
  const https = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return [
    `${TIK_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    ...(https ? ['Secure'] : []),
  ].join('; ');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// --- Route allowlist -----------------------------------------------------------
// Every TikShortis route the native pages use, by method and path (below
// /api/), reconciled with the TikShortis API inventory
// (docs/grabbit-3.0/tikshortis-inventory.md, section 2). Anything else is a 404
// from the gateway, not a request upstream. Role checks stay TikShortis' own:
// listing an admin route here only lets the request through to be judged.
//   filter  the JSON answer can carry clips or profiles: drop every one that is
//           not in the general channel (see filterClips). A string names the
//           property the answer is about: if that one is dropped, the answer
//           is a 404 rather than its leftovers.
//   stream  media: piped as it comes, Range passed through.
//   upload  raw or multipart body, streamed; the x-upload-* headers pass.
// Deliberately absent:
//   auth/login, auth/logout  only through /api/tik/session.
//   shorts/grab/*            TikShortis calling back into Grabbit; the native
//                            pages use Grabbit's own downloader instead.
const ID = '(\\d{1,12})';
const HANDLE = '([A-Za-z0-9._%-]{1,200})';
const r = (m, path, opts = {}) => ({ m, p: new RegExp(`^${path}$`), ...opts });
const ROUTES = [
  // Infra and the viewer
  r('GET', 'version'),
  r('GET', 'health'),
  r('GET', 'me'),
  // Feed and one clip
  r('GET', 'shorts/feed', { filter: true }),
  r('PATCH', `shorts/${ID}`),
  r('DELETE', `shorts/${ID}`),
  r('GET', `shorts/${ID}/video`, { stream: true }),
  r('GET', `shorts/${ID}/poster`, { stream: true }),
  r('POST', `shorts/${ID}/poster`),
  r('POST', `shorts/${ID}/like`),
  r('POST', `shorts/${ID}/hide`),
  r('DELETE', `shorts/${ID}/hide`),
  r('POST', `shorts/${ID}/report`),
  r('GET', `shorts/${ID}/comments`),
  r('POST', `shorts/${ID}/comments`),
  r('PATCH', `shorts/${ID}/visibility`),
  r('PATCH', `shorts/${ID}/channel`),
  r('PATCH', `shorts/${ID}/profile`),
  r('POST', `shorts/${ID}/fetch-title`),
  // The viewer's collections
  r('POST', 'shorts/views'),
  r('GET', 'shorts/hidden'),
  r('DELETE', 'shorts/hidden'),
  r('GET', 'shorts/playlists'),
  r('POST', 'shorts/playlists'),
  r('GET', `shorts/playlists/${ID}`),
  r('PATCH', `shorts/playlists/${ID}`),
  r('DELETE', `shorts/playlists/${ID}`),
  r('POST', `shorts/playlists/${ID}/items`),
  r('DELETE', `shorts/playlists/${ID}/items`),
  // Profiles, creators, people, tags
  r('GET', 'shorts/creators', { filter: true }),
  r('GET', 'shorts/profiles', { filter: true }),
  r('POST', 'shorts/profiles', { filter: true }),
  r('GET', `shorts/profiles/${ID}`, { filter: 'profile' }),
  r('PATCH', `shorts/profiles/${ID}`, { filter: true }),
  r('DELETE', `shorts/profiles/${ID}`),
  r('GET', `shorts/profiles/${ID}/avatar`, { stream: true }),
  r('GET', `shorts/profiles/${ID}/links`),
  r('POST', `shorts/profiles/${ID}/links`),
  r('PATCH', `shorts/profiles/${ID}/links/${ID}`),
  r('DELETE', `shorts/profiles/${ID}/links/${ID}`),
  r('POST', `shorts/profiles/${ID}/poll`),
  r('GET', `shorts/profiles/${ID}/candidates`),
  r('POST', `shorts/profiles/${ID}/candidates`),
  r('GET', 'admin/shorts/profiles'),
  r('POST', 'admin/shorts/merge-profiles'),
  r('GET', `shorts/people/${HANDLE}`),
  r('GET', 'shorts/tags'),
  r('GET', 'shorts/analysis', { filter: true }),
  // Upload and import
  r('POST', 'shorts/upload', { upload: true }),
  r('POST', 'shorts/import'),
  // AI summaries (an admin session; the admin token never passes)
  r('GET', 'shorts/summarize'),
  r('POST', 'shorts/summarize'),
  // Library maintenance (settings tools)
  r('GET', 'shorts/duplicates', { filter: true }),
  r('POST', 'shorts/duplicates'),
  r('POST', 'shorts/duplicates/scan'),
  r('POST', 'shorts/duplicates/resolve'),
  r('GET', 'shorts/maintenance', { filter: true }),
  r('POST', 'shorts/maintenance'),
  r('GET', 'shorts/titles'),
  r('POST', 'shorts/titles/scan'),
  r('GET', 'shorts/captions'),
  r('POST', 'shorts/captions/scan'),
  r('GET', 'admin/shorts/reports', { filter: true }),
  r('POST', 'admin/shorts/reports'),
  // Thumbnails of external candidates
  r('GET', 'image-proxy', { stream: true }),
];

const UPLOAD_HEADERS = ['x-upload-name', 'x-upload-caption', 'x-upload-channel', 'x-upload-visibility'];

function matchRoute(method, rest) {
  const m = method === 'HEAD' ? 'GET' : method;
  return ROUTES.find((r) => r.m === m && r.p.test(rest)) || null;
}

// --- Response filters ------------------------------------------------------------
// TikShortis is the general app: every clip it serves should be in its `main`
// channel. The gateway does not take that on trust. On a filtered route:
//   - any object with a `channel` field other than 'main' is dropped (clips,
//     profiles, duplicate groups, reported clips, analysis rows);
//   - an object that looks like a clip but has no `channel` is dropped too,
//     because the gateway cannot tell where it belongs (fail closed);
//   - a clip Grabbit's own registry knows as adult (`isAdult`) is dropped.
// A dropped array entry disappears; a dropped object property becomes null.
const clipId = (o) => (Number.isInteger(o.id) ? o.id : Number.isInteger(o.short_id) ? o.short_id : null);
const looksLikeClip = (o) => clipId(o) != null && ('storage_key' in o || 'poster_key' in o || 'source_id' in o || 'has_poster' in o);

function allowed(o, isAdult) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return true;
  if ('channel' in o) {
    if (o.channel !== 'main') return false;
  } else if (looksLikeClip(o)) {
    return false;
  }
  if (isAdult && looksLikeClip(o) && isAdult(o)) return false;
  return true;
}

// Walks a JSON value and removes everything not allowed, wherever it sits
// (feed items, group members, nested profiles). Returns the cleaned value and
// how many objects were dropped.
function filterClips(value, isAdult) {
  let dropped = 0;
  const walk = (v) => {
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        if (!allowed(x, isAdult)) { dropped++; continue; }
        out.push(walk(x));
      }
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (!allowed(x, isAdult)) { dropped++; out[k] = null; continue; }
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  if (!allowed(value, isAdult)) return { value: null, dropped: 1 };
  return { value: walk(value), dropped };
}

// Content types the gateway passes back. HTML, SVG, XML and anything unknown
// are refused: the response is served from Grabbit's origin.
function allowedType(ct, stream) {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  if (t === 'application/json') return true;
  if (!stream) return false;
  if (t === 'image/svg+xml') return false;
  return /^(video|audio)\/[a-z0-9.+-]+$/.test(t) || /^image\/(jpeg|png|webp|gif|avif)$/.test(t);
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'retry-after'];

// --- The gateway ------------------------------------------------------------------

function createGateway({ apiUrl, secret, isAdult = null, clientIp = (req) => req.ip || '', log = console, timeoutMs = 30000 }) {
  const origin = parseApiUrl(apiUrl);
  if (!origin) throw new Error('TIKSHORTIS_API_URL is not a plain http(s) origin');
  const up = new URL(origin);
  const agentMod = up.protocol === 'https:' ? https : http;
  const agent = new agentMod.Agent({ keepAlive: true, maxSockets: 32 });

  // One request upstream. Resolves with the upstream response (not consumed).
  function upstream(req, { method, path, headers, body, signal }) {
    return new Promise((resolve, reject) => {
      const h = {
        host: up.host,
        'user-agent': 'grabbit-tik-gateway',
        // TikShortis' own CSRF check: a write must come from a page on its
        // host. The gateway is that page's stand-in; Grabbit has already
        // refused anything that did not come from its own pages.
        ...(method !== 'GET' && method !== 'HEAD' ? { origin } : {}),
        'sec-fetch-site': 'same-origin',
        'x-real-ip': clientIp(req) || 'unknown',
        ...headers,
      };
      const r = agentMod.request({ agent, protocol: up.protocol, hostname: up.hostname, port: up.port, method, path, headers: h, timeout: timeoutMs }, resolve);
      r.on('timeout', () => r.destroy(new Error('TikShortis did not answer in time')));
      r.on('error', reject);
      if (signal) signal.once('close', () => { if (!r.writableEnded || !r.destroyed) r.destroy(); });
      if (body && typeof body.pipe === 'function') body.pipe(r);
      else r.end(body || undefined);
    });
  }

  function readJson(res, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > limit) { res.destroy(); reject(new Error('TikShortis answer too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(text ? JSON.parse(text) : null); } catch { reject(new Error('TikShortis sent something that is not JSON')); }
      });
      res.on('error', reject);
    });
  }

  const fail = (res, status, error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.status(status).set('Cache-Control', 'no-store').json({ ok: false, error });
  };

  // Browsers only: the request must come from one of Grabbit's own pages. The
  // global gate already refuses cross-site; this also refuses a sibling host on
  // the same site (Sec-Fetch-Site: same-site), which SameSite cookies let in.
  function fromOwnPage(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    for (const v of [req.headers.origin, req.headers.referer]) {
      if (!v) continue;
      try { return new URL(v).host.toLowerCase() === host; } catch { return false; }
    }
    // No browser headers at all: only a safe read is allowed.
    return req.method === 'GET' || req.method === 'HEAD';
  }

  function sessionOf(req) {
    return openSession(secret, readCookie(req, TIK_COOKIE));
  }

  // GET /api/tik/session -> { linked, user } ; POST (email, password) links;
  // DELETE unlinks (signs the TikShortis session out too).
  async function session(req, res) {
    if (!fromOwnPage(req)) return fail(res, 403, 'Request not from this site');
    const cur = sessionOf(req);
    try {
      if (req.method === 'GET') {
        if (!cur) return res.set('Cache-Control', 'no-store').json({ ok: true, linked: false });
        // Who the session belongs to, from TikShortis itself (GET /api/me).
        const r = await upstream(req, { method: 'GET', path: '/api/me', headers: { cookie: `${UPSTREAM_COOKIE}=${cur.t}`, accept: 'application/json' } });
        if (r.statusCode === 401) {
          r.resume();
          res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
          return res.set('Cache-Control', 'no-store').json({ ok: true, linked: false, expired: true });
        }
        if (r.statusCode === 404) {
          // A TikShortis older than the native pages: linked, but it cannot
          // say who. The hub shows an "update TikShortis" notice.
          r.resume();
          return res.set('Cache-Control', 'no-store').json({ ok: true, linked: true, user: null, outdated: true });
        }
        if (r.statusCode !== 200) {
          r.resume();
          return fail(res, 424, 'TikShortis is not reachable right now');
        }
        const d = await readJson(r).catch(() => null);
        if (!d || !d.user) return fail(res, 424, 'TikShortis sent an unexpected answer');
        return res.set('Cache-Control', 'no-store').json({ ok: true, linked: true, user: d.user });
      }
      if (req.method === 'POST') {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!email || !password || email.length > 320 || password.length > 1024) return fail(res, 400, 'Email and password are required');
        const r = await upstream(req, {
          method: 'POST',
          path: '/api/auth/login',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const d = await readJson(r).catch(() => null);
        const set = [].concat(r.headers['set-cookie'] || []);
        const token = set.map((c) => new RegExp(`^${UPSTREAM_COOKIE}=([^;]+)`).exec(c)).find(Boolean);
        if (r.statusCode !== 200 || !token) {
          const status = r.statusCode === 429 ? 429 : r.statusCode === 401 || r.statusCode === 400 ? r.statusCode : 422;
          if (r.headers['retry-after']) res.setHeader('Retry-After', r.headers['retry-after']);
          return fail(res, status, (d && d.error) || 'TikShortis refused the sign-in');
        }
        const exp = Date.now() + SESSION_DAYS * 86400000;
        res.setHeader('Set-Cookie', cookieHeader(req, sealSession(secret, { t: token[1], exp }), SESSION_DAYS * 86400));
        return res.set('Cache-Control', 'no-store').json({ ok: true, linked: true });
      }
      if (req.method === 'DELETE') {
        if (cur) {
          // End the TikShortis session too, so a copied cookie dies with it.
          await upstream(req, { method: 'POST', path: '/api/auth/logout', headers: { cookie: `${UPSTREAM_COOKIE}=${cur.t}`, accept: 'application/json' } })
            .then((r) => r.resume())
            .catch(() => {});
        }
        res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
        return res.set('Cache-Control', 'no-store').json({ ok: true, linked: false });
      }
      return fail(res, 405, 'Method not allowed');
    } catch (e) {
      log.warn('[tik] session:', e.message);
      return fail(res, 424, 'TikShortis is not reachable right now');
    }
  }

  async function proxy(req, res) {
    // req.path is relative to the mount point (/api/tik).
    const rest = req.path.replace(/^\/+/, '');
    if (rest === 'session') return session(req, res);
    const route = matchRoute(req.method, rest);
    if (!route) return fail(res, 404, 'Not available through Grabbit');
    if (!fromOwnPage(req)) return fail(res, 403, 'Request not from this site');
    const cur = sessionOf(req);
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const headers = { accept: req.headers.accept || '*/*' };
    if (cur) headers.cookie = `${UPSTREAM_COOKIE}=${cur.t}`;
    if (route.stream && req.headers.range) headers.range = req.headers.range;
    for (const k of ['if-none-match', 'if-modified-since']) if (req.headers[k]) headers[k] = req.headers[k];
    // An upload must reach the gateway unread. A JSON or form body has already
    // been consumed by Grabbit's global parsers, so streaming it on would send
    // an empty body under the original content-length and hang upstream.
    if (route.upload && req._body) return fail(res, 415, 'Uploads must be sent as raw or multipart data');
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (route.upload || !req._body) {
        // Not parsed by express (multipart, raw): stream it as it arrives.
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
        if (route.upload) for (const k of UPLOAD_HEADERS) if (req.headers[k]) headers[k] = String(req.headers[k]).slice(0, 8192);
        if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
        else if (req.headers['transfer-encoding']) headers['transfer-encoding'] = req.headers['transfer-encoding'];
        body = req;
      } else {
        // express.json() already read it; send the same JSON on.
        const text = JSON.stringify(req.body == null ? null : req.body);
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(text));
        body = text;
      }
    }
    let r;
    try {
      r = await upstream(req, { method: req.method, path: `/api/${rest}${qs}`, headers, body, signal: res });
    } catch (e) {
      log.warn(`[tik] ${req.method} ${rest}: ${e.message}`);
      return fail(res, 424, 'TikShortis is not reachable right now');
    }
    // A TikShortis 5xx becomes 424: Cloudflare would replace a 5xx body.
    const status = r.statusCode >= 500 ? 424 : r.statusCode;
    const ct = r.headers['content-type'];
    if (status === 304 || req.method === 'HEAD' || (status === 204)) {
      r.resume();
      for (const k of ['etag', 'last-modified']) if (r.headers[k]) res.setHeader(k, r.headers[k]);
      return res.status(status).end();
    }
    if (!allowedType(ct, route.stream)) {
      r.resume();
      return fail(res, status >= 400 ? status : 424, status >= 400 ? `TikShortis answered ${r.statusCode}` : 'TikShortis sent an unexpected kind of file');
    }
    res.status(status);
    res.setHeader('Cache-Control', route.stream && status < 400 ? 'private, max-age=3600' : 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (route.stream) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    // An upstream session that ended (signed out elsewhere, expired) unlinks here.
    if (status === 401 && cur) res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
    const isJson = String(ct || '').toLowerCase().startsWith('application/json');
    if (isJson && !route.stream) {
      let d;
      try { d = await readJson(r); } catch (e) { return fail(res, 424, e.message); }
      if (route.filter && status < 400) {
        const { value, dropped } = filterClips(d, isAdult);
        if (dropped) log.warn(`[tik] dropped ${dropped} item(s) outside the general channel from ${rest}`);
        if (value === null || (typeof route.filter === 'string' && value[route.filter] == null)) return fail(res, 404, 'Not found');
        d = value;
      }
      return res.json(d);
    }
    for (const k of PASS_HEADERS) if (r.headers[k]) res.setHeader(k, r.headers[k]);
    r.pipe(res);
    res.once('close', () => r.destroy());
  }

  return { origin, proxy, session, routes: ROUTES, upstream };
}

module.exports = {
  TIK_COOKIE,
  parseApiUrl,
  sealSession,
  openSession,
  filterClips,
  allowedType,
  matchRoute,
  UPLOAD_HEADERS,
  createGateway,
  ROUTES,
};
