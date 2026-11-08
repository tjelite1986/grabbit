'use strict';
// The Instagram inbox end to end: a real server on temp folders, drops written
// the way the patched app writes them, and the app folders read afterwards.
// An unclassified or 18+ creator must never leave a byte in a general app.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const SHARED = 'inbox-test-password';
const MIN = 60 * 1000;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

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

let seq = 0;
// One drop as the app writes it: media + schema-2 sidecar, aged past the settle time.
function drop(dropDir, username, { video = false, shortcode = null, size = 1, index = 0, bytes = null, ageMs = 5 * MIN } = {}) {
  seq++;
  const pk = String(4000000000000000000n + BigInt(seq));
  const ext = video ? 'mp4' : 'jpg';
  const media = `${username}_${pk}.${ext}`;
  const dir = path.join(dropDir, username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, media), bytes || `media ${username} ${pk} ${Math.random()}`);
  const sc = shortcode || `Sc${String(seq).padStart(8, '0')}`;
  fs.writeFileSync(path.join(dir, `${username}_${pk}.json`), JSON.stringify({
    schema_version: 2, source: 'instagram', media_file: media, username, shortcode: sc, media_pk: pk,
    post_url: `https://www.instagram.com/p/${sc}/`, is_video: video, carousel_size: size, media_index: index,
    caption: `Caption ${seq} #tag${seq}`,
  }));
  const t = new Date(Date.now() - ageMs);
  for (const n of [media, `${username}_${pk}.json`]) fs.utimesSync(path.join(dir, n), t, t);
  return { media, sidecar: `${username}_${pk}.json`, shortcode: sc };
}

