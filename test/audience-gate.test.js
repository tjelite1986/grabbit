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
async function boot(t, { profileList = [], registry = null, breakItemStore = false, corruptItemStore = false, egram = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = await mediaServer();
  t.after(() => media.close());
  const apps = { tik: path.join(root, 'tik'), ads: path.join(root, 'ads'), plat: path.join(root, 'plat'), posts: path.join(root, 'posts'), egram: path.join(root, 'egram') };
  for (const d of Object.values(apps)) fs.mkdirSync(d, { recursive: true });
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let store = profiles.emptyStore();
  for (const p of profileList) store = profiles.create(store, p, NOW).store;
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(store));
  if (registry) fs.writeFileSync(path.join(dataDir, 'downloaded.json'), JSON.stringify(registry));
  if (breakItemStore) fs.mkdirSync(path.join(dataDir, 'items.db'));
  if (corruptItemStore) fs.writeFileSync(path.join(dataDir, 'items.db'), Buffer.alloc(8192, 0x5a));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    TMPDIR: os.tmpdir(),
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
    ...(egram ? { POSTS_TO_EGRAM: '1', EGRAM_IMPORT_DIR: apps.egram } : {}),
  };
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'loopback-listen.js'), '-r', path.join(__dirname, 'fixtures', 'fake-extractors.js'), 'server.js'], {
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
      const { jobs } = await (await fetch(`${base}/api/jobs?audience=adult`, { headers })).json();
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

// A broken items.db (not a database) and an unavailable one (cannot be opened)
// must both stop every app delivery, by both routes, for a creator that would
// otherwise pass: general to the general apps, adult to Adshortis. There is no
// fallback to delivering unrecorded.
for (const [what, opts] of [
  ['an unavailable', { breakItemStore: true }],
  ['a corrupt', { corruptItemStore: true }],
]) {
  test(`with ${what} items.db no app receives anything, by either route`, async (t) => {
    const s = await boot(t, {
      profileList: [{ name: 'Jane Doe', audience: 'general' }, { name: 'Ada', audience: 'adult' }],
      ...opts,
    });
    assert.match(s.logs(), /items\.db could not be opened/);
    const cases = [
      ['video', 'Jane Doe', 'main'],
      ['video', 'Jane Doe', 'platform'],
      ['image', 'Jane Doe', 'main'], // lands in the posts library
      ['video', 'Ada', '18plus'],
    ];
    for (const [kind, who, channel] of cases) {
      const tag = `${kind}/${who}/${channel}`;
      const r = await s.save(s.fakeUrl(kind, 'tiktok', who, `nb-${kind}-${channel}`), channel);
      assert.equal(r.status, 422, `${tag}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /item store is unavailable/, tag);
      const job = await s.saveJob(s.fakeUrl(kind, 'tiktok', who, `nbj-${kind}-${channel}`), channel);
      assert.notEqual(job.job && job.job.status, 'done', `${tag} (job): ${JSON.stringify(job)}`);
      assert.match(String(job.job && job.job.error), /item store is unavailable/, `${tag} (job)`);
    }
    assert.deepEqual(s.generalFiles(), []);
    assert.deepEqual(filesUnder(s.apps.ads), []);
  });
}

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

test('review groups: a whole group is classified only with its exact count, and only that group', async (t) => {
  const registry = {
    'id:tiktok:a1': { filename: 'Jane Doe_-_a a1.mp4', at: 1, channel: 'main' },
    'id:tiktok:a2': { filename: 'Kim_-_b a2.mp4', at: 2, channel: 'main' },
    'id:tiktok:a3': { filename: 'Max_-_c a3.mp4', at: 3, channel: 'platform' },
    'id:tiktok:a4': { filename: 'Lo_-_d a4.mp4', at: 4 },
    'id:redgifs:a5': { filename: 'Rex_-_e a5.mp4', at: 5, channel: '18plus' },
  };
  const s = await boot(t, { registry });
  const jpost = (p, body) =>
    fetch(`${s.base}${p}`, { method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  const jget = (p) => fetch(`${s.base}${p}`, { headers: s.headers }).then((r) => r.json());

  const { groups } = await jget('/api/hub/review/groups');
  assert.deepEqual(groups.map((g) => `${g.group}=${g.count}`), ['tiktok | main=2', 'tiktok | none=1', 'tiktok | platform=1']);
  const main = groups[0];
  const listed = await jget(`/api/hub/review/creators?group=${encodeURIComponent(main.group)}`);
  assert.deepEqual(listed.items.map((p) => p.name).sort(), ['Jane Doe', 'Kim']);

  // No count, a wrong count, or a group that is not a string: nothing is classified.
  assert.equal((await jpost('/api/hub/review/creators', { audience: 'general', all: true, group: main.group })).status, 409);
  assert.equal((await jpost('/api/hub/review/creators', { audience: 'general', all: true, group: main.group, expected: 4 })).status, 409);
  assert.equal((await jpost('/api/hub/review/creators', { audience: 'general', all: true, group: ['x'], expected: 2 })).status, 400);
  assert.equal((await jget('/api/hub/review')).creators.unclassified, 4);

  const ok = await jpost('/api/hub/review/creators', { audience: 'general', all: true, q: '', group: main.group, expected: 2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.changed.length, 2);
  const left = (await jget('/api/hub/review/groups')).groups;
  assert.deepEqual(left.map((g) => g.group), ['tiktok | none', 'tiktok | platform']);
  assert.equal((await s.save(s.fakeUrl('video', 'tiktok', 'Kim', 'k1'), 'main')).status, 200);
  assert.equal((await s.save(s.fakeUrl('video', 'tiktok', 'Max', 'm1'), 'main')).status, 422);
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

test('classify-retry: one click sends a refused unclassified item, never an 18+ one', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Adult Star', audience: 'adult' }] });
  const post = (p) => fetch(`${s.base}${p}`, { method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: '{}' });
  const waitJob = async (id) => {
    for (let i = 0; i < 100; i++) {
      const { jobs } = await (await fetch(`${s.base}/api/jobs`, { headers: s.headers })).json();
      const j = jobs.find((x) => x.id === id);
      if (j && ['done', 'error', 'cancelled'].includes(j.status)) return j;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`job ${id} did not finish:\n${s.logs()}`);
  };

  // Unclassified creator: refused, then classified by the click and delivered.
  const refused = await s.saveJob(s.fakeUrl('video', 'tiktok', 'newcomer', 'cr1'), 'platform');
  assert.match(String(refused.job.error), /not classified/);
  const r = await post(`/api/jobs/${encodeURIComponent(refused.job.id)}/classify-retry`);
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body) + s.logs());
  const retried = await waitJob(body.jobId);
  assert.equal(retried.status, 'done', JSON.stringify(retried) + s.logs());
  const { rows, deliveries } = s.items();
  const item = rows.find((x) => x.id === body.itemId);
  assert.equal(item.audience, 'general');
  assert.equal(item.classified_by_hand, 1);
  assert.deepEqual(deliveries.filter((d) => d.item_id === item.id).map((d) => d.status), ['refused', 'dropped']);
  // Only the item: the creator stays unclassified, so their next video is refused again.
  const next = await s.saveJob(s.fakeUrl('video', 'tiktok', 'newcomer', 'cr2'), 'platform');
  assert.match(String(next.job.error), /not classified/);

  // 18+: refused for a general app, and the click cannot make it general.
  const adult = await s.saveJob(s.fakeUrl('video', 'tiktok', 'Adult Star', 'cr3'), 'main');
  assert.match(String(adult.job.error), /18\+/);
  const a = await post(`/api/jobs/${encodeURIComponent(adult.job.id)}/classify-retry`);
  assert.ok(a.status >= 400, `expected a refusal, got ${a.status}`);
  assert.equal(s.items().rows.find((x) => x.key && x.audience === 'adult' && x.classified_by_hand === 1), undefined);

  // A finished job is not a refused one.
  const done = await post(`/api/jobs/${encodeURIComponent(retried.id)}/classify-retry`);
  assert.equal(done.status, 400);

  const delivered = s.generalFiles().filter((f) => !f.endsWith('.md') && !f.endsWith('.json'));
  assert.equal(delivered.length, 1, delivered.join('\n'));
});

// --- read-only route preview ---------------------------------------------------

const snapshot = (s) => JSON.stringify({ ...s.items(), tik: filesUnder(s.apps.tik), ads: filesUnder(s.apps.ads), plat: filesUnder(s.apps.plat), posts: filesUnder(s.apps.posts) });

async function preview(s, qs) {
  const r = await fetch(`${s.base}/api/hub/route-preview?${new URLSearchParams(qs)}`, { headers: s.headers });
  return { status: r.status, body: await r.json() };
}

test('route preview: same verdicts as the gate, and no side effects', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  // Known items: one general, one unclassified (refused on save), one 18+ site.
  assert.equal((await s.save(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'p1'), 'main')).status, 200);
  assert.equal((await s.save(s.fakeUrl('video', 'tiktok', 'stranger', 'p2'), 'main')).status, 422);
  assert.equal((await s.save(s.fakeUrl('video', 'redgifs', 'someone', 'p3'), 'main')).status, 422);
  const keyOf = (id) => s.items().rows.find((r) => r.key.endsWith(`:${id}`) || r.key.includes(id)).key;
  const before = snapshot(s);

  const ok = await preview(s, { channel: 'main', key: keyOf('p1') });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.allowed, true);
  assert.equal(ok.body.destination, 'main');

  const unk = await preview(s, { channel: 'main', key: keyOf('p2') });
  assert.equal(unk.body.allowed, false);
  assert.match(unk.body.reason, /not classified/);

  const adult = await preview(s, { channel: 'main', key: keyOf('p3') });
  assert.equal(adult.body.allowed, false);
  assert.match(adult.body.reason, /18\+/);
  // 18+ risk is never "general allowed" on the 18+ channel's behalf either: the
  // adult item may go to the 18+ app only, as a video.
  const toAds = await preview(s, { channel: '18plus', key: keyOf('p3') });
  assert.equal(toAds.body.allowed, true);
  assert.equal(toAds.body.destination, '18plus');
  // A general-looking channel for an adult item through platform is refused.
  assert.equal((await preview(s, { channel: 'platform', key: keyOf('p3') })).body.allowed, false);

  // Lookup by URL works too, and nothing was written by any of it.
  const byUrl = await preview(s, { channel: 'main', url: s.fakeUrl('video', 'tiktok', 'Jane Doe', 'p1') });
  assert.equal(byUrl.body.allowed, true, JSON.stringify(byUrl.body));
  assert.equal(snapshot(s), before);
});

test('route preview: unknown channel, unknown item and missing input', async (t) => {
  const s = await boot(t);
  const before = snapshot(s);
  assert.equal((await preview(s, { channel: 'nope', key: 'x' })).status, 400);
  assert.equal((await preview(s, { channel: 'main' })).status, 400);
  const miss = await preview(s, { channel: 'main', url: 'https://example.com/never/seen' });
  assert.equal(miss.status, 404);
  assert.equal(miss.body.known, false);
  assert.equal(snapshot(s), before);
});

test('route preview needs the API login', async (t) => {
  const s = await boot(t);
  const r = await fetch(`${s.base}/api/hub/route-preview?channel=main&key=x`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
  assert.notEqual(r.status, 200);
  assert.notEqual(r.status, 404);
});

test('posts to Elitogram: a second source with the same name is published under its own name, by either route', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }], egram: true });
  const url = (id) => `${s.fakeUrl('image', 'instagram', 'Jane Doe', id)}?title=same`;
  const first = await s.save(url('a1'), 'main');
  assert.equal(first.status, 200, JSON.stringify(first.body) + s.logs());
  assert.equal(first.body.saved, true);
  // Same title and extension, another source: the exact name already exists.
  const second = await s.save(url('a2'), 'main');
  assert.equal(second.status, 200, JSON.stringify(second.body) + s.logs());
  assert.equal(second.body.saved, true, 'the second source was skipped on the file name alone');
  assert.notEqual(second.body.filename, first.body.filename);
  const third = await s.saveJob(url('a3'), 'main');
  assert.equal(third.job.status, 'done', JSON.stringify(third.job) + s.logs());
  // The first source again is a no-op.
  const again = await s.save(url('a1'), 'main');
  assert.equal(again.body.saved, false);
  const files = filesUnder(s.apps.egram);
  const images = files.filter((f) => f.endsWith('.jpg'));
  const sidecars = files.filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(s.apps.egram, f), 'utf8')));
  assert.equal(images.length, 3, files.join('\n'));
  assert.equal(new Set(sidecars.map((x) => x.source_id)).size, 3);
});

// --- Smart Video Routing (Settings spec 2026-11-21) --------------------------
// route=smart on the job route: the server picks the destination from the
// orientation, the source and the audience. Review never reaches a general app.

const smartJob = (s, url) => s.saveJob(url, 'main', { route: 'smart' });
const portrait = '?w=1080&h=1920';
const landscape = '?w=1920&h=1080';
const mediaFiles = (dir) => filesUnder(dir).filter((f) => !f.endsWith('.md') && !f.endsWith('.json'));

test('smart route: portrait from a General source and a general creator goes to Shorts at any length', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  // 40 minutes: far past the shorts length cap, which a smart portrait route lifts.
  const r = await smartJob(s, s.fakeUrl('video', 'tiktok', 'Jane Doe', 'p1') + portrait + '&dur=2400');
  assert.equal(r.job.status, 'done', JSON.stringify(r.job) + s.logs());
  assert.equal(r.job.route.route, 'shorts');
  assert.equal(r.job.route.orientation, 'portrait');
  assert.equal(mediaFiles(s.apps.tik).length, 1, filesUnder(s.apps.tik).join('\n'));
});

test('smart route: an unclassified creator from a General source waits in Review', async (t) => {
  const s = await boot(t);
  const r = await smartJob(s, s.fakeUrl('video', 'tiktok', 'stranger', 'p2') + portrait);
  assert.equal(r.job.status, 'done', JSON.stringify(r.job) + s.logs());
  assert.equal(r.job.route.route, 'review');
  assert.match(r.job.route.reasons.join(' '), /not classified General/);
  assert.deepEqual(s.generalFiles(), []);
  const root = path.dirname(s.dataDir);
  assert.equal(filesUnder(path.join(root, 'downloads', 'review')).length, 1);
});

test('smart route: landscape goes to Long Videos, square and unknown orientation to Review', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  const root = path.dirname(s.dataDir);
  const wide = await smartJob(s, s.fakeUrl('video', 'youtube', 'Jane Doe', 'l1') + landscape);
  assert.equal(wide.job.route.route, 'long-videos', JSON.stringify(wide.job));
  assert.equal(filesUnder(path.join(root, 'downloads', 'videos')).length, 1);
  const square = await smartJob(s, s.fakeUrl('video', 'instagram', 'Jane Doe', 's1') + '?w=1080&h=1080');
  assert.equal(square.job.route.route, 'review');
  assert.equal(square.job.route.orientation, 'square');
  const unknown = await smartJob(s, s.fakeUrl('video', 'facebook', 'Jane Doe', 'u1'));
  assert.equal(unknown.job.route.route, 'review');
  assert.equal(unknown.job.route.orientation, 'unknown');
  assert.equal(filesUnder(path.join(root, 'downloads', 'review')).length, 2);
  assert.deepEqual(mediaFiles(s.apps.tik), []);
});

test('smart route: Review and unknown sources stay out of Shorts, and 18+ always wins', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  const root = path.dirname(s.dataDir);
  for (const site of ['fikfap', 'brandnewsite']) {
    const r = await smartJob(s, s.fakeUrl('video', site, 'Jane Doe', `r-${site}`) + portrait);
    assert.equal(r.job.route.route, 'review', JSON.stringify(r.job));
    assert.equal(r.job.route.sourceClass, 'review');
  }
  // RedGIFs is Review in the table, but it is an 18+ site, and 18+ wins.
  const red = await smartJob(s, s.fakeUrl('video', 'redgifs', 'Jane Doe', 'a1') + portrait);
  assert.equal(red.job.route.route, 'shorts-18', JSON.stringify(red.job));
  // A General source with an 18+ flag on the item: still 18+.
  const flagged = await smartJob(s, s.fakeUrl('video', 'tiktok', 'Jane Doe', 'a2') + landscape + '&adult=1');
  assert.equal(flagged.job.route.route, 'adults', JSON.stringify(flagged.job));
  assert.equal(filesUnder(path.join(root, 'downloads', 'adults')).length, 1);
  assert.equal(mediaFiles(s.apps.ads).length, 1);
  assert.deepEqual(mediaFiles(s.apps.tik), []);
  assert.deepEqual(s.generalFiles().filter((f) => !f.endsWith('.md') && !f.endsWith('.json')), []);
  // Every decision is traceable in the routing log.
  const log = fs.readFileSync(path.join(s.dataDir, 'routing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.route), ['review', 'review', 'shorts-18', 'adults']);
  assert.ok(log.every((l) => l.reasons.length && l.sourceUrl && l.at));
});

test('smart route: only for video saves to Shorts or the server library', async (t) => {
  const s = await boot(t);
  for (const extra of [{ audio: '1' }, { dest: 'navidrome' }, { split: '1', dest: 'server' }]) {
    const q = new URLSearchParams({ url: s.fakeUrl('video', 'tiktok', 'x', 'n1'), dest: 'elite', channel: 'main', device: '0', route: 'smart', ...extra });
    const r = await fetch(`${s.base}/api/jobs/start?${q}`, { headers: s.headers });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
});

test('review: a General-source suggestion is shown, and confirming it is recorded as such', async (t) => {
  const registry = {
    'id:tiktok:1': { filename: 'tikonly_-_clip 1.mp4', channel: null, at: NOW },
    'id:fikfap:2': { filename: 'fikonly_-_clip 2.mp4', channel: null, at: NOW },
  };
  const s = await boot(t, { registry });
  const json = async (url, opts) => (await fetch(`${s.base}${url}`, { ...opts, headers: { ...s.headers, ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}) } })).json();
  const { groups } = await json('/api/hub/review/groups');
  const tik = groups.find((g) => g.sites.join() === 'tiktok');
  const fik = groups.find((g) => g.sites.join() === 'fikfap');
  assert.ok(tik && fik, JSON.stringify(groups));
  assert.equal(tik.suggestion.audience, 'general');
  assert.equal(fik.suggestion, null);
  const { items } = await json('/api/hub/review/creators');
  const tikP = items.find((p) => p.name === 'tikonly');
  const fikP = items.find((p) => p.name === 'fikonly');
  // A suggestion that is not there cannot be confirmed.
  const refused = await fetch(`${s.base}/api/hub/review/creators`, {
    method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience: 'general', ids: [fikP.id], reason: 'source-suggestion' }),
  });
  assert.equal(refused.status, 409);
  const ok = await json('/api/hub/review/creators', { method: 'POST', body: JSON.stringify({ audience: 'general', ids: [tikP.id], reason: 'source-suggestion' }) });
  assert.deepEqual(ok.changed, [tikP.id]);
  const { profile } = await json(`/api/hub/profiles/${tikP.id}`);
  assert.equal(profile.classifiedReason, 'source-suggestion');
  assert.equal(profile.status, 'general');
  const stored = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'profiles.json'), 'utf8'));
  assert.equal(stored.log.at(-1).reason, 'source-suggestion');
  // Nothing else moved: the FikFap creator is still unclassified.
  const after = await json('/api/hub/review/creators');
  assert.ok(after.items.some((p) => p.id === fikP.id));
  const { sources } = await json('/api/hub/sources');
  assert.deepEqual(sources.filter((x) => x.known).map((x) => `${x.id}:${x.specClass}:${x.class}`),
    ['tiktok:general:general', 'facebook:general:general', 'instagram:general:general', 'youtube:general:general', 'redgifs:review:adult', 'fikfap:review:review']);
});

// H97: the job feeds follow the H4 audience gate.
function openStream(s, query = '') {
  const ctrl = new AbortController();
  let text = '';
  const events = [];
  const ready = fetch(`${s.base}/api/jobs/stream${query}`, { headers: s.headers, signal: ctrl.signal }).then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      text += dec.decode(value, { stream: true });
      let i;
      while ((i = text.indexOf('\n\n')) !== -1) {
        const block = text.slice(0, i);
        text = text.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  });
  ready.catch(() => {});
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 100; i++) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no stream event: ${what}\n${JSON.stringify(events).slice(0, 2000)}`);
  };
  return { events, waitFor, close: () => ctrl.abort() };
}

test('the job snapshot names a job only when its item is general, unless the 18+ view asks', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  const gen = await s.saveJob(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'h97-g'), 'main');
  assert.equal(gen.job.status, 'done', JSON.stringify(gen.job));
  const unk = await s.saveJob(s.fakeUrl('video', 'tiktok', 'stranger', 'h97-u'), 'main');
  assert.equal(unk.job.status, 'error');
  const adult = await s.saveJob(s.fakeUrl('video', 'tiktok', 'Ada', 'h97-a'), '18plus');
  assert.equal(adult.job.status, 'done');

  const plain = await (await fetch(`${s.base}/api/jobs`, { headers: s.headers })).json();
  const by = (list, id) => list.find((j) => j.id === id);
  assert.equal(by(plain.jobs, gen.job.id).creator, 'Jane Doe');
  assert.equal(by(plain.jobs, gen.job.id).audienceHidden, undefined);
  for (const id of [unk.job.id, adult.job.id]) {
    const j = by(plain.jobs, id);
    assert.equal(j.audienceHidden, true);
    for (const k of ['creator', 'title', 'thumbnail', 'filename', 'sourceUrl', 'url']) assert.equal(j[k] ?? null, null, k);
  }
  // Status and progress stay, so the queue still counts them.
  assert.equal(by(plain.jobs, adult.job.id).status, 'done');
  assert.equal(by(plain.jobs, adult.job.id).percent, 100);
  const text = JSON.stringify(plain);
  assert.equal(/stranger|Ada|h97-u|h97-a/.test(text), false, text);
  // The unclassified refusal keeps the hub's "classify and retry" shape.
  assert.match(by(plain.jobs, unk.job.id).error, / is a general app and the audience of .* is not classified/);

  const full = await (await fetch(`${s.base}/api/jobs?audience=adult`, { headers: s.headers })).json();
  assert.equal(by(full.jobs, unk.job.id).creator, 'stranger');
  assert.equal(by(full.jobs, adult.job.id).creator, 'Ada');
});

test('the job stream reduces live updates, and re-sends a job reclassified 18+', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  const gen = await s.saveJob(s.fakeUrl('video', 'tiktok', 'Jane Doe', 'h97-s-g'), 'main');
  assert.equal(gen.job.status, 'done', JSON.stringify(gen.job));
  const general = openStream(s);
  const adultView = openStream(s, '?audience=adult');
  t.after(() => { general.close(); adultView.close(); });
  // The snapshot: the general job in full.
  await general.waitFor((e) => e.type === 'job' && e.job.id === gen.job.id && e.job.creator === 'Jane Doe', 'snapshot');

  // A live 18+ download: every event on the general stream is reduced.
  const live = await s.saveJob(s.fakeUrl('video', 'tiktok', 'Ada', 'h97-s-a'), '18plus');
  await general.waitFor((e) => e.type === 'job' && e.job.id === live.job.id && e.job.status === 'done', 'live done');
  const liveEvents = general.events.filter((e) => e.type === 'job' && e.job.id === live.job.id);
  assert.ok(liveEvents.length >= 2);
  for (const e of liveEvents) assert.equal(/Ada|h97-s-a/.test(JSON.stringify(e)), false, JSON.stringify(e));
  await adultView.waitFor((e) => e.type === 'job' && e.job.id === live.job.id && e.job.creator === 'Ada', 'adult view live');

  // The general item is classified 18+ by hand while the stream is open.
  const row = s.items().rows.find((r) => String(r.key).includes('h97-s-g'));
  assert.ok(row, JSON.stringify(s.items().rows));
  const r = await fetch(`${s.base}/api/hub/review/items`, {
    method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'adult', ids: [row.id] }),
  });
  assert.equal(r.status, 200, await r.text());
  await general.waitFor((e) => e.type === 'job' && e.job.id === gen.job.id && e.job.audienceHidden === true, 're-sent reduced');
  await general.waitFor((e) => e.type === 'audience', 'audience event');
  const snap = await (await fetch(`${s.base}/api/jobs`, { headers: s.headers })).json();
  assert.equal(snap.jobs.find((j) => j.id === gen.job.id).creator, null);
});

