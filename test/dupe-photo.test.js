'use strict';
// The photo engine: pHash candidates verified by distance (and by DINOv2
// cosine when vectors exist), grouped into cliques. No model is loaded here:
// embeddings are hand-made vectors.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../dupe-media');
const { hashFrame } = require('../dupe-phash');
const { groupPhotos, phashDistance, explainPair } = require('../dupe-photo');

const has = (bin) => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; }
};
const NO_FF = has('ffmpeg') && has('ffprobe') ? false : 'ffmpeg/ffprobe not installed';

// Flips `n` bits of a 16-hex hash, starting at bit `from`.
function flip(hex, n, from = 0) {
  const bits = BigInt(`0x${hex}`);
  let mask = 0n;
  for (let i = 0; i < n; i++) mask |= 1n << BigInt(from + i);
  return (bits ^ mask).toString(16).padStart(16, '0');
}
const A = '0f1e2d3c4b5a6978';
const UNRELATED = 'f0e1d2c3b4a59687'; // A with every bit flipped
const feat = (sha256, phash, extra = {}) => ({ sha256, kind: 'image', phash, phash_rot: '', width: 100, height: 100, ...extra });
const unit = (v) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v, (x) => x / n);
};
const shasOf = (g) => g.members.map((m) => m.sha256).sort();

test('a close pHash groups as near, an unrelated picture stays out', () => {
  const r = groupPhotos([feat('a', A), feat('b', flip(A, 3)), feat('c', UNRELATED)]);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(shasOf(r.groups[0]), ['a', 'b']);
  assert.equal(r.groups[0].match, 'near');
  assert.equal(r.groups[0].explain.engine, 'phash');
  assert.equal(r.compared, 3);
  const other = r.groups[0].members.find((m) => m.score < 1);
  assert.equal(other.distance, 3);
  assert.equal(other.rotated, false);
});

test('the mode sets how far apart two hashes may be', () => {
  const pair = [feat('a', A), feat('b', flip(A, 7))];
  assert.equal(groupPhotos(pair, new Map(), { mode: 'strict' }).groups.length, 0);
  assert.equal(groupPhotos(pair, new Map(), { mode: 'balanced' }).groups.length, 0);
  assert.equal(groupPhotos(pair, new Map(), { mode: 'relaxed' }).groups.length, 1);
  // An unknown mode falls back to balanced.
  assert.equal(groupPhotos(pair, new Map(), { mode: 'bogus' }).groups.length, 0);
});

test('a rotated copy matches through its stored rotations', () => {
  const upright = feat('up', A, { phash_rot: [UNRELATED, flip(A, 32, 0), flip(A, 32, 32)].join(',') });
  const turned = feat('turned', flip(A, 32, 16), { phash_rot: [flip(A, 1), UNRELATED, UNRELATED].join(',') });
  assert.deepEqual(phashDistance(turned, upright), { d: 32, turn: 0 });
  const d = phashDistance(upright, turned);
  assert.equal(d.turn, 1);
  assert.equal(d.d, 1);
  const r = groupPhotos([upright, turned]);
  assert.equal(r.groups.length, 1);
  const m = r.groups[0].members.find((x) => x.score < 1);
  assert.equal(m.rotated, true);
  assert.ok(m.why.some((w) => /turning it 90 degrees/.test(w)), m.why.join('; '));
});

test('a pair the owner decided on is not grouped again', () => {
  const rows = [feat('a', A), feat('b', flip(A, 2))];
  const r = groupPhotos(rows, new Map(), { decisions: new Map([['a|b', 'different']]) });
  assert.equal(r.groups.length, 0);
});

test('rows without a pHash (errors, skips) are ignored', () => {
  const r = groupPhotos([feat('a', A), feat('b', null, { error: 'could not decode the picture' }), feat('c', flip(A, 1))]);
  assert.equal(r.compared, 2);
  assert.deepEqual(shasOf(r.groups[0]), ['a', 'c']);
});

test('embeddings veto a pHash collision between different pictures', () => {
  const rows = [feat('a', A), feat('b', flip(A, 2))];
  const vecs = new Map([['a', unit([1, 0, 0, 0])], ['b', unit([0, 1, 0, 0])]]);
  assert.equal(groupPhotos(rows, vecs).groups.length, 0);
});

