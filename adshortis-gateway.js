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
const BODY_LIMIT = 16 * 1024;
// The upstream session token (base64url) and user id as Adshortis issues them.
const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;
const validUserId = (v) => (Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^[0-9]{1,15}$/.test(v));
// The server skips its global body parsers for these paths (the gateway reads
// its own body after its checks) and gives early refusals the answer headers.
const isMountPath = (p) => {
  const l = String(p || '').toLowerCase();
  return l === MOUNT || l.startsWith(`${MOUNT}/`);
};

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
// The request body as JSON, read only after the caller passed every check.
// Bounded; a body something else already parsed is used as is. Rejects with
// { status } for a wrong type, an oversized or an unparsable body.
function readBody(req, limit = BODY_LIMIT) {
  if (req._body) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      reject({ status: 415 });
      req.resume();
      return;
    }
    const chunks = [];
    let n = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > limit) { done = true; reject({ status: 413 }); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject({ status: 400 }); }
    });
    req.on('error', () => { if (!done) { done = true; reject({ status: 400 }); } });
  });
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

  // POST /logout runs before the auth gate and outside this mount. It may end
  // an Adshortis link only for the owner's own page over https, by the same
  // rules as a write here (G2); anything else keeps its hands off the link.
  function mayRevoke(req) {
    if (!isOwner(req) || !isSecure(req)) return false;
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    return req.headers.origin === own;
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
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return fail(res, e && e.status ? e.status : 400, 'User name and password are required');
    }
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password || username.length > 100 || password.length > 1024) return fail(res, 400, 'User name and password are required');
    // The link as it is now: the commit below happens only if no unlink or
    // other link landed while upstream was answering.
    const rev = links.revOf(loginId);
    const previous = sealOf(req, loginId);
    let r;
    try {
      r = await upstream(req, { method: 'POST', path: '/api/login', body: JSON.stringify({ username, password }) });
    } catch (e) {
      log.warn('[ads] S1 upstream unreachable');
      return fail(res, 424, 'Adshortis is not reachable right now');
    }
    const d = await readJson(r).catch(() => undefined);
    const json = d !== null && typeof d === 'object' && !Array.isArray(d);
    const m = [].concat(r.headers['set-cookie'] || []).map((c) => new RegExp(`^${UPSTREAM_COOKIE}=([^;]*)`).exec(c)).find(Boolean);
    const t = m && TOKEN_RE.test(m[1]) ? m[1] : null;
    if (r.statusCode !== 200) {
      // A JSON refusal keeps its status (401 wrong password, 429 throttled);
      // a redirect, a 5xx or a body that is not a JSON object is 424.
      if (r.statusCode >= 400 && r.statusCode < 500 && json) {
        if (r.statusCode === 429 && r.headers['retry-after']) res.setHeader('Retry-After', String(r.headers['retry-after']).slice(0, 16));
        return fail(res, r.statusCode, typeof d.error === 'string' ? d.error.slice(0, 200) : 'Adshortis refused the sign-in');
      }
      if (t) upstreamLogout(req, t);
      return fail(res, 424, 'Adshortis is not reachable right now');
    }
    if (!json || d.ok !== true || !t) {
      if (t) upstreamLogout(req, t);
      return fail(res, 424, 'Adshortis sent an unexpected answer');
    }
    // Who signed in (H17): /api/login answers only { ok: true }.
    let user = null;
    try {
      const me = await upstream(req, { method: 'GET', path: '/api/me', token: t });
      if (me.statusCode === 200) user = matrix.projectSession(await readJson(me).catch(() => null), phase);
      else me.resume();
    } catch { /* user stays null */ }
    if (!user || !validUserId(user.id)) {
      upstreamLogout(req, t);
      return fail(res, 424, 'Adshortis sent an unexpected answer');
    }
    user.avatar = rewriteMediaUrl(user.avatar);
    let sealed;
    try {
      sealed = links.seal(loginId, { t, u: user.id }, rev);
    } catch {
      upstreamLogout(req, t);
      log.error('[ads] S1 could not store the link');
      return fail(res, 424, 'The link could not be saved');
    }
    if (sealed === false) {
      upstreamLogout(req, t);
      return fail(res, 409, 'The link changed while signing in; try again');
    }
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
      log.warn('[ads] S2 upstream unreachable');
      return fail(res, 424, 'Adshortis is not reachable right now');
    }
    if (r.statusCode === 401) {
      r.resume();
      // Only the link this request read ends. If a newer link replaced it
      // meanwhile, that one and its cookie stay.
      if (links.clearSeal(loginId, readCookie(req, LINK_COOKIE)) === 'changed') {
        return fail(res, 409, 'The link changed; try again');
      }
      res.append('Set-Cookie', clearCookie(LINK_COOKIE));
      return answer(res, 200, { ok: true, linked: false, expired: true });
    }
    if (r.statusCode !== 200) {
      // Other JSON 4xx keep their status (GW-ANSWER); the rest is 424.
      const d = await readJson(r).catch(() => undefined);
      if (r.statusCode >= 400 && r.statusCode < 500 && d !== null && typeof d === 'object' && !Array.isArray(d)) {
        return fail(res, r.statusCode, typeof d.error === 'string' ? d.error.slice(0, 200) : 'Adshortis refused the request');
      }
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

  return { origin, handle, upstreamLogout, sealOf, mayRevoke };
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
  isMountPath,
  baseHeaders,
  linkCookie,
  loginCookie,
  clearCookie,
  rewriteMediaUrl,
  createGateway,
};
