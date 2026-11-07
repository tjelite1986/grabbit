'use strict';
// Contract tests against a real server process: the calls the installed apps
// make today (POST /login without following the redirect, then
// GET /api/jobs/start with the grabbit_auth cookie) must answer exactly as
// before with the shared password, and app passwords must be scoped.
//
// Jobs are started with `at` far in the future, so they are only scheduled and
// nothing is downloaded. Everything lives in a temp dir that is removed after.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const gda = require('../gda');

const SHARED = 'shared-test-password';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-contract-'));
const dirs = {};
for (const d of ['data', 'downloads', 'adults', 'tik/main/_import', 'ads/18plus/_import', 'music', 'kids', 'books']) {
  dirs[d] = path.join(root, d);
  fs.mkdirSync(dirs[d], { recursive: true });
}

let base;
let proc;
let logs = '';
const pw = {};
let token;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test.before(async () => {
  // Register the step-4 clients before boot, the way gda-admin.js would.
  const reg = gda.createRegistry({ file: path.join(dirs.data, 'gda-clients.json'), sessionSecret: 'x' });
  const clients = {
    elitebook: ['general', ['legacy.tikshortis']],
    elitetok: ['general', ['legacy.tikshortis']],
    'grabbit-send': ['general', ['legacy.tikshortis', 'server.downloads', 'library.music', 'library.audiobooks']],
    elitegifs: ['adult', ['adshortis.inbox']],
  };
  for (const [id, [audience, targets]] of Object.entries(clients)) {
    reg.upsertClient({
      client_id: id,
      audience,
      allowed_targets: targets,
      allowed_ops: ['job', 'status'],
      // Only general apps have a main target to switch; an adult app sending
      // channel=main is refused rather than moved into 18+.
      legacy_main_target: audience === 'general' ? targets[0] : null,
    });
    pw[id] = reg.setPassword(id);
  }
  token = reg.issueToken('grabbit-send');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATA_DIR: dirs.data,
      GRABBIT_PASSWORD: SHARED,
      GRABBIT_INTERNAL_TOKEN: 'internal-test-token',
      TIKSHORTIS_ROOT: path.join(root, 'tik'),
      ELITE_ROOT: path.join(root, 'ads'),
      DOWNLOAD_DIR: dirs.downloads,
      ADULTS_DOWNLOAD_DIR: dirs.adults,
      NAVIDROME_MUSIC_DIR: dirs.music,
      NAVIDROME_KIDS_DIR: dirs.kids,
      AUDIOBOOKS_DIR: dirs.books,
      STATE_BACKUP_DAYS: '0',
      // Nothing in these tests may reach a real downloader.
      YTDLP_BIN: '/bin/false',
      GALLERY_DL_BIN: '/bin/false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  for (let i = 0; i < 100; i++) {
    if (logs.includes('grabbit listening')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${logs}`);
});

test.after(() => {
  if (proc) proc.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

// What GrabbitClient.java does: form POST, no redirect following, pick the
// grabbit_auth pair out of Set-Cookie.
async function appLogin(password) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  const cookie = (res.headers.getSetCookie() || [])
    .map((v) => v.split(';')[0])
    .find((v) => v.startsWith('grabbit_auth=') && v.length > 'grabbit_auth='.length);
  return { status: res.status, cookie: cookie || null };
}

const FUTURE = Date.now() + 365 * 24 * 3600 * 1000;

async function jobsStart(cookie, { dest = 'elite', channel = 'main', folder } = {}) {
  const q = new URLSearchParams({ url: 'https://example.com/clip/1', dest, channel, device: '0', at: String(FUTURE) });
  if (folder) q.set('folder', folder);
  const res = await fetch(`${base}/api/jobs/start?${q}`, { headers: { Cookie: cookie, Accept: 'application/json' } });
  return { status: res.status, body: await res.json() };
}

test('shared password: login and job start answer exactly as before', async () => {
  const { status, cookie } = await appLogin(SHARED);
  assert.equal(status, 302);
  assert.match(cookie, /^grabbit_auth=[0-9a-f]{64}$/, 'shared cookie format changed');
  for (const [dest, channel, folder] of [
    ['elite', 'main'],
    ['elite', '18plus'],
    ['server', 'main'],
    ['server', 'main', 'adults'],
    ['navidrome', 'main'],
    ['audiobooks', 'main'],
  ]) {
    const r = await jobsStart(cookie, { dest, channel, folder });
    assert.equal(r.status, 200, `${dest}/${channel}/${folder}`);
    assert.deepEqual(Object.keys(r.body).sort(), ['jobId', 'ok', 'scheduled']);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.scheduled, true);
  }
  assert.match(logs, /gda: client=legacy-shared target=library\.adults via=legacy result=allow/);
});

test('shared password still opens the web UI and the admin API', async () => {
  const { cookie } = await appLogin(SHARED);
  assert.equal((await fetch(`${base}/api/history`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 200);
});

test('wrong password: 401 and no cookie, as before', async () => {
  const r = await appLogin('not-a-password');
  assert.equal(r.status, 401);
  assert.equal(r.cookie, null);
});

test('internal callers keep full access', async () => {
  const q = new URLSearchParams({ url: 'https://example.com/a', dest: 'elite', channel: '18plus', at: String(FUTURE) });
  const res = await fetch(`${base}/api/jobs/start?${q}`, { headers: { 'X-Grabbit-Token': 'internal-test-token' } });
  assert.equal(res.status, 200);
  assert.match(logs, /gda: client=internal target=adshortis\.inbox/);
});

test('app passwords: same contract on allowed targets', async () => {
  for (const id of ['elitebook', 'elitetok', 'grabbit-send']) {
    const { status, cookie } = await appLogin(pw[id]);
    assert.equal(status, 302, id);
    assert.match(cookie, new RegExp(`^grabbit_auth=gda1\\.${id}\\.[0-9a-f]{64}$`));
    const r = await jobsStart(cookie, { dest: 'elite', channel: 'main' });
    assert.equal(r.status, 200, id);
    assert.deepEqual(Object.keys(r.body).sort(), ['jobId', 'ok', 'scheduled']);
  }
  const { cookie } = await appLogin(pw.elitegifs);
  const r = await jobsStart(cookie, { dest: 'elite', channel: '18plus' });
  assert.equal(r.status, 200);
  assert.match(logs, /gda: client=elitegifs target=adshortis\.inbox via=legacy result=allow/);
});

test('app passwords: refused outside their scope with the shape the apps show', async () => {
  const cases = [
    ['elitebook', { dest: 'elite', channel: '18plus' }],
    ['elitebook', { dest: 'server' }],
    ['elitetok', { dest: 'server', folder: 'adults' }],
    ['grabbit-send', { dest: 'elite', channel: '18plus' }],
    ['grabbit-send', { dest: 'server', folder: 'adults' }],
    ['elitegifs', { dest: 'server' }],
    ['elitegifs', { dest: 'navidrome' }],
    ['elitegifs', { dest: 'elite', channel: 'main' }],
  ];
  for (const [id, args] of cases) {
    const { cookie } = await appLogin(pw[id]);
    const r = await jobsStart(cookie, args);
    assert.equal(r.status, 403, `${id} ${JSON.stringify(args)}`);
    assert.equal(r.body.ok, false);
    assert.equal(typeof r.body.error, 'string');
  }
  assert.match(logs, /gda: client=elitebook target=adshortis\.inbox via=legacy result=deny code=forbidden_target/);
});

test('jobs record which client sent them', async () => {
  const { cookie } = await appLogin(pw.elitetok);
  const r = await jobsStart(cookie, { dest: 'elite', channel: 'main' });
  const jobs = await (await fetch(`${base}/api/jobs`, { headers: { Cookie: (await appLogin(SHARED)).cookie } })).json();
  const job = jobs.jobs.find((j) => j.id === r.body.jobId);
  assert.equal(job.clientId, 'elitetok');
  assert.equal(job.target, 'legacy.tikshortis');
});

test('app passwords cannot reach the web UI or other APIs', async () => {
  const { cookie } = await appLogin(pw.elitebook);
  for (const p of ['/api/history', '/api/jobs', '/api/cookies', '/api/config']) {
    const res = await fetch(`${base}${p}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 403, p);
  }
  const page = await fetch(`${base}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(page.status, 403);
});

test('a forged or stale app cookie is a 401, which makes the apps log in again', async () => {
  const { cookie } = await appLogin(pw.elitebook);
  const forged = cookie.replace('elitebook', 'elitegifs');
  assert.equal((await jobsStart(forged)).status, 401);
});

test('v1: whoami, targets, jobs, status and scope', async () => {
  const auth = { Authorization: `Bearer ${token.token}` };
  const who = await (await fetch(`${base}/api/v1/whoami`, { headers: auth })).json();
  assert.equal(who.ok, true);
  assert.equal(who.data.client_id, 'grabbit-send');
  assert.equal(who.data.audience, 'general');
  assert.deepEqual(who.data.allowed_targets.sort(), ['legacy.tikshortis', 'library.audiobooks', 'library.music', 'server.downloads']);

  const targets = await (await fetch(`${base}/api/v1/targets`, { headers: auth })).json();
  assert.ok(targets.data.targets.every((t) => t.audience === 'general'));

  const post = (body, extra = {}) =>
    fetch(`${base}/api/v1/jobs`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });

  const denied = await post({ url: 'https://example.com/x', target: 'adshortis.inbox' });
  assert.equal(denied.status, 403);
  assert.deepEqual((await denied.json()).error.code, 'forbidden_target');

  const unknown = await post({ url: 'https://example.com/x', target: '/mnt/4tb/anything' });
  assert.equal(unknown.status, 422);

  const bad = await post({ url: 'file:///etc/passwd', target: 'server.downloads' });
  assert.equal(bad.status, 400);

  // A private address: the URL guard fails the job without any network call.
  const ok = await post({ url: 'http://127.0.0.1:9/x', target: 'server.downloads' }, { 'Idempotency-Key': 'k1' });
  assert.equal(ok.status, 202);
  const job = (await ok.json()).data;
  assert.equal(job.target, 'server.downloads');

  const again = await post({ url: 'http://127.0.0.1:9/x', target: 'server.downloads' }, { 'Idempotency-Key': 'k1' });
  assert.equal((await again.json()).data.job_id, job.job_id);

  let st;
  for (let i = 0; i < 50; i++) {
    st = await (await fetch(`${base}/api/v1/jobs/${job.job_id}`, { headers: auth })).json();
    if (st.data.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(st.data.status, 'failed');

  // Another client cannot see it.
  const { cookie } = await appLogin(pw.elitebook);
  const other = await fetch(`${base}/api/v1/jobs/${job.job_id}`, { headers: { Cookie: cookie } });
  assert.equal(other.status, 404);

  const noAuth = await fetch(`${base}/api/v1/whoami`);
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).error.code, 'unauthorized');
});

test('an app cannot pick its own folder or pass yt-dlp args', async () => {
  const { cookie } = await appLogin(pw['grabbit-send']);
  const q = new URLSearchParams({ url: 'https://example.com/f', dest: 'server', folder: 'private', xargs: '--no-mtime', device: '0', at: String(FUTURE) });
  const r = await (await fetch(`${base}/api/jobs/start?${q}`, { headers: { Cookie: cookie } })).json();
  assert.ok(r.ok);
  const sched = JSON.parse(fs.readFileSync(path.join(dirs.data, 'scheduled.json'), 'utf8')).find((s) => s.id === r.jobId);
  assert.equal(sched.params.folder, undefined);
  assert.ok(!JSON.stringify(sched.params.extraArgs || []).includes('no-mtime'));
});

test('an app login does not clear the shared-password failure window', async () => {
  const hdr = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.9' };
  // Without trust proxy the key is the socket peer, the same for every call here.
  let last;
  for (let i = 0; i < 12; i++) {
    await fetch(`${base}/login`, { method: 'POST', headers: hdr, body: 'password=wrong', redirect: 'manual' });
    await appLogin(pw.elitebook);
    last = await fetch(`${base}/login`, { method: 'POST', headers: hdr, body: 'password=wrong', redirect: 'manual' });
  }
  assert.equal(last.status, 429);
});

test('logs carry no password, token or session value', () => {
  for (const id of Object.keys(pw)) assert.ok(!logs.includes(pw[id]), `password of ${id} logged`);
  assert.ok(!logs.includes(token.token));
  assert.ok(!logs.includes(SHARED));
  assert.ok(!/gda1\./.test(logs));
});