// H34: a resolve preview is shown to the view that resolved it; a job's own
// picture follows the job's audience.
test('thumbnails: a resolve preview loads, a job picture follows the job\'s audience', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }] });
  const thumbOf = (url, q = '') => fetch(`${s.base}/api/thumb?url=${encodeURIComponent(url)}&v=2${q}`, { headers: s.headers });

  const preview = await (await fetch(`${s.base}/api/resolve?url=${encodeURIComponent(s.fakeUrl('video', 'tiktok', 'stranger', 'pv1') + '?thumb=1')}`, { headers: s.headers })).json();
  assert.ok(preview.thumbnail, JSON.stringify(preview));
  const p = await thumbOf(preview.thumbnail);
  assert.equal(p.status, 200, 'a preview resolved on a general view loads there');
  assert.equal(p.headers.get('cache-control'), 'private, no-cache');

  const gen = await s.saveJob(`${s.fakeUrl('video', 'tiktok', 'Jane Doe', 'jt-g')}?thumb=1`, 'main');
  assert.equal(gen.job.status, 'done');
  assert.equal((await thumbOf(gen.job.thumbnail)).status, 200);

  const adult = await s.saveJob(`${s.fakeUrl('video', 'tiktok', 'Ada', 'jt-a')}?thumb=1`, '18plus');
  assert.equal(adult.job.status, 'done');
  assert.ok(adult.job.thumbnail);
  assert.equal((await thumbOf(adult.job.thumbnail)).status, 404);
  const a2 = await thumbOf(adult.job.thumbnail, '&audience=adult');
  assert.equal(a2.status, 200);
  assert.equal(a2.headers.get('cache-control'), 'private, no-store');
  // The same picture resolved again on a general view stays held back: the
  // strictest provenance wins (H42).
  const again = await (await fetch(`${s.base}/api/resolve?url=${encodeURIComponent(`${s.fakeUrl('video', 'tiktok', 'Ada', 'jt-a')}?thumb=1`)}`, { headers: s.headers })).json();
  assert.equal(again.thumbnail, adult.job.thumbnail);
  assert.equal((await thumbOf(again.thumbnail)).status, 404);
});

