'use strict';
// items.db v4: source metadata, tags, owner edits and duplicate records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const itemStore = require('../item-store');
const sourceMeta = require('../source-meta');

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = itemStore.open(path.join(dir, 'items.db'));
  t.after(() => s.close());
  return s;
}

// --- source-meta ------------------------------------------------------------

test('tag norms fold case, # and width but never join words', () => {
  assert.equal(sourceMeta.tagNorm('#Beach'), 'beach');
  assert.equal(sourceMeta.tagNorm('  BEACH '), 'beach');
  assert.equal(sourceMeta.tagNorm('Ｂｅａｃｈ'), 'beach');
  assert.notEqual(sourceMeta.tagNorm('big dick'), sourceMeta.tagNorm('bigdick'));
  assert.equal(sourceMeta.tagNorm('#'), '');
  assert.equal(sourceMeta.tagNorm({}), '');
  assert.equal(sourceMeta.tagLabel('a\u0000b​c'), 'a b c');
});

test('fromJob keeps site tags, categories and caption hashtags apart and invents nothing', () => {
  const m = sourceMeta.fromJob({
    extractor: 'generic',
    description: 'Sunset run #Beach #summer #beach',
    sourceTags: ['Beach', 'Travel', 'travel'],
    categories: ['People & Blogs'],
    tags: ['#ignored-because-not-explicit'],
    sourceMeta: { id: 'x1', tags: ['Beach', 'Travel'] },
  });
  const by = (o, k = 'tag') => m.tags.filter((x) => x.origin === o && x.kind === k).map((x) => x.label);
  assert.deepEqual(by('site'), ['Beach', 'Travel']);
  assert.deepEqual(by('site', 'category'), ['People & Blogs']);
  assert.deepEqual(by('caption'), ['Beach', 'summer']);
  assert.equal(JSON.parse(m.raw).from, 'extractor');
  // A job with tags but no explicit source tags and no hashtag caption: no tags.
  const none = sourceMeta.fromJob({ title: 'clip 1', tags: ['#made', '#up'], site: 'x', mediaId: '1' });
  assert.deepEqual(none.tags, []);
  assert.equal(none.description, null);
  assert.equal(sourceMeta.fromJob(null), null);
});

test('a raw record over the cap keeps its small fields', () => {
  const raw = sourceMeta.capRaw({ id: 'a', huge: 'x'.repeat(sourceMeta.RAW_MAX_BYTES * 2), tags: ['t'] });
  assert.ok(Buffer.byteLength(raw) <= sourceMeta.RAW_MAX_BYTES);
  const o = JSON.parse(raw);
  assert.equal(o.id, 'a');
  assert.deepEqual(o._dropped, ['huge']);
});

test('ytdlpRaw keeps descriptive fields and drops formats', () => {
  const r = sourceMeta.ytdlpRaw({ id: '1', title: 't', tags: ['a'], formats: [{ url: 'u' }], http_headers: {} });
  assert.deepEqual(Object.keys(r).sort(), ['id', 'tags', 'title']);
});

// --- source metadata in the store ---------------------------------------------

test('source metadata is additive: the first caption stays, tags accumulate', (t) => {
  const s = store(t);
  const it = s.upsert({ key: 'id:x:1', creator: 'ann', title: 'one' });
  s.recordSourceMeta(it.id, sourceMeta.fromJob({ description: 'first #a', sourceTags: ['B'] }), 1);
  s.recordSourceMeta(it.id, sourceMeta.fromJob({ description: 'second #c', sourceTags: ['B', 'D'] }), 2);
  const m = s.getMeta(it.id);
  assert.equal(m.description, 'first #a');
  assert.deepEqual(m.tags.site, ['B', 'D']);
  assert.deepEqual(m.tags.caption, ['a', 'c']);
});

test('source and caption tags cannot be removed or rewritten, even by raw SQL', (t) => {
  const s = store(t);
  const it = s.upsert({ key: 'k' });
  s.recordSourceMeta(it.id, sourceMeta.fromJob({ description: '#cap', sourceTags: ['site'] }));
  assert.throws(() => s.db.prepare("DELETE FROM item_tags WHERE origin = 'site'").run(), /cannot be removed/);
  assert.throws(() => s.db.prepare("UPDATE item_tags SET label = 'x'").run(), /never rewritten/);
  // Removing through the API only touches user tags.
  const r = s.removeUserTags([it.id], ['site', 'cap']);
  assert.deepEqual(r.changed, []);
  assert.deepEqual(s.getMeta(it.id).tags.site, ['site']);
});

