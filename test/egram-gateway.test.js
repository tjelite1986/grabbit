'use strict';
// Unit tests for the Elitogram gateway (egram-gateway.js), run against a fake
// Elitogram in this process. Mounted the way server.js mounts it (body parsers
// first, then /api/egram), without Grabbit's auth gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const gw = require('../egram-gateway');

const SECRET = 'test-secret';

// --- Fake Elitogram ----------------------------------------------------------------
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
const file = (headers, body = 'JPEGDATA') => (req, res) => {
  res.writeHead(200, { 'content-type': 'image/jpeg', etag: '"e1"', ...headers });
  res.end(body);
};

let base;
let server;
let adultSet = new Set();
const warnings = [];
const quietLog = { warn: (m) => warnings.push(m), log() {}, error() {} };

test.before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upBase = `http://127.0.0.1:${upstream.address().port}`;
  const g = gw.createGateway({ apiUrl: upBase, secret: SECRET, isAdultHandle: (h) => { if (h === 'boom') throw new Error('lookup failed'); return adultSet.has(String(h).toLowerCase()); }, log: quietLog, timeoutMs: 5000 });
  const app = express();
  app.use(express.json());
  app.use('/api/egram', (req, res) => {
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

const linked = () => `${gw.EGRAM_COOKIE}=${gw.seal(SECRET, { t: 'tok123', exp: Date.now() + 60000 })}`;
const browser = { 'sec-fetch-site': 'same-origin' };
function call(method, path, { cookie = linked(), headers = {}, body } = {}) {
  const h = { ...browser, ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const last = () => seen[seen.length - 1];

// --- Pure parts ------------------------------------------------------------------

test('lane: only an exact lane=review is the review lane', () => {
  const lane = (url) => gw.laneOf({ originalUrl: url });
  assert.equal(lane('/api/egram/api/feed'), 'general');
  assert.equal(lane('/api/egram/api/feed?lane=review'), 'review');
  assert.equal(lane('/api/egram/api/feed?lane=general&lane=review'), 'general');
  assert.equal(lane('/api/egram/api/feed?lane=Review'), 'general');
  assert.equal(lane('/api/egram/api/feed?lane=adult'), 'general');
});

test('allowlist: no auth, 18+ unlock, admin, uploads or deletes of posts', () => {
  for (const [m, p] of [
    ['POST', 'api/auth/login'],
    ['POST', 'api/adult/unlock'],
    ['POST', 'api/me/pin'],
    ['GET', 'api/me'],
    ['GET', 'api/admin/jobs'],
    ['POST', 'api/posts'],
    ['DELETE', 'api/posts/1'],
    ['POST', 'api/creators-merge'],
    ['POST', 'api/creators-classify'],
    ['GET', 'm/s/1'],
    ['GET', 'api/users/thomas'],
  ]) {
    assert.equal(gw.matchRoute(m, p), null, `${m} ${p}`);
  }
  assert.ok(gw.matchRoute('GET', 'api/feed'));
  assert.ok(gw.matchRoute('HEAD', 'm/12'));
  assert.ok(gw.matchRoute('PATCH', 'api/posts/5'));
});

test('filter: posts, tiles and creators must carry the lane audience', () => {
  const answer = {
    items: [
      { id: 1, caption: 'a', author: { handle: 'ann' }, media: [], audience: 'general' },
      { id: 2, caption: 'b', author: { handle: 'bob' }, media: [], audience: 'unknown' },
      { id: 3, caption: 'c', author: { handle: 'cy', adult: true }, media: [], audience: 'general' },
      { id: 4, caption: 'd', author: { handle: 'dee' }, media: [] },
      { id: 5, media_id: 9, thumb: '/m/9/t', audience: 'general', author_handle: 'evil' },
      { id: 6, handle: 'fay', post_count: 2, audience: 'general' },
      { id: 7, handle: 'gus', post_count: 2, adult: true, audience: 'general' },
    ],
    next: null,
  };
  const { value, dropped } = gw.filterAnswer(answer, 'general', (h) => h === 'evil');
  assert.deepEqual(value.items.map((x) => x.id), [1, 6]);
  assert.equal(dropped, 5);
  assert.deepEqual(gw.filterAnswer(answer, 'unknown', null).value.items.map((x) => x.id), [2]);
  // A single post outside the lane is not an answer at all.
  assert.equal(gw.filterAnswer({ id: 2, caption: 'b', author: { handle: 'bob' }, media: [], audience: 'unknown' }, 'general', null).value, null);
  // Search hits must name the lane's audience, and are judged by handle too.
  const s = gw.filterAnswer({
    creators: [
      { id: 1, handle: 'ok', audience: 'general' },
      { id: 2, handle: 'evil', audience: 'general' },
      { id: 3, handle: 'bare' },
      { id: 4, handle: 'rev', audience: 'unknown' },
    ],
    tags: [{ tag: 'x', n: 1 }],
  }, 'general', (h) => h === 'evil');
  assert.deepEqual(s.value.creators.map((c) => c.handle), ['ok']);
  assert.equal(s.dropped, 3);
  assert.equal(s.value.tags.length, 1);
});

test('filter: a total counted upstream is withdrawn when anything was dropped', () => {
  const post = (id, handle) => ({ id, caption: '', author: { handle }, media: [], audience: 'general' });
  const kept = gw.filterAnswer({ tag: 'x', total: 2, items: [post(1, 'ann'), post(2, 'bob')] }, 'general', () => false);
  assert.equal(kept.value.total, 2);
  const cut = gw.filterAnswer({ tag: 'x', total: 2, items: [post(1, 'ann'), post(2, 'evil')] }, 'general', (h) => h === 'evil');
  assert.equal(cut.value.total, null);
  assert.equal(cut.value.items.length, 1);
});

test('filter: a failing 18+ lookup refuses the answer instead of passing it', async () => {
  handlers['/api/explore'] = json(200, { items: [{ id: 1, caption: '', author: { handle: 'boom' }, media: [], audience: 'general' }] });
  const r = await call('GET', '/api/egram/api/explore');
  assert.equal(r.status, 424);
});

test('media: audience and creator headers decide, and a missing one refuses', () => {
  const post = { media: true };
  const pic = { media: true, picture: 'creator' };
  const user = { media: true, picture: 'user' };
  const evil = (h) => h === 'evil';
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-creator': 'ann' }, 'general', null), true);
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general' }, 'general', null), false, 'no creator');
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'unknown' }, 'general', null), false);
  assert.equal(gw.mediaAllowed(post, {}, 'general', null), false);
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'adult' }, 'general', null), false);
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-creator': 'evil' }, 'general', evil), false);
  // A creator's picture must say so, name the lane and a creator not 18+ in Grabbit.
  const cp = { 'x-egram-picture': 'creator', 'x-egram-audience': 'general', 'x-egram-creator': 'ann' };
  assert.equal(gw.mediaAllowed(pic, cp, 'general', evil), true);
  assert.equal(gw.mediaAllowed(pic, {}, 'general', null), false, 'unlabelled');
  assert.equal(gw.mediaAllowed(pic, { ...cp, 'x-egram-picture': 'user' }, 'general', null), false);
  assert.equal(gw.mediaAllowed(pic, { ...cp, 'x-egram-audience': 'any' }, 'general', null), false);
  assert.equal(gw.mediaAllowed(pic, { ...cp, 'x-egram-audience': 'unknown' }, 'general', null), false);
  assert.equal(gw.mediaAllowed(pic, { ...cp, 'x-egram-creator': 'evil' }, 'general', evil), false);
  assert.equal(gw.mediaAllowed(pic, { 'x-egram-picture': 'creator', 'x-egram-audience': 'general' }, 'general', null), false, 'no creator');
  // An account's avatar must say it is one.
  assert.equal(gw.mediaAllowed(user, { 'x-egram-picture': 'user' }, 'general', null), true);
  assert.equal(gw.mediaAllowed(user, {}, 'general', null), false);
  assert.equal(gw.mediaAllowed(user, { 'x-egram-picture': 'creator' }, 'general', null), false);
  assert.equal(gw.allowedType('image/svg+xml', pic), true);
  assert.equal(gw.allowedType('image/svg+xml', post), false);
  assert.equal(gw.allowedType('text/html', post), false);
  assert.equal(gw.allowedType('text/html', {}), false);
});

