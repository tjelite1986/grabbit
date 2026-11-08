'use strict';
// The duplicate scan: read-only, resumable, and honest about what it can link.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const itemStore = require('../item-store');
const { DupeScanner, planRoots, mediaNames } = require('../dupe-scan');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = itemStore.open(path.join(dir, 'items.db'));
  t.after(() => s.close());
  const own = path.join(dir, 'own');
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(own, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(app, 'creator'), { recursive: true });
  return { dir, s, own, app };
}

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');

function scanner(s, roots, extra = {}) {
  const sc = new DupeScanner({ store: s, roots, mbPerSec: 1000, pauseMs: 0, log: () => {}, ...extra });
  s.setSetting('dupes.scan.state', 'running');
  return sc;
}

test('mediaNames keeps media, drops hidden and partial files and posters beside a video', () => {
  assert.deepEqual(
    mediaNames(['a.mp4', 'a.jpg', 'b.jpg', '.c.mp4', 'd.mp4.part', 'e.md', 'f.MP3', 'g.nfo', 'h.part-1.mp4']).sort(),
    ['a.mp4', 'b.jpg', 'f.MP3']
  );
});

test('planRoots drops missing, repeated, nested and excluded folders', (t) => {
  const { dir, own, app } = setup(t);
  const data = path.join(own, 'data');
  fs.mkdirSync(data);
  fs.symlinkSync(app, path.join(dir, 'app-link'));
  const roots = planRoots([
    { path: own, label: 'own' },
    { path: path.join(own, 'videos'), label: 'nested' },
    { path: app, label: 'app' },
    { path: path.join(dir, 'app-link'), label: 'same app' },
    { path: path.join(dir, 'missing'), label: 'missing' },
    { path: data, label: 'data' },
  ], [data]);
  assert.deepEqual(roots.map((r) => r.label), ['own', 'app']);
  assert.deepEqual(roots[0].excluded, [fs.realpathSync(data)]);
});

test('a pass finds exact duplicates across roots and links only unique file names', async (t) => {
  const { s, own, app } = setup(t);
  write(path.join(own, 'videos', 'ann_-_clip 1.mp4'), 'same bytes');
  write(path.join(app, 'creator', 'renamed-by-app.mp4'), 'same bytes');
  write(path.join(app, 'creator', 'other.mp4'), 'other bytes');
  write(path.join(app, 'creator', 'renamed-by-app.jpg'), 'poster, skipped');
  const item = s.upsert({ key: 'id:x:1', filename: 'ann_-_clip 1.mp4', creator: 'ann' });
  const roots = planRoots([{ path: own, label: 'Grabbit', owner: 'grabbit' }, { path: app, label: 'App', owner: 'app' }]);
  const sc = scanner(s, roots);
  assert.equal(await sc.pass(), true);
  const g = s.dupeGroups();
  assert.equal(g.total, 1);
  assert.equal(g.items[0].sha256, sha('same bytes'));
  const linked = g.items[0].members.find((m) => m.rel.endsWith('clip 1.mp4'));
  const unlinked = g.items[0].members.find((m) => m.rel.endsWith('renamed-by-app.mp4'));
  assert.equal(linked.item_id, item.id);
  assert.equal(linked.creator, 'ann');
  assert.equal(unlinked.item_id, null);
  assert.equal(unlinked.link, 'none');
  const st = sc.status();
  assert.equal(st.totals.files, 3);
  assert.equal(st.totals.hashed, 3);
});

