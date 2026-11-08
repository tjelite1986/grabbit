'use strict';
// The media viewer: finding an entry's files, keeping every served path inside
// a configured root, and the access rules of the HTTP routes (admin session
// only; app passwords, signed-out and cross-site callers are refused).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const mv = require('../media-viewer');
const gda = require('../gda');

const touch = (file, body = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

test('plain names: one path segment, nothing else', () => {
  for (const ok of ['a.mp4', 'Creator_-_Title [id=1].mp4', 'x ....mp4', '..a.mp4']) assert.equal(mv.isPlainName(ok), true, ok);
  for (const bad of ['', '.', '..', '../x.mp4', 'a/b.mp4', 'a\\b.mp4', 'a\0.mp4', null, 42, 'x'.repeat(1025)]) {
    assert.equal(mv.isPlainName(bad), false, String(bad));
  }
});

test('stems and kinds', () => {
  assert.equal(mv.stemOf('a.web.mp4'), 'a');
  assert.equal(mv.stemOf('a.mp4'), 'a');
  assert.equal(mv.kindOfName('x.WEBM'), 'video');
  assert.equal(mv.kindOfName('x.jpeg'), 'image');
  assert.equal(mv.kindOfName('x.m4a'), 'audio');
  assert.equal(mv.kindOfName('x.md'), 'other');
});

test('findVariants: original, web copy and poster in the first folder that has them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  try {
    const lib = path.join(root, 'lib', 'Creator');
    const imp = path.join(root, 'lib', '_import');
    touch(path.join(lib, 'Creator_-_Clip.mkv'));
    touch(path.join(lib, 'Creator_-_Clip.web.mp4'));
    touch(path.join(lib, 'Creator_-_Clip.jpg'));
    touch(path.join(lib, 'Creator_-_Clip.md'));
    touch(path.join(lib, 'Creator_-_Clip two.mp4')); // another item, same prefix
    touch(path.join(imp, 'Creator_-_Queued.mp4'));
    const roots = [path.join(root, 'lib')];
    const real = (p) => fs.realpathSync(p);

    const a = mv.findVariants('Creator_-_Clip.mkv', [lib, imp], roots);
    assert.equal(a.original, real(path.join(lib, 'Creator_-_Clip.mkv')));
    assert.equal(a.web, real(path.join(lib, 'Creator_-_Clip.web.mp4')));
    assert.equal(a.poster, real(path.join(lib, 'Creator_-_Clip.jpg')));

    // History names the web copy: the original is whatever video shares the stem.
    const b = mv.findVariants('Creator_-_Clip.web.mp4', [lib], roots);
    assert.ok(b.web && b.original);

    // Not in the creator folder yet: found in _import.
    const c = mv.findVariants('Creator_-_Queued.mp4', [lib, imp], roots);
    assert.equal(c.original, real(path.join(imp, 'Creator_-_Queued.mp4')));

    assert.equal(mv.findVariants('Creator_-_Gone.mp4', [lib, imp], roots), null);
    // A picture is its own original; a .jpg beside it is not a "poster".
    touch(path.join(lib, 'Creator_-_Pic.jpg'));
    const d = mv.findVariants('Creator_-_Pic.jpg', [lib], roots);
    assert.equal(d.original, real(path.join(lib, 'Creator_-_Pic.jpg')));
    assert.equal(d.poster, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findVariants: the importer\'s tidied names still match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  try {
    const dir = path.join(root, 'jackroberts');
    touch(path.join(dir, 'jackroberts_-_Every AI app looks the sa.web.mp4'));
    touch(path.join(dir, 'settigation_-_Four boxes. OTP Verification.web.mp4'));
    const a = mv.findVariants('jackroberts_____-_Every AI app looks the sa....mp4', [dir], [root]);
    assert.ok(a && a.web);
    const b = mv.findVariants('settigation_-_Four boxes. OTP Verification ....mp4', [dir], [root]);
    assert.ok(b && b.web);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findVariants: nothing outside the roots, symlinks included', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-'));
  try {
    const inside = path.join(root, 'in');
    const outside = path.join(root, 'out');
    touch(path.join(outside, 'Secret_-_x.mp4'));
    fs.mkdirSync(inside, { recursive: true });
    fs.symlinkSync(path.join(outside, 'Secret_-_x.mp4'), path.join(inside, 'Secret_-_x.mp4'));
    // The file is listed in an allowed folder but resolves outside every root.
    assert.equal(mv.findVariants('Secret_-_x.mp4', [inside], [inside]), null);
    // A folder outside the roots is not searched into either.
    assert.equal(mv.findVariants('Secret_-_x.mp4', [outside], [inside]), null);
    // Traversal in the name never reaches the file system.
    assert.equal(mv.findVariants('../out/Secret_-_x.mp4', [inside], [root]), null);
    // The root itself is not a file inside it.
    assert.equal(mv.insideRoots(inside, [inside]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probe parsing and playability', () => {
  const p = mv.parseProbe(JSON.stringify({
    streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1280, height: 720 }, { codec_type: 'audio', codec_name: 'aac' }],
    format: { duration: '12.345' },
  }));
  assert.deepEqual(p, { width: 1280, height: 720, videoCodec: 'hevc', audioCodec: 'aac', duration: 12.3 });
  assert.equal(mv.parseProbe('not json'), null);
  assert.equal(mv.playability('video', 'mp4', { videoCodec: 'h264' }), 'yes');
  assert.equal(mv.playability('video', 'mp4', p), 'maybe');
  assert.equal(mv.playability('video', 'mkv', { videoCodec: 'h264' }), 'no');
  assert.equal(mv.playability('image', 'heic', null), 'no');
  assert.equal(mv.playability('image', 'webp', null), 'yes');
});

