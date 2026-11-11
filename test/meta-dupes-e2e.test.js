'use strict';
// Duplicates and Metadata & tags end to end: a real server on temp folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const SHARED = 'meta-test-password';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-meta-e2e-'));
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
      FFMPEG_BIN: '/bin/false', FFPROBE_BIN: '/bin/false', DUPES_SCAN_MBPS: '200',
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
  return { dirs, get, post, run, list, base, headers, root, logs: () => logs };
}


const sig = (p) => {
  const st = fs.statSync(p);
  return `${st.size}:${st.mtimeMs}:${st.mode}:${st.ino}`;
};

test('the duplicate scan finds a copy across Grabbit and an app, touches nothing, and can be paused', async (t) => {
  const s = await boot(t);
  const downloads = path.join(path.dirname(s.dirs.data), 'downloads');
  const files = [
    path.join(s.dirs.tik, 'main', 'ann', 'renamed.mp4'),
    path.join(downloads, 'videos', 'ann_-_clip 1.mp4'),
    path.join(s.dirs.egram, 'bob', 'unique.jpg'),
  ];
  const bytes = ['same bytes here', 'same bytes here', 'unique'];
  files.forEach((f, i) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bytes[i]);
  });
  const before = files.map(sig);
  let d = await s.get('/api/hub/dupes');
  assert.equal(d.scan.state, 'stopped', 'the scan waits for the owner');
  assert.equal(d.total, 0);
  const st = await s.post('/api/hub/dupes/scan', { action: 'start' });
  assert.equal(st.status, 200);
  for (let i = 0; i < 100; i++) {
    d = await s.get('/api/hub/dupes');
    if (d.scan.lastPassAt) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(d.scan.lastPassAt, JSON.stringify(d.scan));
  assert.equal(d.scan.totals.files, 3, JSON.stringify(d.scan.roots));
  assert.equal(d.total, 1);
  const labels = d.items[0].members.map((m) => m.rootLabel).sort();
  assert.deepEqual(labels, ['Grabbit library', 'TikShortis']);
  assert.ok(!d.scan.roots.some((r) => r.path === s.dirs.drop || r.path === s.dirs.data), 'the inbox drop and data dir are not scanned');
  // Known/OK hides it from the open list; the files stay as they were.
  const ack = await s.post(`/api/hub/dupes/${d.items[0].sha256}/ack`, { note: 'fine' });
  assert.equal(ack.status, 200);
  assert.equal((await s.get('/api/hub/dupes')).total, 0);
  assert.equal((await s.get('/api/hub/dupes?state=acked')).total, 1);
  assert.deepEqual(files.map(sig), before);
  assert.equal((await s.post('/api/hub/dupes/scan', { action: 'pause' })).body.scan.state, 'paused');
  assert.equal((await s.post('/api/hub/dupes/scan', { action: 'delete' })).status, 400);
  assert.equal((await s.post('/api/hub/dupes/nothex/ack')).status, 400);
});

