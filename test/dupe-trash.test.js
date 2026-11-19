'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planGroup, DupeTrash, HOLD_MS } = require('../dupe-trash');

const ROOTS = {
  '/g': { owner: 'grabbit' },
  '/tik': { owner: 'app', app: 'TikShortis' },
  '/egram-import': { owner: 'app', app: 'egram', importFor: '/egram-lib' },
  '/egram-lib': { owner: 'app', app: 'egram' },
};
const rootOf = (p) => ROOTS[p] || null;
const m = (id, root, extra = {}) => ({ id, root, rel: `f${id}.mp4`, mtime_ms: 1000 + id, link: 'none', item_id: null, ...extra });
const byId = (plan) => Object.fromEntries(plan.members.map((x) => [x.id, x]));

test('an import copy may go only when its app library has the bytes', () => {
  const spent = byId(planGroup([m(1, '/egram-import'), m(2, '/egram-lib')], rootOf));
  assert.equal(spent[1].suggested, true);
  assert.equal(spent[2].keep, true);
  const waiting = byId(planGroup([m(1, '/egram-import'), m(2, '/g')], rootOf));
  assert.equal(waiting[1].removable, false);
  assert.match(waiting[1].why, /has not imported it yet/);
  assert.equal(waiting[2].removable, false, 'the Grabbit copy is the last one anyone may remove');
});

test('a linked copy is kept before an older unlinked one, and the only linked copy of an item never goes', () => {
  const p = byId(planGroup([m(1, '/g'), m(2, '/g', { link: 'filename', item_id: 7 })], rootOf));
  assert.equal(p[2].keep, true);
  assert.equal(p[1].suggested, true);
  // With an app copy kept, the Grabbit copy linked to an item still stays.
  const q = byId(planGroup([m(1, '/tik'), m(2, '/g', { link: 'filename', item_id: 7 }), m(3, '/g')], rootOf));
  assert.equal(q[1].keep, true);
  assert.equal(q[2].removable, false);
  assert.match(q[2].why, /only copy linked/);
  assert.equal(q[3].suggested, true);
});

test('purge deletes only trashed files past the hold time, and only while another copy remains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-trash-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-trash-lib-'));
  test.after(() => fs.rmSync(lib, { recursive: true, force: true }));
  const sha = require('crypto').createHash('sha256').update('x').digest('hex');
  const now = 10 * HOLD_MS;
  const rows = [
    { id: 1, trash_name: 'old', at: now - HOLD_MS - 1, sha256: sha },
    { id: 2, trash_name: 'new', at: now - 1000, sha256: sha },
  ];
  for (const r of rows) fs.writeFileSync(path.join(dir, r.trash_name), 'x');
  fs.writeFileSync(path.join(lib, 'keep.mp4'), 'x');
  const purged = [];
  const store = {
    trashDue: (before) => rows.filter((r) => r.at < before && !purged.includes(r.id)),
    trashPurged: (id) => (purged.push(id), 1),
    dupeMembers: () => [{ root: lib, rel: 'keep.mp4' }],
  };
  const roots = { [lib]: { owner: 'grabbit' } };
  const t = new DupeTrash({ store, trashDir: dir, rootOf: (p) => roots[p] || null, now: () => now });
  assert.equal(await t.purge(), 1);
  assert.deepEqual(purged, [1]);
  assert.ok(!fs.existsSync(path.join(dir, 'old')));
  assert.ok(fs.existsSync(path.join(dir, 'new')));
});

test('a permanent delete keeps the last copy: no verified survivor, nothing is deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-trash-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-trash-lib-'));
  test.after(() => fs.rmSync(lib, { recursive: true, force: true }));
  const imp = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-trash-imp-'));
  test.after(() => fs.rmSync(imp, { recursive: true, force: true }));
  const crypto = require('crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  fs.writeFileSync(path.join(dir, 'held'), 'original');
  // The copy that stayed was removed by hand; another indexed copy now has
  // other bytes, and the only exact copy left waits in an import folder.
  fs.writeFileSync(path.join(lib, 'other.mp4'), 'changed');
  fs.writeFileSync(path.join(imp, 'waiting.mp4'), 'original');
  const row = { id: 1, trash_name: 'held', at: 1, sha256: sha('original'), root: lib, rel: 'gone.mp4' };
  const purged = [];
  let members = [{ root: lib, rel: 'kept.mp4' }, { root: lib, rel: 'other.mp4' }, { root: imp, rel: 'waiting.mp4' }];
  const store = {
    trashGet: () => (purged.length ? { ...row, purged_at: 2 } : row),
    trashPurged: (id) => (purged.push(id), 1),
    dupeMembers: () => members,
  };
  const roots = { [lib]: { owner: 'grabbit' }, [imp]: { owner: 'app', app: 'egram', import: true } };
  let keep = { keep_root: lib, keep_rel: 'kept.mp4', keep_sha256: sha('original') };
  const t = new DupeTrash({ store, trashDir: dir, rootOf: (p) => roots[p] || null, keepOf: () => keep });
  await assert.rejects(() => t.deletePermanently(1), /No other copy of this file could be verified/);
  assert.ok(fs.existsSync(path.join(dir, 'held')));
  assert.deepEqual(purged, []);
  // A near duplicate kept in its place counts only with the bytes it had at the move.
  fs.writeFileSync(path.join(lib, 'similar.jpg'), 'similar v2');
  keep = { keep_root: lib, keep_rel: 'similar.jpg', keep_sha256: sha('similar v1') };
  members = [];
  await assert.rejects(() => t.deletePermanently(1), /No other copy/);
  keep = { keep_root: lib, keep_rel: 'similar.jpg', keep_sha256: sha('similar v2') };
  const r = await t.deletePermanently(1);
  assert.equal(r.bytes, 8);
  assert.ok(!fs.existsSync(path.join(dir, 'held')));
  assert.deepEqual(purged, [1]);
});

