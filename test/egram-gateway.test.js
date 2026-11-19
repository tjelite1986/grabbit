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
// handle -> other names Elitogram knows it by (served at /api/creator-identities).
// Any other handle is answered as a creator without other names, unless it is
// in `hidden` (Elitogram leaves it out: outside the scope) or `accountNames`
// (listed under `accounts`).
const identities = {};
const hidden = new Set();
const accountNames = new Set();
// Names that are both an account and a (visible) creator.
const creatorNames = new Set();
let upBase;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    seen.push(rec);
    const path = req.url.split('?')[0];
    if (path === '/api/creator-identities' && !handlers[path]) {
      // Default: the other names each asked handle is known by (identities).
      const q = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
      const items = {};
      const accounts = [];
      // `h` asks for creators, `a` for accounts (separate namespaces).
      for (const h of q.getAll('h')) {
        if (hidden.has(h) || (accountNames.has(h) && !creatorNames.has(h))) continue;
        items[h] = identities[h] || [];
      }
      for (const a of q.getAll('a')) if (accountNames.has(a)) accounts.push(a);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ items, accounts }));
    }
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
  const g = gw.createGateway({ apiUrl: upBase, secret: SECRET, isAdultHandle: (h) => { if (h === 'boom') throw new Error('lookup failed'); return adultSet.has(String(h).toLowerCase()); }, bindingOf: (req) => req.headers['x-test-signin'] || '', log: quietLog, timeoutMs: 5000, identityDeadlineMs: 1500, uploadMaxBytes: 64 * 1024 });
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
// Another Elitogram session.
const linkedAs = (t) => `${gw.EGRAM_COOKIE}=${gw.seal(SECRET, { t, exp: Date.now() + 60000 })}`;
const browser = { 'sec-fetch-site': 'same-origin' };
function call(method, path, { cookie = linked(), headers = {}, body } = {}) {
  const h = { ...browser, ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
// The last request the gateway forwarded, not counting identity lookups.
const last = () => seen.filter((x) => !x.url.startsWith('/api/creator-identities')).pop();

// --- Pure parts ------------------------------------------------------------------

test('lane: only an exact lane=review is the review lane', () => {
  const lane = (url) => gw.laneOf({ originalUrl: url });
  assert.equal(lane('/api/egram/api/feed'), 'general');
  assert.equal(lane('/api/egram/api/feed?lane=review'), 'review');
  assert.equal(lane('/api/egram/api/feed?lane=general&lane=review'), 'general');
  assert.equal(lane('/api/egram/api/feed?lane=Review'), 'general');
  assert.equal(lane('/api/egram/api/feed?lane=adult'), 'general');
});

test('allowlist: no auth, 18+ unlock, admin, merges, stories or push', () => {
  for (const [m, p] of [
    ['POST', 'api/auth/login'],
    ['POST', 'api/adult/unlock'],
    ['POST', 'api/adult/lock'],
    ['POST', 'api/me/pin'],
    ['POST', 'api/me/avatar'],
    ['GET', 'api/me'],
    ['GET', 'api/admin/jobs'],
    ['POST', 'api/push/subscribe'],
    ['GET', 'api/stories'],
    ['DELETE', 'api/comments/1'],
    ['POST', 'api/posts/1/media'],
    ['POST', 'api/posts/1/restore'],
    ['PATCH', 'api/creators/ann'],
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
  assert.ok(gw.matchRoute('POST', 'api/posts').upload);
  assert.equal(gw.matchRoute('DELETE', 'api/posts/5').parent, 'path');
  assert.equal(gw.matchRoute('DELETE', 'api/posts/5/comments/9').parent, 'path');
  assert.deepEqual(gw.matchRoute('PATCH', 'api/me').body, ['display_name', 'bio']);
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
  // A post an account wrote itself names that account instead of a creator.
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'unknown', 'x-egram-account': 'cc_test' }, 'unknown', null), true);
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-account': 'Bob' }, 'general', null), true, 'account names are compared lowercased');
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-account': 'evil' }, 'general', evil), false, 'an account named like an 18+ profile');
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-account': 'a,b' }, 'general', null), false);
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-creator': 'ann', 'x-egram-account': 'bob' }, 'general', null), false, 'both named');
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-account': 'bob' }, 'general', null, ['X-Egram-Audience', 'general', 'X-Egram-Account', 'bob', 'X-Egram-Account', 'ann']), false, 'account named twice');
  assert.equal(gw.mediaAllowed(post, { 'x-egram-audience': 'general', 'x-egram-account': 'bob' }, 'general', null, ['X-Egram-Audience', 'general', 'X-Egram-Account', 'bob']), true);
  // Never for a creator's picture.
  assert.equal(gw.mediaAllowed(pic, { 'x-egram-picture': 'creator', 'x-egram-audience': 'general', 'x-egram-account': 'bob' }, 'general', null), false);
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
  assert.equal(gw.mediaAllowed(user, { 'x-egram-picture': 'user', 'content-type': 'image/svg+xml' }, 'general', null), true);
  // An uploaded account picture says nothing about its audience: replaced.
  assert.equal(gw.mediaAllowed(user, { 'x-egram-picture': 'user', 'content-type': 'image/jpeg' }, 'general', null), false);
  assert.equal(gw.mediaAllowed(user, { 'x-egram-picture': 'user' }, 'general', null), false);
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
  handlers['/api/posts/5'] = json(200, { id: 5, caption: '', author: { handle: 'ann' }, media: [], audience: 'general' });
  handlers['PATCH /api/posts/5'] = json(200, { id: 5, out_of_scope: true, can_edit: true });
  const r = await call('PATCH', '/api/egram/api/posts/5', { body: { audience: 'general', caption: 'x', adult: false, author: { creator: 'z' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(last().body), { audience: 'general', caption: 'x' });
  assert.equal((await call('PATCH', '/api/egram/api/posts/5', { body: { audience: 'everyone' } })).status, 400);
});

test('reads below a post and writes to it need the post itself to pass', async () => {
  adultSet = new Set(['secretly18']);
  // Elitogram calls post 6 general, but Grabbit has its author as 18+.
  handlers['/api/posts/6'] = json(200, { id: 6, caption: '', author: { handle: 'secretly18' }, media: [], audience: 'general' });
  handlers['/api/posts/6/comments'] = json(200, { items: [{ id: 1, body: 'hi', user: { username: 'u' } }] });
  handlers['POST /api/posts/6/like'] = json(200, { liked: true });
  const before = seen.length;
  assert.equal((await call('GET', '/api/egram/api/posts/6/comments')).status, 404);
  assert.equal((await call('POST', '/api/egram/api/posts/6/like')).status, 404);
  // Only the parent lookups reached Elitogram, never the comment read or the like.
  assert.ok(seen.slice(before).every((q) => q.method === 'GET' && (q.url === '/api/posts/6' || q.url.startsWith('/api/creator-identities'))));
  // A post without an owner cannot be judged either.
  handlers['/api/posts/7'] = json(200, { id: 7, caption: '', media: [], audience: 'general' });
  assert.equal((await call('POST', '/api/egram/api/collections/1/items', { body: { post_id: 7 } })).status, 404);
  assert.equal((await call('POST', '/api/egram/api/collections/1/items', { body: { post_id: 'x' } })).status, 400);
  // Removing a saved post from a collection is judged on the post (the second id), not the collection.
  handlers['DELETE /api/collections/1/items/6'] = json(200, { ok: true });
  const del = seen.length;
  assert.equal((await call('DELETE', '/api/egram/api/collections/1/items/6')).status, 404);
  assert.ok(seen.slice(del).every((q) => q.method === 'GET' && (q.url === '/api/posts/6' || q.url.startsWith('/api/creator-identities'))));
  adultSet = new Set();
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

test('a post keeps only the mentions that are not 18+ in Grabbit', async () => {
  adultSet = new Set(['secretly18', 'alias18']);
  // u-sam is known to Elitogram as alias18 too; u-gone is outside the scope.
  identities['u-sam'] = ['alias18'];
  hidden.add('u-gone');
  const mentions = [
    { type: 'creator', handle: 'ann', name: 'ann' },
    { type: 'creator', handle: 'Secretly18', name: 'Secretly18' },
    { type: 'creator', handle: 'u-sam', name: '_sam' },
    { type: 'creator', handle: 'u-gone', name: '_gone' },
  ];
  const post = (id) => ({ id, caption: '@ann @Secretly18 @_sam @_gone', author: { handle: 'bob', type: 'creator' }, media: [], audience: 'general', mentions });
  handlers['/api/feed'] = json(200, { items: [post(1)], next: null });
  const d = await (await call('GET', '/api/egram/api/feed')).json();
  assert.deepEqual(d.items.map((x) => x.id), [1], 'the post itself stays');
  assert.deepEqual(d.items[0].mentions.map((m) => m.handle), ['ann']);
  // The same holds for a single post and for a creator's "Mentioned in" list.
  handlers['/api/posts/1'] = json(200, post(1));
  assert.deepEqual((await (await call('GET', '/api/egram/api/posts/1')).json()).mentions.map((m) => m.handle), ['ann']);
  handlers['/api/creators/ann/mentioned'] = json(200, { items: [post(1), { ...post(2), author: { handle: 'secretly18', type: 'creator' } }], next: null });
  const m = await (await call('GET', '/api/egram/api/creators/ann/mentioned')).json();
  assert.deepEqual(m.items.map((x) => x.id), [1]);
  assert.deepEqual(m.items[0].mentions.map((x) => x.handle), ['ann']);
  delete identities['u-sam'];
  hidden.delete('u-gone');
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
  assert.deepEqual(me.user, { username: 'cc', display_name: 'CC', bio: '', role: 'admin', can_classify: true });
  assert.equal(last().headers['x-egram-audience'], 'general');

  handlers['GET /api/me'] = json(200, { user: null });
  const gone = await call('GET', '/api/egram/session');
  assert.deepEqual(await gone.json(), { ok: true, linked: false, expired: true });
  assert.match(gone.headers.get('set-cookie'), /Max-Age=0/);
});

test('a link counts only alongside the Grabbit sign-in it was made under', async () => {
  handlers['/api/feed'] = json(200, { items: [], next: null });
  assert.equal((await call('GET', '/api/egram/api/feed')).status, 200);
  // The same sealed link under another sign-in (e.g. planted from a sibling domain).
  assert.equal((await call('GET', '/api/egram/api/feed', { headers: { 'x-test-signin': 'someone-else' } })).status, 401);
  const bound = `${gw.EGRAM_COOKIE}=${gw.seal(SECRET, { t: 'tok123', exp: Date.now() + 60000, b: 'me' })}`;
  assert.equal((await call('GET', '/api/egram/api/feed', { cookie: bound, headers: { 'x-test-signin': 'me' } })).status, 200);
  assert.equal((await call('GET', '/api/egram/api/feed', { cookie: bound })).status, 401);
});

// --- Other identities (brief item 6) -------------------------------------------------

test('a creator 18+ in Grabbit under another identity is dropped from answers and media', async () => {
  // Elitogram knows "zed" also as the Instagram account "zed.ig" and the alias "zedalias".
  identities.zed = ['zed.ig', 'zedalias'];
  identities.yan = [];
  handlers['/api/feed'] = json(200, { items: [
    { id: 1, audience: 'general', author: { handle: 'zed' }, caption: 'a', media: [] },
    { id: 2, audience: 'general', author: { handle: 'yan' }, caption: 'b', media: [] },
  ], next: null });
  handlers['/m/40'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'zed' });
  handlers['/m/40/t'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'zed' });
  handlers['/m/ca/40'] = (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg', 'x-egram-picture': 'creator', 'x-egram-audience': 'general', 'x-egram-creator': 'zed' }); res.end('AVATAR'); };
  // Grabbit has the Instagram account classified 18+, not the Elitogram handle.
  adultSet = new Set(['zed.ig']);
  try {
    const d = await (await call('GET', '/api/egram/api/feed')).json();
    assert.deepEqual(d.items.map((p) => p.id), [2]);
    assert.equal((await call('GET', '/api/egram/m/40')).status, 404);
    assert.equal((await call('GET', '/api/egram/m/40/t')).status, 404);
    const av = await call('GET', '/api/egram/m/ca/40');
    assert.equal(await av.text(), gw.NEUTRAL_PICTURE);
    // The same through an alias, and in the review lane too.
    adultSet = new Set(['zedalias']);
    handlers['/api/explore'] = json(200, { items: [{ id: 3, media_id: 9, audience: 'unknown', author_handle: 'zed' }], next: null });
    const rv = await (await call('GET', '/api/egram/api/explore?lane=review')).json();
    assert.deepEqual(rv.items, []);
    // Writes below such a post are refused by the parent check.
    handlers['/api/posts/1'] = json(200, { id: 1, audience: 'general', author: { handle: 'zed' }, caption: 'a', media: [] });
    assert.equal((await call('POST', '/api/egram/api/posts/1/comments', { body: { body: 'hi' } })).status, 404);
  } finally {
    adultSet = new Set();
    delete handlers['/api/explore'];
  }
});

test('a failing identity lookup refuses the answer and the file', async () => {
  identities.quo = [];
  handlers['/api/creator-identities'] = json(500, { error: 'down' });
  handlers['/api/feed'] = json(200, { items: [{ id: 5, audience: 'general', author: { handle: 'quo' }, caption: 'c', media: [] }], next: null });
  handlers['/m/41'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'quo' });
  adultSet = new Set(['someone-else']);
  try {
    assert.equal((await call('GET', '/api/egram/api/feed')).status, 424);
    assert.equal((await call('GET', '/api/egram/m/41')).status, 404);
  } finally {
    delete handlers['/api/creator-identities'];
    adultSet = new Set();
  }
});

test('media naming two creators, or a joined handle, is refused', async () => {
  handlers['/m/42'] = (req, res) => {
    // Two X-Egram-Creator headers: Node would join them as "adultone, other".
    res.writeHead(200, [['content-type', 'image/jpeg'], ['x-egram-audience', 'general'], ['x-egram-creator', 'adultone'], ['x-egram-creator', 'other']]);
    res.end('JPEGDATA');
  };
  handlers['/m/43'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'adultone, other' });
  adultSet = new Set(['adultone']);
  try {
    assert.equal((await call('GET', '/api/egram/m/42')).status, 404);
    assert.equal((await call('GET', '/api/egram/m/42', { headers: { range: 'bytes=0-3' } })).status, 404);
    assert.equal((await call('GET', '/api/egram/m/43')).status, 404);
  } finally {
    adultSet = new Set();
  }
  assert.equal(gw.singleHeader(['X-Egram-Creator', 'a', 'x-egram-creator', 'b'], 'x-egram-creator'), null);
  assert.equal(gw.singleHeader(['X-Egram-Creator', 'a'], 'x-egram-creator'), 'a');
  assert.equal(gw.mediaCreator({}, ['x-egram-creator', 'a b']), null);
});

test('search hits without a handle are dropped', () => {
  const { value, dropped } = gw.filterAnswer({ creators: [{ audience: 'general' }, { audience: 'general', handle: 'ok' }] }, 'general', () => false);
  assert.deepEqual(value.creators.map((c) => c.handle), ['ok']);
  assert.equal(dropped, 1);
});

test('notifications about a creator or a post author 18+ in Grabbit are dropped', async () => {
  handlers['/api/notifications'] = json(200, { items: [
    { id: 1, kind: 'like', text: 'a', post_id: 5, creator_id: null, creator_handle: null, post_author_handle: 'nadult' },
    { id: 2, kind: 'follow', text: 'b', post_id: null, creator_id: 3, creator_handle: 'nadult2', post_author_handle: null },
    { id: 3, kind: 'comment', text: 'c', post_id: 6, creator_id: null, creator_handle: null, post_author_handle: 'fine' },
  ] });
  adultSet = new Set(['nadult', 'nadult2']);
  try {
    const d = await (await call('GET', '/api/egram/api/notifications')).json();
    assert.deepEqual(d.items.map((n) => n.id), [3]);
  } finally {
    adultSet = new Set();
  }
});

test('upload: multipart streams upstream; the answer is only the id and refused files', async () => {
  let got = null;
  handlers['POST /api/posts'] = (req, res, rec) => {
    got = rec;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 77, rejected: [{ name: 'x.txt', reason: 'not media' }], audience: 'adult', secret: 'no' }));
  };
  const fd = new FormData();
  fd.append('caption', 'hello #tag');
  fd.append('audience', 'unknown');
  fd.append('files', new Blob([Buffer.from('JPEGBYTES')], { type: 'image/jpeg' }), 'a.jpg');
  const r = await fetch(`${base}/api/egram/api/posts`, { method: 'POST', headers: { ...browser, cookie: linked() }, body: fd });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { ok: true, id: 77, rejected: [{ name: 'x.txt', reason: 'not media' }] });
  assert.match(got.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(got.body.includes('JPEGBYTES') && got.body.includes('hello #tag'));
  assert.equal(got.headers['x-egram-audience'], 'general');
  assert.equal(got.headers.cookie, 'eg_session=tok123');
  // Not multipart: refused before anything goes upstream.
  const before = seen.length;
  assert.equal((await call('POST', '/api/egram/api/posts', { body: { caption: 'x' } })).status, 400);
  assert.equal(seen.length, before);
  // Elitogram refusing (a general creator for a non-moderator, say) passes its message.
  handlers['POST /api/posts'] = json(403, { error: 'Only a moderator can classify posts' });
  const fd2 = new FormData();
  fd2.append('files', new Blob([Buffer.from('J')], { type: 'image/jpeg' }), 'b.jpg');
  const no = await fetch(`${base}/api/egram/api/posts`, { method: 'POST', headers: { ...browser, cookie: linked() }, body: fd2 });
  assert.equal(no.status, 403);
  assert.equal((await no.json()).error, 'Only a moderator can classify posts');
  // Cross-site: refused.
  const cross = await fetch(`${base}/api/egram/api/posts`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', cookie: linked() }, body: fd2 });
  assert.equal(cross.status, 403);
});

// --- Final review (Codex, phase 2 final) ----------------------------------------------

test('a creator Elitogram does not answer for in the identity lookup is refused', async () => {
  // A post held in review under a creator classified general: Elitogram once
  // left that creator out of the unknown-scope lookup, and an omitted handle
  // counted as "no other names".
  hidden.add('heldcreator');
  handlers['/api/explore'] = json(200, { items: [
    { id: 30, media_id: 31, audience: 'unknown', author_handle: 'heldcreator' },
    { id: 32, media_id: 33, audience: 'unknown', author_handle: 'other' },
  ], next: null });
  handlers['/m/31'] = file({ 'x-egram-audience': 'unknown', 'x-egram-creator': 'heldcreator' });
  handlers['/m/ca/31'] = (req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg', 'x-egram-picture': 'creator', 'x-egram-audience': 'unknown', 'x-egram-creator': 'heldcreator' }); res.end('AVATAR'); };
  adultSet = new Set(['someone-else']);
  try {
    const d = await (await call('GET', '/api/egram/api/explore?lane=review')).json();
    assert.deepEqual(d.items.map((x) => x.id), [32]);
    assert.equal((await call('GET', '/api/egram/m/31?lane=review')).status, 404);
    assert.equal(await (await call('GET', '/api/egram/m/ca/31?lane=review')).text(), gw.NEUTRAL_PICTURE);
    // Answered later (Elitogram fixed), it passes: an unresolved handle is not cached.
    hidden.delete('heldcreator');
    const again = await (await call('GET', '/api/egram/api/explore?lane=review')).json();
    assert.deepEqual(again.items.map((x) => x.id), [30, 32]);
  } finally {
    hidden.delete('heldcreator');
    adultSet = new Set();
    delete handlers['/api/explore'];
  }
});

test('an account listed under accounts passes; the same name unlisted does not', async () => {
  handlers['/api/feed'] = json(200, { items: [{ id: 34, audience: 'general', author: { handle: 'someuser' }, caption: 'mine', media: [] }], next: null });
  handlers['/m/35'] = file({ 'x-egram-audience': 'general', 'x-egram-account': 'someuser' });
  adultSet = new Set(['someone-else']);
  try {
    accountNames.add('someuser');
    assert.deepEqual((await (await call('GET', '/api/egram/api/feed')).json()).items.map((x) => x.id), [34]);
    assert.equal((await call('GET', '/api/egram/m/35')).status, 200);
    // An Elitogram that does not list accounts (or no longer knows the name).
    accountNames.delete('someuser');
    hidden.add('someuser');
    await new Promise((r) => setTimeout(r, 0));
    const fresh = linkedAs('tok-other');
    assert.deepEqual((await (await call('GET', '/api/egram/api/feed', { cookie: fresh })).json()).items, []);
    assert.equal((await call('GET', '/api/egram/m/35', { cookie: fresh })).status, 404);
  } finally {
    accountNames.delete('someuser');
    hidden.delete('someuser');
    adultSet = new Set();
  }
});

test('an identity lookup that never answers is given up at its deadline', async () => {
  const stalled = [];
  handlers['/api/creator-identities'] = (req, res) => { stalled.push(res); };
  handlers['/m/36'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'slowone' });
  adultSet = new Set(['someone-else']);
  try {
    const t0 = Date.now();
    const r = await call('GET', '/api/egram/m/36', { cookie: linkedAs('tok-slow') });
    assert.equal(r.status, 404);
    const took = Date.now() - t0;
    assert.ok(took >= 1400 && took < 4500, `took ${took} ms`);
  } finally {
    delete handlers['/api/creator-identities'];
    for (const x of stalled) x.destroy();
    adultSet = new Set();
  }
});

test('identity lookups do not wait for sockets held by media answers', async () => {
  // 40 media answers that send headers and then hold their bodies: with one
  // shared pool of 32 sockets the identity lookups would queue behind them.
  // Each by its own creator, so no lookup is answered from the cache.
  const held = [];
  for (let i = 0; i < 40; i++) {
    handlers[`/m/${100 + i}`] = (req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'x-egram-audience': 'general', 'x-egram-creator': `pool${i}` });
      res.write('JPEG');
      held.push(res);
    };
  }
  adultSet = new Set(['someone-else']);
  const cookie = linkedAs('tok-pool');
  const ctrl = new AbortController();
  try {
    const t0 = Date.now();
    const pending = Array.from({ length: 40 }, (_, i) => fetch(`${base}/api/egram/m/${100 + i}`, { headers: { ...browser, cookie }, signal: ctrl.signal }).then((r) => r.status, () => 'aborted'));
    // Each one reaches the identity check; the statuses arrive once checked.
    const statuses = await Promise.race([
      Promise.all(pending.slice(0, 32)),
      new Promise((r) => setTimeout(() => r('timeout'), 4000)),
    ]);
    assert.notEqual(statuses, 'timeout', 'identity checks stalled behind held media bodies');
    assert.ok(statuses.every((s) => s === 200));
    assert.ok(Date.now() - t0 < 4000);
  } finally {
    ctrl.abort();
    for (const x of held) x.destroy();
    for (let i = 0; i < 40; i++) delete handlers[`/m/${100 + i}`];
    adultSet = new Set();
  }
});

