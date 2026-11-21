'use strict';
// KNOWN GAPS. Each test states the protection we would want for an open owner
// decision (documentation/open-decisions.md, D1-D4) and runs it against the
// current code. Current behaviour is pinned separately by the ordinary tests
// (guard-storage, guard-url, guard-http, guard-jobs).
//
// How a gap test reports (see documentation/test-contracts.md, "Known gaps"):
//  - the gap is still open (an assertion fails):
//      `not ok N - KNOWN GAP Dn ... # TODO Dn open owner decision`
//    node:test counts it as todo, not as a failure, and the run exits 0;
//  - the gap has closed (every assertion passes):
//      `ok N - KNOWN GAP Dn ... # TODO GAP CLOSED ...`
//    still exit 0, but the line says to remove the gap test;
//  - the harness broke (the server did not start, a precondition did not
//    hold, or any error that is not an assertion): a real failure whose
//    message starts with `HARNESS:`, and the run exits 1. A broken setup must
//    never pass for an open gap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, FUTURE } = require('./helpers/guard-server');
const { plainFetchFiles } = require('./helpers/fetch-scan');

// gap(name, decision, fn): fn(t, pre) runs the desired-behaviour assertions.
// pre(condition, message) checks a precondition; when it does not hold the
// test fails as HARNESS, because the gap assertion would prove nothing.
class Harness extends Error {}
function gap(name, decision, fn) {
  test(`KNOWN GAP ${decision}: ${name}`, async (t) => {
    const pre = (ok, message) => {
      if (!ok) throw new Harness(`HARNESS: precondition failed: ${message}`);
    };
    try {
      await fn(t, pre);
    } catch (e) {
      if (e instanceof assert.AssertionError) {
        t.todo(`${decision} open owner decision`);
        throw e;
      }
      if (e instanceof Harness) throw e;
      throw new Error(`HARNESS: ${e && e.stack ? e.stack : e}`);
    }
    t.todo(`GAP CLOSED: ${decision} now behaves as desired; remove this test (see documentation/test-contracts.md)`);
  });
}

const CORRUPT = '{"id:tiktok:1": {"filename": "a.mp4"';
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const history = (rows) => rows.map(([url, filename], i) => ({ id: `h${i}`, time: 1_700_000_000_000 + i, sourceUrl: url, filename }));
const REG_OLD = { 'id:tiktok:1': { filename: 'old_-_a 1.mp4', at: 1 } };
const corruptCopies = (dataDir) => fs.readdirSync(dataDir).filter((f) => f.startsWith('downloaded.json.corrupt-'));

gap('a damaged newest snapshot falls back to an older usable one', 'D1', async (t, pre) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), CORRUPT);
      write(path.join(d, 'backups', '2026-11-19', 'downloaded.json'), REG_OLD);
      write(path.join(d, 'backups', '2026-11-20', 'downloaded.json'), '{broken');
      write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4']]));
    },
  });
  pre(/downloaded\.json did not parse/.test(s.logs()), `the server never read the corrupt registry:\n${s.logs()}`);
  assert.deepEqual(s.readJson('downloaded.json'), REG_OLD, 'the registry was not restored from the older valid snapshot');
});

gap('with no usable snapshot the registry is not replaced by a history floor', 'D1', async (t, pre) => {
  const s = await boot(t, {
    seed: (d) => {
      write(path.join(d, 'downloaded.json'), CORRUPT);
      write(path.join(d, 'history.json'), history([['https://example.com/h/1', 'h1.mp4']]));
    },
  });
  pre(/downloaded\.json did not parse/.test(s.logs()), `the server never read the corrupt registry:\n${s.logs()}`);
  // Desired: the damaged bytes are kept (under the real name or as
  // .corrupt-*), no degraded reconstruction is written under the real name,
  // and the damage is reported. The exact signal is the owner's choice.
  const kept = [path.join(s.dataDir, 'downloaded.json'), ...corruptCopies(s.dataDir).map((f) => path.join(s.dataDir, f))]
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'));
  assert.ok(kept.includes(CORRUPT), 'the original damaged bytes were not kept anywhere');
  const live = path.join(s.dataDir, 'downloaded.json');
  if (fs.existsSync(live)) {
    const raw = fs.readFileSync(live, 'utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* still the damaged bytes: fine */
    }
    assert.ok(!parsed || !('example.com/h/1' in parsed), `a history floor was written as downloaded.json: ${raw}`);
  }
  assert.match(s.logs(), /no usable snapshot/, 'the damage is not reported');
});

gap('no extractor fetches with plain fetch() instead of safeFetch()', 'D2', async (_t, pre) => {
  const dir = path.join(__dirname, '..', 'extractors');
  pre(fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length > 1, `no extractors found in ${dir}`);
  assert.deepEqual(plainFetchFiles(dir), [], 'these extractors still call plain fetch() (text scan, test/helpers/fetch-scan.js)');
});

gap('route=smart is refused for the internal principal (owner web UI only)', 'D3', async (t, pre) => {
  const s = await boot(t);
  const base = { url: 'https://192.0.2.10/clip/1', dest: 'elite', channel: 'main', device: '0', at: String(FUTURE()) };
  // The internal principal must still be able to schedule an ordinary job;
  // otherwise a refusal below would prove nothing about route=smart.
  const plain = await s.call(`/api/jobs/start?${new URLSearchParams(base)}`, { headers: s.internal });
  pre(plain.status === 200, `an ordinary internal job start returned ${plain.status}: ${plain.text}`);
  const r = await s.call(`/api/jobs/start?${new URLSearchParams({ ...base, route: 'smart' })}`, { headers: s.internal });
  assert.equal(r.status, 400, `internal route=smart: ${r.status} ${r.text}`);
  assert.deepEqual(r.body, { ok: false, error: 'route=smart is only available to the owner.' });
});

gap('every smart routing decision has a matching history row', 'D4', async (t, pre) => {
  const s = await boot(t, {
    media: true,
    seed: (dataDir) => {
      const profiles = require('../profiles');
      const store = profiles.create(profiles.emptyStore(), { name: 'Jane Doe', audience: 'general' }, 1).store;
      fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(store));
    },
  });
  const url = s.fakeUrl('video', 'tiktok', 'Jane Doe', 'gap-d4', '?w=1080&h=1920');
  const first = await s.runJob({ url, dest: 'elite', route: 'smart' });
  const second = await s.runJob({ url, dest: 'elite', route: 'smart' });
  for (const [n, r] of [['first', first], ['second', second]]) {
    pre(r.job && r.job.status === 'done', `${n} job did not finish as done: ${JSON.stringify(r.job || r.started)}`);
  }
  const decisions = fs
    .readFileSync(path.join(s.dataDir, 'routing.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((d) => d.sourceUrl === url);
  pre(decisions.length === 2, `expected 2 routing decisions for ${url}, found ${decisions.length}`);
  // Neither routing.jsonl nor history rows carry a job id today, so rows are
  // paired with decisions by URL and count.
  const rows = (await s.call('/api/history')).body.items.filter((h) => h.sourceUrl === url);
  assert.equal(rows.length, decisions.length, `${url}: ${decisions.length} routing decisions but ${rows.length} history rows`);
  assert.ok(rows.every((r) => r.route && r.route.route === 'shorts'), `history rows without the route: ${JSON.stringify(rows)}`);
});