// --- HTTP: who may list, read and stream -----------------------------------------
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('routes: admin only, by entry id, inside the roots', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-http-'));
  const data = path.join(root, 'data');
  const dl = path.join(root, 'downloads');
  fs.mkdirSync(data, { recursive: true });
  touch(path.join(dl, 'videos', 'Maker_-_Clip.mp4'), Buffer.alloc(4096, 7));
  touch(path.join(root, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(dl, 'videos', 'Maker_-_Link.mp4'));
  const now = Date.now();
  fs.writeFileSync(path.join(data, 'history.json'), JSON.stringify([
    { id: `${now}-1`, time: now, creator: 'Maker', title: 'Clip', channel: 'server/videos', filename: 'Maker_-_Clip.mp4', sourceUrl: 'https://example.com/v/1' },
    { id: `${now}-2`, time: now, creator: 'Maker', title: 'Link', channel: 'server/videos', filename: 'Maker_-_Link.mp4' },
    { id: `${now}-3`, time: now, creator: 'Maker', title: 'Up', channel: 'server/videos/..', filename: 'secret.txt' },
    { id: `${now}-4`, time: now, creator: 'Maker', title: 'Dots', channel: 'server/videos', filename: '../secret.txt' },
  ]));
  const reg = gda.createRegistry({ file: path.join(data, 'gda-clients.json'), sessionSecret: 'x' });
  reg.upsertClient({ client_id: 'someapp', audience: 'general', allowed_targets: ['server.downloads'], allowed_ops: ['job', 'status'], legacy_main_target: 'server.downloads' });
  const appPw = reg.setPassword('someapp');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATA_DIR: data,
      GRABBIT_PASSWORD: 'admin-pw',
      DOWNLOAD_DIR: dl,
      ADULTS_DOWNLOAD_DIR: path.join(dl, 'adults'),
      NAVIDROME_MUSIC_DIR: path.join(root, 'm'),
      NAVIDROME_KIDS_DIR: path.join(root, 'k'),
      AUDIOBOOKS_DIR: path.join(root, 'b'),
      STATE_BACKUP_DAYS: '0',
      YTDLP_BIN: '/bin/false',
      GALLERY_DL_BIN: '/bin/false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  t.after(() => {
    proc.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !logs.includes('grabbit listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.includes('grabbit listening'), logs);

  const login = async (pw) => {
    const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(pw)}`, redirect: 'manual' });
    return (r.headers.getSetCookie() || []).map((v) => v.split(';')[0]).find((v) => /^grabbit_auth=./.test(v));
  };
  const admin = await login('admin-pw');
  const app = await login(appPw);
  assert.ok(admin && app);
  const get = (p, cookie, headers = {}) => fetch(base + p, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });

  const list = await (await get('/api/hub/media', admin)).json();
  assert.deepEqual(list.items.map((i) => i.id).sort(), [`${now}-1`, `${now}-2`, `${now}-3`]); // '../secret.txt' is never listed
  const one = list.items.find((i) => i.id === `${now}-1`);
  assert.equal(one.kind, 'video');

  const detail = await (await get(`/api/hub/media/${now}-1`, admin)).json();
  assert.equal(detail.item.available, true);
  assert.equal(detail.item.variants[0].bytes, 4096);

  const ranged = await get(`/api/hub/media/${now}-1/file?v=original`, admin, { Range: 'bytes=0-99' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-99/4096');
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  // A symlink out of the library, a channel that climbs out, a bad variant, a bad id.
  for (const p of [`/api/hub/media/${now}-2/file`, `/api/hub/media/${now}-3/file`, `/api/hub/media/${now}-1/file?v=../x`, '/api/hub/media/..%2Fsecret.txt/file']) {
    const r = await get(p, admin);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /secret/);
  }
  assert.equal((await (await get(`/api/hub/media/${now}-3`, admin)).json()).item.available, false);

  // Who else is refused.
  assert.equal((await get('/api/hub/media', null)).status, 401);
  assert.equal((await get(`/api/hub/media/${now}-1/file`, null)).status, 401);
  assert.equal((await get('/api/hub/media', app)).status, 403);
  assert.equal((await get(`/api/hub/media/${now}-1/file`, app)).status, 403);
  assert.equal((await get(`/api/hub/media/${now}-1/file`, admin, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});
