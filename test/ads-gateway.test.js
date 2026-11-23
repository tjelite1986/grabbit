'use strict';
// Grabbit 3.0 native Adshortis, phase 1: the gateway (adshortis-gateway.js) and
// the link store (ads-links.js) against a fake Adshortis in this process. Covers
// PHASE1_GATEWAY_TESTS 1 and 3-6 at the gateway level (the real-process half is
// test/ads-server.test.js). Every temp file lives under one mkdtemp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const gw = require('../adshortis-gateway');
const { createLinkStore } = require('../ads-links');
const matrix = require('../ads-route-matrix');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-ads-gw-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const OWN = 'https://grabbit.example.com';
const APP = 'https://ads.example.com';
const USERNAME = 'secret-member-name';
const PASSWORD = 'secret-member-password';

function writeJsonAtomic(file, value, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value), mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

// --- Fake Adshortis ------------------------------------------------------------------
const ME = { id: 7, username: 'member', display_name: 'Member', role: 'user', permissions: ['upload'], avatar: '/m/avatar/user/7', ai: { on: true }, nav_tabs: ['x'], prefs: { a: 1 }, extra: 'nope' };
// up.hold = { url, wait, arrived, reply? }: the next request to `url` calls
// arrived(), then waits for `wait` before it is answered (by reply(send) when
// given), so a test can put another request in between.
const up = { seen: [], login: 'ok', me: 'ok', logout: 'ok', tokens: 0, hold: null };
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    up.seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const send = (status, obj, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };
    if (up.hold && up.hold.url === req.url) {
      const h = up.hold;
      up.hold = null;
      h.arrived();
      return h.wait.then(() => (h.reply ? h.reply(send) : answerUp(req, res, send)));
    }
    answerUp(req, res, send);
  });
});
function answerUp(req, res, send) {
  {
    if (req.url === '/api/login') {
      const minted = () => `as_session=tok${++up.tokens}; Path=/; HttpOnly`;
      if (up.login === 'html200') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': minted() }); return res.end('<html>'); }
      if (up.login === 'empty200') return send(200, {}, { 'set-cookie': minted() });
      if (up.login === 'badtoken') return send(200, { ok: true }, { 'set-cookie': 'as_session=a b; Path=/' });
      if (up.login === '302') { res.writeHead(302, { location: 'https://evil.example/' }); return res.end(); }
      if (up.login === '403') return send(403, { error: 'Account disabled' });
      if (up.login === '400html') { res.writeHead(400, { 'content-type': 'text/html' }); return res.end('<html>'); }
      if (up.login === '429') return send(429, { error: 'Too many attempts' }, { 'retry-after': '600' });
      if (up.login === '401') return send(401, { error: 'Wrong user name or password' });
      if (up.login === '500') return send(500, { error: 'boom' });
      if (up.login === '429text') return send(429, { error: 'UPSTREAM-TEXT login throttle' }, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
      if (up.login === '418') return send(418, { error: 'UPSTREAM-TEXT teapot' });
      up.tokens++;
      return send(200, { ok: true }, { 'set-cookie': `as_session=tok${up.tokens}; Path=/; HttpOnly` });
    }
    if (req.url === '/api/me') {
      if (!/as_session=tok\d+/.test(req.headers.cookie || '')) return send(401, { error: 'Unauthorized' });
      if (up.me === '401') return send(401, { error: 'Unauthorized' });
      if (up.me === 'array') return send(200, [1, 2]);
      if (up.me === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
      if (up.me === 'emptyobj') return send(200, {});
      if (up.me === '403') return send(403, { error: 'Forbidden' });
      if (up.me === '429') return send(429, { error: 'UPSTREAM-TEXT me throttle' }, { 'retry-after': '1e9' });
      if (up.me === '404text') return send(404, { error: 'UPSTREAM-TEXT gone' });
      return send(200, ME);
    }
    if (req.url === '/api/logout') {
      if (up.logout === '500') return send(500, { error: 'boom' });
      if (up.logout === 'drop') return req.socket.destroy();
      return send(200, { ok: true });
    }
    send(404, { error: 'Not found' });
  }
}
// Hold the next upstream request to `url`; returns { reached, release }.
function holdUpstream(url, reply) {
  let release;
  let arrived;
  const wait = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { arrived = r; });
  up.hold = { url, wait, arrived, reply };
  return { reached, release };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Grabbit side: an express app with the gateway mounted like server.js ---------------
let base;
let links;
const logs = [];
const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
const apps = [];

function mount(phase = '1') {
  const app = express();
  app.set('trust proxy', 'loopback');
  // No body parser: as in server.js, /api/ads reads its own body.
  // Stand-in for the auth gate: the test says who the caller is.
  app.use((req, _res, next) => {
    req.principal = req.headers['x-test-principal'] || 'owner';
    next();
  });
  const gateway = gw.createGateway({
    apiUrl: `http://127.0.0.1:${upstream.address().port}`,
    appOrigin: APP,
    publicOrigin: OWN,
    links,
    isOwner: (req) => req.principal === 'owner',
    log,
    phase,
  });
  app.use(gw.MOUNT, (req, res) => gateway.handle(req, res));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      apps.push(srv);
      resolve(`http://127.0.0.1:${srv.address().port}`);
    });
  });
}