test('sealed session: the TikShortis key cannot open it', () => {
  const tik = require('../tikshortis-gateway');
  const sealed = gw.seal(SECRET, { t: 'x' });
  assert.equal(gw.unseal(SECRET, sealed).t, 'x');
  assert.equal(tik.openSession(SECRET, sealed), null);
  assert.equal(gw.unseal('other', sealed), null);
});

// --- Through the gateway -----------------------------------------------------------

test('every request carries the scope; review only with lane=review', async () => {
  handlers['/api/feed'] = json(200, { items: [], next: null });
  await call('GET', '/api/egram/api/feed');
  assert.equal(last().headers['x-egram-audience'], 'general');
  assert.equal(last().headers.cookie, 'eg_session=tok123');
  await call('GET', '/api/egram/api/feed?lane=review');
  assert.equal(last().headers['x-egram-audience'], 'unknown');
});

test('the 18+ cookie and other browser cookies never pass', async () => {
  await call('GET', '/api/egram/api/feed', { cookie: `${linked()}; eg_adult=unlocked; eg_session=stolen` });
  assert.equal(last().headers.cookie, 'eg_session=tok123');
});

test('unlinked: 401 without a request upstream', async () => {
  const before = seen.length;
  const r = await call('GET', '/api/egram/api/feed', { cookie: '' });
  assert.equal(r.status, 401);
  assert.equal(seen.length, before);
});

