'use strict';
// The Smart Duplicate Manager service: groups, tabs, the keep choice, actions,
// batch, trash, merges, prevention, cache and references. Real files in temp
// folders, a real item store with dupes.db attached, a real DupeTrash; app
// adapters are plain stub objects (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const itemStore = require('../item-store');
const dupeStore = require('../dupe-store');
const { DupeScanner, planRoots } = require('../dupe-scan');
const { DupeTrash } = require('../dupe-trash');
const { DupeService, DupeError } = require('../dupe-service');
const { AdapterError } = require('../dupe-adapters');
const { kindOf, audienceOf } = require('../dupe-classify');

const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');
const write = (file, body, mtimeSec = null) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mtimeSec != null) fs.utimesSync(file, mtimeSec, mtimeSec);
};
const ino = (file) => fs.statSync(file).ino;

function setup(t, { adapters = null, extra = [] } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupesvc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = itemStore.open(path.join(dir, 'items.db'));
  t.after(() => s.close());
  const dx = dupeStore.attach(s.raw, path.join(dir, 'dupes.db'));
  const own = path.join(dir, 'own');
  const adult = path.join(dir, 'own18');
  const tik = path.join(dir, 'tik');
  const imp = path.join(dir, 'egram-import');
  const lib = path.join(dir, 'egram-lib');
  for (const d of [own, adult, tik, imp, lib]) fs.mkdirSync(d, { recursive: true });
  const candidates = [
    { path: own, label: 'Grabbit library', owner: 'grabbit' },
    { path: adult, label: 'Grabbit 18+ library', owner: 'grabbit', adult: true },
    { path: tik, label: 'TikShortis', owner: 'app', app: 'TikShortis' },
    { path: imp, label: 'egram import', owner: 'app', app: 'egram', importFor: lib },
    { path: lib, label: 'egram library', owner: 'app', app: 'egram' },
    ...extra,
  ];
  const rootOf = (p) => candidates.find((r) => r.path === p) || null;
  // Wired as server.js wires it: 3.0.4 metadata beside each trash row.
  const trash = new DupeTrash({
    store: s,
    trashDir: path.join(dir, 'trash'),
    rootOf,
    onRemoved: (id, row, info) => {
      const r = rootOf(row.root) || {};
      const k = info.keep || {};
      dx.putTrashMeta(id, { reason: info.reason || 'Identical copy', app: r.app || 'Grabbit', kind: kindOf(row.rel), audience: audienceOf(r, null), keep_root: k.root || null, keep_rel: k.rel || null });
    },
    mergeOf: (id) => {
      const m = dx.trashMeta(id);
      return m && m.reason === 'merged' ? m : null;
    },
  });
  const svc = new DupeService({ store: s, dx, roots: candidates, rootOf, trash, adapters: adapters || new Map(), log: () => {} });
  const scan = async () => {
    const sc = new DupeScanner({ store: s, roots: planRoots(candidates), mbPerSec: 1000, pauseMs: 0, log: () => {} });
    s.setSetting('dupes.scan.state', 'running');
    assert.equal(await sc.pass(), true);
    svc.invalidate();
  };
  return { dir, s, dx, own, adult, tik, imp, lib, candidates, rootOf, trash, svc, scan, trashDir: path.join(dir, 'trash') };
}

// The state of a folder: every file with its inode, size, mtime and bytes.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.lstatSync(p);
        out[path.relative(root, p)] = `${st.ino}:${st.size}:${st.mtimeMs}:${st.nlink}:${sha(fs.readFileSync(p))}`;
      }
    }
  };
  walk(root);
  return out;
}

// Records any write-capable fs call aimed under one of `roots`.
function guardWrites(t, roots) {
  const offences = [];
  const hit = (p) => typeof p === 'string' && roots.some((r) => p === r || p.startsWith(r + path.sep));
  const names = ['writeFile', 'writeFileSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'link', 'linkSync',
    'mkdir', 'mkdirSync', 'copyFile', 'copyFileSync', 'symlink', 'symlinkSync', 'truncate', 'truncateSync', 'utimes', 'utimesSync',
    'appendFile', 'appendFileSync', 'chmod', 'chmodSync'];
  const restore = [];
  for (const mod of [fs, fs.promises]) {
    for (const n of names) {
      if (typeof mod[n] !== 'function') continue;
      const orig = mod[n];
      mod[n] = function patched(...args) {
        for (const a of args.slice(0, 2)) if (hit(String(a))) offences.push(`${n} ${a}`);
        return orig.apply(this, args);
      };
      restore.push(() => { mod[n] = orig; });
    }
  }
  const undo = () => { while (restore.length) restore.pop()(); };
  t.after(undo);
  return { offences, undo };
}

const exactGroup = (svc, body, tab = 'identical') => svc.list({ tab, status: 'all', adult: 'show', limit: 200 }).items.find((g) => g.key === `exact:${sha(body)}`);
const byName = (g) => Object.fromEntries(g.members.map((m) => [m.name, m]));

function stubAdapter(o = {}) {
  const calls = [];
  const ad = {
    id: o.id || 'tikshortis',
    app: o.app || 'TikShortis',
    caps: new Set(o.caps || ['lookup', 'link']),
    calls,
    ops: [],
    async opStatus(op) { calls.push(['opStatus', op]); return o.opStatus(op); },
    ready: () => (o.ready ? o.ready() : { ok: true }),
    async link(keep, drop, sha256, op) {
      calls.push(['link', keep, drop, sha256]);
      if (op) ad.ops.push(op);
      if (o.link) return o.link(keep, drop, sha256);
      return { id: 100 + calls.length, uid: String(100 + calls.length).padStart(32, '0'), bytes: 1 };
    },
    async restore(id) { calls.push(['restore', id]); return { id: Number(String(id).split(':')[0]) }; },
    async purge(id) { calls.push(['purge', id]); return { id: Number(String(id).split(':')[0]), bytes: 1 }; },
    async lookup(rels) {
      calls.push(['lookup', rels]);
      if (o.lookup) return o.lookup(rels);
      return new Map();
    },
    async cache() { calls.push(['cache']); if (o.cache) return o.cache(); return null; },
    async cacheClean(dryRun) { calls.push(['cacheClean', dryRun]); return { removed: dryRun ? 0 : 2, dryRun }; },
    async call(method, route, body) { calls.push(['call', method, route, body]); return { ok: true }; },
    async cacheRebuild(body) { return ad.call('POST', 'cache/rebuild', body); },
  };
  return ad;
}

// --- app-owned roots ----------------------------------------------------------

test('a copy in an app library without an adapter is never touched, and says why and what to do', async (t) => {
  const { own, tik, svc, scan, trashDir } = setup(t);
  const body = 'shared clip bytes';
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  write(path.join(tik, 'c.mp4'), body, 3000);
  write(path.join(tik, 'd.mp4'), body, 4000);
  await scan();
  const before = snapshot(tik);
  const guard = guardWrites(t, [tik]);
  const g = exactGroup(svc, body);
  const m = byName(g);
  // The app's copy is the anchor; Grabbit's extra copies can go.
  assert.equal(g.keepId, m['c.mp4'].id);
  assert.equal(m['a.mp4'].action, 'trash');
  assert.equal(m['b.mp4'].action, 'trash');
  assert.equal(m['d.mp4'].action, null);
  assert.ok(m['d.mp4'].why);
  assert.match(m['d.mp4'].fix, /Remove it in TikShortis itself/);
  // The owner keeps a Grabbit copy: the app copies are refused, with reasons.
  const r = await svc.act(g.key, 'keep_selected', { keep: [m['a.mp4'].id] });
  assert.deepEqual(r.done.map((x) => x.name), ['b.mp4']);
  assert.deepEqual(r.refused.map((x) => x.name).sort(), ['c.mp4', 'd.mp4']);
  for (const x of r.refused) assert.ok(x.error);
  assert.ok(r.refused.find((x) => x.name === 'd.mp4').fix);
  // A batch over everything (the group is reviewed now) moves only Grabbit's
  // remaining extra.
  // A filter selects (its dry run returns the keys) but never trashes.
  await assert.rejects(svc.batch({ filter: { tab: 'identical', status: 'all' }, action: 'trash_extras', dryRun: false, expect: { files: 1 } }), /cannot move copies/);
  const sel = await svc.batch({ filter: { tab: 'identical', status: 'all' }, action: 'trash_extras', dryRun: true });
  await assert.rejects(svc.batch({ keys: sel.keys, action: 'trash_extras', dryRun: false }), /Confirm how many/);
  const b = await svc.batch({ keys: sel.keys, action: 'trash_extras', dryRun: false, expect: { files: sel.files } });
  assert.equal(b.done, 1);
  guard.undo();
  assert.deepEqual(guard.offences, []);
  assert.deepEqual(snapshot(tik), before);
  assert.ok(!fs.existsSync(path.join(own, 'a.mp4')));
  assert.ok(!fs.existsSync(path.join(own, 'b.mp4')));
  assert.equal(fs.readdirSync(trashDir).length, 2);
});