test.before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  links = createLinkStore({ dir: path.join(root, 'data'), writeJsonAtomic, log });
  base = await mount('1');
});
test.after(() => {
  for (const s of apps) s.close();
  upstream.close();
});

// A browser request from Grabbit's own page over https.
function call(p, { method = 'GET', login, seal, cookie, headers = {}, body, raw, browser = true, at = base } = {}) {
  const h = { 'x-forwarded-proto': 'https', ...headers };
  if (browser) {
    h['sec-fetch-site'] = 'same-origin';
    if (method !== 'GET' && method !== 'HEAD') h.origin = OWN;
  }
  const jar = [];
  if (login) jar.push(`${gw.LOGIN_COOKIE}=${login}`);
  if (seal) jar.push(`${gw.LINK_COOKIE}=${seal}`);
  if (cookie) jar.push(cookie);
  if (jar.length) h.cookie = jar.join('; ');
  if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json';
  for (const [k, v] of Object.entries(headers)) h[k] = v;
  for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  return fetch(`${at}${p}`, { method, headers: h, body: payload, redirect: 'manual' }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json, headers: r.headers, setCookie: r.headers.getSetCookie() };
  });
}
const sealFrom = (r) => {
  const c = r.setCookie.find((v) => v.startsWith(`${gw.LINK_COOKIE}=`) && !/Max-Age=0/.test(v));
  return c ? c.split(';')[0].slice(gw.LINK_COOKIE.length + 1) : null;
};
const upCount = () => up.seen.length;
const reset = () => { up.login = 'ok'; up.me = 'ok'; up.logout = 'ok'; up.hold = null; };

async function linked() {
  reset();
  const login = links.issueLogin();
  const r = await call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { login, seal: sealFrom(r), r };
}

// --- Settings ---------------------------------------------------------------------------

test('origins: API/app origins are plain http(s); the public and embed origins are https only', () => {
  assert.equal(gw.parseOrigin('http://adshortis:3000/'), 'http://adshortis:3000');
  assert.equal(gw.parseOrigin('http://adshortis:3000/x'), null);
  assert.equal(gw.parseOrigin('http://u:p@adshortis'), null);
  assert.equal(gw.parseHttpsOrigin('http://grabbit.example.com'), null);
  assert.equal(gw.parseHttpsOrigin('https://grabbit.example.com/'), 'https://grabbit.example.com');
  assert.equal(gw.parseHttpsOrigin('javascript:alert(1)'), null);
});

test('rewriteMediaUrl: relative /m/ paths go under /api/ads; anything else is dropped', () => {
  assert.equal(gw.rewriteMediaUrl('/m/avatar/user/7'), '/api/ads/m/avatar/user/7');
  for (const v of ['https://evil.example/m/x', '//evil.example/m/x', '/m/../api/login', '/m//x', '/api/me', '', null, 7, '/m/a?b=1']) {
    assert.equal(gw.rewriteMediaUrl(v), null, String(v));
  }
});

// --- PHASE1_GATEWAY_TESTS 1: NL --------------------------------------------------------