// Codex phase-0 B1: a link to an item classified 18+, resolved on a general
// view, does not make its picture general. The view that resolved it sees it
// through its preview key, never stored; /api/media is never stored either.
test('a resolve preview of an 18+ item stays 18+, except for its own preview key (B1)', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Ada', audience: 'adult' }] });
  const thumbOf = (url, q = '') => fetch(`${s.base}/api/thumb?url=${encodeURIComponent(url)}&v=2${q}`, { headers: s.headers });
  const pv = await (await fetch(`${s.base}/api/resolve?url=${encodeURIComponent(`${s.fakeUrl('video', 'tiktok', 'Ada', 'b1')}?thumb=1`)}`, { headers: s.headers })).json();
  assert.ok(pv.thumbnail && pv.thumbToken, JSON.stringify(pv));
  assert.equal((await thumbOf(pv.thumbnail)).status, 404, 'the general view gets no picture of an 18+ item');
  assert.equal((await thumbOf(pv.thumbnail, '&pt=0123456789abcdef0123456789abcdef')).status, 404, 'a wrong key opens nothing');
  const own = await thumbOf(pv.thumbnail, `&pt=${pv.thumbToken}`);
  assert.equal(own.status, 200, 'the resolving view sees its own preview');
  assert.equal(own.headers.get('cache-control'), 'private, no-store');
  assert.equal((await thumbOf(pv.thumbnail, '&audience=adult')).status, 200);
  // An 18+ site makes the item 18+ whoever the creator is.
  const site = await (await fetch(`${s.base}/api/resolve?url=${encodeURIComponent(`${s.fakeUrl('video', 'redgifs.com', 'nobody', 'b1s')}?thumb=1`)}`, { headers: s.headers })).json();
  assert.equal((await thumbOf(site.thumbnail)).status, 404);
  // A key from another preview does not open this one.
  assert.equal((await thumbOf(site.thumbnail, `&pt=${pv.thumbToken}`)).status, 404);
  // An unclassified creator's preview still loads on the general view (H15).
  const unk = await (await fetch(`${s.base}/api/resolve?url=${encodeURIComponent(`${s.fakeUrl('video', 'tiktok', 'stranger', 'b1u')}?thumb=1`)}`, { headers: s.headers })).json();
  const u = await thumbOf(unk.thumbnail);
  assert.equal(u.status, 200);
  assert.equal(u.headers.get('cache-control'), 'private, no-cache');
  // The preview clip proxy never lets the browser store a clip.
  const media = await fetch(`${s.base}/api/media?url=${encodeURIComponent(`${new URL(pv.thumbnail).origin}/media/b1/clip.mp4`)}`, { headers: s.headers });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('cache-control'), 'private, no-store');
  await media.arrayBuffer();
});