test('caption hashtags arrive with an inbox item; owner edits and tags never move the audience', async (t) => {
  const s = await boot(t);
  drop(s.dirs.drop, 'meta.creator');
  drop(s.dirs.drop, 'other.creator');
  await s.run();
  let m = await s.get('/api/hub/meta?q=meta.creator');
  assert.equal(m.total, 1);
  const item = m.items[0];
  assert.equal(item.audience, 'unknown');
  assert.deepEqual(item.tags.site, [], 'Instagram gives no tag list, so none is invented');
  assert.equal(item.tags.caption.length, 1);
  const capTag = item.tags.caption[0];
  assert.match(capTag, /^tag\d+$/);
  const one = await s.get(`/api/hub/meta/${item.id}`);
  assert.match(one.item.description, /^Caption \d+ #tag\d+$/);
  assert.equal(one.item.raw.from, 'extractor');
  assert.equal(one.item.raw.sidecar.source, 'instagram');
  // Search and filter on the source tag.
  assert.equal((await s.get(`/api/hub/meta?tag=%23${capTag.toUpperCase()}&origin=source`)).total, 1);
  assert.equal((await s.get(`/api/hub/meta?tag=${capTag}&origin=user`)).total, 0);

  // The general creator is classified; the other creator is not.
  const c = await s.post('/api/hub/inbox/creators', { username: 'meta.creator', audience: 'general' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  m = await s.get('/api/hub/meta?q=other.creator');
  const other = m.items[0];
  // Rename the unclassified item to the general creator and tag it: it stays held.
  const e = await s.post(`/api/hub/meta/${other.id}`, { creator: 'meta.creator', title: 'A nicer title' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.deepEqual(e.body.changed.sort(), ['creator', 'title']);
  const tg = await s.post('/api/hub/meta/tags', { ids: [other.id], add: ['mine', other.tags.caption[0]] });
  assert.equal(tg.status, 200);
  assert.deepEqual(tg.body.added.changed, [other.id]);
  drop(s.dirs.drop, 'other.creator');
  await s.run();
  const held = (await s.list('q=other.creator')).items;
  assert.ok(held.length >= 2);
  assert.ok(held.every((x) => x.state === 'held' && x.audience === 'unknown'), JSON.stringify(held.map((x) => [x.state, x.audience])));
  assert.ok(!filesUnder(s.dirs.egram).some((f) => f.startsWith('other.creator/')));
  // The edit is kept beside the source and logged.
  const after = (await s.get(`/api/hub/meta/${other.id}`)).item;
  assert.equal(after.creator, 'meta.creator');
  assert.equal(after.source.creator, 'other.creator');
  assert.deepEqual(after.tags.user, ['mine']);
  assert.equal(after.audience, 'unknown');
  assert.deepEqual(after.edits.map((x) => x.field).sort(), ['creator', 'tag_add', 'title']);
  // Bulk rename needs the count the owner saw.
  const bad = await s.post('/api/hub/meta/creator-rename', { from: 'meta.creator', to: 'Meta', expected: 99 });
  assert.equal(bad.status, 409);
  const n = (await s.get('/api/hub/meta/creators?q=meta.creator')).creators.find((x) => x.creator === 'meta.creator').items;
  const ok = await s.post('/api/hub/meta/creator-rename', { from: 'meta.creator', to: 'Meta', expected: n });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.changed, n);
  // A source tag cannot be removed through the API.
  const rm = await s.post('/api/hub/meta/tags', { ids: [item.id], remove: [capTag] });
  assert.deepEqual(rm.body.removed.changed, []);
  assert.deepEqual((await s.get(`/api/hub/meta/${item.id}`)).item.tags.caption, [capTag]);
});

// --- duplicate preview: GET /api/hub/dupes/file/:id -----------------------------

test('duplicate preview serves scanned media only, with range, and refuses everything else', async (t) => {
  const s = await boot(t);
  const downloads = path.join(path.dirname(s.dirs.data), 'downloads');
  const mp4 = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42'), Buffer.alloc(2000, 7)]);
  const kinds = { 'a.mp4': mp4, 'b.jpg': Buffer.alloc(300, 1), 'a.mp3': Buffer.alloc(300, 2) };
  for (const [name, buf] of Object.entries(kinds)) {
    for (const [root, sub] of [[s.dirs.tik, path.join('main', 'ann')], [downloads, 'videos']]) {
      fs.mkdirSync(path.join(root, sub), { recursive: true });
      fs.writeFileSync(path.join(root, sub, name), buf);
    }
  }
  assert.equal((await s.post('/api/hub/dupes/scan', { action: 'start' })).status, 200);
  let d;
  for (let i = 0; i < 100; i++) {
    d = await s.get('/api/hub/dupes?limit=100');
    if (d.scan.lastPassAt) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const members = d.items.flatMap((g) => g.members);
  const idOf = (name, rootLabel) => (members.find((m) => m.rel.endsWith(name) && (!rootLabel || m.rootLabel === rootLabel)) || {}).id;
  const fetchFile = (id, extra = {}) => fetch(`${s.base}/api/hub/dupes/file/${id}`, { headers: { ...s.headers, ...extra }, redirect: 'manual' });

  // Media types: served with the right type and hardening headers.
  for (const [name, type] of [['a.mp4', /video\/mp4/], ['b.jpg', /image\/jpeg/], ['a.mp3', /audio\/mpeg/]]) {
    const id = idOf(name);
    assert.ok(id, `${name} should be in a duplicate group`);
    const r = await fetchFile(id);
    assert.equal(r.status, 200, name);
    assert.match(r.headers.get('content-type'), type);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await r.arrayBuffer()).byteLength, kinds[name].length);
  }

  // Range: 206 with Content-Range, and an unsatisfiable range gives 416.
  const id = idOf('a.mp4');
  const part = await fetchFile(id, { Range: 'bytes=0-9' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-9/${mp4.length}`);
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await fetchFile(id, { Range: 'bytes=999999-' })).status, 416);

  // Not logged in: no bytes, whatever the id.
  const anon = await fetch(`${s.base}/api/hub/dupes/file/${id}`, { headers: { Accept: 'application/json' }, redirect: 'manual' });
  assert.notEqual(anon.status, 200);
  assert.notEqual(anon.status, 206);

  // Ids that are not rows.
  for (const bad of ['0', '999999', 'abc', '1.5', '-1', '1%2F..%2F..']) {
    assert.equal((await fetchFile(bad)).status, 404, bad);
  }

  // A file swapped for a symlink after the scan is refused (leaf symlink).
  const outside = path.join(s.root, 'outside.jpg');
  fs.writeFileSync(outside, 'outside the roots');
  const jpgId = idOf('b.jpg', 'TikShortis');
  const leaf = path.join(s.dirs.tik, 'main', 'ann', 'b.jpg');
  fs.rmSync(leaf);
  fs.symlinkSync(outside, leaf);
  assert.equal((await fetchFile(jpgId)).status, 404, 'leaf symlink');

  // A folder swapped for a symlink after the scan is refused (parent symlink).
  const mp3Id = idOf('a.mp3', 'Grabbit library');
  const folder = path.join(downloads, 'videos');
  const moved = path.join(s.root, 'moved-videos');
  fs.renameSync(folder, moved);
  const elsewhere = path.join(s.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'a.mp3'), 'not in a root');
  fs.symlinkSync(elsewhere, folder);
  assert.equal((await fetchFile(mp3Id)).status, 404, 'parent symlink');
});

test('duplicate preview refuses a row whose path climbs out of its root or whose root is not a scan root', async (t) => {
  const s = await boot(t);
  const Database = require('better-sqlite3');
  const secret = path.join(s.root, 'secret.jpg');
  fs.writeFileSync(secret, 'top secret');
  const tik = path.join(s.root, 'tik');
  const db = new Database(path.join(s.dirs.data, 'items.db'));
  t.after(() => db.close());
  const insert = (root, rel) => {
    return Number(db.prepare('INSERT INTO file_hashes (root, rel, bytes, mtime_ms, sha256, seen_at, hashed_at) VALUES (?, ?, 10, 1, ?, 1, 1)').run(root, rel, 'ab'.repeat(32)).lastInsertRowid);
  };
  const up = insert(tik, '../secret.jpg');
  const sibling = insert(tik, '../tik-evil/x.jpg');
  const foreignRoot = insert(s.root, 'secret.jpg');
  const notMedia = insert(tik, 'notes.txt');
  const html = insert(tik, 'page.html');
  fs.writeFileSync(path.join(tik, 'notes.txt'), 'top secret');
  fs.writeFileSync(path.join(tik, 'page.html'), '<script>top secret</script>');
  const gone = insert(tik, 'gone.jpg');
  db.prepare('UPDATE file_hashes SET gone_at = 5 WHERE id = ?').run(gone);
  fs.writeFileSync(path.join(tik, 'gone.jpg'), 'x');
  for (const id of [up, sibling, foreignRoot, gone, notMedia, html]) {
    const r = await fetch(`${s.base}/api/hub/dupes/file/${id}`, { headers: s.headers });
    assert.equal(r.status, 404, `row ${id}`);
    assert.doesNotMatch(await r.text(), /top secret/);
  }
});