async function boot(t, { mode = 'on', settings = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-inbox-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = {
    drop: path.join(root, 'drop'), egram: path.join(root, 'egram'), tik: path.join(root, 'tik'),
    plat: path.join(root, 'plat'), ads: path.join(root, 'ads'), data: path.join(root, 'data'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  if (settings) fs.writeFileSync(path.join(dirs.data, 'inbox-settings.json'), JSON.stringify(settings));
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, PORT: String(port), DATA_DIR: dirs.data, DOWNLOAD_DIR: path.join(root, 'downloads'),
      GRABBIT_PASSWORD: SHARED, STATE_BACKUP_DAYS: '0', YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
      FFMPEG_BIN: '/bin/false', FFPROBE_BIN: '/bin/false',
      ELITE_ROOT: dirs.ads, TIKSHORTIS_ROOT: dirs.tik, PLATFORM_IMPORT_ROOT: dirs.plat,
      INBOX_DROP_DIR: dirs.drop, EGRAM_IMPORT_DIR: dirs.egram, INBOX_MODE: mode,
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
  const headers = { Cookie: cookie, Accept: 'application/json' };
  const get = async (p) => (await fetch(`${base}${p}`, { headers })).json();
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  };
  const run = () => post('/api/hub/inbox/run');
  const list = async (q = '') => (await get(`/api/hub/inbox?${q}`));
  return { dirs, get, post, run, list, logs: () => logs };
}

test('an unclassified creator is held; classifying it general delivers to egram only by default', async (t) => {
  const s = await boot(t);
  const d = drop(s.dirs.drop, 'new.creator');
  const r = await s.run();
  assert.equal(r.status, 200);
  assert.equal(r.body.run.staged, 1);
  assert.deepEqual(filesUnder(s.dirs.drop), [], 'the drop folder is emptied');
  assert.deepEqual(filesUnder(s.dirs.egram), [], 'nothing reaches egram before a classification');
  let l = await s.list();
  assert.equal(l.items.length, 1);
  assert.equal(l.items[0].state, 'held');
  assert.equal(l.items[0].audience, 'unknown');
  assert.match(l.items[0].reason, /no profile matches/);

  const c = await s.post('/api/hub/inbox/creators', { username: 'new.creator', audience: 'general' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.ok(c.body.created);
  assert.deepEqual(filesUnder(s.dirs.egram), [`new.creator/${d.media}`, `new.creator/${d.sidecar}`].sort());
  assert.deepEqual(filesUnder(s.dirs.tik), []);
  assert.deepEqual(filesUnder(s.dirs.plat), []);
  l = await s.list();
  assert.equal(l.items[0].state, 'delivered');
  assert.deepEqual(l.items[0].deliveries.map((x) => [x.destination, x.status]), [['egram', 'dropped']]);
  // The sidecar reaches egram byte for byte.
  assert.equal(
    fs.readFileSync(path.join(s.dirs.egram, 'new.creator', d.sidecar), 'utf8'),
    fs.readFileSync(path.join(s.dirs.data, 'inbox', 'staged', 'new.creator', d.sidecar), 'utf8')
  );
  // A later item of the same creator goes straight through.
  const d2 = drop(s.dirs.drop, 'new.creator');
  await s.run();
  assert.ok(filesUnder(s.dirs.egram).includes(`new.creator/${d2.media}`));
});

test('an 18+ creator never reaches a general app, by hand either', async (t) => {
  const s = await boot(t, { settings: { auto: { egram: true, main: true, platform: true } } });
  drop(s.dirs.drop, 'adult.one', { video: true });
  await s.run();
  const c = await s.post('/api/hub/inbox/creators', { username: 'adult.one', audience: 'adult' });
  assert.equal(c.status, 200);
  const l = await s.list();
  assert.equal(l.items[0].state, 'held');
  assert.match(l.items[0].reason, /^18\+/);
  for (const dest of ['egram', 'main', 'platform']) {
    const r = await s.post(`/api/hub/inbox/${l.items[0].id}/deliver`, { destination: dest });
    assert.equal(r.status, 422, `${dest}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(filesUnder(s.dirs.egram), []);
  assert.deepEqual(filesUnder(s.dirs.tik), []);
  assert.deepEqual(filesUnder(s.dirs.plat), []);
  // Making it general afterwards is refused.
  const back = await s.post('/api/hub/inbox/creators', { username: 'adult.one', audience: 'general' });
  assert.equal(back.status, 409);
  // The 18+ app takes the video by hand.
  const ads = await s.post(`/api/hub/inbox/${l.items[0].id}/deliver`, { destination: '18plus' });
  assert.equal(ads.status, 200, JSON.stringify(ads.body));
  assert.ok(filesUnder(s.dirs.ads).some((f) => f.endsWith('.mp4')));
});

test('a general video goes to every app switched on; an image only to egram', async (t) => {
  const s = await boot(t, { settings: { auto: { egram: true, main: true, platform: true } } });
  await s.post('/api/hub/inbox/creators', { username: 'ok.creator', audience: 'general' });
  const v = drop(s.dirs.drop, 'ok.creator', { video: true });
  const i = drop(s.dirs.drop, 'ok.creator');
  await s.run();
  const egram = filesUnder(s.dirs.egram);
  assert.ok(egram.includes(`ok.creator/${v.media}`) && egram.includes(`ok.creator/${i.media}`));
  const tik = filesUnder(s.dirs.tik);
  assert.equal(tik.filter((f) => f.endsWith('.mp4')).length, 1, tik.join(','));
  assert.ok(tik.every((f) => f.startsWith('main/_import/')));
  const plat = filesUnder(s.dirs.plat);
  assert.equal(plat.filter((f) => f.endsWith('.mp4')).length, 1);
  const sc = JSON.parse(fs.readFileSync(path.join(s.dirs.plat, plat.find((f) => f.endsWith('.json'))), 'utf8'));
  assert.equal(sc.source, 'instagram');
  assert.equal(sc.sourceId, v.shortcode);
  assert.equal(sc.creator.handle, 'ok.creator');
  const l = await s.list();
  assert.ok(l.items.every((x) => x.state === 'delivered'), JSON.stringify(l.items.map((x) => [x.state, x.reason])));
  assert.equal(filesUnder(path.join(s.dirs.tik)).filter((f) => f.startsWith('.') || f.includes('/.')).length, 0, 'no temp file left');
});

test('a carousel waits for every member and lands in egram with one mtime', async (t) => {
  const s = await boot(t);
  await s.post('/api/hub/inbox/creators', { username: 'carousel.user', audience: 'general' });
  const a = drop(s.dirs.drop, 'carousel.user', { shortcode: 'CarouselX1', size: 3, index: 0 });
  drop(s.dirs.drop, 'carousel.user', { shortcode: 'CarouselX1', size: 3, index: 1 });
  await s.run();
  assert.deepEqual(filesUnder(s.dirs.egram), []);
  let l = await s.list();
  assert.ok(l.items.every((x) => /2 of 3/.test(x.reason)), JSON.stringify(l.items.map((x) => x.reason)));
  drop(s.dirs.drop, 'carousel.user', { shortcode: 'CarouselX1', size: 3, index: 2 });
  await s.run();
  const files = filesUnder(s.dirs.egram);
  assert.equal(files.length, 6);
  const mtimes = new Set(files.map((f) => fs.statSync(path.join(s.dirs.egram, f)).mtimeMs));
  assert.equal(mtimes.size, 1, 'one mtime for the whole post');
  l = await s.list();
  assert.ok(l.items.every((x) => x.state === 'delivered'));
  assert.ok(l.items.some((x) => x.item_key === 'id:instagram:CarouselX1-0'));
  void a;
});

test('the same bytes dropped again are a duplicate, not a second delivery', async (t) => {
  const s = await boot(t);
  await s.post('/api/hub/inbox/creators', { username: 'dup.user', audience: 'general' });
  drop(s.dirs.drop, 'dup.user', { bytes: 'identical bytes' });
  await s.run();
  drop(s.dirs.drop, 'dup.user', { bytes: 'identical bytes' });
  await s.run();
  const l = await s.list();
  const states = l.items.map((x) => x.state).sort();
  assert.deepEqual(states, ['delivered', 'duplicate']);
  assert.equal(filesUnder(s.dirs.egram).filter((f) => f.endsWith('.jpg')).length, 1);
});

test('young files and files of an unknown folder stay in the drop folder', async (t) => {
  const s = await boot(t);
  drop(s.dirs.drop, 'young.one', { ageMs: 10 * 1000 });
  fs.mkdirSync(path.join(s.dirs.drop, 'bad name!'));
  fs.writeFileSync(path.join(s.dirs.drop, 'bad name!', 'x.jpg'), 'x');
  const r = await s.run();
  assert.equal(r.body.run.staged, 0);
  assert.equal(r.body.run.waiting, 1);
  assert.equal(filesUnder(s.dirs.drop).length, 3);
});

test('a symlinked drop file or username folder never pulls a file from outside', async (t) => {
  const s = await boot(t);
  await s.post('/api/hub/inbox/creators', { username: 'link.user', audience: 'general' });
  await s.post('/api/hub/inbox/creators', { username: 'linkdir.user', audience: 'general' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-inbox-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.jpg'), 'secret bytes');
  fs.writeFileSync(path.join(outside, 'secret.json'), '{}');
  // A real folder whose files point outside.
  const d = drop(s.dirs.drop, 'link.user');
  for (const [n, target] of [[d.media, 'secret.jpg'], [d.sidecar, 'secret.json']]) {
    fs.rmSync(path.join(s.dirs.drop, 'link.user', n));
    fs.symlinkSync(path.join(outside, target), path.join(s.dirs.drop, 'link.user', n));
  }
  // A username folder that is itself a link to the outside.
  fs.symlinkSync(outside, path.join(s.dirs.drop, 'linkdir.user'));
  const r = await s.run();
  assert.equal(r.status, 200);
  assert.equal(r.body.run.staged, 0);
  assert.deepEqual(filesUnder(path.join(s.dirs.data, 'inbox')).filter((f) => !f.endsWith('.jsonl')), []);
  assert.deepEqual(filesUnder(s.dirs.egram), []);
  assert.deepEqual(fs.readdirSync(outside).sort(), ['secret.jpg', 'secret.json'], 'the outside folder is untouched');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.jpg'), 'utf8'), 'secret bytes');
});

test('a symlinked username folder in egram is refused, nothing is written through it', async (t) => {
  const s = await boot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-inbox-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(s.dirs.egram, 'swap.user'));
  const d = drop(s.dirs.drop, 'swap.user');
  await s.run();
  // Staged copies are private to Grabbit.
  const staged = path.join(s.dirs.data, 'inbox', 'staged', 'swap.user');
  for (const n of [d.media, d.sidecar]) assert.equal(fs.statSync(path.join(staged, n)).mode & 0o777, 0o600, n);
  const c = await s.post('/api/hub/inbox/creators', { username: 'swap.user', audience: 'general' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the link');
  const l = await s.list();
  assert.equal(l.items.length, 1);
  assert.notEqual(l.items[0].state, 'delivered');
  assert.ok(l.items[0].deliveries.some((x) => x.destination === 'egram' && x.status === 'failed' && /symlink/.test(x.detail || '')),
    JSON.stringify(l.items[0].deliveries));
});

test('shadow mode moves nothing and logs what it would do', async (t) => {
  const s = await boot(t, { mode: 'shadow' });
  drop(s.dirs.drop, 'shadow.user', { video: true });
  drop(s.dirs.drop, 'shadow.user');
  await s.run();
  await s.run();
  assert.equal(filesUnder(s.dirs.drop).length, 4, 'nothing moved');
  assert.deepEqual(filesUnder(s.dirs.egram), []);
  const sum = await s.get('/api/hub/inbox/shadow');
  assert.equal(sum.entries, 2, 'each entry logged once');
  assert.equal(sum.audience.unknown, 2);
  assert.deepEqual(sum.wouldDeliver, {});
  assert.equal((await s.list()).total, 0, 'no inbox rows in shadow mode');
});

test('the inbox routes refuse when the inbox is off', async (t) => {
  const s = await boot(t, { mode: 'off' });
  const r = await s.post('/api/hub/inbox/run');
  assert.equal(r.status, 409);
});
