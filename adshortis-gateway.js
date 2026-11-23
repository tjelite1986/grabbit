'use strict';
// Grabbit 3.0 native Adshortis: the gateway at /api/ads/* (phase 1 session
// rows, phase 3 member and media rows).
//
// Adshortis is the 18+ app. Grabbit reaches its API server-side and the hub
// never talks to it directly; the shape follows tikshortis-gateway.js and
// egram-gateway.js, with stricter rules (plan parts 1-3 and 11):
//
//   - Only the owner's browser session reaches it. The internal token and GDA
//     app clients are refused (403) on every row, before anything else.
//   - HTTPS only: both cookies are __Host- cookies.
//   - The method + path allowlist is ads-route-matrix.js matchRoute() and
//     nothing else, for the phase and the met conditions the server passes.
//     Every other path answers 404 "Not available through Grabbit" and is
//     never sent upstream. What a live member row sends upstream and what of
//     the answer passes back is ads-member-rows.js (upstream path from the
//     row, query and body allowlists, projections).
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
//     a dead upstream or a wrong content type becomes 424, never a 5xx. An
//     upstream 4xx keeps its status with a fixed message, never upstream text;
//     an upstream 401 ends the link.
//   - Media (D1-D3) is streamed, never buffered; a client that goes away ends
//     the upstream request. Upload (M12) streams the request body upstream
//     inside a multipart body the gateway writes itself.
//   - The log carries method, rule and status only: no query strings, names,
//     titles, paths or URLs (S12).

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream');
const matrix = require('./ads-route-matrix');
const rows = require('./ads-member-rows');

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

const { rewriteMediaUrl } = rows;

// Fixed messages for an upstream 4xx on a member row: the status passes, the
// upstream text never does.
const REFUSALS = {
  400: 'Adshortis refused the request',
  403: 'Not allowed',
  404: 'Not found',
  409: 'That changed meanwhile; try again',
  413: 'This file is too large to upload here.',
  415: 'Not a recognised video file',
  422: 'Adshortis could not process the request',
  429: 'Too many requests; try again later',
};
const NOT_AVAILABLE = 'This clip is not available.';
const RASTER = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MEDIA_CSP = "sandbox; default-src 'none'";
const RANGE_RE = /^bytes=[0-9]{0,15}-[0-9]{0,15}$/;
const ETAG_RE = /^(W\/)?"[A-Za-z0-9._-]{1,64}"$/;

// Grabbit's own raster stand-in for an upstream SVG (blank poster, initials
// avatar): one dark pixel, marked X-Grabbit-Placeholder so the hub can tell.
const PLACEHOLDER_PNG = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, 0x18, 0x18, 0x1b]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
})();

