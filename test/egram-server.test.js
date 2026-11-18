'use strict';
// Grabbit 3.0 phase 2, Social & Photos against a real server process:
// /api/config per EGRAM_MODE, who may reach /api/egram, and the classify route
// that mirrors a decision into Grabbit's profiles. Elitogram is a fake upstream
// in this process; everything lives in a temp dir that is removed after.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const PASSWORD = 'egram-test-password';
const INTERNAL = 'internal-test-token';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-egram-'));
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

// --- Fake Elitogram ------------------------------------------------------------------
const upSeen = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    upSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, obj, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/api/auth/login') return send(200, { ok: true }, { 'set-cookie': 'eg_session=up-token; Path=/; HttpOnly' });
    if (req.url.startsWith('/api/feed')) {
      return send(200, {
        items: [
          { id: 1, caption: 'a', author: { handle: 'sunny' }, media: [], audience: 'general' },
          { id: 2, caption: 'b', author: { handle: 'naughty' }, media: [], audience: 'general' },
        ],
        next: null,
      });
    }
    if (req.url === '/api/creators-classify') {
      const b = JSON.parse(body);
      return send(200, { audience: b.audience, updated: b.handles, skipped: [] });
    }
    const one = /^\/api\/creators\/([a-z0-9._-]+)$/.exec(req.url);
    if (one && one[1] === 'ghost') return send(404, { error: 'Profile not found' });
    if (one) return send(200, { id: 7, handle: one[1], ig_handle: `ig.${one[1]}`, post_count: 1, audience: 'general' });
    send(404, { error: 'Not found' });
  });
});

async function boot(name, extraEnv, files = {}) {
  const data = path.join(root, name);
  fs.mkdirSync(data, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(data, f), JSON.stringify(v));
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

async function login(base) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    redirect: 'manual',
  });
  return (res.headers.getSetCookie() || []).map((v) => v.split(';')[0]).find((v) => /^grabbit_auth=.+/.test(v));
}

const config = async (base) => (await fetch(`${base}/api/config`, { headers: { 'X-Grabbit-Token': INTERNAL } })).json();

// Profiles known to Grabbit only: Elitogram has no idea. `naughty` is 18+ by
// its alias; the 18+ `shady` profile is known only by the Instagram account
// Elitogram links to its creator `shady`; `Linda Kay` is a general profile known
// only by the Instagram account of the creator `linky`.
const PROFILES = {
  version: 1,
  nextId: 4,
  profiles: [
    {
      id: 1, name: 'naughty', audience: 'adult', note: '', accounts: [], aliases: [{ name: 'naughty', addedAt: 1 }],
      mergedFrom: [], origin: 'registry', classifiedAs: null, classifiedAt: null, createdAt: 1, updatedAt: 1,
    },
    {
      id: 2, name: 'Shady Lady', audience: 'adult', note: '', accounts: [{ platform: 'instagram', handle: 'ig.shady', url: null, source: 'manual', addedAt: 1 }], aliases: [],
      mergedFrom: [], origin: 'manual', classifiedAs: null, classifiedAt: null, createdAt: 1, updatedAt: 1,
    },
    {
      id: 3, name: 'Linda Kay', audience: 'general', note: '', accounts: [{ platform: 'instagram', handle: 'ig.linky', url: null, source: 'manual', addedAt: 1 }], aliases: [],
      mergedFrom: [], origin: 'manual', classifiedAs: null, classifiedAt: null, createdAt: 1, updatedAt: 1,
    },
  ],
  log: [],
};

let native;
let auth;
let egramCookie;

test.before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  native = await boot('native', { EGRAM_MODE: 'native', EGRAM_API_URL: `http://127.0.0.1:${upstream.address().port}` }, { 'profiles.json': PROFILES });
  auth = await login(native.base);
});

