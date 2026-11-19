'use strict';
// The AI model manager: only pinned, verified model files are fetched and
// loaded. No test here touches the network; fetch is always a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('../dupe-ai');

const { MODELS, ModelManager, Embedder } = ai;

function setup(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-ai-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  // As server.js wires it: <DATA_DIR>/models.
  return { data, dir: path.join(data, 'models') };
}

// A fetch stub that streams `total` bytes of `fill` in 1 MB chunks, and
// records every call. It never touches the network.
function streamFetch({ total, fill = 0, status = 200, chunk = 1 << 20 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    async function* body() {
      let left = total;
      const buf = Buffer.alloc(chunk, fill);
      while (left > 0) {
        const n = Math.min(chunk, left);
        left -= n;
        yield n === chunk ? buf : buf.subarray(0, n);
      }
    }
    return { ok: status >= 200 && status < 300, status, body: status === 200 ? body() : null };
  };
  fn.calls = calls;
  return fn;
}
const noFetch = () => {
  const fn = async () => { throw new Error('the network must not be touched'); };
  return fn;
};

// A sparse file of the given size (no real disk use).
function sparse(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
}

test('only the light model has a pinned sha256 in this build', () => {
  assert.match(MODELS.light.sha256, /^[0-9a-f]{64}$/);
  assert.equal(MODELS.medium.sha256, null);
  assert.equal(MODELS.heavy.sha256, null);
});

test('a model without a pinned sha256 refuses to download and never fetches', async (t) => {
  const { dir } = setup(t);
  for (const id of ['medium', 'heavy']) {
    const fetchImpl = streamFetch({ total: 10 });
    const m = new ModelManager({ dir, fetchImpl, log: () => {} });
    await assert.rejects(m.download(id), /no pinned checksum/);
    assert.equal(fetchImpl.calls.length, 0, id);
    assert.equal(m.downloading, null, 'a refusal leaves no download marked as running');
    assert.ok(!fs.existsSync(`${m.fileOf(id)}.part`));
  }
  assert.ok(!fs.existsSync(dir), 'a refused download does not even create the models folder');
});

test('an unknown model id is refused', async (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir, fetchImpl: noFetch(), log: () => {} });
  await assert.rejects(m.download('huge'), /Unknown model/);
  // Object.prototype names are refused too (the route only lets
  // light|medium|heavy through), and never reach fetch.
  await assert.rejects(m.download('constructor'));
  await assert.rejects(m.download('toString'));
  assert.ok(!fs.existsSync(dir));
});

test('model files live directly under DATA_DIR/models', (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir });
  for (const id of Object.keys(MODELS)) {
    const f = m.fileOf(id);
    assert.equal(path.dirname(f), dir);
    assert.equal(path.basename(f), MODELS[id].file);
    assert.doesNotMatch(MODELS[id].file, /[/\\]|\.\./);
  }
});

test('status lists every model, not installed in an empty folder', (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir });
  const st = m.status();
  assert.deepEqual(st.map((s) => s.id), ['light', 'medium', 'heavy']);
  for (const s of st) {
    assert.equal(s.installed, false);
    assert.equal(s.downloading, null);
  }
});

test('an installed model is not fetched again', async (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir, fetchImpl: noFetch(), log: () => {} });
  sparse(m.fileOf('light'), MODELS.light.bytes);
  // Installed means the pinned bytes, so pin the bytes this file has.
  const pinned = MODELS.light.sha256;
  t.after(() => { MODELS.light.sha256 = pinned; });
  MODELS.light.sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(m.fileOf('light'))).digest('hex');
  assert.equal(m.installed('light'), true);
  assert.deepEqual(await m.download('light'), { already: true });
});

