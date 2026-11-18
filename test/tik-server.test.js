'use strict';
// Grabbit 3.0 native TikShortis, against a real server process: /api/config
// flags per TIKSHORTIS_MODE, and who may reach /api/tik (signed-in browser
// only: not anonymous, not cross-site, not a sibling site, not the internal
// token, not an app password). TikShortis is a fake upstream in this process.
// Everything lives in a temp dir that is removed after.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const gda = require('../gda');

const PASSWORD = 'tik-test-password';
const INTERNAL = 'internal-test-token';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-tik-'));
const procs = [];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const upSeen = [];
const upstream = http.createServer((req, res) => {
  upSeen.push({ method: req.method, url: req.url, headers: req.headers });
  req.resume();
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/shorts/feed')) {
    return res.end(JSON.stringify({ items: [{ id: 1, channel: 'main', storage_key: 'a' }, { id: 2, channel: '18plus', storage_key: 'b' }] }));
  }
  res.end(JSON.stringify({ user: { id: 1 } }));
});

// Starts one Grabbit with the given extra env; resolves with its base URL.
async function boot(name, extraEnv) {
  const data = path.join(root, name);
  fs.mkdirSync(data, { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATA_DIR: data,
      DOWNLOAD_DIR: path.join(data, 'downloads'),
      GRABBIT_PASSWORD: PASSWORD,
      GRABBIT_INTERNAL_TOKEN: INTERNAL,
      STATE_BACKUP_DAYS: '0',
      YTDLP_BIN: '/bin/false',
      GALLERY_DL_BIN: '/bin/false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  for (let i = 0; i < 150; i++) {
    if (logs.includes('grabbit listening')) return { base: `http://127.0.0.1:${port}`, logs: () => logs, data };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server ${name} did not start:\n${logs}`);
}

async function login(base, password = PASSWORD) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  return (res.headers.getSetCookie() || []).map((v) => v.split(';')[0]).find((v) => /^grabbit_auth=.+/.test(v));
}

const config = async (base) => (await fetch(`${base}/api/config`, { headers: { 'X-Grabbit-Token': INTERNAL } })).json();

let native;
let appPassword;

test.before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const nativeData = path.join(root, 'native');
  fs.mkdirSync(nativeData, { recursive: true });
  const reg = gda.createRegistry({ file: path.join(nativeData, 'gda-clients.json'), sessionSecret: 'x' });
  reg.upsertClient({
    client_id: 'sender',
    audience: 'general',
    allowed_targets: ['server.downloads'],
    allowed_ops: ['job', 'status'],
    legacy_main_target: null,
  });
  appPassword = reg.setPassword('sender');
  native = await boot('native', {
    TIKSHORTIS_MODE: 'native',
    TIKSHORTIS_API_URL: `http://127.0.0.1:${upstream.address().port}`,
  });
});

test.after(() => {
  for (const p of procs) p.kill();
  upstream.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('/api/config in native mode', async () => {
  const c = await config(native.base);
  assert.equal(c.tikshortisMode, 'native');
  assert.equal(c.tikshortisEmbed, null);
  const tik = c.modules.find((m) => m.id === 'tikshortis');
  assert.deepEqual(tik, { id: 'tikshortis', label: 'TikShortis', phase: 1, audience: 'general', group: 'watch', enabled: true, mode: 'native' });
  assert.ok(c.modules.filter((m) => m.id !== 'tikshortis').every((m) => m.enabled === false && m.planned === true));
  assert.match(native.logs(), /TikShortis: native, API at http:\/\/127\.0\.0\.1:/);
});

test('/api/config: fallbacks and 2.2 behaviour (rollback A)', async () => {
  const embedUrl = 'https://tik.example.com';
  const cases = [
    ['unset', {}, 'off', null],
    ['unset-embed', { TIKSHORTIS_EMBED_URL: embedUrl }, 'embed', 'https://tik.example.com'],
    ['native-no-api', { TIKSHORTIS_MODE: 'native', TIKSHORTIS_EMBED_URL: embedUrl }, 'embed', 'https://tik.example.com'],
    ['native-bad-api', { TIKSHORTIS_MODE: 'native', TIKSHORTIS_API_URL: 'http://tik.example.com/api' }, 'off', null],
    ['embed-off', { TIKSHORTIS_MODE: 'off', TIKSHORTIS_EMBED_URL: embedUrl, TIKSHORTIS_API_URL: 'http://127.0.0.1:1' }, 'off', null],
  ];
  const servers = await Promise.all(cases.map(([name, env]) => boot(name, env)));
  for (const [i, [name, , mode, embedOrigin]] of cases.entries()) {
    const c = await config(servers[i].base);
    assert.equal(c.tikshortisMode, mode, name);
    assert.equal(c.tikshortisEmbed && c.tikshortisEmbed.origin, embedOrigin || null, name);
    assert.equal(c.modules.find((m) => m.id === 'tikshortis').enabled, mode !== 'off', name);
    // Not native: /api/tik does not exist (a signed-in browser gets no gateway).
    const cookie = await login(servers[i].base);
    const r = await fetch(`${servers[i].base}/api/tik/me`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
    assert.notEqual(r.status, 200, `${name}: /api/tik must not answer`);
  }
  assert.match(servers[2].logs(), /needs a valid TIKSHORTIS_API_URL; using embed/);
  assert.match(servers[3].logs(), /TIKSHORTIS_API_URL is not a plain http\(s\) origin/);
});

test('/api/tik: signed-in browser from the hub gets through, 18+ filtered', async () => {
  const cookie = await login(native.base);
  const r = await fetch(`${native.base}/api/tik/shorts/feed`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).items.map((x) => x.id), [1]);
  assert.equal(upSeen.at(-1).headers['x-real-ip'] !== undefined, true);
});

test('/api/tik: refused for everyone else, before anything goes upstream', async () => {
  const cookie = await login(native.base);
  const appCookie = await login(native.base, appPassword);
  assert.ok(appCookie, 'app password signs in');
  const before = upSeen.length;
  const cases = [
    ['anonymous', {}, 401],
    ['internal token', { 'X-Grabbit-Token': INTERNAL }, 403],
    ['internal token + browser cookie', { 'X-Grabbit-Token': INTERNAL, Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' }, 403],
    ['cross-site', { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }, 403],
    ['foreign Origin', { Cookie: cookie, Origin: 'https://evil.example.com' }, 403],
    ['same-site sibling', { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' }, 403],
    ['app password', { Cookie: appCookie, 'Sec-Fetch-Site': 'same-origin' }, 403],
  ];
  for (const [name, headers, status] of cases) {
    for (const [method, p] of [['GET', 'me'], ['POST', 'shorts/1/like'], ['GET', 'session']]) {
      const r = await fetch(`${native.base}/api/tik/${p}`, { method, headers });
      assert.equal(r.status, status, `${name}: ${method} ${p}`);
    }
  }
  assert.equal(upSeen.length, before, 'nothing reached TikShortis');
});
