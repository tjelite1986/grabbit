'use strict';
// The background analysis loop behind Similar Photos and Similar Videos:
// which content it reads, the DUPES_* feature flags, skip marks and their
// reset when settings change, and that a bad file never stops the loop.
//
// Most tests inject a fake media reader (no ffmpeg, deterministic frames).
// The AI path never loads a real model: the ModelManager points at an empty
// folder or is a stub, and the Embedder is replaced where it would be built.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const itemStore = require('../item-store');
const dupeStore = require('../dupe-store');
const ai = require('../dupe-ai');
const { Analyzer, flags, safePath, CFG_KEY, STATE_KEY } = require('../dupe-analyzer');
const { DupeService } = require('../dupe-service');

const has = (bin) => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; }
};
const NO_FF = has('ffmpeg') && has('ffprobe') ? false : 'ffmpeg/ffprobe not installed';
const FLAGS = ['DUPES_PHOTO', 'DUPES_AI', 'DUPES_VIDEO'];

// Sets feature flags for one test and restores them after.
function withEnv(t, env) {
  const before = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of FLAGS) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  });
}

// Replaces one export of dupe-ai for one test.
function stubAi(t, name, value) {
  const orig = ai[name];
  ai[name] = value;
  t.after(() => { ai[name] = orig; });
}

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

// Fake media reader. A file's body "<kind>:<picture>:<copy>" decides what it
// shows: bodies with the same <picture> show the same frames although their
// bytes (and sha256) differ, like a re-encode. A body starting with "corrupt"
// fails like ffprobe does on a broken file.
function fakeMedia() {
  const calls = [];
  const seedOf = (file) => {
    const body = fs.readFileSync(file, 'utf8');
    if (body.startsWith('corrupt')) throw new Error('ffprobe failed: Invalid data found when processing input');
    return [...body.split(':')[1]].reduce((s, c) => s * 31 + c.charCodeAt(0), 7);
  };
  return {
    calls,
    count: (fn) => calls.filter((c) => c.fn === fn).length,
    async probe(file) {
      calls.push({ fn: 'probe', file: path.basename(file) });
      seedOf(file);
      if (/\.mp4$/.test(file)) return { width: 320, height: 240, duration: 8, fps: 10, vcodec: 'h264', acodec: null, bitrate: 400000, container: 'mov' };
      return { width: 64, height: 64, duration: null, fps: null, vcodec: 'mjpeg', acodec: null, bitrate: null, container: 'image2' };
    },
    async readImage(file, { rgb = false } = {}) {
      calls.push({ fn: 'readImage', file: path.basename(file), rgb });
      return { gray: pattern(seedOf(file)), rgb: rgb ? Buffer.alloc(224 * 224 * 3, 7) : null };
    },
    async readVideoFrames(file) {
      calls.push({ fn: 'readVideoFrames', file: path.basename(file) });
      const seed = seedOf(file);
      return Array.from({ length: 16 }, (_, i) => ({ t: i * 0.5, gray: pattern(seed + i) }));
    },
    async readFramesAt(file, duration, fractions) {
      calls.push({ fn: 'readFramesAt', file: path.basename(file) });
      const seed = seedOf(file);
      return fractions.map((f, i) => ({ t: duration * f, gray: pattern(seed + 100 + i) }));
    },
  };
}

const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');

