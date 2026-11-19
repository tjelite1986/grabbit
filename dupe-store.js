'use strict';
// Smart Duplicate Manager 2.0 state (Grabbit 3.0.4).
//
// Everything new lives in its own SQLite file, dupes.db, ATTACHed to the
// items.db connection as schema `dx`. items.db keeps its schema version (6),
// so rolling back to 3.0.3 is an image swap: the older code never opens
// dupes.db and still finds file_hashes, dupe_acks and dupe_trash exactly as it
// left them. Joins between the two run on one connection.
//
// What is kept here:
// - features: what the photo and video engines read from a file's bytes, keyed
//   on its sha256, so identical copies are analysed once.
// - embeddings: DINOv2 vectors per (sha256, model), versioned; a model switch
//   adds rows and never touches review decisions.
// - sim_groups: the last grouping the engines produced.
// - pair_decisions / reviews: the owner's judgements. They are keyed on
//   content hashes, never on group ids, so they survive regrouping and a model
//   change.
// - app_trash: copies an app took out of service at Grabbit's request (the app
//   holds the file; Grabbit holds the record). Grabbit's own trash stays in
//   items.db dupe_trash; trash_meta adds the 3.0.4 fields to those rows.
// - ops: a journal for operations that touch an app and Grabbit's records, so
//   an interrupted one is visible ("Unfinished app operations"). The owner
//   checks the item in the app and marks the operation checked; Grabbit does
//   not finish or undo it on its own.
// - scan_history, prevention: what ran and what the download check found.

const fs = require('fs');

const MIGRATIONS = [
  `
  CREATE TABLE dx.features (
    sha256 TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    fversion INTEGER NOT NULL,
    width INTEGER, height INTEGER, duration REAL, fps REAL,
    vcodec TEXT, acodec TEXT, bitrate INTEGER, container TEXT,
    phash TEXT, phash_rot TEXT, dhash TEXT, sharpness REAL,
    frames BLOB,
    probes BLOB,
    error TEXT,
    at INTEGER NOT NULL
  );
  CREATE TABLE dx.embeddings (
    sha256 TEXT NOT NULL,
    model TEXT NOT NULL,
    version TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB,
    error TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (sha256, model)
  );
  CREATE TABLE dx.sim_groups (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
    match TEXT NOT NULL CHECK (match IN ('near', 'similar', 'reencoded', 'partial')),
    score REAL NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    members TEXT NOT NULL,
    explain TEXT,
    run INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX dx.sim_groups_kind ON sim_groups (kind, match);
  CREATE TABLE dx.pair_decisions (
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('different', 'related')),
    by TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (a, b),
    CHECK (a < b)
  );
  CREATE TABLE dx.reviews (
    signature TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('reviewed', 'ignored', 'keep_all')),
    keep TEXT,
    note TEXT,
    by TEXT,
    at INTEGER NOT NULL
  );
  CREATE TABLE dx.trash_meta (
    trash_id INTEGER PRIMARY KEY,
    reason TEXT,
    app TEXT,
    kind TEXT,
    audience TEXT,
    keep_root TEXT,
    keep_rel TEXT
  );
  CREATE TABLE dx.app_trash (
    id INTEGER PRIMARY KEY,
    adapter TEXT NOT NULL,
    ref TEXT NOT NULL,
    root TEXT NOT NULL,
    rel TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    keep_root TEXT,
    keep_rel TEXT,
    reason TEXT,
    kind TEXT,
    audience TEXT,
    app TEXT,
    by TEXT,
    at INTEGER NOT NULL,
    restored_at INTEGER,
    purged_at INTEGER,
    UNIQUE (adapter, ref)
  );
  CREATE TABLE dx.ops (
    id INTEGER PRIMARY KEY,
    adapter TEXT NOT NULL,
    op TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
    result TEXT,
    error TEXT,
    by TEXT,
    at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE TABLE dx.scan_history (
    id INTEGER PRIMARY KEY,
    engine TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    files INTEGER,
    bytes INTEGER,
    outcome TEXT,
    detail TEXT
  );
  CREATE TABLE dx.prevention (
    id INTEGER PRIMARY KEY,
    job_id TEXT,
    root TEXT,
    rel TEXT,
    sha256 TEXT,
    match TEXT NOT NULL,
    other_root TEXT,
    other_rel TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX dx.prevention_job ON prevention (job_id);
  `,
];

