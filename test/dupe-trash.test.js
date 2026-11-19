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

test('purge deletes only trashed files past the hold time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-trash-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = 10 * HOLD_MS;
  const rows = [
    { id: 1, trash_name: 'old', at: now - HOLD_MS - 1 },
    { id: 2, trash_name: 'new', at: now - 1000 },
  ];
  for (const r of rows) fs.writeFileSync(path.join(dir, r.trash_name), 'x');
  const purged = [];
  const store = {
    trashDue: (before) => rows.filter((r) => r.at < before && !purged.includes(r.id)),
    trashPurged: (id) => (purged.push(id), 1),
  };
  const t = new DupeTrash({ store, trashDir: dir, rootOf, now: () => now });
  assert.equal(t.purge(), 1);
  assert.deepEqual(purged, [1]);
  assert.ok(!fs.existsSync(path.join(dir, 'old')));
  assert.ok(fs.existsSync(path.join(dir, 'new')));
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

test('merge never leaves the live name missing, and a failed swap changes nothing', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const rename = fs.renameSync;
  const seen = [];
  fs.renameSync = (from, to) => {
    seen.push(fs.existsSync(path.join(g, 'b.mp4')));
    if (to === path.join(g, 'b.mp4')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return rename(from, to);
  };
  try {
    await assert.rejects(t.mergeLocal(2, 1), /nothing changed/);
  } finally {
    fs.renameSync = rename;
  }
  assert.ok(seen.every(Boolean), 'b.mp4 was there at every rename');
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
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(g, 'b.mp4')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return rename(from, to);
  };
  try {
    await assert.rejects(t.restore(id), /trash still holds it/);
  } finally {
    fs.renameSync = rename;
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

// Replaces `file` with a new inode holding `body`, as an atomic writer does.
function replaceFile(file, body) {
  const tmp = `${file}.writer`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

test('merge stops and changes nothing when the file is replaced while the trash copy is placed', async () => {
  const { g, trash, trashDir, t } = mergeFixture();
  const b = path.join(g, 'b.mp4');
  await duringLink((to) => to.startsWith(trashDir + path.sep), () => replaceFile(b, 'newer bytes'), async () => {
    await assert.rejects(t.mergeLocal(2, 1), /changed while it was being merged/);
  });
  assert.equal(fs.readFileSync(b, 'utf8'), 'newer bytes', 'the writer\'s file is untouched');
  assert.notEqual(fs.statSync(b).ino, fs.statSync(path.join(g, 'a.mp4')).ino);
  assert.deepEqual(fs.readdirSync(g).sort(), ['a.mp4', 'b.mp4'], 'no merge temp left behind');
  assert.deepEqual(fs.readdirSync(trashDir), [], 'no trash copy left behind');
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