function setup(t, { media = fakeMedia(), models = null, cfg = { pauseMs: 0 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-analyzer-'));
  const s = itemStore.open(path.join(dir, 'items.db'));
  let an = null;
  // One hook, in order: stop a loop a failing assertion left running, close
  // the database, remove the temp dir.
  t.after(async () => {
    if (an) {
      an.stop();
      if (an.loop) await an.loop;
    }
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dx = dupeStore.attach(s.raw, path.join(dir, 'dupes.db'));
  const root = path.join(dir, 'media');
  fs.mkdirSync(root);
  const rootOf = (p) => (p === root ? { path: root, label: 'media', owner: 'grabbit' } : null);
  // A file the exact scan has seen and hashed.
  const add = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const { row } = s.fileSeen(root, rel, fs.statSync(file));
    s.fileHashed(row.id, { sha256: sha(body) });
    return sha(body);
  };
  if (cfg) s.setSetting(CFG_KEY, JSON.stringify(cfg));
  an = new Analyzer({ store: s, dx, rootOf, models, media, log: () => {} });
  return { dir, s, dx, root, rootOf, add, an, media };
}

// Runs the feature queue to the end, one file at a time, like the loop does.
async function drain(an) {
  let n = 0;
  for (let task = an.nextFeatureWork(); task; task = an.nextFeatureWork()) {
    await an.analyse(task);
    n++;
  }
  return n;
}

async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('flags: each engine is on unless its env var says off; AI follows the photo flag', (t) => {
  withEnv(t, {});
  assert.deepEqual(flags(), { photo: true, ai: true, video: true });
  process.env.DUPES_VIDEO = 'OFF';
  assert.deepEqual(flags(), { photo: true, ai: true, video: false });
  process.env.DUPES_VIDEO = 'no';
  assert.equal(flags().video, true, 'only "off" switches an engine off');
  process.env.DUPES_AI = 'off';
  assert.deepEqual(flags(), { photo: true, ai: false, video: true });
  delete process.env.DUPES_AI;
  process.env.DUPES_PHOTO = 'off';
  assert.deepEqual(flags(), { photo: false, ai: false, video: true });
});

test('content is analysed once per sha256 and look-alike pictures and videos group', async (t) => {
  withEnv(t, {});
  const { add, an, dx, media } = setup(t);
  const a1 = add('photos/a.jpg', 'img:A:1');
  add('photos/a-copy.jpg', 'img:A:1'); // same bytes: same content, read once
  const a2 = add('photos/a-resized.jpg', 'img:A:2');
  const b = add('photos/b.png', 'img:B:1');
  const v1 = add('videos/v.mp4', 'vid:V:1');
  const v2 = add('videos/v-reencoded.mp4', 'vid:V:2');
  const w = add('videos/w.mp4', 'vid:W:1');
  assert.equal(await drain(an), 6);
  assert.equal(media.count('probe'), 6);
  assert.equal(media.count('readImage'), 3);
  assert.equal(media.count('readVideoFrames'), 3);
  for (const s of [a1, a2, b]) {
    const f = dx.feature(s);
    assert.equal(f.kind, 'image');
    assert.equal(f.error, null);
    assert.match(f.phash, /^[0-9a-f]{16}$/);
    assert.equal(f.phash_rot.split(',').length, 3);
  }
  for (const s of [v1, v2, w]) {
    const f = dx.feature(s);
    assert.equal(f.kind, 'video');
    assert.equal(f.error, null);
    assert.equal(f.duration, 8);
    assert.ok(f.frames.length >= 3 * 12);
  }
  assert.equal(an.regroup('photo').groups, 1);
  assert.equal(an.regroup('video').groups, 1);
  const pg = dx.simGroups('photo');
  assert.deepEqual(pg[0].members.map((m) => m.sha256).sort(), [a1, a2].sort());
  const vg = dx.simGroups('video');
  assert.deepEqual(vg[0].members.map((m) => m.sha256).sort(), [v1, v2].sort());
  assert.equal(vg[0].match, 'reencoded');
  assert.equal(an.nextFeatureWork(), null, 'nothing left to do');
});

test('DUPES_VIDEO=off: videos get a skip mark and are never decoded; pictures carry on', async (t) => {
  withEnv(t, { DUPES_VIDEO: 'off' });
  const { add, an, dx, media } = setup(t);
  const img = add('a.jpg', 'img:A:1');
  const vid = add('v.mp4', 'vid:V:1');
  assert.equal(await drain(an), 1);
  assert.equal(media.count('readVideoFrames'), 0);
  assert.equal(media.calls.some((c) => c.file === 'v.mp4'), false);
  assert.equal(dx.feature(vid).error, 'skip: video not analysed');
  assert.equal(dx.feature(img).error, null);
  assert.deepEqual(an.enabled(), { photo: true, ai: false, video: false });
  assert.equal(an.status().videos.errors, 0, 'a skip mark is not an error');
});

test('DUPES_PHOTO=off: pictures get a skip mark, videos carry on, AI is off too', async (t) => {
  withEnv(t, { DUPES_PHOTO: 'off' });
  const { add, an, dx, media } = setup(t, { cfg: { pauseMs: 0, ai: true } });
  const img = add('a.jpg', 'img:A:1');
  const vid = add('v.mp4', 'vid:V:1');
  assert.equal(await drain(an), 1);
  assert.equal(media.count('readImage'), 0);
  assert.equal(dx.feature(img).error, 'skip: image not analysed');
  assert.equal(dx.feature(vid).error, null);
  assert.equal(an.enabled().ai, false);
  assert.equal(await an.aiReady(), null);
});

test('a settings change clears skip marks so the queue is rebuilt', async (t) => {
  withEnv(t, {});
  const { add, an, dx, s, rootOf, media } = setup(t);
  const svc = new DupeService({ store: s, dx, roots: [], rootOf, analyzer: an, log: () => {} });
  svc.setCfg({ video: false });
  const vid = add('v.mp4', 'vid:V:1');
  const img = add('a.jpg', 'img:A:1');
  assert.equal(await drain(an), 1);
  assert.equal(dx.feature(vid).error, 'skip: video not analysed');
  assert.equal(media.count('readVideoFrames'), 0);

  svc.setCfg({ video: true });
  assert.equal(dx.feature(vid), undefined, 'the skip mark is gone');
  assert.equal(dx.feature(img).error, null, 'real features are kept');
  assert.equal(await drain(an), 1);
  assert.equal(dx.feature(vid).error, null);
  assert.equal(media.count('readVideoFrames'), 1);
});

test('a change that does not touch an engine keeps skip marks', async (t) => {
  withEnv(t, {});
  const { add, an, dx, s, rootOf } = setup(t);
  const svc = new DupeService({ store: s, dx, roots: [], rootOf, analyzer: an, log: () => {} });
  svc.setCfg({ video: false });
  const vid = add('v.mp4', 'vid:V:1');
  await drain(an);
  svc.setCfg({ trashRetentionDays: 7 });
  assert.equal(dx.feature(vid).error, 'skip: video not analysed');
});

test('audio and generated files are marked skipped, not analysed', async (t) => {
  withEnv(t, {});
  const { add, an, dx, media } = setup(t);
  const song = add('music/song.mp3', 'aud:S:1');
  const thumb = add('thumbs/a.jpg', 'img:T:1');
  const doc = add('notes/readme.txt', 'txt:R:1');
  assert.equal(await drain(an), 0);
  assert.equal(media.calls.length, 0);
  assert.equal(dx.feature(song).error, 'skip: audio not analysed');
  assert.equal(dx.feature(thumb).error, 'skip: thumbnail');
  assert.match(dx.feature(doc).error, /^skip: /);
});

test('a content is analysed when any copy is original media, even if another copy is a thumbnail', async (t) => {
  withEnv(t, {});
  const { add, an, dx } = setup(t);
  const s1 = add('thumbs/a.jpg', 'img:A:1');
  add('photos/a.jpg', 'img:A:1');
  assert.equal(await drain(an), 1);
  assert.equal(dx.feature(s1).error, null);
});

test('a missing or corrupt file yields an error row, and the next file is still analysed', async (t) => {
  withEnv(t, {});
  const { add, an, dx, root } = setup(t);
  const gone = add('gone.jpg', 'img:G:1');
  fs.rmSync(path.join(root, 'gone.jpg'));
  const bad = add('bad.mp4', 'corrupt video');
  const badImg = add('bad.jpg', 'corrupt picture');
  const good = add('good.jpg', 'img:A:1');
  assert.equal(await drain(an), 4);
  assert.equal(dx.feature(gone).error, 'file not readable');
  assert.match(dx.feature(bad).error, /ffprobe failed: Invalid data/);
  assert.equal(dx.feature(bad).kind, 'video');
  assert.match(dx.feature(badImg).error, /ffprobe failed/);
  assert.equal(dx.feature(good).error, null);
  const st = an.status();
  assert.equal(st.photos.errors, 2);
  assert.equal(st.videos.errors, 1);
  assert.equal(st.photos.analysed, 1);
});

test('a video with too few distinct frames is recorded with an error', async (t) => {
  withEnv(t, {});
  const media = fakeMedia();
  media.readVideoFrames = async () => [0, 1, 2, 3].map((t) => ({ t, gray: Buffer.alloc(4096, 0) }));
  const { add, an, dx } = setup(t, { media });
  const v = add('black.mp4', 'vid:K:1');
  await drain(an);
  assert.equal(dx.feature(v).error, 'too few distinct frames');
});

test('the background loop analyses everything, survives bad files and stops on request', async (t) => {
  withEnv(t, {});
  // AI is switched on in settings but no model is installed: the loop must
  // carry on with pHash only. The model manager may not touch the network.
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-models-'));
  t.after(() => fs.rmSync(modelDir, { recursive: true, force: true }));
  const models = new ai.ModelManager({ dir: modelDir, log: () => {}, fetchImpl: () => { throw new Error('no network in tests'); } });
  const { add, an, dx, s, media, root } = setup(t, { models, cfg: { pauseMs: 0, ai: true } });
  const shas = [add('a.jpg', 'img:A:1'), add('a2.jpg', 'img:A:2'), add('bad.jpg', 'corrupt'), add('v.mp4', 'vid:V:1'), add('gone.mp4', 'vid:G:1')];
  fs.rmSync(path.join(root, 'gone.mp4'));

  an.start();
  assert.equal(s.setting(STATE_KEY), 'running');
  await until(() => shas.every((x) => dx.feature(x)) && an.phase === 'waiting');
  assert.equal(an.lastError, null);
  assert.equal(an.status().active, true, 'the loop is still alive');
  assert.ok(media.calls.filter((c) => c.fn === 'readImage').every((c) => c.rgb === false), 'no RGB crop without a model');
  assert.deepEqual(dx.embeddingCounts(), []);
  assert.equal(fs.readdirSync(modelDir).length, 0, 'nothing was downloaded');
  assert.equal(dx.simGroups('photo').length, 1, 'regrouped when the queue ran dry');
  const hist = dx.history();
  assert.equal(hist[0].engine, 'analysis');
  assert.equal(hist[0].outcome, 'up to date');

  an.stop();
  await an.loop;
  assert.equal(an.status().active, false);
  assert.equal(an.lastError, null);
});

test('boot resumes a loop that was running and leaves a stopped one alone', async (t) => {
  withEnv(t, {});
  const { an, s } = setup(t);
  an.boot();
  assert.equal(an.loop, null);
  s.setSetting(STATE_KEY, 'running');
  an.boot();
  assert.ok(an.loop);
  an.pause();
  await an.loop;
  assert.equal(an.state, 'paused');
});

test('DUPES_AI=off: no embedder even with AI on in settings and a model installed', async (t) => {
  withEnv(t, { DUPES_AI: 'off' });
  let built = 0;
  stubAi(t, 'Embedder', class { constructor() { built++; } });
  stubAi(t, 'runtime', () => ({}));
  const models = { installed: () => true, fileOf: () => '/nonexistent/model.onnx' };
  const { add, an, dx, media } = setup(t, { models, cfg: { pauseMs: 0, ai: true } });
  const a = add('a.jpg', 'img:A:1');
  assert.equal(await an.aiReady(), null);
  await drain(an);
  assert.equal(built, 0);
  assert.equal(media.calls.find((c) => c.fn === 'readImage').rgb, false);
  assert.equal(dx.feature(a).error, null);
  assert.equal(an.status().enabled.ai, false);
});

test('AI on with the model absent or no ONNX runtime: no embedder, pictures still analysed', async (t) => {
  withEnv(t, {});
  let built = 0;
  stubAi(t, 'Embedder', class { constructor() { built++; } });
  const models = { installed: () => false, fileOf: () => '/nonexistent/model.onnx' };
  const { add, an, dx, media } = setup(t, { models, cfg: { pauseMs: 0, ai: true } });
  const a = add('a.jpg', 'img:A:1');
  assert.equal(await an.aiReady(), null);
  models.installed = () => true;
  stubAi(t, 'runtime', () => null);
  assert.equal(await an.aiReady(), null);
  await drain(an);
  assert.equal(built, 0);
  assert.equal(media.calls.find((c) => c.fn === 'readImage').rgb, false);
  assert.equal(dx.feature(a).error, null);
});

test('AI on with a working embedder: the vector is stored beside the pHash (stub, no model)', async (t) => {
  withEnv(t, {});
  stubAi(t, 'runtime', () => ({}));
  stubAi(t, 'Embedder', class {
    constructor(o) { Object.assign(this, o); }
    async embed(rgb) { assert.equal(rgb.length, 224 * 224 * 3); return [ai.normalise(Float32Array.from([1, 2, 3, 4]))]; }
    async close() {}
  });
  const models = { installed: () => true, fileOf: () => '/nonexistent/model.onnx' };
  const { add, an, dx, media } = setup(t, { models, cfg: { pauseMs: 0, ai: true } });
  const a = add('a.jpg', 'img:A:1');
  await drain(an);
  assert.equal(media.calls.find((c) => c.fn === 'readImage').rgb, true);
  assert.equal(dx.feature(a).error, null);
  assert.equal(dx.embeddings('light', ai.versionOf('light')).length, 1);
});

test('AI on but the embedder fails: the picture keeps its pHash features', {
}, async (t) => {
  withEnv(t, {});
  stubAi(t, 'runtime', () => ({}));
  stubAi(t, 'Embedder', class {
    constructor(o) { Object.assign(this, o); }
    async embed() { throw new Error('ONNX session failed to load'); }
    async close() {}
  });
  const models = { installed: () => true, fileOf: () => '/nonexistent/model.onnx' };
  const { add, an, dx } = setup(t, { models, cfg: { pauseMs: 0, ai: true } });
  const a = add('a.jpg', 'img:A:1');
  await drain(an);
  const f = dx.feature(a);
  assert.equal(f.error, null, `feature error: ${f.error}`);
  assert.match(String(f.phash), /^[0-9a-f]{16}$/);
});

test('safePath accepts a file inside the root and refuses escapes and symlinks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-analyzer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'a.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'outside.jpg'), 'x');
  fs.symlinkSync(path.join(dir, 'outside.jpg'), path.join(root, 'link.jpg'));
  fs.symlinkSync(dir, path.join(root, 'dirlink'));
  assert.equal(safePath(root, 'sub/a.jpg'), path.join(fs.realpathSync(root), 'sub', 'a.jpg'));
  assert.equal(safePath(root, '../outside.jpg'), null);
  assert.equal(safePath(root, 'link.jpg'), null);
  assert.equal(safePath(root, 'dirlink/outside.jpg'), null);
  assert.equal(safePath(root, 'sub'), null);
  assert.equal(safePath(root, 'missing.jpg'), null);
});