test('upload: over the total limit is refused, declared or chunked, and the upstream request is cut', async () => {
  let reached = 0;
  handlers['POST /api/posts'] = (req, res) => { reached++; res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 1, rejected: [] })); };
  const big = Buffer.alloc(80 * 1024, 1);
  const fd = new FormData();
  fd.append('files', new Blob([big], { type: 'image/jpeg' }), 'big.jpg');
  const declared = await fetch(`${base}/api/egram/api/posts`, { method: 'POST', headers: { ...browser, cookie: linked() }, body: fd });
  assert.equal(declared.status, 413);
  // Chunked: no Content-Length, the limit is counted as the body streams.
  const boundary = 'xBOUNDARYx';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="c.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const chunks = [head, big.subarray(0, 40 * 1024), big.subarray(40 * 1024), tail];
  const body = new ReadableStream({ pull(c) { const x = chunks.shift(); if (x) c.enqueue(x); else c.close(); } });
  const chunked = await fetch(`${base}/api/egram/api/posts`, {
    method: 'POST', duplex: 'half', body,
    headers: { ...browser, cookie: linked(), 'content-type': `multipart/form-data; boundary=${boundary}` },
  }).catch((e) => ({ status: `error ${e.message}` }));
  assert.equal(chunked.status, 413);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(reached, 0);
});