test('an app copy goes only through its adapter, which keeps both posts; Grabbit writes nothing there', async (t) => {
  const dirs = {};
  const ad = stubAdapter();
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  Object.assign(dirs, ctx);
  adapters.set(ctx.tik, ad);
  const { tik, svc, scan, dx } = ctx;
  const body = 'tik twin';
  write(path.join(tik, 'one.mp4'), body, 1000);
  write(path.join(tik, 'two.mp4'), body, 2000);
  await scan();
  const before = snapshot(tik);
  const guard = guardWrites(t, [tik]);
  const g = exactGroup(svc, body);
  const m = byName(g);
  assert.equal(m['one.mp4'].recommended, true);
  assert.equal(m['two.mp4'].action, 'link');
  assert.equal(m['two.mp4'].linkTo, m['one.mp4'].id);
  // "Move extra copies to the trash" never links in an app as a side effect.
  const none = await svc.act(g.key, 'trash_extras');
  assert.deepEqual([none.done, none.refused], [[], []]);
  assert.deepEqual(ad.calls, []);
  const r = await svc.act(exactGroup(svc, body).key, 'merge');
  assert.equal(r.done.length, 1);
  assert.match(r.done[0].trash, /^a\d+$/);
  assert.deepEqual(ad.calls, [['link', 'one.mp4', 'two.mp4', sha(body)]]);
  assert.deepEqual(dx.opsRecent().map((o) => [o.op, o.state]), [['link', 'done']]);
  // The app holds the original; Grabbit holds the record and can ask it back.
  const list = svc.trashList({ adult: 'show' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].source, 'app');
  assert.equal(list.items[0].preview, false);
  const rr = await svc.trashRestore([list.items[0].id]);
  assert.equal(rr.done.length, 1);
  assert.deepEqual(ad.calls[1], ['restore', `101:${'101'.padStart(32, '0')}`], 'the ref carries the uid');
  assert.equal(svc.trashList({ adult: 'show' }).total, 0);
  const again = await svc.trashRestore([list.items[0].id]);
  assert.match(again.refused[0].error, /Not in the trash/);
  guard.undo();
  assert.deepEqual(guard.offences, []);
  assert.deepEqual(snapshot(tik), before);
});

test('an adapter that is not ready or refuses leaves the app copy and records nothing in app trash', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  const { tik, svc, scan, dx } = ctx;
  const body = 'tik twin 2';
  write(path.join(tik, 'one.mp4'), body, 1000);
  write(path.join(tik, 'two.mp4'), body, 2000);
  await scan();
  const notReady = stubAdapter({ ready: () => ({ ok: false, why: 'TikShortis is not connected', fix: 'Set the URL.' }) });
  adapters.set(tik, notReady);
  svc.invalidate();
  let m = byName(exactGroup(svc, body));
  assert.equal(m['two.mp4'].action, null);
  assert.equal(m['two.mp4'].why, 'TikShortis is not connected');
  assert.equal(m['two.mp4'].fix, 'Set the URL.');
  let r = await svc.act(exactGroup(svc, body).key, 'trash_extras');
  assert.deepEqual(r.done, []);
  assert.deepEqual(notReady.calls, []);
  const refusing = stubAdapter({ link: () => { throw new AdapterError('TikShortis refused', { fix: 'Check the app.' }); } });
  adapters.set(tik, refusing);
  svc.invalidate();
  m = byName(exactGroup(svc, body));
  assert.equal(m['two.mp4'].action, 'link');
  r = await svc.act(exactGroup(svc, body).key, 'merge');
  assert.deepEqual(r.done, []);
  assert.equal(r.refused[0].error, 'TikShortis refused');
  assert.equal(r.refused[0].fix, 'Check the app.');
  assert.deepEqual(dx.appTrashHeld(), []);
  assert.deepEqual(dx.opsRecent().map((o) => o.state), ['failed']);
  // An app that stops answering half way may have done the link: the journal
  // row stays pending and the trash page lists it until the owner checked it.
  let clock = 1_000_000;
  svc.now = () => clock;
  const stalled = stubAdapter({ link: () => { throw new AdapterError('TikShortis stopped answering half way', { status: 424, stalled: true }); } });
  adapters.set(tik, stalled);
  svc.invalidate();
  r = await svc.act(exactGroup(svc, body).key, 'merge');
  assert.match(r.refused[0].error, /half way/);
  assert.deepEqual(dx.opsRecent().map((o) => o.state), ['pending', 'failed']);
  assert.deepEqual(svc.trashList().unfinished, [], 'a call that may still be running is not listed');
  clock += 3 * 60 * 1000;
  const [u] = svc.trashList().unfinished;
  assert.equal(u.app, 'TikShortis');
  assert.equal(u.what, 'Share two.mp4 with one.mp4');
  assert.match(u.check, /Open two\.mp4 in TikShortis/);
  assert.deepEqual(svc.opChecked(u.id, 'owner'), { checked: u.id });
  assert.deepEqual(svc.trashList().unfinished, []);
  assert.throws(() => svc.opChecked(u.id, 'owner'), (e) => e.status === 404);
  assert.deepEqual(dx.appTrashHeld(), []);
  assert.ok(fs.existsSync(path.join(tik, 'two.mp4')));
  // Round 5: an app that says it may have merged names its held entry; the
  // pending row keeps that reference for the owner's check.
  const ref = `9:${'c'.repeat(32)}`;
  adapters.set(tik, stubAdapter({ link: () => { throw new AdapterError('Merged, but not confirmed on disk', { status: 424, stalled: true, appRef: ref }); } }));
  svc.invalidate();
  await svc.act(exactGroup(svc, body).key, 'merge');
  clock += 3 * 60 * 1000;
  const [u2] = svc.trashList().unfinished;
  assert.equal(u2.appRef, ref);
  assert.ok(u2.check.includes(`held entry ${ref}`));
});

test('a copy in an app import folder is never moved by Grabbit, even when the library already has it', async (t) => {
  const { own, imp, lib, svc, scan } = setup(t);
  const body = 'imported bytes';
  write(path.join(imp, 'new.mp4'), body, 1000);
  write(path.join(lib, 'creator', 'post.mp4'), body, 2000);
  const other = 'waiting bytes';
  write(path.join(imp, 'waiting.mp4'), other, 1000);
  write(path.join(own, 'waiting.mp4'), other, 2000);
  await scan();
  const before = { imp: snapshot(imp), lib: snapshot(lib) };
  const guard = guardWrites(t, [imp, lib]);
  const spent = byName(exactGroup(svc, body));
  assert.equal(spent['new.mp4'].action, null);
  assert.match(spent['new.mp4'].why, /import folder/);
  assert.ok(spent['new.mp4'].fix);
  const waiting = byName(exactGroup(svc, other));
  assert.equal(waiting['waiting.mp4'] && waiting['waiting.mp4'].action, null);
  const sel = await svc.batch({ filter: { tab: 'identical' }, action: 'trash_extras', dryRun: true });
  const b = await svc.batch({ keys: sel.keys, action: 'trash_extras', dryRun: false, expect: { files: sel.files } });
  assert.equal(b.done, 0);
  for (const g of [exactGroup(svc, body), exactGroup(svc, other)]) {
    const ids = g.members.map((x) => x.id);
    const r = await svc.act(g.key, 'keep_selected', { keep: [ids[ids.length - 1]] });
    assert.deepEqual(r.done, []);
  }
  guard.undo();
  assert.deepEqual(guard.offences, []);
  assert.deepEqual({ imp: snapshot(imp), lib: snapshot(lib) }, before);
  assert.ok(fs.existsSync(path.join(own, 'waiting.mp4')), 'the only lasting copy stays');
});

test('an 18+ Grabbit copy is never merged into a general app copy', async (t) => {
  const { adult, tik, svc, scan } = setup(t);
  const body = 'adult and app';
  write(path.join(tik, 'clip.mp4'), body, 1000);
  write(path.join(adult, 'clip.mp4'), body, 2000);
  await scan();
  const g = exactGroup(svc, body);
  const m = g.members.find((x) => x.audience === 'adult');
  assert.equal(m.action, null);
  assert.match(m.why, /18\+ copy is never merged/);
  assert.equal(g.crossesAudience, true);
  // Hidden by default.
  const hidden = svc.list({ tab: 'identical', status: 'all' });
  assert.equal(hidden.total, 0);
  assert.equal(hidden.hiddenAdult, 1);
  assert.equal((await svc.act(g.key, 'trash_extras')).done.length, 0);
  assert.ok(fs.existsSync(path.join(adult, 'clip.mp4')));
});

