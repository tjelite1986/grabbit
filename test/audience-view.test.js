'use strict';
// H4: Grabbit's own surfaces (Media, its detail and file routes, the dashboard
// summary and creator list, the raw history) hand out an entry that is 18+ or
// not classified general only when the request asks for the 18+ view with
// `audience=adult`. Without it such an entry is counted nowhere and its routes
// answer 404, the same as an id that does not exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const profiles = require('../profiles');

const SHARED = 'audience-view-test-password';
const NOW = 1_700_000_000_000;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Three history entries with a file each: general (a creator the owner
// classified general by hand), adult (saved to the 18+ app) and unclassified
// (a creator no profile names).
const ENTRIES = [
  { id: '1700000000003-3', time: NOW + 3, creator: 'Jane Doe', title: 'general clip g1', channel: 'main', dest: 'elite',
    filename: 'Jane Doe_-_general clip g1.mp4', sourceUrl: 'https://www.tiktok.com/@janedoe/video/1001', extractor: 'TikTok' },
  { id: '1700000000002-2', time: NOW + 2, creator: 'Ada', title: 'adult clip a1', channel: '18plus', dest: 'elite',
    filename: 'Ada_-_adult clip a1.mp4', sourceUrl: 'https://www.tiktok.com/@ada/video/2002', extractor: 'TikTok' },
  { id: '1700000000001-1', time: NOW + 1, creator: 'Stranger', title: 'unknown clip u1', channel: 'main', dest: 'elite',
    filename: 'Stranger_-_unknown clip u1.mp4', sourceUrl: 'https://www.tiktok.com/@stranger/video/3003', extractor: 'TikTok' },
];
const [GEN, ADULT, UNK] = ENTRIES;
const REGISTRY = Object.fromEntries(ENTRIES.map((e) => [
  `tiktok.com/@${e.creator.toLowerCase().replace(' ', '')}/video/${e.sourceUrl.split('/').pop()}`,
  { filename: e.filename, at: e.time, channel: e.channel },
]));

async function boot(t, { history = ENTRIES, registry = REGISTRY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-aud-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const tik = path.join(root, 'tik');
  const ads = path.join(root, 'ads');
  fs.mkdirSync(data, { recursive: true });
  for (const e of history) {
    if (!e.filename) continue;
    const dir = e.channel === '18plus' ? path.join(ads, '18plus', '_import') : path.join(tik, 'main', '_import');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, e.filename), `bytes of ${e.id}`);
  }
  let store = profiles.emptyStore();
  for (const p of [{ name: 'Jane Doe', audience: 'general' }, { name: 'Ada', audience: 'adult' }]) store = profiles.create(store, p, NOW).store;
  fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(store));
  fs.writeFileSync(path.join(data, 'history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(data, 'downloaded.json'), JSON.stringify(registry));
  const port = await freePort();
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'loopback-listen.js'), 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, TMPDIR: os.tmpdir(), PORT: String(port), DATA_DIR: data, DOWNLOAD_DIR: path.join(root, 'downloads'),
      GRABBIT_PASSWORD: SHARED, STATE_BACKUP_DAYS: '0', YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
      FFMPEG_BIN: '/bin/false', FFPROBE_BIN: '/bin/false', DUPES_SCAN: 'off', TIKSHORTIS_ROOT: tik, ELITE_ROOT: ads,
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
  const get = (p) => fetch(`${base}${p}`, { headers: { Cookie: cookie, Accept: 'application/json' } });
  const json = async (p) => {
    const r = await get(p);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { base, cookie, get, json, logs: () => logs, root, data };
}

const ids = (items) => items.map((it) => it.id).sort();

test('Media lists only general entries unless the 18+ view asks', async (t) => {
  const s = await boot(t);
  const plain = await s.json('/api/hub/media');
  assert.equal(plain.status, 200);
  assert.deepEqual(ids(plain.body.items), [GEN.id]);
  const adult = await s.json('/api/hub/media?audience=adult');
  assert.deepEqual(ids(adult.body.items), ids(ENTRIES));
  // Any other value is not the 18+ view.
  const other = await s.json('/api/hub/media?audience=general');
  assert.deepEqual(ids(other.body.items), [GEN.id]);
});

test('detail and file routes answer 404 for 18+ and unclassified entries without the 18+ view', async (t) => {
  const s = await boot(t);
  for (const e of [ADULT, UNK]) {
    const d = await s.json(`/api/hub/media/${e.id}`);
    assert.equal(d.status, 404, `${e.title} detail`);
    assert.equal(JSON.stringify(d.body).includes(e.creator), false);
    const f = await s.get(`/api/hub/media/${e.id}/file?v=original`);
    assert.equal(f.status, 404, `${e.title} file`);
    const body = await f.text();
    assert.equal(body.includes('bytes of'), false);
    const d2 = await s.json(`/api/hub/media/${e.id}?audience=adult`);
    assert.equal(d2.status, 200, `${e.title} detail in the 18+ view`);
    const f2 = await s.get(`/api/hub/media/${e.id}/file?v=original&audience=adult`);
    assert.equal(f2.status, 200, `${e.title} file in the 18+ view`);
    assert.equal(await f2.text(), `bytes of ${e.id}`);
  }
  assert.equal((await s.json(`/api/hub/media/${GEN.id}`)).status, 200);
  assert.equal((await s.get(`/api/hub/media/${GEN.id}/file?v=original`)).status, 200);
});

test('the raw history leaves out 18+ and unclassified entries unless the 18+ view asks', async (t) => {
  const s = await boot(t);
  const plain = await s.json('/api/history');
  assert.deepEqual(ids(plain.body.items), [GEN.id]);
  assert.equal(JSON.stringify(plain.body).includes('Ada'), false);
  assert.equal(JSON.stringify(plain.body).includes('Stranger'), false);
  const adult = await s.json('/api/history?audience=adult');
  assert.deepEqual(ids(adult.body.items), ids(ENTRIES));
});

test('a no-file history entry named above the Media grid follows the same rule', async (t) => {
  const failed = { id: '1700000000009-9', time: NOW + 9, creator: 'Ada', title: 'refused adult', channel: 'main', dest: 'elite',
    filename: null, sourceUrl: 'https://www.tiktok.com/@ada/video/9009', error: 'refused' };
  const s = await boot(t, { history: [failed, ...ENTRIES] });
  const plain = await s.json('/api/hub/media');
  assert.deepEqual(plain.body.misses, []);
  const adult = await s.json('/api/hub/media?audience=adult');
  assert.deepEqual(adult.body.misses.map((m) => m.id), [failed.id]);
});

test('the dashboard summary and the creator list count general entries only', async (t) => {
  const s = await boot(t);
  const sum = await s.json('/api/hub/summary');
  assert.equal(sum.status, 200);
  assert.equal(sum.body.files, 1);
  assert.equal(sum.body.creators, 1);
  const sumAdult = await s.json('/api/hub/summary?audience=adult');
  assert.equal(sumAdult.body.files, 3);
  const cr = await s.json('/api/hub/creators');
  assert.deepEqual(cr.body.items.map((c) => c.name), ['Jane Doe']);
  const crAdult = await s.json('/api/hub/creators?audience=adult');
  assert.deepEqual(crAdult.body.items.map((c) => c.name).sort(), ['Ada', 'Jane Doe', 'Stranger']);
});

test('a file name is general only when every registry row naming it is', async (t) => {
  // The same file reached through a second, 18+ registry row (the id key of a
  // save into the 18+ app) is not counted on a general surface.
  const registry = { ...REGISTRY, 'id:tiktok:1001': { filename: GEN.filename, at: GEN.time, channel: '18plus' } };
  const s = await boot(t, { registry });
  const sum = await s.json('/api/hub/summary');
  assert.equal(sum.body.files, 0);
});