test('real media: the loop groups a resized picture with its source and records a corrupt one', { skip: NO_FF }, async (t) => {
  withEnv(t, { DUPES_AI: 'off' });
  const { add, an, dx, root } = setup(t, { media: require('../dupe-media') });
  const ff = (...args) => {
    const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  const tmp = path.join(root, '..', 'src');
  fs.mkdirSync(tmp);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=480x360:rate=1', '-frames:v', '1', '-q:v', '2', path.join(tmp, 'o.jpg'));
  ff('-i', path.join(tmp, 'o.jpg'), '-vf', 'scale=240:180', '-q:v', '6', path.join(tmp, 'r.jpg'));
  ff('-f', 'lavfi', '-i', 'mandelbrot=size=480x360:rate=1', '-frames:v', '1', '-q:v', '3', path.join(tmp, 'u.jpg'));
  const o = add('original.jpg', fs.readFileSync(path.join(tmp, 'o.jpg')));
  const r = add('resized.jpg', fs.readFileSync(path.join(tmp, 'r.jpg')));
  const u = add('unrelated.jpg', fs.readFileSync(path.join(tmp, 'u.jpg')));
  const bad = add('corrupt.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x41)]));

  an.start();
  await until(() => [o, r, u, bad].every((x) => dx.feature(x)) && an.phase === 'waiting', 30000);
  an.stop();
  await an.loop;
  assert.equal(an.lastError, null);
  assert.ok(dx.feature(bad).error, 'the corrupt picture has an error');
  assert.equal(dx.feature(o).width, 480);
  const groups = dx.simGroups('photo');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.sha256).sort(), [o, r].sort());
});
