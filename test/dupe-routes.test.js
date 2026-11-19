'use strict';
// /api/hub/dupes/v2: input checks, error mapping (never 5xx) and the gate
// the router sits behind in server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const express = require('express');
const { createRouter, KEY_RE, TRASH_ID_RE } = require('../dupe-routes');
const { DupeError } = require('../dupe-service');
const { TrashError } = require('../dupe-trash');
const { AdapterError } = require('../dupe-adapters');

const SHA = 'a'.repeat(64);

// A service stub that records every call and answers with `answers[name]`
// (a value or a function of the arguments).
function stubService(answers = {}) {
  const calls = [];
  const svc = new Proxy({}, {
    get(_, name) {
      if (name === 'calls') return calls;
      if (name === 'store') return answers.store || { dupeFile: () => null };
      if (name === 'dx') return answers.dx || { preventionRecent: () => [], history: () => [], opsRecent: () => [] };
      if (name === 'then') return undefined;
      return (...args) => {
        calls.push({ name, args });
        const a = answers[name];
        return typeof a === 'function' ? a(...args) : (a === undefined ? {} : a);
      };
    },
  });
  return svc;
}

async function mount(t, deps = {}) {
  const app = express();
  app.use(express.json());
  const service = deps.service || stubService();
  app.use('/v2', createRouter({ kindOfName: () => 'video', actorOf: () => 'tester', ...deps, service }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/v2`;
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  };
  return { service, get: (p) => req('GET', p), post: (p, b) => req('POST', p, b ?? {}) };
}

const quiet = (t) => {
  const err = console.error;
  const warn = console.warn;
  const log = console.log;
  console.error = () => {};
  console.warn = () => {};
  console.log = () => {};
  t.after(() => { console.error = err; console.warn = warn; console.log = log; });
};

test('KEY_RE and TRASH_ID_RE accept only the server-made shapes', () => {
  for (const ok of [`exact:${SHA}`, 'photo:1', 'video:123456789012']) assert.ok(KEY_RE.test(ok), ok);
  for (const bad of [`exact:${SHA.toUpperCase()}`, 'exact:abc', 'photo:0', 'photo:01', 'video:12345678901234', 'audio:1', `exact:${SHA}\n`, '../x']) {
    assert.ok(!KEY_RE.test(bad), bad);
  }
  for (const ok of ['g1', 'a42']) assert.ok(TRASH_ID_RE.test(ok), ok);
  for (const bad of ['g0', 'x1', '1', 'g', 'g1/../2', 'G1']) assert.ok(!TRASH_ID_RE.test(bad), bad);
});

test('a successful call answers ok:true with the service result', async (t) => {
  const s = await mount(t, { service: stubService({ overview: { totals: { groups: 3 } }, libraryStatus: [{ path: '/x' }] }) });
  assert.deepEqual((await s.get('/overview')).body, { ok: true, totals: { groups: 3 } });
  assert.deepEqual((await s.get('/library')).body, { ok: true, roots: [{ path: '/x' }] });
});

test('list queries keep only known keys, as short strings', async (t) => {
  const s = await mount(t);
  await s.get(`/groups?tab=exact&limit=10&evil=1&sort=${'x'.repeat(200)}&status=`);
  const call = s.service.calls.find((c) => c.name === 'list');
  assert.deepEqual(Object.keys(call.args[0]).sort(), ['limit', 'sort', 'tab']);
  assert.equal(call.args[0].sort.length, 80);
});

test('group actions validate the key, the action and the keep ids', async (t) => {
  const s = await mount(t);
  const bad = [
    { key: 'nope', action: 'keep' },
    { key: `exact:${SHA}`, action: 'delete_everything' },
    { key: `exact:${SHA}`, action: 'keep_selected', keep: ['../etc'] },
    { key: `exact:${SHA}`, action: 'keep_selected', keep: [] },
    { key: `exact:${SHA}`, action: 'keep_selected', keep: '1' },
    { key: `exact:${SHA}`, action: 'keep_selected', keep: Array.from({ length: 501 }, (_, i) => i + 1) },
  ];
  for (const b of bad) {
    const r = await s.post('/groups/action', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.ok, false);
  }
  assert.equal(s.service.calls.filter((c) => c.name === 'act').length, 0);
  const ok = await s.post('/groups/action', { key: `exact:${SHA}`, action: 'keep_selected', keep: [2, '2', 5], note: 'n'.repeat(600) });
  assert.equal(ok.status, 200);
  const [key, action, opts] = s.service.calls.find((c) => c.name === 'act').args;
  assert.equal(key, `exact:${SHA}`);
  assert.equal(action, 'keep_selected');
  assert.deepEqual(opts.keep, [2, 5], 'ids are deduplicated');
  assert.equal(opts.by, 'tester');
  assert.equal(opts.note.length, 500);
});

test('the references route refuses a malformed key before the service', async (t) => {
  const s = await mount(t);
  assert.equal((await s.get('/groups/photo:0/references')).status, 400);
  assert.equal(s.service.calls.length, 0);
  assert.equal((await s.get('/groups/photo:7/references')).status, 200);
});

test('batch defaults to a dry run and validates keys', async (t) => {
  const s = await mount(t);
  assert.equal((await s.post('/batch', { keys: ['bad'], action: 'trash_extras' })).status, 400);
  assert.equal((await s.post('/batch', { action: 'trash_extras' })).status, 400, 'no keys and no filter');
  await s.post('/batch', { keys: [`exact:${SHA}`], action: 'trash_extras' });
  await s.post('/batch', { keys: [`exact:${SHA}`], action: 'trash_extras', dryRun: 'no' });
  await s.post('/batch', { keys: [`exact:${SHA}`], action: 'trash_extras', dryRun: false });
  const runs = s.service.calls.filter((c) => c.name === 'batch').map((c) => c.args[0].dryRun);
  assert.deepEqual(runs, [true, true, false], 'only an explicit false runs for real');
});

test('trash routes take only trash ids and need an explicit expectation to empty', async (t) => {
  const s = await mount(t, { service: stubService({ trashEntries: [{ id: 'g1' }, { id: 'a2' }] }) });
  assert.equal((await s.post('/trash/restore', { ids: ['/etc/passwd'] })).status, 400);
  assert.equal((await s.post('/trash/delete', { ids: ['g1', 'g0'] })).status, 400);
  assert.equal((await s.post('/trash/delete', {})).status, 400);
  assert.equal((await s.post('/trash/empty', {})).status, 400);
  assert.equal(s.service.calls.filter((c) => ['trashRestore', 'trashDelete', 'trashEmpty'].includes(c.name)).length, 0);
  await s.post('/trash/restore', { all: true });
  assert.deepEqual(s.service.calls.find((c) => c.name === 'trashRestore').args, [['g1', 'a2'], 'tester']);
  await s.post('/trash/empty', { expect: { files: '3', bytes: 10, fingerprint: 'abc' } });
  assert.deepEqual(s.service.calls.find((c) => c.name === 'trashEmpty').args[0], { files: 3, bytes: 10, fingerprint: 'abc' });
});

test('errors map to 4xx with a message, never 5xx', async (t) => {
  quiet(t);
  const cases = [
    [new DupeError('Bad input'), 400, 'Bad input'],
    [new DupeError('Gone', 409, 'Rescan'), 409, 'Gone'],
    [new DupeError('Server said 500', 500), 424, 'Server said 500'],
    [new AdapterError('TikShortis is not reachable right now', { status: 424, fix: 'nothing was changed' }), 424, 'TikShortis is not reachable right now'],
    [new AdapterError('refused', { status: 503 }), 424, 'refused'],
    [new TrashError('Already restored'), 409, 'Already restored'],
    [new Error('SQLITE_BUSY: secret internals'), 422, 'That did not work. See the server log.'],
    [new TypeError('x is undefined'), 422, 'That did not work. See the server log.'],
  ];
  for (const [err, status, message] of cases) {
    const s = await mount(t, { service: stubService({ overview: () => { throw err; } }) });
    const r = await s.get('/overview');
    assert.equal(r.status, status, err.message);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, message);
  }
  // A rejected promise is handled the same way.
  const s = await mount(t, { service: stubService({ references: async () => { throw new Error('boom'); } }) });
  const r = await s.get('/groups/photo:1/references');
  assert.equal(r.status, 422);
  assert.doesNotMatch(r.text, /boom/, 'internal messages stay in the log');
});

test('unknown routes are a JSON 404', async (t) => {
  const s = await mount(t);
  const r = await s.get('/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { ok: false, error: 'Not found' });
});

test('scan and analysis report a missing engine as 409 and validate the action', async (t) => {
  quiet(t);
  const s = await mount(t);
  assert.equal((await s.post('/scan', { action: 'start' })).status, 409);
  assert.equal((await s.post('/analysis', { action: 'start' })).status, 409);
  const calls = [];
  const engine = () => {
    const e = {};
    for (const n of ['start', 'pause', 'stop', 'rescan']) e[n] = () => { calls.push(n); return { state: n }; };
    e.regroup = (k) => k;
    return e;
  };
  const s2 = await mount(t, { scanner: engine(), analyzer: engine() });
  assert.equal((await s2.post('/scan', { action: 'delete' })).status, 400);
  assert.equal((await s2.post('/analysis', { action: 'rescan' })).status, 400);
  assert.deepEqual((await s2.post('/scan', { action: 'resume' })).body, { ok: true, scan: { state: 'start' } });
  assert.deepEqual(calls, ['start']);
});

test('an action named after an Object.prototype member is refused as unknown', async (t) => {
  quiet(t);
  const engine = { start: () => ({}), pause: () => ({}), stop: () => ({}), rescan: () => ({}) };
  const s = await mount(t, { scanner: engine, analyzer: engine });
  for (const action of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.equal((await s.post('/scan', { action })).status, 400, `scan ${action}`);
    assert.equal((await s.post('/analysis', { action })).status, 400, `analysis ${action}`);
  }
});

test('settings must be an object', async (t) => {
  const s = await mount(t);
  assert.equal((await s.post('/settings', { settings: 'x' })).status, 400);
  assert.equal((await s.post('/settings', {})).status, 400);
  assert.equal((await s.post('/settings', { settings: { sensitivity: 40 } })).status, 200);
});

test('cache actions name the app by a short lowercase word', async (t) => {
  const s = await mount(t);
  assert.equal((await s.post('/cache/TIK/clean')).status, 400);
  assert.equal((await s.post('/cache/a/clean')).status, 400);
  await s.post('/cache/egram/clean', {});
  await s.post('/cache/egram/clean', { dryRun: false });
  const runs = s.service.calls.filter((c) => c.name === 'cacheAction').map((c) => c.args.slice(0, 3));
  assert.deepEqual(runs, [['egram', 'clean', true], ['egram', 'clean', false]]);
});

test('model downloads take only known ids and need a model manager', async (t) => {
  quiet(t);
  const s = await mount(t);
  assert.equal((await s.post('/models/light/download')).status, 409);
  const asked = [];
  const models = { download: async (id) => { asked.push(id); return {}; } };
  const s2 = await mount(t, { models });
  assert.equal((await s2.post('/models/huge/download')).status, 400);
  assert.equal((await s2.post('/models/..%2Flight/download')).status, 400);
  assert.deepEqual((await s2.post('/models/light/download')).body, { ok: true, started: true });
  assert.deepEqual(asked, ['light']);
  models.downloading = 'light';
  const busy = await s2.post('/models/light/download');
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /already downloading/);
  assert.deepEqual(asked, ['light'], 'a second download is not started');
});

test('a model without a pinned checksum is refused, not reported as started', async (t) => {
  quiet(t);
  const { ModelManager } = require('../dupe-ai');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const models = new ModelManager({ dir, fetchImpl: async () => { throw new Error('no network in tests'); }, log: () => {} });
  const s = await mount(t, { models });
  const r = await s.post('/models/medium/download');
  assert.notEqual(r.body.started, true);
  assert.equal(r.status, 409);
});

test('thumb and trash file routes take only numeric ids and 404 otherwise', async (t) => {
  const s = await mount(t);
  for (const p of ['/thumb/0', '/thumb/abc', '/thumb/1', '/trash/a1/file', '/trash/g0/file', '/trash/g1/file']) {
    const r = await s.get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body.ok, false);
  }
  // The trash row decides the file; a restored entry is not served.
  const trash = {
    store: { trashGet: (id) => (id === 1 ? { rel: 'a.mp4', restored_at: 1 } : null) },
    trashedFile: () => { throw new Error('must not be asked'); },
  };
  const s2 = await mount(t, { trash });
  assert.equal((await s2.get('/trash/g1/file')).status, 404);
});

// --- the gate in server.js -------------------------------------------------

const SHARED = 'dupe-routes-test-password';
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('server.js puts v2 behind the owner session and refuses cross-site requests', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-routes-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, PORT: String(port), DATA_DIR: data, DOWNLOAD_DIR: path.join(root, 'downloads'),
      GRABBIT_PASSWORD: SHARED, STATE_BACKUP_DAYS: '0', YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
      FFMPEG_BIN: '/bin/false', FFPROBE_BIN: '/bin/false', DUPES_SCAN: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  t.after(() => proc.kill());
  for (let i = 0; i < 100 && !logs.includes('grabbit listening'); i++) await new Promise((r) => setTimeout(r, 100));
  if (!logs.includes('grabbit listening')) throw new Error(`server did not start:\n${logs}`);
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `password=${encodeURIComponent(SHARED)}`,
    redirect: 'manual',
  });
  const cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth='));
  assert.ok(cookie, 'signed in');

  const call = (p, headers = {}, method = 'GET') => fetch(`${base}/api/hub/dupes/v2${p}`, {
    method, headers: { Accept: 'application/json', ...headers }, redirect: 'manual',
  });

  // No session: 401 JSON, not a redirect.
  let r = await call('/overview');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).ok, false);
  r = await call('/scan', { 'Content-Type': 'application/json' }, 'POST');
  assert.equal(r.status, 401);

  // With the session: the router answers.
  r = await call('/overview', { Cookie: cookie });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).ok, true);

  // Cross-site, even with the cookie: 403 before the router.
  for (const h of [
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'https://evil.example.com' },
    { Origin: 'not a url' },
  ]) {
    r = await call('/scan', { Cookie: cookie, ...h }, 'POST');
    assert.equal(r.status, 403, JSON.stringify(h));
    assert.match((await r.json()).error, /Cross-site/);
  }
  // Case does not slip past the check.
  r = await fetch(`${base}/API/hub/dupes/v2/overview`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  // Same-origin with a matching Origin is fine.
  r = await call('/overview', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Origin: base });
  assert.equal(r.status, 200);

  // The scan is off here: a 409 with a reason, not a 5xx.
  r = await fetch(`${base}/api/hub/dupes/v2/scan`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
  });
  assert.ok(r.status < 500, `status ${r.status}`);
});
