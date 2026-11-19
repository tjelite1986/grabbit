'use strict';
// The video engine: keyframe fingerprints plus same-time probes, re-encode
// matching across codecs and sizes, and clips cut from a longer video.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../dupe-media');
const { hashFrame } = require('../dupe-phash');
const { packFrames, packProbes, unpackFrames, compareVideos, groupVideos, groupVideosAsync, PROBE_AT } = require('../dupe-video');

const has = (bin) => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; }
};
const NO_FF = has('ffmpeg') && has('ffprobe') ? false : 'ffmpeg/ffprobe not installed';
const FLAT = 'ffffffffffffffff';

// A deterministic 64x64 grey frame with plenty of contrast.
function pattern(seed) {
  const b = Buffer.alloc(4096);
  let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 4096; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

test('packFrames keeps frames with their times and drops flat ones', () => {
  const frames = [
    { t: 0, gray: Buffer.alloc(4096, 0) }, // black
    { t: 0.5, gray: pattern(1) },
    { t: 1, gray: Buffer.alloc(4096, 200) }, // a single-colour card
    { t: 1.5, gray: pattern(2) },
    { t: 2, gray: pattern(3) },
  ];
  const p = packFrames(frames);
  assert.equal(p.count, 3);
  assert.equal(p.buf.length, 3 * 12);
  const back = unpackFrames(p.buf);
  assert.deepEqual(back.map((f) => f.t), [0.5, 1.5, 2]);
  assert.equal(back[0].h, hashFrame(pattern(1), { rotations: false }).phash);
  assert.equal(typeof p.sharpness, 'number');
  assert.deepEqual(unpackFrames(null), []);
  assert.equal(packFrames([]).sharpness, null);
});

test('packProbes keeps one slot per position and marks unreadable or flat ones', () => {
  const buf = packProbes([{ t: 1, gray: pattern(5) }, { t: 2, gray: null }, { t: 3, gray: Buffer.alloc(4096, 9) }]);
  const back = unpackFrames(buf);
  assert.equal(back.length, 3);
  assert.equal(back[0].h, hashFrame(pattern(5), { rotations: false }).phash);
  assert.equal(back[1].h, FLAT);
  assert.equal(back[2].h, FLAT);
  assert.deepEqual(back.map((f) => f.t), [1, 2, 3]);
});

test('compareVideos needs at least three distinct frames on each side', () => {
  const two = { sha256: 'a', duration: 10, framesList: [{ t: 0, h: '0'.repeat(16) }, { t: 1, h: '1'.repeat(16) }], probesList: [] };
  const many = { sha256: 'b', duration: 10, framesList: [0, 1, 2, 3].map((t) => ({ t, h: '0'.repeat(16) })), probesList: [] };
  assert.equal(compareVideos(two, many), null);
});

test('rows without enough frames or a duration are left out of grouping', () => {
  const p = packFrames([pattern(1), pattern(2)].map((gray, t) => ({ t, gray })));
  const r = groupVideos([
    { sha256: 'a', duration: 5, frames: p.buf, probes: null },
    { sha256: 'b', duration: null, frames: packFrames([1, 2, 3, 4].map((s, t) => ({ t, gray: pattern(s) }))).buf, probes: null },
  ]);
  assert.equal(r.compared, 0);
  assert.deepEqual(r.groups, []);
});

// Video grouping over many candidate pairs hands the event loop back while it
// works, and gives the same groups as the one-go version. Run in one go on a
// real library it once held every other request for over seven minutes.
test('groupVideosAsync yields to the event loop and matches groupVideos', async () => {
  const rows = [];
  for (let g = 0; g < 12; g++) {
    const buf = packFrames([0, 1, 2, 3, 4, 5].map((t) => ({ t, gray: pattern(100 + g * 10 + t) }))).buf;
    for (let i = 0; i < 25; i++) rows.push({ sha256: `g${g}v${i}`, duration: 6, frames: buf, probes: null });
  }
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const r = await groupVideosAsync(rows);
  clearInterval(timer);
  assert.ok(ticks > 0, 'timers ran while grouping');
  const s = groupVideos(rows);
  assert.equal(r.candidates, s.candidates);
  assert.deepEqual(r.groups, s.groups);
  assert.equal(r.groups.length, 12);
});

let fixtures = null;
// An 8 s source, a re-encode (other codec, size, container, keyframe
// spacing), a 3 s clip cut from 3 s in, and an unrelated video of the same
// length. 320x240 at 10 fps: small enough for a Pi.
function fx() {
  if (fixtures) return fixtures;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-video-'));
  const ff = (...args) => {
    const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  const f = { dir, source: path.join(dir, 'source.mp4'), reencoded: path.join(dir, 'reencoded.avi'), clip: path.join(dir, 'clip.mp4'), other: path.join(dir, 'other.mp4') };
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '5', '-pix_fmt', 'yuv420p'];
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-t', '8', ...x264, f.source);
  ff('-i', f.source, '-vf', 'scale=160:120', '-c:v', 'mpeg4', '-q:v', '8', '-g', '7', f.reencoded);
  ff('-ss', '3', '-i', f.source, '-t', '3', ...x264, f.clip);
  ff('-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=10', '-t', '8', ...x264, f.other);
  fixtures = f;
  return f;
}
test.after(() => { if (fixtures) fs.rmSync(fixtures.dir, { recursive: true, force: true }); });

// What the analyser stores for one file.
const featureCache = new Map();
async function feature(name) {
  if (featureCache.has(name)) return featureCache.get(name);
  const file = fx()[name];
  const meta = await media.probe(file);
  const packed = packFrames(await media.readVideoFrames(file));
  const probes = packProbes(await media.readFramesAt(file, meta.duration, PROBE_AT));
  const row = { sha256: name, kind: 'video', ...meta, frames: packed.buf, probes, sharpness: packed.sharpness };
  featureCache.set(name, row);
  return row;
}
const listed = (row) => ({ ...row, framesList: unpackFrames(row.frames), probesList: unpackFrames(row.probes) });

test('a re-encode in another codec, size and container groups with its source', { skip: NO_FF }, async () => {
  const r = compareVideos(listed(await feature('source')), listed(await feature('reencoded')));
  assert.ok(r, 'matched');
  assert.equal(r.match, 'reencoded');
  assert.ok(r.score >= 0.8);
  assert.ok(r.quarters >= 3);
});

test('a clip cut from a longer video is reported as partial at its offset', { skip: NO_FF }, async () => {
  const r = compareVideos(listed(await feature('clip')), listed(await feature('source')));
  assert.ok(r, 'matched');
  assert.equal(r.match, 'partial');
  assert.equal(r.clip, 'clip');
  assert.equal(r.source, 'source');
  assert.equal(r.offset, 3);
});

test('an unrelated video of the same length does not match', { skip: NO_FF }, async () => {
  assert.equal(compareVideos(listed(await feature('source')), listed(await feature('other'))), null);
  assert.equal(compareVideos(listed(await feature('reencoded')), listed(await feature('other'))), null);
  assert.equal(compareVideos(listed(await feature('clip')), listed(await feature('other'))), null);
});

test('groupVideos: one re-encode group, the clip listed apart as partial, the unrelated video nowhere', { skip: NO_FF }, async () => {
  const rows = [];
  for (const n of ['source', 'reencoded', 'clip', 'other']) rows.push(await feature(n));
  const r = groupVideos(rows);
  assert.equal(r.compared, 4);
  const full = r.groups.filter((g) => g.match !== 'partial');
  const partial = r.groups.filter((g) => g.match === 'partial');
  assert.equal(full.length, 1);
  assert.equal(full[0].match, 'reencoded');
  assert.deepEqual(full[0].members.map((m) => m.sha256).sort(), ['reencoded', 'source']);
  const why = full[0].members.find((m) => !m.why.includes('Reference video of this group')).why.join('; ');
  assert.match(why, /Different codec/);
  assert.match(why, /Different resolution/);
  const pc = partial.find((g) => g.members.some((m) => m.sha256 === 'clip' && m.role === 'clip'));
  assert.ok(pc, 'the clip is listed as partial');
  assert.equal(pc.members.find((m) => m.role === 'source').sha256, 'source');
  assert.equal(pc.members.find((m) => m.role === 'clip').offset, 3);
  const everywhere = r.groups.flatMap((g) => g.members.map((m) => m.sha256));
  assert.ok(!everywhere.includes('other'));
});

test('a pair the owner decided on is not grouped again', { skip: NO_FF }, async () => {
  const rows = [await feature('source'), await feature('reencoded')];
  const r = groupVideos(rows, { decisions: new Map([['reencoded|source', 'different']]) });
  assert.deepEqual(r.groups, []);
});