// GW-LIMIT: at most `max` calls per key in a fixed window. Returns 0, or the
// seconds until the window ends when the call is over the limit.
function createLimiter({ max = 60, windowMs = 60000, now = Date.now } = {}) {
  const seen = new Map();
  return (key) => {
    const t = now();
    if (seen.size > 5000) for (const [k, e] of seen) if (t - e.start >= windowMs) seen.delete(k);
    let e = seen.get(key);
    if (!e || t - e.start >= windowMs) {
      e = { start: t, n: 0 };
      seen.set(key, e);
    }
    e.n++;
    return e.n > max ? Math.max(1, Math.ceil((e.start + windowMs - t) / 1000)) : 0;
  };
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
  // M12: the largest file accepted (ADSHORTIS_UPLOAD_MAX_MB) and the idle
  // timeout while it streams.
  uploadMaxMb = 4096,
  uploadTimeoutMs = 120000,
  // GW-LIMIT: search and lookup calls per login id per minute.
  searchPerMinute = 60,
  now = Date.now,
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
  // Media streams hold a socket for as long as a video plays; they get their own pool.
  const mediaAgent = new mod.Agent({ keepAlive: true, maxSockets: 32 });
  const uploadMax = Math.max(1, Math.floor(Number(uploadMaxMb) || 4096)) * 1024 * 1024;
  const limited = createLimiter({ max: searchPerMinute, now });

  // The request headers every upstream call starts from: nothing of the
  // browser's request is copied.
  function baseUpHeaders(req, token, accept = 'application/json') {
    const h = {
      host: up.host,
      'user-agent': 'grabbit-ads-gateway',
      accept,
      'x-forwarded-for': String(clientIp(req) || '').slice(0, 64) || 'unknown',
    };
    if (token) h.cookie = `${UPSTREAM_COOKIE}=${token}`;
    return h;
  }

  // One request upstream; resolves with the response (not consumed). Only the
  // headers built here are sent: nothing of the browser's request is copied.
  function upstream(req, { method, path, token, body }) {
    return new Promise((resolve, reject) => {
      const h = baseUpHeaders(req, token);
      if (method !== 'GET' && method !== 'HEAD') {
        h.origin = app;
        h['content-length'] = String(body ? Buffer.byteLength(body) : 0);
        if (body) h['content-type'] = 'application/json';
      }
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

    // Any other live row: an unlinked caller is 401 before upstream.
    const cur = loginOk ? sealOf(req, loginId) : null;
    if (!cur) {
      req.resume();
      if (readCookie(req, LINK_COOKIE) !== null) res.append('Set-Cookie', clearCookie(LINK_COOKIE));
      return fail(res, 401, 'Adshortis is not linked');
    }
    const spec = rows.ROWS[rule];
    if (!spec) {
      req.resume();
      return fail(res, 404, 'Not available through Grabbit');
    }
    if (spec.media) return media(req, res, method, spec, hit.params, cur, loginId);
    if (spec.upload) return upload(req, res, spec, cur, loginId);
    return member(req, res, method, rule, spec, hit.params, cur, loginId);
  }

  // --- Member rows (phase 3) -------------------------------------------------------

  // An upstream 401: the link this request read ends (a newer one stays).
  function expired(req, res, loginId) {
    if (links.clearSeal(loginId, readCookie(req, LINK_COOKIE)) === 'changed') return fail(res, 409, 'The link changed; try again');
    res.append('Set-Cookie', clearCookie(LINK_COOKIE));
    return fail(res, 401, 'Adshortis is not linked', { reason: 'expired' });
  }

  // An upstream 4xx other than 401: its status with a fixed message.
  function refuse(res, status, headers) {
    if (status === 429 && /^[0-9]{1,6}$/.test(String(headers['retry-after'] || ''))) res.setHeader('Retry-After', String(headers['retry-after']));
    return fail(res, status, REFUSALS[status] || REFUSALS[400]);
  }

  // One JSON call upstream: { r, d } with d the parsed body (undefined when it
  // is not JSON). Throws when upstream cannot be reached.
  async function callJson(req, opts) {
    const r = await upstream(req, opts);
    const d = r.statusCode === 200 ? await readJson(r).catch(() => undefined) : (r.resume(), undefined);
    return { r, d };
  }

  // Relay an upstream answer through a projection. 424 for 5xx, redirects,
  // non-JSON and wrong shapes.
  function relay(req, res, loginId, { r, d }, project, after) {
    const st = r.statusCode;
    if (st === 401) return expired(req, res, loginId);
    if (st === 200) {
      const p = d === undefined ? undefined : project(d);
      if (p === undefined) return fail(res, 424, 'Adshortis sent an unexpected answer');
      if (after) return after(p);
      return answer(res, 200, { ok: true, ...p });
    }
    if (st >= 400 && st < 500) return refuse(res, st, r.headers);
    return fail(res, 424, 'Adshortis is not reachable right now');
  }

  async function member(req, res, method, rule, spec, params, cur, loginId) {
    const pairs = [...new URL(req.originalUrl || req.url, 'http://x').searchParams];
    const q = rows.rowQuery(spec, pairs);
    if (q.status) {
      req.resume();
      return fail(res, q.status, q.error);
    }
    // GW-LIMIT: search and lookup, per login id, before anything is read.
    if (spec.limited) {
      const wait = limited(`${rule}:${loginId}`);
      if (wait) {
        req.resume();
        res.setHeader('Retry-After', String(wait));
        return fail(res, 429, 'Too many searches; try again in a minute');
      }
    }
    let qs = q.qs;
    let body;
    let name = null;
    const hasBody = spec.search || spec.lookup || (spec.body && (!spec.bodyOn || spec.bodyOn.includes(method)));
    if (hasBody) {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        return fail(res, e && e.status ? e.status : 400, 'Bad request');
      }
      const v = spec.search ? rows.searchQuery(raw) : spec.lookup ? rows.lookupQuery(raw) : spec.body(raw);
      if (v.status) return fail(res, v.status, v.error);
      if (spec.search || spec.lookup) qs = v.qs;
      else body = JSON.stringify(v.body);
      if (spec.lookup) name = v.name;
    } else {
      req.resume();
    }
    // Search and lookup are reads upstream; the words stay out of every log.
    const upMethod = spec.search || spec.lookup ? 'GET' : method;
    const path = spec.path(params) + (qs ? `?${qs}` : '');
    try {
      // GAP 23 (M5): the clip itself must be eligible first, for every role.
      if (spec.eligible) {
        const c = await callJson(req, { method: 'GET', path: `/api/clips/${params.id}`, token: cur.t });
        const st = c.r.statusCode;
        if (st === 200) {
          if (c.d === undefined) return fail(res, 424, 'Adshortis sent an unexpected answer');
          if (!rows.eligible(rows.projectClip(c.d, true))) return fail(res, 404, NOT_AVAILABLE, { reason: 'not_available' });
        } else if (st === 404) {
          return fail(res, 404, NOT_AVAILABLE, { reason: 'not_available' });
        } else {
          return relay(req, res, loginId, c, () => undefined);
        }
      }
      const out = await callJson(req, { method: upMethod, path, token: cur.t, body });
      return relay(req, res, loginId, out, spec.project, (p) => {
        // GW-ELIG (H80): a single clip that is deleted or not ready is refused
        // for every role; the hub then asks for no media.
        if (spec.single && !rows.eligible(p)) return fail(res, 404, NOT_AVAILABLE, { reason: 'not_available' });
        if (spec.lookup) return answer(res, 200, { ok: true, ...rows.lookupFilter(p, name) });
        return answer(res, 200, { ok: true, ...p });
      });
    } catch {
      log.warn(`[ads] ${rule} upstream unreachable`);
      return fail(res, 424, 'Adshortis is not reachable right now');
    }
  }

  // --- Media (D1-D3) ------------------------------------------------------------------

  function placeholder(res, method) {
    baseHeaders(res);
    res.setHeader('Content-Security-Policy', MEDIA_CSP);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(PLACEHOLDER_PNG.length));
    res.setHeader('X-Grabbit-Placeholder', '1');
    res.status(200);
    return method === 'HEAD' ? res.end() : res.end(PLACEHOLDER_PNG);
  }

  function media(req, res, method, spec, params, cur, loginId) {
    req.resume();
    const range = req.headers.range;
    if (range !== undefined && !RANGE_RE.test(String(range).trim())) {
      baseHeaders(res);
      return res.status(416).end();
    }
    const h = baseUpHeaders(req, cur.t, spec.media === 'video' ? 'video/mp4' : 'image/*');
    if (range !== undefined) h.range = String(range).trim();
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && ETAG_RE.test(inm)) h['if-none-match'] = inm;
    const ac = new AbortController();
    // A client that goes away ends the upstream request too (phase-1 leftover).
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    return new Promise((resolve) => {
      const r = mod.request(
        { agent: mediaAgent, protocol: up.protocol, hostname: up.hostname, port: up.port, method, path: spec.path(params), headers: h, timeout: timeoutMs, signal: ac.signal },
        (ur) => {
          ur.on('error', () => {});
          const st = ur.statusCode;
          const ct = String(ur.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          const drop = () => ur.resume();
          if (st === 401) { drop(); expired(req, res, loginId); return resolve(); }
          if (st === 304 || st === 416) {
            drop();
            baseHeaders(res);
            if (st === 304 && ETAG_RE.test(String(ur.headers.etag || ''))) res.setHeader('ETag', ur.headers.etag);
            if (st === 416 && /^bytes \*\/[0-9]{1,15}$/.test(String(ur.headers['content-range'] || ''))) res.setHeader('Content-Range', ur.headers['content-range']);
            res.status(st).end();
            return resolve();
          }
          if (st === 200 || st === 206) {
            if (spec.media === 'image' && ct === 'image/svg+xml') { drop(); placeholder(res, method); return resolve(); }
            const typeOk = spec.media === 'video' ? ct === 'video/mp4' : RASTER.includes(ct);
            if (!typeOk) { drop(); fail(res, 424, 'Adshortis sent an unexpected answer'); return resolve(); }
            baseHeaders(res);
            res.setHeader('Content-Security-Policy', MEDIA_CSP);
            res.setHeader('Content-Type', ct);
            if (/^[0-9]{1,15}$/.test(String(ur.headers['content-length'] || ''))) res.setHeader('Content-Length', ur.headers['content-length']);
            if (/^bytes [0-9]{1,15}-[0-9]{1,15}\/[0-9]{1,15}$/.test(String(ur.headers['content-range'] || ''))) res.setHeader('Content-Range', ur.headers['content-range']);
            if (ur.headers['accept-ranges'] === 'bytes') res.setHeader('Accept-Ranges', 'bytes');
            if (ETAG_RE.test(String(ur.headers.etag || ''))) res.setHeader('ETag', ur.headers.etag);
            res.status(st);
            if (method === 'HEAD') { drop(); res.end(); return resolve(); }
            // A playing video pauses the stream (backpressure) for as long as
            // the browser's buffer is full; that is not an idle upstream.
            r.setTimeout(0);
            // Streamed, never buffered; an error on either side ends both.
            return pipeline(ur, res, (err) => {
              if (err) ac.abort();
              resolve();
            });
          }
          drop();
          if (st >= 400 && st < 500) refuse(res, st, ur.headers);
          else fail(res, 424, 'Adshortis is not reachable right now');
          return resolve();
        },
      );
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', () => {
        if (!ac.signal.aborted && !res.headersSent) {
          log.warn('[ads] media upstream unreachable');
          fail(res, 424, 'Adshortis is not reachable right now');
        } else if (!res.writableFinished) {
          res.destroy();
        }
        resolve();
      });
      r.end();
    });
  }

  // --- Upload (M12) -------------------------------------------------------------------

  // The hub sends the file as the request body (application/octet-stream or
  // video/*), with the allowlisted fields as base64url JSON in X-Ads-Upload.
  // The gateway writes the multipart body upstream itself, so only allowlisted
  // fields and one file part can ever reach Adshortis, and nothing is buffered.
  function upload(req, res, spec, cur, loginId) {
    const refuseEarly = (status, error, extra) => {
      // The body is not read; the connection closes after the answer.
      res.setHeader('Connection', 'close');
      return fail(res, status, error, extra);
    };
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/octet-stream' && !/^video\/[a-z0-9.+-]{1,40}$/.test(ct)) return refuseEarly(415, 'Send the video file as the request body');
    const meta = rows.uploadMeta(req.headers['x-ads-upload']);
    if (meta.status) return refuseEarly(meta.status, meta.error);
    const cl = String(req.headers['content-length'] || '');
    if (!/^[0-9]{1,15}$/.test(cl)) return refuseEarly(411, 'The upload needs a Content-Length');
    const size = Number(cl);
    if (size === 0) return refuseEarly(400, 'No file');
    const limitMb = uploadMax / 1048576;
    if (size > uploadMax) return refuseEarly(413, REFUSALS[413], { limit_mb: limitMb });

    const boundary = `----grabbit-ads-${crypto.randomBytes(12).toString('hex')}`;
    let head = '';
    for (const [k, v] of Object.entries(meta.fields)) head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const headBuf = Buffer.from(head, 'utf8');
    const tailBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const h = baseUpHeaders(req, cur.t);
    h.origin = app;
    h['content-type'] = `multipart/form-data; boundary=${boundary}`;
    h['content-length'] = String(headBuf.length + size + tailBuf.length);

    const ac = new AbortController();
    return new Promise((resolve) => {
      let answered = false;
      const settle = () => { if (!answered) { answered = true; resolve(); } };
      // The browser cancelled or went away: end the upstream upload too.
      req.on('close', () => { if (!req.complete) ac.abort(); });
      res.on('close', () => { if (!res.writableFinished) ac.abort(); settle(); });
      const r = mod.request(
        { agent, protocol: up.protocol, hostname: up.hostname, port: up.port, method: 'POST', path: spec.path({}), headers: h, timeout: uploadTimeoutMs, signal: ac.signal },
        async (ur) => {
          ur.on('error', () => {});
          // Upstream answered (maybe early, on its own size check): stop
          // sending and close this connection after the answer.
          if (!req.complete) {
            req.unpipe();
            req.pause();
            res.setHeader('Connection', 'close');
          }
          const st = ur.statusCode;
          const d = st === 200 || st === 413 ? await readJson(ur).catch(() => undefined) : (ur.resume(), undefined);
          if (st === 413) {
            const m = d && typeof d.error === 'string' ? /upload limit \(([0-9]{1,7}) MB\)/.exec(d.error) : null;
            fail(res, 413, REFUSALS[413], { limit_mb: m ? Number(m[1]) : limitMb });
          } else {
            relay(req, res, loginId, { r: ur, d }, spec.project);
          }
          settle();
        },
      );
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', () => {
        if (!ac.signal.aborted && !res.headersSent) {
          log.warn('[ads] M12 upstream unreachable');
          res.setHeader('Connection', 'close');
          fail(res, 424, 'Adshortis is not reachable right now');
        }
        settle();
      });
      r.write(headBuf);
      req.on('end', () => r.end(tailBuf));
      req.pipe(r, { end: false });
    });
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
  PLACEHOLDER_PNG,
  createLimiter,
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
