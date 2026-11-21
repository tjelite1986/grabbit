'use strict';
// Guard tests for state files and recovery (server.js: writeJsonAtomic,
// readJsonState, newestSnapshot, readDownloaded). Binding rules, CLAUDE.md
// "Writing files safely": a missing file is a fresh install; a file that
// exists but does not parse is damage, quarantined as `.corrupt-<stamp>` and
// restored from a snapshot; never write a degraded reconstruction back over
// the original.
//
// D1 is an open owner decision: with no usable snapshot the registry is
// rebuilt from history.json and written. The tests below pin TODAY's
// behaviour (so a change is deliberate) and check the one protection that
// holds now: the damaged original survives, byte for byte, as `.corrupt-*`.
// The desired behaviour is in test/known-gaps.test.js.
//
// The server reads downloaded.json at boot (item store import), so recovery
// has already run when boot() returns. Every DATA_DIR is a temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('./helpers/guard-server');

const CORRUPT = '{"id:tiktok:1": {"filename": "a.mp4"'; // truncated mid-object
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const snap = (dataDir, day, name, value) => write(path.join(dataDir, 'backups', day, name), value);
const corruptCopies = (dataDir, name) => fs.readdirSync(dataDir).filter((f) => f.startsWith(`${name}.corrupt-`));
const tmpLeftovers = (dataDir) => fs.readdirSync(dataDir).filter((f) => /\.tmp-\d+$/.test(f));
const history = (rows) => rows.map(([url, filename], i) => ({ id: `h${i}`, time: 1_700_000_000_000 + i, sourceUrl: url, filename }));

const REG_OLD = { 'id:tiktok:1': { filename: 'old_-_a 1.mp4', at: 1 } };
const REG_NEW = {
  'id:tiktok:1': { filename: 'new_-_a 1.mp4', at: 2 },
  'id:tiktok:2': { filename: 'new_-_b 2.mp4', at: 3 },
};

test('a corrupt registry is quarantined and restored from the newest usable snapshot', async (t) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), CORRUPT);
      snap(d, '2026-11-19', 'downloaded.json', REG_OLD);
      snap(d, '2026-11-20', 'downloaded.json', REG_NEW);
      snap(d, '2026-11-21', 'downloaded.json', ''); // empty copies are skipped
      snap(d, 'not-a-day', 'downloaded.json', { 'id:x:9': { filename: 'never.mp4', at: 9 } });
      write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4']]));
    },
  });
  assert.deepEqual(s.readJson('downloaded.json'), REG_NEW);
  const kept = corruptCopies(s.dataDir, 'downloaded.json');
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(s.dataDir, kept[0]), 'utf8'), CORRUPT, 'the damaged original must be kept byte for byte');
  assert.match(s.logs(), /downloaded\.json did not parse/);
  assert.match(s.logs(), /downloaded\.json restored from the snapshot of 2026-11-20/);
  // Snapshots are read, never modified by a restore: the one restored from
  // and the older one.
  assert.equal(fs.readFileSync(path.join(s.dataDir, 'backups', '2026-11-20', 'downloaded.json'), 'utf8'), JSON.stringify(REG_NEW));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'backups', '2026-11-19', 'downloaded.json'), 'utf8')), REG_OLD);
  assert.deepEqual(tmpLeftovers(s.dataDir), []);
  // The server loaded the restored registry, not just the file on disk: the
  // hub's creator list is built from it (creator "new" from REG_NEW, two
  // files; nothing from the older snapshot).
  const creators = await s.call('/api/hub/creators');
  assert.equal(creators.status, 200, creators.text);
  assert.deepEqual(creators.body.items.map((c) => [c.name, c.files]), [['new', 2]], creators.text);
});

test('D1 (current behaviour): a damaged newest snapshot is not followed by an older one; the registry is rebuilt from history', async (t) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), CORRUPT);
      snap(d, '2026-11-19', 'downloaded.json', REG_OLD);
      snap(d, '2026-11-20', 'downloaded.json', '{broken');
      write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4'], ['https://www.youtube.com/watch?v=abc', 'h2.mp4']]));
    },
  });
  assert.match(s.logs(), /the newest snapshot is damaged too/);
  const reg = s.readJson('downloaded.json');
  assert.deepEqual(Object.keys(reg).sort(), ['example.com/h/1', 'yt:abc']);
  assert.equal(reg['yt:abc'].filename, 'h2.mp4');
  assert.equal(reg['id:tiktok:1'], undefined, 'the older valid snapshot is not used today (D1)');
  // What protects the data today: the original is kept, the snapshots are untouched.
  const kept = corruptCopies(s.dataDir, 'downloaded.json');
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(s.dataDir, kept[0]), 'utf8'), CORRUPT);
  assert.equal(fs.readFileSync(path.join(s.dataDir, 'backups', '2026-11-20', 'downloaded.json'), 'utf8'), '{broken');
});

