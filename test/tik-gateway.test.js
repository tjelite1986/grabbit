'use strict';
// Unit tests for the TikShortis gateway (tikshortis-gateway.js), run against a
// fake TikShortis upstream in this process. The gateway is mounted the way
// server.js mounts it (the global body parsers first, then /api/tik), but without
// Grabbit's auth gate: that part is covered by tik-server.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const gw = require('../tikshortis-gateway');

const SECRET = 'test-secret';

// --- Fake upstream ---------------------------------------------------------------
// Records every request; answers from `handlers[path]` or with a JSON echo.
const seen = [];
const handlers = {};
let upBase;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    seen.push(rec);
    const path = req.url.split('?')[0];
    const h = handlers[`${req.method} ${path}`] || handlers[path];
    if (h) return h(req, res, rec);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
});
const json = (status, body, extra = {}) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
};

// --- Grabbit side ------------------------------------------------------------------
let base;
let server;
let adultSet = new Set();
const warnings = [];
const quietLog = { warn: (m) => warnings.push(m), log() {}, error() {} };

test.before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upBase = `http://127.0.0.1:${upstream.address().port}`;
  const g = gw.createGateway({
    apiUrl: upBase,
    secret: SECRET,
    isAdult: (clip) => adultSet.has(String(clip.source_id)),
    clientIp: () => '203.0.113.7',
    log: quietLog,
    timeoutMs: 5000,
  });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/tik', (req, res) => {
    g.proxy(req, res).catch(() => {
      if (!res.headersSent) res.status(424).json({ ok: false });
      else res.destroy();
    });
  });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  upstream.close();
});

test.beforeEach(() => {
  seen.length = 0;
  for (const k of Object.keys(handlers)) delete handlers[k];
  adultSet = new Set();
});

const linked = () => `${gw.TIK_COOKIE}=${gw.sealSession(SECRET, { t: 'upstream-token', exp: Date.now() + 60000 })}`;
const own = { 'Sec-Fetch-Site': 'same-origin' };
const call = (path, opts = {}) => fetch(`${base}/api/tik/${path}`, { ...opts, headers: { ...own, ...(opts.headers || {}) } });

// --- Settings ------------------------------------------------------------------------

test('TIKSHORTIS_API_URL: only a plain http(s) origin', () => {
  assert.equal(gw.parseApiUrl('http://192.168.0.10:3001'), 'http://192.168.0.10:3001');
  assert.equal(gw.parseApiUrl('http://tik.example.com:3001/'), 'http://tik.example.com:3001');
  assert.equal(gw.parseApiUrl('https://tik.example.com'), 'https://tik.example.com');
  for (const bad of [undefined, null, '', ' ', 'tik.example.com', 'ftp://tik.example.com', 'http://u:p@tik.example.com',
    'http://tik.example.com/api', 'http://tik.example.com?x=1', 'http://tik.example.com#a', 'javascript:alert(1)']) {
    assert.equal(gw.parseApiUrl(bad), null, String(bad));
  }
  assert.throws(() => gw.createGateway({ apiUrl: 'nope', secret: SECRET }), /not a plain http/);
});

// --- Sealed session -------------------------------------------------------------------

test('sealed session: round trip, tamper, wrong secret, expiry, garbage', () => {
  const sealed = gw.sealSession(SECRET, { t: 'tok', exp: Date.now() + 60000 });
  assert.equal(gw.openSession(SECRET, sealed).t, 'tok');
  assert.ok(!sealed.includes('tok'), 'token must not be readable in the cookie');
  assert.equal(gw.openSession('other-secret', sealed), null);
  const raw = Buffer.from(sealed, 'base64url');
  raw[raw.length - 1] ^= 1;
  assert.equal(gw.openSession(SECRET, raw.toString('base64url')), null);
  assert.equal(gw.openSession(SECRET, gw.sealSession(SECRET, { t: 'tok', exp: Date.now() - 1 })), null);
  assert.equal(gw.openSession(SECRET, gw.sealSession(SECRET, { t: '' })), null);
  for (const g of [undefined, null, '', 'abc', 'x'.repeat(200)]) assert.equal(gw.openSession(SECRET, g), null);
});

// --- Allowlist --------------------------------------------------------------------------

