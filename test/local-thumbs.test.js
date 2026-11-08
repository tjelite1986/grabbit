'use strict';
// History pictures: kept while the entry is in the history, and made again from
// the downloaded file when the site's signed link has expired.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const SHARED = 'local-thumbs-test-password';
// Loopback is refused by the URL guard, so these behave like expired CDN links.
const DEAD = (n) => `http://127.0.0.1:9/expired-${n}.jpg`;
const key = (url) => crypto.createHash('sha1').update(url).digest('hex');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function boot(t, { history = [], thumbs = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-local-thumbs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const tik = path.join(root, 'tik');
  const drop = path.join(tik, 'main', '_import');
  fs.mkdirSync(path.join(data, 'thumbs'), { recursive: true });
  fs.mkdirSync(drop, { recursive: true });
  fs.writeFileSync(path.join(data, 'history.json'), JSON.stringify(history));
  for (const [name, buf] of Object.entries(thumbs)) fs.writeFileSync(path.join(data, 'thumbs', name), buf);
  for (const [name, buf] of Object.entries(files)) {
    // 'folder/name' files a clip in a creator folder under main/, else in _import.
    const file = name.includes('/') ? path.join(tik, 'main', name) : path.join(drop, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof buf === 'function') buf(file);
    else fs.writeFileSync(file, buf);
  }
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, PORT: String(port), DATA_DIR: data, DOWNLOAD_DIR: path.join(root, 'downloads'),
      GRABBIT_PASSWORD: SHARED, STATE_BACKUP_DAYS: '0', YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
      FFPROBE_BIN: '/bin/false', DUPES_SCAN: 'off', TIKSHORTIS_ROOT: tik,
      ...(HAS_FFMPEG ? {} : { FFMPEG_BIN: '/bin/false' }),
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(SHARED)}`,
    redirect: 'manual',
  });
  const cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth='));
  const thumb = (url) => fetch(`${base}/api/thumb?url=${encodeURIComponent(url)}`, { headers: { Cookie: cookie } });
  return { thumb, thumbsDir: path.join(data, 'thumbs') };
}

const entry = (n, filename) => ({
  id: `170000000000${n}-${n}`, time: 1700000000000 + n, title: `clip ${n}`, creator: 'someone',
  channel: 'main', dest: 'elite', filename, thumbnail: DEAD(n),
});

test('an expired link is made again from the poster beside the downloaded video, and kept', async (t) => {
  const poster = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(3000)]);
  const { thumb, thumbsDir } = await boot(t, {
    history: [entry(1, 'clip1.mp4')],
    files: { 'clip1.mp4': Buffer.alloc(10), 'clip1.jpg': poster },
  });
  const r = await thumb(DEAD(1));
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), poster);
  assert.ok(fs.existsSync(path.join(thumbsDir, `keep-${key(DEAD(1))}.jpg`)));
});

test('a frame is taken from the video when there is no poster', { skip: !HAS_FFMPEG && 'no ffmpeg' }, async (t) => {
  const make = (file) => {
    const out = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=3:s=320x240:r=10', '-pix_fmt', 'yuv420p', file]);
    assert.equal(out.status, 0, String(out.stderr));
  };
  const { thumb, thumbsDir } = await boot(t, { history: [entry(2, 'clip2.mp4')], files: { 'clip2.mp4': make } });
  const r = await thumb(DEAD(2));
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xd8]);
  assert.ok(fs.existsSync(path.join(thumbsDir, `keep-${key(DEAD(2))}.jpg`)));
});

test('no link and no file: refused once, then not asked for again for a while', async (t) => {
  const { thumb, thumbsDir } = await boot(t, { history: [entry(3, 'gone.mp4')] });
  assert.equal((await thumb(DEAD(3))).status, 502);
  const again = await thumb(DEAD(3));
  assert.equal(again.status, 404);
  assert.match((await again.json()).error, /tried recently/);
  assert.deepEqual(fs.readdirSync(thumbsDir), []);
});

test('at boot the history keeps its cached pictures; orphans go, own frames stay', async (t) => {
  const pic = crypto.randomBytes(2000);
  const { thumb, thumbsDir } = await boot(t, {
    history: [entry(4, 'clip4.mp4')],
    thumbs: {
      [`${key(DEAD(4))}.jpg`]: pic,
      [`keep-${key('https://cdn.example/old.jpg')}.jpg`]: pic,
      [`local-${'a'.repeat(40)}.jpg`]: pic,
    },
  });
  const names = fs.readdirSync(thumbsDir).sort();
  assert.deepEqual(names, [`${key(DEAD(4))}.jpg`, `keep-${key(DEAD(4))}.jpg`, `local-${'a'.repeat(40)}.jpg`].sort());
  // The kept copy answers even when the cache copy is gone.
  fs.unlinkSync(path.join(thumbsDir, `${key(DEAD(4))}.jpg`));
  const r = await thumb(DEAD(4));
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), pic);
});

test('a creator folder the importer filed in lower case is found', async (t) => {
  const poster = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(3000)]);
  const e = { ...entry(5, 'SomeOne_-_Clip.mp4'), creator: 'SomeOne' };
  const { thumb } = await boot(t, {
    history: [e],
    files: { 'someone/SomeOne_-_Clip.web.mp4': Buffer.alloc(10), 'someone/SomeOne_-_Clip.jpg': poster },
  });
  const r = await thumb(DEAD(5));
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), poster);
});
