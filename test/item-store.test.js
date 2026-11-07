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