// --- hard links -----------------------------------------------------------------

test('two names of one inode are one stored copy and never offered for deletion as a duplicate of themselves', async (t) => {
  const { own, svc, scan, trash } = setup(t);
  const body = 'stored once';
  write(path.join(own, 'a.mp4'), body, 1000);
  fs.linkSync(path.join(own, 'a.mp4'), path.join(own, 'a-again.mp4'));
  await scan();
  const g = exactGroup(svc, body);
  assert.equal(g.files, 2);
  assert.equal(g.stored, Buffer.byteLength(body), 'one inode, one stored copy');
  assert.equal(g.reclaim, 0);
  assert.equal(g.deletable, false);
  const other = g.members.find((x) => !x.recommended);
  assert.equal(other.action, null);
  assert.match(other.why, /Already stored once/);
  const dry = await svc.batch({ keys: [g.key], action: 'trash_extras', dryRun: true });
  assert.equal(dry.files, 0);
  assert.equal(dry.bytes, 0);
  assert.deepEqual(dry.blocked, [], 'a hard link is not reported as blocked');
  assert.deepEqual((await svc.act(g.key, 'trash_extras')).done, []);
  const ks = await svc.act(g.key, 'keep_selected', { keep: [other.id] });
  assert.deepEqual(ks.done, []);
  await assert.rejects(trash.mergeLocal(other.id, g.keepId), /Already stored once/);
  assert.ok(fs.existsSync(path.join(own, 'a.mp4')));
  assert.ok(fs.existsSync(path.join(own, 'a-again.mp4')));
  assert.equal(svc.overview().identical.duplicateBytes, 0);
});

test('two hard-linked names count as one copy towards the space a removal frees', {
}, async (t) => {
  const { own, svc, scan } = setup(t);
  const body = 'twice linked, once copied';
  const n = Buffer.byteLength(body);
  write(path.join(own, 'keep.mp4'), body, 1000);
  write(path.join(own, 'x.mp4'), body, 5000);
  fs.linkSync(path.join(own, 'x.mp4'), path.join(own, 'y.mp4'));
  await scan();
  const g = exactGroup(svc, body);
  assert.equal(g.members.find((x) => x.recommended).name, 'keep.mp4');
  assert.equal(g.stored, 2 * n);
  const dry = await svc.batch({ keys: [g.key], action: 'trash_extras', dryRun: true });
  assert.equal(dry.files, 2);
  // Both names go, but they free one stored copy, not two.
  assert.equal(g.reclaim, n);
  assert.equal(dry.bytes, n);
});

// --- keep choice, tabs, review states --------------------------------------------

test('groups, tabs and review states', async (t) => {
  const { own, svc, scan, s } = setup(t);
  write(path.join(own, 'v1.mp4'), 'video bytes', 2000);
  write(path.join(own, 'v2.mp4'), 'video bytes', 1000);
  write(path.join(own, 'thumbs', 't1.jpg'), 'thumb bytes');
  write(path.join(own, 'thumbs', 't2.jpg'), 'thumb bytes');
  write(path.join(own, 'solo.mp4'), 'unique');
  await scan();
  const ident = svc.list({ tab: 'identical' });
  assert.equal(ident.total, 1);
  const g = ident.items[0];
  assert.equal(g.key, `exact:${sha('video bytes')}`);
  assert.equal(g.members.find((m) => m.recommended).name, 'v2.mp4', 'the oldest copy is kept');
  assert.equal(svc.list({ tab: 'cache' }).total, 1, 'two identical thumbnails sit in the cache tab');
  assert.equal(svc.list({ tab: 'bogus' }).tab, 'identical');
  await assert.rejects(svc.act(g.key, 'nonsense'), DupeError);
  await assert.rejects(svc.act('exact:nope', 'ignore'), (e) => e.status === 404);
  await assert.rejects(svc.act(g.key, 'keep_selected', { keep: [] }), /at least one/);
  await assert.rejects(svc.act(g.key, 'keep_selected', { keep: [99999] }), /not in this group/);
  assert.deepEqual(await svc.act(g.key, 'ignore'), { ok: true, status: 'ignored' });
  assert.equal(svc.list({ tab: 'identical' }).total, 0);
  assert.equal(svc.list({ tab: 'identical', status: 'ignored' }).total, 1);
  await svc.act(g.key, 'reopen');
  assert.equal(svc.list({ tab: 'identical' }).total, 1);
  // Keep both on an exact group acknowledges it in items.db for exactly these members.
  await svc.act(g.key, 'keep_both');
  assert.equal(svc.findGroup(g.key).status, 'known');
  assert.equal(s.dupeGroups({ state: 'acked' }).total, 1);
  await svc.act(g.key, 'reopen');
  assert.equal(s.dupeGroups({ state: 'acked' }).total, 0);
  assert.equal(svc.findGroup(g.key).status, 'open');
  // One destructive operation at a time.
  svc.busy = 'something';
  await assert.rejects(svc.act(g.key, 'trash_extras'), (e) => e.status === 409);
  svc.busy = null;
  // A batch summary that no longer matches is refused and moves nothing.
  await assert.rejects(svc.batch({ keys: [g.key], action: 'trash_extras', dryRun: false, expect: { files: 5 } }), (e) => e.status === 409);
  assert.ok(fs.existsSync(path.join(own, 'v1.mp4')));
});

// --- trash ------------------------------------------------------------------------

test('trash: extras move, the kept copy stays, restore works, nothing is deleted unless asked', async (t) => {
  const { own, svc, scan, trash, trashDir, s } = setup(t);
  const body = 'three copies';
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  write(path.join(own, 'sub', 'c.mp4'), body, 3000);
  await scan();
  const g = exactGroup(svc, body);
  const keepIno = ino(path.join(own, 'a.mp4'));
  const r = await svc.act(g.key, 'trash_extras', { by: 'owner' });
  assert.equal(r.done.length, 2);
  assert.equal(fs.readFileSync(path.join(own, 'a.mp4'), 'utf8'), body);
  assert.equal(ino(path.join(own, 'a.mp4')), keepIno);
  assert.ok(!fs.existsSync(path.join(own, 'b.mp4')));
  assert.ok(!fs.existsSync(path.join(own, 'sub', 'c.mp4')));
  assert.equal(fs.readdirSync(trashDir).length, 2);
  const list = svc.trashList();
  assert.equal(list.total, 2);
  assert.ok(list.items.every((x) => x.reason === 'Identical copy' && x.source === 'grabbit'));
  // The hourly purge with the default hold deletes nothing fresh.
  assert.equal(await trash.purge(), 0);
  assert.equal(await svc.purgeAppTrash(), 0);
  assert.equal(await svc.purgeGrabbitTrash(), 0);
  assert.equal(fs.readdirSync(trashDir).length, 2);
  // Restore puts the copy back at its own name.
  const cEntry = list.items.find((x) => x.name === 'c.mp4');
  const rr = await svc.trashRestore([cEntry.id], 'owner');
  assert.deepEqual(rr.done.map((x) => x.rel), [path.join('sub', 'c.mp4')]);
  assert.equal(fs.readFileSync(path.join(own, 'sub', 'c.mp4'), 'utf8'), body);
  assert.equal(svc.trashList().total, 1);
  // Emptying with a stale confirmation deletes nothing.
  await assert.rejects(svc.trashEmpty({ files: 2, bytes: 0 }), (e) => e.status === 409);
  assert.equal(fs.readdirSync(trashDir).length, 1);
  await assert.rejects(svc.trashRestore(['x1']).then((o) => { if (o.refused.length) throw new Error(o.refused[0].error); }), /Not a trash entry/);
  // Deleted for good only when asked.
  const left = svc.trashList().items[0];
  const del = await svc.trashDelete([left.id], 'owner');
  assert.equal(del.done, 1);
  assert.equal(del.bytes, Buffer.byteLength(body));
  assert.deepEqual(fs.readdirSync(trashDir), []);
  assert.equal(svc.trashList().total, 0);
  assert.ok(fs.existsSync(path.join(own, 'a.mp4')));
  assert.equal(s.raw.pragma('main.user_version', { simple: true }), itemStore.SCHEMA_VERSION);
});