test('allowlist: method and path must both match', () => {
  assert.ok(gw.matchRoute('GET', 'shorts/feed'));
  assert.ok(gw.matchRoute('HEAD', 'shorts/12/video'));
  assert.ok(gw.matchRoute('GET', 'shorts/people/some.one_x'));
  assert.equal(gw.matchRoute('POST', 'shorts/feed'), null);
  assert.equal(gw.matchRoute('GET', 'shorts/abc'), null);
  assert.equal(gw.matchRoute('PATCH', 'shorts/1234567890123'), null, 'ids are capped at 12 digits');
  for (const p of ['auth/login', 'auth/logout', 'shorts/grab/start', 'admin/users', 'shorts/feed/', 'shorts/../admin/users',
    'shorts/people/a/b', 'shorts/1/video/x']) {
    assert.equal(gw.matchRoute('GET', p), null, p);
    assert.equal(gw.matchRoute('POST', p), null, p);
  }
});

test('allowlist: an unlisted route is a 404 from the gateway and never goes upstream', async () => {
  for (const [method, path] of [['GET', 'auth/login'], ['POST', 'auth/login'], ['GET', 'admin/users'], ['POST', 'shorts/feed'],
    ['GET', 'shorts/grab/start'], ['GET', 'shorts/%2e%2e/admin/users']]) {
    const r = await call(path, { method });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal((await r.json()).ok, false);
  }
  assert.equal(seen.length, 0);
});

// --- Headers sent upstream ------------------------------------------------------------------

test('admin token, browser cookies and client IP headers are never forwarded', async () => {
  await call('me', {
    headers: {
      'x-admin-token': 'leak',
      'X-Real-IP': '10.9.9.9',
      'X-Forwarded-For': '10.9.9.9',
      Authorization: 'Bearer leak',
      Cookie: `grabbit_auth=abc; other=1; ${linked()}`,
      'x-upload-name': 'not-an-upload.mp4',
    },
  });
  assert.equal(seen.length, 1);
  const h = seen[0].headers;
  assert.equal(h['x-admin-token'], undefined);
  assert.equal(h.authorization, undefined);
  assert.equal(h['x-forwarded-for'], undefined);
  assert.equal(h['x-upload-name'], undefined, 'upload headers pass on the upload route only');
  assert.equal(h['x-real-ip'], '203.0.113.7', 'x-real-ip comes from clientIp(), not from the caller');
  assert.equal(h.cookie, 'tikshortis_session=upstream-token', 'only the unsealed TikShortis session goes upstream');
  assert.equal(h.host, new URL(upBase).host);
});

test('no linked account: no cookie upstream', async () => {
  await call('me');
  assert.equal(seen[0].headers.cookie, undefined);
});

