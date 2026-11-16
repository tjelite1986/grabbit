'use strict';
// Grabbit 2.1 library: media tree, categories, profile tree, 18+ isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const itemStore = require('../item-store');
const library = require('../library');
const profiles = require('../profiles');

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-lib-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'items.db');
}
function seed(s) {
  const mk = (f, raw) => {
    const it = s.upsert(f);
    if (raw) s.db.prepare("INSERT INTO item_source_meta (item_id, raw, captured_at, updated_at) VALUES (?, ?, 1, 1)").run(it.id, JSON.stringify(raw));
    return it;
  };
  return {
    tt: mk({ key: 'id:tiktok:1', site: 'tiktok.com', kind: 'video', audience: 'general', title: 'tt clip', creator: 'ann' }),
    yts: mk({ key: 'id:youtube:s1', site: 'youtube', kind: 'video', audience: 'general', title: 'a short', sourceUrl: 'https://www.youtube.com/shorts/abc' }),
    ytl: mk({ key: 'id:youtube:l1', site: 'youtube', kind: 'video', audience: 'general', title: 'long one' }, { duration: 900 }),
    mid: mk({ key: 'id:vimeo:m1', site: 'vimeo.com', kind: 'video', audience: 'general', title: 'mid' }, { duration: 120 }),
    song: mk({ key: 'id:youtube:song', site: 'youtube', kind: 'audio', audience: 'general', title: 'song' }),
    pic: mk({ key: 'id:instagram:p1', site: 'instagram.com', kind: 'image', audience: 'general', title: 'pic', creator: 'ann' }),
    unk: mk({ key: 'id:tiktok:u', site: 'tiktok.com', kind: 'video', audience: 'unknown', title: 'unk' }),
    ad1: mk({ key: 'id:redgifs:1', site: 'redgifs.com', kind: 'video', audience: 'adult', title: 'secret clip' }, { duration: 20 }),
    ad2: mk({ key: 'id:fikfap:1', site: 'fikfap.com', kind: 'video', audience: 'adult', title: 'secret long' }, { duration: 1200 }),
    ad3: mk({ key: 'id:erome:1', site: 'erome.com', kind: 'image', audience: 'adult', title: 'secret pic' }),
  };
}

test('a v5 database migrates to v6 keeping every row, and the library works on it', (t) => {
  const file = tmpDb(t);
  const Database = require('better-sqlite3');
  const old = new Database(file);
  for (let i = 0; i < 5; i++) old.exec(itemStore.__MIGRATIONS[i]);
  old.pragma('user_version = 5');
  old.prepare("INSERT INTO items (key, audience, kind, site, origin, created_at, updated_at) VALUES ('a', 'general', 'video', 'tiktok.com', 'save', 1, 1)").run();
  old.prepare("INSERT INTO items (key, audience, kind, site, origin, created_at, updated_at) VALUES ('b', 'adult', 'video', 'redgifs.com', 'save', 1, 1)").run();
  old.close();
  const s = itemStore.open(file);
  t.after(() => s.close());
  t.after(() => s.migrationBackup && fs.rmSync(s.migrationBackup, { force: true }));
  assert.equal(s.db.pragma('user_version', { simple: true }), 6);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
  assert.equal(s.library.mediaTree('general').count, 1);
  assert.equal(s.library.mediaTree('adult').count, 1);
});

test('media tree: sections, dynamic platform subs, adult per source, unknown nowhere', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  seed(s);
  const g = s.library.mediaTree('general');
  assert.equal(g.count, 6); // the unknown item and all adult items are excluded
  const by = Object.fromEntries(g.children.map((c) => [c.id, c]));
  assert.equal(by.shortis.count, 2); // tiktok + youtube /shorts/
  assert.deepEqual(by.shortis.children.map((c) => c.id), ['shortis:tiktok', 'shortis:youtube']);
  assert.equal(by.videos.count, 2); // long youtube + uncertain vimeo
  assert.deepEqual(by.videos.children.map((c) => c.id), ['videos:youtube', 'videos:other']);
  assert.equal(by.music.count, 1);
  assert.equal(by.photos.count, 1);
  assert.equal(by.movies.count, 0);
  const a = s.library.mediaTree('adult');
  assert.equal(a.count, 3);
  const ab = Object.fromEntries(a.children.map((c) => [c.id, c]));
  assert.deepEqual(ab['shortis-adults'].children.map((c) => c.id), ['shortis-adults:redgifs']);
  assert.deepEqual(ab['videos-adults'].children.map((c) => c.id), ['videos-adults:fikfap']);
  assert.deepEqual(ab['photos-adults'].children.map((c) => c.id), ['photos-adults:erome']);
});

