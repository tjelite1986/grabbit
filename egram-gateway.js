'use strict';
// Grabbit 3.0 phase 2: the Elitogram (egram) gateway.
//
// The hub's Social & Photos module talks to Elitogram's own HTTP API through
// this gateway, mounted at /api/egram/*. Elitogram keeps its database, accounts
// and media; Grabbit stores none of them. It works like the TikShortis gateway
// (tikshortis-gateway.js), with one difference that matters: Elitogram holds
// general, unclassified and 18+ material side by side, so the gateway narrows
// every request to an audience and then checks every answer against it.
//
// Audience, the owner's decision for phase 2:
//   - every request upstream carries `X-Egram-Audience`. Elitogram treats a
//     scoped request as locked out of 18+, whatever cookies it carries, and
//     shows only that audience;
//   - the scope is `general` unless the request asks for the review lane
//     (`lane=review` in its query), which uses `unknown`: posts nobody has
//     classified yet, shown only in the labelled Review lane;
//   - 18+ is never reachable from the module: no lane asks for it, the 18+
//     unlock is never forwarded, and an answer that carries anything 18+ is
//     cleaned or refused;
//   - on the way back, every post, tile and creator must carry the lane's
//     audience, and its author must not match a Grabbit profile classified
//     18+ (Elitogram does not know Grabbit's classification). Media must say
//     which audience and creator they belong to (X-Egram-Audience,
//     X-Egram-Creator) and are refused when either does not fit.
//
// Accounts: Grabbit's own sign-in gates /api/egram like every /api route. The
// Elitogram account is linked separately: the owner enters its user name and
// password once, the gateway signs in and keeps only the session, sealed in a
// Grabbit cookie a page script cannot read.

const http = require('http');
const https = require('https');
const { pipeline } = require('stream');
const { parseApiUrl, sealSession, openSession } = require('./tikshortis-gateway');

const EGRAM_COOKIE = 'grabbit_egram';
const COOKIE_PATH = '/api/egram';
const SESSION_DAYS = 30;
const UPSTREAM_COOKIE = 'eg_session';
const SEAL_PURPOSE = 'egram';

const LANES = { general: 'general', review: 'unknown' };

// --- Sealed session cookie (same sealing as the TikShortis link, own purpose) ---

function seal(secret, data) {
  return sealSession(`${secret}\u0000${SEAL_PURPOSE}`, data);
}
function unseal(secret, raw) {
  return openSession(`${secret}\u0000${SEAL_PURPOSE}`, raw);
}