test('Origin is set to the TikShortis origin on writes only', async () => {
  await call('me', { headers: { Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(seen[0].headers.origin, undefined, 'a read carries no Origin');
  await call('shorts/5/like', { method: 'POST', headers: { Origin: 'https://evil.example.com', Cookie: linked() } });
  assert.equal(seen[1].headers.origin, upBase);
  assert.equal(seen[1].headers['sec-fetch-site'], 'same-origin');
});

test('JSON bodies are re-sent as JSON; query strings pass through', async () => {
  await call('shorts/7/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) });
  assert.equal(seen[0].body, '{"body":"hi"}');
  assert.equal(seen[0].headers['content-type'], 'application/json');
  await call('shorts/feed?cursor=10&tag=cats');
  assert.equal(seen[1].url, '/api/shorts/feed?cursor=10&tag=cats');
});

test('upload headers pass on the upload route and are capped', async () => {
  await call('shorts/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-upload-name': 'a.mp4', 'x-upload-caption': 'c'.repeat(9000), 'x-admin-token': 'leak' },
    body: Buffer.from('raw-bytes'),
  });
  const h = seen[0].headers;
  assert.equal(h['x-upload-name'], 'a.mp4');
  assert.equal(h['x-upload-caption'].length, 8192);
  assert.equal(h['x-admin-token'], undefined);
  assert.equal(seen[0].body, 'raw-bytes');
});

test('an upload with a body Grabbit already parsed is a 415, not a hang', async () => {
  for (const [ct, body] of [['application/json', '{"a":1}'], ['application/x-www-form-urlencoded', 'a=1']]) {
    const started = Date.now();
    const r = await call('shorts/upload', { method: 'POST', headers: { 'Content-Type': ct }, body });
    assert.equal(r.status, 415, ct);
    assert.ok(Date.now() - started < 2000, `${ct} answered at once`);
  }
  assert.equal(seen.length, 0);
});

// --- Who may call ------------------------------------------------------------------------

test('only Grabbit\'s own pages: same-site and cross-site browsers get 403', async () => {
  for (const site of ['same-site', 'cross-site', 'none']) {
    const r = await call('me', { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(r.status, 403, site);
    const s = await call('session', { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(s.status, 403, `session ${site}`);
  }
  assert.equal(seen.length, 0);
});

test('without Sec-Fetch-Site: Origin must match the host; no headers at all allows reads only', async () => {
  const host = new URL(base).host;
  const plain = (path, opts = {}) => fetch(`${base}/api/tik/${path}`, opts);
  assert.equal((await plain('me')).status, 200, 'a bare read');
  assert.equal((await plain('shorts/5/like', { method: 'POST' })).status, 403, 'a bare write');
  assert.equal((await plain('shorts/5/like', { method: 'POST', headers: { Origin: `http://${host}` } })).status, 200);
  assert.equal((await plain('shorts/5/like', { method: 'POST', headers: { Origin: 'http://evil.example.com' } })).status, 403);
  assert.equal((await plain('shorts/5/like', { method: 'POST', headers: { Referer: 'not a url' } })).status, 403);
});

// --- Answers coming back --------------------------------------------------------------------

test('a TikShortis 5xx becomes 424 (never a 5xx through Cloudflare)', async () => {
  for (const code of [500, 502, 503]) {
    handlers['/api/me'] = json(code, { error: 'boom' });
    const r = await call('me');
    assert.equal(r.status, 424, String(code));
    assert.match(r.headers.get('content-type'), /application\/json/);
  }
});

test('an unreachable TikShortis is a 424', async () => {
  const dead = gw.createGateway({ apiUrl: 'http://127.0.0.1:1', secret: SECRET, log: quietLog });
  const app = express();
  app.use('/api/tik', (req, res) => dead.proxy(req, res));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/tik/me`, { headers: own });
    assert.equal(r.status, 424);
  } finally {
    s.close();
  }
});

test('HTML, SVG and unknown types are refused; media passes only on stream routes', async () => {
  const send = (ct, body = 'x', status = 200) => (req, res) => { res.writeHead(status, { 'content-type': ct }); res.end(body); };
  handlers['/api/me'] = send('text/html', '<html>login</html>');
  let r = await call('me');
  assert.equal(r.status, 424);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.ok(!(await r.text()).includes('<html>'));

  handlers['/api/me'] = send('text/html', '<html>404</html>', 404);
  r = await call('me');
  assert.equal(r.status, 404, 'an upstream 4xx keeps its status but loses its HTML body');
  assert.ok(!(await r.text()).includes('<html>'));

  handlers['/api/me'] = send('image/jpeg');
  assert.equal((await call('me')).status, 424, 'media on a JSON route');

  handlers['/api/shorts/3/poster'] = send('image/svg+xml', '<svg onload="x()"/>');
  assert.equal((await call('shorts/3/poster')).status, 424);
  handlers['/api/shorts/3/poster'] = send('application/xml');
  assert.equal((await call('shorts/3/poster')).status, 424);

  handlers['/api/shorts/3/video'] = send('video/webm', 'VIDEO', 206);
  r = await call('shorts/3/video', { headers: { Range: 'bytes=0-4' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), 'VIDEO');
  assert.equal(seen.at(-1).headers.range, 'bytes=0-4');
  assert.equal(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('allowedType table', () => {
  assert.equal(gw.allowedType('application/json; charset=utf-8', false), true);
  assert.equal(gw.allowedType('video/mp4', false), false);
  assert.equal(gw.allowedType('video/mp4', true), true);
  assert.equal(gw.allowedType('image/webp', true), true);
  for (const t of ['text/html', 'image/svg+xml', 'application/xml', 'text/plain', '', undefined, 'image/x-icon']) {
    assert.equal(gw.allowedType(t, true), false, String(t));
  }
});

test('an upstream 401 unlinks the account', async () => {
  handlers['/api/me'] = json(401, { error: 'Unauthorized' });
  const r = await call('me', { headers: { Cookie: linked() } });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('set-cookie'), new RegExp(`^${gw.TIK_COOKIE}=; .*Max-Age=0`));
});

// --- General-channel filter (fail closed) --------------------------------------------------------

test('filterClips: non-main channels, clips without a channel and adult clips are dropped', () => {
  const isAdult = (c) => c.source_id === 'adult-1';
  const { value, dropped } = gw.filterClips({
    items: [
      { id: 1, channel: 'main', storage_key: 'a' },
      { id: 2, channel: '18plus', storage_key: 'b' },
      { id: 3, storage_key: 'c' },
      { id: 4, channel: 'main', storage_key: 'd', source_id: 'adult-1' },
      { id: 5, channel: 'main', profile: { id: 9, channel: '18plus' } },
      { name: 'tag without channel' },
    ],
    profile: { id: 9, channel: 'platform' },
  }, isAdult);
  assert.deepEqual(value.items.map((x) => x.id ?? x.name), [1, 5, 'tag without channel']);
  assert.equal(value.items[1].profile, null);
  assert.equal(value.profile, null);
  assert.equal(dropped, 5);
  assert.deepEqual(gw.filterClips({ id: 1, channel: '18plus' }), { value: null, dropped: 1 });
  assert.deepEqual(gw.filterClips(null), { value: null, dropped: 0 });
});

test('feed through the gateway: only general clips arrive', async () => {
  adultSet = new Set(['s-adult']);
  handlers['/api/shorts/feed'] = json(200, {
    items: [
      { id: 1, channel: 'main', storage_key: 'a', source_id: 's-ok' },
      { id: 2, channel: '18plus', storage_key: 'b' },
      { id: 3, has_poster: true },
      { id: 4, channel: 'main', storage_key: 'd', source_id: 's-adult' },
    ],
    nextCursor: 4,
  });
  const r = await call('shorts/feed');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.items.map((x) => x.id), [1]);
  assert.equal(d.nextCursor, 4);
  assert.ok(warnings.some((w) => /dropped 3 item/.test(w)));
});

test('an 18+ profile is a 404, not an empty shell', async () => {
  handlers['/api/shorts/profiles/9'] = json(200, { profile: { id: 9, channel: '18plus', name: 'x' }, clips: [] });
  let r = await call('shorts/profiles/9');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).ok, false);

  handlers['/api/shorts/profiles/9'] = json(200, { profile: { id: 9, channel: 'main', name: 'x' }, clips: [{ id: 1, channel: '18plus', storage_key: 'k' }] });
  r = await call('shorts/profiles/9');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.profile.name, 'x');
  assert.deepEqual(d.clips, []);
});

test('a top-level answer outside the general channel is a 404', async () => {
  handlers['/api/shorts/creators'] = json(200, { id: 1, channel: '18plus', storage_key: 'x' });
  assert.equal((await call('shorts/creators')).status, 404);
});

test('unfiltered routes are not rewritten', async () => {
  handlers['/api/me'] = json(200, { user: { id: 1, channel: '18plus' } });
  const d = await (await call('me')).json();
  assert.equal(d.user.channel, '18plus');
});

// --- /api/tik/session ------------------------------------------------------------------------

test('session: link, read, unlink', async () => {
  handlers['POST /api/auth/login'] = (req, res, rec) => {
    const b = JSON.parse(rec.body);
    if (b.password !== 'right') return json(401, { error: 'Invalid credentials' })(req, res);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['tikshortis_session=fresh-token; Path=/; HttpOnly'] });
    res.end('{"ok":true}');
  };
  let r = await call('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'wrong' }) });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);

  r = await call('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'right' }) });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\/api\/tik/);
  assert.ok(!sc.includes('fresh-token'), 'the upstream token is sealed');
  const cookie = sc.split(';')[0];
  assert.equal(gw.openSession(SECRET, cookie.split('=')[1]).t, 'fresh-token');

  handlers['GET /api/me'] = (req, res) => json(req.headers.cookie === 'tikshortis_session=fresh-token' ? 200 : 401, { user: { id: 1, name: 'n' } })(req, res);
  r = await call('session', { headers: { Cookie: cookie } });
  assert.deepEqual(await r.json(), { ok: true, linked: true, user: { id: 1, name: 'n' } });

  r = await call('session', { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.ok(seen.some((s) => s.url === '/api/auth/logout' && s.headers.cookie === 'tikshortis_session=fresh-token'));
});

test('session: missing fields are a 400 and nothing goes upstream', async () => {
  for (const body of [{}, { email: 'a@example.com' }, { password: 'x' }, { email: 'a'.repeat(400), password: 'x' }]) {
    const r = await call('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 400);
  }
  assert.equal(seen.length, 0);
});

test('session: expired upstream session unlinks; old TikShortis is outdated; 5xx is 424', async () => {
  handlers['/api/me'] = json(401, {});
  let r = await call('session', { headers: { Cookie: linked() } });
  assert.deepEqual(await r.json(), { ok: true, linked: false, expired: true });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);

  handlers['/api/me'] = json(404, {});
  r = await call('session', { headers: { Cookie: linked() } });
  assert.equal((await r.json()).outdated, true);

  handlers['/api/me'] = json(502, {});
  r = await call('session', { headers: { Cookie: linked() } });
  assert.equal(r.status, 424);

  r = await call('session');
  assert.deepEqual(await r.json(), { ok: true, linked: false });
  assert.equal(seen.length, 3, 'no upstream call without a linked session');
});