test('a move across mounts (EXDEV) copies through a .part, then unlinks the source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-exdev-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = path.join(dir, 'g');
  fs.mkdirSync(g);
  fs.writeFileSync(path.join(g, 'a.mp4'), 'same bytes');
  fs.writeFileSync(path.join(g, 'b.mp4'), 'same bytes');
  const sha = require('crypto').createHash('sha256').update('same bytes').digest('hex');
  const rows = [
    { id: 1, root: g, rel: 'a.mp4', bytes: 10, sha256: sha, mtime_ms: 1, link: 'none', item_id: null },
    { id: 2, root: g, rel: 'b.mp4', bytes: 10, sha256: sha, mtime_ms: 2, link: 'none', item_id: null },
  ];
  const gone = new Set();
  const trash = [];
  const store = {
    dupeFile: (id) => rows.find((r) => r.id === Number(id) && !gone.has(r.id)),
    dupeMembers: () => rows.filter((r) => !gone.has(r.id)),
    trashAdd: (t) => (trash.push(t), trash.length),
    fileGoneNow: (id) => gone.add(id),
  };
  // A move is a hard link plus an unlink; across mounts the link fails with
  // EXDEV (the .part publish inside the trash folder is on one mount).
  const link = fs.linkSync;
  let exdev = 0;
  fs.linkSync = (from, to) => {
    if (!path.basename(from).startsWith('.')) { exdev++; const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; }
    return link(from, to);
  };
  try {
    const t = new DupeTrash({ store, trashDir: path.join(dir, 'trash'), rootOf: () => ({ owner: 'grabbit' }), now: () => 5 });
    await t.remove(2);
  } finally {
    fs.linkSync = link;
  }
  assert.equal(exdev, 1);
  assert.ok(!fs.existsSync(path.join(g, 'b.mp4')));
  const left = fs.readdirSync(path.join(dir, 'trash'));
  assert.deepEqual(left, [trash[0].trash_name], 'no .part left behind');
  assert.equal(fs.readFileSync(path.join(dir, 'trash', left[0]), 'utf8'), 'same bytes');
});

// A tiny store and two identical files in a Grabbit folder, for merge and
// restore paths.
function mergeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-merge-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = path.join(dir, 'g');
  fs.mkdirSync(g);
  fs.writeFileSync(path.join(g, 'a.mp4'), 'same bytes');
  fs.writeFileSync(path.join(g, 'b.mp4'), 'same bytes');
  const sha = require('crypto').createHash('sha256').update('same bytes').digest('hex');
  const rows = [
    { id: 1, root: g, rel: 'a.mp4', bytes: 10, sha256: sha, mtime_ms: 1, link: 'none', item_id: null },
    { id: 2, root: g, rel: 'b.mp4', bytes: 10, sha256: sha, mtime_ms: 2, link: 'none', item_id: null },
  ];
  const trash = [];
  const store = {
    dupeFile: (id) => rows.find((r) => r.id === Number(id)),
    trashAdd: (t) => (trash.push({ ...t, id: trash.length + 1 }), trash.length),
    trashGet: (id) => trash.find((t) => t.id === Number(id)),
    trashPurged: (id) => { trash.find((t) => t.id === id).purged_at = 1; },
    trashRestored: (id) => { trash.find((t) => t.id === id).restored_at = 1; },
    fileSeen: () => {},
    fileGoneNow: () => {},
  };
  const trashDir = path.join(dir, 'trash');
  const t = new DupeTrash({
    store, trashDir, rootOf: () => ({ owner: 'grabbit' }), now: () => 5,
    mergeOf: () => ({ keep_root: g, keep_rel: 'a.mp4' }),
  });
  return { dir, g, trash, trashDir, t };
}

test('merge keeps the live name until the swap, and a failed swap puts the original back', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const link = fs.linkSync;
  const seen = [];
  // The swap takes the live name aside, then links the stage in; that link fails.
  fs.linkSync = (from, to) => {
    if (to === path.join(g, 'b.mp4') && from.includes('.merge-')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    if (!from.includes('.aside-')) seen.push(fs.existsSync(path.join(g, 'b.mp4')));
    return link(from, to);
  };
  try {
    await assert.rejects(t.mergeLocal(2, 1), /nothing changed/);
  } finally {
    fs.linkSync = link;
  }
  assert.ok(seen.every(Boolean), 'b.mp4 was there at every step before the swap');
  const before = fs.statSync(path.join(g, 'b.mp4'));
  assert.notEqual(before.ino, fs.statSync(path.join(g, 'a.mp4')).ino, 'b.mp4 is still its own file');
  assert.deepEqual(fs.readdirSync(g).sort(), ['a.mp4', 'b.mp4'], 'no merge temp left behind');
  assert.deepEqual(fs.readdirSync(trashDir), [], 'no trash copy left behind');
  assert.equal(trash[0].purged_at, 1, 'the trash row is closed');

  const id = await t.mergeLocal(2, 1);
  assert.equal(fs.statSync(path.join(g, 'b.mp4')).ino, fs.statSync(path.join(g, 'a.mp4')).ino);
  const held = path.join(trashDir, trash[id - 1].trash_name);
  assert.equal(fs.readFileSync(held, 'utf8'), 'same bytes');
  assert.equal(fs.statSync(held).ino, before.ino, 'the trash holds the original file');
});