test('an account and a creator sharing a handle are checked each as itself', async () => {
  // Account `sam` wrote a post; a creator `sam` exists too, hidden from this
  // scope (or 18+ in Elitogram). The account's post and file pass; anything
  // naming the creator `sam` is refused.
  accountNames.add('sam');
  hidden.add('sam');
  handlers['/api/feed'] = json(200, { items: [
    { id: 50, audience: 'general', author: { type: 'user', handle: 'sam' }, caption: 'mine', media: [] },
    { id: 51, audience: 'general', author: { type: 'creator', handle: 'sam' }, caption: 'theirs', media: [] },
  ], next: null });
  handlers['/m/52'] = file({ 'x-egram-audience': 'general', 'x-egram-account': 'sam' });
  handlers['/m/53'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'sam' });
  adultSet = new Set(['someone-else']);
  try {
    assert.deepEqual((await (await call('GET', '/api/egram/api/feed')).json()).items.map((x) => x.id), [50]);
    assert.equal((await call('GET', '/api/egram/m/52')).status, 200);
    assert.equal((await call('GET', '/api/egram/m/53')).status, 404);
    const looks = seen.filter((x) => x.url.startsWith('/api/creator-identities')).slice(-2).map((q) => new URLSearchParams(q.url.slice(q.url.indexOf('?') + 1)));
    assert.deepEqual([looks[0].getAll('a'), looks[0].getAll('h')], [['sam'], []], 'the account file asks for an account only');
    assert.deepEqual([looks[1].getAll('a'), looks[1].getAll('h')], [[], ['sam']], 'the creator file asks for a creator only');
    // Now the creator is visible, general and linked to an 18+ profile; the
    // account's post still passes, the creator's does not.
    hidden.delete('sam');
    creatorNames.add('sam');
    identities.sam = ['adultalias'];
    adultSet = new Set(['adultalias']);
    assert.deepEqual((await (await call('GET', '/api/egram/api/feed')).json()).items.map((x) => x.id), [50]);
    assert.equal((await call('GET', '/api/egram/m/52')).status, 200);
    assert.equal((await call('GET', '/api/egram/m/53')).status, 404);
  } finally {
    accountNames.delete('sam');
    creatorNames.delete('sam');
    hidden.delete('sam');
    delete identities.sam;
    adultSet = new Set();
    delete handlers['/api/feed'];
  }
});

