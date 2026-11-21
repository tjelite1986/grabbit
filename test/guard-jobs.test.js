'use strict';
// Guard tests for the background job engine (server.js: startJobFromQuery,
// scheduleJob, runJob, failJob, markDownloaded, the retry queue). Binding
// rules, CLAUDE.md "Downloads and extractors": failures are persisted to
// history and never marked downloaded; retryable upstream errors are parked in
// retry-queue.json; MAX_ACTIVE_JOBS bounds concurrency.
//
// Extractors are replaced by test/fixtures/fake-extractors.js and every file
// is served by a loopback server in this process (helpers/guard-server.js), so
// no external network is used and no real media is downloaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, filesUnder } = require('./helpers/guard-server');

const LANDSCAPE = '?w=1920&h=1080';
const PORTRAIT = '?w=1080&h=1920';
const historyFor = async (s, url) => (await s.call('/api/history')).body.items.filter((h) => h.sourceUrl === url);
const media = (dir) => filesUnder(dir).filter((f) => /\.(mp4|jpg)$/.test(f));
const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const jobById = async (s, id) => (await s.call('/api/jobs')).body.jobs.find((j) => j.id === id);
const seedProfiles = (list) => (dataDir) => {
  const profiles = require('../profiles');
  let store = profiles.emptyStore();
  for (const p of list) store = profiles.create(store, p, 1_700_000_000_000).store;
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(store));
};

test('a successful job: done, one history row, registered under its site id, one file', async (t) => {
  const s = await boot(t, { media: true });
  const url = s.fakeUrl('video', 'youtube', 'Jane Doe', 'ok1', LANDSCAPE);
  const { started, job } = await s.runJob({ url, dest: 'server' });
  assert.equal(started.status, 200);
  assert.equal(job.status, 'done', JSON.stringify(job) + s.logs());
  const rows = await historyFor(s, url);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].filename, JSON.stringify(rows[0]));
  assert.ok(!rows[0].error);
  const reg = s.readJson('downloaded.json');
  assert.ok(reg['id:youtube:ok1'], Object.keys(reg).join(', '));
  assert.equal(reg['id:youtube:ok1'].filename, rows[0].filename);
  assert.equal(media(s.downloads).length, 1, filesUnder(s.downloads).join('\n'));
});

test('a failed download: error status, a history row with the reason, never marked downloaded, parked for retry', async (t) => {
  const s = await boot(t, { media: true });
  s.media.state.mode = 404; // the CDN has not encoded the file yet
  const url = s.fakeUrl('video', 'youtube', 'Jane Doe', 'missing1', LANDSCAPE);
  const { job } = await s.runJob({ url, dest: 'server' });
  assert.equal(job.status, 'error', JSON.stringify(job));
  assert.match(job.error, /404/);
  const rows = await historyFor(s, url);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].filename, null);
  assert.match(rows[0].error, /404/);
  const reg = s.readJson('downloaded.json');
  assert.equal(reg['id:youtube:missing1'], undefined, 'a failure must never be marked downloaded');
  assert.equal(Object.keys(reg).length, 0);
  const queue = s.readJson('retry-queue.json');
  assert.equal(queue.length, 1, JSON.stringify(queue));
  assert.equal(queue[0].url, url);
  assert.equal(queue[0].dest, 'server');
  assert.ok(queue[0].nextAt > Date.now(), 'retries are backed off, not immediate');
  assert.deepEqual(media(s.downloads), []);
});

test('a repeat save of the same item is skipped and writes no second file', async (t) => {
  const s = await boot(t, { media: true });
  const url = s.fakeUrl('video', 'youtube', 'Jane Doe', 'dup1', LANDSCAPE);
  const first = await s.runJob({ url, dest: 'server' });
  assert.equal(first.job.status, 'done');
  const requests = s.media.state.requests;
  const second = await s.runJob({ url, dest: 'server' });
  assert.equal(second.job.status, 'done', JSON.stringify(second.job));
  assert.equal(second.job.message, 'Already in the library.');
  assert.equal(media(s.downloads).length, 1, filesUnder(s.downloads).join('\n'));
  assert.equal(s.media.state.requests, requests, 'the repeat must not fetch the file again');
});

test('concurrency: at most MAX_ACTIVE_JOBS (2) run at once; the rest queue in order and can be cancelled', async (t) => {
  const s = await boot(t, { media: true });
  s.media.state.mode = 'hold';
  const ids = [];
  for (const id of ['c1', 'c2', 'c3', 'c4']) {
    const q = new URLSearchParams({ url: s.fakeUrl('video', 'youtube', 'Jane Doe', id, LANDSCAPE), dest: 'server', channel: 'main', device: '0' });
    const r = await s.call(`/api/jobs/start?${q}`);
    assert.equal(r.status, 200);
    ids.push(r.body.jobId);
  }
  await until(() => s.media.heldCount() === 2, 'two held downloads');
  // Give a third job every chance to start if the cap were broken.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.media.heldCount(), 2);
  const statuses = await Promise.all(ids.map(async (id) => (await jobById(s, id)).status));
  assert.deepEqual(statuses.slice(2), ['queued', 'queued'], statuses.join());
  // Cancel the last queued job; it must never be fetched.
  const c = await s.call(`/api/jobs/${ids[3]}/cancel`, { method: 'POST' });
  assert.equal(c.status, 200);
  // A running job cannot be cancelled through this route.
  const running = await s.call(`/api/jobs/${ids[0]}/cancel`, { method: 'POST' });
  assert.equal(running.status, 400);
  s.media.state.mode = 'ok';
  s.media.release();
  await until(async () => ['done', 'error'].includes((await jobById(s, ids[2])).status), 'the third job');
  const final = await Promise.all(ids.map(async (id) => (await jobById(s, id)).status));
  assert.deepEqual(final, ['done', 'done', 'done', 'cancelled'], final.join());
  assert.equal(s.media.state.requests, 3, 'the cancelled job never reached the network');
  assert.equal(media(s.downloads).length, 3);
});