// Codex phase-0 B2: the synchronous save route records the registry row's
// picture provenance too, not only finishJob.
test('every save path records the registry provenance of its picture (B2)', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Ada', audience: 'adult' }] });
  const r = await s.save(`${s.fakeUrl('video', 'tiktok', 'Ada', 'b2')}?thumb=1`, '18plus');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 1500));
  const index = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'thumb-index.json'), 'utf8'));
  const provs = Object.values(index.keys).flatMap((k) => k.provs);
  const reg = provs.find((p) => p.kind === 'entry' && String(p.ref).startsWith('r:'));
  assert.ok(reg, JSON.stringify(index));
  assert.equal(reg.in.channel, '18plus');
});

// Codex phase-0 B4: a renamed creator does not open an 18+ creator's job to
// the general feed, from its first event on; a failed 18+ save stays 18+ in
// History.
test('a creator override never makes an 18+ job general; a failed 18+ save stays 18+ (B4)', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Jane Doe', audience: 'general' }, { name: 'Ada', audience: 'adult' }] });
  const general = openStream(s);
  t.after(() => general.close());
  await new Promise((res) => setTimeout(res, 200));
  const renamed = await s.saveJob(s.fakeUrl('video', 'tiktok', 'Ada', 'b4-rename'), 'main', { creator: 'Jane Doe' });
  assert.equal(renamed.job.status, 'error', 'the gate refuses it for the general app');
  await general.waitFor((e) => e.type === 'job' && e.job.id === renamed.job.id && e.job.status === 'error', 'renamed end');
  for (const e of general.events.filter((x) => x.type === 'job' && x.job.id === renamed.job.id)) {
    assert.equal(/b4-rename|Ada|Jane Doe/.test(JSON.stringify(e)), false, JSON.stringify(e));
  }
  const full = await (await fetch(`${s.base}/api/jobs?audience=adult`, { headers: s.headers })).json();
  assert.equal(full.jobs.find((j) => j.id === renamed.job.id).sourceCreator, 'Ada');

  // An image sent to the 18+ app is refused; its History row keeps the channel.
  const img = await s.saveJob(s.fakeUrl('image', 'tiktok', 'Jane Doe', 'b4-img'), '18plus');
  assert.equal(img.job.status, 'error');
  const plainHistory = JSON.stringify(await (await fetch(`${s.base}/api/history`, { headers: s.headers })).json());
  assert.equal(plainHistory.includes('b4-img'), false, plainHistory);
  assert.equal(plainHistory.includes('b4-rename'), false, plainHistory);
  const adultHistory = JSON.stringify(await (await fetch(`${s.base}/api/history?audience=adult`, { headers: s.headers })).json());
  assert.ok(adultHistory.includes('b4-img'));
  assert.ok(adultHistory.includes('b4-rename'));
  const rows = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'history.json'), 'utf8'));
  assert.equal(rows.find((r) => String(r.sourceUrl).includes('b4-img')).channel, '18plus');
});