test('photos and notifications carry the author type; an untyped handle needs a resolved, clean identity', async () => {
  accountNames.add('pat');
  hidden.add('pat');
  handlers['/api/photos'] = json(200, { items: [
    { media_id: 60, post_id: 61, audience: 'general', author_handle: 'pat', author_type: 'user' },
    { media_id: 62, post_id: 63, audience: 'general', author_handle: 'pat', author_type: 'creator' },
    { media_id: 64, post_id: 65, audience: 'general', author_handle: 'pat' },
    { media_id: 66, post_id: 67, audience: 'general', author_handle: 'nobody' },
  ], next: null });
  handlers['/api/notifications'] = json(200, { items: [
    { id: 1, kind: 'like', text: 'a', post_id: 61, creator_handle: null, post_author_handle: 'pat', post_author_type: 'user' },
    { id: 2, kind: 'like', text: 'b', post_id: 63, creator_handle: null, post_author_handle: 'pat', post_author_type: 'creator' },
  ] });
  adultSet = new Set(['someone-else']);
  hidden.add('nobody');
  try {
    // Untyped `pat` resolves as an account only: passes. `nobody` resolves as neither: refused.
    assert.deepEqual((await (await call('GET', '/api/egram/api/photos')).json()).items.map((x) => x.media_id), [60, 64]);
    assert.deepEqual((await (await call('GET', '/api/egram/api/notifications')).json()).items.map((x) => x.id), [1]);
  } finally {
    accountNames.delete('pat');
    hidden.delete('pat');
    hidden.delete('nobody');
    adultSet = new Set();
    delete handlers['/api/photos'];
    delete handlers['/api/notifications'];
  }
});

