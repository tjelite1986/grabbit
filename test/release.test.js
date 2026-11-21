'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const { releaseSha } = require('../release');

const SHA = 'a'.repeat(39) + 'b';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-release-'));
const none = path.join(dir, 'missing');

test('valid env sha is reported', () => assert.equal(releaseSha({ RELEASE_SHA: SHA }, none), SHA));
test('missing sha is null', () => assert.equal(releaseSha({}, none), null));
test('invalid values are rejected to null', () => {
  for (const v of ['unknown', '', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), SHA + '\nx', '<script>', 'g'.repeat(40)]) {
    assert.equal(releaseSha({ RELEASE_SHA: v }, none), null, JSON.stringify(v));
  }
});
test('file wins over env; invalid file falls back to env', () => {
  const f = path.join(dir, 'RELEASE_SHA');
  fs.writeFileSync(f, SHA + '\n');
  assert.equal(releaseSha({ RELEASE_SHA: 'c'.repeat(40) }, f), SHA);
  fs.writeFileSync(f, 'unknown\n');
  assert.equal(releaseSha({ RELEASE_SHA: 'c'.repeat(40) }, f), 'c'.repeat(40));
  assert.equal(releaseSha({}, f), null);
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('health endpoints over HTTP: sha first, release route public and minimal', async (t) => {
  const port = await freePort();
  const mk = (n) => { const p = path.join(dir, n); fs.mkdirSync(p, { recursive: true }); return p; };
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, PORT: String(port), DATA_DIR: mk('data'), DOWNLOAD_DIR: mk('dl'),
      GRABBIT_PASSWORD: 'pw-test', RELEASE_SHA: SHA, RELEASE_SHA_FILE: none,
      // Never start the developer's real downloaders (boot runs yt-dlp --list-extractors).
      YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
    },
    stdio: 'ignore',
  });
  t.after(() => proc.kill());
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(base + '/api/health/release'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, 'server did not start');
  const r = await fetch(base + '/api/health/release');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sha: SHA });
  // Full health stays behind the password gate.
  assert.equal((await fetch(base + '/api/health')).status, 401);
});

test('full /api/health: sha is the first key, within 4 KiB, existing fields kept', async (t) => {
  const port = await freePort();
  const mk = (n) => { const p = path.join(dir, n); fs.mkdirSync(p, { recursive: true }); return p; };
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: mk('data2'), DOWNLOAD_DIR: mk('dl2'), GRABBIT_AUTH_DISABLED: '1', RELEASE_SHA: SHA, RELEASE_SHA_FILE: none, YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false' },
    stdio: 'ignore',
  });
  t.after(() => proc.kill());
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(base + '/api/health/release'); up = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(up, 'server did not start');
  const text = await (await fetch(base + '/api/health')).text();
  const body = JSON.parse(text);
  assert.equal(Object.keys(body)[0], 'sha');
  assert.equal(body.sha, SHA);
  assert.ok(text.indexOf('"sha"') < 4096);
  for (const k of ['ok', 'now', 'uptimeSec', 'tools', 'dests', 'state', 'items', 'backups', 'cookies', 'jobs', 'auth']) assert.ok(k in body, k);
});
