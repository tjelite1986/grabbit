'use strict';
// dupes.db: the Smart Duplicate Manager's own state, ATTACHed as `dx` onto the
// items.db connection. items.db keeps its schema, so a rollback is an image
// swap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const itemStore = require('../item-store');
const dupeStore = require('../dupe-store');

const DX_TABLES = ['features', 'embeddings', 'sim_groups', 'pair_decisions', 'reviews', 'trash_meta', 'app_trash', 'ops', 'scan_history', 'prevention'];

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupestore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const itemsFile = path.join(dir, 'items.db');
  const dupesFile = path.join(dir, 'dupes.db');
  const s = itemStore.open(itemsFile);
  let closed = false;
  const close = () => { if (!closed) { closed = true; s.close(); } };
  t.after(close);
  const dx = dupeStore.attach(s.raw, dupesFile);
  return { dir, s, dx, itemsFile, dupesFile, close };
}

// A present, hashed file row in items.db file_hashes.
function fileRow(s, root, rel, sha, { ino = 1, bytes = 10 } = {}) {
  const { row } = s.fileSeen(root, rel, { dev: 1, ino, size: bytes, mtimeMs: 1000 });
  s.fileHashed(row.id, { sha256: sha }, 2000);
  return row.id;
}

const tablesIn = (db, schema) => db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all().map((r) => r.name);

test('attach keeps items.db at its schema version and puts every new table in a separate dupes.db', (t) => {
  const { s, dupesFile, itemsFile, close } = setup(t);
  assert.ok(fs.existsSync(dupesFile));
  assert.equal(s.raw.pragma('main.user_version', { simple: true }), itemStore.SCHEMA_VERSION);
  assert.equal(s.raw.pragma('dx.user_version', { simple: true }), dupeStore.SCHEMA_VERSION);
  const main = tablesIn(s.raw, 'main');
  for (const name of DX_TABLES) assert.ok(!main.includes(name), `${name} must not be in items.db`);
  const dx = tablesIn(s.raw, 'dx');
  for (const name of DX_TABLES) assert.ok(dx.includes(name), `${name} is in dupes.db`);
  close();
  // Rollback: an older Grabbit opens items.db alone and finds it exactly as
  // it knows it, with the 3.0.3 duplicate tables in place.
  const old = new Database(itemsFile, { readonly: true });
  try {
    assert.equal(old.pragma('user_version', { simple: true }), itemStore.SCHEMA_VERSION);
    const names = tablesIn(old, 'main');
    for (const name of ['file_hashes', 'dupe_acks', 'dupe_trash']) assert.ok(names.includes(name), `${name} stays in items.db`);
    for (const name of DX_TABLES) assert.ok(!names.includes(name));
  } finally {
    old.close();
  }
});

test('attach is idempotent on one connection and keeps its data across a reopen', (t) => {
  const { dir, s, dx, itemsFile, dupesFile, close } = setup(t);
  dx.decidePairs(['b', 'a'], 'different', 'owner', 5);
  const again = dupeStore.attach(s.raw, dupesFile);
  assert.equal(again.decision('a', 'b'), 'different');
  assert.equal(s.raw.prepare('PRAGMA database_list').all().filter((d) => d.name === 'dx').length, 1);
  close();
  const s2 = itemStore.open(itemsFile);
  t.after(() => s2.close());
  const dx2 = dupeStore.attach(s2.raw, path.join(dir, 'dupes.db'));
  assert.equal(dx2.decision('b', 'a'), 'different');
  assert.equal(s2.raw.pragma('main.user_version', { simple: true }), itemStore.SCHEMA_VERSION);
});

test('a dupes.db from a newer Grabbit is refused, and items.db is not touched', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupestore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const newer = new Database(path.join(dir, 'dupes.db'));
  newer.pragma(`user_version = ${dupeStore.SCHEMA_VERSION + 5}`);
  newer.close();
  const s = itemStore.open(path.join(dir, 'items.db'));
  t.after(() => s.close());
  assert.throws(() => dupeStore.attach(s.raw, path.join(dir, 'dupes.db')), dupeStore.DupeStoreError);
  assert.equal(s.raw.pragma('main.user_version', { simple: true }), itemStore.SCHEMA_VERSION);
});