test('format: explicit source and duration decide, uncertain is flagged and correctable', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const x = seed(s);
  const L = s.library;
  const unc = L.listItems({ scope: 'general', uncertain: true });
  assert.deepEqual(unc.items.map((i) => i.id), [x.mid.id]);
  assert.equal(library.classifyFormat({ url: 'https://example.com/x', duration: 30 }).format, 'short');
  assert.equal(library.classifyFormat({ url: 'https://example.com/x', duration: 600 }).format, 'long');
  assert.equal(library.classifyFormat({ url: 'https://example.com/x' }).format, 'uncertain');
  assert.equal(library.classifyFormat({ url: 'https://tiktok.com/@a/video/1', duration: 900 }).format, 'uncertain');
  const r = L.setFormat({ scope: 'general', ids: [x.mid.id, x.song.id, x.ad1.id], value: 'short' });
  assert.deepEqual(r.changed, [x.mid.id]);
  assert.equal(r.skipped.length, 2); // audio, and an adult item from a general scope
  assert.equal(L.listItems({ scope: 'general', uncertain: true }).total, 0);
  assert.equal(L.listItems({ scope: 'general', node: 'shortis' }).total, 3);
  L.setFormat({ scope: 'general', ids: [x.mid.id], value: 'movie' });
  assert.equal(L.mediaTree('general').children.find((c) => c.id === 'movies').count, 1);
  assert.equal(s.db.prepare('SELECT format_override FROM items WHERE id = ?').get(x.ad1.id).format_override, null);
  assert.ok(s.db.prepare("SELECT COUNT(*) AS n FROM library_log WHERE action = 'format'").get().n >= 2);
});

test('18+ isolation: no general read or write path reaches an adult or unknown item', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const x = seed(s);
  const L = s.library;
  for (const node of ['all', 'shortis', 'videos', 'photos', 'shortis-adults', 'shortis-adults:redgifs']) {
    const r = L.listItems({ scope: 'general', node });
    assert.ok(r.items.every((i) => i.audience === 'general'), node);
  }
  assert.equal(L.listItems({ scope: 'general', q: 'secret' }).total, 0);
  assert.equal(L.listItems({ scope: 'adult', q: 'secret' }).total, 3);
  assert.equal(L.listItems({ scope: 'general', q: 'unk' }).total, 0);
  assert.throws(() => L.mediaTree('all'), /scope/);
  assert.throws(() => L.mediaTree(undefined), /scope/);
  // Categories: a general category refuses an adult item (API and raw SQL), and the other way round.
  const gc = L.createCategory({ scope: 'general', name: 'Fun' });
  const ac = L.createCategory({ scope: 'adult', name: 'Fun' }); // same name, other tree
  assert.notEqual(gc.id, ac.id);
  const r = L.assign({ scope: 'general', ids: [x.tt.id, x.ad1.id, x.unk.id], categoryIds: [gc.id] });
  assert.deepEqual(r.changed, [x.tt.id]);
  assert.equal(r.skipped.length, 2);
  assert.throws(() => L.assign({ scope: 'general', ids: [x.tt.id], categoryIds: [ac.id] }), /no such category/);
  assert.throws(() => s.db.prepare('INSERT INTO item_categories (item_id, category_id, at) VALUES (?, ?, 1)').run(x.ad1.id, gc.id), /own audience/);
  assert.throws(() => s.db.prepare('INSERT INTO item_categories (item_id, category_id, at) VALUES (?, ?, 1)').run(x.tt.id, ac.id), /own audience/);
  assert.throws(() => s.db.prepare('INSERT INTO item_categories (item_id, category_id, at) VALUES (?, ?, 1)').run(x.unk.id, gc.id), /own audience/);
  assert.equal(L.categoryTree('general').roots.length, 1);
  assert.equal(L.categoryTree('general').roots[0].count, 1);
  assert.equal(L.categoryTree('adult').roots[0].count, 0);
  assert.throws(() => L.listItems({ scope: 'general', node: `cat:${ac.id}` }), /no such category/);
  assert.throws(() => L.suggestForItem({ scope: 'general', itemId: x.ad1.id }), /no such item/);
});