// Codex phase-0 B5: a device copy of an 18+ job goes to the 18+ view or to
// the request that started the job, never to another general tab.
test('a device copy of an 18+ job needs the starting tab\'s key or the 18+ view (B5)', async (t) => {
  const s = await boot(t, { profileList: [{ name: 'Ada', audience: 'adult' }, { name: 'Jane Doe', audience: 'general' }] });
  const start = async (creator, id) => {
    const q = new URLSearchParams({ url: s.fakeUrl('video', 'tiktok', creator, id), dest: 'elite', channel: creator === 'Ada' ? '18plus' : 'main', device: '1' });
    const started = await (await fetch(`${s.base}/api/jobs/start?${q}`, { headers: s.headers })).json();
    for (let i = 0; i < 100; i++) {
      const { jobs } = await (await fetch(`${s.base}/api/jobs?audience=adult`, { headers: s.headers })).json();
      const j = jobs.find((x) => x.id === started.jobId);
      if (j && ['done', 'error'].includes(j.status)) return { started, job: j };
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('job did not finish');
  };
  const a = await start('Ada', 'b5-a');
  assert.equal(a.job.status, 'done', JSON.stringify(a.job));
  assert.equal(a.job.deliverable, true);
  assert.match(a.started.deliverKey, /^[0-9a-f]{32}$/);
  assert.equal(a.job.deliverKey, undefined, 'the key is never in the job feed');
  const file = (id, q = '') => fetch(`${s.base}/api/jobs/${id}/file${q}`, { headers: s.headers });
  const other = await file(a.job.id);
  assert.equal(other.status, 404, 'another general tab gets nothing');
  await other.arrayBuffer();
  const wrong = await file(a.job.id, '?key=0123456789abcdef0123456789abcdef');
  assert.equal(wrong.status, 404);
  await wrong.arrayBuffer();
  const own = await file(a.job.id, `?key=${a.started.deliverKey}`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('cache-control'), 'private, no-store');
  assert.ok((await own.arrayBuffer()).byteLength > 0);

  const g = await start('Jane Doe', 'b5-g');
  assert.equal(g.job.status, 'done', JSON.stringify(g.job));
  const gf = await file(g.job.id);
  assert.equal(gf.status, 200, 'a general job\'s copy still reaches any tab');
  await gf.arrayBuffer();
  // The copy vanished before the transfer: 422, never a 5xx.
  const g2 = await start('Jane Doe', 'b5-gone');
  assert.equal(g2.job.status, 'done');
  const roots = [s.apps.tik];
  let removed = 0;
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root, { recursive: true }); } catch { continue; }
    for (const f of names) {
      if (String(f).includes('b5-gone') && fs.statSync(path.join(root, f)).isFile()) {
        fs.rmSync(path.join(root, f));
        removed++;
      }
    }
  }
  assert.ok(removed > 0, 'found the device copy');
  const gone = await file(g2.job.id);
  assert.equal(gone.status, 422);
  assert.match((await gone.json()).error, /no longer available/);
});
