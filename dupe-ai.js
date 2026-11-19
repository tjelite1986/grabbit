'use strict';
// DINOv2 image embeddings for the AI Photo Engine, run locally with ONNX
// Runtime. Nothing leaves the server: the only network call is the one-time
// download of a model file, which the owner starts from Settings.
//
// Adapted from photo-duplicate-finder-ai (MIT, Copyright (c) 2026 Nikolay
// Fedotov, https://github.com/nikweel/photo-duplicate-finder-ai): the model
// catalogue and file sizes, the preprocessing (short side to 256 bicubic,
// centre crop 224, ImageNet mean/std), L2-normalised CLS embeddings, the
// per-model similarity thresholds and their sensitivity span. The ONNX models
// are DINOv2 (Apache-2.0, Meta Platforms) exported by that project.
// See THIRD_PARTY_NOTICES.md.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RELEASE = 'https://github.com/nikweel/photo-duplicate-finder-ai/releases/download/v0.1/';

// thrDefault: cosine threshold at the default sensitivity (33 of 100);
// thrSpan: how far it moves from the strictest to the most relaxed setting.
const MODELS = {
  light: { id: 'light', label: 'Light (DINOv2 small, 44 MB)', file: 'dinov2_small.onnx', dim: 384, bytes: 44397267, sha256: '3de1a4e5f3916da13c9367cf5873d8aebd048a23bbede3a91ff7b499b5ca1687', thrDefault: 0.955, thrSpan: 0.06, ramMb: 350 },
  medium: { id: 'medium', label: 'Medium (DINOv2 base, 174 MB)', file: 'dinov2_base.onnx', dim: 768, bytes: 173549573, sha256: null, thrDefault: 0.96, thrSpan: 0.06, ramMb: 900 },
  heavy: { id: 'heavy', label: 'Heavy (DINOv2 large, 609 MB)', file: 'dinov2_large.onnx', dim: 1024, bytes: 609124541, sha256: null, thrDefault: 0.925, thrSpan: 0.1, ramMb: 2600 },
};
const DEFAULT_SENSITIVITY = 33;
// Embeddings are tagged with this, so a change in preprocessing or export
// invalidates them without touching the owner's review decisions.
const PREP_VERSION = 'p1';
const versionOf = (model) => `${model}-${PREP_VERSION}`;

const MODES = { strict: 0, balanced: DEFAULT_SENSITIVITY, relaxed: 66 };

