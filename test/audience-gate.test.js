'use strict';
// End to end, without the network: the server runs with the extractors
// replaced by fixtures (test/fixtures/fake-extractors.js) and every download
// served from a loopback server in this process. Each test saves through the
// real routes and then reads the app folders: an 18+ or unclassified item
// must never leave a single byte in a general app's folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const profiles = require('../profiles');
const itemStore = require('../item-store');

const SHARED = 'gate-test-password';
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

// Every request gets different bytes, so content hashes never collide by accident.
let served = 0;
function mediaServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      served++;
      const body = Buffer.from(`fixture ${req.url} ${served} ${Math.random()}`);
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'Content-Length': body.length });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Every file under dir, relative, dotfiles included.
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

// Boots a server with every app root configured and these profiles in the
// store, and returns helpers. `seed` may also hold a downloaded.json.
async function boot(t, { profileList = [], registry = null, breakItemStore = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = await mediaServer();
  t.after(() => media.close());
  const apps = { tik: path.join(root, 'tik'), ads: path.join(root, 'ads'), plat: path.join(root, 'plat'), posts: path.join(root, 'posts') };
  for (const d of Object.values(apps)) fs.mkdirSync(d, { recursive: true });
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let store = profiles.emptyStore();
  for (const p of profileList) store = profiles.create(store, p, NOW).store;
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(store));
  if (registry) fs.writeFileSync(path.join(dataDir, 'downloaded.json'), JSON.stringify(registry));
  if (breakItemStore) fs.mkdirSync(path.join(dataDir, 'items.db'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    PORT: String(port),
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: path.join(root, 'downloads'),
    GRABBIT_PASSWORD: SHARED,
    STATE_BACKUP_DAYS: '0',
    YTDLP_BIN: '/bin/false',
    GALLERY_DL_BIN: '/bin/false',
    FFMPEG_BIN: '/bin/false',
    FFPROBE_BIN: '/bin/false',
    ALLOW_PRIVATE_ADDRESSES: 'true',
    FAKE_MEDIA_BASE: `http://127.0.0.1:${media.address().port}`,
    ELITE_ROOT: apps.ads,
    TIKSHORTIS_ROOT: apps.tik,
    PLATFORM_IMPORT_ROOT: apps.plat,
    ELITE_POSTS_ROOT: apps.posts,
  };
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'fake-extractors.js'), 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env,
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
  const headers = { Cookie: cookie, Accept: 'application/json' };

  const fakeUrl = (kind, site, creator, id) =>
    `http://fake.test/${kind}/${encodeURIComponent(site)}/${encodeURIComponent(creator)}/${encodeURIComponent(id)}`;

  // The synchronous route co-hosted apps call.
  async function save(url, channel, extra = {}) {
    const q = new URLSearchParams({ url, dest: 'elite', channel, device: '0', ...extra });
    const r = await fetch(`${base}/api/download?${q}`, { headers });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { text }; }
    return { status: r.status, body };
  }

  // The background job route the web UI uses; waits for the job to end.
  async function saveJob(url, channel, extra = {}) {
    const q = new URLSearchParams({ url, dest: 'elite', channel, device: '0', ...extra });
    const r = await fetch(`${base}/api/jobs/start?${q}`, { headers });
    const started = await r.json();
    if (r.status !== 200) return { status: r.status, body: started };
    const id = started.jobId;
    for (let i = 0; i < 100; i++) {
      const { jobs } = await (await fetch(`${base}/api/jobs`, { headers })).json();
      const j = jobs.find((x) => x.id === id);
      if (j && ['done', 'error', 'failed', 'cancelled'].includes(j.status)) return { status: 200, job: j };
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`job ${id} did not finish:\n${logs}`);
  }

  function items() {
    const s = itemStore.open(path.join(dataDir, 'items.db'));
    try {
      return {
        rows: s.db.prepare('SELECT * FROM items ORDER BY id').all(),
        deliveries: s.db.prepare('SELECT d.*, i.key FROM deliveries d JOIN items i ON i.id = d.item_id ORDER BY d.id').all(),
      };
    } finally {
      s.close();
    }
  }

  const generalFiles = () => [...filesUnder(apps.tik), ...filesUnder(apps.plat), ...filesUnder(apps.posts)];
  return { apps, dataDir, save, saveJob, fakeUrl, items, generalFiles, logs: () => logs, headers, base };
}

