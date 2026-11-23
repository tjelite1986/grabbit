'use strict';
// Grabbit 3.0 native Adshortis, phase 3: the member and media rows of the
// gateway (adshortis-gateway.js + ads-member-rows.js) against a fake Adshortis
// in this process (exit test E2 of phase3-requirements.md). Every temp file
// lives under one mkdtemp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const gw = require('../adshortis-gateway');
const rows = require('../ads-member-rows');
const { createLinkStore } = require('../ads-links');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-ads-gwm-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const OWN = 'https://grabbit.example.com';
const APP = 'https://ads.example.com';
const SECRET_WORDS = 'secret search words';

function writeJsonAtomic(file, value, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value), mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

// --- Fake Adshortis ------------------------------------------------------------------

const clip = (id, extra = {}) => ({
  id, title: `Clip ${id}`, genre: 'solo', visibility: 'public', status: 'ready', deleted: false, created_at: 1700000000000,
  source_url: 'https://source.example/v/1', tags: ['a', 'b'],
  creator: { id: 3, name: 'Cr', avatar: '/m/avatar/creator/3', following: false, secret: 1 },
  width: 720, height: 1280, duration: 12.5, has_audio: true, poster: `/m/poster/${id}`, video: `/m/video/${id}`,
  like_count: 2, comment_count: 1, liked: false, mine: false,
  error: 'ffmpeg failed at /srv/media/secret.mp4', uploader_id: 99, internal: 'x', ...extra,
});

const VIDEO = Buffer.alloc(64 * 1024, 7);
const up = { seen: [], clip: {}, status: {}, closed: [], uploadSeen: null, stream: null };
const upstream = http.createServer((req, res) => {
  const entry = { method: req.method, url: req.url, headers: req.headers, body: '', complete: false, closed: false };
  up.seen.push(entry);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  res.on('close', () => { entry.closed = !res.writableFinished; });
  req.on('close', () => { if (!req.complete) up.closed.push(req.url); });
  if (req.url === '/api/upload' && up.uploadEarly) {
    // A2: a declared size over the limit is refused before the body is read.
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
    return res.end(JSON.stringify({ error: 'The file is larger than the upload limit (12 MB)' }));
  }
  req.on('end', () => {
    entry.complete = true;
    entry.raw = Buffer.concat(chunks);
    entry.body = entry.raw.toString('utf8');
    answerUp(req, res, entry);
  });
});

function send(res, status, obj, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(obj));
}