test('restoring a merged copy keeps the trash copy until the swap succeeded', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const id = await t.mergeLocal(2, 1);
  const held = path.join(trashDir, trash[id - 1].trash_name);
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    if (to === path.join(g, 'b.mp4') && from.includes('.restore-')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return link(from, to);
  };
  try {
    await assert.rejects(t.restore(id), /trash still holds it/);
  } finally {
    fs.linkSync = link;
  }
  assert.ok(fs.existsSync(held), 'the trash copy is still there');
  assert.deepEqual(fs.readdirSync(g).sort(), ['a.mp4', 'b.mp4'], 'no restore stage left behind');
  assert.equal(fs.statSync(path.join(g, 'b.mp4')).ino, fs.statSync(path.join(g, 'a.mp4')).ino, 'the link is untouched');

  const r = await t.restore(id);
  assert.equal(r.renamed, false);
  assert.ok(!fs.existsSync(held));
  assert.notEqual(fs.statSync(path.join(g, 'b.mp4')).ino, fs.statSync(path.join(g, 'a.mp4')).ino);
  assert.equal(fs.readFileSync(path.join(g, 'b.mp4'), 'utf8'), 'same bytes');
});

test('a copy across mounts is checked against the sha256 and leaves the source on a mismatch', async () => {
  const { placeCopy } = require('../dupe-trash');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-copy-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src.bin');
  fs.writeFileSync(src, 'payload');
  const link = fs.linkSync;
  fs.linkSync = () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  try {
    await assert.rejects(placeCopy(src, path.join(dir, 'bad.bin'), 'f'.repeat(64)), /does not match/);
    const good = require('crypto').createHash('sha256').update('payload').digest('hex');
    await placeCopy(src, path.join(dir, 'ok.bin'), good);
  } finally {
    fs.linkSync = link;
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ok.bin', 'src.bin'], 'no .part and no bad copy left');
  assert.equal(fs.readFileSync(path.join(dir, 'ok.bin'), 'utf8'), 'payload');
});

test('a similar copy never goes when the copy that stays is only waiting in an import folder', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-similar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = path.join(dir, 'g');
  const imp = path.join(dir, 'imp');
  fs.mkdirSync(g);
  fs.mkdirSync(imp);
  fs.writeFileSync(path.join(g, 'a.jpg'), 'picture a');
  fs.writeFileSync(path.join(imp, 'b.jpg'), 'picture b');
  const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
  const rows = [
    { id: 1, root: g, rel: 'a.jpg', bytes: 9, sha256: sha('picture a'), mtime_ms: 1, link: 'none', item_id: null },
    { id: 2, root: imp, rel: 'b.jpg', bytes: 9, sha256: sha('picture b'), mtime_ms: 2, link: 'none', item_id: null },
  ];
  const store = { dupeFile: (id) => rows.find((r) => r.id === Number(id)), trashAdd: () => 1, fileGoneNow: () => {} };
  const roots = { [g]: { owner: 'grabbit' }, [imp]: { owner: 'app', app: 'egram', importFor: '/lib' } };
  const trash = new DupeTrash({ store, trashDir: path.join(dir, 'trash'), rootOf: (p) => roots[p] || null, now: () => 5 });
  await assert.rejects(trash.removeSimilar(1, 2), /waiting in egram's import folder/);
  assert.ok(fs.existsSync(path.join(g, 'a.jpg')), 'nothing moved');
});

// Runs `fn` with fs.linkSync wrapped: after a link whose target matches
// `when`, `then()` runs, like a writer that acts while a copy is staged.
async function duringLink(when, then, fn) {
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    const r = link(from, to);
    if (when(to)) then();
    return r;
  };
  try {
    return await fn();
  } finally {
    fs.linkSync = link;
  }
}

// Runs `fn` with console.error silenced (expected "copy stays" logs).
async function quiet(fn) {
  const err = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = err; }
}

// Replaces `file` with a new inode holding `body`, as an atomic writer does.
function replaceFile(file, body) {
  const tmp = `${file}.writer`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

test('merge stops and changes nothing when the file is replaced while the trash copy is placed', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const b = path.join(g, 'b.mp4');
  const original = fs.statSync(b).ino;
  await quiet(() => duringLink((to) => to.startsWith(trashDir + path.sep), () => replaceFile(b, 'newer bytes'), async () => {
    await assert.rejects(t.mergeLocal(2, 1), /changed while it was being merged/);
  }));
  assert.equal(fs.readFileSync(b, 'utf8'), 'newer bytes', 'the writer\'s file is untouched');
  assert.notEqual(fs.statSync(b).ino, fs.statSync(path.join(g, 'a.mp4')).ino);
  assert.deepEqual(fs.readdirSync(g).sort(), ['a.mp4', 'b.mp4'], 'no merge temp left behind');
  // Round 7: the held link is now the last name of the original inode.
  const left = fs.readdirSync(trashDir);
  assert.equal(left.length, 1, 'the last name of the original stays in the trash folder');
  assert.equal(fs.statSync(path.join(trashDir, left[0])).ino, original);
  assert.equal(trash.length, 0, 'no trash row recorded');
});

test('restoring a merge refuses when the live name is replaced while the original is staged', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const id = await t.mergeLocal(2, 1);
  const held = path.join(trashDir, trash[id - 1].trash_name);
  const b = path.join(g, 'b.mp4');
  await duringLink((to) => path.basename(to).includes('.restore-'), () => replaceFile(b, 'written meanwhile'), async () => {
    await assert.rejects(t.restore(id), /changed while restoring/);
  });
  assert.equal(fs.readFileSync(b, 'utf8'), 'written meanwhile', 'the newer file is never overwritten');
  assert.ok(fs.existsSync(held), 'the trash still holds the original');
  assert.deepEqual(fs.readdirSync(g).sort(), ['a.mp4', 'b.mp4'], 'no restore stage left behind');
  assert.equal(trash[id - 1].restored_at, undefined, 'the entry is still in the trash');
});