test.after(() => {
  for (const p of procs) p.kill();
  upstream.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const hub = (extra = {}) => ({ Cookie: [auth, egramCookie].filter(Boolean).join('; '), 'Sec-Fetch-Site': 'same-origin', ...extra });

test('/api/config: Social & Photos native', async () => {
  const c = await config(native.base);
  assert.deepEqual(c.modules.find((m) => m.id === 'social'), { id: 'social', label: 'Social & Photos', phase: 3, audience: 'general', group: 'social', enabled: true, mode: 'native' });
  assert.match(native.logs(), /Social & Photos: native, Elitogram API at http:\/\/127\.0\.0\.1:/);
});

test('/api/config: off by default, and native without a URL falls back to off', async () => {
  const off = await boot('off', {});
  assert.equal((await config(off.base)).modules.find((m) => m.id === 'social').mode, 'off');
  assert.match(off.logs(), /Social & Photos: off/);
  const noUrl = await boot('nourl', { EGRAM_MODE: 'native' });
  assert.equal((await config(noUrl.base)).modules.find((m) => m.id === 'social').enabled, false);
  assert.match(noUrl.logs(), /EGRAM_MODE=native needs a valid EGRAM_API_URL/);
  const r = await fetch(`${noUrl.base}/api/egram/session`, { headers: { Cookie: await login(noUrl.base), 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(r.status, 404);
});

test('/api/egram: refused for anonymous, internal and cross-site callers before anything goes upstream', async () => {
  const before = upSeen.length;
  const anon = await fetch(`${native.base}/api/egram/api/feed`, { redirect: 'manual' });
  assert.ok([401, 302].includes(anon.status), String(anon.status));
  const internal = await fetch(`${native.base}/api/egram/api/feed`, { headers: { 'X-Grabbit-Token': INTERNAL } });
  assert.equal(internal.status, 403);
  const cross = await fetch(`${native.base}/api/egram/api/feed`, { headers: hub({ 'Sec-Fetch-Site': 'cross-site' }) });
  assert.equal(cross.status, 403);
  assert.equal(upSeen.length, before);
});

test('link, then the feed comes back without the Grabbit-18+ author', async () => {
  const r = await fetch(`${native.base}/api/egram/session`, {
    method: 'POST',
    headers: hub({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ username: 'cc', password: 'pw' }),
  });
  assert.equal(r.status, 200);
  egramCookie = (r.headers.getSetCookie() || []).map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_egram='));
  assert.ok(egramCookie);
  const feed = await (await fetch(`${native.base}/api/egram/api/feed`, { headers: hub() })).json();
  assert.deepEqual(feed.items.map((p) => p.author.handle), ['sunny']);
  const up = upSeen[upSeen.length - 1];
  assert.equal(up.headers['x-egram-audience'], 'general');
  assert.equal(up.headers.cookie, 'eg_session=up-token');
});

test('classify: an 18+ Grabbit profile is never made general; others are mirrored', async () => {
  const r = await fetch(`${native.base}/api/egram/creators-classify`, {
    method: 'POST',
    headers: hub({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ handles: ['naughty', 'newbie'], audience: 'general' }),
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.deepEqual(d.updated, ['newbie']);
  assert.deepEqual(d.skipped, [{ handle: 'naughty', reason: 'matches an 18+ profile in Grabbit' }]);
  const sent = upSeen.find((x) => x.url === '/api/creators-classify');
  assert.deepEqual(JSON.parse(sent.body), { handles: ['newbie'], audience: 'general' });
  const store = JSON.parse(fs.readFileSync(path.join(native.data, 'profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.name === 'newbie');
  assert.equal(p.audience, 'general');
  assert.equal(p.origin, 'manual');
  assert.deepEqual(p.accounts.map((a) => `${a.platform}:${a.handle}`), ['egram:newbie', 'instagram:ig.newbie']);
  // Classifying the same creator again changes nothing in Grabbit.
  const again = await (await fetch(`${native.base}/api/egram/creators-classify`, {
    method: 'POST',
    headers: hub({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ handles: ['newbie'], audience: 'general' }),
  })).json();
  assert.deepEqual(again.mirrored, [{ handle: 'newbie', changed: [], created: null, linked: null }]);
});

test('classify: general is refused before the write for a creator 18+ in Grabbit by Instagram, or unknown to Elitogram', async () => {
  const before = upSeen.filter((x) => x.url === '/api/creators-classify').length;
  const r = await fetch(`${native.base}/api/egram/creators-classify`, {
    method: 'POST',
    headers: hub({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ handles: ['shady', 'ghost'], audience: 'general' }),
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.deepEqual(d.updated, []);
  assert.deepEqual(d.skipped, [
    { handle: 'shady', reason: 'matches an 18+ profile in Grabbit' },
    { handle: 'ghost', reason: 'not found in Elitogram' },
  ]);
  assert.equal(upSeen.filter((x) => x.url === '/api/creators-classify').length, before, 'nothing written upstream');
});

test('classify: a profile found only by Instagram gets the egram account', async () => {
  const r = await fetch(`${native.base}/api/egram/creators-classify`, {
    method: 'POST',
    headers: hub({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ handles: ['linky'], audience: 'adult' }),
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.deepEqual(d.mirrored, [{ handle: 'linky', changed: [3], created: null, linked: 3 }]);
  const store = JSON.parse(fs.readFileSync(path.join(native.data, 'profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.id === 3);
  assert.deepEqual(p.accounts.map((a) => `${a.platform}:${a.handle}`), ['instagram:ig.linky', 'egram:linky']);
});

test('classify: bad input is refused', async () => {
  const evil = { toString: 1 };
  for (const body of [
    { handles: ['x'], audience: 'unknown' },
    { handles: [], audience: 'general' },
    { handles: ['../x'], audience: 'general' },
    { handles: [evil], audience: 'general' },
    { handles: [['a']], audience: 'general' },
    { handles: 'abc', audience: 'general' },
    { handles: Array.from({ length: 201 }, (_, i) => `h${i}`), audience: 'general' },
  ]) {
    const r = await fetch(`${native.base}/api/egram/creators-classify`, { method: 'POST', headers: hub({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('/logout also clears the linked Elitogram session cookie', async () => {
  const r = await fetch(`${native.base}/logout`, { method: 'POST', headers: hub(), redirect: 'manual' });
  const set = r.headers.getSetCookie() || [];
  assert.ok(set.some((c) => /^grabbit_egram=;/.test(c) && /Path=\/api\/egram/.test(c)));
  assert.ok(set.some((c) => /^__Host-grabbit_egram=;/.test(c) && /Path=\/;/.test(c) && /Secure/.test(c)));
});

test('an unreadable profile store on a cold start hides every author instead of none', async () => {
  const data = path.join(root, 'unreadable');
  // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
  fs.mkdirSync(path.join(data, 'profiles.json'), { recursive: true });
  const s = await boot('unreadable', { EGRAM_MODE: 'native', EGRAM_API_URL: `http://127.0.0.1:${upstream.address().port}` });
  const a = await login(s.base);
  const link = await fetch(`${s.base}/api/egram/session`, {
    method: 'POST',
    headers: { Cookie: a, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cc', password: 'pw' }),
  });
  assert.equal(link.status, 200);
  const eg = (link.headers.getSetCookie() || []).map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_egram='));
  const feed = await (await fetch(`${s.base}/api/egram/api/feed`, { headers: { Cookie: `${a}; ${eg}`, 'Sec-Fetch-Site': 'same-origin' } })).json();
  assert.deepEqual(feed.items, []);
});
