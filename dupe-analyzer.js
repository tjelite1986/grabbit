'use strict';
// The background analysis behind Similar Photos and Similar Videos.
//
// One loop, one file at a time, at low CPU and I/O priority. It reads files
// the exact scan has already hashed, so a picture or video is analysed once
// per content (sha256), however many copies exist. State (running / paused /
// stopped) is stored, so a restart resumes where the owner left it, and the
// loop never blocks downloads or the API: every step yields.
//
// Feature flags: DUPES_PHOTO=off, DUPES_AI=off, DUPES_VIDEO=off switch an
// engine off on this server whatever the settings say. The exact scan does
// not depend on any of them.

const fs = require('fs');
const path = require('path');
const media = require('./dupe-media');
const { hashFrame } = require('./dupe-phash');
const { classify } = require('./dupe-classify');
const ai = require('./dupe-ai');
const { groupPhotosAsync } = require('./dupe-photo');
const { groupVideos, packFrames, packProbes, PROBE_AT } = require('./dupe-video');

const STATE_KEY = 'dupes.analyze.state';
const CFG_KEY = 'dupes.cfg';
// Bump when what a feature row holds changes; older rows are redone.
const FVERSION = { image: 1, video: 1 };

const DEFAULT_CFG = {
  photo: true,
  ai: false,
  model: 'light',
  mode: 'balanced',
  sensitivity: ai.DEFAULT_SENSITIVITY,
  video: true,
  threads: 2,
  pauseMs: 150,
  scanMbps: null,
  trashRetentionDays: 0, // manual cleanup only (owner decision 2026-11-19)
  defaultRule: 'recommended',
  showThumbnails: false,
  prevention: {
    enabled: true,
    exact: 'review',
    perceptual: 'review',
    perApp: {},
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const off = (name) => String(process.env[name] || '').toLowerCase() === 'off';

function flags() {
  return { photo: !off('DUPES_PHOTO'), ai: !off('DUPES_AI') && !off('DUPES_PHOTO'), video: !off('DUPES_VIDEO') };
}

// Reads and validates the stored settings, filling defaults.
function readCfg(store) {
  let raw = {};
  try { raw = JSON.parse(store.setting(CFG_KEY) || '{}') || {}; } catch { raw = {}; }
  return sanitizeCfg({ ...DEFAULT_CFG, ...raw, prevention: { ...DEFAULT_CFG.prevention, ...(raw.prevention || {}) } });
}

const RETENTION = [7, 14, 30, 60, 90, 0]; // 0 = manual cleanup only
const PREVENT_ACTIONS = ['skip', 'link', 'keep', 'review'];

function sanitizeCfg(c) {
  const out = { ...DEFAULT_CFG };
  out.photo = c.photo !== false;
  out.ai = c.ai === true;
  out.model = ai.MODELS[c.model] ? c.model : 'light';
  out.mode = ['strict', 'balanced', 'relaxed', 'custom'].includes(c.mode) ? c.mode : 'balanced';
  out.sensitivity = Math.max(0, Math.min(100, Math.round(Number(c.sensitivity)))) || 0;
  if (out.mode !== 'custom') out.sensitivity = ai.MODES[out.mode];
  out.video = c.video !== false;
  out.threads = Math.max(1, Math.min(4, Math.round(Number(c.threads) || 2)));
  out.pauseMs = Math.max(0, Math.min(5000, Math.round(Number(c.pauseMs)) || 0));
  out.scanMbps = c.scanMbps == null || c.scanMbps === '' ? null : Math.max(1, Math.min(500, Math.round(Number(c.scanMbps)) || 20));
  out.trashRetentionDays = RETENTION.includes(Number(c.trashRetentionDays)) ? Number(c.trashRetentionDays) : 0;
  out.defaultRule = require('./dupe-quality').RULES.includes(c.defaultRule) ? c.defaultRule : 'recommended';
  out.showThumbnails = c.showThumbnails === true;
  const p = c.prevention || {};
  const perApp = {};
  for (const [k, v] of Object.entries(p.perApp || {})) {
    if (!/^[A-Za-z0-9 _.+-]{1,40}$/.test(k) || !v || typeof v !== 'object') continue;
    perApp[k] = {
      exact: PREVENT_ACTIONS.includes(v.exact) ? v.exact : 'review',
      perceptual: v.perceptual === 'keep' ? 'keep' : 'review',
    };
  }
  out.prevention = {
    enabled: p.enabled !== false,
    exact: PREVENT_ACTIONS.includes(p.exact) ? p.exact : 'review',
    // AI and perceptual matches always go to manual review (or are ignored).
    perceptual: p.perceptual === 'keep' ? 'keep' : 'review',
    perApp,
  };
  return out;
}

// The real path of a scanned file inside its root, or null (gone, symlinked,
// outside the root).
function safePath(root, rel) {
  try {
    const r = path.resolve(root);
    const abs = path.resolve(r, rel);
    if (!abs.startsWith(r + path.sep)) return null;
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    const real = fs.realpathSync(abs);
    if (real !== path.join(fs.realpathSync(r), path.relative(r, abs))) return null;
    return real;
  } catch {
    return null;
  }
}

class Analyzer {
  // opts: store (item store), dx (dupe store), rootOf(path) -> root candidate,
  // models (ModelManager), log, now
  constructor(opts) {
    this.store = opts.store;
    this.dx = opts.dx;
    this.rootOf = opts.rootOf;
    this.models = opts.models;
    this.log = opts.log || ((m) => console.log(`dupes: ${m}`));
    this.now = opts.now || Date.now;
    this.media = opts.media || media;
    this.loop = null;
    this.phase = null;
    this.current = null;
    this.lastError = null;
    this.done = { image: 0, video: 0, embed: 0 };
    this.rate = [];
    this.dirty = { photo: false, video: false };
    this.lastGroupAt = { photo: 0, video: 0 };
    this.lastGroupStats = { photo: null, video: null };
    this.embedder = null;
    this.historyId = null;
  }

  get state() { return this.store.setting(STATE_KEY) || 'stopped'; }
  cfg() { return readCfg(this.store); }
  running() { return this.state === 'running'; }

  boot() { if (this.state === 'running') this.start(); }

  start() {
    this.store.setSetting(STATE_KEY, 'running');
    if (!this.loop) {
      this.loop = this.run()
        .catch((e) => { this.lastError = e.message; this.log(`analysis stopped on an error: ${e.message}`); })
        .finally(() => { this.loop = null; this.phase = null; this.current = null; });
    }
    return this.status();
  }

  pause() { this.store.setSetting(STATE_KEY, 'paused'); return this.status(); }
  stop() { this.store.setSetting(STATE_KEY, 'stopped'); return this.status(); }

  enabled() {
    const f = flags();
    const c = this.cfg();
    return { photo: f.photo && c.photo, ai: f.ai && c.photo && c.ai, video: f.video && c.video };
  }

  async aiReady() {
    const en = this.enabled();
    if (!en.ai || !this.models || !this.models.installed(this.cfg().model) || !ai.runtime()) return null;
    const c = this.cfg();
    if (!this.embedder || this.embedder.modelId !== c.model || this.embedder.threads !== c.threads) {
      if (this.embedder) await this.embedder.close().catch(() => {});
      this.embedder = new ai.Embedder({ modelId: c.model, file: this.models.fileOf(c.model), threads: c.threads });
    }
    return this.embedder;
  }

  // What kind a content is for the engines, looking at every present copy:
  // analysed when at least one copy is original media of an enabled kind.
  accept(row) {
    const en = this.enabled();
    const members = this.store.dupeMembers(row.sha256);
    const rows = members.length ? members : [row];
    let kind = null;
    for (const m of rows) {
      const c = classify(this.rootOf(m.root) || {}, m.rel);
      if (c.cls !== 'media') continue;
      if (c.kind === 'image' && en.photo) kind = 'image';
      if (c.kind === 'video' && en.video) kind = 'video';
      if (kind) return { kind, row: m };
    }
    return null;
  }

  async run() {
    this.historyId = this.dx.historyStart('analysis', this.now());
    let processed = 0;
    while (this.running()) {
      const en = this.enabled();
      // 1. Features for new content.
      const todo = this.nextFeatureWork();
      if (todo) {
        await this.analyse(todo);
        processed++;
        await this.breathe();
        continue;
      }
      // 2. Embeddings for pictures that have features but no current vector.
      const emb = en.ai ? await this.aiReady() : null;
      if (emb) {
        const c = this.cfg();
        const shas = this.dx.embeddingTodo(c.model, ai.versionOf(c.model), 5);
        if (shas.length) {
          for (const sha of shas) {
            if (!this.running()) break;
            await this.embedOne(sha, emb, c);
            processed++;
            await this.breathe();
          }
          continue;
        }
      }
      // 3. Regroup what changed, then wait for more work.
      await this.regroupIfDirty(true);
      if (this.historyId) {
        // A pass that found nothing to do is not history.
        if (processed) this.dx.historyEnd(this.historyId, { files: processed, outcome: 'up to date' }, this.now());
        else this.dx.historyDrop(this.historyId);
        this.historyId = null;
        processed = 0;
      }
      this.phase = 'waiting';
      this.current = null;
      for (let i = 0; i < 60 && this.running(); i++) await sleep(1000);
      if (this.running() && this.nextFeatureWork(true)) this.historyId = this.dx.historyStart('analysis', this.now());
    }
    await this.regroupIfDirty(true).catch(() => {});
    if (this.historyId) {
      this.dx.historyEnd(this.historyId, { files: processed, outcome: this.state }, this.now());
      this.historyId = null;
    }
  }

  async breathe() {
    const c = this.cfg();
    if (c.pauseMs) await sleep(c.pauseMs);
    else await new Promise((r) => setImmediate(r));
    await this.regroupIfDirty(false);
  }

  // The next content to analyse. Pulled from the database 50 at a time;
  // content no engine reads (audio, thumbnails, an engine that is off) gets a
  // skip mark so the query moves past it. clearSkips() undoes the marks when
  // the settings change.
  nextFeatureWork(peek = false) {
    const fver = Math.min(FVERSION.image, FVERSION.video);
    if (!this.queue || !this.queue.length) {
      this.queue = [];
      for (let round = 0; round < 10 && !this.queue.length; round++) {
        const { rows } = this.dx.featureTodo({ fversion: fver, limit: 50, accept: () => true });
        if (!rows.length) return null;
        for (const r of rows) {
          const a = this.accept(r);
          if (a) this.queue.push({ sha256: r.sha256, kind: a.kind, root: a.row.root, rel: a.row.rel });
          else {
            const c = classify(this.rootOf(r.root) || {}, r.rel);
            this.dx.skipFeature(r.sha256, c.kind === 'video' ? 'video' : 'image', fver, c.cls !== 'media' ? c.what : `${c.kind} not analysed`, this.now());
          }
        }
      }
    }
    if (!this.queue.length) return null;
    return peek ? this.queue[0] : this.queue.shift();
  }

  // Settings changed: forget skip marks and queued work so the queue is
  // rebuilt under the new settings.
  resetQueue() {
    this.queue = [];
    this.dx.clearSkips();
  }

  async analyse(t) {
    this.phase = t.kind === 'image' ? 'photos' : 'videos';
    this.current = { root: t.root, rel: t.rel };
    const file = safePath(t.root, t.rel);
    if (!file) {
      this.dx.putFeature({ sha256: t.sha256, kind: t.kind, fversion: FVERSION[t.kind], error: 'file not readable' }, this.now());
      return;
    }
    const t0 = this.now();
    try {
      const meta = await this.media.probe(file);
      if (t.kind === 'image') {
        const emb = await this.aiReady();
        const img = await this.media.readImage(file, { rgb: Boolean(emb) });
        const h = hashFrame(img.gray, { rotations: true });
        this.dx.putFeature({
          sha256: t.sha256, kind: 'image', fversion: FVERSION.image, width: meta.width, height: meta.height,
          vcodec: meta.vcodec, container: meta.container, phash: h.phash, phash_rot: h.phashRot.join(','), dhash: h.dhash, sharpness: h.sharpness,
        }, this.now());
        if (emb && img.rgb) {
          const c = this.cfg();
          // An embedding failure is the AI engine's own: the pHash row above
          // stays, so the picture keeps its perceptual matching.
          try {
            const [v] = await emb.embed(img.rgb);
            this.dx.putEmbedding(t.sha256, c.model, ai.versionOf(c.model), v, null, this.now());
            this.done.embed++;
          } catch (e) {
            this.dx.putEmbedding(t.sha256, c.model, ai.versionOf(c.model), null, String(e.message || e).slice(0, 200), this.now());
          }
        }
        this.done.image++;
        this.dirty.photo = true;
      } else {
        const frames = await this.media.readVideoFrames(file);
        const packed = packFrames(frames);
        const probes = meta.duration ? packProbes(await this.media.readFramesAt(file, meta.duration, PROBE_AT)) : null;
        this.dx.putFeature({
          sha256: t.sha256, kind: 'video', fversion: FVERSION.video, width: meta.width, height: meta.height, duration: meta.duration,
          fps: meta.fps, vcodec: meta.vcodec, acodec: meta.acodec, bitrate: meta.bitrate, container: meta.container,
          sharpness: packed.sharpness, frames: packed.buf, probes, error: packed.count < 3 ? 'too few distinct frames' : null,
        }, this.now());
        this.done.video++;
        this.dirty.video = true;
      }
      this.rate.push({ at: this.now(), kind: t.kind, ms: this.now() - t0 });
      if (this.rate.length > 50) this.rate.shift();
    } catch (e) {
      this.dx.putFeature({ sha256: t.sha256, kind: t.kind, fversion: FVERSION[t.kind], error: String(e.message || e).slice(0, 200) }, this.now());
    }
  }

  async embedOne(sha, emb, c) {
    this.phase = 'ai';
    const members = this.store.dupeMembers(sha);
    let file = null;
    for (const m of members) {
      if (classify(this.rootOf(m.root) || {}, m.rel).cls !== 'media') continue;
      file = safePath(m.root, m.rel);
      if (file) { this.current = { root: m.root, rel: m.rel }; break; }
    }
    if (!file) return this.dx.putEmbedding(sha, c.model, ai.versionOf(c.model), null, 'file not readable', this.now());
    try {
      const t0 = this.now();
      const img = await this.media.readImage(file, { rgb: true });
      const [v] = await emb.embed(img.rgb);
      this.dx.putEmbedding(sha, c.model, ai.versionOf(c.model), v, null, this.now());
      this.done.embed++;
      this.dirty.photo = true;
      this.rate.push({ at: this.now(), kind: 'ai', ms: this.now() - t0 });
      if (this.rate.length > 50) this.rate.shift();
    } catch (e) {
      this.dx.putEmbedding(sha, c.model, ai.versionOf(c.model), null, e.message, this.now());
    }
  }

  // Regroups an engine whose features changed: at once when `force`, else at
  // most every 10 minutes while the queue is busy.
  async regroupIfDirty(force) {
    for (const kind of ['photo', 'video']) {
      if (!this.dirty[kind]) continue;
      if (!force && this.now() - this.lastGroupAt[kind] < 10 * 60 * 1000) continue;
      await this.regroup(kind);
    }
  }

  // Photo grouping hands the event loop back while it works; the previous
  // groups stay in place until the new ones replace them. One regroup per
  // kind at a time: a second call waits for the running one.
  regroup(kind) {
    this.grouping = this.grouping || {};
    if (this.grouping[kind]) return this.grouping[kind];
    const run = this.regroupNow(kind)
      .catch((e) => { this.dirty[kind] = true; throw e; })
      .finally(() => { this.grouping[kind] = null; });
    this.grouping[kind] = run;
    return run;
  }

  async regroupNow(kind) {
    const c = this.cfg();
    const t0 = this.now();
    this.phase = `grouping ${kind}s`;
    const decisions = this.dx.allDecisions();
    let r;
    if (kind === 'photo') {
      const feats = this.dx.featureRows('image');
      const en = this.enabled();
      const vecs = new Map();
      if (en.ai) for (const e of this.dx.embeddings(c.model, ai.versionOf(c.model))) vecs.set(e.sha256, e.vec);
      // Cleared before the work: a change while it runs marks it dirty again.
      this.dirty[kind] = false;
      r = await groupPhotosAsync(feats, vecs, { mode: c.mode === 'custom' ? 'balanced' : c.mode, threshold: ai.thresholdFor(c.model, c.sensitivity), decisions });
    } else {
      r = groupVideos(this.dx.featureRows('video'), { decisions });
    }
    this.dx.replaceGroups(kind, r.groups, this.now());
    if (kind !== 'photo') this.dirty[kind] = false;
    this.lastGroupAt[kind] = this.now();
    // A capped candidate set means some similar pairs were not compared.
    if (r.capped) this.log(`${kind} grouping compared only the first ${r.candidates} candidate pairs (memory limit); some similar copies may be missing`);
    this.lastGroupStats[kind] = { groups: r.groups.length, compared: r.compared, candidates: r.candidates, capped: !!r.capped, ms: this.now() - t0, at: this.now() };
    return this.lastGroupStats[kind];
  }

  markDirty(kind) { if (kind) this.dirty[kind] = true; else { this.dirty.photo = true; this.dirty.video = true; } }

  status() {
    const counts = this.dx.featureCounts();
    const get = (k) => counts.find((c) => c.kind === k) || { n: 0, ok: 0, errors: 0 };
    const c = this.cfg();
    const recent = this.rate.filter((x) => this.now() - x.at < 10 * 60 * 1000);
    const avg = (k) => {
      const xs = recent.filter((x) => x.kind === k);
      return xs.length ? Math.round(xs.reduce((s, x) => s + x.ms, 0) / xs.length) : null;
    };
    return {
      state: this.state,
      active: Boolean(this.loop),
      phase: this.phase,
      current: this.current,
      lastError: this.lastError,
      flags: flags(),
      enabled: this.enabled(),
      model: c.model,
      aiRuntime: Boolean(ai.runtime()),
      modelInstalled: this.models ? this.models.installed(c.model) : false,
      photos: { analysed: get('image').ok, errors: get('image').errors },
      videos: { analysed: get('video').ok, errors: get('video').errors },
      embeddings: this.dx.embeddingCounts(),
      msPerImage: avg('image'),
      msPerVideo: avg('video'),
      msPerEmbedding: avg('ai'),
      done: this.done,
      grouping: this.lastGroupStats,
    };
  }
}

module.exports = { Analyzer, readCfg, sanitizeCfg, DEFAULT_CFG, CFG_KEY, STATE_KEY, flags, safePath, FVERSION, RETENTION };
