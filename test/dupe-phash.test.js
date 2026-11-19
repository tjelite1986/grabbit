'use strict';
// Perceptual hashes and the candidate band index.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashFrame, hamming, bandPairs, phash32, downsample, rotate } = require('../dupe-phash');

// Deterministic pseudo-random numbers, so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// A 64x64 frame with some structure: smooth blobs, no flat areas.
function frame(seed) {
  const r = rng(seed);
  const cx = [r() * 64, r() * 64, r() * 64];
  const cy = [r() * 64, r() * 64, r() * 64];
  const out = Buffer.alloc(4096);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += 80 * Math.exp(-((x - cx[k]) ** 2 + (y - cy[k]) ** 2) / 200);
      out[y * 64 + x] = Math.min(255, Math.round(20 + v + x));
    }
  }
  return out;
}

const fill = (fn) => {
  const b = Buffer.alloc(4096);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) b[y * 64 + x] = fn(x, y);
  return b;
};
const popcount = (hex) => hamming(hex, '0000000000000000');

test('hashFrame refuses anything but 4096 values', () => {
  assert.throws(() => hashFrame(null), /64x64/);
  assert.throws(() => hashFrame(Buffer.alloc(4095)), /64x64/);
  assert.throws(() => hashFrame(Buffer.alloc(64 * 64 * 3)), /64x64/);
});

test('hashFrame returns 16-hex hashes and three rotations', () => {
  const h = hashFrame(frame(1));
  assert.match(h.phash, /^[0-9a-f]{16}$/);
  assert.match(h.dhash, /^[0-9a-f]{16}$/);
  assert.equal(h.phashRot.length, 3);
  for (const r of h.phashRot) assert.match(r, /^[0-9a-f]{16}$/);
  assert.equal(typeof h.sharpness, 'number');
  assert.equal(typeof h.contrast, 'number');
});

test('rotations can be switched off', () => {
  assert.equal('phashRot' in hashFrame(frame(1), { rotations: false }), false);
});

test('a Buffer and a plain array give the same hashes', () => {
  const b = frame(2);
  assert.deepEqual(hashFrame([...b]), hashFrame(b));
});

test('the hash is deterministic', () => {
  assert.deepEqual(hashFrame(frame(3)), hashFrame(frame(3)));
});

test('a rotated frame hashes to the matching phashRot of the original', () => {
  const g = frame(4);
  const h = hashFrame(g);
  for (const q of [1, 2, 3]) {
    const rotated = Array.from(rotate(Float64Array.from(g), 64, q));
    assert.equal(hashFrame(rotated).phash, h.phashRot[q - 1], `quarter ${q}`);
  }
});

test('small noise keeps the pHash close', () => {
  const g = frame(5);
  const r = rng(99);
  const noisy = Buffer.from(g.map((v) => Math.max(0, Math.min(255, v + Math.round((r() - 0.5) * 6)))));
  assert.ok(hamming(hashFrame(g).phash, hashFrame(noisy).phash) <= 6);
});

test('a brightness shift keeps the pHash close', () => {
  const g = frame(6);
  const brighter = Buffer.from(g.map((v) => Math.min(255, v + 10)));
  assert.ok(hamming(hashFrame(g).phash, hashFrame(brighter).phash) <= 4);
});

test('different pictures are far apart', () => {
  const a = hashFrame(frame(7)).phash;
  const b = hashFrame(fill((x, y) => ((x >> 3) + (y >> 3)) % 2 ? 230 : 20)).phash;
  assert.ok(hamming(a, b) > 16, `distance ${hamming(a, b)}`);
});

test('pHash bits split around the median', () => {
  // Bits 1..63 are "above the median of 63 AC values", so 31 of them are set;
  // bit 0 adds at most one more.
  const n = popcount(hashFrame(frame(8)).phash);
  assert.ok(n === 31 || n === 32, `popcount ${n}`);
});

test('dHash reads horizontal gradient direction', () => {
  assert.equal(hashFrame(fill((x) => 255 - x * 4)).dhash, 'ffffffffffffffff');
  assert.equal(hashFrame(fill((x) => x * 4)).dhash, '0000000000000000');
});

test('sharpness: flat and linear ramps are zero, edges are high', () => {
  assert.equal(hashFrame(fill(() => 128)).sharpness, 0);
  assert.equal(hashFrame(fill((x) => x * 2)).sharpness, 0);
  const checker = hashFrame(fill((x, y) => (x + y) % 2 ? 255 : 0)).sharpness;
  const blobs = hashFrame(frame(9)).sharpness;
  assert.ok(checker > blobs && blobs >= 0);
});

test('contrast is the standard deviation of the frame', () => {
  assert.equal(hashFrame(fill(() => 77)).contrast, 0);
  assert.equal(hashFrame(fill((x) => (x < 32 ? 0 : 200))).contrast, 100);
});