function thresholdFor(modelId, sensitivity = DEFAULT_SENSITIVITY) {
  const spec = MODELS[modelId] || MODELS.light;
  const s = Math.max(0, Math.min(100, Number(sensitivity)));
  return Math.round((spec.thrDefault + ((DEFAULT_SENSITIVITY - s) / 100) * spec.thrSpan) * 10000) / 10000;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// 224x224 RGB24 bytes -> CHW float32, normalised.
function toTensorData(rgb, rotate = 0) {
  const S = 224;
  const out = new Float32Array(3 * S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let sx = x;
      let sy = y;
      if (rotate === 1) { sx = y; sy = S - 1 - x; } else if (rotate === 2) { sx = S - 1 - x; sy = S - 1 - y; } else if (rotate === 3) { sx = S - 1 - y; sy = x; }
      const i = (sy * S + sx) * 3;
      for (let c = 0; c < 3; c++) out[c * S * S + y * S + x] = (rgb[i + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return out;
}

function normalise(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function runtime() {
  try {
    return require('onnxruntime-node');
  } catch {
    return null;
  }
}

function hashFileSync(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// The whole model transfer must finish within this time (the heavy model is
// 609 MB; 30 minutes is about 340 kB/s).
const DOWNLOAD_DEADLINE_MS = 30 * 60 * 1000;

class ModelManager {
  constructor({ dir, fetchImpl = globalThis.fetch, log = console.log } = {}) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.log = log;
    this.downloading = null;
    this.progress = null;
  }

  fileOf(id) {
    return path.join(this.dir, MODELS[id].file);
  }

  // Installed means the exact pinned bytes: ONNX Runtime parses the file
  // natively, so a file of the right size but other content is never loaded.
  // The hash is computed once per (inode, size, mtime) and remembered.
  installed(id) {
    const spec = MODELS[id];
    if (!spec || !spec.sha256) return false;
    let st;
    try {
      st = fs.statSync(this.fileOf(id));
    } catch {
      return false;
    }
    if (!st.isFile() || st.size !== spec.bytes) return false;
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (!this.verified) this.verified = new Map();
    const known = this.verified.get(id);
    if (known && known.sig === sig) return known.ok;
    const ok = hashFileSync(this.fileOf(id)) === spec.sha256;
    if (!ok) this.log(`dupes: model ${id} on disk does not match its checksum; it is not loaded`);
    this.verified.set(id, { sig, ok });
    return ok;
  }

  status() {
    return Object.values(MODELS).map((m) => ({
      id: m.id, label: m.label, bytes: m.bytes, ramMb: m.ramMb, installed: this.installed(m.id),
      downloading: this.downloading === m.id ? this.progress : null,
      lastError: this.lastError && this.lastError.id === m.id ? this.lastError.error : null,
    }));
  }

  // Downloads one model file to <dir>/<file>.part, checks the exact size (and
  // the pinned sha256 where known), then renames it into place.
  async download(id) {
    const spec = MODELS[id];
    if (!spec) throw new Error('Unknown model');
    if (this.installed(id)) return { already: true };
    // Only a model whose exact bytes are pinned here may be fetched: ONNX
    // Runtime parses the file natively, so an unverified file is not loaded.
    if (!spec.sha256) throw new Error(`The ${spec.id} model has no pinned checksum in this build yet`);
    if (this.downloading) throw new Error('A model download is already running');
    this.downloading = id;
    this.progress = { bytes: 0, total: spec.bytes };
    this.lastError = null;
    const part = `${this.fileOf(id)}.part`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // A stalled transfer must not hold the download slot until a restart.
      const res = await this.fetch(RELEASE + spec.file, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_DEADLINE_MS) });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(part, 'w');
      try {
        for await (const chunk of res.body) {
          const b = Buffer.from(chunk);
          hash.update(b);
          fs.writeSync(fd, b);
          this.progress.bytes += b.length;
          if (this.progress.bytes > spec.bytes) throw new Error('The model file is larger than expected');
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.statSync(part).size !== spec.bytes) throw new Error('The model file came out short');
      const digest = hash.digest('hex');
      if (spec.sha256 && digest !== spec.sha256) throw new Error('The model file does not match its checksum');
      fs.renameSync(part, this.fileOf(id));
      this.log(`dupes: model ${id} installed (${spec.bytes} bytes, sha256 ${digest.slice(0, 16)})`);
      return { installed: true, sha256: digest };
    } catch (e) {
      try { fs.unlinkSync(part); } catch {}
      this.lastError = { id, error: e.name === 'TimeoutError' ? 'The download took too long and was stopped' : e.message, at: Date.now() };
      throw e;
    } finally {
      this.downloading = null;
      this.progress = null;
    }
  }
}

class Embedder {
  constructor({ modelId, file, threads = 2 }) {
    this.modelId = modelId;
    this.file = file;
    this.threads = threads;
    this.session = null;
    this.ort = null;
  }

  async load() {
    if (this.session) return;
    this.ort = runtime();
    if (!this.ort) throw new Error('ONNX Runtime is not installed in this build');
    this.session = await this.ort.InferenceSession.create(this.file, {
      intraOpNumThreads: this.threads,
      interOpNumThreads: 1,
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }

  // One 224x224 RGB crop -> L2-normalised embedding (Float32Array). With
  // rotations, the embeddings of the 90/180/270-degree turns as well.
  async embed(rgb, { rotations = false } = {}) {
    await this.load();
    const turns = rotations ? [0, 1, 2, 3] : [0];
    const data = new Float32Array(turns.length * 3 * 224 * 224);
    turns.forEach((q, i) => data.set(toTensorData(rgb, q), i * 3 * 224 * 224));
    const x = new this.ort.Tensor('float32', data, [turns.length, 3, 224, 224]);
    const out = await this.session.run({ pixel_values: x });
    const e = out[this.session.outputNames[0]];
    const dim = e.dims[1];
    return turns.map((_, i) => normalise(e.data.subarray(i * dim, (i + 1) * dim)));
  }

  async close() {
    if (this.session && this.session.release) await this.session.release();
    this.session = null;
  }
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// Random-hyperplane LSH over normalised vectors: candidate pairs share a
// bucket in at least one of `tables` tables of `bits` signs each. Seeded, so
// a run is reproducible.
// Long grouping work is written as a generator that yields at checkpoints.
// runSync() drives it to the end in one go (tests, small inputs); runAsync()
// hands the event loop back at every checkpoint, so a large library never
// stalls the server's other requests.
function runSync(gen) {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}
async function runAsync(gen, { sliceMs = 20 } = {}) {
  let t = Date.now();
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (Date.now() - t >= sliceMs) {
      await new Promise((resolve) => setImmediate(resolve));
      t = Date.now();
    }
  }
}

function lshPairs(vecs, opts) {
  return runSync(lshPairsGen(vecs, opts));
}

function* lshPairsGen(vecs, { tables = 14, bits = 12, maxBucket = 300, seed = 1 } = {}) {
  if (!vecs.length) return new Set();
  const dim = vecs[0].length;
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  const pairs = new Set();
  for (let tb = 0; tb < tables; tb++) {
    const planes = Array.from({ length: bits }, () => Float32Array.from({ length: dim }, rnd));
    const buckets = new Map();
    for (let idx = 0; idx < vecs.length; idx++) {
      const v = vecs[idx];
      let key = 0;
      for (let b = 0; b < bits; b++) if (dot(v, planes[b]) > 0) key |= 1 << b;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(idx);
      if (idx % 256 === 255) yield;
    }
    for (const arr of buckets.values()) {
      if (arr.length < 2 || arr.length > maxBucket) continue;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) pairs.add(`${arr[i]}|${arr[j]}`);
        yield;
      }
    }
  }
  return pairs;
}

module.exports = { MODELS, MODES, DEFAULT_SENSITIVITY, PREP_VERSION, versionOf, thresholdFor, ModelManager, Embedder, toTensorData, normalise, dot, lshPairs, lshPairsGen, runSync, runAsync, runtime };