test('pair decisions are keyed on the sorted pair of content hashes', (t) => {
  const { dx } = setup(t);
  assert.deepEqual(dupeStore.pairKey('z', 'a'), ['a', 'z']);
  assert.equal(dx.decision('a', 'b'), null);
  // Keep multiple: every pair among three, a repeated hash adds nothing.
  assert.equal(dx.decidePairs(['c', 'a', 'b', 'a'], 'different', 'owner', 10), 3);
  assert.equal(dx.decision('b', 'a'), 'different');
  assert.equal(dx.decision('c', 'b'), 'different');
  assert.equal(dx.decidePairs(['a', 'b'], 'related', 'owner', 11), 1);
  assert.equal(dx.decision('a', 'b'), 'related', 'a later decision replaces the earlier one');
  const sub = dx.decisionsFor(['a', 'b', 'x']);
  assert.deepEqual([...sub.entries()], [['a|b', 'related']]);
  assert.equal(dx.decisionsFor([]).size, 0);
  assert.equal(dx.allDecisions().size, 3);
  assert.equal(dx.undecidePairs(['b', 'c', 'a']), 3);
  assert.equal(dx.allDecisions().size, 0);
});

test('reviews are keyed on content signatures, so regrouping never drops a decision', (t) => {
  const { dx } = setup(t);
  assert.equal(dupeStore.signatureOf('photo', ['b', 'a', 'b']), 'photo:a,b');
  const sig = dupeStore.signatureOf('photo', ['a', 'b']);
  dx.setReview(sig, 'photo', 'keep_all', { keep: [1, 2], note: 'x'.repeat(900), by: 'owner' }, 7);
  dx.decidePairs(['a', 'b'], 'different', 'owner', 7);
  dx.replaceGroups('photo', [{ match: 'similar', score: 0.9, members: [{ sha256: 'b' }, { sha256: 'a' }] }], 8);
  dx.replaceGroups('photo', [{ match: 'near', score: 0.99, members: [{ sha256: 'a' }, { sha256: 'b' }] }], 9);
  const second = dx.simGroups('photo')[0];
  assert.equal(second.match, 'near', 'the new run replaced the old group');
  assert.equal(second.signature, sig);
  const r = dx.review(sig);
  assert.equal(r.decision, 'keep_all');
  assert.deepEqual(JSON.parse(r.keep), [1, 2]);
  assert.equal(r.note.length, 500);
  assert.equal(dx.decision('a', 'b'), 'different');
  assert.ok(dx.reviewsFor('photo').has(sig));
  assert.equal(dx.reviewsFor('video').size, 0);
  assert.equal(dx.dropReview(sig), 1);
  assert.equal(dx.review(sig), undefined);
});

test('replaceGroups replaces one engine\'s groups only, and a partial match has its own signature', (t) => {
  const { dx } = setup(t);
  dx.replaceGroups('video', [{ match: 'reencoded', score: 0.8, members: [{ sha256: 'v1' }, { sha256: 'v2' }] }], 1);
  const n = dx.replaceGroups('photo', [
    { match: 'similar', score: 0.7, members: [{ sha256: 'p1' }, { sha256: 'p2' }], explain: { why: 'test' } },
    { match: 'near', score: 0.95, members: [{ sha256: 'p2' }, { sha256: 'p1' }] },
  ], 2);
  assert.equal(n, 2);
  const photos = dx.simGroups('photo');
  assert.equal(photos.length, 1, 'a second group with the same members is not stored twice');
  assert.deepEqual(photos[0].explain, { why: 'test' });
  assert.equal(dx.simGroups('video').length, 1, 'the video engine\'s groups are untouched');
  assert.deepEqual(dx.simGroup(photos[0].id).members, [{ sha256: 'p1' }, { sha256: 'p2' }]);
  assert.equal(dx.simGroup(99999), null);
  dx.replaceGroups('video', [
    { match: 'partial', score: 0.6, members: [{ sha256: 'v1' }, { sha256: 'v2' }] },
    { match: 'reencoded', score: 0.8, members: [{ sha256: 'v1' }, { sha256: 'v2' }] },
  ], 3);
  const sigs = dx.simGroups('video').map((g) => g.signature).sort();
  assert.deepEqual(sigs, ['video-partial:v1,v2', 'video:v1,v2']);
});