function cookieHeader(req, value, maxAgeSec) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return [`${EGRAM_COOKIE}=${value}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, ...(secure ? ['Secure'] : [])].join('; ');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// --- Lane ------------------------------------------------------------------------
// Read from the raw query string, first value only, like the TikShortis gate
// reads ids: anything but exactly `review` is the general lane.
function laneOf(req) {
  const url = req.originalUrl || req.url || '';
  const q = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
  return q.getAll('lane')[0] === 'review' ? 'review' : 'general';
}

// --- Route allowlist ---------------------------------------------------------------
// Below /api/ (JSON) or /m/ (media) on Elitogram. Anything else is a 404 from
// the gateway. Deliberately absent: auth/* (only through /api/egram/session),
// adult/* (the 18+ unlock), me/pin, admin/*, uploads, post edits other than
// the audience, deletes, merges, users/* and notifications.
//   media   piped as it comes, Range passed through
//   picture an avatar or banner: may be Elitogram's generated SVG
//   body    the JSON keys a write may carry; everything else is dropped
const ID = '(\\d{1,12})';
const HANDLE = '([a-z0-9._~-]{1,100})';
const TAG = '([^/?#]{1,100})';
const r = (m, path, opts = {}) => ({ m, p: new RegExp(`^${path}$`), ...opts });
const ROUTES = [
  // Posts
  r('GET', 'api/feed'),
  r('GET', 'api/explore'),
  r('GET', 'api/search'),
  r('GET', 'api/liked'),
  r('GET', 'api/hashtags'),
  r('GET', `api/hashtags/${TAG}`),
  r('GET', `api/posts/${ID}`),
  r('PATCH', `api/posts/${ID}`, { body: ['audience'] }),
  r('POST', `api/posts/${ID}/like`),
  r('DELETE', `api/posts/${ID}/like`),
  r('GET', `api/posts/${ID}/comments`),
  r('POST', `api/posts/${ID}/comments`, { body: ['body'] }),
  // Creators
  r('GET', 'api/creators'),
  r('GET', `api/creators/${HANDLE}`),
  r('GET', `api/creators/${HANDLE}/posts`),
  r('POST', `api/creators/${HANDLE}/follow`),
  r('DELETE', `api/creators/${HANDLE}/follow`),
  // Photos, categories, collections, favorites, history
  r('GET', 'api/photos'),
  r('GET', 'api/categories'),
  r('GET', 'api/collections'),
  r('POST', 'api/collections', { body: ['name'] }),
  r('PATCH', `api/collections/${ID}`, { body: ['name'] }),
  r('DELETE', `api/collections/${ID}`),
  r('GET', `api/collections/${ID}/posts`),
  r('POST', `api/collections/${ID}/items`, { body: ['post_id'] }),
  r('DELETE', `api/collections/${ID}/items/${ID}`),
  r('GET', `api/posts/${ID}/collections`),
  r('POST', `api/posts/${ID}/favorite`),
  r('DELETE', `api/posts/${ID}/favorite`),
  r('GET', 'api/favorites'),
  r('POST', `api/posts/${ID}/view`),
  r('GET', 'api/history'),
  r('DELETE', 'api/history'),
  // Media
  r('GET', `m/${ID}`, { media: true }),
  r('GET', `m/${ID}/t`, { media: true }),
  r('GET', `m/ca/${ID}`, { media: true, picture: true }),
  r('GET', `m/cb/${ID}`, { media: true, picture: true }),
  r('GET', `m/ua/${ID}`, { media: true, picture: true }),
];

function matchRoute(method, rest) {
  const m = method === 'HEAD' ? 'GET' : method;
  return ROUTES.find((x) => x.m === m && x.p.test(rest)) || null;
}

// --- Response filter -------------------------------------------------------------
// Objects that are a post, a grid tile, a photo or a creator must carry an
// `audience` equal to the lane's, and their author must not be 18+ in Grabbit.
// Something that looks like one of them without an audience is dropped (fail
// closed). Search and mention hits (handle, no audience) are checked by handle.
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

function authorHandle(o) {
  if (o.author && typeof o.author === 'object' && typeof o.author.handle === 'string') return o.author.handle;
  if (typeof o.author_handle === 'string') return o.author_handle;
  if (typeof o.handle === 'string') return o.handle;
  return null;
}

const looksLikePost = (o) => Number.isInteger(o.id) && (Array.isArray(o.media) || 'media_id' in o || ('author' in o && 'caption' in o));
const looksLikePhoto = (o) => Number.isInteger(o.media_id) && Number.isInteger(o.post_id);
const looksLikeCreator = (o) => Number.isInteger(o.id) && typeof o.handle === 'string' && ('post_count' in o || 'follower_count' in o);

function allowedItem(o, want, isAdultHandle) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return true;
  const shaped = looksLikePost(o) || looksLikePhoto(o) || looksLikeCreator(o);
  if (o.adult === true || o.audience === 'adult') return false;
  if (o.author && typeof o.author === 'object' && o.author.adult === true) return false;
  // A post, tile, photo or creator must name the lane's audience; anything
  // else that names an audience must name that one too.
  if (shaped ? o.audience !== want : 'audience' in o && o.audience !== want) return false;
  const h = authorHandle(o);
  if (h && isAdultHandle && isAdultHandle(h)) return false;
  return true;
}

// Walks a JSON value and removes everything not allowed. A dropped array entry
// disappears; a dropped property becomes null. Returns the value and how many
// objects were dropped.
function filterAnswer(value, want, isAdultHandle) {
  let dropped = 0;
  const walk = (v) => {
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        if (!allowedItem(x, want, isAdultHandle)) { dropped++; continue; }
        out.push(walk(x));
      }
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (!allowedItem(x, want, isAdultHandle)) { dropped++; out[k] = null; continue; }
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  if (!allowedItem(value, want, isAdultHandle)) return { value: null, dropped: 1 };
  return { value: walk(value), dropped };
}

// Content types passed back. Elitogram's generated avatars and banners are
// SVG; nothing else may be, and every media answer gets a sandbox CSP.
function allowedType(ct, route) {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  if (!route.media) return t === 'application/json';
  if (t === 'image/svg+xml') return !!route.picture;
  return /^(video|audio)\/[a-z0-9.+-]+$/.test(t) || /^image\/(jpeg|png|webp|gif|avif)$/.test(t);
}

// A post's file must name the lane's audience and a creator who is not 18+ in
// Grabbit. Pictures (avatars, banners) carry neither; Elitogram already serves
// a neutral picture for a creator outside the scope.
function mediaAllowed(route, headers, want, isAdultHandle) {
  if (route.picture) return true;
  if (headers['x-egram-audience'] !== want) return false;
  const creator = headers['x-egram-creator'];
  if (creator && isAdultHandle && isAdultHandle(String(creator))) return false;
  return true;
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];

// --- The gateway ---------------------------------------------------------------

function createGateway({ apiUrl, secret, isAdultHandle = null, clientIp = (req) => req.ip || '', log = console, timeoutMs = 30000 }) {
  const origin = parseApiUrl(apiUrl);
  if (!origin) throw new Error('EGRAM_API_URL is not a plain http(s) origin');
  const up = new URL(origin);
  const mod = up.protocol === 'https:' ? https : http;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: 32 });

  function upstream(req, { method, path, headers, body, signal }) {
    return new Promise((resolve, reject) => {
      const h = {
        host: up.host,
        'user-agent': 'grabbit-egram-gateway',
        // Elitogram's write check accepts Sec-Fetch-Site: same-origin when no
        // Origin is sent. The gateway stands in for Elitogram's own page;
        // Grabbit has already refused anything not from its own pages.
        'sec-fetch-site': 'same-origin',
        'x-real-ip': clientIp(req) || 'unknown',
        ...headers,
      };
      const rq = mod.request({ agent, protocol: up.protocol, hostname: up.hostname, port: up.port, method, path, headers: h, timeout: timeoutMs }, (res) => {
        res.on('error', (e) => log.warn(`[egram] upstream answer ${method} ${path.split('?')[0]}: ${e.message}`));
        resolve(res);
      });
      rq.on('timeout', () => rq.destroy(new Error('Elitogram did not answer in time')));
      rq.on('error', reject);
      if (signal) signal.once('close', () => { if (!rq.destroyed) rq.destroy(); });
      rq.end(body || undefined);
    });
  }

  function readJson(res, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > limit) { res.destroy(); reject(new Error('Elitogram answer too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(text ? JSON.parse(text) : null); } catch { reject(new Error('Elitogram sent something that is not JSON')); }
      });
      res.on('error', reject);
    });
  }

  const fail = (res, status, error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.status(status).set('Cache-Control', 'no-store').json({ ok: false, error });
  };

  // Same rule as the TikShortis gateway: a browser request must come from one
  // of Grabbit's own pages; without browser headers only a read passes.
  function fromOwnPage(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    for (const v of [req.headers.origin, req.headers.referer]) {
      if (!v) continue;
      try { return new URL(v).host.toLowerCase() === host; } catch { return false; }
    }
    return req.method === 'GET' || req.method === 'HEAD';
  }

  const sessionOf = (req) => unseal(secret, readCookie(req, EGRAM_COOKIE));
  const authHeaders = (cur, lane) => ({ 'x-egram-audience': LANES[lane], ...(cur ? { cookie: `${UPSTREAM_COOKIE}=${cur.t}` } : {}) });

  // One JSON call for Grabbit's own routes (classification): scoped and
  // filtered like any proxied answer. -> { status, json }
  async function callJson(req, method, path, body, lane = 'general') {
    const cur = sessionOf(req);
    const headers = { accept: 'application/json', ...authHeaders(cur, lane) };
    let text;
    if (body !== undefined) {
      text = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(text));
    }
    const res = await upstream(req, { method, path, headers, body: text });
    const json = await readJson(res).catch(() => null);
    return { status: res.statusCode, json, linked: !!cur };
  }

  // GET /api/egram/session -> { linked, user }; POST { username, password }
  // links; DELETE unlinks and ends the Elitogram session too.
  async function session(req, res) {
    if (!fromOwnPage(req)) return fail(res, 403, 'Request not from this site');
    const cur = sessionOf(req);
    try {
      if (req.method === 'GET') {
        if (!cur) return res.set('Cache-Control', 'no-store').json({ ok: true, linked: false });
        const r = await upstream(req, { method: 'GET', path: '/api/me', headers: { accept: 'application/json', ...authHeaders(cur, 'general') } });
        if (r.statusCode !== 200 && r.statusCode !== 401) { r.resume(); return fail(res, 424, 'Elitogram is not reachable right now'); }
        const d = r.statusCode === 200 ? await readJson(r).catch(() => null) : (r.resume(), { user: null });
        // Elitogram answers 200 { user: null } for a session that has ended.
        if (d && d.user === null) {
          res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
          return res.set('Cache-Control', 'no-store').json({ ok: true, linked: false, expired: true });
        }
        const u = d && d.user;
        if (!u || typeof u.username !== 'string') return fail(res, 424, 'Elitogram sent an unexpected answer');
        // Only what the module shows; never the 18+ state or permissions list.
        const user = { username: u.username, display_name: u.display_name || u.username, role: u.role === 'admin' ? 'admin' : 'user', can_classify: u.role === 'admin' || (Array.isArray(u.permissions) && u.permissions.includes('profiles')) };
        return res.set('Cache-Control', 'no-store').json({ ok: true, linked: true, user });
      }
      if (req.method === 'POST') {
        const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!username || !password || username.length > 100 || password.length > 1024) return fail(res, 400, 'User name and password are required');
        const text = JSON.stringify({ username, password });
        const r = await upstream(req, {
          method: 'POST',
          path: '/api/auth/login',
          headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), accept: 'application/json' },
          body: text,
        });
        const d = await readJson(r).catch(() => null);
        const token = [].concat(r.headers['set-cookie'] || []).map((c) => new RegExp(`^${UPSTREAM_COOKIE}=([^;]+)`).exec(c)).find(Boolean);
        if (r.statusCode !== 200 || !token) {
          const status = r.statusCode === 429 ? 429 : r.statusCode === 401 || r.statusCode === 400 ? r.statusCode : 422;
          if (r.headers['retry-after']) res.setHeader('Retry-After', r.headers['retry-after']);
          return fail(res, status, (d && d.error) || 'Elitogram refused the sign-in');
        }
        const exp = Date.now() + SESSION_DAYS * 86400000;
        res.setHeader('Set-Cookie', cookieHeader(req, seal(secret, { t: token[1], exp }), SESSION_DAYS * 86400));
        return res.set('Cache-Control', 'no-store').json({ ok: true, linked: true });
      }
      if (req.method === 'DELETE') {
        if (cur) {
          await upstream(req, { method: 'POST', path: '/api/auth/logout', headers: { accept: 'application/json', 'content-length': '0', cookie: `${UPSTREAM_COOKIE}=${cur.t}` } })
            .then((x) => x.resume())
            .catch(() => {});
        }
        res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
        return res.set('Cache-Control', 'no-store').json({ ok: true, linked: false });
      }
      return fail(res, 405, 'Method not allowed');
    } catch (e) {
      log.warn('[egram] session:', e.message);
      return fail(res, 424, 'Elitogram is not reachable right now');
    }
  }

  async function proxy(req, res) {
    const rest = req.path.replace(/^\/+/, '');
    if (rest === 'session') return session(req, res);
    const route = matchRoute(req.method, rest);
    if (!route) return fail(res, 404, 'Not available through Grabbit');
    if (!fromOwnPage(req)) return fail(res, 403, 'Request not from this site');
    const cur = sessionOf(req);
    if (!cur) return fail(res, 401, 'Link your Elitogram account first');
    const lane = laneOf(req);
    const want = LANES[lane];
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const headers = { accept: req.headers.accept || '*/*', ...authHeaders(cur, lane) };
    if (route.media && req.headers.range) headers.range = req.headers.range;
    for (const k of ['if-none-match', 'if-modified-since']) if (req.headers[k]) headers[k] = req.headers[k];
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Writes carry only the keys this route needs, re-encoded by the gateway.
      const src = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const out = {};
      for (const k of route.body || []) if (k in src) out[k] = src[k];
      body = JSON.stringify(out);
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    let r;
    try {
      r = await upstream(req, { method: req.method, path: `/${rest}${qs}`, headers, body, signal: res });
    } catch (e) {
      log.warn(`[egram] ${req.method} ${rest}: ${e.message}`);
      return fail(res, 424, 'Elitogram is not reachable right now');
    }
    const status = r.statusCode >= 500 ? 424 : r.statusCode;
    if (status === 401) res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
    if (route.media && status < 400 && !mediaAllowed(route, r.headers, want, isAdultHandle)) {
      r.resume();
      log.warn(`[egram] refused ${rest}: audience ${r.headers['x-egram-audience'] || 'missing'} in the ${lane} lane`);
      return fail(res, 404, 'Not found');
    }
    if (status === 304 || req.method === 'HEAD' || status === 204) {
      r.resume();
      for (const k of ['etag', 'last-modified']) if (r.headers[k]) res.setHeader(k, r.headers[k]);
      return res.status(status).end();
    }
    const ct = r.headers['content-type'];
    if (status >= 400) {
      // Errors pass as JSON with Elitogram's message; anything else is replaced.
      const d = String(ct || '').toLowerCase().startsWith('application/json') ? await readJson(r).catch(() => null) : (r.resume(), null);
      return fail(res, status, (d && typeof d.error === 'string' && d.error.slice(0, 300)) || `Elitogram answered ${r.statusCode}`);
    }
    if (!allowedType(ct, route)) {
      r.resume();
      return fail(res, 424, 'Elitogram sent an unexpected kind of file');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (route.media) {
      res.status(status);
      // Stored by the browser but revalidated on every use, so a post that was
      // reclassified is judged again (ETag makes that a cheap 304).
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      for (const k of PASS_HEADERS) if (r.headers[k]) res.setHeader(k, r.headers[k]);
      pipeline(r, res, (e) => { if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warn(`[egram] stream ${rest}: ${e.message}`); });
      return;
    }
    let d;
    try { d = await readJson(r); } catch (e) { return fail(res, 424, e.message); }
    const { value, dropped } = filterAnswer(d, want, isAdultHandle);
    if (dropped) log.warn(`[egram] dropped ${dropped} item(s) outside the ${lane} lane from ${rest}`);
    if (value === null) return fail(res, 404, 'Not found');
    res.status(status).set('Cache-Control', 'private, no-store');
    return res.json(value);
  }

  return { origin, proxy, session, callJson, routes: ROUTES };
}

module.exports = {
  EGRAM_COOKIE,
  COOKIE_PATH,
  LANES,
  ROUTES,
  laneOf,
  matchRoute,
  filterAnswer,
  allowedType,
  mediaAllowed,
  seal,
  unseal,
  createGateway,
};