test('a dangling symlink counts as a taken name: moveFile refuses it and restore goes beside it', async () => {
  const { moveFile } = require('../dupe-trash');
  const { g, trash, trashDir, t } = mergeFixture();
  const src = path.join(g, 'src.bin');
  const dangling = path.join(g, 'dangling.bin');
  fs.writeFileSync(src, 'payload');
  fs.symlinkSync(path.join(g, 'nowhere'), dangling);
  await assert.rejects(moveFile(src, dangling), /already exists/);
  assert.equal(fs.readFileSync(src, 'utf8'), 'payload', 'the source stays');
  assert.ok(fs.lstatSync(dangling).isSymbolicLink() && !fs.existsSync(dangling), 'the symlink is untouched');
  fs.unlinkSync(src);
  fs.unlinkSync(dangling);

  // A merged copy whose name is now a dangling symlink comes back beside it.
  const id = await t.mergeLocal(2, 1);
  const b = path.join(g, 'b.mp4');
  fs.unlinkSync(b);
  fs.symlinkSync(path.join(g, 'nowhere'), b);
  const r = await t.restore(id);
  assert.equal(r.renamed, true);
  assert.equal(r.restoredRel, 'b (restored).mp4');
  assert.ok(fs.lstatSync(b).isSymbolicLink(), 'the symlink is left as it was');
  assert.equal(fs.readFileSync(path.join(g, 'b (restored).mp4'), 'utf8'), 'same bytes');
  assert.ok(!fs.existsSync(path.join(trashDir, trash[id - 1].trash_name)));
});

test('restore makes no folder through a symlinked parent, even when the folder is missing', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-restore-ln-')));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = path.join(dir, 'g');
  const outside = path.join(dir, 'outside');
  const trashDir = path.join(dir, 'trash');
  for (const d of [g, outside, trashDir]) fs.mkdirSync(d);
  fs.symlinkSync(outside, path.join(g, 'sub'));
  fs.writeFileSync(path.join(trashDir, 'held'), 'kept bytes');
  const entry = { id: 1, root: g, rel: path.join('sub', 'new', 'b.mp4'), trash_name: 'held', bytes: 10, sha256: require('crypto').createHash('sha256').update('kept bytes').digest('hex') };
  const store = { trashGet: () => entry, trashRestored: () => { throw new Error('must not be recorded'); }, fileSeen: () => {} };
  const t = new DupeTrash({ store, trashDir, rootOf: () => ({ owner: 'grabbit' }), now: () => 5 });
  await assert.rejects(t.restore(1), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), [], 'no folder was made outside the root');
  assert.ok(fs.existsSync(path.join(trashDir, 'held')));
});

test('a name of multi-byte characters gets a trash name under the 255-byte limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-cjk-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = path.join(dir, 'g');
  fs.mkdirSync(g);
  const long = `${'動画'.repeat(40)}.mp4`; // 240 bytes of CJK + .mp4
  fs.writeFileSync(path.join(g, 'a.mp4'), 'same bytes');
  fs.writeFileSync(path.join(g, long), 'same bytes');
  const sha = require('crypto').createHash('sha256').update('same bytes').digest('hex');
  const rows = [
    { id: 1, root: g, rel: 'a.mp4', bytes: 10, sha256: sha, mtime_ms: 1, link: 'none', item_id: null },
    { id: 2, root: g, rel: long, bytes: 10, sha256: sha, mtime_ms: 2, link: 'none', item_id: null },
  ];
  const trash = [];
  const store = {
    dupeFile: (id) => rows.find((r) => r.id === Number(id)),
    dupeMembers: () => rows,
    trashAdd: (x) => (trash.push(x), trash.length),
    fileGoneNow: () => {},
  };
  const t = new DupeTrash({ store, trashDir: path.join(dir, 'trash'), rootOf: () => ({ owner: 'grabbit' }), now: () => 5 });
  await t.remove(2);
  assert.ok(Buffer.byteLength(trash[0].trash_name) <= 255, `${Buffer.byteLength(trash[0].trash_name)} bytes`);
  assert.ok(!fs.existsSync(path.join(g, long)));
});

// Round 4: a cross-mount move must not remove a file a writer published at
// the source name while the copy was being made.
test('a move across mounts keeps a source replaced during the copy, and keeps the copy too', async () => {
  const { moveFile } = require('../dupe-trash');
  const { g, dir } = mergeFixture();
  const src = path.join(g, 'b.mp4');
  const destDir = path.join(dir, 'other-mount');
  fs.mkdirSync(destDir);
  const dest = path.join(destDir, 'held.mp4');
  const expect = fs.lstatSync(src);
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    // The source's own link fails as on another mount; the .part publish
    // inside the target folder works, and a writer replaces the source then.
    if (from === src) { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; }
    const r = link(from, to);
    if (to === dest) replaceFile(src, 'published meanwhile');
    return r;
  };
  try {
    await quiet(() => assert.rejects(moveFile(src, dest, null, expect), /changed while it was being moved/));
  } finally {
    fs.linkSync = link;
  }
  assert.equal(fs.readFileSync(src, 'utf8'), 'published meanwhile', 'the replacement is never unlinked');
  // Round 7: the verified copy may be the last copy of the hashed bytes.
  assert.deepEqual(fs.readdirSync(destDir), ['held.mp4'], 'the verified copy stays, no .part left');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'same bytes');
});