test('restore never overwrites a newer file in the copy\'s place', async (t) => {
  const { own, svc, scan } = setup(t);
  const body = 'restore beside';
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  await scan();
  await svc.act(exactGroup(svc, body).key, 'trash_extras');
  write(path.join(own, 'b.mp4'), 'a newer file');
  const id = svc.trashList().items[0].id;
  const r = await svc.trashRestore([id]);
  assert.equal(r.done[0].renamed, true);
  assert.equal(fs.readFileSync(path.join(own, 'b.mp4'), 'utf8'), 'a newer file');
  assert.equal(fs.readFileSync(path.join(own, 'b (restored).mp4'), 'utf8'), body);
});

// --- merge ---------------------------------------------------------------------------

test('merge stores two item-linked copies once, keeps both names working, and can be undone', async (t) => {
  const { own, svc, scan, s, trashDir } = setup(t);
  const body = 'linked twice';
  s.upsert({ key: 'id:x:1', filename: 'a.mp4', creator: 'ann' });
  s.upsert({ key: 'id:x:2', filename: 'b.mp4', creator: 'bob' });
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  await scan();
  const g = exactGroup(svc, body);
  const m = byName(g);
  assert.equal(m['a.mp4'].recommended, true);
  assert.equal(m['b.mp4'].action, 'merge', 'each is the only copy of its item, so it is merged, not trashed');
  const origB = ino(path.join(own, 'b.mp4'));
  const r = await svc.act(g.key, 'merge', { by: 'owner' });
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].merged, true);
  assert.equal(ino(path.join(own, 'b.mp4')), ino(path.join(own, 'a.mp4')), 'one stored file, two names');
  assert.equal(fs.readFileSync(path.join(own, 'b.mp4'), 'utf8'), body);
  const entry = svc.trashList().items[0];
  assert.equal(entry.merged, true);
  assert.equal(ino(path.join(trashDir, fs.readdirSync(trashDir)[0])), origB, 'the original waits in the trash');
  // A new scan sees one stored copy.
  await scan();
  const after = exactGroup(svc, body);
  assert.equal(after.stored, Buffer.byteLength(body));
  assert.match(byName(after)['b.mp4'].why, /Already stored once/);
  // Undo: the link goes and the original comes back under its own name.
  const rr = await svc.trashRestore([entry.id]);
  assert.equal(rr.done[0].renamed, false);
  assert.equal(ino(path.join(own, 'b.mp4')), origB);
  assert.notEqual(ino(path.join(own, 'a.mp4')), origB);
  assert.equal(fs.readFileSync(path.join(own, 'a.mp4'), 'utf8'), body);
});

test('restoring a merge checks the folder before it changes anything: a symlinked folder keeps its file', async (t) => {
  const { own, svc, scan, s } = setup(t);
  const body = 'merged under a folder';
  s.upsert({ key: 'id:x:11', filename: 'a.mp4', creator: 'ann' });
  s.upsert({ key: 'id:x:12', filename: 'b.mp4', creator: 'bob' });
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'sub', 'b.mp4'), body, 2000);
  await scan();
  const g = exactGroup(svc, body);
  const r = await svc.act(g.key, 'merge', { by: 'owner' });
  assert.equal(r.done.length, 1);
  const entry = svc.trashList().items[0];
  // The folder is swapped for a symlink to a folder holding the same link.
  fs.renameSync(path.join(own, 'sub'), path.join(own, 'sub-real'));
  fs.symlinkSync(path.join(own, 'sub-real'), path.join(own, 'sub'));
  const rr = await svc.trashRestore([entry.id]);
  assert.equal(rr.done.length, 0);
  assert.match(rr.refused[0].error, /symlink/);
  assert.equal(ino(path.join(own, 'sub-real', 'b.mp4')), ino(path.join(own, 'a.mp4')), 'the link behind the symlink is untouched');
  assert.equal(svc.trashList().total, 1, 'the original still waits in the trash');
});

test('merge refuses a kept copy outside Grabbit\'s folders', async (t) => {
  const { own, tik, svc, scan, trash } = setup(t);
  const body = 'merge across';
  write(path.join(tik, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  await scan();
  const m = byName(exactGroup(svc, body));
  await assert.rejects(trash.mergeLocal(m['b.mp4'].id, m['a.mp4'].id), /TikShortis owns/);
  assert.ok(fs.existsSync(path.join(own, 'b.mp4')));
});

// --- similar matches -------------------------------------------------------------------

test('similar photo matches are review-only: no action or batch removes them for the owner', async (t) => {
  const { own, tik, svc, scan, dx } = setup(t);
  write(path.join(own, 'p1.jpg'), 'picture one', 1000);
  write(path.join(own, 'p2.jpg'), 'picture two', 2000);
  write(path.join(tik, 'p3.mp4'), 'clip three', 1000);
  write(path.join(own, 'p4.mp4'), 'clip four', 2000);
  await scan();
  dx.replaceGroups('photo', [{ match: 'similar', score: 0.93, members: [{ sha256: sha('picture one'), score: 1 }, { sha256: sha('picture two'), score: 0.93 }] }]);
  dx.replaceGroups('video', [{ match: 'reencoded', score: 0.9, members: [{ sha256: sha('clip three'), score: 1 }, { sha256: sha('clip four'), score: 0.9 }] }]);
  svc.invalidate();
  const before = { own: snapshot(own), tik: snapshot(tik) };
  const photos = svc.list({ tab: 'photos' });
  assert.equal(photos.total, 1);
  const g = photos.items[0];
  for (const m of g.members) assert.equal(m.suggested, false, 'a near match is never chosen for the owner');
  const videos = svc.list({ tab: 'videos' }).items[0];
  assert.equal(videos.members.find((m) => m.owner === 'app').action, null);
  await assert.rejects(svc.act(g.key, 'trash_extras'), /never removed for you/);
  await assert.rejects(svc.act(g.key, 'merge'), /never removed for you/);
  for (const filter of [{ tab: 'photos' }, { tab: 'videos' }]) {
    const dry = await svc.batch({ filter, action: 'trash_extras', dryRun: true });
    assert.equal(dry.files, 0);
    assert.equal(dry.similarSkipped, 1);
    const real = await svc.batch({ keys: dry.keys, action: 'trash_extras', dryRun: false, expect: { files: dry.files } });
    assert.equal(real.done, 0);
  }
  const all = await svc.batch({ keys: [g.key, videos.key], action: 'trash_extras', dryRun: false, expect: { files: 0 } });
  assert.equal(all.done, 0);
  assert.deepEqual({ own: snapshot(own), tik: snapshot(tik) }, before);
  // Keep both records the pair as different, so it is not offered again.
  await svc.act(g.key, 'keep_both');
  assert.equal(dx.decision(sha('picture one'), sha('picture two')), 'different');
  await svc.act(g.key, 'reopen');
  assert.equal(dx.decision(sha('picture one'), sha('picture two')), null);
  // Only the owner's explicit choice moves a similar copy, and only to the trash.
  const keep = g.members.find((m) => m.recommended);
  const r = await svc.act(g.key, 'keep_selected', { keep: [keep.id] });
  assert.equal(r.done.length, 1);
  const entry = svc.trashList().items[0];
  assert.match(entry.reason, /Similar photo/);
  await svc.trashRestore([entry.id]);
  assert.ok(fs.existsSync(path.join(own, 'p1.jpg')) && fs.existsSync(path.join(own, 'p2.jpg')));
});

// --- prevention ------------------------------------------------------------------------

test('prevention reviews a finished download\'s duplicate and never marks the job downloaded', async (t) => {
  const { own, svc, scan, s, dx } = setup(t);
  const body = 'already here';
  write(path.join(own, 'old.mp4'), body, 1000);
  await scan();
  const abs = path.join(own, 'new.mp4');
  write(abs, body);
  const items = s.counts().items;
  const job = { id: 'job-1', status: 'failed', saved: false, error: 'boom', savedPaths: [abs] };
  const frozen = JSON.parse(JSON.stringify(job));
  const seen = [];
  svc.onJobDuplicate = (j, hit) => seen.push([j, hit]);
  const findings = await svc.checkSaved(job);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].match, 'exact');
  assert.equal(findings[0].action, 'review');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], job);
  assert.deepEqual(job, frozen, 'the job keeps its failed status and is not marked saved');
  assert.equal(s.counts().items, items, 'no item is recorded as downloaded');
  assert.equal(s.getByFilename('new.mp4'), null);
  assert.ok(fs.existsSync(abs), 'review leaves the new file alone');
  const log = dx.preventionForJob('job-1');
  assert.equal(log.length, 1);
  assert.equal(log[0].other_rel, 'old.mp4');
  // A file with no twin is no finding; prevention switched off checks nothing.
  write(path.join(own, 'fresh.mp4'), 'brand new');
  assert.deepEqual(await svc.checkSaved({ id: 'job-2', savedPaths: [path.join(own, 'fresh.mp4')] }), []);
  svc.setCfg({ prevention: { enabled: false } });
  assert.equal(await svc.checkSaved(job), null);
});