class DupeStoreError extends Error {}

const pairKey = (x, y) => (x < y ? [x, y] : [y, x]);
const signatureOf = (kind, shas) => `${kind}:${[...new Set(shas)].sort().join(',')}`;

// Attaches dupes.db to the item store's connection and migrates it.
function attach(db, file) {
  const attached = db.prepare('PRAGMA database_list').all().some((d) => d.name === 'dx');
  if (!attached) db.prepare('ATTACH DATABASE ? AS dx').run(file);
  db.pragma('dx.journal_mode = WAL');
  const version = db.pragma('dx.user_version', { simple: true });
  if (version > MIGRATIONS.length) {
    throw new DupeStoreError(`dupes.db has schema version ${version}, newer than this Grabbit (${MIGRATIONS.length})`);
  }
  if (version < MIGRATIONS.length) {
    db.transaction(() => {
      for (let v = version; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
      db.pragma(`dx.user_version = ${MIGRATIONS.length}`);
    })();
  }

  const q = {
    feature: db.prepare('SELECT * FROM dx.features WHERE sha256 = ?'),
    putFeature: db.prepare(`INSERT INTO dx.features (sha256, kind, fversion, width, height, duration, fps, vcodec, acodec, bitrate,
        container, phash, phash_rot, dhash, sharpness, frames, probes, error, at)
      VALUES (@sha256, @kind, @fversion, @width, @height, @duration, @fps, @vcodec, @acodec, @bitrate,
        @container, @phash, @phash_rot, @dhash, @sharpness, @frames, @probes, @error, @at)
      ON CONFLICT (sha256) DO UPDATE SET kind = excluded.kind, fversion = excluded.fversion, width = excluded.width,
        height = excluded.height, duration = excluded.duration, fps = excluded.fps, vcodec = excluded.vcodec,
        acodec = excluded.acodec, bitrate = excluded.bitrate, container = excluded.container, phash = excluded.phash,
        phash_rot = excluded.phash_rot, dhash = excluded.dhash, sharpness = excluded.sharpness, frames = excluded.frames, probes = excluded.probes,
        error = excluded.error, at = excluded.at`),
    putEmbedding: db.prepare(`INSERT INTO dx.embeddings (sha256, model, version, dim, vec, error, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (sha256, model) DO UPDATE SET version = excluded.version, dim = excluded.dim, vec = excluded.vec,
        error = excluded.error, at = excluded.at`),
    decision: db.prepare('SELECT decision FROM dx.pair_decisions WHERE a = ? AND b = ?'),
    putDecision: db.prepare(`INSERT INTO dx.pair_decisions (a, b, decision, by, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (a, b) DO UPDATE SET decision = excluded.decision, by = excluded.by, at = excluded.at`),
    dropDecision: db.prepare('DELETE FROM dx.pair_decisions WHERE a = ? AND b = ?'),
    review: db.prepare('SELECT * FROM dx.reviews WHERE signature = ?'),
    putReview: db.prepare(`INSERT INTO dx.reviews (signature, kind, decision, keep, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (signature) DO UPDATE SET decision = excluded.decision, keep = excluded.keep, note = excluded.note,
        by = excluded.by, at = excluded.at`),
    dropReview: db.prepare('DELETE FROM dx.reviews WHERE signature = ?'),
  };

  const api = {
    file,
    // --- features -------------------------------------------------------------
    feature: (sha) => q.feature.get(String(sha)),
    putFeature(f, now = Date.now()) {
      q.putFeature.run({
        width: null, height: null, duration: null, fps: null, vcodec: null, acodec: null, bitrate: null, container: null,
        phash: null, phash_rot: null, dhash: null, sharpness: null, frames: null, probes: null, error: null, ...f, at: now,
      });
    },
    // Distinct contents of present media files that have no current features
    // yet. `kinds` are 'image' / 'video'; `extOf` decides from the file name.
    // Derivatives (thumbnails, posters, caches) are skipped by the caller's
    // filter, which sees root and rel.
    featureTodo({ fversion, limit = 50, accept }) {
      const rows = db.prepare(`SELECT f.sha256, f.id, f.root, f.rel, f.bytes FROM file_hashes f
        LEFT JOIN dx.features x ON x.sha256 = f.sha256
        WHERE f.sha256 IS NOT NULL AND f.gone_at IS NULL AND (x.sha256 IS NULL OR x.fversion < ?)
        GROUP BY f.sha256 ORDER BY MIN(f.id) LIMIT ?`).all(fversion, Math.max(limit * 4, 200));
      const out = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        const kind = accept(r);
        if (kind) out.push({ ...r, kind });
      }
      return { rows: out, scanned: rows.length };
    },
    // Rows the accept filter refused still need a marker, or the todo query
    // returns them forever: a 'skip' feature row with no data.
    skipFeature(sha, kind, fversion, why, now = Date.now()) {
      api.putFeature({ sha256: sha, kind, fversion, error: `skip: ${why}` }, now);
    },
    clearSkips: () => db.prepare("DELETE FROM dx.features WHERE error LIKE 'skip:%'").run().changes,
    featureRows(kind) {
      return db.prepare(`SELECT x.* FROM dx.features x WHERE x.kind = ? AND x.error IS NULL
        AND EXISTS (SELECT 1 FROM file_hashes f WHERE f.sha256 = x.sha256 AND f.gone_at IS NULL)`).all(kind);
    },
    featureCounts() {
      return db.prepare(`SELECT kind, COUNT(*) AS n, SUM(error IS NULL) AS ok, SUM(error IS NOT NULL AND error NOT LIKE 'skip:%') AS errors
        FROM dx.features GROUP BY kind`).all();
    },

    // --- embeddings -------------------------------------------------------------
    putEmbedding(sha, model, version, vec, error = null, now = Date.now()) {
      const buf = vec ? Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength) : null;
      q.putEmbedding.run(String(sha), model, version, vec ? vec.length : 0, buf, error ? String(error).slice(0, 300) : null, now);
    },
    embeddingTodo(model, version, limit = 20) {
      return db.prepare(`SELECT x.sha256 FROM dx.features x
        LEFT JOIN dx.embeddings e ON e.sha256 = x.sha256 AND e.model = ?
        WHERE x.kind = 'image' AND x.error IS NULL AND (e.sha256 IS NULL OR e.version <> ?)
          AND EXISTS (SELECT 1 FROM file_hashes f WHERE f.sha256 = x.sha256 AND f.gone_at IS NULL)
        LIMIT ?`).all(model, version, limit).map((r) => r.sha256);
    },
    embeddings(model, version) {
      return db.prepare(`SELECT sha256, dim, vec FROM dx.embeddings WHERE model = ? AND version = ? AND vec IS NOT NULL`)
        .all(model, version)
        .map((r) => ({ sha256: r.sha256, vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) }));
    },
    embeddingCounts: () => db.prepare('SELECT model, version, COUNT(*) AS n, SUM(vec IS NOT NULL) AS ok FROM dx.embeddings GROUP BY model, version').all(),

    // --- similar groups ---------------------------------------------------------
    // Replaces one engine's groups with a new run, in one transaction.
    replaceGroups(kind, groups, now = Date.now()) {
      const run = now;
      db.transaction(() => {
        db.prepare('DELETE FROM dx.sim_groups WHERE kind = ?').run(kind);
        const ins = db.prepare(`INSERT INTO dx.sim_groups (kind, match, score, signature, members, explain, run, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (signature) DO NOTHING`);
        for (const g of groups) {
          ins.run(kind, g.match, g.score, signatureOf(g.match === 'partial' ? `${kind}-partial` : kind, g.members.map((m) => m.sha256)),
            JSON.stringify(g.members), JSON.stringify(g.explain || null), run, now);
        }
      })();
      return groups.length;
    },
    simGroups(kind) {
      return db.prepare('SELECT * FROM dx.sim_groups WHERE kind = ? ORDER BY score DESC, id').all(kind)
        .map((g) => ({ ...g, members: JSON.parse(g.members), explain: g.explain ? JSON.parse(g.explain) : null }));
    },
    simGroup: (id) => {
      const g = db.prepare('SELECT * FROM dx.sim_groups WHERE id = ?').get(Number(id));
      return g ? { ...g, members: JSON.parse(g.members), explain: g.explain ? JSON.parse(g.explain) : null } : null;
    },

    // --- the owner's decisions ------------------------------------------------
    decision(x, y) {
      const [a, b] = pairKey(String(x), String(y));
      const r = q.decision.get(a, b);
      return r ? r.decision : null;
    },
    decisionsFor(shas) {
      const set = new Set(shas);
      if (!set.size) return new Map();
      const rows = db.prepare('SELECT a, b, decision FROM dx.pair_decisions').all();
      const out = new Map();
      for (const r of rows) if (set.has(r.a) && set.has(r.b)) out.set(`${r.a}|${r.b}`, r.decision);
      return out;
    },
    allDecisions() {
      const out = new Map();
      for (const r of db.prepare('SELECT a, b, decision FROM dx.pair_decisions').all()) out.set(`${r.a}|${r.b}`, r.decision);
      return out;
    },
    // Keep both / keep multiple: every pair among `shas` is marked different
    // (or related, for an original and its intended derivative), so no later
    // grouping offers them as duplicates again.
    decidePairs(shas, decision, by = null, now = Date.now()) {
      const list = [...new Set(shas.map(String))];
      let n = 0;
      db.transaction(() => {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [a, b] = pairKey(list[i], list[j]);
            if (a === b) continue;
            q.putDecision.run(a, b, decision, by, now);
            n++;
          }
        }
      })();
      return n;
    },
    undecidePairs(shas) {
      const list = [...new Set(shas.map(String))];
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) n += q.dropDecision.run(...pairKey(list[i], list[j])).changes;
      }
      return n;
    },
    review: (sig) => q.review.get(String(sig)),
    reviewsFor(prefix) {
      const out = new Map();
      for (const r of db.prepare('SELECT * FROM dx.reviews WHERE signature LIKE ?').all(`${prefix}:%`)) out.set(r.signature, r);
      return out;
    },
    setReview(sig, kind, decision, { keep = null, note = null, by = null } = {}, now = Date.now()) {
      q.putReview.run(String(sig), kind, decision, keep ? JSON.stringify(keep) : null, note ? String(note).slice(0, 500) : null, by, now);
    },
    dropReview: (sig) => q.dropReview.run(String(sig)).changes,

    // --- trash ------------------------------------------------------------------
    trashMeta: (id) => db.prepare('SELECT * FROM dx.trash_meta WHERE trash_id = ?').get(Number(id)),
    putTrashMeta(id, m) {
      db.prepare(`INSERT INTO dx.trash_meta (trash_id, reason, app, kind, audience, keep_root, keep_rel)
        VALUES (@trash_id, @reason, @app, @kind, @audience, @keep_root, @keep_rel)
        ON CONFLICT (trash_id) DO UPDATE SET reason = excluded.reason, app = excluded.app, kind = excluded.kind,
          audience = excluded.audience, keep_root = excluded.keep_root, keep_rel = excluded.keep_rel`)
        .run({ reason: null, app: null, kind: null, audience: null, keep_root: null, keep_rel: null, ...m, trash_id: Number(id) });
    },
    allTrashMeta() {
      const out = new Map();
      for (const r of db.prepare('SELECT * FROM dx.trash_meta').all()) out.set(r.trash_id, r);
      return out;
    },
    appTrashAdd(t, now = Date.now()) {
      const r = db.prepare(`INSERT INTO dx.app_trash (adapter, ref, root, rel, sha256, bytes, keep_root, keep_rel, reason, kind, audience, app, by, at)
        VALUES (@adapter, @ref, @root, @rel, @sha256, @bytes, @keep_root, @keep_rel, @reason, @kind, @audience, @app, @by, @at)`)
        .run({ keep_root: null, keep_rel: null, reason: null, kind: null, audience: null, app: null, by: null, ...t, ref: String(t.ref), at: now });
      return Number(r.lastInsertRowid);
    },
    appTrashGet: (id) => db.prepare('SELECT * FROM dx.app_trash WHERE id = ?').get(Number(id)),
    appTrashHeld: () => db.prepare('SELECT * FROM dx.app_trash WHERE restored_at IS NULL AND purged_at IS NULL ORDER BY at DESC, id DESC').all(),
    appTrashDone(id, field, now = Date.now()) {
      if (!['restored_at', 'purged_at'].includes(field)) throw new DupeStoreError('bad field');
      return db.prepare(`UPDATE dx.app_trash SET ${field} = ? WHERE id = ? AND restored_at IS NULL AND purged_at IS NULL`).run(now, Number(id)).changes;
    },

    // --- ops journal ------------------------------------------------------------
    opBegin(adapter, op, payload, by = null, now = Date.now()) {
      return Number(db.prepare('INSERT INTO dx.ops (adapter, op, payload, state, by, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(adapter, op, JSON.stringify(payload), 'pending', by, now).lastInsertRowid);
    },
    opEnd(id, ok, { result = null, error = null } = {}, now = Date.now()) {
      db.prepare('UPDATE dx.ops SET state = ?, result = ?, error = ?, done_at = ? WHERE id = ?')
        .run(ok ? 'done' : 'failed', result == null ? null : JSON.stringify(result), error ? String(error).slice(0, 500) : null, now, Number(id));
    },
    // The owner checked an operation the app never answered for.
    opChecked(id, by = null, now = Date.now()) {
      return db.prepare("UPDATE dx.ops SET state = 'failed', error = ?, done_at = ? WHERE id = ? AND state = 'pending'")
        .run(`Checked by ${by || 'the owner'} after the app stopped answering`, now, Number(id)).changes;
    },
    opsPending: () => db.prepare("SELECT * FROM dx.ops WHERE state = 'pending' ORDER BY id").all(),
    opsRecent: (limit = 50) => db.prepare('SELECT * FROM dx.ops ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(limit) || 50)),

    // --- history ----------------------------------------------------------------
    historyStart(engine, now = Date.now()) {
      return Number(db.prepare('INSERT INTO dx.scan_history (engine, started_at) VALUES (?, ?)').run(engine, now).lastInsertRowid);
    },
    historyEnd(id, { files = null, bytes = null, outcome = 'complete', detail = null } = {}, now = Date.now()) {
      db.prepare('UPDATE dx.scan_history SET finished_at = ?, files = ?, bytes = ?, outcome = ?, detail = ? WHERE id = ?')
        .run(now, files, bytes, outcome, detail, Number(id));
    },
    historyDrop: (id) => db.prepare('DELETE FROM dx.scan_history WHERE id = ? AND finished_at IS NULL').run(Number(id)).changes,
    history: (limit = 20) => db.prepare('SELECT * FROM dx.scan_history ORDER BY id DESC LIMIT ?').all(Math.min(200, Number(limit) || 20)),

    // --- prevention ---------------------------------------------------------------
    preventionAdd(p, now = Date.now()) {
      return Number(db.prepare(`INSERT INTO dx.prevention (job_id, root, rel, sha256, match, other_root, other_rel, action, detail, at)
        VALUES (@job_id, @root, @rel, @sha256, @match, @other_root, @other_rel, @action, @detail, @at)`)
        .run({ job_id: null, root: null, rel: null, sha256: null, other_root: null, other_rel: null, detail: null, ...p, at: now }).lastInsertRowid);
    },
    preventionForJob: (jobId) => db.prepare('SELECT * FROM dx.prevention WHERE job_id = ? ORDER BY id').all(String(jobId)),
    preventionRecent: (limit = 50) => db.prepare('SELECT * FROM dx.prevention ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(limit) || 50)),

    // A consistent copy, for the daily state snapshot.
    snapshotTo(target) {
      const part = `${target}.part`;
      fs.rmSync(part, { force: true });
      db.prepare('VACUUM dx INTO ?').run(part);
      fs.renameSync(part, target);
    },
  };
  return api;
}

module.exports = { attach, DupeStoreError, signatureOf, pairKey, SCHEMA_VERSION: MIGRATIONS.length };