test('a move refuses a source that is no longer the file that was hashed', async () => {
  const { moveFile } = require('../dupe-trash');
  const { g, trashDir } = mergeFixture();
  const src = path.join(g, 'b.mp4');
  const expect = fs.lstatSync(src);
  replaceFile(src, 'same bytes');
  fs.mkdirSync(trashDir, { recursive: true });
  await assert.rejects(moveFile(src, path.join(trashDir, 'x.mp4'), null, expect), /changed while it was being moved/);
  assert.ok(fs.existsSync(src));
  assert.deepEqual(fs.readdirSync(trashDir), []);
});

test('merge stops when the copy that stays is replaced after it was hashed', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const a = path.join(g, 'a.mp4');
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    if (path.basename(to).includes('.merge-')) replaceFile(a, 'other bytes');
    return link(from, to);
  };
  try {
    await assert.rejects(t.mergeLocal(2, 1), /copy that stays changed/);
  } finally {
    fs.linkSync = link;
  }
  assert.equal(fs.readFileSync(path.join(g, 'b.mp4'), 'utf8'), 'same bytes', 'the drop keeps its own bytes');
  assert.deepEqual(fs.readdirSync(g).sort(), ['a.mp4', 'b.mp4'], 'no merge temp left behind');
  assert.ok(!fs.existsSync(trashDir) || fs.readdirSync(trashDir).length === 0);
  assert.equal(trash.length, 0);
});

test('a restore beside a reused 255-byte name stays within the name limit', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const long = `${'é'.repeat(125)}x.mp4`; // 250 + 1 + 4 = 255 bytes
  assert.equal(Buffer.byteLength(long), 255);
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(path.join(trashDir, 'held-1'), 'old bytes');
  fs.writeFileSync(path.join(g, long), 'a newer file');
  trash.push({ id: 1, root: g, rel: long, sha256: require('crypto').createHash('sha256').update('old bytes').digest('hex'), bytes: 9, trash_name: 'held-1' });
  t.mergeOf = () => null;
  const r = await t.restore(1);
  assert.equal(r.renamed, true);
  assert.ok(Buffer.byteLength(r.restoredRel) <= 255, `${Buffer.byteLength(r.restoredRel)} bytes`);
  assert.match(r.restoredRel, / \(restored\)\.mp4$/);
  assert.equal(fs.readFileSync(path.join(g, r.restoredRel), 'utf8'), 'old bytes');
  assert.equal(fs.readFileSync(path.join(g, long), 'utf8'), 'a newer file');
});

test('where hard links are refused, a published copy never replaces a name that appeared meanwhile', async () => {
  const { placeCopy } = require('../dupe-trash');
  const { g, dir } = mergeFixture();
  const to = path.join(dir, 'target.mp4');
  const link = fs.linkSync;
  fs.linkSync = (from, dst) => {
    // No hard links on this filesystem; a writer takes the name first.
    if (dst === to) fs.writeFileSync(to, 'writer was first');
    const e = new Error('no links'); e.code = 'EPERM'; throw e;
  };
  try {
    await assert.rejects(placeCopy(path.join(g, 'a.mp4'), to), /already exists/);
  } finally {
    fs.linkSync = link;
  }
  assert.equal(fs.readFileSync(to, 'utf8'), 'writer was first');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.part')), []);
});

// Round 8: on a read error the exclusive copy's descriptor is closed exactly
// once, by its owner, after the writer has settled (a stream destroy would
// close it too, and a later close could hit a reused descriptor number).
test('a read error during the exclusive copy closes its descriptor once', async () => {
  const { placeCopy } = require('../dupe-trash');
  const { Readable } = require('stream');
  const { g, dir } = mergeFixture();
  const to = path.join(dir, 'target-fd.mp4');
  const link = fs.linkSync, open = fs.openSync, crs = fs.createReadStream, close = fs.close, closeSync = fs.closeSync;
  let fd = null;
  const closes = [];
  fs.linkSync = () => { const e = new Error('no links'); e.code = 'EPERM'; throw e; };
  fs.openSync = (p, flags, ...rest) => { const n = open(p, flags, ...rest); if (p === to && flags === 'wx') fd = n; return n; };
  fs.createReadStream = (p, ...rest) => {
    if (String(p).endsWith('.part')) {
      return new Readable({ read() { this.push(Buffer.from('some')); this.destroy(Object.assign(new Error('EIO: read'), { code: 'EIO' })); } });
    }
    return crs(p, ...rest);
  };
  fs.close = (n, cb) => { if (n === fd) closes.push('close'); return close(n, cb); };
  fs.closeSync = (n) => { if (n === fd) closes.push('closeSync'); return closeSync(n); };
  try {
    await assert.rejects(placeCopy(path.join(g, 'a.mp4'), to), /EIO/);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    Object.assign(fs, { linkSync: link, openSync: open, createReadStream: crs, close, closeSync });
  }
  assert.ok(fd != null, 'the exclusive create ran');
  assert.deepEqual(closes, ['closeSync'], 'closed once, by its owner');
  assert.ok(!fs.existsSync(to), 'the half copy is removed');
});