test('prevention skip moves a new Grabbit copy to the trash (restorable) and keeps the existing one', async (t) => {
  const { own, svc, scan, trashDir } = setup(t);
  const body = 'skip me';
  write(path.join(own, 'old.mp4'), body, 1000);
  await scan();
  svc.setCfg({ prevention: { exact: 'skip' } });
  const abs = path.join(own, 'dl', 'new.mp4');
  write(abs, body);
  // While the owner's restore or delete holds the lock, the new copy stays.
  svc.busy = 'restore';
  const [held] = await svc.checkSaved({ id: 'j0', status: 'done', savedPaths: [abs] });
  svc.busy = null;
  assert.equal(held.action, 'review');
  assert.match(held.detail, /another duplicate operation/);
  assert.ok(fs.existsSync(abs));
  const [hit] = await svc.checkSaved({ id: 'j', status: 'done', savedPaths: [abs] });
  assert.equal(hit.action, 'skip');
  assert.ok(!fs.existsSync(abs));
  assert.equal(fs.readFileSync(path.join(own, 'old.mp4'), 'utf8'), body);
  assert.equal(fs.readdirSync(trashDir).length, 1);
  const entry = svc.trashList().items[0];
  await svc.trashRestore([entry.id]);
  assert.equal(fs.readFileSync(abs, 'utf8'), body);
});

test('prevention link stores a new Grabbit copy once, with the existing file', async (t) => {
  const { own, svc, scan } = setup(t);
  const body = 'link me';
  write(path.join(own, 'old.mp4'), body, 1000);
  await scan();
  svc.setCfg({ prevention: { exact: 'link' } });
  const abs = path.join(own, 'new.mp4');
  write(abs, body);
  const [hit] = await svc.checkSaved({ id: 'j', savedPaths: [abs] });
  assert.equal(hit.action, 'link');
  assert.equal(ino(abs), ino(path.join(own, 'old.mp4')));
  assert.deepEqual(fs.readdirSync(own).sort(), ['new.mp4', 'old.mp4'], 'no temp file left behind');
});

// Round 8: the stage is hashed asynchronously; a file put at the stage name
// meanwhile is never renamed over the download, and is not removed either.
test('prevention link refuses a stage replaced while it is hashed', async (t) => {
  const { own, svc, scan } = setup(t);
  const body = 'link me too';
  write(path.join(own, 'old.mp4'), body, 1000);
  await scan();
  svc.setCfg({ prevention: { exact: 'link' } });
  const abs = path.join(own, 'new.mp4');
  write(abs, body);
  const before = ino(abs);
  const crs = fs.createReadStream;
  let intruder = null;
  fs.createReadStream = (p, ...rest) => {
    const rs = crs(p, ...rest);
    if (String(p).includes('.dedupe-') && !intruder) {
      rs.on('open', () => { fs.writeFileSync(`${p}.x`, body); fs.renameSync(`${p}.x`, p); intruder = String(p); });
    }
    return rs;
  };
  let hit;
  try {
    [hit] = await svc.checkSaved({ id: 'j', savedPaths: [abs] });
  } finally {
    fs.createReadStream = crs;
  }
  assert.ok(intruder, 'the stage was replaced during the hash');
  assert.equal(hit.action, 'review');
  assert.match(hit.detail, /changed while it was checked/);
  assert.equal(ino(abs), before, 'the download is untouched');
  assert.ok(fs.existsSync(intruder), "the stage name now holds someone else's file, which stays");
  fs.unlinkSync(intruder);
});

test('prevention never skips or links a new file in an app folder: it is a post of its own', async (t) => {
  const { own, tik, svc, scan, trashDir } = setup(t);
  const body = 'app post';
  write(path.join(own, 'old.mp4'), body, 1000);
  await scan();
  for (const exact of ['skip', 'link']) {
    svc.setCfg({ prevention: { exact, perApp: { TikShortis: { exact } } } });
    const abs = path.join(tik, `new-${exact}.mp4`);
    write(abs, body);
    const before = snapshot(tik);
    const [hit] = await svc.checkSaved({ id: `j-${exact}`, savedPaths: [abs] });
    assert.equal(hit.action, 'review');
    assert.match(hit.detail, /post of its own/);
    assert.deepEqual(snapshot(tik), before);
  }
  assert.ok(!fs.existsSync(trashDir) || fs.readdirSync(trashDir).length === 0);
});

// --- cache ------------------------------------------------------------------------------

test('cache report: generated files per app, duplicate thumbnails, and what the apps report', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  const { own, tik, lib, svc, scan, dx } = ctx;
  write(path.join(own, 'thumbs', 'a.jpg'), 'thumb');
  write(path.join(own, 'thumbs', 'b.jpg'), 'thumb');
  write(path.join(tik, 'poster.jpg'), 'poster');
  write(path.join(own, 'media.mp4'), 'real media');
  const egram = stubAdapter({ id: 'egram', app: 'egram', caps: ['lookup', 'cache'], cache: () => ({ files: 7, bytes: 70 }) });
  const broken = stubAdapter({ id: 'other', app: 'Other', caps: ['cache'], cache: () => { throw new AdapterError('Other is not reachable right now', { fix: 'Start it.' }); } });
  adapters.set(lib, egram);
  adapters.set(path.join(ctx.dir, 'elsewhere'), broken);
  await scan();
  await scan();
  const r = await svc.cacheReport();
  const kinds = Object.fromEntries(r.kinds.map((k) => [`${k.app}|${k.what}`, k]));
  assert.equal(kinds['Grabbit library|thumbnail'].files, 2);
  assert.equal(kinds['TikShortis|poster'].files, 1);
  assert.equal(r.files, 3);
  assert.equal(r.bytes, 2 * 'thumb'.length + 'poster'.length);
  assert.equal(r.duplicateGroups, 1);
  assert.equal(r.duplicateFiles, 1);
  assert.equal(r.duplicateBytes, 'thumb'.length);
  const apps = Object.fromEntries(r.apps.map((a) => [a.id, a]));
  assert.deepEqual({ ok: apps.egram.ok, files: apps.egram.files }, { ok: true, files: 7 });
  assert.equal(apps.other.ok, false);
  assert.equal(apps.other.fix, 'Start it.');
  const ov = svc.overview();
  assert.equal(ov.cache.files, 3);
  assert.equal(ov.cache.duplicateGroups, 1);
  assert.equal(ov.identical.groups, 0, 'thumbnails are not identical media copies');
  // Cache actions run in the app, never on Grabbit's side.
  await assert.rejects(svc.cacheAction('nope', 'clean', true), (e) => e.status === 404);
  await assert.rejects(svc.cacheAction('egram', 'wipe', true), /Unknown cache action/);
  assert.deepEqual(await svc.cacheAction('egram', 'clean', true), { removed: 0, dryRun: true });
  assert.deepEqual(dx.opsRecent(), [], 'a dry run is not journalled');
  await svc.cacheAction('egram', 'clean', false, 'owner');
  await svc.cacheAction('egram', 'rebuild', false, 'owner');
  assert.deepEqual(dx.opsRecent().map((o) => [o.op, o.state]), [['cache-rebuild', 'done'], ['cache-clean', 'done']]);
  assert.deepEqual(egram.calls.filter((c) => c[0] !== 'cache').map((c) => c[0]), ['cacheClean', 'cacheClean', 'call']);
});

// --- references ---------------------------------------------------------------------------

test('references ask each app about its own copies only, and report a failing app per copy', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  const { own, tik, lib, svc, scan } = ctx;
  const body = 'referenced clip';
  write(path.join(own, 'g.mp4'), body, 1000);
  write(path.join(tik, 'creator', 't.mp4'), body, 2000);
  write(path.join(lib, 'e.mp4'), body, 3000);
  const tikAd = stubAdapter({
    lookup: (rels) => new Map(rels.map((r) => [r, { path: r, role: 'post', refs: [{ type: 'post', id: 5, label: 'A post' }] }])),
  });
  const egramAd = stubAdapter({ id: 'egram', app: 'egram', caps: ['lookup', 'cache'], lookup: () => { throw new AdapterError('egram is not reachable right now'); } });
  adapters.set(tik, tikAd);
  adapters.set(lib, egramAd);
  await scan();
  const g = exactGroup(svc, body);
  const m = byName(g);
  const refs = await svc.references(g.key);
  assert.equal(refs[m['g.mp4'].id], undefined, 'Grabbit\'s own copy is not an app question');
  assert.deepEqual(refs[m['t.mp4'].id].refs, [{ type: 'post', id: 5, label: 'A post' }]);
  assert.equal(refs[m['t.mp4'].id].app, 'TikShortis');
  assert.equal(refs[m['e.mp4'].id].error, 'egram is not reachable right now');
  assert.deepEqual(tikAd.calls, [['lookup', [path.join('creator', 't.mp4')]]]);
});