test('feature work covers each present content once, and refused files get a skip marker', (t) => {
  const { s, dx } = setup(t);
  fileRow(s, '/r', 'a.jpg', 'A', { ino: 1 });
  fileRow(s, '/r', 'a-copy.jpg', 'A', { ino: 2 });
  fileRow(s, '/r', 'b.mp4', 'B', { ino: 3 });
  const goneId = fileRow(s, '/r', 'gone.jpg', 'G', { ino: 4 });
  s.fileGoneNow(goneId, 3000);
  fileRow(s, '/r', 'notes.txt', 'T', { ino: 5 });
  const accept = (r) => (r.rel.endsWith('.jpg') ? 'image' : r.rel.endsWith('.mp4') ? 'video' : null);
  const todo = dx.featureTodo({ fversion: 1, accept });
  assert.deepEqual(todo.rows.map((r) => [r.sha256, r.kind]).sort(), [['A', 'image'], ['B', 'video']]);
  assert.equal(todo.scanned, 3, 'the gone file is not work');
  dx.skipFeature('T', 'image', 1, 'not media');
  dx.putFeature({ sha256: 'A', kind: 'image', fversion: 1, width: 10, height: 20, phash: 'ff' });
  assert.deepEqual(dx.featureTodo({ fversion: 1, accept }).rows.map((r) => r.sha256), ['B']);
  // A newer feature version makes the older row work again.
  assert.deepEqual(dx.featureTodo({ fversion: 2, accept }).rows.map((r) => r.sha256).sort(), ['A', 'B']);
  assert.equal(dx.feature('A').width, 10);
  assert.equal(dx.feature('T').error, 'skip: not media');
  assert.deepEqual(dx.featureRows('image').map((f) => f.sha256), ['A'], 'skip rows and gone files are not analysed rows');
  dx.putFeature({ sha256: 'G', kind: 'image', fversion: 1 });
  assert.deepEqual(dx.featureRows('image').map((f) => f.sha256), ['A']);
  const counts = Object.fromEntries(dx.featureCounts().map((c) => [c.kind, c]));
  assert.equal(counts.image.n, 3);
  assert.equal(counts.image.errors, 0, 'a skip marker is not an error');
  assert.equal(dx.clearSkips(), 1);
  assert.equal(dx.feature('T'), undefined);
});

test('embeddings round-trip as Float32Array, per model, and a version change is new work', (t) => {
  const { s, dx } = setup(t);
  fileRow(s, '/r', 'a.jpg', 'A');
  dx.putFeature({ sha256: 'A', kind: 'image', fversion: 1 });
  assert.deepEqual(dx.embeddingTodo('light', 'v1'), ['A']);
  dx.putEmbedding('A', 'light', 'v1', new Float32Array([0.5, -1, 2]));
  assert.deepEqual(dx.embeddingTodo('light', 'v1'), []);
  assert.deepEqual(dx.embeddingTodo('light', 'v2'), ['A']);
  assert.deepEqual(dx.embeddingTodo('large', 'v1'), ['A'], 'another model adds rows');
  const e = dx.embeddings('light', 'v1');
  assert.equal(e.length, 1);
  assert.ok(e[0].vec instanceof Float32Array);
  assert.deepEqual([...e[0].vec], [0.5, -1, 2]);
  dx.putEmbedding('A', 'large', 'v1', null, 'x'.repeat(400));
  assert.deepEqual(dx.embeddings('large', 'v1'), [], 'a failed embedding has no vector');
  const c = dx.embeddingCounts().find((r) => r.model === 'large');
  assert.equal(c.ok, 0);
});