test('S1 NL: no, unknown or expired login id -> 409 login_id_missing, zero upstream calls, no link cookie', async () => {
  reset();
  const before = upCount();
  const expiredStore = createLinkStore({ dir: path.join(root, 'expired'), writeJsonAtomic, log, now: () => Date.now() - 31 * 86400000 });
  const expired = expiredStore.issueLogin();
  for (const login of [undefined, 'A'.repeat(43), expired, 'not-an-id']) {
    const r = await call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, 409, String(login));
    assert.deepEqual(r.body, { ok: false, error: 'Sign in to Grabbit again', reason: 'login_id_missing' });
    assert.deepEqual(r.body, { ...matrix.NL_RESPONSE.body });
    assert.equal(r.setCookie.some((c) => c.startsWith(`${gw.LINK_COOKIE}=`)), false);
  }
  assert.equal(upCount(), before);
});

test('S2/S3 NL: GET says linked:false login_id_missing and DELETE clears, both without upstream', async () => {
  const before = upCount();
  const g = await call('/api/ads/session');
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, { ok: true, linked: false, reason: 'login_id_missing' });
  const d = await call('/api/ads/session', { method: 'DELETE' });
  assert.equal(d.status, 200);
  assert.ok(d.setCookie.some((c) => c.startsWith(`${gw.LINK_COOKIE}=;`) && /Max-Age=0/.test(c)));
  assert.equal(upCount(), before);
});

// --- PHASE1_GATEWAY_TESTS 2 (gateway half): only the owner ----------------------------------

test('principals: a caller that is not the owner gets 403 on every row and unlisted paths, nothing upstream', async () => {
  const { login, seal } = await linked();
  const before = upCount();
  for (const principal of ['internal', 'app-client']) {
    for (const [method, p] of [['POST', '/api/ads/session'], ['GET', '/api/ads/session'], ['DELETE', '/api/ads/session'], ['GET', '/api/ads/clips']]) {
      const r = await call(p, { method, login, seal, headers: { 'x-test-principal': principal }, body: method === 'POST' ? { username: 'a', password: 'b' } : undefined });
      assert.equal(r.status, 403, `${principal} ${method} ${p}`);
    }
  }
  assert.equal(upCount(), before);
});

// --- Allowlist ----------------------------------------------------------------------------