test('an unclassified creator reaches no general app, by any route', async (t) => {
  const s = await boot(t);
  for (const channel of ['main', 'platform']) {
    const r = await s.save(s.fakeUrl('video', 'tiktok', 'stranger', `v-${channel}`), channel);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, /not classified/);
  }
  const img = await s.save(s.fakeUrl('image', 'instagram', 'stranger', 'p1'), 'main');
  assert.equal(img.status, 422, JSON.stringify(img.body));
  const job = await s.saveJob(s.fakeUrl('video', 'tiktok', 'stranger', 'v-job'), 'main');
  assert.match(String(job.job && job.job.error), /not classified/);
  const nameless = await s.save(s.fakeUrl('video', 'tiktok', '-', 'v-none'), 'main');
  assert.equal(nameless.status, 422);
  assert.deepEqual(s.generalFiles(), []);
  const { deliveries } = s.items();
  assert.ok(deliveries.length >= 4);
  assert.ok(deliveries.every((d) => d.status === 'refused'));
});

test('a general creator is delivered, and the delivery is recorded', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  const v = await s.save(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'g1'), 'main');
  assert.equal(v.status, 200, JSON.stringify(v.body) + s.logs());
  const img = await s.save(s.fakeUrl('image', 'instagram', 'Jane Doe', 'g2'), 'main');
  assert.equal(img.status, 200, JSON.stringify(img.body) + s.logs());
  const job = await s.saveJob(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'g3'), 'platform');
  assert.equal(job.job.status, 'done', JSON.stringify(job.job) + s.logs());
  assert.equal(s.generalFiles().filter((f) => !f.endsWith('.md') && !f.endsWith('.json')).length, 3, s.generalFiles().join('\n'));
  assert.deepEqual(filesUnder(s.apps.ads), []);
  const { rows, deliveries } = s.items();
  assert.deepEqual(rows.map((r) => r.audience), ['general', 'general', 'general']);
  assert.deepEqual(deliveries.map((d) => `${d.destination}:${d.status}`).sort(), ['main:dropped', 'platform:dropped', 'posts:dropped']);
  // The content hash is filled in after the drop.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(s.items().rows.every((r) => /^[0-9a-f]{64}$/.test(r.sha256 || '')), JSON.stringify(s.items().rows));
});