test('embeddings alone find near duplicates and similar pictures', () => {
  // pHashes far apart, so only the vectors can link them.
  const rows = [feat('a', A), feat('b', UNRELATED), feat('c', flip(A, 32, 16))];
  const near = groupPhotos(rows.slice(0, 2), new Map([['a', unit([1, 0.1, 0, 0])], ['b', unit([1, 0.12, 0.02, 0])]]));
  assert.equal(near.groups.length, 1);
  assert.equal(near.groups[0].match, 'near');
  assert.equal(near.groups[0].explain.engine, 'phash+dinov2');

  // cos ~ 0.96: above the 0.955 default threshold, below 0.975.
  const va = unit([1, 0, 0, 0]);
  const vb = unit([1, 0.29, 0, 0]);
  const cos = va.reduce((s, x, i) => s + x * vb[i], 0);
  assert.ok(cos > 0.955 && cos < 0.975, `cos ${cos}`);
  const sim = groupPhotos([rows[0], rows[2]], new Map([['a', va], ['c', vb]]));
  assert.equal(sim.groups.length, 1);
  assert.equal(sim.groups[0].match, 'similar');
  assert.match(sim.groups[0].explain.summary, /compare before removing/);
  // A stricter threshold drops it.
  assert.equal(groupPhotos([rows[0], rows[2]], new Map([['a', va], ['c', vb]]), { threshold: 0.99 }).groups.length, 0);
});

test('groups are cliques: A~B and B~C without A~C is not one group of three', () => {
  const b = flip(A, 5, 0);
  const c = flip(b, 5, 20);
  const r = groupPhotos([feat('a', A), feat('b', b), feat('c', c)]);
  for (const g of r.groups) assert.ok(g.members.length <= 2, JSON.stringify(shasOf(g)));
});

test('explainPair names size, shape and format differences', () => {
  const why = explainPair({ width: 1600, height: 1200, vcodec: 'mjpeg' }, { width: 800, height: 800, vcodec: 'png' }, { d: 3, turn: 0, cos: null });
  assert.ok(why.includes('Perceptual hashes differ in 3 of 64 bits'));
  assert.ok(why.some((w) => /Different size/.test(w)));
  assert.ok(why.includes('Different shape: one may be cropped'));
  assert.ok(why.includes('Different format (mjpeg and png)'));
});

test('real pictures: resized, recompressed, converted and rotated copies group with the source', { skip: NO_FF }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-photo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ff = (...args) => {
    const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  const p = (n) => path.join(dir, n);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=1', '-frames:v', '1', '-q:v', '2', p('original.jpg'));
  ff('-i', p('original.jpg'), '-vf', 'scale=320:240', '-q:v', '2', p('resized.jpg'));
  ff('-i', p('original.jpg'), '-q:v', '25', p('recompressed.jpg'));
  ff('-i', p('original.jpg'), p('converted.png'));
  ff('-i', p('original.jpg'), '-vf', 'transpose=1', '-q:v', '3', p('rotated.jpg'));
  ff('-f', 'lavfi', '-i', 'mandelbrot=size=640x480:rate=1', '-frames:v', '1', '-q:v', '3', p('unrelated.jpg'));

  const names = ['original.jpg', 'resized.jpg', 'recompressed.jpg', 'converted.png', 'rotated.jpg', 'unrelated.jpg'];
  const rows = [];
  for (const n of names) {
    const meta = await media.probe(p(n));
    const img = await media.readImage(p(n));
    const h = hashFrame(img.gray, { rotations: true });
    rows.push({ sha256: n, kind: 'image', phash: h.phash, phash_rot: h.phashRot.join(','), width: meta.width, height: meta.height, vcodec: meta.vcodec });
  }
  for (const mode of ['strict', 'balanced']) {
    const r = groupPhotos(rows, new Map(), { mode });
    const grouped = r.groups.flatMap((g) => g.members.map((m) => m.sha256));
    assert.ok(!grouped.includes('unrelated.jpg'), `${mode}: the unrelated picture stays out`);
    const withOriginal = r.groups.filter((g) => g.members.some((m) => m.sha256 === 'original.jpg'));
    const together = new Set(withOriginal.flatMap((g) => g.members.map((m) => m.sha256)));
    for (const n of ['resized.jpg', 'recompressed.jpg', 'converted.png', 'rotated.jpg']) assert.ok(together.has(n), `${mode}: ${n} groups with the original`);
    for (const g of r.groups) assert.equal(g.match, 'near');
  }
});
