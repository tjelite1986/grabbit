'use strict';
// Perceptual hashes and the candidate index the photo and video engines use.
//
// Input is a 64x64 greyscale frame (ffmpeg scales with an area filter, so the
// result does not depend on the source resolution). From it:
// - pHash: 32x32 DCT, the 8x8 lowest frequencies without DC, each bit = above
//   the median. Robust to resizing, recompression and small colour changes.
// - dHash: 9x8 horizontal gradient signs. A second opinion, cheap.
// - the pHash of the frame rotated 90, 180 and 270 degrees, so a rotated copy
//   is found without decoding it again.
// - sharpness: variance of the Laplacian at 64x64, comparable only between
//   renditions of the same picture (used by quality selection).
//
// Hashes are 16 hex chars (64 bits). Distances are Hamming distances.

const N = 32;

// DCT-II basis, computed once.
const COS = (() => {
  const t = new Float64Array(N * N);
  for (let k = 0; k < N; k++) for (let n = 0; n < N; n++) t[k * N + n] = Math.cos((Math.PI / N) * (n + 0.5) * k);
  return t;
})();

// Area downsample of a square greyscale buffer.
function downsample(src, from, to) {
  const out = new Float64Array(to * to);
  const f = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += src[(y * f + dy) * from + (x * f + dx)];
      out[y * to + x] = s / (f * f);
    }
  }
  return out;
}

function rotate(src, size, quarter) {
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = src[y * size + x];
      if (quarter === 1) out[x * size + (size - 1 - y)] = v;
      else if (quarter === 2) out[(size - 1 - y) * size + (size - 1 - x)] = v;
      else out[(size - 1 - x) * size + y] = v;
    }
  }
  return out;
}

const bitsToHex = (bits) => {
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  return hex;
};

function phash32(m) {
  // 2D DCT, only the 8x8 low corner is needed.
  const rows = new Float64Array(8 * N);
  for (let k = 0; k < 8; k++) {
    for (let y = 0; y < N; y++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += m[y * N + x] * COS[k * N + x];
      rows[k * N + y] = s;
    }
  }
  const coef = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[v * N + y] * COS[u * N + y];
      coef.push(s);
    }
  }
  const ac = coef.slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const med = (sorted[31] + sorted[32]) / 2;
  const bits = coef.map((c, i) => (i === 0 ? 0 : c > med ? 1 : 0));
  // Bit 0 (DC) carries nothing; use the 64th coefficient's place for the
  // overall brightness ordering of the corner so all 64 bits are informative.
  bits[0] = coef[1] > coef[8] ? 1 : 0;
  return bitsToHex(bits);
}

function dhash(gray64) {
  const m = new Float64Array(9 * 8);
  // 9x8 from 64x64 by box filter of roughly 7x8.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      let s = 0;
      let c = 0;
      const x0 = Math.floor((x * 64) / 9);
      const x1 = Math.floor(((x + 1) * 64) / 9);
      for (let yy = y * 8; yy < y * 8 + 8; yy++) for (let xx = x0; xx < x1; xx++) { s += gray64[yy * 64 + xx]; c++; }
      m[y * 9 + x] = s / c;
    }
  }
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(m[y * 9 + x] > m[y * 9 + x + 1] ? 1 : 0);
  return bitsToHex(bits);
}

function sharpness(gray64) {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 1; y < 63; y++) {
    for (let x = 1; x < 63; x++) {
      const i = y * 64 + x;
      const l = 4 * gray64[i] - gray64[i - 1] - gray64[i + 1] - gray64[i - 64] - gray64[i + 64];
      sum += l;
      sq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}

// Standard deviation of the frame: a flat frame (black, white, a title card)
// carries no identity and is ignored by the video matcher.
function contrast(gray64) {
  let s = 0;
  let q = 0;
  for (let i = 0; i < gray64.length; i++) { s += gray64[i]; q += gray64[i] * gray64[i]; }
  const m = s / gray64.length;
  return Math.sqrt(Math.max(0, q / gray64.length - m * m));
}

// All hashes of one 64x64 greyscale frame (Buffer or array of 4096 bytes).
function hashFrame(gray64, { rotations = true } = {}) {
  if (!gray64 || gray64.length !== 4096) throw new Error('need a 64x64 greyscale frame');
  const g = Float64Array.from(gray64);
  const m32 = downsample(g, 64, 32);
  const out = { phash: phash32(m32), dhash: dhash(g), sharpness: sharpness(g), contrast: contrast(g) };
  if (rotations) out.phashRot = [1, 2, 3].map((q) => phash32(rotate(m32, 32, q)));
  return out;
}

// Hamming distance of two 16-hex hashes.
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    d += (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return d;
}

// Candidate pairs among hashes by the pigeonhole rule: split each 64-bit hash
// into `bands` parts; two hashes within distance < bands share at least one
// part exactly. Buckets that grow past `maxBucket` (flat or blank frames) are
// dropped instead of producing a quadratic pile of pairs.
// items: [{ id, hashes: [hex, ...] }] -> Set of "i|j" index pairs (i < j).
function bandPairs(items, { bands = 8, maxBucket = 400 } = {}) {
  const width = 16 / bands;
  const buckets = new Map();
  items.forEach((it, idx) => {
    const seen = new Set();
    for (const h of it.hashes) {
      for (let b = 0; b < bands; b++) {
        const k = `${b}:${h.slice(b * width, (b + 1) * width)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        let arr = buckets.get(k);
        if (!arr) buckets.set(k, (arr = []));
        arr.push(idx);
      }
    }
  });
  const pairs = new Set();
  for (const arr of buckets.values()) {
    if (arr.length < 2 || arr.length > maxBucket) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i] < arr[j] ? arr[i] : arr[j];
        const b = arr[i] < arr[j] ? arr[j] : arr[i];
        if (a !== b) pairs.add(`${a}|${b}`);
      }
    }
  }
  return pairs;
}

module.exports = { hashFrame, hamming, bandPairs, phash32, downsample, rotate };
