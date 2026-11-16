'use strict';
// Rollback of Grabbit 2.1: v6 -> v5 keeps every item and saves the library
// rows, and the v5 code (the previous release) opens the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const itemStore = require('../item-store');
const { downgrade, restore } = require('../scripts/library-downgrade-v6');

test('downgrade v6 -> v5 keeps items written after the upgrade and saves categories; restore puts them back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-down-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'items.db');
  let s = itemStore.open(file);
  const a = s.upsert({ key: 'id:tiktok:1', site: 'tiktok.com', kind: 'video', audience: 'general', title: 'a' });
  const b = s.upsert({ key: 'id:redgifs:1', site: 'redgifs.com', kind: 'video', audience: 'adult', title: 'b' });
  const top = s.library.createCategory({ scope: 'general', name: 'Top' });
  const sub = s.library.createCategory({ scope: 'general', name: 'Sub', parentId: top.id });
  s.library.assign({ scope: 'general', ids: [a.id], categoryIds: [sub.id] });
  s.library.setFormat({ scope: 'adult', ids: [b.id], value: 'movie' });
  // "Written after release": a new item, a tag, an edit.
  const c = s.upsert({ key: 'id:youtube:new', site: 'youtube', kind: 'video', audience: 'general', title: 'after release' });
  s.close();

  const dry = downgrade(file);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.before.categories, 2);

  const r = downgrade(file, { apply: true });
  assert.equal(r.before.items, 3);
  assert.equal(r.after.items, 3);
  assert.equal(r.after.version, 5);
  assert.ok(fs.existsSync(r.copy));
  const saved = JSON.parse(fs.readFileSync(r.json, 'utf8'));
  assert.equal(saved.categories.length, 2);
  assert.equal(saved.item_categories.length, 1);
  assert.deepEqual(saved.format_override, [{ id: b.id, format_override: 'movie' }]);

  // The previous release: the first five migrations only.
  const v5 = itemStore.__withMigrations(itemStore.__MIGRATIONS.slice(0, 5)).open(file);
  assert.equal(v5.db.pragma('user_version', { simple: true }), 5);
  assert.equal(v5.db.prepare('SELECT title FROM items WHERE id = ?').get(c.id).title, 'after release');
  // The old code keeps writing while rolled back.
  v5.upsert({ key: 'id:youtube:during', site: 'youtube', kind: 'video', audience: 'general', title: 'during rollback' });
  v5.close();

  // Roll forward again: 2.1 migrates v5 -> v6, then the saved rows go back.
  s = itemStore.open(file);
  t.after(() => s.close());
  assert.equal(s.db.pragma('user_version', { simple: true }), 6);
  s.close();
  const back = restore(file, r.json);
  assert.deepEqual(back, { categories: 2, memberships: 1, skipped: 0, log: saved.library_log.length, overrides: 1 });
  s = itemStore.open(file);
  const tree = s.library.categoryTree('general');
  assert.equal(tree.roots[0].name, 'Top');
  assert.equal(tree.roots[0].children[0].name, 'Sub');
  assert.equal(tree.roots[0].count, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 4);
});

test('downgrade refuses anything but v6', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-down-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'items.db');
  const v5 = itemStore.__withMigrations(itemStore.__MIGRATIONS.slice(0, 5)).open(file);
  v5.close();
  assert.throws(() => downgrade(file, { apply: true }), /only v6/);
});