test('user tags add, dedupe against source tags, remove, and are logged', (t) => {
  const s = store(t);
  const a = s.upsert({ key: 'a' });
  const b = s.upsert({ key: 'b' });
  s.recordSourceMeta(a.id, sourceMeta.fromJob({ sourceTags: ['Beach'] }));
  const add = s.addUserTags([a.id, b.id], ['#beach', 'Mine', 'mine'], 'owner');
  assert.deepEqual(add.changed.sort(), [a.id, b.id].sort());
  assert.ok(add.skipped.some((x) => x.id === a.id && /already a site tag/.test(x.reason)));
  assert.deepEqual(s.getMeta(a.id).tags.user, ['Mine']);
  assert.deepEqual(s.getMeta(b.id).tags.user, ['beach', 'Mine']);
  // The combined list has one entry per tag, with its origins.
  const all = s.getMeta(a.id).tags.all.map((x) => `${x.norm}:${x.origins.join('+')}`);
  assert.deepEqual(all.sort(), ['beach:site', 'mine:user']);
  // Adding again is a no-op.
  assert.deepEqual(s.addUserTags([b.id], ['MINE']).changed, []);
  const rm = s.removeUserTags([b.id], ['mine']);
  assert.deepEqual(rm.changed, [b.id]);
  assert.deepEqual(s.getMeta(b.id).tags.user, ['beach']);
  const log = s.getMeta(b.id).edits.map((e) => `${e.field}:${e.old_value || ''}>${e.new_value || ''}`);
  assert.deepEqual(log, ['tag_remove:Mine>', 'tag_add:>Mine', 'tag_add:>beach']);
  assert.equal(s.getMeta(b.id).metaRev, 2);
});

test('edits sit beside the source fields and survive a later save from the source', (t) => {
  const s = store(t);
  const it = s.upsert({ key: 'k', creator: 'src_creator', title: 'src title', audience: 'unknown' });
  s.editItem(it.id, { title: 'Better title', creator: 'Real Name' }, 'owner');
  let m = s.getMeta(it.id);
  assert.equal(m.title, 'Better title');
  assert.equal(m.creator, 'Real Name');
  assert.deepEqual(m.source, { title: 'src title', creator: 'src_creator' });
  // The source saves again with a new title: the source field moves, the edit stays.
  s.upsert({ key: 'k', creator: 'src_creator', title: 'src title v2' });
  m = s.getMeta(it.id);
  assert.equal(m.title, 'Better title');
  assert.equal(m.source.title, 'src title v2');
  // '' removes the edit.
  s.editItem(it.id, { title: '' });
  assert.equal(s.getMeta(it.id).title, 'src title v2');
  assert.equal(s.getMeta(it.id).edited.title, false);
  // Text rules.
  assert.throws(() => s.editItem(it.id, { title: 'x'.repeat(301) }), /at most 300/);
  assert.throws(() => s.editItem(it.id, { title: 5 }), /text expected/);
  assert.throws(() => s.editItem(99999, { title: 'x' }), /no such item/);
});

test('metadata edits never change the audience, the hand mark or the profile', (t) => {
  const s = store(t);
  const adult = s.upsert({ key: 'a', creator: 'adult_creator', audience: 'adult', profileId: 7 });
  const unknown = s.upsert({ key: 'u', creator: 'nobody' });
  const general = s.upsert({ key: 'g', creator: 'general_creator' });
  s.classifyItems([general.id], 'general');
  // Rename the 18+ item to the general creator and tag it: still 18+.
  s.editItem(adult.id, { creator: 'general_creator' });
  s.renameCreator('nobody', 'general_creator');
  s.addUserTags([adult.id, unknown.id], ['safe']);
  const a = s.getById(adult.id);
  const u = s.getById(unknown.id);
  assert.equal(a.audience, 'adult');
  assert.equal(a.profile_id, 7);
  assert.equal(a.creator, 'adult_creator');
  assert.equal(u.audience, 'unknown');
  assert.equal(u.classified_by_hand, 0);
  // And the database still refuses a general delivery of either.
  assert.throws(() => s.recordDelivery(adult.id, 'main', 'dropped'), /not classified general/);
  assert.throws(() => s.recordDelivery(unknown.id, 'main', 'dropped'), /not classified general/);
});