// --- settings ---------------------------------------------------------------------------------

test('the trash defaults to manual cleanup, and a time limit needs its own confirmation', async (t) => {
  const { svc } = setup(t);
  assert.equal(svc.cfg().trashRetentionDays, 0);
  assert.equal(await svc.purgeGrabbitTrash(), 0);
  assert.equal(await svc.purgeAppTrash(), 0);
  assert.throws(() => svc.setCfg({ trashRetentionDays: 90 }), (e) => e.status === 409 && /deletes 0 held copies/.test(e.message));
  assert.equal(svc.cfg().trashRetentionDays, 0, 'nothing saved');
  assert.equal(svc.setCfg({ trashRetentionDays: 30 }, 'owner', { confirmRetention: true }).trashRetentionDays, 30);
  assert.equal(svc.setCfg({ trashRetentionDays: 60 }).trashRetentionDays, 60, 'longer needs no confirmation');
  assert.throws(() => svc.setCfg({ trashRetentionDays: 7 }), /Confirm the shorter time/);
  svc.trashEntries = () => [{ at: 0, bytes: 3 * 1024 * 1024 }, { at: 0, bytes: 1024 * 1024 }, { at: svc.now(), bytes: 1 }];
  assert.throws(() => svc.setCfg({ trashRetentionDays: 14 }), /deletes 2 held copies \(4\.0 MB\) within the hour/);
  delete svc.trashEntries;
  assert.equal(svc.setCfg({ trashRetentionDays: 0 }).trashRetentionDays, 0, 'back to manual needs none');
});

test('settings are sanitised and stored in items.db settings, not as a schema change', async (t) => {
  const { svc, s } = setup(t);
  const next = svc.setCfg({ trashRetentionDays: 3, defaultRule: 'bogus', prevention: { exact: 'explode', perceptual: 'delete' } });
  assert.equal(next.trashRetentionDays, 0, 'an unknown hold time falls back to manual cleanup');
  assert.equal(next.defaultRule, 'recommended');
  assert.equal(next.prevention.exact, 'review');
  assert.equal(next.prevention.perceptual, 'review', 'a perceptual match only ever goes to review');
  assert.deepEqual(svc.cfg(), next);
  assert.equal(s.raw.pragma('main.user_version', { simple: true }), itemStore.SCHEMA_VERSION);
});

test('empty trash deletes only the exact entries the owner saw, not another set of the same count and size', async (t) => {
  const { own, svc, scan, trashDir } = setup(t);
  const body = 'same size';
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  write(path.join(own, 'c.mp4'), body, 3000);
  await scan();
  await svc.act(exactGroup(svc, body).key, 'trash_extras', { by: 'owner' });
  const seen = svc.trashSummary();
  assert.equal(seen.files, 2);
  assert.match(seen.fingerprint, /^[0-9a-f]{32}$/);
  // One copy comes back and goes again: same count and bytes, another entry.
  const c = svc.trashList().items.find((x) => x.name === 'c.mp4');
  await svc.trashRestore([c.id], 'owner');
  await scan();
  await svc.act(exactGroup(svc, body).key, 'trash_extras', { by: 'owner' });
  const now = svc.trashSummary();
  assert.equal(now.files, seen.files);
  assert.equal(now.bytes, seen.bytes);
  assert.notEqual(now.fingerprint, seen.fingerprint);
  await assert.rejects(svc.trashEmpty(seen, 'owner'), (e) => e.status === 409);
  await assert.rejects(svc.trashEmpty({ files: now.files, bytes: now.bytes }, 'owner'), (e) => e.status === 409, 'no fingerprint is no confirmation');
  assert.equal(fs.readdirSync(trashDir).length, 2, 'nothing was deleted');
  await svc.trashEmpty(now, 'owner');
  assert.deepEqual(fs.readdirSync(trashDir), []);
});

test('a restore that arrives while another operation holds the lock is refused with 409 and changes nothing', async (t) => {
  const { own, svc, scan } = setup(t);
  const body = 'locked restore';
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  await scan();
  await svc.act(exactGroup(svc, body).key, 'trash_extras', { by: 'owner' });
  const entry = svc.trashList().items[0];
  let release;
  const held = svc.exclusive('delete', () => new Promise((r) => { release = r; }));
  // The legacy route runs DupeTrash.restore through this same lock.
  await assert.rejects(svc.exclusive('restore', () => svc.trash.restore(Number(entry.id.replace(/^\D+/, '')))), (e) => e.status === 409 && /Another operation is running \(delete\)/.test(e.message));
  await assert.rejects(svc.trashRestore([entry.id], 'owner'), (e) => e.status === 409);
  release();
  await held;
  assert.ok(!fs.existsSync(path.join(own, 'b.mp4')), 'nothing came back while locked');
  const rr = await svc.trashRestore([entry.id], 'owner');
  assert.equal(rr.done.length, 1);
  assert.ok(fs.existsSync(path.join(own, 'b.mp4')));
});

test('the batch summary counts only copies that move to the trash; merges and app links are listed apart', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  const ad = stubAdapter();
  adapters.set(ctx.tik, ad);
  const { own, tik, svc, scan } = ctx;
  const body = 'one grabbit, two tik';
  write(path.join(tik, 'one.mp4'), body, 1000);
  write(path.join(tik, 'two.mp4'), body, 2000);
  write(path.join(own, 'g.mp4'), body, 3000);
  await scan();
  const g = exactGroup(svc, body);
  const m = byName(g);
  assert.equal(m['g.mp4'].action, 'trash');
  assert.equal(m['two.mp4'].action, 'link');
  const s = await svc.batch({ keys: [g.key], action: 'trash_extras', dryRun: true });
  assert.equal(s.files, 1, 'only the Grabbit copy moves');
  assert.equal(s.otherActions, 1);
  assert.deepEqual(s.apps, ['Grabbit'], 'TikShortis is not named: nothing moves there');
  const r = await svc.batch({ keys: [g.key], action: 'trash_extras', dryRun: false, expect: { files: 1 } });
  assert.equal(r.files, 1);
  assert.deepEqual(ad.calls, [], 'no app link as a side effect');
  assert.ok(!fs.existsSync(path.join(own, 'g.mp4')));
  assert.ok(fs.existsSync(path.join(tik, 'two.mp4')));
});

test('an app that answers a merge without a usable id leaves the operation pending and records nothing', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  adapters.set(ctx.tik, stubAdapter({ link: () => ({ ok: true }) }));
  const { tik, svc, scan, dx } = ctx;
  const body = 'answer without id';
  write(path.join(tik, 'one.mp4'), body, 1000);
  write(path.join(tik, 'two.mp4'), body, 2000);
  await scan();
  const r = await svc.act(exactGroup(svc, body).key, 'merge');
  assert.equal(r.done.length, 0);
  assert.match(r.refused[0].error, /without a valid entry id/);
  assert.deepEqual(dx.opsRecent().map((o) => o.state), ['pending']);
  assert.deepEqual(dx.appTrashHeld(), []);
});

test('a merged name keeps its hash and its library link without waiting for a new hash pass', async (t) => {
  const { own, svc, scan, s } = setup(t);
  const body = 'merged keeps link';
  s.upsert({ key: 'id:x:21', filename: 'a.mp4', creator: 'ann' });
  s.upsert({ key: 'id:x:22', filename: 'b.mp4', creator: 'bob' });
  write(path.join(own, 'a.mp4'), body, 1000);
  write(path.join(own, 'b.mp4'), body, 2000);
  await scan();
  const row = () => s.raw.prepare('SELECT sha256, link, item_id FROM file_hashes WHERE rel = ? AND gone_at IS NULL').get('b.mp4');
  const before = row();
  assert.equal(before.link, 'filename');
  const r = await svc.act(exactGroup(svc, body).key, 'merge', { by: 'owner' });
  assert.equal(r.done.length, 1);
  assert.deepEqual(row(), before, 'same hash and item link right after the merge');
});

