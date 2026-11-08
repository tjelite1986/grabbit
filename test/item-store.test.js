'use strict';
// items.db: schema, migrations and the two database-level locks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const itemStore = require('../item-store');

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-items-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'items.db');
}

test('a fresh store is WAL with the current schema and no backup', (t) => {
  const file = tmpDb(t);
  const s = itemStore.open(file);
  t.after(() => s.close());
  assert.equal(s.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(s.db.pragma('user_version', { simple: true }), itemStore.SCHEMA_VERSION);
  assert.equal(s.migrationBackup, null);
});

test('an adult item can never be lowered, through the API or by raw SQL', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  s.upsert({ key: 'id:x:1', audience: 'adult', reasons: ['test'] });
  assert.equal(s.upsert({ key: 'id:x:1', audience: 'general' }).audience, 'adult');
  assert.equal(s.upsert({ key: 'id:x:1', audience: 'unknown' }).audience, 'adult');
  assert.throws(() => s.db.prepare("UPDATE items SET audience = 'general' WHERE key = 'id:x:1'").run(), /cannot be lowered/);
  assert.equal(s.get('id:x:1').audience, 'adult');
});

test('a general item becomes adult when an adult signal arrives', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  s.upsert({ key: 'k', audience: 'general' });
  assert.equal(s.upsert({ key: 'k', audience: 'adult' }).audience, 'adult');
});

test('the database refuses a general delivery of an item that is not general', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const adult = s.upsert({ key: 'a', audience: 'adult', kind: 'video' });
  const unknown = s.upsert({ key: 'u', audience: 'unknown', kind: 'video' });
  const general = s.upsert({ key: 'g', audience: 'general', kind: 'video' });
  for (const dest of itemStore.GENERAL_DESTINATIONS) {
    for (const status of ['dropped', 'taken']) {
      assert.throws(() => s.recordDelivery(adult.id, dest, status), /cannot be delivered to a general app/, `${dest} ${status}`);
      assert.throws(() => s.recordDelivery(unknown.id, dest, status), /cannot be delivered to a general app/, `${dest} ${status}`);
    }
    // Refusals are recorded for any item.
    s.recordDelivery(adult.id, dest, 'refused', { detail: 'test' });
    s.recordDelivery(general.id, dest, 'dropped');
  }
  s.recordDelivery(adult.id, '18plus', 'dropped');
  assert.equal(s.deliveries(adult.id).filter((d) => d.status === 'dropped').length, 1);
  // Raw SQL meets the same trigger.
  assert.throws(
    () => s.db.prepare("INSERT INTO deliveries (item_id, destination, status, at) VALUES (?, 'main', 'dropped', 0)").run(adult.id),
    /cannot be delivered/
  );
});

test('the database refuses an image into the 18+ app and unknown destinations', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const img = s.upsert({ key: 'img', audience: 'adult', kind: 'image' });
  assert.throws(() => s.recordDelivery(img.id, '18plus', 'dropped'), /videos only/);
  assert.throws(() => s.recordDelivery(img.id, 'somewhere', 'refused'), /CHECK constraint/);
});

test('the registry import is read-only, additive and maps one entry to one item', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const registry = {
    // One save writes its entry under the URL key and the id key.
    'example.com/v/1': { filename: 'alice_-_one.mp4', at: 1, channel: 'main' },
    'id:example:1': { filename: 'alice_-_one.mp4', at: 1, channel: 'main' },
    'id:example:2': { filename: 'bob_-_two.mp4', at: 2, channel: '18plus' },
    'example.com/v/3': { filename: null, at: 3, channel: null },
    'yt:abc': { filename: 'carol_-_three.mp4', at: 4, channel: null },
  };
  const before = JSON.stringify(registry);
  const r = s.importRegistry(registry);
  assert.equal(JSON.stringify(registry), before, 'the registry object is not changed');
  assert.deepEqual(r, { registryItems: 4, added: 4, tightened: 0 });
  // A save into a general app is a delivery, not a classification.
  assert.equal(s.get('id:example:1').audience, 'unknown');
  assert.equal(s.get('id:example:2').audience, 'adult');
  assert.equal(s.get('example.com/v/3').audience, 'unknown');
  assert.equal(s.get('yt:abc').audience, 'unknown');
  assert.equal(s.get('example.com/v/1'), null);
  // A second import adds nothing.
  assert.deepEqual(s.importRegistry(registry), { registryItems: 4, added: 0, tightened: 0 });
  // A later 18+ entry for the same item tightens it; a general one never loosens.
  registry['id:example:1'] = { ...registry['id:example:1'], channel: '18plus' };
  assert.equal(s.importRegistry(registry).tightened, 1);
  assert.equal(s.get('id:example:1').audience, 'adult');
  registry['id:example:1'] = { ...registry['id:example:1'], channel: 'main' };
  s.importRegistry(registry);
  assert.equal(s.get('id:example:1').audience, 'adult');
});