test('downsample averages square blocks', () => {
  assert.deepEqual(Array.from(downsample([1, 3, 5, 7, 1, 3, 5, 7, 2, 2, 0, 0, 2, 2, 0, 0], 4, 2)), [2, 6, 2, 0]);
});

test('rotate turns a quarter clockwise and four quarters are identity', () => {
  const m = [1, 2, 3, 4];
  assert.deepEqual(Array.from(rotate(m, 2, 1)), [3, 1, 4, 2]);
  assert.deepEqual(Array.from(rotate(m, 2, 2)), [4, 3, 2, 1]);
  assert.deepEqual(Array.from(rotate(m, 2, 3)), [2, 4, 1, 3]);
  assert.deepEqual(Array.from(rotate(rotate(m, 2, 1), 2, 3)), m);
});

test('phash32 takes a 32x32 matrix directly', () => {
  const m32 = downsample(Float64Array.from(frame(10)), 64, 32);
  assert.equal(phash32(m32), hashFrame(frame(10)).phash);
});

test('hamming counts differing bits', () => {
  assert.equal(hamming('0123456789abcdef', '0123456789abcdef'), 0);
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hamming('0000000000000001', '0000000000000000'), 1);
  assert.equal(hamming('8000000000000000', '0000000000000000'), 1);
  assert.equal(hamming('00000000ffffffff', '0000000000000000'), 32);
  assert.equal(hamming('ABCDEF0000000000', 'abcdef0000000000'), 0);
});

test('hamming is symmetric', () => {
  const r = rng(7);
  const hex = () => Array.from({ length: 16 }, () => Math.floor(r() * 16).toString(16)).join('');
  for (let i = 0; i < 20; i++) {
    const a = hex();
    const b = hex();
    assert.equal(hamming(a, b), hamming(b, a));
  }
});

// Flips `n` distinct bits of a 16-hex hash.
function flip(hex, n, r) {
  const bits = [...hex].flatMap((c) => parseInt(c, 16).toString(2).padStart(4, '0').split('').map(Number));
  const idx = new Set();
  while (idx.size < n) idx.add(Math.floor(r() * 64));
  for (const i of idx) bits[i] ^= 1;
  let out = '';
  for (let i = 0; i < 64; i += 4) out += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16);
  return out;
}

test('bandPairs finds every pair closer than the band count', () => {
  const r = rng(11);
  for (let t = 0; t < 50; t++) {
    const a = flip('0123456789abcdef', 5, r);
    const b = flip(a, 7, r);
    assert.equal(hamming(a, b), 7);
    assert.ok(bandPairs([{ id: 1, hashes: [a] }, { id: 2, hashes: [b] }]).has('0|1'), `${a} ${b}`);
  }
});

test('bandPairs skips hashes that differ in every band', () => {
  const pairs = bandPairs([{ id: 1, hashes: ['0000000000000000'] }, { id: 2, hashes: ['1111111111111111'] }]);
  assert.equal(pairs.size, 0);
});

test('bandPairs matches across any of an item\'s hashes and orders the pair', () => {
  const items = [
    { id: 'a', hashes: ['ffffffffffffffff', '0123456789abcdef'] },
    { id: 'b', hashes: ['fedcba9876543210'] },
    { id: 'c', hashes: ['0123456789abcdef'] },
  ];
  assert.deepEqual([...bandPairs(items)], ['0|2']);
});

test('bandPairs never pairs an item with itself', () => {
  assert.equal(bandPairs([{ id: 1, hashes: ['0123456789abcdef', '0123456789abcdef'] }]).size, 0);
});

test('bandPairs drops buckets above maxBucket', () => {
  const items = [1, 2, 3].map((id) => ({ id, hashes: ['0123456789abcdef'] }));
  assert.equal(bandPairs(items).size, 3);
  assert.equal(bandPairs(items, { maxBucket: 2 }).size, 0);
});

test('bandPairs honours a smaller band count', () => {
  // Same first 4 hex chars only.
  const items = [{ id: 1, hashes: ['abcd000000000000'] }, { id: 2, hashes: ['abcdffffffffffff'] }];
  assert.equal(bandPairs(items, { bands: 4 }).size, 1);
  assert.equal(bandPairs([{ id: 1, hashes: ['abc0000000000000'] }, { id: 2, hashes: ['abcfffffffffffff'] }], { bands: 4 }).size, 0);
});

test('bandPairs stops at maxPairs and says so', () => {
  const items = Array.from({ length: 30 }, () => ({ hashes: ['0123456789abcdef'] }));
  const all = bandPairs(items);
  assert.equal(all.size, 435);
  assert.equal(all.capped, false);
  const cut = bandPairs(items, { maxPairs: 100 });
  assert.equal(cut.size, 100);
  assert.equal(cut.capped, true);
});
