'use strict';
// Boot-time separation of the 18+ app (Adshortis) from every general
// destination: the server is started with a given set of roots and asked
// through /api/config which channels it will write to.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const SHARED = 'separation-test-password';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Boot a server with these roots, read /api/config and the job-start answer
// for an 18+ save, then stop it. Every folder lives under a fresh temp dir.
async function boot(roots) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-sep-'));
  const env = {
    PATH: process.env.PATH,
    DATA_DIR: path.join(root, 'data'),
    DOWNLOAD_DIR: path.join(root, 'downloads'),
    GRABBIT_PASSWORD: SHARED,
    STATE_BACKUP_DAYS: '0',
    YTDLP_BIN: '/bin/false',
    GALLERY_DL_BIN: '/bin/false',
  };
  for (const [k, v] of Object.entries(roots)) {
    const dir = path.isAbsolute(v) ? v : path.join(root, v);
    fs.mkdirSync(dir, { recursive: true });
    env[k] = dir;
  }
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  const port = await freePort();
  env.PORT = String(port);
  const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  try {
    for (let i = 0; i < 100 && !logs.includes('grabbit listening'); i++) await new Promise((r) => setTimeout(r, 100));
    if (!logs.includes('grabbit listening')) throw new Error(`server did not start:\n${logs}`);
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `password=${encodeURIComponent(SHARED)}`,
      redirect: 'manual',
    });
    const cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth='));
    const headers = { Cookie: cookie, Accept: 'application/json' };
    const config = await (await fetch(`${base}/api/config`, { headers })).json();
    const q = new URLSearchParams({ url: 'https://example.com/clip/1', dest: 'elite', channel: '18plus', device: '0', at: String(Date.now() + 3.6e6) });
    const adultJob = await fetch(`${base}/api/jobs/start?${q}`, { headers });
    return { config, adultJob: { status: adultJob.status, body: await adultJob.json() }, logs };
  } finally {
    proc.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('separate roots: Adshortis is offered as its own adult app', async () => {
  const { config, adultJob } = await boot({ ELITE_ROOT: 'ads', TIKSHORTIS_ROOT: 'tik', PLATFORM_IMPORT_ROOT: 'platform' });
  assert.deepEqual(config.channels.sort(), ['18plus', 'main', 'platform']);
  assert.deepEqual(config.apps.find((a) => a.channel === '18plus'), { channel: '18plus', app: 'Adshortis', audience: 'adult' });
  assert.ok(config.apps.filter((a) => a.channel !== '18plus').every((a) => a.audience === 'general'));
  assert.equal(config.adultBlocked, null);
  assert.equal(adultJob.status, 200, JSON.stringify(adultJob.body));
});

test('only ELITE_ROOT set: main no longer falls back into the 18+ tree', async () => {
  const { config } = await boot({ ELITE_ROOT: 'ads' });
  assert.deepEqual(config.channels, ['18plus']);
});

test('a general drop folder inside the 18+ tree disables the 18+ channel', async () => {
  const { config, adultJob, logs } = await boot({ ELITE_ROOT: 'ads', TIKSHORTIS_ROOT: 'tik', PLATFORM_IMPORT_ROOT: 'ads/18plus/platform' });
  assert.deepEqual(config.channels.sort(), ['main', 'platform']);
  assert.match(config.adultBlocked, /platform drop folder/);
  assert.match(logs, /18\+ channel is disabled/);
  assert.notEqual(adultJob.status, 200);
  assert.match(JSON.stringify(adultJob.body), /18\+ channel is disabled/);
});

test('a symlink cannot hide the overlap', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-sep-link-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // main channel folder = <tik>/main, made a symlink to the 18+ folder.
  fs.mkdirSync(path.join(tmp, 'ads', '18plus'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tik'));
  fs.symlinkSync(path.join(tmp, 'ads', '18plus'), path.join(tmp, 'tik', 'main'));
  const { config } = await boot({ ELITE_ROOT: path.join(tmp, 'ads'), TIKSHORTIS_ROOT: path.join(tmp, 'tik') });
  assert.equal(config.channels.includes('18plus'), false);
  assert.match(config.adultBlocked, /main channel/);
});
