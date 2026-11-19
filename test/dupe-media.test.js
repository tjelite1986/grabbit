'use strict';
// The ffprobe / ffmpeg wrappers the duplicate engines read media through:
// low priority, bounded output and time, and errors that reject instead of
// hanging or crashing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../dupe-media');

const has = (bin, arg = '-version') => {
  try { return spawnSync(bin, [arg], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; }
};
const HAS_FF = has('ffmpeg') && has('ffprobe');
const NO_FF = HAS_FF ? false : 'ffmpeg/ffprobe not installed';

let fixtures = null;
// Tiny fixtures, made once for the file: a 3 s video, the same video marked
// as rotated, a picture, and files that only claim to be media.
function fx() {
  if (fixtures) return fixtures;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-media-'));
  const ff = (...args) => {
    const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  const f = {
    dir,
    video: path.join(dir, 'clip.mp4'),
    rotated: path.join(dir, 'rotated.mp4'),
    photo: path.join(dir, 'photo.jpg'),
    corrupt: path.join(dir, 'corrupt.mp4'),
    corruptJpg: path.join(dir, 'corrupt.jpg'),
    missing: path.join(dir, 'missing.mp4'),
  };
  ff('-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '5', '-pix_fmt', 'yuv420p', f.video);
  ff('-display_rotation', '90', '-i', f.video, '-c', 'copy', f.rotated);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1', '-frames:v', '1', '-q:v', '3', f.photo);
  fs.writeFileSync(f.corrupt, 'this is not a video, only text with a video name\n'.repeat(20));
  fs.writeFileSync(f.corruptJpg, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 0x41)]));
  fixtures = f;
  return f;
}
test.after(() => { if (fixtures) fs.rmSync(fixtures.dir, { recursive: true, force: true }); });

test('run starts children under nice and ionice when the system has them', { skip: !(has('nice', '--version') && has('ionice', '--version')) && 'nice/ionice missing' }, async () => {
  // `nice` with no arguments prints the niceness it runs at; `ionice` with no
  // arguments prints its own I/O class.
  const n = await media.run('nice', []);
  assert.equal(Number(n.stdout.toString().trim()), Math.min(19, os.getPriority() + 15));
  const io = await media.run('ionice', []);
  assert.match(io.stdout.toString(), /idle/);
});

test('run rejects a non-zero exit with the last stderr line', async () => {
  await assert.rejects(
    media.run('sh', ['-c', 'echo first >&2; echo "the last line" >&2; exit 3']),
    /^Error: sh failed: the last line$/
  );
  await assert.rejects(media.run('sh', ['-c', 'exit 4']), /sh failed: exit 4/);
});

test('run kills a child that runs too long or prints too much', async () => {
  const t0 = Date.now();
  await assert.rejects(media.run('sleep', ['20'], { timeoutMs: 300 }), /sleep timed out/);
  assert.ok(Date.now() - t0 < 5000, 'the timeout ended the child');
  await assert.rejects(media.run('head', ['-c', '500000', '/dev/zero'], { maxBytes: 1000 }), /head output too large/);
});

test('run rejects a binary that does not exist', async () => {
  await assert.rejects(media.run('grabbit-no-such-binary-x7', []));
});

test('probe reads size, length, rate, codecs and container of a video', { skip: NO_FF }, async () => {
  const p = await media.probe(fx().video);
  assert.equal(p.width, 160);
  assert.equal(p.height, 120);
  assert.ok(Math.abs(p.duration - 3) < 0.2, `duration ${p.duration}`);
  assert.equal(p.fps, 10);
  assert.equal(p.vcodec, 'h264');
  assert.equal(p.acodec, null);
  assert.equal(p.container, 'mov');
  assert.ok(p.bitrate > 0);
});

test('probe reports a rotated video in its displayed orientation', { skip: NO_FF }, async () => {
  const p = await media.probe(fx().rotated);
  assert.equal(p.width, 120);
  assert.equal(p.height, 160);
});

test('probe reads a picture and rejects missing and corrupt files', { skip: NO_FF }, async () => {
  const p = await media.probe(fx().photo);
  assert.equal(p.width, 320);
  assert.equal(p.height, 240);
  assert.equal(p.vcodec, 'mjpeg');
  await assert.rejects(media.probe(fx().corrupt), /ffprobe failed/);
  await assert.rejects(media.probe(fx().missing), /ffprobe failed/);
});

test('readImage gives a 64x64 grey frame, and the 224x224 RGB crop when asked', { skip: NO_FF }, async () => {
  const g = await media.readImage(fx().photo);
  assert.equal(g.gray.length, 64 * 64);
  assert.equal(g.rgb, null);
  const both = await media.readImage(fx().photo, { rgb: true });
  assert.equal(both.gray.length, 64 * 64);
  assert.equal(both.rgb.length, 224 * 224 * 3);
  assert.deepEqual(both.gray, g.gray, 'the grey frame does not depend on the RGB branch');
});

test('readImage rejects a corrupt picture instead of returning a bad frame', { skip: NO_FF }, async () => {
  await assert.rejects(media.readImage(fx().corruptJpg));
  await assert.rejects(media.readImage(fx().corruptJpg, { rgb: true }));
  await assert.rejects(media.readImage(fx().missing));
});

test('readVideoFrames returns keyframes in time order, and samples down to maxFrames', { skip: NO_FF }, async () => {
  const all = await media.readVideoFrames(fx().video);
  // 3 s at 10 fps with a keyframe every 5 frames.
  assert.equal(all.length, 6);
  for (const f of all) assert.equal(f.gray.length, 4096);
  assert.deepEqual(all.map((f) => Math.round(f.t * 10) / 10), [0, 0.5, 1, 1.5, 2, 2.5]);
  const few = await media.readVideoFrames(fx().video, { maxFrames: 3 });
  assert.deepEqual(few.map((f) => Math.round(f.t * 10) / 10), [0, 1, 2]);
  await assert.rejects(media.readVideoFrames(fx().corrupt));
});

test('readFramesAt returns one entry per position and never throws', { skip: NO_FF }, async () => {
  const r = await media.readFramesAt(fx().video, 3, [0.1, 0.5, 5]);
  assert.equal(r.length, 3);
  assert.equal(r[0].gray.length, 4096);
  assert.equal(r[1].gray.length, 4096);
  assert.ok(Math.abs(r[1].t - 1.5) < 1e-9);
  assert.equal(r[2].gray, null, 'a position past the end has no frame');
  const bad = await media.readFramesAt(fx().corrupt, 3, [0.2, 0.8]);
  assert.deepEqual(bad.map((x) => x.gray), [null, null]);
});

test('exists is true only for a regular file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a'), 'x');
  assert.equal(media.exists(path.join(dir, 'a')), true);
  assert.equal(media.exists(dir), false);
  assert.equal(media.exists(path.join(dir, 'nope')), false);
});
