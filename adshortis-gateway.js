'use strict';
// Grabbit 3.0 native Adshortis, phase 1: the gateway at /api/ads/*.
//
// Adshortis is the 18+ app. Grabbit reaches its API server-side and the hub
// never talks to it directly; the shape follows tikshortis-gateway.js and
// egram-gateway.js, with stricter rules (plan parts 1-3 and 11):
//
//   - Only the owner's browser session reaches it. The internal token and GDA
//     app clients are refused (403) on every row, before anything else.
//   - HTTPS only: both cookies are __Host- cookies.
//   - The method + path allowlist is ads-route-matrix.js matchRoute() and
//     nothing else. In phase 1 only the session rows S1-S3 are live; every
//     other path answers 404 "Not available through Grabbit" and is never sent
//     upstream.
//   - Writes must carry an Origin equal to GRABBIT_PUBLIC_ORIGIN exactly, and a
//     Sec-Fetch-Site of same-origin when one is sent. A caller with no browser
//     headers may only read.
//   - The upstream session token is sealed per login id (ads-links.js). A
//     Grabbit session without a login id cannot link (409 login_id_missing).
//   - Upstream writes carry Origin: ADSHORTIS_APP_ORIGIN; the viewer address
//     goes as X-Forwarded-For (Adshortis keys its login throttle on it). The
//     browser's own cookies, Authorization, X-Grabbit-Token and X-Forwarded-*
//     are never forwarded. Redirects are not followed.
//   - Every answer is private, no-store, nosniff, no-referrer. An upstream 5xx,
//     a dead upstream or a wrong content type becomes 424, never a 5xx.
//   - The log carries method, rule and status only: no query strings, names,
//     titles, paths or URLs (S12).

const http = require('http');
const https = require('https');
const matrix = require('./ads-route-matrix');

const LINK_COOKIE = '__Host-grabbit_ads';
const LOGIN_COOKIE = '__Host-grabbit_login';
const UPSTREAM_COOKIE = 'as_session';
const LINK_DAYS = 30;
const MOUNT = '/api/ads';

// --- Settings ------------------------------------------------------------------

// ADSHORTIS_API_URL / ADSHORTIS_APP_ORIGIN: a plain http(s) origin.
function parseOrigin(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\/$/, '');
  if (!s || !/^https?:\/\/[a-z0-9.\-[\]:]+$/i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.username || u.password || (u.pathname && u.pathname !== '/')) return null;
    return u.origin;
  } catch {
    return null;
  }
}
// GRABBIT_PUBLIC_ORIGIN / ADSHORTIS_EMBED_URL: https only.
function parseHttpsOrigin(raw) {
  const o = parseOrigin(raw);
  return o && o.startsWith('https://') ? o : null;
}

// --- Cookies ---------------------------------------------------------------------

// Express' req.secure: true for TLS, or X-Forwarded-Proto: https from a proxy
// GRABBIT_TRUST_PROXY trusts. A raw header from an untrusted peer does not count.
const isSecure = (req) => !!req.secure;

