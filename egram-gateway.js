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
const { EventEmitter } = require('events');
const { pipeline, Transform } = require('stream');
const { parseApiUrl, sealSession, openSession } = require('./tikshortis-gateway');

// Over HTTPS the cookie is a __Host- cookie (Secure, Path=/, no Domain), so a
// sibling subdomain cannot plant one. Plain HTTP (a LAN install) cannot use
// the prefix and keeps the old name, scoped to the gateway's path.
const EGRAM_COOKIE = 'grabbit_egram';
const EGRAM_COOKIE_SECURE = '__Host-grabbit_egram';
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

const isSecure = (req) => !!req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function cookieHeader(req, value, maxAgeSec) {
  if (isSecure(req)) return [`${EGRAM_COOKIE_SECURE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, 'Secure'].join('; ');
  return [`${EGRAM_COOKIE}=${value}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`].join('; ');
}

// The value of a cookie sent exactly once. A name sent twice (one of them
// planted for a parent domain, say) counts as no cookie at all.
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

// The session cookie this request may use: the __Host- one over HTTPS, the
// plain one over HTTP.
const sessionCookieOf = (req) => readCookie(req, isSecure(req) ? EGRAM_COOKIE_SECURE : EGRAM_COOKIE);

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
// adult/* (the 18+ unlock), me/pin, me/avatar, push/*, admin/*, creator
// edits, merges, stories and users/*.
//   media   piped as it comes, Range passed through
//   picture an avatar or banner ('creator' or 'user'): may be Elitogram's generated SVG
//   body    the JSON keys a write may carry; everything else is dropped
//   parent  the post this request reads below or writes to ('path': the first
//           id in the path, 'path2': the second, 'body': post_id). The gateway first fetches that
//           post in the lane and passes the request on only if the post itself
//           would be passed back; a comment or a like never carries enough to
//           be judged on its own.
const ID = '(\\d{1,12})';
// What a post's audience may be set to through the gateway (PATCH api/posts/:id).
const AUDIENCE_WRITES = ['general', 'unknown', 'adult'];
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
  r('PATCH', `api/posts/${ID}`, { body: ['audience', 'caption'], parent: 'path' }),
  r('DELETE', `api/posts/${ID}`, { parent: 'path' }),
  // A new post: multipart (files, caption, creator, audience, adult), streamed
  // as it comes. Elitogram decides the audience: unclassified unless a
  // moderator says general; 18+ leaves the module.
  r('POST', 'api/posts', { upload: true }),
  r('POST', `api/posts/${ID}/like`, { parent: 'path' }),
  r('DELETE', `api/posts/${ID}/like`, { parent: 'path' }),
  r('GET', `api/posts/${ID}/comments`, { parent: 'path' }),
  r('POST', `api/posts/${ID}/comments`, { body: ['body'], parent: 'path' }),
  r('DELETE', `api/posts/${ID}/comments/${ID}`, { parent: 'path' }),
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
  r('POST', `api/collections/${ID}/items`, { body: ['post_id'], parent: 'body' }),
  r('DELETE', `api/collections/${ID}/items/${ID}`, { parent: 'path2' }),
  r('GET', `api/posts/${ID}/collections`, { parent: 'path' }),
  r('POST', `api/posts/${ID}/favorite`, { parent: 'path' }),
  r('DELETE', `api/posts/${ID}/favorite`, { parent: 'path' }),
  r('GET', 'api/favorites'),
  r('POST', `api/posts/${ID}/view`, { parent: 'path' }),
  r('GET', 'api/history'),
  r('DELETE', 'api/history'),
  // The account: notifications (scoped by Elitogram, checked here), own profile, password
  r('GET', 'api/notifications'),
  // Marks only the notifications the module showed (`ids`, required): the list
  // it was given may have been filtered here.
  r('POST', 'api/notifications/read', { body: ['ids'], ids: true }),
  r('PATCH', 'api/me', { body: ['display_name', 'bio'] }),
  r('POST', 'api/me/password', { body: ['current', 'password'] }),
  // Media
  r('GET', `m/${ID}`, { media: true }),
  r('GET', `m/${ID}/t`, { media: true }),
  r('GET', `m/ca/${ID}`, { media: true, picture: 'creator' }),
  r('GET', `m/cb/${ID}`, { media: true, picture: 'creator' }),
  r('GET', `m/ua/${ID}`, { media: true, picture: 'user' }),
];

function matchRoute(method, rest) {
  const m = method === 'HEAD' ? 'GET' : method;
  return ROUTES.find((x) => x.m === m && x.p.test(rest)) || null;
}

// --- Response filter -------------------------------------------------------------
// Objects that are a post, a grid tile, a photo or a creator must carry an
// `audience` equal to the lane's, and their author must not be 18+ in Grabbit.
// Something that looks like one of them without an audience is dropped (fail
// closed). Every entry of a `creators` list (search hits) must name the lane's
// audience too, however little else it carries.
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
// A creator handle as Elitogram writes it. Anything else (two handles joined by
// a comma, say) is no handle at all.
const CANONICAL_HANDLE = /^[a-z0-9._~-]{1,100}$/;

function authorHandle(o) {
  if (o.author && typeof o.author === 'object' && typeof o.author.handle === 'string') return o.author.handle;
  if (typeof o.author_handle === 'string') return o.author_handle;
  if (typeof o.handle === 'string') return o.handle;
  return null;
}
// Creators and accounts are separate namespaces in Elitogram (a creator and an
// account may share a handle), so a handle is checked with its type: 'c' a
// creator, 'u' an account, '?' when the answer does not say.
const typeOf = (v) => (v === 'creator' ? 'c' : v === 'user' ? 'u' : '?');
// Every handle an object names, with its type: its author or own handle, and
// for a notification the creator it is about and the author of the post it is
// about. -> [{ h, t }]
function namedHandles(o) {
  const out = [];
  if (o.author && typeof o.author === 'object' && typeof o.author.handle === 'string') out.push({ h: o.author.handle, t: typeOf(o.author.type) });
  else if (typeof o.author_handle === 'string') out.push({ h: o.author_handle, t: typeOf(o.author_type) });
  else if (typeof o.handle === 'string') out.push({ h: o.handle, t: o.type !== undefined ? typeOf(o.type) : looksLikeCreator(o) ? 'c' : '?' });
  if (typeof o.creator_handle === 'string' && o.creator_handle) out.push({ h: o.creator_handle, t: 'c' });
  if (typeof o.post_author_handle === 'string' && o.post_author_handle) out.push({ h: o.post_author_handle, t: typeOf(o.post_author_type) });
  return out;
}

const looksLikePost = (o) => Number.isInteger(o.id) && (Array.isArray(o.media) || 'media_id' in o || ('author' in o && 'caption' in o));
const looksLikePhoto = (o) => Number.isInteger(o.media_id) && Number.isInteger(o.post_id);
function looksLikeCreator(o) {
  return Number.isInteger(o.id) && typeof o.handle === 'string' && ('post_count' in o || 'follower_count' in o);
}

function allowedItem(o, want, isAdultHandle) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return true;
  const shaped = looksLikePost(o) || looksLikePhoto(o) || looksLikeCreator(o);
  if (o.adult === true || o.audience === 'adult') return false;
  if (o.author && typeof o.author === 'object' && o.author.adult === true) return false;
  // A post, tile, photo or creator must name the lane's audience; anything
  // else that names an audience must name that one too.
  if (shaped ? o.audience !== want : 'audience' in o && o.audience !== want) return false;
  const named = namedHandles(o);
  // A post, tile, photo or creator must say whose it is, or it cannot be checked.
  if (shaped && !authorHandle(o)) return false;
  if (isAdultHandle && named.some(({ h, t }) => isAdultHandle(h, t))) return false;
  return true;
}

// Walks a JSON value and removes everything not allowed. A dropped array entry
// disappears; a dropped property becomes null. Returns the value and how many
// objects were dropped. When anything was dropped, a top-level `total` counted
// upstream would include it, so it becomes null rather than a wrong number.
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
        if (k === 'creators' && Array.isArray(x)) {
          const kept = x.filter((c) => c && typeof c === 'object' && !Array.isArray(c) && c.audience === want && typeof c.handle === 'string' && c.handle !== ''
            && !(isAdultHandle && isAdultHandle(c.handle, 'c')));
          dropped += x.length - kept.length;
          out[k] = walk(kept);
          continue;
        }
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  if (!allowedItem(value, want, isAdultHandle)) return { value: null, dropped: 1 };
  const out = walk(value);
  if (dropped && out && typeof out === 'object' && !Array.isArray(out) && 'total' in out) out.total = null;
  return { value: out, dropped };
}

// Every handle an answer names as an author or creator, typed ('c:ann',
// 'u:bob', '?:sam'), for the identity lookup below. A `creators` list names
// creators.
function handlesIn(value) {
  const out = new Set();
  const add = (h, t) => { const n = norm(h); if (CANONICAL_HANDLE.test(n)) out.add(`${t}:${n}`); };
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    for (const { h, t } of namedHandles(v)) add(h, t);
    if (Array.isArray(v.creators)) for (const c of v.creators) if (c && typeof c === 'object' && typeof c.handle === 'string') add(c.handle, 'c');
    for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return [...out];
}

// Content types passed back. Elitogram's generated avatars and banners are
// SVG; nothing else may be, and every media answer gets a sandbox CSP.
function allowedType(ct, route) {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  if (!route.media) return t === 'application/json';
  if (t === 'image/svg+xml') return !!route.picture;
  return /^(video|audio)\/[a-z0-9.+-]+$/.test(t) || /^image\/(jpeg|png|webp|gif|avif)$/.test(t);
}

// Every file must say whose it is, and fails closed when it does not:
//   - a post's file names the lane's audience and its creator (or, for a post
//     an account wrote itself, that account);
//   - a creator's avatar or banner says it is one (X-Egram-Picture: creator)
//     and names the lane's audience and the creator. Elitogram answers a
//     creator outside the scope with an unlabelled neutral picture, which the
//     gateway replaces with its own;
//   - an account's avatar says it is one (X-Egram-Picture: user) and is the
//     generated initials picture; an uploaded account picture is not passed.
// The creator must not be 18+ in Grabbit. Applies to 200, 206 and 304 alike.
// The value of a header the answer sent exactly once (counted on the raw
// headers, since Node joins repeats of unknown headers with a comma).
function singleHeader(rawHeaders, name) {
  if (!Array.isArray(rawHeaders)) return undefined;
  let found;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() !== name) continue;
    if (found !== undefined) return null;
    found = String(rawHeaders[i + 1]);
  }
  return found === undefined ? null : found;
}

// The creator a media answer names: exactly one header holding one canonical
// handle, else null.
function mediaCreator(headers, rawHeaders) {
  const v = rawHeaders ? singleHeader(rawHeaders, 'x-egram-creator') : typeof headers['x-egram-creator'] === 'string' ? headers['x-egram-creator'] : null;
  return typeof v === 'string' && CANONICAL_HANDLE.test(v) ? v : null;
}

// The author of a post's file: its creator, or for a post an account wrote
// itself (no creator), that account (X-Egram-Account), checked against
// Grabbit's 18+ profiles like the author_handle of the post's JSON. Both
// named, or either named twice, is no author. Never used for pictures.
function headerCount(headers, rawHeaders, name) {
  if (Array.isArray(rawHeaders)) {
    let n = 0;
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) if (String(rawHeaders[i]).toLowerCase() === name) n++;
    return n;
  }
  return headers[name] === undefined ? 0 : 1;
}
// -> { h, t } with t 'c' (creator) or 'u' (account), or null.
function mediaAuthor(headers, rawHeaders) {
  const c = headerCount(headers, rawHeaders, 'x-egram-creator');
  const a = headerCount(headers, rawHeaders, 'x-egram-account');
  if (c + a !== 1) return null;
  if (c) {
    const h = mediaCreator(headers, rawHeaders);
    return h ? { h, t: 'c' } : null;
  }
  const v = rawHeaders ? singleHeader(rawHeaders, 'x-egram-account') : headers['x-egram-account'];
  const account = typeof v === 'string' ? norm(v) : '';
  return CANONICAL_HANDLE.test(account) ? { h: account, t: 'u' } : null;
}
// The typed author a media answer names (a creator for a picture). -> { h, t } | null
function mediaNamed(route, headers, rawHeaders) {
  if (route.picture === 'user') return null;
  if (route.picture) {
    const h = mediaCreator(headers, rawHeaders);
    return h ? { h, t: 'c' } : null;
  }
  return mediaAuthor(headers, rawHeaders);
}

function mediaAllowed(route, headers, want, isAdultHandle, rawHeaders) {
  const one = (k) => (typeof headers[k] === 'string' ? headers[k] : null);
  // An account's own upload says nothing about its audience, so only the
  // generated initials (SVG) pass; an uploaded account picture is replaced.
  if (route.picture === 'user') return one('x-egram-picture') === 'user' && /^image\/svg\+xml\b/i.test(one('content-type') || '');
  if (route.picture && one('x-egram-picture') !== 'creator') return false;
  if (one('x-egram-audience') !== want) return false;
  const named = mediaNamed(route, headers, rawHeaders);
  if (!named) return false;
  if (isAdultHandle && isAdultHandle(named.h, named.t)) return false;
  return true;
}

// Grabbit's own stand-in for a picture it will not pass on: a plain tile with
// nothing from Elitogram in it.
const NEUTRAL_PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice"><rect width="100" height="100" fill="#3a3a3c"/></svg>';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];

// --- The gateway ---------------------------------------------------------------

// bindingOf(req): a value tied to the caller's Grabbit sign-in. The sealed link
// carries it and is honoured only alongside the same sign-in, so a link cookie
// planted from a sibling domain (possible over plain HTTP) is worthless.
// uploadMaxBytes: the most one upload request may carry in all (files and
// fields), declared or streamed. Elitogram limits each file and the number of
// files; this bounds the whole request.
function createGateway({ apiUrl, secret, isAdultHandle = null, bindingOf = () => '', clientIp = (req) => req.ip || '', log = console, timeoutMs = 30000, identityDeadlineMs = 10000, uploadMaxBytes = 4096 * 1024 * 1024 }) {
  const origin = parseApiUrl(apiUrl);
  if (!origin) throw new Error('EGRAM_API_URL is not a plain http(s) origin');
  const up = new URL(origin);
  const mod = up.protocol === 'https:' ? https : http;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: 32 });
  // Identity lookups have their own small pool. A media answer holds its socket
  // in the main pool while its author is checked; with a shared pool a page of
  // large pictures could take every socket and leave the checks queued behind
  // the very bodies waiting for them.
  const identityAgent = new mod.Agent({ keepAlive: true, maxSockets: 8 });

  function upstream(req, { method, path, headers, body, signal, stream, timeout, agent: via }) {
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
      const rq = mod.request({ agent: via || agent, protocol: up.protocol, hostname: up.hostname, port: up.port, method, path, headers: h, timeout: timeout || timeoutMs }, (res) => {
        res.on('error', (e) => log.warn(`[egram] upstream answer ${method} ${path.split('?')[0]}: ${e.message}`));
        resolve(res);
      });
      rq.on('timeout', () => rq.destroy(new Error('Elitogram did not answer in time')));
      rq.on('error', reject);
      if (signal) signal.once('close', () => { if (!rq.destroyed) rq.destroy(); });
      if (stream) {
        stream.on('error', (e) => rq.destroy(e));
        stream.pipe(rq);
      } else rq.end(body || undefined);
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

  // --- Other identities of a creator ---------------------------------------
  // Grabbit's 18+ profiles may know a creator by another name than the
  // Elitogram handle: an Instagram or TikTok account, a linked account, an
  // alias. Elitogram lists those names per creator handle (api/creator-
  // identities, in the same scope), and a creator is 18+ here when the handle
  // or any of them matches a Grabbit profile classified 18+. Nothing is merged;
  // this only reads. Asked afresh for every answer (no cache across requests),
  // so a new alias that ties a creator to an 18+ profile takes effect at once.
  // One lookup with a deadline that includes the wait for a socket, given up
  // early when the caller's own answer closes (`downstream`, a response).
  function identityLookup(req, cur, lane, qs, downstream) {
    return new Promise((resolve, reject) => {
      const stop = new EventEmitter();
      let done = false;
      const onClose = () => { stop.emit('close'); finish(reject, new Error('the caller went away')); };
      const timer = setTimeout(() => { stop.emit('close'); finish(reject, new Error('identity lookup took too long')); }, identityDeadlineMs);
      function finish(fn, v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (downstream) downstream.removeListener('close', onClose);
        fn(v);
      }
      if (downstream) downstream.once('close', onClose);
      upstream(req, { method: 'GET', path: `/api/creator-identities?${qs}`, headers: { accept: 'application/json', ...authHeaders(cur, lane) }, agent: identityAgent, signal: stop, timeout: identityDeadlineMs })
        .then((r) => {
          if (r.statusCode !== 200) { r.resume(); throw new Error(`identity lookup answered ${r.statusCode}`); }
          return readJson(r, 1024 * 1024);
        })
        .then((d) => finish(resolve, d), (e) => finish(reject, e));
    });
  }

  // `refs` are typed handles from handlesIn() ('c:ann', 'u:bob', '?:sam').
  // -> Map 'c:<handle>' -> other names, 'u:<handle>' -> [] for an account that
  // exists. A creator Elitogram did not answer for (outside the scope, or
  // unknown) and an account it did not list are left out, and the 18+ test
  // below treats them as 18+. An untyped handle is asked as both.
  async function identitiesFor(req, cur, lane, refs, downstream = null) {
    const out = new Map();
    if (!isAdultHandle || !refs.length) return out;
    const creators = new Set();
    const accounts = new Set();
    for (const ref of refs) {
      const t = ref.slice(0, 1);
      const h = ref.slice(2);
      if (t === 'c' || t === '?') creators.add(h);
      if (t === 'u' || t === '?') accounts.add(h);
    }
    const cs = [...creators];
    const as = [...accounts];
    for (let i = 0; i < Math.max(cs.length, as.length); i += 100) {
      const cPart = cs.slice(i, i + 100);
      const aPart = as.slice(i, i + 100);
      const qs = [...cPart.map((h) => `h=${encodeURIComponent(h)}`), ...aPart.map((h) => `a=${encodeURIComponent(h)}`)].join('&');
      const d = await identityLookup(req, cur, lane, qs, downstream);
      const items = d && typeof d.items === 'object' && d.items && !Array.isArray(d.items) ? d.items : null;
      if (!items) throw new Error('identity lookup sent an unexpected answer');
      // An Elitogram without the typed `accounts` answer lists none, so every
      // account author stays unresolved there (and is refused).
      const listed = new Set(Array.isArray(d.accounts) ? d.accounts.filter((x) => typeof x === 'string').map(norm) : []);
      for (const h of cPart) {
        if (Object.prototype.hasOwnProperty.call(items, h) && Array.isArray(items[h])) {
          out.set(`c:${h}`, items[h].filter((x) => typeof x === 'string').map(norm).filter(Boolean).slice(0, 100));
        }
      }
      for (const h of aPart) if (listed.has(h)) out.set(`u:${h}`, []);
    }
    return out;
  }
  // The 18+ test for one answer: the handle, or any other name it is known by.
  // A handle that was not looked up (not canonical, say) or that Elitogram did
  // not answer for counts as 18+: the other names it might be known by are
  // unknown, so it fails closed. An untyped handle passes only when at least
  // one of creator and account resolved and no resolved creator is 18+.
  const adultTest = (ids) => (isAdultHandle ? (h, t = '?') => {
    if (isAdultHandle(h)) return true;
    const n = norm(h);
    const c = ids.get(`c:${n}`);
    const isAdultCreator = (names) => names.some((x) => isAdultHandle(x));
    if (t === 'c') return !c || isAdultCreator(c);
    if (t === 'u') return !ids.has(`u:${n}`);
    if (!c && !ids.has(`u:${n}`)) return true;
    return !!c && isAdultCreator(c);
  } : null);

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

  const sessionOf = (req) => {
    const s = unseal(secret, sessionCookieOf(req));
    return s && (s.b || '') === String(bindingOf(req) || '') ? s : null;
  };
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
        const user = { username: u.username, display_name: u.display_name || u.username, bio: typeof u.bio === 'string' ? u.bio.slice(0, 1000) : '', role: u.role === 'admin' ? 'admin' : 'user', can_classify: u.role === 'admin' || (Array.isArray(u.permissions) && u.permissions.includes('profiles')) };
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
        res.setHeader('Set-Cookie', cookieHeader(req, seal(secret, { t: token[1], exp, b: String(bindingOf(req) || '') }), SESSION_DAYS * 86400));
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

  // Would the post `id` be passed back in this lane? -> true | false | 401
  async function parentVerdict(req, cur, lane, id, downstream = null) {
    const r = await upstream(req, { method: 'GET', path: `/api/posts/${id}`, headers: { accept: 'application/json', ...authHeaders(cur, lane) } });
    if (r.statusCode === 401) { r.resume(); return 401; }
    if (r.statusCode !== 200) { r.resume(); if (r.statusCode >= 500) throw new Error(`Elitogram answered ${r.statusCode}`); return false; }
    const d = await readJson(r);
    const ids = await identitiesFor(req, cur, lane, handlesIn(d), downstream);
    const { value, dropped } = filterAnswer(d, LANES[lane], adultTest(ids));
    return value !== null && dropped === 0 && value.audience === LANES[lane];
  }

  // The notification ids this lane lists after Grabbit's filter. -> Set | 401
  async function visibleNotificationIds(req, cur, lane, downstream) {
    const r = await upstream(req, { method: 'GET', path: '/api/notifications', headers: { accept: 'application/json', ...authHeaders(cur, lane) } });
    if (r.statusCode === 401) { r.resume(); return 401; }
    if (r.statusCode !== 200) { r.resume(); throw new Error(`Elitogram answered ${r.statusCode}`); }
    const d = await readJson(r);
    const ids = await identitiesFor(req, cur, lane, handlesIn(d), downstream);
    const { value } = filterAnswer(d, LANES[lane], adultTest(ids));
    // No list means nothing was verified: the write does not go ahead.
    if (!value || !Array.isArray(value.items)) throw new Error('Elitogram sent no notification list');
    return new Set(value.items.filter((n) => n && Number.isInteger(n.id)).map((n) => n.id));
  }

  // A new post. The multipart body goes upstream as it arrives (Elitogram
  // stores files at original quality). The answer is reduced to the new id and
  // the files Elitogram refused: whether the post is general, in review or 18+
  // is not said here; the module asks for the post in each lane, which runs
  // through the normal checks.
  async function uploadPost(req, res, cur, lane, headers) {
    const ct = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data;\s*boundary=/i.test(ct)) return fail(res, 400, 'Send the files as multipart/form-data');
    const h = { ...headers, accept: 'application/json', 'content-type': ct };
    const tooLarge = () => {
      res.set('Connection', 'close');
      return fail(res, 413, `The upload is larger than ${Math.floor(uploadMaxBytes / (1024 * 1024))} MB in all`);
    };
    if (req.headers['content-length']) {
      const declared = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(declared) || declared < 0) return fail(res, 400, 'Bad Content-Length');
      if (declared > uploadMaxBytes) { req.resume(); return tooLarge(); }
      h['content-length'] = req.headers['content-length'];
    } else h['transfer-encoding'] = 'chunked';
    // Counts what actually arrives, declared or chunked. Going over the limit
    // ends the upstream request mid-body, which Elitogram treats as an aborted
    // upload and cleans up.
    let seen = 0;
    let over = false;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > uploadMaxBytes) { over = true; cb(new Error('upload over the limit')); return; }
        cb(null, chunk);
      },
    });
    req.on('error', (e) => counter.destroy(e));
    req.pipe(counter);
    let r;
    try {
      r = await upstream(req, { method: 'POST', path: '/api/posts', headers: h, stream: counter, signal: res, timeout: 10 * 60000 });
    } catch (e) {
      req.unpipe(counter);
      req.resume();
      if (over) return tooLarge();
      log.warn(`[egram] upload: ${e.message}`);
      return fail(res, 422, 'The upload did not reach Elitogram');
    }
    const d = await readJson(r, 1024 * 1024).catch(() => null);
    if (r.statusCode === 401) { res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); return fail(res, 401, 'Link your Elitogram account first'); }
    if (r.statusCode !== 201 || !d || !Number.isInteger(d.id)) {
      return fail(res, r.statusCode >= 400 && r.statusCode < 500 ? r.statusCode : 422, (d && typeof d.error === 'string' && d.error.slice(0, 300)) || `Elitogram answered ${r.statusCode}`);
    }
    const rejected = Array.isArray(d.rejected)
      ? d.rejected.slice(0, 50).map((x) => ({ name: String((x && x.name) || '').slice(0, 200), reason: String((x && x.reason) || '').slice(0, 200) }))
      : [];
    return res.status(201).set('Cache-Control', 'no-store').json({ ok: true, id: d.id, rejected });
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
    const src = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if ('audience' in src && (route.body || []).includes('audience') && !AUDIENCE_WRITES.includes(src.audience)) {
      return fail(res, 400, 'audience must be general, unknown or adult');
    }
    if (route.ids && !(Array.isArray(src.ids) && src.ids.length >= 1 && src.ids.length <= 500 && src.ids.every((x) => Number.isInteger(x) && x > 0))) {
      return fail(res, 400, 'ids must list 1 to 500 notification ids');
    }
    if (route.ids) {
      // Only ids this lane would list after Grabbit's own filter: a client may
      // not mark read a notification the gateway hid from it.
      let shown;
      try { shown = await visibleNotificationIds(req, cur, lane, res); } catch (e) {
        log.warn(`[egram] notifications check: ${e.message}`);
        return fail(res, 424, 'Elitogram is not reachable right now');
      }
      if (shown === 401) { res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); return fail(res, 401, 'Link your Elitogram account first'); }
      src.ids = [...new Set(src.ids)].filter((x) => shown.has(x));
      if (!src.ids.length) return res.status(200).set('Cache-Control', 'no-store').json({ ok: true });
    }
    if (route.parent) {
      const pid = route.parent === 'body' ? src.post_id : Number(route.p.exec(rest)[route.parent === 'path2' ? 2 : 1]);
      if (!Number.isInteger(pid) || pid < 1) return fail(res, 400, 'A post id is required');
      let verdict;
      try { verdict = await parentVerdict(req, cur, lane, pid, res); } catch (e) {
        log.warn(`[egram] parent check ${rest}: ${e.message}`);
        return fail(res, 424, 'Elitogram is not reachable right now');
      }
      if (verdict === 401) { res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); return fail(res, 401, 'Link your Elitogram account first'); }
      if (verdict !== true) return fail(res, 404, 'Not found');
    }
    if (route.upload) return uploadPost(req, res, cur, lane, headers);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Writes carry only the keys this route needs, re-encoded by the gateway.
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
    if (route.media && status < 400) {
      let ok = false;
      try {
        let test = isAdultHandle;
        const named = mediaNamed(route, r.headers, r.rawHeaders);
        if (named && isAdultHandle) test = adultTest(await identitiesFor(req, cur, lane, [`${named.t}:${named.h}`], res));
        ok = mediaAllowed(route, r.headers, want, test, r.rawHeaders);
      } catch (e) { log.warn(`[egram] media check ${rest}: ${e.message}`); }
      if (!ok) {
        r.resume();
        if (route.picture) {
          res.status(200).set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
          return req.method === 'HEAD' ? res.end() : res.end(NEUTRAL_PICTURE);
        }
        log.warn(`[egram] refused ${rest}: audience ${r.headers['x-egram-audience'] || 'missing'}, author ${r.headers['x-egram-creator'] || r.headers['x-egram-account'] ? 'named' : 'missing'} in the ${lane} lane`);
        return fail(res, 404, 'Not found');
      }
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
    let filtered;
    try { filtered = filterAnswer(d, want, adultTest(await identitiesFor(req, cur, lane, handlesIn(d), res))); } catch (e) {
      log.warn(`[egram] filter ${rest}: ${e.message}`);
      return fail(res, 424, 'Grabbit could not check this answer right now');
    }
    const { value, dropped } = filtered;
    if (dropped) log.warn(`[egram] dropped ${dropped} item(s) outside the ${lane} lane from ${rest}`);
    if (value === null) return fail(res, 404, 'Not found');
    res.status(status).set('Cache-Control', 'private, no-store');
    return res.json(value);
  }

  return { origin, proxy, session, callJson, identitiesFor, adultTest, routes: ROUTES };
}

module.exports = {
  EGRAM_COOKIE,
  EGRAM_COOKIE_SECURE,
  NEUTRAL_PICTURE,
  readCookie,
  COOKIE_PATH,
  LANES,
  ROUTES,
  laneOf,
  matchRoute,
  filterAnswer,
  allowedType,
  mediaAllowed,
  mediaCreator,
  singleHeader,
  handlesIn,
  seal,
  unseal,
  createGateway,
};