// Round 7: once the app has done a change, a local write failure is not the
// app refusing. The operation stays pending with the app's reference.
test('a local write failure after the app merged or restored keeps the operation pending with its reference', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  const ad = stubAdapter();
  adapters.set(ctx.tik, ad);
  const { tik, svc, scan, dx } = ctx;
  const body = 'local write fails';
  write(path.join(tik, 'one.mp4'), body, 1000);
  write(path.join(tik, 'two.mp4'), body, 2000);
  await scan();
  const add = dx.appTrashAdd;
  dx.appTrashAdd = () => { throw new Error('database is locked'); };
  const r = await svc.act(exactGroup(svc, body).key, 'merge');
  dx.appTrashAdd = add;
  assert.equal(r.done.length, 0);
  assert.match(r.refused[0].error, /carried this out, but Grabbit could not record it/);
  const ops = dx.opsRecent();
  assert.deepEqual(ops.map((o) => o.state), ['pending'], 'never closed as failed');
  const note = JSON.parse(ops[0].result);
  assert.equal(note.appRef, `101:${'101'.padStart(32, '0')}`, 'the returned reference is kept');
  assert.equal(note.appDone, true);

  // A restore the app carried out: the trash row and the journal close
  // together, or neither does.
  const r2 = await svc.act(exactGroup(svc, body).key, 'merge');
  assert.equal(r2.done.length, 1);
  const item = svc.trashList({ adult: 'show' }).items[0];
  const done = dx.appTrashDone;
  dx.appTrashDone = () => { throw new Error('disk I/O error'); };
  const rr = await svc.trashRestore([item.id]);
  dx.appTrashDone = done;
  assert.equal(rr.done.length, 0);
  assert.match(rr.refused[0].error, /could not record it/);
  const restoreOp = dx.opsRecent().find((o) => o.op === 'restore');
  assert.equal(restoreOp.state, 'pending');
  assert.equal(JSON.parse(restoreOp.result).appDone, true);
});

test('the journal row and the trash update are written in one transaction', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  adapters.set(ctx.tik, stubAdapter());
  const { tik, svc, scan, dx } = ctx;
  const body = 'one transaction';
  write(path.join(tik, 'one.mp4'), body, 1000);
  write(path.join(tik, 'two.mp4'), body, 2000);
  await scan();
  await svc.act(exactGroup(svc, body).key, 'merge');
  const item = svc.trashList({ adult: 'show' }).items[0];
  // The journal write fails after the trash row was updated: both roll back.
  const end = dx.opEnd;
  dx.opEnd = () => { throw new Error('disk I/O error'); };
  const rr = await svc.trashRestore([item.id]);
  dx.opEnd = end;
  assert.equal(rr.done.length, 0);
  assert.equal(svc.trashList({ adult: 'show' }).total, 1, 'the trash row was rolled back with the journal');
});

test('only a cursor the app rejects as invalid is reported as bad_cursor; other rebuild failures are not', async (t) => {
  const adapters = new Map();
  const ctx = setup(t, { adapters });
  let reply = null;
  const egram = stubAdapter({ id: 'egram', app: 'egram', caps: ['lookup', 'cache'] });
  egram.call = async () => { throw reply; };
  adapters.set(ctx.lib, egram);
  const { svc } = ctx;
  await assert.rejects(svc.cacheAction('egram', 'rebuild', false, 'owner', { cursor: 'bad cursor!' }), (e) => e.code === 'bad_cursor' && e.status === 400);
  reply = new AdapterError('Invalid cursor', { status: 409 });
  await assert.rejects(svc.cacheAction('egram', 'rebuild', false, 'owner', { cursor: 'm:12' }), (e) => e.code === 'bad_cursor');
  for (const err of [
    new AdapterError('egram did not answer in time', { status: 424, stalled: true }),
    new AdapterError('egram is not reachable right now', { status: 424 }),
    new AdapterError('Another rebuild is running', { status: 409 }),
  ]) {
    reply = err;
    await assert.rejects(svc.cacheAction('egram', 'rebuild', false, 'owner', { cursor: 'm:12' }), (e) => e.code !== 'bad_cursor', err.message);
  }
});

test('a local move cut short is listed as an unfinished operation with both places', (t) => {
  const { svc, dx, own } = setup(t);
  let clock = 1_000_000;
  svc.now = () => clock;
  dx.opBegin('grabbit', 'trash', { from: 'clip.mp4', root: own, trashName: '5-1-ab-clip.mp4' }, 'owner', clock);
  const kept = dx.opBegin('grabbit', 'trash', { from: 'b.mp4', root: own, trashName: '5-2-cd-b.mp4' }, 'owner', clock);
  dx.opNote(kept, { keptCopy: '/trash/5-2-cd-b.mp4' });
  clock += 3 * 60 * 1000;
  const [a, b] = svc.trashList().unfinished;
  assert.equal(a.app, 'Grabbit');
  assert.equal(a.what, 'Move clip.mp4 to the trash');
  assert.match(a.check, /in the trash folder as 5-1-ab-clip\.mp4/);
  assert.match(b.check, /extra copy of the earlier file stays at \/trash\/5-2-cd-b\.mp4/);
});

test('a merge whose answer was lost is resolved by asking the app with its op key', async (t) => {
  const adapters = new Map();
  const { tik, svc, scan, dx } = setup(t, { adapters });
  const body = 'tik twin resolve';
  write(path.join(tik, 'one.mp4'), body, 1000);
  write(path.join(tik, 'two.mp4'), body, 2000);
  await scan();
  let clock = 1_000_000;
  svc.now = () => clock;
  let answer = null;
  const ad = stubAdapter({
    caps: ['lookup', 'link', 'opstatus'],
    link: () => { throw new AdapterError('TikShortis stopped answering half way', { status: 424, stalled: true }); },
    opStatus: (op) => answer(op),
  });
  adapters.set(tik, ad);
  svc.invalidate();
  await svc.act(exactGroup(svc, body).key, 'merge');
  assert.equal(ad.ops.length, 1);
  assert.match(ad.ops[0], /^[0-9a-f]{32}$/, 'the link call carried an op key');
  clock += 3 * 60 * 1000;
  let [u] = svc.trashList().unfinished;
  assert.equal(u.canResolve, true);
  // Still running in the app: stays pending.
  answer = (op) => ({ op, found: true, inProgress: true });
  await assert.rejects(svc.resolveOp(u.id, 'owner'), /still working/);
  assert.equal(svc.trashList().unfinished.length, 1);
  // The app stopped part way and cannot tell: no trash entry, stays pending.
  answer = (op) => ({ op, found: true, inProgress: false, id: 42, uid: 'd'.repeat(32), bytes: 16, state: 'pending', stopped: true, posts: [1] });
  await assert.rejects(svc.resolveOp(u.id, 'owner'), (e) => e.status === 409 && /stopped part way/.test(e.message));
  assert.equal(dx.appTrashHeld().length, 0, 'a stopped merge is no restorable entry');
  assert.equal(svc.trashList().unfinished.length, 1);
  // The app merged it: recorded like any merge, so it can be restored.
  const uid = 'd'.repeat(32);
  answer = (op) => ({ op, found: true, inProgress: false, id: 42, uid, bytes: 16, state: 'linked', posts: [1] });
  const r = await svc.resolveOp(u.id, 'owner');
  assert.equal(r.outcome, 'merged');
  const held = dx.appTrashHeld();
  assert.equal(held.length, 1);
  assert.equal(held[0].ref, `42:${uid}`);
  assert.equal(held[0].rel, 'two.mp4');
  assert.deepEqual(svc.trashList().unfinished, []);
  // A second merge the app never received: closed as nothing changed.
  write(path.join(tik, 'three.mp4'), body, 3000);
  await scan();
  svc.invalidate();
  await svc.act(exactGroup(svc, body).key, 'merge');
  clock += 3 * 60 * 1000;
  answer = (op) => ({ op, found: false });
  const left = svc.trashList().unfinished;
  assert.ok(left.length >= 1);
  for (const x of left) assert.equal((await svc.resolveOp(x.id, 'owner')).outcome, 'nothing changed');
  assert.deepEqual(svc.trashList().unfinished, []);
  assert.equal(dx.appTrashHeld().length, 1, 'only the merge the app reported is in the trash');
  await assert.rejects(svc.resolveOp(left[0].id, 'owner'), (e) => e.status === 404);
});