test('the scan never writes, renames or removes anything in a scanned folder', async (t) => {
  const { s, own, app } = setup(t);
  write(path.join(app, 'creator', 'a.mp4'), 'x'.repeat(3 * 1024 * 1024));
  write(path.join(app, 'creator', 'b.mp4'), 'x'.repeat(3 * 1024 * 1024));
  const before = new Map();
  for (const f of ['a.mp4', 'b.mp4']) {
    const p = path.join(app, 'creator', f);
    const st = fs.statSync(p);
    before.set(p, `${st.size}:${st.mtimeMs}:${st.mode}:${st.ino}`);
  }
  const dirBefore = fs.readdirSync(path.join(app, 'creator')).sort();
  // Any write-capable call aimed under a scanned root fails the test.
  const roots = planRoots([{ path: own }, { path: app }]);
  const watched = roots.map((r) => r.real);
  const hit = (p) => typeof p === 'string' && watched.some((w) => p.startsWith(w));
  const names = ['writeFile', 'writeFileSync', 'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync',
    'mkdir', 'mkdirSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync', 'truncate',
    'truncateSync', 'copyFile', 'copyFileSync', 'symlink', 'symlinkSync', 'appendFile', 'appendFileSync'];
  const restore = [];
  const offences = [];
  for (const mod of [fs, fs.promises]) {
    for (const n of names) {
      if (typeof mod[n] !== 'function') continue;
      const orig = mod[n];
      mod[n] = function patched(p, ...rest) {
        if (hit(String(p))) offences.push(n);
        return orig.call(this, p, ...rest);
      };
      restore.push(() => { mod[n] = orig; });
    }
  }
  const origOpen = fs.promises.open;
  fs.promises.open = function patchedOpen(p, flags, ...rest) {
    if (hit(String(p)) && (typeof flags !== 'number' || (flags & 3) !== fs.constants.O_RDONLY)) offences.push('open for write');
    return origOpen.call(this, p, flags, ...rest);
  };
  restore.push(() => { fs.promises.open = origOpen; });
  try {
    await scanner(s, roots).pass();
  } finally {
    restore.forEach((r) => r());
  }
  assert.deepEqual(offences, []);
  assert.deepEqual(fs.readdirSync(path.join(app, 'creator')).sort(), dirBefore);
  for (const [p, sig] of before) {
    const st = fs.statSync(p);
    assert.equal(`${st.size}:${st.mtimeMs}:${st.mode}:${st.ino}`, sig);
  }
  assert.equal(s.dupeGroups().total, 1);
});

test('symlinks are never followed, as files or as folders', async (t) => {
  const { dir, s, app } = setup(t);
  const outside = path.join(dir, 'outside');
  write(path.join(outside, 'secret.mp4'), 'outside bytes');
  write(path.join(app, 'creator', 'real.mp4'), 'outside bytes');
  fs.symlinkSync(path.join(outside, 'secret.mp4'), path.join(app, 'creator', 'link.mp4'));
  fs.symlinkSync(outside, path.join(app, 'outside-dir'));
  await scanner(s, planRoots([{ path: app }])).pass();
  assert.equal(s.dupeGroups().total, 0);
  assert.equal(s.scanCounts()[0].files, 1);
});

test('pause stops the pass and a second start resumes without rereading hashed files', async (t) => {
  const { s, app } = setup(t);
  for (let i = 0; i < 5; i++) write(path.join(app, `f${i}.mp4`), `body ${i % 2}`);
  const roots = planRoots([{ path: app }]);
  const sc = scanner(s, roots);
  // Pause after the second file is hashed.
  const orig = s.fileHashed;
  let n = 0;
  s.fileHashed = (...a) => {
    orig(...a);
    if (++n === 2) sc.pause();
  };
  assert.equal(await sc.pass(), false);
  assert.equal(sc.status().state, 'paused');
  assert.equal(sc.status().totals.hashed, 2);
  s.fileHashed = orig;
  const sc2 = scanner(s, roots);
  const read0 = sc2.readBytes;
  assert.equal(await sc2.pass(), true);
  assert.equal(sc2.status().totals.hashed, 5);
  // Only the three files left were read.
  assert.equal(sc2.readBytes - read0, 3 * 'body 0'.length);
  assert.equal(s.dupeGroups().total, 2);
});

test('a root that is gone marks nothing gone; a finished walk marks deleted files', async (t) => {
  const { dir, s } = setup(t);
  const app = path.join(dir, 'mount');
  write(path.join(app, 'a.mp4'), 'A');
  write(path.join(app, 'b.mp4'), 'A');
  const roots = planRoots([{ path: app }]);
  await scanner(s, roots).pass();
  assert.equal(s.dupeGroups().total, 1);
  fs.renameSync(app, `${app}.away`);
  await scanner(s, roots).pass();
  assert.equal(s.dupeGroups().total, 1, 'an unmounted root keeps its records');
  fs.renameSync(`${app}.away`, app);
  fs.unlinkSync(path.join(app, 'b.mp4'));
  await scanner(s, roots, { now: () => Date.now() + 1000 }).pass();
  assert.equal(s.dupeGroups().total, 0);
});

test('the state survives a restart: boot resumes only a running scan', (t) => {
  const { s, app } = setup(t);
  const roots = planRoots([{ path: app }]);
  const sc = new DupeScanner({ store: s, roots, log: () => {} });
  assert.equal(sc.state, 'stopped');
  sc.boot();
  assert.equal(sc.loop, null);
  sc.pause();
  sc.boot();
  assert.equal(sc.loop, null);
});