test('cross-site and same-site requests are refused', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await call('POST', '/api/egram/api/posts/1/like', { headers: { 'sec-fetch-site': site } });
    assert.equal(r.status, 403, site);
  }
});

test('a write carries only the keys its route allows', async () => {
  handlers['PATCH /api/posts/5'] = json(200, { id: 5, out_of_scope: true, can_edit: true });
  const r = await call('PATCH', '/api/egram/api/posts/5', { body: { audience: 'general', caption: 'x', adult: false, author: { creator: 'z' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(last().body), { audience: 'general' });
});

test('answers are filtered against the lane and Grabbit 18+ profiles', async () => {
  adultSet = new Set(['secretly18']);
  handlers['/api/explore'] = json(200, {
    items: [
      { id: 1, media_id: 1, audience: 'general', author_handle: 'ann' },
      { id: 2, media_id: 2, audience: 'general', author_handle: 'Secretly18' },
      { id: 3, media_id: 3, audience: 'unknown', author_handle: 'cy' },
    ],
    next: null,
  });
  const d = await (await call('GET', '/api/egram/api/explore')).json();
  assert.deepEqual(d.items.map((x) => x.id), [1]);
  handlers['/api/posts/3'] = json(200, { id: 3, caption: '', author: { handle: 'cy' }, media: [], audience: 'unknown' });
  assert.equal((await call('GET', '/api/egram/api/posts/3')).status, 404);
  assert.equal((await call('GET', '/api/egram/api/posts/3?lane=review')).status, 200);
  adultSet = new Set();
});

test('media: refused without the right audience header, passed with it', async () => {
  handlers['/m/10'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'ann', 'content-disposition': 'attachment; filename="a.jpg"' });
  handlers['/m/11'] = file({ 'x-egram-audience': 'unknown', 'x-egram-creator': 'bob' });
  handlers['/m/12'] = file({});
  const ok = await call('GET', '/api/egram/m/10?download=1');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'JPEGDATA');
  assert.match(ok.headers.get('content-security-policy'), /sandbox/);
  assert.equal(ok.headers.get('content-disposition'), 'attachment; filename="a.jpg"');
  assert.equal(ok.headers.get('x-egram-audience'), null);
  assert.equal((await call('GET', '/api/egram/m/11')).status, 404);
  assert.equal((await call('GET', '/api/egram/m/11?lane=review')).status, 200);
  assert.equal((await call('GET', '/api/egram/m/12')).status, 404);
  adultSet = new Set(['ann']);
  assert.equal((await call('GET', '/api/egram/m/10')).status, 404);
  adultSet = new Set();
});

test('media: a HEAD or 304 is judged by its headers too', async () => {
  handlers['/m/13'] = (req, res) => {
    res.writeHead(304, { 'x-egram-audience': 'unknown', etag: '"e1"' });
    res.end();
  };
  assert.equal((await call('GET', '/api/egram/m/13', { headers: { 'if-none-match': '"e1"' } })).status, 404);
  handlers['/m/14'] = file({ 'x-egram-audience': 'unknown' });
  assert.equal((await call('HEAD', '/api/egram/m/14')).status, 404);
});

test('a generated SVG avatar passes; SVG or HTML for a post file does not', async () => {
  handlers['/m/ca/1'] = (req, res) => { res.writeHead(200, { 'content-type': 'image/svg+xml', 'x-egram-picture': 'creator', 'x-egram-audience': 'general', 'x-egram-creator': 'ann' }); res.end('<svg id="up"/>'); };
  handlers['/m/15'] = (req, res) => { res.writeHead(200, { 'content-type': 'image/svg+xml', 'x-egram-audience': 'general', 'x-egram-creator': 'ann' }); res.end('<svg/>'); };
  handlers['/m/16'] = (req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'x-egram-audience': 'general', 'x-egram-creator': 'ann' }); res.end('<b>'); };
  const ok = await call('GET', '/api/egram/m/ca/1');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '<svg id="up"/>');
  assert.equal((await call('GET', '/api/egram/m/15')).status, 424);
  assert.equal((await call('GET', '/api/egram/m/16')).status, 424);
});