function answerUp(req, res, entry) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/api/login') return send(res, 200, { ok: true }, { 'set-cookie': `as_session=tok${up.seen.length}; Path=/` });
  if (p === '/api/me') return send(res, 200, { id: 7, username: 'm', display_name: 'M', role: 'user', permissions: [], avatar: '/m/avatar/user/7', prefs: { sound: true, nav: ['x'] } });
  if (up.status[p]) {
    const [st, body, headers] = up.status[p];
    if (body === 'html') { res.writeHead(st, { 'content-type': 'text/html' }); return res.end('<html>upstream text</html>'); }
    return send(res, st, body || { error: 'Upstream secret text' }, headers);
  }
  if (p === '/api/clips') return send(res, 200, { items: [clip(1), clip(2, { poster: 'https://evil.example/p.jpg' }), { nope: 1 }], next: 2, prev: null, total: 3, extra: 'x' });
  let m;
  if ((m = /^\/api\/clips\/([0-9]+)$/.exec(p))) {
    const id = Number(m[1]);
    return send(res, 200, { ...clip(id, up.clip[id] || {}), hidden: false, can_edit: true, can_curate: false, ai_description: null });
  }
  if ((m = /^\/api\/clips\/([0-9]+)\/comments$/.exec(p))) {
    if (req.method === 'POST') return send(res, 200, { id: 55, extra: 1 });
    return send(res, 200, [{ id: 1, body: 'hi', created_at: 1, user_id: 9, display_name: 'D', avatar: '/m/avatar/user/9', can_delete: false, x: 1 }]);
  }
  if (p === '/api/creators') {
    return send(res, 200, [
      { id: 3, name: 'Ann', count: 4, avatar: '/m/avatar/creator/3', cover: '/m/poster/9', cover_clip: 9, extra: 1 },
      { id: 4, name: 'Anna', count: 1, avatar: '/m/avatar/creator/4', cover: '/m/poster/8', cover_clip: 8 },
    ]);
  }
  if (p === '/api/creators/3') {
    return send(res, 200, {
      id: 3, name: 'Ann', avatar: '/m/avatar/creator/3', has_avatar: true,
      links: [{ id: 1, kind: 'x', url: 'https://x.example/ann', label: 'X' }, { id: 2, kind: 'other', url: 'http://plain.example/', label: null }, { id: 3, kind: 'other', url: 'javascript:alert(1)' }],
      aliases: ['A'], person: { id: 2, name: 'P', x: 1 }, merged_into: null, following: true,
      source: { type: 'ytdlp', url: 'https://src.example/secret', last_poll_result: 'x' },
    });
  }
  if (p === '/api/creators/5') return send(res, 200, { redirect: 3 });
  if (p === '/api/tags') return send(res, 200, [{ tag: 'a', count: 2, x: 1 }]);
  if (p === '/api/me/prefs') return send(res, 200, { sound: false, autoplay: true, nav: ['feed'], grid_columns: 4, feed: 'new', feed_pos: {} });
  if (p === '/api/upload') {
    up.uploadSeen = entry;
    return send(res, 200, { id: 77, status: 'pending', path: '/srv/x' });
  }
  if ((m = /^\/m\/(video|poster|avatar\/creator)\/([0-9]+)$/.exec(p))) {
    const kind = m[1];
    if (kind === 'video') {
      if (up.stream) return up.stream(req, res);
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      const base = { 'content-type': 'video/mp4', 'cache-control': 'private, max-age=86400', 'accept-ranges': 'bytes', etag: '"abc-1"', 'set-cookie': 'x=1' };
      if (req.headers.range && (!range || Number(range[1]) >= VIDEO.length)) {
        res.writeHead(416, { 'content-range': `bytes */${VIDEO.length}` });
        return res.end();
      }
      if (range) {
        const start = Number(range[1]);
        const end = range[2] === '' ? VIDEO.length - 1 : Number(range[2]);
        res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${VIDEO.length}`, 'content-length': String(end - start + 1) });
        return res.end(req.method === 'HEAD' ? undefined : VIDEO.subarray(start, end + 1));
      }
      res.writeHead(200, { ...base, 'content-length': String(VIDEO.length) });
      return res.end(req.method === 'HEAD' ? undefined : VIDEO);
    }
    if (m[2] === '66') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
    if (kind === 'poster' && m[2] === '2') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg/>'); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' });
    return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  send(res, 404, { error: 'Not found' });
}

// --- Grabbit side ------------------------------------------------------------------------

let links;
const logs = [];
const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
const apps = [];
let t0 = 1_000_000;

function mount(met = ['adshortis:A2', 'adshortis:A18'], extra = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use((req, _res, next) => { req.principal = 'owner'; next(); });
  const gateway = gw.createGateway({
    apiUrl: `http://127.0.0.1:${upstream.address().port}`,
    appOrigin: APP,
    publicOrigin: OWN,
    links,
    isOwner: (req) => req.principal === 'owner',
    log,
    phase: '3',
    met: new Set(met),
    now: () => t0,
    ...extra,
  });
  app.use(gw.MOUNT, (req, res) => gateway.handle(req, res));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      apps.push(srv);
      resolve(`http://127.0.0.1:${srv.address().port}`);
    });
  });
}

let base;
let small; // upload cap 1 MB
let bare; // no conditions met
test.before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  links = createLinkStore({ dir: path.join(root, 'data'), writeJsonAtomic, log });
  base = await mount();
  small = await mount(undefined, { uploadMaxMb: 1 });
  bare = await mount([]);
});
test.after(() => {
  for (const s of apps) s.close();
  upstream.close();
});

function call(p, { method = 'GET', who, headers = {}, body, raw, at = base, signal } = {}) {
  const h = { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' };
  if (method !== 'GET' && method !== 'HEAD') h.origin = OWN;
  if (who) h.cookie = `${gw.LOGIN_COOKIE}=${who.login}; ${gw.LINK_COOKIE}=${who.seal}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  Object.assign(h, headers);
  for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
  const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
  return fetch(`${at}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal }).then(async (r) => {
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
    return { status: r.status, body: json, buf, headers: r.headers, setCookie: r.headers.getSetCookie() };
  });
}