// Round 5: the directory syncs are slow disk I/O, so they come before the
// last identity check, never between it and the unlink.
test('a source replaced while the trash folder is synced is never unlinked', async () => {
  const { moveFile } = require('../dupe-trash');
  const { g, trashDir } = mergeFixture();
  fs.mkdirSync(trashDir, { recursive: true });
  const src = path.join(g, 'b.mp4');
  const dest = path.join(trashDir, 'held.mp4');
  const expect = fs.lstatSync(src);
  const open = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (p === trashDir) replaceFile(src, 'published meanwhile');
    return open(p, ...rest);
  };
  try {
    await assert.rejects(moveFile(src, dest, null, expect), /changed while it was being moved/);
  } finally {
    fs.openSync = open;
  }
  assert.equal(fs.readFileSync(src, 'utf8'), 'published meanwhile', 'the replacement stays');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'same bytes', 'the hard link is the last name of the original, so it stays');
});

test('a failed sync of the old folder after the unlink still records the trash entry', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  t.store.dupeMembers = () => [1, 2].map((id) => t.store.dupeFile(id));
  const unlink = fs.unlinkSync;
  const open = fs.openSync;
  let gone = false;
  // The source is taken aside and that name is unlinked.
  fs.unlinkSync = (p) => { const r = unlink(p); if (path.dirname(p) === g && path.basename(p).startsWith('.b.mp4.aside-')) gone = true; return r; };
  fs.openSync = (p, ...rest) => {
    if (gone && p === g) { const e = new Error('i/o error'); e.code = 'EIO'; throw e; }
    return open(p, ...rest);
  };
  const err = console.error;
  console.error = () => {};
  try {
    await t.remove(2);
  } finally {
    fs.unlinkSync = unlink;
    fs.openSync = open;
    console.error = err;
  }
  assert.ok(gone);
  assert.equal(trash.length, 1, 'the move is recorded');
  assert.ok(fs.existsSync(path.join(trashDir, trash[0].trash_name)));
});

test('a trash folder made by the first removal is synced into its parent', async () => {
  const { dir, trashDir, t } = mergeFixture();
  t.store.dupeMembers = () => [1, 2].map((id) => t.store.dupeFile(id));
  const open = fs.openSync;
  const opened = [];
  fs.openSync = (p, ...rest) => { opened.push(p); return open(p, ...rest); };
  try {
    await t.remove(2);
  } finally {
    fs.openSync = open;
  }
  const parent = opened.indexOf(dir);
  assert.ok(parent >= 0, 'the parent of the new trash folder is synced');
  assert.ok(parent < opened.indexOf(trashDir), 'before the move syncs the trash folder itself');
});

// Round 6: a directory sync that fails is never taken as durable, and a
// retry syncs again; the final check knows which file the move published.
test('fsyncDir passes only a filesystem that cannot sync a directory', () => {
  const { fsyncDir } = require('../dupe-trash');
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  try {
    fs.openSync = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
    assert.throws(() => fsyncDir(os.tmpdir()), /denied/);
    fs.openSync = open;
    fs.fsyncSync = () => { const e = new Error('not here'); e.code = 'EINVAL'; throw e; };
    assert.doesNotThrow(() => fsyncDir(os.tmpdir()));
    fs.fsyncSync = () => { const e = new Error('i/o error'); e.code = 'EIO'; throw e; };
    assert.throws(() => fsyncDir(os.tmpdir()), /i\/o error/);
  } finally {
    fs.openSync = open;
    fs.fsyncSync = sync;
  }
});

test('a removal after a failed sync of the new trash folder syncs its parent again', async () => {
  const { g, dir, trash, t } = mergeFixture();
  t.store.dupeMembers = () => [1, 2].map((id) => t.store.dupeFile(id));
  const open = fs.openSync;
  let fail = true;
  const opened = [];
  fs.openSync = (p, ...rest) => {
    opened.push(p);
    if (fail && p === dir) { const e = new Error('i/o error'); e.code = 'EIO'; throw e; }
    return open(p, ...rest);
  };
  try {
    await assert.rejects(t.remove(2), /i\/o error/);
    assert.ok(fs.existsSync(path.join(g, 'b.mp4')), 'nothing was moved');
    assert.equal(trash.length, 0);
    fail = false;
    opened.length = 0;
    await t.remove(2);
  } finally {
    fs.openSync = open;
  }
  assert.ok(opened.includes(dir), 'the retry syncs the parent of the trash folder');
  assert.equal(trash.length, 1);
  assert.ok(!fs.existsSync(path.join(g, 'b.mp4')));
});

test('a cross-mount move refuses when a writer replaces the published copy during the folder sync', async () => {
  const { moveFile } = require('../dupe-trash');
  const { g, dir } = mergeFixture();
  const src = path.join(g, 'b.mp4');
  const destDir = path.join(dir, 'other-mount');
  fs.mkdirSync(destDir);
  const dest = path.join(destDir, 'held.mp4');
  const expect = fs.lstatSync(src);
  const link = fs.linkSync;
  const open = fs.openSync;
  fs.linkSync = (from, to) => {
    if (from === src) { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; }
    return link(from, to);
  };
  fs.openSync = (p, ...rest) => {
    if (p === destDir && fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === 'same bytes') replaceFile(dest, 'a writer was here');
    return open(p, ...rest);
  };
  try {
    await assert.rejects(moveFile(src, dest, null, expect), /changed while it was being moved/);
  } finally {
    fs.linkSync = link;
    fs.openSync = open;
  }
  assert.equal(fs.readFileSync(src, 'utf8'), 'same bytes', 'the original is never unlinked');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'a writer was here', "the writer's file is never removed");
});

test('a hard-link move whose new name vanishes during the sync refuses cleanly', async () => {
  const { moveFile, TrashError } = require('../dupe-trash');
  const { g, trashDir } = mergeFixture();
  fs.mkdirSync(trashDir, { recursive: true });
  const src = path.join(g, 'b.mp4');
  const dest = path.join(trashDir, 'held.mp4');
  const expect = fs.lstatSync(src);
  const open = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (p === trashDir) { try { fs.unlinkSync(dest); } catch {} }
    return open(p, ...rest);
  };
  try {
    await assert.rejects(moveFile(src, dest, null, expect), (e) => e instanceof TrashError && /changed while it was being moved/.test(e.message));
  } finally {
    fs.openSync = open;
  }
  assert.equal(fs.readFileSync(src, 'utf8'), 'same bytes');
});