test('D4 (current behaviour): a smart-routed repeat logs a routing decision but writes no history row', async (t) => {
  const s = await boot(t, { media: true, seed: seedProfiles([{ name: 'Jane Doe', audience: 'general' }]) });
  const url = s.fakeUrl('video', 'tiktok', 'Jane Doe', 'd4', PORTRAIT);
  const first = await s.runJob({ url, dest: 'elite', route: 'smart' });
  assert.equal(first.job.status, 'done', JSON.stringify(first.job) + s.logs());
  assert.equal(first.job.route.route, 'shorts');
  const second = await s.runJob({ url, dest: 'elite', route: 'smart' });
  assert.equal(second.job.status, 'done', JSON.stringify(second.job));
  assert.equal(second.job.message, 'Already queued for import.');
  const log = fs.readFileSync(path.join(s.dataDir, 'routing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const decisions = log.filter((l) => l.sourceUrl === url);
  assert.equal(decisions.length, 2, 'every smart decision is logged');
  assert.ok(decisions.every((d) => d.route === 'shorts' && d.at && Array.isArray(d.reasons)));
  // Today the save-only repeat returns before recordJobHistory(): one row for two decisions.
  assert.equal((await historyFor(s, url)).length, 1);
  assert.equal(media(s.apps.tik).length, 1);
});

test('routing log entries carry the decision inputs, and history rows the route', async (t) => {
  const s = await boot(t, { media: true, seed: seedProfiles([{ name: 'Jane Doe', audience: 'general' }]) });
  const url = s.fakeUrl('video', 'youtube', 'Jane Doe', 'r1', LANDSCAPE);
  const { job } = await s.runJob({ url, dest: 'elite', route: 'smart' });
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.route.route, 'long-videos');
  const [entry] = fs.readFileSync(path.join(s.dataDir, 'routing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const key of ['at', 'route', 'reasons', 'orientation', 'sourceClass', 'sourceUrl']) assert.ok(key in entry, `routing.jsonl lacks ${key}: ${JSON.stringify(entry)}`);
  assert.equal(entry.orientation, 'landscape');
  const [row] = await historyFor(s, url);
  assert.equal(row.route && row.route.route, 'long-videos', JSON.stringify(row));
});

test('Shorts destinations are opt-in: with no app roots, a smart portrait save goes to Review', async (t) => {
  const s = await boot(t, { media: true, apps: false, seed: seedProfiles([{ name: 'Jane Doe', audience: 'general' }]) });
  const url = s.fakeUrl('video', 'tiktok', 'Jane Doe', 'noapp1', PORTRAIT);
  const { started, job } = await s.runJob({ url, dest: 'elite', route: 'smart' });
  assert.equal(started.status, 200, started.text);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.route.route, 'review', 'no Shorts app is configured, so the portrait clip waits in Review');
  assert.equal(media(path.join(s.downloads, 'review')).length, 1, filesUnder(s.downloads).join('\n'));
  for (const d of ['tik', 'ads', 'plat']) assert.deepEqual(filesUnder(path.join(s.root, d)), [], d);
});

test('ELITE_ENABLED: with no Shorts or posts root, dest=elite (and no dest) fall back to the server library', async (t) => {
  const s = await boot(t, { apps: false });
  const cfg = await s.call('/api/config');
  assert.equal(cfg.body.elite, false);
  assert.equal(cfg.body.shorts, false);
  assert.deepEqual(cfg.body.channels, []);
  for (const dest of ['elite', undefined, 'bogus']) {
    const q = new URLSearchParams({ url: 'https://example.com/e/1', channel: 'main', device: '0', at: String(Date.now() + 3600e3) });
    if (dest) q.set('dest', dest);
    const r = await s.call(`/api/jobs/start?${q}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(s.readJson('scheduled.json').find((x) => x.id === r.body.jobId).dest, 'server', String(dest));
  }
});

test('ELITE_ENABLED: with app roots, no dest means elite and the configured channels are listed', async (t) => {
  const s = await boot(t);
  const cfg = await s.call('/api/config');
  assert.equal(cfg.body.elite, true);
  assert.ok(cfg.body.channels.includes('main'), JSON.stringify(cfg.body.channels));
  const q = new URLSearchParams({ url: 'https://example.com/e/2', channel: 'main', device: '0', at: String(Date.now() + 3600e3) });
  const r = await s.call(`/api/jobs/start?${q}`);
  assert.equal(s.readJson('scheduled.json').find((x) => x.id === r.body.jobId).dest, 'elite');
});