test('identities are asked afresh for every answer: a new 18+ alias applies at once', async () => {
  handlers['/api/feed'] = json(200, { items: [{ id: 70, audience: 'general', author: { type: 'creator', handle: 'fresh' }, caption: 'c', media: [] }], next: null });
  handlers['/m/71'] = file({ 'x-egram-audience': 'general', 'x-egram-creator': 'fresh' });
  adultSet = new Set(['fresh18']);
  try {
    assert.deepEqual((await (await call('GET', '/api/egram/api/feed')).json()).items.map((x) => x.id), [70]);
    assert.equal((await call('GET', '/api/egram/m/71')).status, 200);
    identities.fresh = ['fresh18'];
    assert.deepEqual((await (await call('GET', '/api/egram/api/feed')).json()).items, []);
    assert.equal((await call('GET', '/api/egram/m/71')).status, 404);
  } finally {
    delete identities.fresh;
    adultSet = new Set();
    delete handlers['/api/feed'];
  }
});

test('notifications/read forwards only the ids the module showed', async () => {
  handlers['POST /api/notifications/read'] = json(200, { ok: true });
  handlers['/api/notifications'] = json(200, { items: [
    { id: 3, kind: 'like', text: 'a', post_id: null, creator_handle: null, post_author_handle: null },
    { id: 4, kind: 'like', text: 'b', post_id: null, creator_handle: null, post_author_handle: null },
    { id: 5, kind: 'like', text: 'c', post_id: 9, creator_handle: null, post_author_handle: 'hid18', post_author_type: 'user' },
  ] });
  adultSet = new Set(['hid18']);
  try {
    assert.equal((await call('POST', '/api/egram/api/notifications/read', { body: {} })).status, 400, 'no ids');
    assert.equal((await call('POST', '/api/egram/api/notifications/read', { body: { ids: [] } })).status, 400);
    assert.equal((await call('POST', '/api/egram/api/notifications/read', { body: { ids: ['1'] } })).status, 400);
    const r = await call('POST', '/api/egram/api/notifications/read', { body: { ids: [3, 4], extra: 1 } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(last().body), { ids: [3, 4] });
    // An id Grabbit hid (an 18+ author) and an unknown one are dropped.
    assert.equal((await call('POST', '/api/egram/api/notifications/read', { body: { ids: [4, 5, 99] } })).status, 200);
    assert.deepEqual(JSON.parse(last().body), { ids: [4] });
    const before = seen.length;
    assert.equal((await call('POST', '/api/egram/api/notifications/read', { body: { ids: [5] } })).status, 200);
    assert.ok(!seen.slice(before).some((q) => q.method === 'POST'), 'nothing to mark: no write upstream');
    // A list that cannot be verified stops the write (fail closed, never 5xx).
    for (const bad of [json(200, { nope: true }), json(503, { error: 'down' })]) {
      handlers['/api/notifications'] = bad;
      const n = seen.length;
      const r2 = await call('POST', '/api/egram/api/notifications/read', { body: { ids: [3] } });
      assert.equal(r2.status, 424);
      assert.ok(!seen.slice(n).some((q) => q.method === 'POST'), 'unverified: no write upstream');
    }
  } finally {
    adultSet = new Set();
    delete handlers['/api/notifications'];
    delete handlers['POST /api/notifications/read'];
  }
});
