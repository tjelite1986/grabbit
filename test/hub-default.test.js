'use strict';
// The hub is the start page; Grabbit 1 lives at /classic/ and keeps its deep links.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const SHARED = 'hub-default-test-password';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-hub-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, PORT: String(port), DATA_DIR: data, DOWNLOAD_DIR: path.join(root, 'downloads'),
      GRABBIT_PASSWORD: SHARED, STATE_BACKUP_DAYS: '0', YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
      FFMPEG_BIN: '/bin/false', FFPROBE_BIN: '/bin/false', DUPES_SCAN: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  t.after(() => proc.kill());
  for (let i = 0; i < 100 && !logs.includes('grabbit listening'); i++) await new Promise((r) => setTimeout(r, 100));
  if (!logs.includes('grabbit listening')) throw new Error(`server did not start:\n${logs}`);
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(SHARED)}`,
    redirect: 'manual',
  });
  const cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth='));
  const get = (p, auth = true) => fetch(`${base}${p}`, { headers: auth ? { Cookie: cookie } : {}, redirect: 'manual' });
  return { get, login };
}

test('the start page is the hub; Grabbit 1 is at /classic/', async (t) => {
  const { get, login } = await boot(t);
  assert.equal(login.headers.get('location'), '/');
  const hub = await get('/');
  assert.equal(hub.status, 200);
  assert.equal(hub.headers.get('cache-control'), 'no-cache');
  assert.match(await hub.text(), /\/hub\/hub\.js/);
  const classic = await get('/classic/');
  assert.equal(classic.status, 200);
  assert.equal(classic.headers.get('cache-control'), 'no-cache');
  const html = await classic.text();
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /\/hub\/hub\.js/);
  // The hub's own assets are still where the shell loads them from.
  assert.equal((await get('/hub/hub.js')).status, 200);
});

test('old addresses and deep links land where they belong', async (t) => {
  const { get } = await boot(t);
  const loc = async (p) => {
    const r = await get(p);
    return [r.status, r.headers.get('location')];
  };
  assert.deepEqual(await loc('/?tab=queue'), [302, '/classic/?tab=queue']);
  assert.deepEqual(await loc('/?action=paste'), [302, '/classic/?action=paste']);
  assert.deepEqual(await loc('/classic'), [302, '/classic/']);
  assert.deepEqual(await loc('/hub/'), [302, '/']);
  assert.deepEqual(await loc('/hub'), [302, '/']);
  // The share target still opens Grabbit 1's grab box.
  const share = await get('/share?url=https%3A%2F%2Fexample.com%2Fv');
  assert.equal(share.status, 200);
  assert.match(await share.text(), /manifest\.webmanifest/);
});

test('signed out, every page goes to the login form', async (t) => {
  const { get } = await boot(t);
  for (const p of ['/', '/classic/', '/hub/']) {
    const r = await get(p, false);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/login', p);
  }
});

test('the manifest keeps its id and start page; shortcuts open Grabbit 1', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.id, '/');
  assert.equal(m.start_url, '/');
  assert.equal(m.share_target.action, '/share');
  for (const s of m.shortcuts) assert.match(s.url, /^\/classic\/\?/);
});