test('app trash entries end once, restored or purged, never both', (t) => {
  const { dx } = setup(t);
  const id = dx.appTrashAdd({ adapter: 'tikshortis', ref: 41, root: '/tik', rel: 'a.mp4', sha256: 'A', bytes: 10, app: 'TikShortis' }, 5);
  assert.equal(dx.appTrashGet(id).ref, '41');
  assert.throws(() => dx.appTrashAdd({ adapter: 'tikshortis', ref: '41', root: '/tik', rel: 'b.mp4', sha256: 'A', bytes: 10 }), /UNIQUE/);
  assert.deepEqual(dx.appTrashHeld().map((r) => r.id), [id]);
  assert.throws(() => dx.appTrashDone(id, 'at'), dupeStore.DupeStoreError);
  assert.equal(dx.appTrashDone(id, 'restored_at', 6), 1);
  assert.equal(dx.appTrashDone(id, 'purged_at', 7), 0, 'a restored entry cannot be purged');
  assert.equal(dx.appTrashDone(id, 'restored_at', 8), 0);
  assert.deepEqual(dx.appTrashHeld(), []);
  assert.equal(dx.appTrashGet(id).restored_at, 6);
  assert.equal(dx.appTrashGet(id).purged_at, null);
});

test('trash meta adds 3.0.4 fields beside items.db trash rows and can be updated', (t) => {
  const { dx } = setup(t);
  dx.putTrashMeta(3, { reason: 'Identical copy', app: 'Grabbit', keep_root: '/g', keep_rel: 'a.mp4' });
  dx.putTrashMeta('3', { reason: 'merged', app: 'Grabbit', keep_root: '/g', keep_rel: 'b.mp4' });
  const m = dx.trashMeta(3);
  assert.equal(m.reason, 'merged');
  assert.equal(m.keep_rel, 'b.mp4');
  assert.equal(m.kind, null);
  assert.equal(dx.allTrashMeta().size, 1);
});

test('the ops journal shows an interrupted operation as pending', (t) => {
  const { dx } = setup(t);
  const a = dx.opBegin('tikshortis', 'link', { keep: 'a', drop: 'b' }, 'owner', 1);
  const b = dx.opBegin('egram', 'purge', { ref: 1 }, null, 2);
  dx.opBegin('egram', 'restore', { ref: 2 }, null, 3);
  dx.opEnd(a, true, { result: { id: 9 } }, 4);
  dx.opEnd(b, false, { error: 'e'.repeat(800) }, 5);
  assert.deepEqual(dx.opsPending().map((o) => o.op), ['restore']);
  const recent = dx.opsRecent(10);
  assert.equal(recent.length, 3);
  const done = recent.find((o) => o.id === a);
  assert.equal(done.state, 'done');
  assert.deepEqual(JSON.parse(done.result), { id: 9 });
  assert.deepEqual(JSON.parse(done.payload), { keep: 'a', drop: 'b' });
  const failed = recent.find((o) => o.id === b);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.length, 500);
});

test('scan history and the prevention log', (t) => {
  const { dx } = setup(t);
  const h1 = dx.historyStart('exact', 1);
  dx.historyEnd(h1, { files: 3, bytes: 30 }, 2);
  const h2 = dx.historyStart('photo', 3);
  assert.equal(dx.historyDrop(h1), 0, 'a finished run stays in the history');
  assert.equal(dx.historyDrop(h2), 1);
  const hist = dx.history();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].outcome, 'complete');
  assert.equal(hist[0].files, 3);
  dx.preventionAdd({ job_id: 'j1', match: 'exact', action: 'review', sha256: 'A' }, 10);
  dx.preventionAdd({ job_id: 'j2', match: 'photo', action: 'review' }, 11);
  assert.deepEqual(dx.preventionForJob('j1').map((p) => p.sha256), ['A']);
  assert.deepEqual(dx.preventionRecent().map((p) => p.job_id), ['j2', 'j1']);
});

test('snapshotTo writes a consistent copy of dupes.db and leaves no .part behind', (t) => {
  const { dir, dx } = setup(t);
  dx.decidePairs(['a', 'b'], 'different', null, 1);
  const target = path.join(dir, 'snap', 'dupes.db');
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(`${target}.part`, 'stale');
  dx.snapshotTo(target);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['dupes.db']);
  const copy = new Database(target, { readonly: true });
  try {
    assert.equal(copy.pragma('user_version', { simple: true }), dupeStore.SCHEMA_VERSION);
    assert.equal(copy.prepare('SELECT decision FROM pair_decisions').get().decision, 'different');
    assert.ok(!tablesIn(copy, 'main').includes('items'), 'the snapshot is dupes.db alone');
  } finally {
    copy.close();
  }
});