test('categories: nesting, rename, move, merge, multi-membership without duplicates', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const x = seed(s);
  const L = s.library;
  const a = L.createCategory({ scope: 'general', name: 'Animals' });
  const dogs = L.createCategory({ scope: 'general', name: 'Dogs', parentId: a.id });
  const puppies = L.createCategory({ scope: 'general', name: 'Puppies', parentId: dogs.id });
  const fun = L.createCategory({ scope: 'general', name: 'Fun' });
  assert.throws(() => L.createCategory({ scope: 'general', name: ' animals ' }), /already exists/);
  assert.throws(() => L.createCategory({ scope: 'general', name: '' }), /needs a name/);
  assert.throws(() => L.createCategory({ scope: 'general', name: 'X', parentId: 9999 }), /no such category/);
  L.assign({ scope: 'general', ids: [x.tt.id, x.ytl.id], categoryIds: [puppies.id, fun.id] });
  L.assign({ scope: 'general', ids: [x.tt.id], categoryIds: [puppies.id] }); // twice: still one row
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM item_categories WHERE item_id = ?').get(x.tt.id).n, 2);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items WHERE key = ?').get('id:tiktok:1').n, 1);
  let tree = L.categoryTree('general');
  const animals = tree.roots.find((r) => r.name === 'Animals');
  assert.equal(animals.count, 2); // branch count is distinct items
  assert.equal(animals.direct, 0);
  assert.equal(L.listItems({ scope: 'general', node: `cat:${a.id}` }).total, 2);
  assert.equal(L.listItems({ scope: 'general', node: `cat:${a.id}`, branch: false }).total, 0); // no direct members
  assert.equal(L.listItems({ scope: 'general', node: `cat:${a.id}`, q: 'long' }).total, 1);
  // Loops are refused.
  assert.throws(() => L.moveCategory({ scope: 'general', id: a.id, parentId: puppies.id }), /itself or its own/);
  assert.throws(() => L.moveCategory({ scope: 'general', id: a.id, parentId: a.id }), /itself or its own/);
  // Move puppies to the top level, rename it.
  L.moveCategory({ scope: 'general', id: puppies.id, parentId: null });
  L.renameCategory({ scope: 'general', id: puppies.id, name: 'Pups' });
  assert.throws(() => L.renameCategory({ scope: 'general', id: puppies.id, name: 'fun' }), /already exists/);
  // Merge Pups into Fun: members move, the row is gone, the items stay.
  L.mergeCategories({ scope: 'general', sourceId: puppies.id, targetId: fun.id });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM categories WHERE id = ?').get(puppies.id).n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM item_categories WHERE category_id = ?').get(fun.id).n, 2);
  assert.throws(() => L.mergeCategories({ scope: 'general', sourceId: fun.id, targetId: fun.id }), /itself/);
  // Depth cap.
  let p = null;
  assert.throws(() => { for (let i = 0; i < 10; i++) p = L.createCategory({ scope: 'general', name: `d${i}`, parentId: p && p.id }); }, /levels deep/);
  // Mass unassign, and the audit log.
  const r = L.assign({ scope: 'general', ids: [x.tt.id, x.ytl.id], categoryIds: [fun.id], remove: true });
  assert.equal(r.changed.length, 2);
  assert.equal(L.categoryTree('general').roots.find((c) => c.name === 'Fun').count, 0);
  const actions = s.db.prepare('SELECT DISTINCT action FROM library_log').all().map((r2) => r2.action).sort();
  assert.deepEqual(actions, ['assign', 'category_create', 'category_merge', 'category_move', 'category_rename', 'unassign']);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 10); // no item was created or removed
});