test('allowlist: only S1-S3 are live in phase 1; anything else is 404 and never sent upstream', async () => {
  const { login, seal } = await linked();
  const before = upCount();
  for (const [method, p] of [
    ['PUT', '/api/ads/session'], ['PATCH', '/api/ads/session'], ['GET', '/api/ads/clips'], ['GET', '/api/ads/me'],
    ['POST', '/api/ads/login'], ['GET', '/api/ads/admin/users'], ['GET', '/api/ads/m/avatar/user/7'], ['GET', '/api/ads/'],
    ['GET', '/api/ads/session/x'], ['GET', '/api/ads/version'], ['GET', '/api/ads/healthz'],
  ]) {
    const r = await call(p, { method, login, seal, body: ['PUT', 'PATCH', 'POST'].includes(method) ? {} : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.deepEqual(r.body, { ok: false, error: 'Not available through Grabbit' });
  }
  assert.equal(upCount(), before);
});

// --- PHASE1_GATEWAY_TESTS 3: origin ----------------------------------------------------------

test('origin: same-site, cross-site, plain http, header-less writes, Origin null/foreign/conflicting are refused', async () => {
  const { login, seal } = await linked();
  const before = upCount();
  const refused = [
    ['GET', { 'sec-fetch-site': 'same-site' }],
    ['GET', { 'sec-fetch-site': 'cross-site' }],
    ['GET', { 'sec-fetch-site': 'none' }],
    ['GET', { origin: 'https://evil.example.com' }],
    ['POST', { 'sec-fetch-site': 'same-site', origin: OWN }],
    ['POST', { 'sec-fetch-site': 'same-origin', origin: 'null' }],
    ['POST', { 'sec-fetch-site': 'same-origin', origin: 'https://evil.example.com' }],
    ['POST', { 'sec-fetch-site': 'same-origin', origin: 'http://grabbit.example.com' }],
    ['POST', { 'sec-fetch-site': 'same-origin', origin: `${OWN}:443x` }],
    ['POST', { 'sec-fetch-site': 'same-origin' }], // no Origin on a write
    ['POST', {}], // no browser headers at all
    ['DELETE', {}],
    ['DELETE', { origin: 'https://grabbit.example.com.evil.example' }],
  ];
  for (const [method, headers] of refused) {
    const r = await call('/api/ads/session', { method, login, seal, browser: false, headers, body: method === 'POST' ? { username: 'a', password: 'b' } : undefined });
    assert.equal(r.status, 403, `${method} ${JSON.stringify(headers)}`);
  }
  // Plain http (no trusted X-Forwarded-Proto): refused.
  const plain = await call('/api/ads/session', { login, seal, headers: { 'x-forwarded-proto': null } });
  assert.equal(plain.status, 403);
  assert.equal(upCount(), before);
  // A header-less read is allowed (and reaches upstream: /api/me).
  const read = await call('/api/ads/session', { login, seal, browser: false });
  assert.equal(read.status, 200);
  assert.equal(read.body.linked, true);
});

// --- Link, forwarded headers, answers ------------------------------------------------------------

test('S1 link: upstream sees only what the gateway builds; the answer carries the projected user', async () => {
  reset();
  const login = links.issueLogin();
  const mark = upCount();
  const r = await call('/api/ads/session', {
    method: 'POST',
    login,
    cookie: 'grabbit_auth=owner-cookie; grabbit_cache_gen=1',
    headers: { authorization: 'Bearer x', 'x-grabbit-token': 'tok', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '1.1.1.1, 9.9.9.9' },
    body: { username: USERNAME, password: PASSWORD },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['ok', 'linked', 'user']);
  assert.deepEqual(Object.keys(r.body.user), matrix.SESSION_FIELDS);
  assert.equal(r.body.user.avatar, '/api/ads/m/avatar/user/7');
  const set = r.setCookie.find((c) => c.startsWith(`${gw.LINK_COOKIE}=`));
  assert.match(set, /; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  for (const h of ['cache-control', 'x-content-type-options', 'referrer-policy']) assert.ok(r.headers.get(h), h);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  const calls = up.seen.slice(mark);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/login', 'GET /api/me']);
  const [lg, me] = calls;
  assert.equal(lg.headers.origin, APP);
  // req.ip as Grabbit's trust proxy resolves it (loopback is trusted here, so
  // the last hop), sent as one value; the caller's chain is never copied.
  assert.equal(lg.headers['x-forwarded-for'], '9.9.9.9');
  assert.deepEqual(JSON.parse(lg.body), { username: USERNAME, password: PASSWORD });
  for (const c of calls) {
    for (const k of ['authorization', 'x-grabbit-token', 'x-forwarded-host', 'x-forwarded-proto', 'referer', 'sec-fetch-site']) assert.equal(c.headers[k], undefined, `${c.url} ${k}`);
    assert.ok(!String(c.headers.cookie || '').includes('grabbit'), c.url);
  }
  assert.equal(lg.headers.cookie, undefined);
  assert.equal(me.headers.cookie, 'as_session=tok' + up.tokens);
  assert.equal(me.headers.origin, undefined);
});

test('S1 link: upstream 401/429 keep their status (Retry-After passes), 5xx and a bad /api/me become 424', async () => {
  const login = links.issueLogin();
  const post = () => call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
  up.login = '401';
  assert.equal((await post()).status, 401);
  up.login = '429';
  const tooMany = await post();
  assert.equal(tooMany.status, 429);
  assert.equal(tooMany.headers.get('retry-after'), '600');
  up.login = '500';
  assert.equal((await post()).status, 424);
  up.login = 'ok';
  up.me = 'array';
  const mark = upCount();
  const bad = await post();
  assert.equal(bad.status, 424);
  assert.equal(sealFrom(bad), null);
  // The session that could not be read is ended upstream.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(up.seen.slice(mark).some((c) => c.url === '/api/logout'));
  reset();
  assert.equal((await call('/api/ads/session', { method: 'POST', login, body: { username: '', password: 'x' } })).status, 400);
  assert.equal((await call('/api/ads/session', { method: 'POST', login, body: { username: 'x'.repeat(101), password: 'x' } })).status, 400);
});

// --- PHASE1_GATEWAY_TESTS 5: S2 projection --------------------------------------------------------

test('S2: exactly the six projectSession keys in order, never ai/nav_tabs/prefs; non-object -> 424; 401 unlinks', async () => {
  const { login, seal } = await linked();
  const r = await call('/api/ads/session', { login, seal });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.user), ['id', 'username', 'display_name', 'role', 'permissions', 'avatar']);
  assert.deepEqual(Object.keys(r.body.user), Object.keys(matrix.projectSession(ME, '1')));
  for (const k of ['ai', 'nav_tabs', 'prefs', 'extra']) assert.equal(k in r.body.user, false, k);
  up.me = 'array';
  assert.equal((await call('/api/ads/session', { login, seal })).status, 424);
  up.me = 'html';
  assert.equal((await call('/api/ads/session', { login, seal })).status, 424);
  up.me = '401';
  const gone = await call('/api/ads/session', { login, seal });
  assert.deepEqual(gone.body, { ok: true, linked: false, expired: true });
  assert.ok(gone.setCookie.some((c) => c.startsWith(`${gw.LINK_COOKIE}=;`)));
  reset();
  const after = await call('/api/ads/session', { login, seal });
  assert.equal(after.body.linked, false, 'the upstream 401 cleared the seal record');
});

// --- PHASE1_GATEWAY_TESTS 4: seal ---------------------------------------------------------------------

test('seal: tampered, other login id, replaced, duplicate cookie names -> unlinked/401 with zero upstream calls', async () => {
  const p3 = await mount('3'); // a member row matches in phase 3: the unlinked caller must be 401
  const a = await linked();
  const b = await linked();
  const tampered = a.seal.slice(0, 10) + (a.seal[10] === 'A' ? 'B' : 'A') + a.seal.slice(11);
  const cases = [
    ['tampered', { login: a.login, seal: tampered }],
    ['other login id', { login: b.login, seal: a.seal }],
    ['duplicate link cookie', { login: a.login, seal: a.seal, cookie: `${gw.LINK_COOKIE}=${a.seal}` }],
    ['duplicate login cookie', { login: a.login, seal: a.seal, cookie: `${gw.LOGIN_COOKIE}=${a.login}` }],
  ];
  const before = upCount();
  for (const [name, c] of cases) {
    const m0 = upCount();
    const s = await call('/api/ads/session', c);
    assert.equal(s.status, 200, name);
    assert.equal(s.body.linked, false, name);
    const m = await call('/api/ads/clips/1', { ...c, at: p3 });
    assert.equal(m.status, 401, name);
    assert.deepEqual(up.seen.slice(m0).map((x) => x.url), [], name);
  }
  assert.equal(upCount(), before, 'no upstream call for an invalid seal');
  // A valid seal on the same phase-3 gateway is not 401 (this build has no proxy: 404).
  assert.equal((await call('/api/ads/clips/1', { login: a.login, seal: a.seal, at: p3 })).status, 404);
  // Re-link: the new seal replaces the old one; the old cookie is dead.
  const relink = await call('/api/ads/session', { method: 'POST', login: a.login, seal: a.seal, body: { username: USERNAME, password: PASSWORD } });
  const fresh = sealFrom(relink);
  assert.ok(fresh && fresh !== a.seal);
  // The replaced upstream session is ended too (best effort, not awaited).
  await new Promise((r) => setTimeout(r, 50));
  const ended = up.seen.filter((x) => x.url === '/api/logout').pop();
  assert.ok(ended && ended.headers.cookie !== `as_session=tok${up.tokens}`, 'old upstream session logged out');
  const mark = upCount();
  assert.equal((await call('/api/ads/session', { login: a.login, seal: a.seal })).body.linked, false);
  assert.equal((await call('/api/ads/clips/1', { login: a.login, seal: a.seal, at: p3 })).status, 401);
  assert.equal(upCount(), mark);
  assert.equal((await call('/api/ads/session', { login: a.login, seal: fresh })).body.linked, true);
  // Logout (the record is dropped): the seal dies with it.
  links.dropLogin(a.login);
  assert.equal((await call('/api/ads/clips/1', { login: a.login, seal: fresh, at: p3 })).status, 401);
});

// --- PHASE1_GATEWAY_TESTS 6: S3 ----------------------------------------------------------------------------

test('S3: the seal record goes before the upstream logout; upstream 500 or a dead socket still leaves the next call unlinked', async () => {
  const p3 = await mount('3');
  for (const mode of ['500', 'drop']) {
    const { login, seal } = await linked();
    up.logout = mode;
    const mark = upCount();
    const d = await call('/api/ads/session', { method: 'DELETE', login, seal });
    const order = up.seen.slice(mark).map((c) => c.url);
    assert.equal(d.status, 200, mode);
    assert.deepEqual(d.body, { ok: true, linked: false });
    assert.ok(d.setCookie.some((c) => c.startsWith(`${gw.LINK_COOKIE}=;`) && /Max-Age=0/.test(c)));
    assert.deepEqual(order, ['/api/logout']);
    const after = upCount();
    assert.equal((await call('/api/ads/session', { login, seal })).body.linked, false, mode);
    assert.equal((await call('/api/ads/clips/1', { login, seal, at: p3 })).status, 401, mode);
    assert.equal(upCount(), after);
  }
  reset();
});

test('S3: the record is cleared before the upstream call is made', async () => {
  const { login, seal } = await linked();
  let openAtLogout = 'not called';
  const handler = upstream.listeners('request')[0];
  upstream.removeAllListeners('request');
  upstream.on('request', (req, res) => {
    if (req.url === '/api/logout') openAtLogout = links.open(login, seal);
    handler(req, res);
  });
  try {
    await call('/api/ads/session', { method: 'DELETE', login, seal });
  } finally {
    upstream.removeAllListeners('request');
    upstream.on('request', handler);
  }
  assert.equal(openAtLogout, null, 'the seal no longer opened when upstream logout ran');
});

// --- Codex phase-1 review: races, strict answers, the body ------------------------------------------------

test('race: an unlink while a link is in flight wins; the late link is refused and its session ended', async () => {
  reset();
  const login = links.issueLogin();
  const held = holdUpstream('/api/login');
  const pending = call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
  await held.reached;
  const d = await call('/api/ads/session', { method: 'DELETE', login });
  assert.equal(d.status, 200);
  const mark = upCount();
  held.release();
  const r = await pending;
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(sealFrom(r), null, 'no link cookie');
  await sleep(50);
  const ended = up.seen.slice(mark).filter((c) => c.url === '/api/logout');
  assert.deepEqual(ended.map((c) => c.headers.cookie), [`as_session=tok${up.tokens}`], 'the minted session is ended');
  assert.equal(links.open(login, 'x'), null);
  assert.equal((await call('/api/ads/session', { login })).body.linked, false);
});

test('race: two links in flight; only the first to finish commits', async () => {
  reset();
  const login = links.issueLogin();
  const held = holdUpstream('/api/login');
  const slow = call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
  await held.reached;
  const fast = await call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(fast.status, 200);
  held.release();
  const late = await slow;
  assert.equal(late.status, 409);
  assert.equal((await call('/api/ads/session', { login, seal: sealFrom(fast) })).body.linked, true, 'the committed link stays');
});

test('race: a status check whose upstream 401 arrives after a re-link leaves the new link and its cookie alone', async () => {
  const a = await linked();
  const held = holdUpstream('/api/me', (send) => send(401, { error: 'Unauthorized' }));
  const stale = call('/api/ads/session', { login: a.login, seal: a.seal });
  await held.reached;
  const relink = await call('/api/ads/session', { method: 'POST', login: a.login, seal: a.seal, body: { username: USERNAME, password: PASSWORD } });
  assert.equal(relink.status, 200);
  const fresh = sealFrom(relink);
  held.release();
  const r = await stale;
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.setCookie.some((c) => c.startsWith(`${gw.LINK_COOKIE}=`)), false, 'the browser cookie is not cleared');
  assert.equal((await call('/api/ads/session', { login: a.login, seal: fresh })).body.linked, true);
  // The same 401 without a re-link in between still unlinks.
  const held2 = holdUpstream('/api/me', (send) => send(401, { error: 'Unauthorized' }));
  const gone = call('/api/ads/session', { login: a.login, seal: fresh });
  await held2.reached;
  held2.release();
  assert.deepEqual((await gone).body, { ok: true, linked: false, expired: true });
});

test('S1 strict: only a 200 JSON { ok: true } with a well-formed token and a real user id links; else 424 or the JSON 4xx', async () => {
  const login = links.issueLogin();
  const post = () => call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
  for (const [mode, me, want, minted] of [
    ['html200', 'ok', 424, true],
    ['empty200', 'ok', 424, true],
    ['badtoken', 'ok', 424, false],
    ['302', 'ok', 424, false],
    ['400html', 'ok', 424, false],
    ['403', 'ok', 403, false],
    ['ok', 'emptyobj', 424, true],
  ]) {
    reset();
    up.login = mode;
    up.me = me;
    const t0 = up.tokens;
    const mark = upCount();
    const r = await post();
    assert.equal(r.status, want, `${mode}/${me}`);
    assert.equal(sealFrom(r), null, `${mode}/${me}: no link`);
    assert.equal(r.headers.get('location'), null, `${mode}: no redirect passes`);
    await sleep(30);
    const ended = up.seen.slice(mark).filter((c) => c.url === '/api/logout').map((c) => c.headers.cookie);
    assert.deepEqual(ended, minted ? [`as_session=tok${t0 + 1}`] : [], `${mode}/${me}: minted session ended`);
  }
  reset();
  assert.equal((await call('/api/ads/session', { login })).body.linked, false);
});

test('S1/S2 (3a review C-M5): a JSON 4xx keeps its status with a fixed message; upstream text and a non-numeric Retry-After never pass', async () => {
  const login = links.issueLogin();
  const post = () => call('/api/ads/session', { method: 'POST', login, body: { username: USERNAME, password: PASSWORD } });
  const seen = [];
  for (const [mode, want, retry] of [['401', 401, null], ['403', 403, null], ['429', 429, '600'], ['429text', 429, null], ['418', 418, null]]) {
    reset();
    up.login = mode;
    const r = await post();
    assert.equal(r.status, want, mode);
    assert.equal(r.headers.get('retry-after'), retry, `${mode}: Retry-After`);
    assert.equal(typeof r.body.error, 'string', mode);
    seen.push(r.body.error);
  }
  assert.deepEqual(seen.filter((e) => /UPSTREAM-TEXT|Wrong user name|Account disabled|Too many attempts/.test(e)), [], 'S1 messages are fixed');
  reset();
  const { login: l2, seal } = await linked();
  for (const [mode, want] of [['429', 429], ['404text', 404], ['403', 403]]) {
    up.me = mode;
    const r = await call('/api/ads/session', { login: l2, seal });
    assert.equal(r.status, want, `S2 ${mode}`);
    assert.equal(r.headers.get('retry-after'), null, `S2 ${mode}: Retry-After`);
    assert.doesNotMatch(r.body.error, /UPSTREAM-TEXT|Forbidden/, `S2 ${mode}: fixed message`);
  }
  reset();
});

test('S2: a JSON 4xx other than 401 keeps its status and the link', async () => {
  const { login, seal } = await linked();
  up.me = '403';
  const r = await call('/api/ads/session', { login, seal });
  assert.equal(r.status, 403);
  assert.equal(r.setCookie.some((c) => c.startsWith(`${gw.LINK_COOKIE}=`)), false);
  reset();
  assert.equal((await call('/api/ads/session', { login, seal })).body.linked, true);
});

test('body: read after the checks; malformed, wrong type and oversized bodies get a JSON answer and nothing goes upstream', async () => {
  reset();
  const login = links.issueLogin();
  const before = upCount();
  // Without a login id the NL answer comes first, whatever the body.
  const nl = await call('/api/ads/session', { method: 'POST', raw: '{nope' });
  assert.equal(nl.status, 409);
  // Not the owner: 403 before the body is looked at.
  assert.equal((await call('/api/ads/session', { method: 'POST', login, raw: '{nope', headers: { 'x-test-principal': 'internal' } })).status, 403);
  for (const [name, opts, want] of [
    ['malformed', { raw: '{nope' }, 400],
    ['form body', { raw: 'username=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 415],
    ['oversized', { raw: JSON.stringify({ username: 'a', password: 'x'.repeat(20000) }) }, 413],
    ['json null', { raw: 'null' }, 400],
  ]) {
    const r = await call('/api/ads/session', { method: 'POST', login, ...opts });
    assert.equal(r.status, want, name);
    assert.equal(r.body && r.body.ok, false, `${name}: JSON answer`);
    assert.equal(r.headers.get('cache-control'), 'private, no-store', name);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', name);
  }
  assert.equal(upCount(), before);
});

test('links: a failed write changes nothing; a damaged fingerprint does not stop boot; a loaded key is narrowed to 0600', () => {
  const dir = path.join(root, 'fail');
  let failing = false;
  const flaky = (file, value, mode) => {
    if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    writeJsonAtomic(file, value, mode);
  };
  const s = createLinkStore({ dir, writeJsonAtomic: flaky, log });
  const id = s.issueLogin();
  const sealed = s.seal(id, { t: 'x', u: 1 });
  failing = true;
  assert.throws(() => s.issueLogin(), /disk full/);
  assert.throws(() => s.dropLogin(id), /disk full/);
  assert.equal(s.loginValid(id), true, 'a failed drop keeps the record in memory, as on disk');
  assert.throws(() => s.clearSeal(id), /disk full/);
  assert.deepEqual(s.open(id, sealed), { t: 'x', u: 1 }, 'a failed unlink does not claim success');
  assert.throws(() => s.seal(id, { t: 'y', u: 1 }), /disk full/);
  assert.deepEqual(s.open(id, sealed), { t: 'x', u: 1 });
  failing = false;
  const again = createLinkStore({ dir, writeJsonAtomic, log });
  assert.deepEqual(again.open(id, sealed), { t: 'x', u: 1 }, 'disk and memory agree');
  // A fingerprint of the right length in characters but not in bytes.
  const modeFile = path.join(dir, 'ads-mode.json');
  for (const auth of [{ salt: '0'.repeat(32), hash: 'é'.repeat(64) }, { salt: 'zz', hash: '0'.repeat(64) }, { salt: 5, hash: null }]) {
    fs.writeFileSync(modeFile, JSON.stringify({ v: 1, mode: 'native', gen: 1, auth }));
    const b = createLinkStore({ dir, writeJsonAtomic, log }).bootCheck({ mode: 'native', password: 'p', secret: '' });
    assert.match(b.reason, /password or secret changed/);
  }
  const keyFile = path.join(dir, 'ads-seal-key.json');
  fs.chmodSync(keyFile, 0o644);
  createLinkStore({ dir, writeJsonAtomic, log }).sealKey();
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});

// --- S12: the log --------------------------------------------------------------------------------------------

test('log: method, rule and status only; no user names, passwords, tokens, query strings or paths', async () => {
  logs.length = 0;
  const { login, seal } = await linked();
  await call('/api/ads/session?q=secret-query', { login, seal });
  await call('/api/ads/clips?creator=secret-creator', { login, seal });
  const text = logs.join('\n');
  for (const bad of [USERNAME, PASSWORD, 'secret-query', 'secret-creator', 'tok', 'clips', login, seal]) assert.ok(!text.includes(bad), bad);
  assert.match(text, /\[ads\] POST S1 200/);
  assert.match(text, /\[ads\] GET S2 200/);
  assert.match(text, /\[ads\] GET - 404/);
});

// --- Link store ------------------------------------------------------------------------------------------------

test('links: files, modes, boot drops on mode or password change, generation bumps on mode change only', () => {
  const dir = path.join(root, 'boot');
  const s1 = createLinkStore({ dir, writeJsonAtomic, log });
  const b0 = s1.bootCheck({ mode: 'native', password: 'p1', secret: '' });
  assert.equal(b0.gen, 1);
  const id = s1.issueLogin();
  const sealed = s1.seal(id, { t: 'x', u: 1 });
  assert.deepEqual(s1.open(id, sealed), { t: 'x', u: 1 });
  assert.equal(fs.statSync(s1.files.keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s1.files.loginsFile).mode & 0o777, 0o600);
  const raw = fs.readFileSync(s1.files.loginsFile, 'utf8');
  assert.ok(!raw.includes(id), 'the login id itself is never stored');
  // Same mode and password: nothing dropped, same generation.
  const s2 = createLinkStore({ dir, writeJsonAtomic, log });
  assert.deepEqual(s2.bootCheck({ mode: 'native', password: 'p1', secret: '' }), { gen: 1, dropped: 0, reason: null });
  assert.deepEqual(s2.open(id, sealed), { t: 'x', u: 1 });
  // A new password: every record dropped, generation unchanged.
  const s3 = createLinkStore({ dir, writeJsonAtomic, log });
  const b3 = s3.bootCheck({ mode: 'native', password: 'p2', secret: '' });
  assert.equal(b3.gen, 1);
  assert.equal(b3.dropped, 1);
  assert.equal(s3.open(id, sealed), null);
  // A new mode: generation bumps, records dropped.
  const id2 = s3.issueLogin();
  const s4 = createLinkStore({ dir, writeJsonAtomic, log });
  const b4 = s4.bootCheck({ mode: 'embed', password: 'p2', secret: '' });
  assert.equal(b4.gen, 2);
  assert.equal(b4.dropped, 1);
  assert.equal(s4.loginValid(id2), false);
  // A corrupt login file is set aside and means "no links", never a rebuild.
  fs.writeFileSync(s4.files.loginsFile, '{nope');
  const s5 = createLinkStore({ dir, writeJsonAtomic, log });
  assert.equal(s5.loginValid(id2), false);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('ads-logins.json.corrupt-')));
});