// Round 7: no identity is ever taken by reopening a name, a copy that may be
// the last one of the hashed bytes is never undone, and the last look at
// every file a merge or a merged restore relies on comes right before the
// rename and the unlink, after the slow work.
test('where hard links are refused, the published copy is identified through its own descriptor', async () => {
  const { moveFile } = require('../dupe-trash');
  const { g, dir } = mergeFixture();
  const src = path.join(g, 'b.mp4');
  const destDir = path.join(dir, 'nolinks');
  fs.mkdirSync(destDir);
  const dest = path.join(destDir, 'held.mp4');
  const expect = fs.lstatSync(src);
  const link = fs.linkSync;
  const open = fs.openSync;
  const reopened = [];
  fs.linkSync = () => { const e = new Error('no links'); e.code = 'EPERM'; throw e; };
  // Opening the published name again could open a file a writer put there.
  fs.openSync = (p, flags, ...rest) => {
    if (p === dest && flags !== 'wx') reopened.push(flags);
    return open(p, flags, ...rest);
  };
  try {
    await moveFile(src, dest, null, expect);
  } finally {
    fs.linkSync = link;
    fs.openSync = open;
  }
  assert.deepEqual(reopened, [], 'the copy is never opened by name after its exclusive create');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'same bytes');
  assert.ok(!fs.existsSync(src));
  assert.deepEqual(fs.readdirSync(destDir), ['held.mp4'], 'no .part left');
});

test('merge refuses when the drop is replaced while its trash row is written', async () => {
  const { g, trash, t } = mergeFixture();
  const b = path.join(g, 'b.mp4');
  const add = t.store.trashAdd;
  t.store.trashAdd = (x) => { const r = add(x); replaceFile(b, 'written meanwhile'); return r; };
  await quiet(() => assert.rejects(t.mergeLocal(2, 1), /changed while it was being merged/));
  assert.equal(fs.readFileSync(b, 'utf8'), 'written meanwhile', "the writer's file is never renamed over");
  assert.notEqual(fs.statSync(b).ino, fs.statSync(path.join(g, 'a.mp4')).ino);
  assert.deepEqual(fs.readdirSync(g).sort(), ['a.mp4', 'b.mp4'], 'no merge temp left behind');
  assert.equal(trash[0].purged_at, 1, 'the trash row is closed');
});

test('restoring a merge refuses a stage replaced while it is synced', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const id = await t.mergeLocal(2, 1);
  const held = path.join(trashDir, trash[id - 1].trash_name);
  const original = fs.statSync(held).ino;
  const open = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (p === g) {
      const stage = fs.readdirSync(g).find((n) => n.includes('.restore-'));
      if (stage) replaceFile(path.join(g, stage), 'not the original');
    }
    return open(p, ...rest);
  };
  try {
    await assert.rejects(t.restore(id), /changed while restoring/);
  } finally {
    fs.openSync = open;
  }
  assert.equal(fs.statSync(held).ino, original, 'the trash still holds the original');
  assert.equal(fs.readFileSync(path.join(g, 'b.mp4'), 'utf8'), 'same bytes');
  assert.equal(fs.statSync(path.join(g, 'b.mp4')).ino, fs.statSync(path.join(g, 'a.mp4')).ino, 'the link is untouched');
  assert.equal(trash[id - 1].restored_at, undefined);
});

test('restoring a merge keeps the trash copy when the restored name is replaced during the record', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const id = await t.mergeLocal(2, 1);
  const held = path.join(trashDir, trash[id - 1].trash_name);
  const b = path.join(g, 'b.mp4');
  const done = t.store.trashRestored;
  t.store.trashRestored = (x) => { done(x); replaceFile(b, 'written meanwhile'); };
  await quiet(() => t.restore(id));
  assert.equal(fs.readFileSync(b, 'utf8'), 'written meanwhile');
  assert.ok(fs.existsSync(held), 'the held original stays: it is its last name');
  assert.equal(fs.readFileSync(held, 'utf8'), 'same bytes');
});

// A writer that replaces `p` with new bytes (a new inode), the way a
// downloader or an importer publishes a file: write beside it, rename over.
function writerReplaces(p, bytes) {
  fs.writeFileSync(`${p}.w`, bytes);
  fs.renameSync(`${p}.w`, p);
}

// Runs `fn` while every lstat of `p` is counted; right after call number
// `n` returns, `act()` runs (a writer acting between the last look and the
// change that follows it).
async function afterLstat(p, n, act, fn) {
  const lstat = fs.lstatSync;
  let calls = 0;
  fs.lstatSync = (q, ...rest) => {
    const r = lstat(q, ...rest);
    if (q === p && ++calls === n) act();
    return r;
  };
  try { return await fn(); } finally { fs.lstatSync = lstat; }
}