test('renameCreator moves every item shown under a creator, and back', (t) => {
  const s = store(t);
  const a = s.upsert({ key: 'a', creator: 'old' });
  const b = s.upsert({ key: 'b', creator: 'old' });
  const c = s.upsert({ key: 'c', creator: 'new' });
  assert.equal(s.renameCreator('old', 'new', 'owner').changed, 2);
  assert.deepEqual([a, b, c].map((x) => s.getMeta(x.id).creator), ['new', 'new', 'new']);
  assert.equal(s.creatorCounts({ q: 'new' })[0].items, 3);
  // Back again: the source names return and the edits are gone.
  assert.equal(s.renameCreator('new', 'old').changed, 3);
  assert.equal(s.getById(a.id).creator_edit, null);
  assert.equal(s.getById(c.id).creator_edit, 'old');
  assert.throws(() => s.renameCreator('x', 'x'), /same/);
  assert.throws(() => s.renameCreator('', 'x'), /both/);
});

test('listMeta searches captions and filters on tags by origin', (t) => {
  const s = store(t);
  const a = s.upsert({ key: 'a', creator: 'ann', title: 'alpha' }, 1);
  const b = s.upsert({ key: 'b', creator: 'bob', title: 'beta' }, 2);
  const c = s.upsert({ key: 'c', creator: 'cy', title: 'gamma' }, 3);
  s.recordSourceMeta(a.id, sourceMeta.fromJob({ description: 'by the sea #beach', sourceTags: ['Ocean'] }));
  s.addUserTags([b.id], ['beach']);
  const ids = (r) => r.items.map((x) => x.key).sort();
  assert.deepEqual(ids(s.listMeta({ q: 'the sea' })), ['a']);
  assert.deepEqual(ids(s.listMeta({ tag: '#Beach' })), ['a', 'b']);
  assert.deepEqual(ids(s.listMeta({ tag: 'beach', origin: 'source' })), ['a']);
  assert.deepEqual(ids(s.listMeta({ tag: 'beach', origin: 'caption' })), ['a']);
  assert.deepEqual(ids(s.listMeta({ tag: 'beach', origin: 'user' })), ['b']);
  assert.deepEqual(ids(s.listMeta({ tagged: 'none' })), ['c']);
  assert.deepEqual(ids(s.listMeta({ creator: 'bob' })), ['b']);
  assert.deepEqual(ids(s.listMeta({ edited: true })), ['b']);
  // Wildcards in a search are literal.
  assert.deepEqual(ids(s.listMeta({ q: '%' })), []);
  const counts = s.tagCounts();
  const beach = counts.find((x) => x.norm === 'beach');
  assert.equal(beach.items, 2);
  assert.deepEqual(beach.origins.sort(), ['caption', 'user']);
  assert.deepEqual(s.tagCounts({ origin: 'site' }).map((x) => x.norm), ['ocean']);
  const mc = s.metaCounts();
  assert.equal(mc.withSiteTags, 1);
  assert.equal(mc.withUserTags, 1);
  assert.equal(mc.withCaption, 1);
});

// --- duplicate records ----------------------------------------------------------

const stat = (size, mtimeMs, ino = 1, dev = 1) => ({ size, mtimeMs, ino, dev });

test('a file is rehashed only when its size, mtime or inode changes', (t) => {
  const s = store(t);
  let r = s.fileSeen('/r', 'a.mp4', stat(10, 100), 1);
  assert.equal(r.hash, true);
  s.fileHashed(r.row.id, { sha256: 'h1' });
  assert.equal(s.fileSeen('/r', 'a.mp4', stat(10, 100), 2).hash, false);
  r = s.fileSeen('/r', 'a.mp4', stat(11, 100), 3);
  assert.equal(r.hash, true);
  assert.equal(r.row.sha256, null);
  s.fileHashed(r.row.id, { sha256: 'h2' });
  assert.equal(s.fileSeen('/r', 'a.mp4', stat(11, 100, 2), 4).hash, true);
});