test('an existing store is copied before a migration and keeps every row', (t) => {
  const file = tmpDb(t);
  const s = itemStore.open(file);
  s.upsert({ key: 'keep-me', audience: 'adult', creator: 'x' });
  s.close();
  // Pretend the store is one version behind by adding a migration of our own.
  const Database = require('better-sqlite3');
  const extra = itemStore.__withMigrations([...itemStore.__MIGRATIONS, 'CREATE TABLE extra (id INTEGER PRIMARY KEY);']);
  const s2 = extra.open(file, { Database, now: () => Date.UTC(2026, 10, 7) });
  t.after(() => s2.close());
  assert.ok(s2.migrationBackup && fs.existsSync(s2.migrationBackup), 'backup written');
  assert.equal(s2.get('keep-me').audience, 'adult');
  assert.equal(s2.db.pragma('user_version', { simple: true }), itemStore.SCHEMA_VERSION + 1);
  const old = new Database(s2.migrationBackup, { readonly: true });
  t.after(() => old.close());
  assert.equal(old.prepare("SELECT audience FROM items WHERE key = 'keep-me'").get().audience, 'adult');
  assert.equal(old.pragma('user_version', { simple: true }), itemStore.SCHEMA_VERSION);
});

test('a failed migration leaves the store as it was', (t) => {
  const file = tmpDb(t);
  const s = itemStore.open(file);
  s.upsert({ key: 'keep-me', audience: 'general' });
  s.close();
  const broken = itemStore.__withMigrations([...itemStore.__MIGRATIONS, 'CREATE TABLE ok_part (id INTEGER); THIS IS NOT SQL;']);
  assert.throws(() => broken.open(file));
  const again = itemStore.open(file);
  t.after(() => again.close());
  assert.equal(again.db.pragma('user_version', { simple: true }), itemStore.SCHEMA_VERSION);
  assert.equal(again.get('keep-me').audience, 'general');
  assert.equal(again.db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_part'").get(), undefined);
});

test('a store newer than the code is refused, not touched', (t) => {
  const file = tmpDb(t);
  const s = itemStore.open(file);
  s.db.pragma(`user_version = ${itemStore.SCHEMA_VERSION + 5}`);
  s.close();
  const before = fs.readFileSync(file);
  assert.throws(() => itemStore.open(file), /newer than this Grabbit/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('the snapshot is a complete, openable copy', (t) => {
  const file = tmpDb(t);
  const s = itemStore.open(file);
  t.after(() => s.close());
  s.upsert({ key: 'snap', audience: 'general' });
  const copy = path.join(path.dirname(file), 'snap.db');
  s.snapshotTo(copy);
  const c = itemStore.open(copy);
  t.after(() => c.close());
  assert.equal(c.get('snap').audience, 'general');
});

test('content hashes report the older twin and refuse nothing', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const a = s.upsert({ key: 'a', audience: 'general' });
  const b = s.upsert({ key: 'b', audience: 'general' });
  assert.equal(s.recordHash(a.id, 'f'.repeat(64), 10), null);
  assert.equal(s.recordHash(b.id, 'f'.repeat(64), 10).key, 'a');
});

test('a v1 store migrates to v2 with every row, a backup, and no item classified by hand', (t) => {
  const file = tmpDb(t);
  // A v1 database as the previous release wrote it, built raw: this code's
  // own statements already name the v2 column.
  const Database = require('better-sqlite3');
  const v1 = new Database(file);
  v1.exec(itemStore.__MIGRATIONS[0]);
  v1.pragma('user_version = 1');
  const ins = v1.prepare("INSERT INTO items (key, audience, origin, created_at, updated_at) VALUES (?, ?, 'save', 1, 1)");
  ins.run('a', 'adult');
  ins.run('b', 'general');
  ins.run('c', 'unknown');
  v1.close();
  const s = itemStore.open(file, { now: () => 1_700_000_000_000 });
  t.after(() => s.close());
  assert.ok(s.migrationBackup && fs.existsSync(s.migrationBackup));
  t.after(() => fs.rmSync(s.migrationBackup, { force: true }));
  const rows = s.db.prepare('SELECT key, audience, classified_by_hand FROM items ORDER BY key').all();
  assert.deepEqual(rows.map((r) => `${r.key}=${r.audience}/${r.classified_by_hand}`), ['a=adult/0', 'b=general/0', 'c=unknown/0']);
});

test('classifyItems sets the hand mark, never lowers 18+, and listItems puts refusals first', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const a = s.upsert({ key: 'adult', audience: 'adult', creator: 'ada' }, 1);
  const u1 = s.upsert({ key: 'u1', creator: 'jane', filename: 'jane_-_one.mp4' }, 2);
  const u2 = s.upsert({ key: 'u2', creator: 'bob_100%' }, 3);
  s.recordDelivery(u1.id, 'main', 'refused', { detail: 'not classified', at: 10 });

  const list = s.listItems({ audience: 'unknown' });
  assert.equal(list.total, 2);
  assert.deepEqual(list.items.map((r) => r.key), ['u1', 'u2']);
  assert.equal(list.items[0].refusals, 1);
  assert.equal(list.items[0].last_refusal, 'not classified');
  assert.deepEqual(s.listItems({ refused: true }).items.map((r) => r.key), ['u1']);
  // LIKE wildcards in the search are literal.
  assert.deepEqual(s.listItems({ q: '100%' }).items.map((r) => r.key), ['u2']);
  assert.equal(s.listItems({ q: 'ja_e' }).total, 0, '_ is not a wildcard');
  assert.equal(s.counts().refusedUnknown, 1);

  const g = s.classifyItems([u1.id, a.id, 999], 'general', 50);
  assert.deepEqual(g.changed, [u1.id]);
  assert.deepEqual(g.skipped.map((x) => x.id).sort((x, y) => x - y), [a.id, 999].sort((x, y) => x - y));
  assert.equal(s.get('u1').audience, 'general');
  assert.equal(s.get('u1').classified_by_hand, 1);
  assert.equal(s.get('adult').audience, 'adult');
  // A general item may then be delivered; an adult decision sticks for good.
  s.recordDelivery(u1.id, 'main', 'dropped');
  assert.deepEqual(s.classifyItems([u2.id], 'adult').changed, [u2.id]);
  assert.deepEqual(s.classifyItems([u2.id], 'general').changed, []);
  assert.equal(s.get('u2').audience, 'adult');
  // A later save of an unknown look does not undo the hand mark.
  assert.equal(s.upsert({ key: 'u1', audience: 'unknown' }).classified_by_hand, 1);
  assert.throws(() => s.classifyItems([u1.id], 'unknown'), /general or adult/);
  assert.throws(() => s.classifyItems([], 'general'), /at least one/);
});

test('getBySourceUrl finds the newest item saved from a URL, and nothing for an unknown one', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const url = 'https://www.facebook.com/watch/?v=1';
  s.upsert({ key: 'id:facebook:1', sourceUrl: url, audience: 'unknown' });
  assert.equal(s.getBySourceUrl(url).key, 'id:facebook:1');
  assert.equal(s.getBySourceUrl('https://example.com/none'), null);
  // A later failed resolve files the same URL under a URL key: the id-keyed item still answers.
  s.upsert({ key: 'facebook.com/watch/', sourceUrl: url, audience: 'unknown' });
  assert.equal(s.getBySourceUrl(url).key, 'id:facebook:1');
});

test('a v2 store migrates to v3 keeping every delivery, and egram is a general app', (t) => {
  const file = tmpDb(t);
  const Database = require('better-sqlite3');
  const v2 = new Database(file);
  v2.exec(itemStore.__MIGRATIONS[0]);
  v2.exec(itemStore.__MIGRATIONS[1]);
  v2.pragma('user_version = 2');
  const ins = v2.prepare("INSERT INTO items (key, audience, origin, created_at, updated_at) VALUES (?, ?, 'save', 1, 1)");
  const g = ins.run('g', 'general').lastInsertRowid;
  const u = ins.run('u', 'unknown').lastInsertRowid;
  v2.prepare("INSERT INTO deliveries (item_id, destination, status, detail, at) VALUES (?, 'main', 'dropped', NULL, 5)").run(g);
  v2.prepare("INSERT INTO deliveries (item_id, destination, status, detail, at) VALUES (?, 'platform', 'refused', 'no', 6)").run(u);
  // v2 has no egram: the CHECK refuses it.
  assert.throws(() => v2.prepare("INSERT INTO deliveries (item_id, destination, status, at) VALUES (?, 'egram', 'refused', 7)").run(u), /CHECK/);
  v2.close();

  const s = itemStore.open(file, { now: () => 1_700_000_000_000 });
  t.after(() => s.close());
  t.after(() => fs.rmSync(s.migrationBackup, { force: true }));
  assert.equal(s.db.pragma('user_version', { simple: true }), 3);
  const rows = s.db.prepare('SELECT id, item_id, destination, status, at FROM deliveries ORDER BY id').all();
  assert.deepEqual(rows.map((r) => `${r.item_id}:${r.destination}:${r.status}:${r.at}`), [`${g}:main:dropped:5`, `${u}:platform:refused:6`]);
  // The locks are back on the rebuilt table, egram included.
  assert.throws(() => s.recordDelivery(Number(u), 'egram', 'dropped'), /not classified general/);
  assert.throws(() => s.recordDelivery(Number(u), 'main', 'dropped'), /not classified general/);
  s.recordDelivery(Number(g), 'egram', 'dropped');
  assert.equal(s.deliveredTo(Number(g), 'egram'), true);
  assert.equal(s.deliveredTo(Number(u), 'egram'), false);
  const triggers = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(triggers, ['deliveries_adult_takes_no_images', 'deliveries_general_needs_general_item', 'items_audience_never_lowered']);
});

test('inbox rows: a media row needs an item, states are checked, purge picks settled rows only', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  assert.throws(() => s.inboxAdd({ entry: 'u/a', kind: 'media', username: 'u', mediaFile: 'a.jpg' }), /CHECK/);
  const it = s.upsert({ key: 'id:instagram:A1', audience: 'unknown' });
  const r = s.inboxAdd({ entry: 'u/a', kind: 'media', itemId: it.id, username: 'u', mediaFile: 'a.jpg', groupKey: 'A1', groupSize: 1 }, 100);
  assert.equal(r.state, 'held');
  assert.throws(() => s.inboxAdd({ entry: 'u/a', kind: 'media', itemId: it.id, username: 'u' }), /UNIQUE/);
  assert.throws(() => s.inboxSetState(r.id, 'gone'), /unknown inbox state/);
  const p = s.inboxAdd({ entry: 'u/u', kind: 'profile', username: 'u', sidecarFile: 'u.json' }, 100);
  s.inboxSetState(p.id, 'delivered', 'ok', 200);
  assert.deepEqual(s.inboxOpen().map((x) => x.id), [r.id]);
  assert.deepEqual(s.inboxPurgeDue(150).map((x) => x.id), []);
  assert.deepEqual(s.inboxPurgeDue(201).map((x) => x.id), [p.id]);
  s.inboxMarkPurged(p.id, 300);
  assert.deepEqual(s.inboxPurgeDue(1000).map((x) => x.id), []);
  assert.deepEqual(s.inboxCounts(), { held: 1, delivered: 1 });
});