test('pictures that do not say whose they are become Grabbit\'s neutral picture', async () => {
  handlers['/m/ca/2'] = (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg', etag: '"p2"' }); res.end('UPSTREAM'); };
  handlers['/m/cb/3'] = (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg', 'x-egram-picture': 'creator', 'x-egram-audience': 'general', 'x-egram-creator': 'evil' }); res.end('UPSTREAM'); };
  handlers['/m/ca/4'] = (req, res) => { res.writeHead(304, { 'x-egram-picture': 'creator', 'x-egram-audience': 'unknown', 'x-egram-creator': 'ann', etag: '"p4"' }); res.end(); };
  handlers['/m/ua/5'] = (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end('UPSTREAM'); };
  adultSet = new Set(['evil']);
  for (const p of ['/api/egram/m/ca/2', '/api/egram/m/cb/3', '/api/egram/m/ua/5']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml', p);
    assert.equal(r.headers.get('etag'), null, p);
    assert.equal(await r.text(), gw.NEUTRAL_PICTURE, p);
  }
  const cached = await call('GET', '/api/egram/m/ca/4', { headers: { 'if-none-match': '"p4"' } });
  assert.equal(cached.status, 200, 'a 304 for a picture outside the lane is not confirmed');
  assert.equal(await cached.text(), gw.NEUTRAL_PICTURE);
  const head = await call('HEAD', '/api/egram/m/ca/2');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/svg+xml');
  adultSet = new Set();
});

test('post media without a creator is refused, partial content too', async () => {
  handlers['/m/17'] = (req, res) => { res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10', 'x-egram-audience': 'general' }); res.end('DATA'); };
  assert.equal((await call('GET', '/api/egram/m/17', { headers: { range: 'bytes=0-3' } })).status, 404);
  handlers['/m/18'] = (req, res) => { res.writeHead(304, { 'x-egram-audience': 'general', etag: '"e18"' }); res.end(); };
  assert.equal((await call('GET', '/api/egram/m/18', { headers: { 'if-none-match': '"e18"' } })).status, 404);
});

test('cookie: __Host- over HTTPS, the plain name over HTTP, and a duplicate counts as none', async () => {
  const sealed = gw.seal(SECRET, { t: 'tok123', exp: Date.now() + 60000 });
  // Over HTTPS (behind the proxy) only the __Host- cookie is read.
  const https = { 'x-forwarded-proto': 'https' };
  assert.equal((await call('GET', '/api/egram/api/feed', { headers: https })).status, 401, 'plain cookie ignored over https');
  assert.equal((await call('GET', '/api/egram/api/feed', { headers: https, cookie: `${gw.EGRAM_COOKIE_SECURE}=${sealed}` })).status, 200);
  // Two cookies of the same name: one could be planted for a parent domain.
  assert.equal((await call('GET', '/api/egram/api/feed', { cookie: `${gw.EGRAM_COOKIE}=${sealed}; ${gw.EGRAM_COOKIE}=${sealed}` })).status, 401);
  assert.equal(gw.readCookie({ headers: { cookie: 'a=1; b=2' } }, 'a'), '1');
  assert.equal(gw.readCookie({ headers: { cookie: 'a=1; a=2' } }, 'a'), null);
  // Linking over HTTPS sets the __Host- cookie for the whole site.
  handlers['POST /api/auth/login'] = (req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'eg_session=up9; Path=/' }); res.end('{}'); };
  const r = await call('POST', '/api/egram/session', { cookie: null, headers: https, body: { username: 'cc', password: 'pw' } });
  assert.equal(r.status, 200);
  const c = r.headers.get('set-cookie');
  assert.match(c, /^__Host-grabbit_egram=/);
  assert.match(c, /Path=\/;/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(c, /Domain=/i);
  delete handlers['POST /api/auth/login'];
});

test('an upstream 5xx becomes 424; an expired session unlinks', async () => {
  handlers['/api/liked'] = json(500, { error: 'boom' });
  assert.equal((await call('GET', '/api/egram/api/liked')).status, 424);
  handlers['/api/favorites'] = json(401, { error: 'Sign in' });
  const r = await call('GET', '/api/egram/api/favorites');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('set-cookie'), /grabbit_egram=;.*Max-Age=0/);
});

test('session: link with user name and password, keep only the sealed token', async () => {
  handlers['POST /api/auth/login'] = (req, res, rec) => {
    const b = JSON.parse(rec.body);
    if (b.username === 'cc' && b.password === 'pw') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'eg_session=newtok; Path=/; HttpOnly' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Wrong user name or password' }));
  };
  const bad = await call('POST', '/api/egram/session', { cookie: '', body: { username: 'cc', password: 'no' } });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/egram/session', { cookie: '', body: { username: 'cc', password: 'pw' } });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie');
  assert.match(set, /^grabbit_egram=[^;]+; Path=\/api\/egram; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(set, /newtok/);
  const sealed = set.split(';')[0].split('=')[1];
  assert.equal(gw.unseal(SECRET, sealed).t, 'newtok');

  handlers['GET /api/me'] = json(200, { user: { username: 'cc', display_name: 'CC', role: 'admin', permissions: ['profiles'], adult_unlocked: true } });
  const me = await (await call('GET', '/api/egram/session')).json();
  assert.deepEqual(me.user, { username: 'cc', display_name: 'CC', role: 'admin', can_classify: true });
  assert.equal(last().headers['x-egram-audience'], 'general');

  handlers['GET /api/me'] = json(200, { user: null });
  const gone = await call('GET', '/api/egram/session');
  assert.deepEqual(await gone.json(), { ok: true, linked: false, expired: true });
  assert.match(gone.headers.get('set-cookie'), /Max-Age=0/);
});