test('files a finished walk did not see are gone and leave their groups', (t) => {
  const s = store(t);
  for (const [rel, at] of [['a', 1], ['b', 1], ['c', 1]]) {
    const r = s.fileSeen('/r', rel, stat(5, 1), at);
    s.fileHashed(r.row.id, { sha256: 'same' });
  }
  assert.equal(s.dupeGroups().items[0].files, 3);
  // A second walk starting at 10 sees only a and b.
  s.fileSeen('/r', 'a', stat(5, 1), 10);
  s.fileSeen('/r', 'b', stat(5, 1), 11);
  assert.equal(s.filesGoneBefore('/r', 10), 1);
  assert.equal(s.dupeGroups().items[0].files, 2);
});

test('a file links to an item only on a unique exact file name', (t) => {
  const s = store(t);
  const a = s.upsert({ key: 'a', filename: 'one.mp4' });
  s.upsert({ key: 'b', filename: 'two.mp4' });
  const c = s.upsert({ key: 'c', filename: 'other.mp4' });
  s.recordDelivery(c.id, '18plus', 'refused', { filename: 'two.mp4' });
  assert.deepEqual(s.fileLink('one.mp4'), { link: 'filename', itemId: a.id });
  assert.deepEqual(s.fileLink('two.mp4'), { link: 'ambiguous', itemId: null });
  assert.deepEqual(s.fileLink('ONE.mp4'), { link: 'none', itemId: null });
});

test('acknowledging a group holds until its members change', (t) => {
  const s = store(t);
  const add = (rel, sha) => s.fileHashed(s.fileSeen('/r', rel, stat(100, 1)).row.id, { sha256: sha });
  add('a', 'x');
  add('b', 'x');
  add('c', 'y');
  add('d', 'z');
  add('e', 'z');
  assert.equal(s.dupeGroups().total, 2);
  assert.equal(s.dupeGroups().openBytes, 200);
  s.ackGroup('x', { note: 'kept on purpose', by: 'owner' });
  assert.deepEqual(s.dupeGroups().items.map((g) => g.sha256), ['z']);
  assert.deepEqual(s.dupeGroups({ state: 'acked' }).items.map((g) => g.sha256), ['x']);
  assert.equal(s.dupeGroups().openBytes, 100);
  // A third copy appears: the group is open again.
  add('f', 'x');
  assert.deepEqual(s.dupeGroups().items.map((g) => g.sha256).sort(), ['x', 'z']);
  assert.throws(() => s.ackGroup('y'), /no duplicate group/);
  assert.equal(s.unackGroup('x'), 1);
});

test('a v3 store migrates to v4 with every item, delivery and inbox row kept', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-meta-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'items.db');
  const v3 = itemStore.__withMigrations(itemStore.__MIGRATIONS.slice(0, 3)).open(file);
  const it = v3.upsert({ key: 'id:x:1', creator: 'ann', title: 't', filename: 'f.mp4' });
  v3.classifyItems([it.id], 'general');
  v3.recordDelivery(it.id, 'egram', 'dropped', { filename: 'f.mp4' });
  v3.inboxAdd({ entry: 'ann/f', username: 'ann', itemId: it.id });
  v3.close();
  const s = itemStore.open(file);
  t.after(() => s.close());
  assert.equal(s.db.pragma('user_version', { simple: true }), 4);
  assert.ok(s.migrationBackup && fs.existsSync(s.migrationBackup));
  const row = s.getById(it.id);
  assert.equal(row.audience, 'general');
  assert.equal(row.classified_by_hand, 1);
  assert.equal(row.title_edit, null);
  assert.equal(row.meta_rev, 0);
  assert.equal(s.deliveries(it.id).length, 1);
  assert.equal(s.inboxByEntry('ann/f').item_id, it.id);
  assert.deepEqual(s.fileLink('f.mp4'), { link: 'filename', itemId: it.id });
});