test('D1 (current behaviour): no snapshot at all, the registry becomes the history floor; the original is kept', async (t) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), CORRUPT);
      write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4'], ['https://example.com/h/2?utm=x#t', 'h2.mp4']]));
    },
  });
  assert.match(s.logs(), /no usable snapshot/);
  assert.deepEqual(Object.keys(s.readJson('downloaded.json')).sort(), ['example.com/h/1', 'example.com/h/2']);
  const kept = corruptCopies(s.dataDir, 'downloaded.json');
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(s.dataDir, kept[0]), 'utf8'), CORRUPT);
});

test('a missing registry is a fresh install: seeded from history, nothing quarantined', async (t) => {
  const s = await boot(t, {
    seed: (d) => write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4'], ['https://example.com/h/no-file', null]])),
  });
  assert.deepEqual(Object.keys(s.readJson('downloaded.json')).sort(), ['example.com/h/1', 'example.com/h/no-file']);
  assert.deepEqual(corruptCopies(s.dataDir, 'downloaded.json'), []);
  assert.doesNotMatch(s.logs(), /did not parse/);
});

test('an empty install starts empty and quiet', async (t) => {
  const s = await boot(t);
  assert.deepEqual(s.readJson('downloaded.json'), {});
  assert.doesNotMatch(s.logs(), /did not parse|no usable snapshot/);
});

test('other state files: corrupt history and templates fall back empty, the damaged file is kept', async (t) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'history.json'), '[{"id":"x"');
      write(path.join(d, 'templates.json'), 'not json');
      write(path.join(d, 'scheduled.json'), '{');
    },
  });
  const h = await s.call('/api/history');
  assert.equal(h.status, 200);
  assert.deepEqual(h.body, { ok: true, items: [] });
  const tpl = await s.call('/api/templates');
  assert.deepEqual(tpl.body, { ok: true, templates: [] });
  for (const [name, raw] of [['history.json', '[{"id":"x"'], ['templates.json', 'not json'], ['scheduled.json', '{']]) {
    const kept = corruptCopies(s.dataDir, name);
    assert.equal(kept.length, 1, `${name}: ${fs.readdirSync(s.dataDir).join(', ')}`);
    assert.equal(fs.readFileSync(path.join(s.dataDir, kept[0]), 'utf8'), raw, name);
  }
});

test('a corrupt state file is restored from its own snapshot (templates)', async (t) => {
  const good = [{ id: '1', name: 'subs', args: '--write-subs' }];
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'templates.json'), '[');
      snap(d, '2026-11-20', 'templates.json', good);
    },
  });
  const tpl = await s.call('/api/templates');
  assert.deepEqual(tpl.body.templates, good);
  assert.deepEqual(s.readJson('templates.json'), good);
  assert.equal(corruptCopies(s.dataDir, 'templates.json').length, 1);
});

test('registry writes through the API keep every other entry and leave no temp files', async (t) => {
  const s = await boot(t, { seed: (d) => write(path.join(d, 'downloaded.json'), REG_NEW) });
  const mark = await s.call('/api/downloaded/mark?url=https://example.com/m/1', { method: 'POST' });
  assert.deepEqual(mark.body, { ok: true });
  let reg = s.readJson('downloaded.json');
  assert.equal(reg['example.com/m/1'].filename, null);
  for (const k of Object.keys(REG_NEW)) assert.deepEqual(reg[k], REG_NEW[k], k);
  const unmark = await s.call('/api/downloaded/unmark?url=https://example.com/m/1', { method: 'POST' });
  assert.deepEqual(unmark.body, { ok: true });
  reg = s.readJson('downloaded.json');
  assert.deepEqual(reg, REG_NEW);
  assert.equal((await s.call('/api/downloaded/mark?url=notaurl', { method: 'POST' })).status, 400);
  for (let i = 0; i < 20; i++) await s.call(`/api/templates/save?name=t${i}&args=--embed-subs`, { method: 'POST' });
  assert.equal(s.readJson('templates.json').length, 20);
  assert.deepEqual(tmpLeftovers(s.dataDir), []);
});

test('/api/health reports every state file and its snapshot', async (t) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), REG_NEW);
      snap(d, '2026-11-20', 'downloaded.json', REG_NEW);
    },
  });
  const r = await s.call('/api/health');
  assert.equal(r.status, 200);
  const rows = r.body.state;
  assert.ok(Array.isArray(rows), JSON.stringify(r.body).slice(0, 300));
  const names = rows.map((x) => x.name);
  for (const name of ['downloaded.json', 'history.json', 'scheduled.json', 'retry-queue.json', 'templates.json', 'gda-clients.json', 'profiles.json']) {
    assert.ok(names.includes(name), `${name} missing from STATE_FILES / health`);
  }
  const reg = rows.find((x) => x.name === 'downloaded.json');
  assert.equal(reg.corrupt, false);
  assert.equal(reg.snapshot, '2026-11-20');
});