function hostCookie(name, value, maxAgeSec) {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${maxAgeSec}`].join('; ');
}
const linkCookie = (value) => hostCookie(LINK_COOKIE, value, LINK_DAYS * 86400);
const loginCookie = (value, days) => hostCookie(LOGIN_COOKIE, value, days * 86400);
const clearCookie = (name) => hostCookie(name, '', 0);

// The value of a cookie sent exactly once. A name sent twice (one planted for a
// parent domain, say) counts as no cookie at all.
function readCookie(req, name) {
  let found = null;
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      if (found !== null) return null;
      found = part.slice(i + 1).trim();
    }
  }
  return found;
}

// --- Answers ----------------------------------------------------------------------

function baseHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
function answer(res, status, body) {
  if (res.headersSent) { res.destroy(); return; }
  baseHeaders(res);
  res.status(status).json(body);
}
const fail = (res, status, error, extra) => answer(res, status, { ok: false, error, ...(extra || {}) });

// A media path from upstream JSON: relative /m/... becomes /api/ads/m/...;
// anything else (absolute, protocol-relative, foreign, odd) is dropped.
function rewriteMediaUrl(v) {
  if (typeof v !== 'string') return null;
  if (!/^\/m\/[A-Za-z0-9._~\-/]{1,500}$/.test(v) || v.includes('//') || v.split('/').includes('..')) return null;
  return MOUNT + v;
}

// --- The gateway -------------------------------------------------------------------

function createGateway({
  apiUrl,
  appOrigin,
  publicOrigin,
  links,
  isOwner,
  clientIp = (req) => req.ip || '',
  log = console,
  timeoutMs = 15000,
  phase = '1',
  met = new Set(),
}) {
  const origin = parseOrigin(apiUrl);
  if (!origin) throw new Error('ADSHORTIS_API_URL is not a plain http(s) origin');
  const app = parseOrigin(appOrigin);
  if (!app) throw new Error('ADSHORTIS_APP_ORIGIN is not a plain http(s) origin');
  const own = parseHttpsOrigin(publicOrigin);
  if (!own) throw new Error('GRABBIT_PUBLIC_ORIGIN is not an https origin');
  if (!links || typeof isOwner !== 'function') throw new Error('createGateway needs links and isOwner');
  const up = new URL(origin);
  const mod = up.protocol === 'https:' ? https : http;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: 16 });

  // One request upstream; resolves with the response (not consumed). Only the
  // headers built here are sent: nothing of the browser's request is copied.
  function upstream(req, { method, path, token, body }) {
    return new Promise((resolve, reject) => {
      const h = {
        host: up.host,
        'user-agent': 'grabbit-ads-gateway',
        accept: 'application/json',
        'x-forwarded-for': String(clientIp(req) || '').slice(0, 64) || 'unknown',
      };
      if (method !== 'GET' && method !== 'HEAD') {
        h.origin = app;
        h['content-length'] = String(body ? Buffer.byteLength(body) : 0);
        if (body) h['content-type'] = 'application/json';
      }
      if (token) h.cookie = `${UPSTREAM_COOKIE}=${token}`;
      const r = mod.request({ agent, protocol: up.protocol, hostname: up.hostname, port: up.port, method, path, headers: h, timeout: timeoutMs }, (res) => {
        res.on('error', () => {});
        resolve(res);
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', reject);
      r.end(body || undefined);
    });
  }

  function readJson(res, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      if (!String(res.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        res.resume();
        reject(new Error('not json'));
        return;
      }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > limit) { res.destroy(); reject(new Error('too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new Error('not json')); }
      });
      res.on('error', reject);
    });
  }

  // Best effort: end an upstream session. Never throws, never waits long.
  function upstreamLogout(req, token) {
    if (!token) return Promise.resolve();
    return upstream(req, { method: 'POST', path: '/api/logout', token })
      .then((r) => r.resume())
      .catch(() => {});
  }

  // Origin rules (S3). Reads: Sec-Fetch-Site same-origin when sent; an Origin,
  // when sent, must be ours. Writes additionally need Origin == our origin.
  function originOk(req) {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    const o = req.headers.origin;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (o === undefined) return read;
    return o === own;
  }

  const sealOf = (req, loginId) => links.open(loginId, readCookie(req, LINK_COOKIE));

  async function handle(req, res) {
    const method = String(req.method).toUpperCase();
    const full = MOUNT + (req.path === '/' ? '' : req.path);
    let rule = '-';
    res.on('finish', () => log.log(`[ads] ${method} ${rule} ${res.statusCode}`));

    if (!isOwner(req)) return fail(res, 403, 'Not for this caller');
    if (!isSecure(req)) return fail(res, 403, 'HTTPS required');
    const hit = matrix.matchRoute(method, full, phase, met);
    if (!hit) return fail(res, 404, 'Not available through Grabbit');
    rule = hit.row.row;
    if (!originOk(req)) return fail(res, 403, 'Request not from this site');

    const loginId = readCookie(req, LOGIN_COOKIE);
    const loginOk = !!loginId && links.loginValid(loginId);

    if (rule === 'S1') return link(req, res, loginOk ? loginId : null);
    if (rule === 'S2') return status(req, res, loginOk ? loginId : null);
    if (rule === 'S3') return unlink(req, res, loginOk ? loginId : null);

    // Any other live row: an unlinked caller is 401 before upstream. This build
    // carries no proxy for member rows yet, so a linked one gets the 404.
    const cur = loginOk ? sealOf(req, loginId) : null;
    if (!cur) {
      if (readCookie(req, LINK_COOKIE) !== null) res.append('Set-Cookie', clearCookie(LINK_COOKIE));
      return fail(res, 401, 'Adshortis is not linked');
    }
    return fail(res, 404, 'Not available through Grabbit');
  }

  // S1: POST { username, password } -> { ok, linked, user }.
  async function link(req, res, loginId) {
    const nl = matrix.sessionPreflight('POST', `${MOUNT}/session`, loginId || '');
    if (nl) return answer(res, nl.status, { ...nl.body });
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password || username.length > 100 || password.length > 1024) return fail(res, 400, 'User name and password are required');
    const previous = sealOf(req, loginId);
    let r;
    try {
      r = await upstream(req, { method: 'POST', path: '/api/login', body: JSON.stringify({ username, password }) });
    } catch (e) {
      log.warn(`[ads] S1 upstream unreachable (${e.code || 'error'})`);
      return fail(res, 424, 'Adshortis is not reachable right now');
    }
    const d = await readJson(r).catch(() => null);
    const token = [].concat(r.headers['set-cookie'] || []).map((c) => new RegExp(`^${UPSTREAM_COOKIE}=([^;]+)`).exec(c)).find(Boolean);
    if (r.statusCode !== 200 || !token) {
      if (r.statusCode >= 500 || r.statusCode === 200) return fail(res, 424, 'Adshortis is not reachable right now');
      if (r.statusCode === 429 && r.headers['retry-after']) res.setHeader('Retry-After', String(r.headers['retry-after']).slice(0, 16));
      const msg = d && typeof d.error === 'string' ? d.error.slice(0, 200) : 'Adshortis refused the sign-in';
      return fail(res, r.statusCode, msg);
    }
    const t = token[1];
    // Who signed in (H17): /api/login answers only { ok: true }.
    let user = null;
    try {
      const me = await upstream(req, { method: 'GET', path: '/api/me', token: t });
      if (me.statusCode === 200) user = matrix.projectSession(await readJson(me).catch(() => null), phase);
      else me.resume();
    } catch { /* user stays null */ }
    if (!user) {
      upstreamLogout(req, t);
      return fail(res, 424, 'Adshortis sent an unexpected answer');
    }
    user.avatar = rewriteMediaUrl(user.avatar);
    const sealed = links.seal(loginId, { t, u: user.id });
    if (!sealed) {
      upstreamLogout(req, t);
      return answer(res, matrix.NL_RESPONSE.status, { ...matrix.NL_RESPONSE.body });
    }
    // A re-link replaces the old seal; end the old upstream session too.
    if (previous && previous.t !== t) upstreamLogout(req, previous.t);
    res.append('Set-Cookie', linkCookie(sealed));
    return answer(res, 200, { ok: true, linked: true, user });
  }

  // S2: GET -> { ok, linked, user } (user = exactly projectSession's keys).
  async function status(req, res, loginId) {
    if (!loginId) {
      if (readCookie(req, LINK_COOKIE) !== null) res.append('Set-Cookie', clearCookie(LINK_COOKIE));
      return answer(res, 200, { ok: true, linked: false, reason: 'login_id_missing' });
    }
    const cur = sealOf(req, loginId);
    if (!cur) {
      if (readCookie(req, LINK_COOKIE) !== null) res.append('Set-Cookie', clearCookie(LINK_COOKIE));
      return answer(res, 200, { ok: true, linked: false });
    }
    let r;
    try {
      r = await upstream(req, { method: 'GET', path: '/api/me', token: cur.t });
    } catch (e) {
      log.warn(`[ads] S2 upstream unreachable (${e.code || 'error'})`);
      return fail(res, 424, 'Adshortis is not reachable right now');
    }
    if (r.statusCode === 401) {
      r.resume();
      links.clearSeal(loginId);
      res.append('Set-Cookie', clearCookie(LINK_COOKIE));
      return answer(res, 200, { ok: true, linked: false, expired: true });
    }
    if (r.statusCode !== 200) {
      r.resume();
      return fail(res, 424, 'Adshortis is not reachable right now');
    }
    const user = matrix.projectSession(await readJson(r).catch(() => null), phase);
    if (!user) return fail(res, 424, 'Adshortis sent an unexpected answer');
    user.avatar = rewriteMediaUrl(user.avatar);
    return answer(res, 200, { ok: true, linked: true, user });
  }

  // S3: DELETE. The local seal record goes first, so the link is dead even if
  // the upstream logout fails or never arrives.
  async function unlink(req, res, loginId) {
    const cur = loginId ? sealOf(req, loginId) : null;
    if (loginId) links.clearSeal(loginId);
    res.append('Set-Cookie', clearCookie(LINK_COOKIE));
    if (cur) await upstreamLogout(req, cur.t);
    return answer(res, 200, { ok: true, linked: false });
  }

  return { origin, handle, upstreamLogout, sealOf };
}

module.exports = {
  LINK_COOKIE,
  LOGIN_COOKIE,
  UPSTREAM_COOKIE,
  MOUNT,
  parseOrigin,
  parseHttpsOrigin,
  readCookie,
  isSecure,
  linkCookie,
  loginCookie,
  clearCookie,
  rewriteMediaUrl,
  createGateway,
};