test('copies in a mixed-audience app library stay hidden as 18+ until the app reports them general', async (t) => {
  const adapters = new Map();
  const mixedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupesvc-mixed-')));
  t.after(() => fs.rmSync(mixedDir, { recursive: true, force: true }));
  const ctx = setup(t, { adapters, extra: [{ path: mixedDir, label: 'egram library', owner: 'app', app: 'egram', mixedAudience: true }] });
  const { own, svc, scan } = ctx;
  write(path.join(own, 'a.jpg'), 'adult post bytes', 1000);
  write(path.join(mixedDir, 'adult.jpg'), 'adult post bytes', 2000);
  write(path.join(own, 'b.jpg'), 'general post bytes', 1000);
  write(path.join(mixedDir, 'general.jpg'), 'general post bytes', 2000);
  let reachable = false;
  const aud = { 'adult.jpg': 'adult', 'general.jpg': 'general' };
  adapters.set(mixedDir, stubAdapter({
    id: 'egram', app: 'egram', caps: ['lookup', 'cache'],
    lookup: (rels) => {
      if (!reachable) throw new AdapterError('egram is not reachable right now');
      return new Map(rels.map((r) => [r, { path: r, role: 'media', refs: [{ type: 'post', id: 1, audience: aud[r] }] }]));
    },
  }));
  await scan();
  let clock = Date.now();
  svc.now = () => clock;
  const hidden = () => svc.list({ tab: 'identical', status: 'all', adult: 'hide', limit: 200 });
  // egram not reachable: both groups count as 18+ and stay out of the default view.
  await svc.refreshAppAudience();
  assert.equal(hidden().items.length, 0);
  assert.equal(hidden().hiddenAdult, 2);
  // egram answers: only the general one shows, the adult one stays hidden.
  reachable = true;
  svc.audRetryAt.clear(); // the one-minute pause after the failure
  await svc.refreshAppAudience();
  const shown = hidden().items;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].key, `exact:${sha('general post bytes')}`);
  assert.ok(shown[0].members.every((m) => m.preview !== false || m.kind !== 'image'));
  // A post in egram turns 18+ while the media file stays the same: once the
  // answer is a minute old the app is asked again, and the copy is hidden.
  aud['general.jpg'] = 'adult';
  clock += 30 * 1000;
  await svc.refreshAppAudience();
  assert.equal(hidden().items.length, 1, 'a fresh answer still holds');
  clock += 31 * 1000;
  await svc.refreshAppAudience();
  assert.equal(hidden().items.length, 0, 'an expired answer is asked again');
  // An expired answer the app cannot confirm counts as 18+ (fail closed).
  aud['general.jpg'] = 'general';
  clock += 61 * 1000;
  await svc.refreshAppAudience();
  assert.equal(hidden().items.length, 1);
  const gen = svc.build().groups.flatMap((g) => g.members).find((m) => m.rel === 'general.jpg');
  assert.equal(svc.audienceFor(svc.rootInfo(gen.root), { ...gen, item_audience: null }), 'general');
  reachable = false;
  clock += 61 * 1000;
  await svc.refreshAppAudience();
  assert.equal(hidden().items.length, 0);
  assert.equal(svc.audienceFor(svc.rootInfo(gen.root), { ...gen, item_audience: null }), 'adult', 'a preview of a stale answer is refused');
  svc.audRetryAt.clear();
  reachable = true;
  // A rewritten file is unverified again.
  write(path.join(mixedDir, 'general.jpg'), 'general post bytes', 5000);
  await scan();
  reachable = false;
  await svc.refreshAppAudience();
  assert.equal(hidden().items.length, 0);
  assert.ok(svc.audRetryAt.size === 1, 'a failed app is paused for a minute');
});

// A mixed-audience fixture: one group whose egram copy egram calls general.
async function mixedFixture(t) {
  const adapters = new Map();
  const mixedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupesvc-mixed-')));
  t.after(() => fs.rmSync(mixedDir, { recursive: true, force: true }));
  const ctx = setup(t, { adapters, extra: [{ path: mixedDir, label: 'egram library', owner: 'app', app: 'egram', mixedAudience: true }] });
  write(path.join(ctx.own, 'b.jpg'), 'general post bytes', 1000);
  write(path.join(mixedDir, 'general.jpg'), 'general post bytes', 2000);
  const state = { reachable: true, aud: 'general', asked: 0 };
  adapters.set(mixedDir, stubAdapter({
    id: 'egram', app: 'egram', caps: ['lookup', 'cache'],
    lookup: (rels) => {
      state.asked++;
      if (!state.reachable) throw new AdapterError('egram is not reachable right now');
      const answer = new Map(rels.map((r) => [r, { path: r, role: 'media', refs: [{ type: 'post', id: 1, audience: state.aud }] }]));
      // state.hold: the reply is decided now and delivered later.
      return state.hold ? state.hold.then(() => answer) : answer;
    },
  }));
  await ctx.scan();
  let clock = Date.now();
  ctx.svc.now = () => clock;
  const shown = () => ctx.svc.list({ tab: 'identical', status: 'all', adult: 'hide', limit: 200 }).items.length;
  return { ...ctx, state, shown, tick: (ms) => { clock += ms; } };
}

test('a cached list never outlives the general app answer it was built on', async (t) => {
  const { svc, shown, tick } = await mixedFixture(t);
  await svc.refreshAppAudience();
  assert.equal(shown(), 1);
  // The list is built again just before the answer expires...
  tick(59 * 1000);
  svc.invalidate();
  assert.equal(shown(), 1);
  // ...and is still inside its 15 s cache when the answer expires: the copy
  // counts as 18+ again, without waiting for the cache.
  tick(2 * 1000);
  assert.equal(shown(), 0, 'the cached list is not served past the answer it rests on');
});

test('every list asks the app again, and a copy it does not confirm now is 18+', async (t) => {
  const { svc, state, shown, tick } = await mixedFixture(t);
  await svc.refreshAppAudience({ fresh: true });
  assert.equal(shown(), 1);
  // The post turns 18+ in egram ten seconds later; the earlier answer is
  // still young, but the next list asks again.
  state.aud = 'adult';
  tick(10 * 1000);
  const before = state.asked;
  await svc.refreshAppAudience({ fresh: true });
  assert.equal(state.asked, before + 1, 'a verified copy is asked again for a list');
  assert.equal(shown(), 0, 'the reclassified copy is hidden at once');
  // General again, then egram goes down: the list fails closed although the
  // earlier answer is a second old.
  state.aud = 'general';
  tick(1000);
  await svc.refreshAppAudience({ fresh: true });
  assert.equal(shown(), 1);
  state.reachable = false;
  tick(1000);
  await svc.refreshAppAudience({ fresh: true });
  assert.equal(shown(), 0, 'an app that cannot answer now leaves its copies 18+');
  // In its retry pause the app is not asked, and its copies stay 18+.
  state.reachable = true;
  const asked = state.asked;
  await svc.refreshAppAudience({ fresh: true });
  assert.equal(state.asked, asked);
  assert.equal(shown(), 0);
});

test('a list counts only answers given during its request: a copy outside every group at refresh time is 18+', async (t) => {
  const { own, svc, scan, state, shown, tick } = await mixedFixture(t);
  await svc.refreshAppAudience({ fresh: true });
  assert.equal(shown(), 1);
  // The Grabbit copy goes away: the egram copy is in no group, so a fresh
  // refresh does not ask about it, and its earlier 'general' answer stays.
  const b = path.join(own, 'b.jpg');
  fs.renameSync(b, `${b}.away`);
  await scan();
  state.aud = 'adult'; // reclassified in egram meanwhile
  tick(5 * 1000);
  const asked = state.asked;
  const run = await svc.refreshAppAudience({ fresh: true });
  assert.equal(state.asked, asked, 'nothing in a group to ask about');
  // The copy comes back before the list is built.
  fs.renameSync(`${b}.away`, b);
  await scan();
  svc.invalidate();
  const list = svc.list({ tab: 'identical', status: 'all', adult: 'hide', limit: 200 }, { audRun: run });
  assert.equal(list.items.length, 0, 'an answer from before the request does not show the copy');
});

test('a list counts only the answers of the fresh run it waited for, never a late reply of an earlier run', async (t) => {
  const { own, svc, scan, state } = await mixedFixture(t);
  let release;
  state.hold = new Promise((r) => { release = r; });
  // Run A asks egram while the post is general; its reply is held.
  const a = svc.refreshAppAudience();
  await new Promise((r) => setImmediate(r));
  assert.equal(state.asked, 1);
  // The post turns 18+ and the Grabbit twin goes away (the egram copy is in
  // no group). List request B starts and waits for A.
  state.aud = 'adult';
  const b = path.join(own, 'b.jpg');
  fs.renameSync(b, `${b}.away`);
  await scan();
  const runB = svc.refreshAppAudience({ fresh: true });
  // A's general reply lands after B began.
  release();
  await a;
  state.hold = null;
  const run = await runB;
  // The twin comes back before B's list is built.
  fs.renameSync(`${b}.away`, b);
  await scan();
  svc.invalidate();
  const list = svc.list({ tab: 'identical', status: 'all', adult: 'hide', limit: 200 }, { audRun: run });
  assert.equal(list.items.length, 0, 'an answer of run A does not count for request B');
  assert.equal(svc.list({ tab: 'identical', status: 'all', adult: 'hide', limit: 200 }, { audRun: 0 }).items.length, 0, 'a failed refresh counts no answer');
});