test('a pinned model whose bytes do not match the checksum is not installed', async (t) => {
  const { dir } = setup(t);
  const fetchImpl = streamFetch({ total: MODELS.light.bytes, fill: 0 });
  const logs = [];
  const m = new ModelManager({ dir, fetchImpl, log: (l) => logs.push(l) });
  await assert.rejects(m.download('light'), /does not match its checksum/);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.endsWith(`/${MODELS.light.file}`));
  assert.ok(fetchImpl.calls[0].url.startsWith('https://'));
  assert.ok(!fs.existsSync(m.fileOf('light')), 'the wrong file is never renamed into place');
  assert.ok(!fs.existsSync(`${m.fileOf('light')}.part`), 'the partial file is removed');
  assert.equal(m.installed('light'), false);
  assert.equal(m.downloading, null);
  assert.equal(m.progress, null);
  assert.equal(logs.length, 0);
});

test('a short download is refused and cleaned up', async (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir, fetchImpl: streamFetch({ total: 1000 }), log: () => {} });
  await assert.rejects(m.download('light'), /came out short/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a download larger than expected is cut off and cleaned up', async (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir, fetchImpl: streamFetch({ total: MODELS.light.bytes + 1 }), log: () => {} });
  await assert.rejects(m.download('light'), /larger than expected/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(m.downloading, null);
});

test('an HTTP error is refused and cleaned up', async (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir, fetchImpl: streamFetch({ total: 0, status: 404 }), log: () => {} });
  await assert.rejects(m.download('light'), /HTTP 404/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(m.downloading, null);
});

test('only one download runs at a time', async (t) => {
  const { dir } = setup(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async () => {
    await gate;
    return { ok: false, status: 503, body: null };
  };
  const m = new ModelManager({ dir, fetchImpl, log: () => {} });
  const first = m.download('light');
  assert.equal(m.downloading, 'light');
  assert.equal(m.status().find((s) => s.id === 'light').downloading.total, MODELS.light.bytes);
  await assert.rejects(m.download('light'), /already running/);
  release();
  await assert.rejects(first, /HTTP 503/);
  assert.equal(m.downloading, null);
});

test('a file with the right size but the wrong bytes does not count as installed', (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir });
  sparse(m.fileOf('light'), MODELS.light.bytes); // all zero bytes, not the pinned hash
  assert.equal(m.installed('light'), false);
});

test('a file of the wrong size is not installed', (t) => {
  const { dir } = setup(t);
  const m = new ModelManager({ dir });
  sparse(m.fileOf('light'), MODELS.light.bytes - 1);
  assert.equal(m.installed('light'), false);
});

test('the Embedder refuses cleanly when ONNX Runtime is missing (optional dependency)', async (t) => {
  if (ai.runtime()) {
    t.skip('onnxruntime-node is installed here');
    return;
  }
  const { dir } = setup(t);
  const e = new Embedder({ modelId: 'light', file: path.join(dir, MODELS.light.file) });
  await assert.rejects(e.load(), /ONNX Runtime is not installed/);
  assert.equal(e.session, null);
});

test('thresholdFor clamps sensitivity and falls back to the light model', () => {
  assert.equal(ai.thresholdFor('light'), MODELS.light.thrDefault);
  assert.equal(ai.thresholdFor('light', -50), ai.thresholdFor('light', 0));
  assert.equal(ai.thresholdFor('light', 500), ai.thresholdFor('light', 100));
  assert.ok(ai.thresholdFor('light', 0) > ai.thresholdFor('light', 100));
  assert.equal(ai.thresholdFor('nope'), ai.thresholdFor('light'));
});

test('normalise returns a unit vector and survives a zero vector', () => {
  const v = ai.normalise(Float32Array.from([3, 4]));
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
  assert.deepEqual([...ai.normalise(new Float32Array(3))], [0, 0, 0]);
});

test('lshPairs is deterministic and pairs identical vectors', () => {
  const a = ai.normalise(Float32Array.from({ length: 16 }, (_, i) => i + 1));
  const b = ai.normalise(Float32Array.from({ length: 16 }, (_, i) => (i % 2 ? -1 : 1) * (16 - i)));
  const vecs = [a, b, a];
  const p1 = ai.lshPairs(vecs);
  assert.ok(p1.has('0|2'));
  assert.deepEqual([...p1].sort(), [...ai.lshPairs(vecs)].sort());
  assert.equal(ai.lshPairs([]).size, 0);
});