test('18+ material never reaches a general app: adult profile, adult site, adult history', async (t) => {
  const s = await boot(t, {
    profileList: [
      { name: 'Jane Doe', audience: 'general' },
      { name: 'Ada', audience: 'adult' },
      { name: 'Twin', audience: 'general' },
      { name: 'Twin', audience: 'adult' },
    ],
  });
  const cases = [
    ['adult profile', s.fakeUrl('video', 'tiktok', 'Ada', 'a1')],
    ['same name in both audiences', s.fakeUrl('video', 'tiktok', 'Twin', 'a2')],
    ['18+ site, general creator', s.fakeUrl('video', 'redgifs.com', 'Jane Doe', 'a3')],
    ['18+ extractor slug', s.fakeUrl('video', 'xxxfollow', 'Jane Doe', 'a4')],
  ];
  for (const [label, url] of cases) {
    for (const channel of ['main', 'platform']) {
      const r = await s.save(url, channel);
      assert.equal(r.status, 422, `${label} -> ${channel}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /18\+/, label);
    }
    const job = await s.saveJob(url, 'main');
    assert.match(String(job.job && job.job.error), /18\+/, `${label} (job)`);
  }
  for (const [label, url] of [
    ['adult image', s.fakeUrl('image', 'instagram', 'Ada', 'i1')],
    ['18+ site image', s.fakeUrl('image', 'erome.com', 'Jane Doe', 'i2')],
  ]) {
    const r = await s.save(url, 'main');
    assert.equal(r.status, 422, `${label}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /18\+/, label);
  }
  assert.deepEqual(s.generalFiles(), []);
});

test("an item's own 18+ flag beats a general profile, by every route and app", async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general', accounts: [{ platform: 'tiktok', handle: 'jane doe' }] }] });
  const flagged = (kind, id) => `${s.fakeUrl(kind, 'tiktok', 'Jane Doe', id)}?adult=1`;
  for (const channel of ['main', 'platform']) {
    const r = await s.save(flagged('video', `f-${channel}`), channel);
    assert.equal(r.status, 422, `${channel}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /18\+/);
    const job = await s.saveJob(flagged('video', `fj-${channel}`), channel);
    assert.match(String(job.job && job.job.error), /18\+/, `${channel} (job): ${JSON.stringify(job)}`);
  }
  const img = await s.save(flagged('image', 'f-img'), 'main');
  assert.equal(img.status, 422, JSON.stringify(img.body));
  assert.match(img.body.error, /18\+/);
  // A renamed creator does not wash the flag off either.
  const renamed = await s.save(flagged('video', 'f-rn'), 'main', { creator: 'Jane Doe' });
  assert.equal(renamed.status, 422, JSON.stringify(renamed.body));
  assert.deepEqual(s.generalFiles(), []);
  // The same flagged item may go to Adshortis, and is then recorded 18+.
  const ok = await s.save(flagged('video', 'f-ads'), '18plus');
  assert.equal(ok.status, 200, JSON.stringify(ok.body) + s.logs());
  const back = await s.save(flagged('video', 'f-ads').replace('?adult=1', ''), 'main');
  assert.equal(back.status, 422, 'the unflagged link to the same item is still 18+');
  assert.match(back.body.error, /recorded as 18\+/);
  assert.deepEqual(s.generalFiles(), []);
});

test('18+ images are refused by Adshortis too and land nowhere', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Ada', audience: 'adult' }] });
  const r = await s.save(s.fakeUrl('image', 'erome.com', 'Ada', 'i9'), '18plus');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /videos only/);
  const job = await s.saveJob(s.fakeUrl('image', 'erome.com', 'Ada', 'i10'), '18plus');
  assert.match(String(job.job && job.job.error), /videos only/);
  assert.deepEqual(s.generalFiles(), []);
  assert.deepEqual(filesUnder(s.apps.ads), []);
});

test('audio=1 does not let an image past the gate, by either route', async (t) => {
  // A general creator, so only the 18+ channel choice stands between this
  // image and the general posts library.
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  const r = await s.save(s.fakeUrl('image', 'instagram', 'Jane Doe', 'au1'), '18plus', { audio: '1' });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /videos only/);
  const job = await s.saveJob(s.fakeUrl('image', 'instagram', 'Jane Doe', 'au2'), '18plus', { audio: '1' });
  assert.match(String(job.job && job.job.error), /videos only/, JSON.stringify(job));
  const stranger = await s.save(s.fakeUrl('image', 'instagram', 'stranger', 'au3'), 'main', { audio: '1' });
  assert.equal(stranger.status, 422, JSON.stringify(stranger.body));
  assert.deepEqual(s.generalFiles(), []);
  assert.deepEqual(filesUnder(s.apps.ads), []);
});

test('Adshortis takes adult and unclassified videos, and the item stays 18+ for good', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  // A job tightens: an item first saved to Adshortis is adult, so the same
  // item can no longer go to a general app, even under a general creator.
  const url = s.fakeUrl('video', 'tiktok', 'Jane Doe', 'sticky');
  const adult = await s.save(url, '18plus');
  assert.equal(adult.status, 200, JSON.stringify(adult.body) + s.logs());
  const after = await s.save(url, 'main');
  assert.equal(after.status, 422, JSON.stringify(after.body));
  assert.match(after.body.error, /recorded as 18\+/);
  const stranger = await s.save(s.fakeUrl('video', 'tiktok', 'stranger', 'x1'), '18plus');
  assert.equal(stranger.status, 200, JSON.stringify(stranger.body));
  assert.deepEqual(s.generalFiles(), []);
  const { rows } = s.items();
  assert.ok(rows.every((r) => r.audience === 'adult'), JSON.stringify(rows));
});

test('renaming the creator cannot borrow a general profile', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }, { name: 'Ada', audience: 'adult' }] });
  for (const site of ['tiktok']) {
    for (const who of ['Ada', 'stranger']) {
      const url = s.fakeUrl('video', site, who, `rn-${who}`);
      const r = await s.save(url, 'main', { creator: 'Jane Doe' });
      assert.equal(r.status, 422, `${who}: ${JSON.stringify(r.body)}`);
      const job = await s.saveJob(url, 'main', { creator: 'Jane Doe' });
      assert.ok(job.job && job.job.status !== 'done', `${who} (job): ${JSON.stringify(job)}`);
    }
  }
  assert.deepEqual(s.generalFiles(), []);
});

test('without its item store the server delivers nothing to a general app', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }], breakItemStore: true });
  assert.match(s.logs(), /items\.db could not be opened/);
  const r = await s.save(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'nb1'), 'main');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /item store is unavailable/);
  assert.deepEqual(s.generalFiles(), []);
});

test('boot imports the registry without touching downloaded.json or profiles.json', async (t) => {
  const registry = {
    'example.com/v/1': { filename: 'alice_-_one.mp4', at: 1, channel: 'main' },
    'id:example:1': { filename: 'alice_-_one.mp4', at: 1, channel: 'main' },
    'id:example:2': { filename: 'bob_-_two.mp4', at: 2, channel: '18plus' },
  };
  const s = await boot(t, { registry });
  const reg = fs.readFileSync(path.join(s.dataDir, 'downloaded.json'), 'utf8');
  const prof = fs.readFileSync(path.join(s.dataDir, 'profiles.json'), 'utf8');
  assert.match(s.logs(), /registry has 2 items, 2 added/);
  assert.equal(reg, JSON.stringify(registry));
  assert.equal(JSON.parse(prof).profiles.length, 0);
  const { rows } = s.items();
  assert.deepEqual(rows.map((r) => `${r.key}=${r.audience}`), ['id:example:1=unknown', 'id:example:2=adult']);
});

test('review queue: a creator once delivered is refused until classified by hand, and 18+ never goes back', async (t) => {
  const registry = {
    'id:tiktok:old1': { filename: 'Jane Doe_-_old clip old1.mp4', at: 1, channel: 'main' },
    'id:tiktok:old2': { filename: 'Max_-_old clip old2.mp4', at: 2, channel: 'platform' },
  };
  const s = await boot(t, { registry });
  const jpost = (p, body) =>
    fetch(`${s.base}${p}`, { method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  const jget = (p) => fetch(`${s.base}${p}`, { headers: s.headers }).then((r) => r.json());

  // Delivered before, but that is no classification.
  const before = await s.save(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'n1'), 'main');
  assert.equal(before.status, 422, JSON.stringify(before.body));
  assert.match(before.body.error, /not classified/);

  const queue = await jget('/api/hub/review/creators?q=jane');
  assert.equal(queue.total, 1, JSON.stringify(queue));
  const jane = queue.items[0];
  assert.equal(jane.status, 'unknown');

  // Bulk "all matching" must name the count the owner saw.
  const stale = await jpost('/api/hub/review/creators', { audience: 'general', all: true, q: 'jane', expected: 5 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const ok = await jpost('/api/hub/review/creators', { audience: 'general', all: true, q: 'jane', expected: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.changed, [jane.id]);
  const after = await s.save(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'n1'), 'main');
  assert.equal(after.status, 200, JSON.stringify(after.body) + s.logs());

  // 18+ by hand, then general again is refused per id.
  const max = (await jget('/api/hub/review/creators?q=max')).items[0];
  assert.equal((await jpost('/api/hub/review/creators', { audience: 'adult', ids: [max.id] })).body.changed[0], max.id);
  const back = await jpost('/api/hub/review/creators', { audience: 'general', ids: [max.id, jane.id] });
  assert.deepEqual(back.body.changed, []);
  assert.match(back.body.skipped.find((x) => x.id === max.id).reason, /never classified general/);
  const maxSave = await s.save(s.fakeUrl('video', 'tiktok', 'Max', 'm1'), 'main');
  assert.equal(maxSave.status, 422);
  assert.match(maxSave.body.error, /18\+/);

  // A refused item shows up in the item queue; classified general by hand it goes through.
  const url = s.fakeUrl('video', 'tiktok', 'stranger', 's1');
  assert.equal((await s.save(url, 'main')).status, 422);
  const items = await jget('/api/hub/review/items?refused=1');
  const row = items.items.find((r) => r.creator === 'stranger');
  assert.ok(row, JSON.stringify(items));
  assert.match(row.last_refusal, /not classified/);
  assert.deepEqual((await jpost('/api/hub/review/items', { audience: 'general', ids: [row.id] })).body.changed, [row.id]);
  const delivered = await s.save(url, 'main');
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  // Another clip by the same stranger is still refused: the item was classified, not the creator.
  assert.equal((await s.save(s.fakeUrl('video', 'tiktok', 'stranger', 's2'), 'main')).status, 422);

  // An 18+ item is never classified general.
  const adultUrl = s.fakeUrl('video', 'redgifs.com', 'stranger', 'r1');
  assert.equal((await s.save(adultUrl, '18plus')).status, 200);
  const adultRow = s.items().rows.find((r) => r.audience === 'adult');
  const refused = await jpost('/api/hub/review/items', { audience: 'general', ids: [adultRow.id] });
  assert.deepEqual(refused.body.changed, []);
  assert.equal((await s.save(adultUrl, 'main')).status, 422);
  assert.equal((await jpost('/api/hub/review/items', { audience: 'maybe', ids: [1] })).status, 400);
});

test('reddclips reaches no general app without a hand classification', async (t) => {
  const registry = { 'id:reddclips:old': { filename: 'someuser_-_old old.mp4', at: 1, channel: 'main' } };
  const s = await boot(t, { registry });
  for (const creator of ['-', 'someuser']) {
    const r = await s.save(s.fakeUrl('video', 'reddclips', creator, `rc-${creator}`), 'main');
    assert.equal(r.status, 422, `${creator}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /not classified/);
  }
  assert.deepEqual(s.generalFiles(), []);
});
