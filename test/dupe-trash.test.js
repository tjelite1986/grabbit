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
  const rename = fs.renameSync;
  let exdev = 0;
  fs.renameSync = (from, to) => {
    if (!path.basename(from).startsWith('.')) { exdev++; const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; }
    return rename(from, to);
  };
  try {
    const t = new DupeTrash({ store, trashDir: path.join(dir, 'trash'), rootOf: () => ({ owner: 'grabbit' }), now: () => 5 });
    await t.remove(2);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(exdev, 1);
  assert.ok(!fs.existsSync(path.join(g, 'b.mp4')));
  const left = fs.readdirSync(path.join(dir, 'trash'));
  assert.deepEqual(left, [trash[0].trash_name], 'no .part left behind');
  assert.equal(fs.readFileSync(path.join(dir, 'trash', left[0]), 'utf8'), 'same bytes');
});
