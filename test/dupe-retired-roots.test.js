'use strict';
// D12: the 18+ app's import folder (ELITE_ROOT) and its library are not
// Duplicate Manager roots in any mode. Rows an earlier scan recorded under
// them are set aside at boot, their cached previews are deleted, and the
// preview routes refuse them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const express = require('express');
const itemStore = require('../item-store');
const { createRouter } = require('../dupe-routes');

const SHARED = 'dupe-retired-roots-password';
const SHA_ADULT = 'b'.repeat(64);
const SHA_GENERAL = 'c'.repeat(64);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('rows recorded under the 18+ app folders are set aside at boot and never previewed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-d12-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const ads = path.join(root, 'ads');
  const adsLib = path.join(root, 'ads-library');
  const dl = path.join(root, 'downloads');
  for (const d of [data, path.join(ads, '18plus', '_import'), adsLib, dl]) fs.mkdirSync(d, { recursive: true });
  const files = {
    imp: [ads, '18plus/_import/Ada_-_clip 1.mp4', SHA_ADULT],
    lib: [adsLib, 'Ada/clip 2.web.mp4', SHA_ADULT],
    gen: [dl, 'Jane Doe_-_clip 3.mp4', SHA_GENERAL],
  };
  // An earlier Grabbit scanned all three roots.
  const st = itemStore.open(path.join(data, 'items.db'));
  const ids = {};
  for (const [k, [r, rel, sha]] of Object.entries(files)) {
    const abs = path.join(r, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `bytes ${k}`);
    const { row } = st.fileSeen(r, rel, fs.statSync(abs));
    st.fileHashed(row.id, { sha256: sha });
    ids[k] = row.id;
  }
  st.close();
  const thumbDir = path.join(data, 'dupe-thumbs');
  for (const sha of [SHA_ADULT, SHA_GENERAL]) {
    fs.mkdirSync(path.join(thumbDir, sha.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(thumbDir, sha.slice(0, 2), `${sha}.jpg`), 'jpeg');
  }

  const port = await freePort();
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'loopback-listen.js'), 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, TMPDIR: os.tmpdir(), PORT: String(port), DATA_DIR: data, DOWNLOAD_DIR: dl,
      GRABBIT_PASSWORD: SHARED, STATE_BACKUP_DAYS: '0', YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
      FFMPEG_BIN: '/bin/false', FFPROBE_BIN: '/bin/false', ELITE_ROOT: ads, ADSHORTIS_LIBRARY_DIR: adsLib,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  t.after(() => proc.kill());
  for (let i = 0; i < 100 && !logs.includes('grabbit listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.includes('grabbit listening'), logs);
  assert.match(logs, /2 recorded files set aside, 1 cached previews deleted/);
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `password=${encodeURIComponent(SHARED)}`,
    redirect: 'manual',
  });
  const cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth='));
  const get = (p) => fetch(base + p, { headers: { Cookie: cookie } });

  // The cached preview of the 18+ bytes is gone; the general one stays.
  assert.equal(fs.existsSync(path.join(thumbDir, SHA_ADULT.slice(0, 2), `${SHA_ADULT}.jpg`)), false);
  assert.equal(fs.existsSync(path.join(thumbDir, SHA_GENERAL.slice(0, 2), `${SHA_GENERAL}.jpg`)), true);
  // Neither folder is a scan root.
  const lib = await (await get('/api/hub/dupes/v2/library')).json();
  assert.equal(lib.ok, true);
  for (const r of lib.roots) assert.ok(![ads, adsLib].includes(r.path), r.path);
  // No preview, by any route, even when the 18+ view asks.
  for (const k of ['imp', 'lib']) {
    assert.equal((await get(`/api/hub/dupes/file/${ids[k]}`)).status, 404, `${k} legacy file`);
    assert.equal((await get(`/api/hub/dupes/v2/thumb/${ids[k]}?adult=1`)).status, 404, `${k} thumb`);
  }
  // The general copy is still served by the legacy preview.
  assert.equal((await get(`/api/hub/dupes/file/${ids.gen}`)).status, 200);
});

test('the v2 preview routes check the retired roots on every request', async (t) => {
  const retired = '/srv/ads';
  const rows = { 1: { id: 1, root: retired, rel: 'x.mp4', sha256: 'd'.repeat(64) }, 2: { id: 2, root: `${retired}/18plus`, rel: 'y.mp4', sha256: 'e'.repeat(64) } };
  const app = express();
  const service = new Proxy({}, {
    get(_, name) {
      if (name === 'store') return { dupeFile: (id) => rows[id] || null };
      if (name === 'then') return undefined;
      return () => 'general';
    },
  });
  const trash = { store: { trashGet: () => ({ root: retired, rel: 'x.mp4' }) }, trashedFile: () => ({ abs: '/dev/null' }) };
  app.use('/v2', createRouter({
    service, trash, kindOfName: () => 'video', actorOf: () => 'tester', thumbDir: '/nonexistent',
    retiredRoot: (p) => p === retired || String(p).startsWith(`${retired}/`),
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/v2`;
  for (const id of [1, 2]) assert.equal((await fetch(`${base}/thumb/${id}?adult=1`)).status, 404);
  assert.equal((await fetch(`${base}/trash/g1/file`)).status, 404);
});