test('tags only suggest: a matching source or own tag never adds a membership', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const x = seed(s);
  const L = s.library;
  s.setSourceMeta && 0;
  const ins = s.db.prepare("INSERT INTO item_tags (item_id, origin, kind, label, norm, created_at) VALUES (?, ?, 'tag', ?, ?, 1)");
  ins.run(x.tt.id, 'site', 'Cats', 'cats');
  ins.run(x.ytl.id, 'user', 'cats', 'cats');
  ins.run(x.ad1.id, 'site', 'cats', 'cats');
  const cats = L.createCategory({ scope: 'general', name: 'Cats' });
  const sug = L.suggestForCategory({ scope: 'general', categoryId: cats.id });
  assert.deepEqual(sug.items.map((i) => i.id).sort(), [x.tt.id, x.ytl.id].sort()); // not the adult item
  assert.deepEqual(L.suggestForItem({ scope: 'general', itemId: x.tt.id }), [{ id: cats.id, name: 'Cats' }]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM item_categories').get().n, 0);
  // Source and own tags stay separate rows with their origin.
  assert.deepEqual(s.db.prepare('SELECT origin FROM item_tags WHERE norm = ? ORDER BY id').all('cats').map((r) => r.origin), ['site', 'user', 'site']);
});

test('profile tree: canonical creators per platform, Unlinked, merged ids, 18+ isolation', (t) => {
  const s = itemStore.open(tmpDb(t));
  t.after(() => s.close());
  const x = seed(s);
  let store = profiles.emptyStore();
  const now = 1;
  store = profiles.create(store, { name: 'Ann', audience: 'general' }, now).store;
  store = profiles.create(store, { name: 'Ann too', audience: 'general' }, now).store;
  store = profiles.create(store, { name: 'Loner', audience: 'general' }, now).store;
  store = profiles.create(store, { name: 'Vixen', audience: 'adult' }, now).store;
  const id = (n) => store.profiles.find((p) => p.name === n).id;
  const pa = profiles.update(store, id('Ann'), { accounts: [{ platform: 'tiktok', handle: 'ann' }, { platform: 'instagram', handle: 'ann' }] }, now);
  store = pa.store || pa;
  const pb = profiles.update(store, id('Ann too'), { accounts: [{ platform: 'youtube', handle: 'anny' }] }, now);
  store = pb.store || pb;
  store = profiles.merge(store, id('Ann'), [id('Ann too')], now).store;
  const annId = id('Ann');
  const gone = 2;
  s.db.prepare('UPDATE items SET profile_id = ? WHERE id IN (?, ?)').run(annId, x.tt.id, x.pic.id);
  s.db.prepare('UPDATE items SET profile_id = ? WHERE id = ?').run(gone, x.ytl.id); // points at the merged-away profile
  s.db.prepare('UPDATE items SET profile_id = ? WHERE id = ?').run(id('Vixen'), x.ad1.id);
  s.db.prepare('UPDATE items SET profile_id = ? WHERE id = ?').run(id('Vixen'), x.unk.id);
  const L = s.library;
  const g = L.profileTree('general', store);
  assert.equal(g.count, 2); // Ann (one canonical profile) + Loner
  assert.deepEqual(g.children.map((c) => c.id), ['profiles:instagram', 'profiles:tiktok', 'profiles:youtube', 'profiles:unlinked']);
  for (const c of g.children.slice(0, 3)) assert.equal(c.profiles[0].id, annId); // same creator under each platform
  assert.equal(g.children.find((c) => c.id === 'profiles:unlinked').profiles[0].name, 'Loner');
  assert.equal(g.children[1].profiles[0].count, 3); // tt, pic and the item of the merged-away id
  assert.ok(!JSON.stringify(g).includes('Vixen'));
  assert.equal(L.listItems({ scope: 'general', node: `profile:${annId}`, store }).total, 3);
  assert.throws(() => L.listItems({ scope: 'general', node: `profile:${id('Vixen')}`, store }), /no such profile/);
  const a = L.profileTree('adult', store);
  assert.deepEqual(a.children.map((c) => c.id), ['profiles:unlinked']);
  assert.equal(a.children[0].profiles[0].count, 1); // the unknown-audience item is not counted
  assert.equal(L.listItems({ scope: 'adult', node: `profile:${id('Vixen')}`, store }).total, 1);
  assert.throws(() => L.listItems({ scope: 'adult', node: `profile:${annId}`, store }), /no such profile/);
  assert.equal(L.listItems({ scope: 'general', node: 'profile:none', store }).total, 3); // ytl is resolved; song, mid, yts have none
});