async function linked(at = base) {
  const login = links.issueLogin();
  const r = await call('/api/ads/session', { method: 'POST', at, who: { login, seal: '' }, body: { username: 'm', password: 'p' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.setCookie.find((v) => v.startsWith(`${gw.LINK_COOKIE}=`));
  return { login, seal: c.split(';')[0].slice(gw.LINK_COOKIE.length + 1) };
}
const mark = () => up.seen.length;
const since = (n) => up.seen.slice(n).map((e) => `${e.method} ${e.url}`);
const reset = () => { up.status = {}; up.clip = {}; up.stream = null; up.uploadEarly = false; };

// --- Wiring ------------------------------------------------------------------------------

test('wiring: phase 3 without conditions keeps D1, D2 and M12 off (404, nothing upstream)', async () => {
  reset();
  const who = await linked(bare);
  const n = mark();
  for (const [method, p] of [['GET', '/api/ads/m/video/1'], ['HEAD', '/api/ads/m/poster/1'], ['POST', '/api/ads/upload'], ['GET', '/api/ads/m/avatar/user/7'], ['GET', '/api/ads/m/download/1']]) {
    const r = await call(p, { method, who, at: bare, headers: method === 'POST' ? { 'content-type': 'video/mp4' } : {}, raw: method === 'POST' ? 'x' : undefined });
    assert.equal(r.status, 404, `${method} ${p}`);
  }
  assert.deepEqual(since(n), []);
  // A member JSON row needs no condition.
  assert.equal((await call('/api/ads/tags', { who, at: bare })).status, 200);
});

test('unlinked: a member row is 401 before upstream', async () => {
  reset();
  const n = mark();
  const r = await call('/api/ads/clips', { who: { login: links.issueLogin(), seal: 'x' } });
  assert.equal(r.status, 401);
  assert.deepEqual(since(n), []);
});

// --- Projections (GW-PROJ, GAP 3) --------------------------------------------------------------

test('M1: list items carry exactly CLIP_FIELDS; error, uploader_id and unknown keys never pass; URLs rewritten', async () => {
  reset();
  const who = await linked();
  const r = await call('/api/ads/clips?feed=new&limit=24', { who });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['ok', 'items', 'next', 'prev', 'total']);
  assert.equal(r.body.items.length, 2, 'an item without an id is dropped');
  for (const it of r.body.items) {
    assert.deepEqual(Object.keys(it), rows.CLIP_FIELDS);
    assert.deepEqual(Object.keys(it.creator), ['id', 'name', 'avatar', 'following']);
  }
  assert.equal(r.body.items[0].video, '/api/ads/m/video/1');
  assert.equal(r.body.items[0].creator.avatar, '/api/ads/m/avatar/creator/3');
  assert.equal(r.body.items[1].poster, null, 'an absolute URL is dropped');
  assert.equal(r.body.items[0].source_url, 'https://source.example/v/1', 'kept as text');
  assert.doesNotMatch(r.buf.toString(), /ffmpeg|secret|uploader|internal/);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('M3: detail fields added, error dropped; deleted or unready refused for owner and admin alike (GW-ELIG)', async () => {
  reset();
  const who = await linked();
  const ok = await call('/api/ads/clips/5', { who });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body), ['ok', ...rows.CLIP_FIELDS, ...rows.DETAIL_FIELDS]);
  assert.equal('error' in ok.body, false);
  for (const [id, extra] of [
    [6, { deleted: true, mine: true }],
    [7, { deleted: true, can_edit: true, can_curate: true }],
    [8, { status: 'pending', mine: true }],
    [9, { status: 'failed' }],
    [10, { deleted: 'no' }],
  ]) {
    up.clip[id] = extra;
    const r = await call(`/api/ads/clips/${id}`, { who });
    assert.equal(r.status, 404, String(id));
    assert.deepEqual(r.body, { ok: false, error: 'This clip is not available.', reason: 'not_available' });
  }
});

test('ids: a non-numeric or odd id is 404 and never sent upstream (GW-ID)', async () => {
  reset();
  const who = await linked();
  const n = mark();
  for (const p of ['/api/ads/clips/abc', '/api/ads/clips/1.5', '/api/ads/clips/-1', '/api/ads/clips/%31', '/api/ads/clips/1234567890123456', '/api/ads/creators/x', '/api/ads/m/video/1a']) {
    assert.equal((await call(p, { who })).status, 404, p);
  }
  assert.deepEqual(since(n), []);
});

// --- Queries (GW-Q) ------------------------------------------------------------------------------

test('query: q on any GET is 400 and never upstream; bad values 400; unknown keys dropped; limit capped at 60', async () => {
  reset();
  const who = await linked();
  const n = mark();
  for (const p of ['/api/ads/clips?q=x', '/api/ads/creators?q=ann', '/api/ads/tags?q=a', '/api/ads/clips?feed=evil', '/api/ads/clips?tag=a%20b',
    '/api/ads/clips?creator=1x', '/api/ads/clips?limit=0', '/api/ads/clips?feed=new&feed=liked', '/api/ads/playlists?all=2']) {
    const r = await call(p, { who });
    assert.equal(r.status, 400, p);
  }
  assert.equal((await call('/api/ads/clips?tag=a%20b', { who })).body.error, 'This tag cannot be opened.');
  assert.deepEqual(since(n), []);
  await call('/api/ads/clips?feed=foryou&genre=solo,duo&limit=500&evil=1&tag=%C3%A5ka_1&around=4', { who });
  const sent = new URL(up.seen.at(-1).url, 'http://x');
  assert.equal(sent.pathname, '/api/clips');
  assert.deepEqual([...sent.searchParams.keys()].sort(), ['around', 'feed', 'genre', 'limit', 'tag']);
  assert.equal(sent.searchParams.get('limit'), '60');
  assert.equal(sent.searchParams.get('tag'), 'åka_1');
  await call('/api/ads/playlists?all=1&x=2', { who });
  assert.equal(up.seen.at(-1).url, '/api/playlists?all=1');
  await call('/api/ads/hidden?feed=new', { who });
  assert.equal(up.seen.at(-1).url, '/api/hidden', 'rows without a query pass none');
});

// --- Search and lookup (M2, M14, GW-LIMIT) -------------------------------------------------------

test('M2 search: words only in the POST body and the upstream query, never in the log; 60/min per login id', async () => {
  reset();
  const who = await linked();
  const other = await linked();
  logs.length = 0;
  const r = await call('/api/ads/search', { method: 'POST', who, body: { q: `  ${SECRET_WORDS} `, genre: 'solo', limit: 30, evil: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
  const sent = new URL(up.seen.at(-1).url, 'http://x');
  assert.equal(up.seen.at(-1).method, 'GET');
  assert.equal(sent.searchParams.get('q'), SECRET_WORDS);
  assert.equal(sent.searchParams.get('genre'), 'solo');
  assert.equal(sent.searchParams.has('evil'), false);
  assert.ok(logs.every((l) => !l.includes('secret') && !l.includes('?')), logs.join('\n'));
  assert.equal((await call('/api/ads/search', { method: 'POST', who, body: { q: '  ' } })).status, 400);
  assert.equal((await call('/api/ads/search', { method: 'POST', who, body: { q: 'x'.repeat(101) } })).status, 400);
  // Three calls so far for `who`; 57 more fill the minute.
  for (let i = 0; i < 57; i++) assert.equal((await call('/api/ads/search', { method: 'POST', who, body: { q: 'a' } })).status, 200);
  const n = mark();
  const over = await call('/api/ads/search', { method: 'POST', who, body: { q: 'a' } });
  assert.equal(over.status, 429);
  assert.match(over.headers.get('retry-after'), /^[0-9]+$/);
  assert.deepEqual(since(n), []);
  assert.equal((await call('/api/ads/search', { method: 'POST', who: other, body: { q: 'a' } })).status, 200, 'per login id');
  assert.equal((await call('/api/ads/creators/lookup', { method: 'POST', who, body: { name: 'Ann' } })).status, 200, 'lookup has its own count');
  t0 += 60_000;
  assert.equal((await call('/api/ads/search', { method: 'POST', who, body: { q: 'a' } })).status, 200, 'a new minute');
});

test('M14 lookup: exact name match in Grabbit; the name only in the body', async () => {
  reset();
  const who = await linked();
  const r = await call('/api/ads/creators/lookup', { method: 'POST', who, body: { name: 'Ann' } });
  assert.deepEqual(r.body, { ok: true, items: [{ id: 3, name: 'Ann', count: 4, avatar: '/api/ads/m/avatar/creator/3', cover: '/api/ads/m/poster/9', cover_clip: 9 }] });
  assert.equal(up.seen.at(-1).url, '/api/creators?q=Ann');
  assert.deepEqual((await call('/api/ads/creators/lookup', { method: 'POST', who, body: { name: 'An' } })).body.items, []);
  assert.equal((await call('/api/ads/creators/lookup', { method: 'POST', who, body: {} })).status, 400);
});

// --- GAP 23, GAP 7, GAP 6 ---------------------------------------------------------------------------

test('M5 (GAP 23): comments of a deleted or unready clip are 404 with no comments call; authors carry no avatar or id', async () => {
  reset();
  const who = await linked();
  up.clip[20] = { deleted: true, mine: true, can_edit: true };
  up.clip[21] = { status: 'pending' };
  for (const id of [20, 21]) {
    const n = mark();
    const r = await call(`/api/ads/clips/${id}/comments`, { who });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'This clip is not available.');
    assert.deepEqual(since(n), [`GET /api/clips/${id}`]);
  }
  up.status['/api/clips/23'] = [404];
  assert.equal((await call('/api/ads/clips/23/comments', { who })).status, 404);
  const ok = await call('/api/ads/clips/22/comments', { who });
  assert.deepEqual(ok.body, { ok: true, items: [{ id: 1, body: 'hi', created_at: 1, display_name: 'D', can_delete: false }] });
});

test('M15 (GAP 7): only https links pass; the source block never does; a merged profile answers its redirect', async () => {
  reset();
  const who = await linked();
  const r = await call('/api/ads/creators/3', { who });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.links, [{ kind: 'x', url: 'https://x.example/ann', label: 'X' }]);
  assert.equal('source' in r.body, false);
  assert.doesNotMatch(r.buf.toString(), /src\.example|plain\.example|javascript/);
  assert.deepEqual(r.body.person, { id: 2, name: 'P' });
  assert.deepEqual((await call('/api/ads/creators/5', { who })).body, { ok: true, redirect: 3 });
});

test('M25 (GAP 6) and other writes: bodies re-serialised from the allowlist; upstream gets the app Origin', async () => {
  reset();
  const who = await linked();
  const r = await call('/api/ads/me/prefs', { method: 'PATCH', who, body: { sound: false, nav: ['admin'], grid_columns: 4, feed: 'new', feed_pos: { 'new|': 5, x: 'y' }, role: 'admin' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, prefs: { sound: false, autoplay: true, grid_columns: 4, feed: 'new', feed_pos: {} } });
  const sent = up.seen.at(-1);
  assert.deepEqual(JSON.parse(sent.body), { sound: false, grid_columns: 4, feed: 'new', feed_pos: { 'new|': 5 } });
  assert.equal(sent.headers.origin, APP);
  assert.equal(sent.headers['content-type'], 'application/json');
  await call('/api/ads/clips/4/comments', { method: 'POST', who, body: { body: ' hello ', user_id: 1 } });
  assert.deepEqual(JSON.parse(up.seen.at(-1).body), { body: 'hello' });
  await call('/api/ads/clips/4/report', { method: 'POST', who, body: { reason: 'other', note: 'n', clip: 9 } });
  assert.deepEqual(JSON.parse(up.seen.at(-1).body), { reason: 'other', note: 'n' });
  await call('/api/ads/playlists', { method: 'POST', who, body: { name: 'L', clip_id: '4', user_id: 2 } });
  assert.deepEqual(JSON.parse(up.seen.at(-1).body), { name: 'L', clip_id: 4 });
  const n = mark();
  for (const [p, method, body] of [
    ['/api/ads/clips/4/report', 'POST', { reason: 'spam' }],
    ['/api/ads/clips/4/comments', 'POST', { body: '' }],
    ['/api/ads/playlists/2/items', 'POST', { clip_id: 'x' }],
    ['/api/ads/playlists/2', 'PATCH', { name: '' }],
  ]) {
    assert.equal((await call(p, { method, who, body })).status, 400, p);
  }
  assert.deepEqual(since(n), []);
  // DELETE carries no body upstream.
  await call('/api/ads/playlists/2', { method: 'DELETE', who });
  assert.equal(up.seen.at(-1).body, '');
});

// --- Upstream answers -------------------------------------------------------------------------------

test('answers: upstream 4xx keeps its status with a fixed message; 5xx, HTML and wrong shapes are 424', async () => {
  reset();
  const who = await linked();
  for (const [st, msg] of [[403, 'Not allowed'], [404, 'Not found'], [400, 'Adshortis refused the request'], [418, 'Adshortis refused the request']]) {
    up.status['/api/playlists/9'] = [st];
    const r = await call('/api/ads/playlists/9', { who });
    assert.equal(r.status, st);
    assert.deepEqual(r.body, { ok: false, error: msg });
  }
  up.status['/api/playlists/9'] = [429, null, { 'retry-after': '30' }];
  const t = await call('/api/ads/playlists/9', { who });
  assert.equal(t.status, 429);
  assert.equal(t.headers.get('retry-after'), '30');
  for (const st of [500, 502, 302]) {
    up.status['/api/playlists/9'] = [st];
    assert.equal((await call('/api/ads/playlists/9', { who })).status, 424, String(st));
  }
  up.status['/api/playlists/9'] = [200, 'html'];
  assert.equal((await call('/api/ads/playlists/9', { who })).status, 424);
  up.status['/api/playlists/9'] = [200, [1, 2]];
  assert.equal((await call('/api/ads/playlists/9', { who })).status, 424, 'wrong shape');
});

test('answers: an upstream 401 on a member row ends the link; the next call is 401 with no upstream call', async () => {
  reset();
  const who = await linked();
  up.status['/api/tags'] = [401];
  const r = await call('/api/ads/tags', { who });
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'expired');
  assert.ok(r.setCookie.some((c) => c.startsWith(`${gw.LINK_COOKIE}=;`) && /Max-Age=0/.test(c)));
  reset();
  const n = mark();
  assert.equal((await call('/api/ads/tags', { who })).status, 401);
  assert.deepEqual(since(n), []);
});

test('log: method, rule and status only', async () => {
  reset();
  const who = await linked();
  logs.length = 0;
  await call('/api/ads/clips/12', { who });
  await call('/api/ads/clips?tag=secret_tag', { who });
  assert.deepEqual(logs, ['[ads] GET M3 200', '[ads] GET M1 200']);
});

// --- Media (GW-MEDIA) ------------------------------------------------------------------------------

test('D1: Range forwarded, 206 and Content-Range mirrored, HEAD bodyless, 416; private no-store, sandbox CSP, no upstream cookies', async () => {
  reset();
  const who = await linked();
  const full = await call('/api/ads/m/video/3', { who });
  assert.equal(full.status, 200);
  assert.ok(full.buf.equals(VIDEO));
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  assert.equal(full.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(full.headers.get('set-cookie'), null);
  assert.equal(up.seen.at(-1).url, '/m/video/3');
  assert.match(up.seen.at(-1).headers.cookie, /^as_session=/);
  const part = await call('/api/ads/m/video/3', { who, headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${VIDEO.length}`);
  assert.equal(part.buf.length, 10);
  assert.equal(up.seen.at(-1).headers.range, 'bytes=10-19');
  const head = await call('/api/ads/m/video/3', { who, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(VIDEO.length));
  assert.equal(head.buf.length, 0);
  assert.equal(up.seen.at(-1).method, 'HEAD');
  const past = await call('/api/ads/m/video/3', { who, headers: { range: `bytes=${VIDEO.length}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${VIDEO.length}`);
  const n = mark();
  assert.equal((await call('/api/ads/m/video/3', { who, headers: { range: 'bytes=0-1,4-5' } })).status, 416, 'odd Range never upstream');
  assert.deepEqual(since(n), []);
  up.status['/m/video/4'] = [404];
  assert.equal((await call('/api/ads/m/video/4', { who })).status, 404, 'A18 refusal passes as 404');
});

test('D2/D3: raster passes; an SVG is replaced by the placeholder PNG; a wrong type is 424', async () => {
  reset();
  const who = await linked();
  const jpg = await call('/api/ads/m/poster/1', { who });
  assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
  assert.equal(jpg.headers.get('cache-control'), 'private, no-store', 'upstream max-age replaced');
  const svg = await call('/api/ads/m/poster/2', { who });
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/png');
  assert.equal(svg.headers.get('x-grabbit-placeholder'), '1');
  assert.ok(svg.buf.equals(gw.PLACEHOLDER_PNG));
  assert.equal(svg.buf.subarray(1, 4).toString(), 'PNG');
  assert.equal((await call('/api/ads/m/poster/66', { who })).status, 424);
  assert.equal((await call('/api/ads/m/avatar/creator/3', { who })).headers.get('content-type'), 'image/jpeg');
});

test('D1: a client that goes away ends the upstream stream', async () => {
  reset();
  const who = await linked();
  let opened;
  const ready = new Promise((r) => { opened = r; });
  up.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(10 * 1024 * 1024) });
    res.write(Buffer.alloc(16 * 1024));
    opened();
  };
  const ac = new AbortController();
  const p = fetch(`${base}/api/ads/m/video/3`, { headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin', cookie: `${gw.LOGIN_COOKIE}=${who.login}; ${gw.LINK_COOKIE}=${who.seal}` }, signal: ac.signal });
  const res = await p;
  const reader = res.body.getReader();
  await reader.read();
  await ready;
  const entry = up.seen.at(-1);
  ac.abort();
  for (let i = 0; i < 50 && !entry.closed; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(entry.closed, true, 'upstream response closed before it finished');
});

test('D1: a stream paused by the browser longer than the idle timeout still finishes', async () => {
  reset();
  const at = await mount(undefined, { timeoutMs: 200 });
  const who = await linked(at);
  // Larger than every socket buffer on the way, so the gateway's upstream
  // socket really stalls while the browser reads nothing.
  const total = 64 * 1024 * 1024;
  const chunk = Buffer.alloc(256 * 1024, 5);
  up.stream = (req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(total) });
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  };
  const r = await fetch(`${at}/api/ads/m/video/3`, { headers: { 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin', cookie: `${gw.LOGIN_COOKIE}=${who.login}; ${gw.LINK_COOKIE}=${who.seal}` } });
  const reader = r.body.getReader();
  let got = (await reader.read()).value.length;
  // The browser's buffer is full: nothing is read for longer than the timeout.
  await new Promise((res) => setTimeout(res, 1500));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
  }
  assert.equal(got, total);
});

// --- Upload (M12, GW-UP) -------------------------------------------------------------------------

const meta = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// An upload that declares `size` bytes but sends only `send` of them, then
// waits for the answer. A refusal that arrives before the body is sent closes
// the connection; fetch() would race that close while still writing.
function rawUpload(at, who, size, send) {
  const u = new URL(at);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, method: 'POST', path: '/api/ads/upload',
      headers: {
        'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin', origin: OWN, 'content-type': 'video/mp4', 'content-length': String(size),
        cookie: `${gw.LOGIN_COOKIE}=${who.login}; ${gw.LINK_COOKIE}=${who.seal}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') reject(e); });
    req.flushHeaders();
    if (send) req.write(Buffer.alloc(send));
  });
}

test('M12: the file streams upstream in a multipart body with only the allowlisted fields', async () => {
  reset();
  const who = await linked();
  const file = Buffer.alloc(200 * 1024, 3);
  const r = await call('/api/ads/upload', {
    method: 'POST', who, raw: file,
    headers: { 'content-type': 'video/mp4', 'x-ads-upload': meta({ title: ' T ', tags: 'a b', creator: 'Ann', genre: 'solo', visibility: 'private', uploader_id: 1, path: '/etc' }) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, id: 77, status: 'pending' });
  const seen = up.uploadSeen;
  assert.equal(seen.headers.origin, APP);
  const b = /boundary=(.+)$/.exec(seen.headers['content-type'])[1];
  assert.equal(Number(seen.headers['content-length']), seen.raw.length);
  const parts = seen.raw.toString('latin1').split(`--${b}`).slice(1, -1);
  const names = parts.map((p) => /name="([^"]+)"/.exec(p)[1]);
  assert.deepEqual(names, ['title', 'tags', 'creator', 'genre', 'visibility', 'file']);
  assert.match(parts[0], /\r\n\r\nT\r\n$/);
  const filePart = Buffer.from(parts[5], 'latin1');
  const bodyStart = filePart.indexOf('\r\n\r\n') + 4;
  assert.ok(filePart.subarray(bodyStart, filePart.length - 2).equals(file), 'file bytes intact');
});

test('M12: refusals before upstream (type, meta, length, over the cap); upstream 413 mapped with its limit', async () => {
  reset();
  const who = await linked(small);
  const n = mark();
  const cases = [
    [{ 'content-type': 'multipart/form-data; boundary=x' }, 'x', 415],
    [{ 'content-type': 'video/mp4', 'x-ads-upload': 'not base64!' }, 'x', 400],
    [{ 'content-type': 'video/mp4', 'x-ads-upload': meta({ visibility: 'all' }) }, 'x', 400],
    [{ 'content-type': 'video/mp4', 'x-ads-upload': meta({ title: 'a\r\nb' }) }, 'x', 400],
  ];
  for (const [headers, raw, st] of cases) {
    const r = await call('/api/ads/upload', { method: 'POST', who, at: small, headers, raw });
    assert.equal(r.status, st, JSON.stringify(headers));
  }
  // Over the cap: refused on the declared length, before a byte is read.
  const over = await rawUpload(small, who, 2 * 1024 * 1024, 0);
  assert.equal(over.status, 413);
  assert.equal(over.headers.connection, 'close');
  assert.deepEqual(over.body, { ok: false, error: 'This file is too large to upload here.', limit_mb: 1 });
  assert.deepEqual(since(n), []);
  // Upstream refuses early (A2 precheck): its limit passes, the connection closes.
  up.uploadEarly = true;
  const early = await rawUpload(small, who, 512 * 1024, 16 * 1024);
  assert.equal(early.status, 413);
  assert.equal(early.headers.connection, 'close');
  assert.deepEqual(early.body, { ok: false, error: 'This file is too large to upload here.', limit_mb: 12 });
});

test('M12: a browser that cancels mid-upload ends the upstream upload', async () => {
  reset();
  const who = await linked();
  const before = up.closed.length;
  const n = mark();
  const u = new URL(base);
  const req = http.request({
    hostname: u.hostname, port: u.port, method: 'POST', path: '/api/ads/upload',
    headers: {
      'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin', origin: OWN, 'content-type': 'video/mp4', 'content-length': String(4 * 1024 * 1024),
      cookie: `${gw.LOGIN_COOKIE}=${who.login}; ${gw.LINK_COOKIE}=${who.seal}`,
    },
  });
  req.on('error', () => {});
  req.write(Buffer.alloc(256 * 1024));
  for (let i = 0; i < 50 && !up.seen.slice(n).some((e) => e.url === '/api/upload'); i++) await new Promise((r) => setTimeout(r, 20));
  req.destroy();
  for (let i = 0; i < 50 && up.closed.length === before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(up.closed.slice(before).includes('/api/upload'), 'upstream saw the upload end early');
});

// --- Pure helpers -------------------------------------------------------------------------------------

test('rows: eligibility, https links, tag rule, every live phase-3 member row has a spec', () => {
  const matrix = require('../ads-route-matrix');
  for (const r of matrix.liveRoutes('3', new Set(['adshortis:A2', 'adshortis:A18']))) {
    if (!r.row.startsWith('S')) assert.ok(rows.ROWS[r.row], r.row);
  }
  assert.equal(rows.eligible({ deleted: false, status: 'ready' }), true);
  for (const c of [null, { deleted: null, status: 'ready' }, { deleted: false, status: 'pending' }, { deleted: true, status: 'ready' }]) assert.equal(rows.eligible(c), false);
  assert.equal(rows.httpsUrl('https://a.example/x'), 'https://a.example/x');
  for (const u of ['http://a.example', 'javascript:alert(1)', 'https://u:p@a.example', '//a.example', 7]) assert.equal(rows.httpsUrl(u), null, String(u));
  assert.ok(rows.TAG_RE.test('åka_1') && !rows.TAG_RE.test('a b') && !rows.TAG_RE.test('x'.repeat(61)));
});
