'use strict';
// KNOWN GAPS. Each test states the protection we would want for an open owner
// decision (documentation/open-decisions.md, D1-D4) and runs it against the
// current code. They are marked `todo`, so node:test reports them as TODO and
// a failure does not fail the suite: they document a gap, they are not an
// unexpected regression. Current behaviour is pinned separately by the
// ordinary tests (guard-storage, guard-url, guard-http, guard-jobs).
//
// When the owner decides a gap and it is fixed, the matching test here starts
// passing; then remove its `todo` and the characterisation test it replaces.
// If the owner decides to keep current behaviour instead, delete the test here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, FUTURE } = require('./helpers/guard-server');

const CORRUPT = '{"id:tiktok:1": {"filename": "a.mp4"';
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const history = (rows) => rows.map(([url, filename], i) => ({ id: `h${i}`, time: 1_700_000_000_000 + i, sourceUrl: url, filename }));
const REG_OLD = { 'id:tiktok:1': { filename: 'old_-_a 1.mp4', at: 1 } };

test('KNOWN GAP D1: a damaged newest snapshot falls back to an older usable one', { todo: 'D1 open owner decision' }, async (t) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), CORRUPT);
      write(path.join(d, 'backups', '2026-11-19', 'downloaded.json'), REG_OLD);
      write(path.join(d, 'backups', '2026-11-20', 'downloaded.json'), '{broken');
      write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4']]));
    },
  });
  assert.deepEqual(s.readJson('downloaded.json'), REG_OLD);
});

test('KNOWN GAP D1: with no usable snapshot the registry is not replaced by a history floor', { todo: 'D1 open owner decision' }, async (t) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), CORRUPT);
      write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4']]));
    },
  });
  // Desired: no degraded reconstruction is written under the real name; the
  // server reports the damage instead (the exact signal is the owner's choice).
  assert.equal(fs.existsSync(path.join(s.dataDir, 'downloaded.json')), false, 'a history floor was written as downloaded.json');
});

test('KNOWN GAP D2: no extractor fetches with plain fetch() instead of safeFetch()', { todo: 'D2 open owner decision' }, () => {
  const dir = path.join(__dirname, '..', 'extractors');
  const plain = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /(^|[^.\w])fetch\(/m.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(plain, []);
});

test('KNOWN GAP D3: route=smart is refused for the internal principal (owner web UI only)', { todo: 'D3 open owner decision' }, async (t) => {
  const s = await boot(t);
  const q = new URLSearchParams({ url: 'https://example.com/clip/1', dest: 'elite', channel: 'main', device: '0', route: 'smart', at: String(FUTURE()) });
  const r = await s.call(`/api/jobs/start?${q}`, { headers: s.internal });
  assert.equal(r.status, 400, r.text);
});

test('KNOWN GAP D4: every smart routing decision has a matching history row', { todo: 'D4 open owner decision' }, async (t) => {
  const s = await boot(t, {
    media: true,
    seed: (dataDir) => {
      const profiles = require('../profiles');
      const store = profiles.create(profiles.emptyStore(), { name: 'Jane Doe', audience: 'general' }, 1).store;
      fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(store));
    },
  });
  const url = s.fakeUrl('video', 'tiktok', 'Jane Doe', 'gap-d4', '?w=1080&h=1920');
  await s.runJob({ url, dest: 'elite', route: 'smart' });
  await s.runJob({ url, dest: 'elite', route: 'smart' });
  const decisions = fs.readFileSync(path.join(s.dataDir, 'routing.jsonl'), 'utf8').trim().split('\n').filter((l) => JSON.parse(l).sourceUrl === url);
  const rows = (await s.call('/api/history')).body.items.filter((h) => h.sourceUrl === url);
  assert.equal(rows.length, decisions.length);
});