test('removeIfSame and replaceWith never lose a file a writer put at the name', () => {
  const { removeIfSame, replaceWith } = require('../dupe-trash');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-aside-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'clip.mp4');
  fs.writeFileSync(p, 'old');
  const old = fs.lstatSync(p);
  const same = (s) => s.dev === old.dev && s.ino === old.ino;
  writerReplaces(p, 'new');
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(removeIfSame(p, same), false);
    assert.equal(fs.readFileSync(p, 'utf8'), 'new', 'the writer\'s file is back under its name');
    const stage = path.join(dir, 'stage');
    fs.writeFileSync(stage, 'kept');
    assert.equal(replaceWith(p, same, stage), false);
    assert.equal(fs.readFileSync(p, 'utf8'), 'new');
    assert.ok(fs.existsSync(stage), 'the stage stays for the caller to undo');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['clip.mp4', 'stage'], 'nothing left aside');
    // The file that was checked: replaced and removed as asked.
    const cur = fs.lstatSync(p);
    assert.equal(replaceWith(p, (s) => s.ino === cur.ino, stage), true);
    assert.equal(fs.readFileSync(p, 'utf8'), 'kept');
    assert.deepEqual(fs.readdirSync(dir), ['clip.mp4']);
    const now = fs.lstatSync(p);
    assert.equal(removeIfSame(p, (s) => s.ino === now.ino), true);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    console.error = err;
  }
});

test('a writer replacing the source after the last look keeps its file, and the trash keeps the original', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  t.store.dupeMembers = () => [1, 2].map((id) => t.store.dupeFile(id));
  const notes = [];
  t.journal = { begin: () => 7, end: (id, ok) => notes.push(['end', id, ok]), note: (id, r) => notes.push(['note', id, r]) };
  const b = path.join(fs.realpathSync(g), 'b.mp4');
  const err = console.error;
  console.error = () => {};
  try {
    // lstat 1: realFileOf; 2: moveFile's first look; 3: the last look.
    await assert.rejects(afterLstat(b, 3, () => writerReplaces(b, 'newer bytes'), () => t.remove(2)), /changed/);
  } finally {
    console.error = err;
  }
  assert.equal(fs.readFileSync(b, 'utf8'), 'newer bytes', 'the writer\'s file was not unlinked');
  assert.equal(trash.length, 0, 'no trash row for a refused move');
  const left = fs.readdirSync(trashDir);
  assert.equal(left.length, 1, 'the only name of the original stays in the trash folder');
  assert.equal(fs.readFileSync(path.join(trashDir, left[0]), 'utf8'), 'same bytes');
  assert.deepEqual(notes, [['note', 7, { keptCopy: path.join(trashDir, left[0]) }]], 'the kept copy is listed as unfinished');
  assert.ok(!fs.readdirSync(g).some((n) => n.includes('.aside-')));
});

test('a move is refused when the copy that stays changed after it was hashed', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  t.store.dupeMembers = () => [1, 2].map((id) => t.store.dupeFile(id));
  const a = path.join(fs.realpathSync(g), 'a.mp4');
  const b = path.join(fs.realpathSync(g), 'b.mp4');
  const err = console.error;
  console.error = () => {};
  try {
    await assert.rejects(afterLstat(b, 2, () => writerReplaces(a, 'other bytes'), () => t.remove(2, { plannedKeep: 1 })), /copy that stays changed/);
  } finally {
    console.error = err;
  }
  assert.equal(fs.readFileSync(b, 'utf8'), 'same bytes', 'the copy is still in its place');
  assert.equal(trash.length, 0);
  assert.deepEqual(fs.readdirSync(trashDir), [], 'the trash link is undone (the source still holds it)');
});

test('a move into the trash is journaled and closed with its trash row', async () => {
  const { trash, t } = mergeFixture();
  t.store.dupeMembers = () => [1, 2].map((id) => t.store.dupeFile(id));
  const calls = [];
  t.journal = {
    begin: (p) => (calls.push(['begin', p.from]), 3),
    end: (id, ok) => calls.push(['end', id, ok, trash.length]),
    note: () => calls.push(['note']),
    tx: (fn) => { calls.push(['tx']); return fn(); },
  };
  await t.remove(2);
  assert.deepEqual(calls, [['begin', 'b.mp4'], ['tx'], ['end', 3, true, 1]], 'the journal closes in the same transaction as the trash row');
});

test('merge puts back a file a writer put at the live name after the last look', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const b = path.join(fs.realpathSync(g), 'b.mp4');
  const err = console.error;
  console.error = () => {};
  try {
    // lstat 1: realFileOf; 2 and 3: the two intact() looks.
    await assert.rejects(afterLstat(b, 3, () => writerReplaces(b, 'newer bytes'), () => t.mergeLocal(2, 1)), /changed/);
  } finally {
    console.error = err;
  }
  assert.equal(fs.readFileSync(b, 'utf8'), 'newer bytes', 'the writer\'s file was not overwritten');
  assert.equal(trash[0].purged_at, 1, 'the trash row is closed');
  assert.ok(!fs.readdirSync(g).some((n) => n.startsWith('.')), 'no stage or aside name left');
  assert.equal(fs.readdirSync(trashDir).length, 1, 'the held original stays (its live name holds other bytes now)');
});

test('restore refuses a held file whose bytes are not the ones moved to the trash', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const id = await t.mergeLocal(2, 1);
  const held = path.join(trashDir, trash[id - 1].trash_name);
  // Same size, other bytes, written in place: a same-disk restore would
  // otherwise publish it by a hard link without reading it.
  const before = fs.readFileSync(held, 'utf8');
  fs.writeFileSync(held, before.replace(/./, (c) => (c === 'X' ? 'Y' : 'X')));
  const b = path.join(g, 'b.mp4');
  fs.unlinkSync(b);
  await assert.rejects(t.restore(id), /no longer matches what was moved to the trash/);
  assert.ok(!fs.existsSync(b), 'nothing was published');
  assert.ok(fs.existsSync(held), 'the held file stays');
  assert.equal(trash[id - 1].restored_at || null, null);
});
