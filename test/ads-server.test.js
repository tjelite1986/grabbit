'use strict';
// Grabbit 3.0 native Adshortis, phase 1, against a real server.js process
// (test/helpers/guard-server.js): the mode matrix, who reaches /api/ads, the
// per-login id from /login, logout and boot-time drops (H2), the folder page
// rows (H1, H19, H46, H53), the cache generation (H62) and /api/config.
// Adshortis is a fake upstream in this process. Covers the real-process half of
// PHASE1_GATEWAY_TESTS 1-4.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { boot } = require('./helpers/guard-server');

const OWN = 'https://grabbit.example.com';
const APP = 'https://ads.example.com';
const EMBED = 'https://ads.example.com';
const SHA = 'a'.repeat(40);
const LOGIN = '__Host-grabbit_login';
const LINK = '__Host-grabbit_ads';

// --- Fake Adshortis ---------------------------------------------------------------------
const seen = [];
let tokens = 0;
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const send = (status, obj, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/api/login') return send(200, { ok: true }, { 'set-cookie': `as_session=srv${++tokens}; Path=/; HttpOnly` });
    if (req.url === '/api/me') {
      if (!/as_session=srv\d+/.test(req.headers.cookie || '')) return send(401, { error: 'Unauthorized' });
      return send(200, { id: 3, username: 'm', display_name: 'M', role: 'user', permissions: [], avatar: null, ai: {}, nav_tabs: [] });
    }
    if (req.url === '/api/logout') return send(200, { ok: true });
    send(404, { error: 'Not found' });
  });
});
test.before(() => new Promise((r) => upstream.listen(0, '127.0.0.1', r)));
test.after(() => upstream.close());

const nativeEnv = () => ({
  ADSHORTIS_MODE: 'native',
  ADSHORTIS_API_URL: `http://127.0.0.1:${upstream.address().port}`,
  ADSHORTIS_APP_ORIGIN: APP,
  GRABBIT_PUBLIC_ORIGIN: OWN,
  GRABBIT_TRUST_PROXY: '127.0.0.1',
  RELEASE_SHA: SHA,
});

// A folder library with one clip, for the folder page rows.
function seedLibrary(root) {
  const lib = path.join(root, 'adslib');
  fs.mkdirSync(path.join(lib, 'creator'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'creator', 'clip.web.mp4'), 'MP4');
  fs.writeFileSync(path.join(lib, 'creator', 'clip.jpg'), 'JPG');
  return lib;
}

const cookieOf = (setCookie, name) => {
  const c = setCookie.find((v) => v.startsWith(`${name}=`) && !/Max-Age=0/.test(v));
  return c ? c.split(';')[0] : null;
};

// The owner's browser over https through a trusted proxy.
function browser(s, cookies, write) {
  return {
    Cookie: [s.headers.Cookie, ...cookies].filter(Boolean).join('; '),
    Accept: 'application/json',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'grabbit.example.com',
    'Sec-Fetch-Site': 'same-origin',
    ...(write ? { Origin: OWN, 'Content-Type': 'application/json' } : {}),
  };
}

async function freshLogin(s) {
  const l = await s.login();
  const auth = l.cookie;
  const login = cookieOf(l.setCookie, LOGIN);
  return { auth, login, setCookie: l.setCookie };
}

test('mode matrix: /api/config, modules and whether /api/ads exists', async (t) => {
  const cases = [
    ['unset', {}, 'off'],
    ['native', nativeEnv(), 'native'],
    ['embed', { ADSHORTIS_MODE: 'embed', ADSHORTIS_EMBED_URL: EMBED }, 'embed'],
    ['embed without a valid url', { ADSHORTIS_MODE: 'embed', ADSHORTIS_EMBED_URL: 'http://ads.example.com' }, 'off'],
    ['native without GRABBIT_PUBLIC_ORIGIN -> embed', { ...nativeEnv(), GRABBIT_PUBLIC_ORIGIN: '', ADSHORTIS_EMBED_URL: EMBED }, 'embed'],
    ['native without ADSHORTIS_APP_ORIGIN -> off', { ...nativeEnv(), ADSHORTIS_APP_ORIGIN: '' }, 'off'],
    ['native with auth disabled -> off', { ...nativeEnv(), GRABBIT_AUTH_DISABLED: '1' }, 'off'],
    ['unknown mode', { ADSHORTIS_MODE: 'iframe', ADSHORTIS_EMBED_URL: EMBED }, 'off'],
  ];
  for (const [name, env, mode] of cases) {
    await t.test(name, async (tt) => {
      const s = await boot(tt, { env, apps: false });
      const c = await s.call('/api/config');
      assert.equal(c.body.adshortisMode, mode);
      const m = c.body.modules.find((x) => x.id === 'adshortis');
      assert.deepEqual([m.enabled, m.mode, m.audience, m.planned], [mode !== 'off', mode, 'adult', undefined]);
      assert.equal(c.body.adshortisEmbed, mode !== 'off' && env.ADSHORTIS_EMBED_URL === EMBED ? `${EMBED}/` : null);
      assert.equal(c.body.adshortisLibrary, false);
      assert.equal(c.body.build, env.RELEASE_SHA || null);
      const r = await s.call('/api/ads/session', { headers: browser(s, []) });
      if (mode === 'native') assert.equal(r.status, 200, name);
      else assert.equal(r.status, 404, `${name}: /api/ads is not mounted`);
      if (mode !== 'native' && env.ADSHORTIS_MODE === 'native') assert.match(s.logs(), /ADSHORTIS_MODE=native needs/);
    });
  }
});

test('build meta: the hub shell carries the release sha', async (t) => {
  const s = await boot(t, { env: nativeEnv(), apps: false });
  const r = await s.call('/', { headers: { Cookie: s.headers.Cookie } });
  assert.match(r.text, new RegExp(`<meta name="grabbit-build" content="${SHA}">`));
});

test('who reaches /api/ads: anonymous 401, internal token 403, app password 403, cross-site and same-site 403', async (t) => {
  const s = await boot(t, {
    env: nativeEnv(),
    apps: false,
    seed: (dataDir) => {
      const gda = require('../gda');
      const reg = gda.createRegistry({ file: path.join(dataDir, 'gda-clients.json'), sessionSecret: 'x' });
      reg.upsertClient({ client_id: 'ads-app', audience: 'general', allowed_targets: ['server.downloads'], allowed_ops: ['job'] });
      fs.writeFileSync(path.join(dataDir, 'ads-app.pw'), reg.setPassword('ads-app'));
    },
  });
  const before = seen.length;
  const { login } = await freshLogin(s);
  const paths = [['POST', '/api/ads/session'], ['GET', '/api/ads/session'], ['DELETE', '/api/ads/session'], ['GET', '/api/ads/clips']];
  for (const [method, p] of paths) {
    const anon = await s.call(p, { method, headers: { Accept: 'application/json', 'X-Forwarded-Proto': 'https' } });
    assert.equal(anon.status, 401, `anonymous ${method} ${p}`);
    const internal = await s.call(p, { method, headers: { ...s.internal, 'X-Forwarded-Proto': 'https', Cookie: login, Accept: 'application/json' } });
    assert.equal(internal.status, 403, `internal ${method} ${p}`);
    const cross = await s.call(p, { method, headers: { ...browser(s, [login], method !== 'GET'), 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(cross.status, 403, `cross-site ${method} ${p}`);
    // Same-site passes the global gate; the gateway refuses it. An unlisted
    // path is already a 404 there (allowlist first, as in the tik gateway).
    const sameSite = await s.call(p, { method, headers: { ...browser(s, [login], method !== 'GET'), 'Sec-Fetch-Site': 'same-site' } });
    assert.equal(sameSite.status, p === '/api/ads/clips' ? 404 : 403, `same-site ${method} ${p}`);
  }
  const app = await s.login(fs.readFileSync(path.join(s.dataDir, 'ads-app.pw'), 'utf8'));
  assert.equal(app.status, 302);
  assert.equal(cookieOf(app.setCookie, LOGIN), null, 'an app password gets no login id');
  for (const [method, p] of paths) {
    const r = await s.call(p, { method, headers: { Cookie: app.cookie, Accept: 'application/json', 'X-Forwarded-Proto': 'https', 'Sec-Fetch-Site': 'same-origin', Origin: OWN, 'X-Forwarded-Host': 'grabbit.example.com' } });
    assert.equal(r.status, 403, `app ${method} ${p}`);
  }
  assert.equal(seen.length, before, 'nothing reached Adshortis');
});

test('S1 NL over HTTP: grabbit_auth without a login id -> 409, zero upstream calls; link, logout and replay', async (t) => {
  const s = await boot(t, { env: nativeEnv(), apps: false });
  const before = seen.length;
  // The boot() login predates nothing: send grabbit_auth only.
  const nl = await s.call('/api/ads/session', { method: 'POST', headers: browser(s, [], true), body: JSON.stringify({ username: 'm', password: 'p' }) });
  assert.equal(nl.status, 409);
  assert.deepEqual(nl.body, { ok: false, error: 'Sign in to Grabbit again', reason: 'login_id_missing' });
  assert.equal(nl.headers.getSetCookie().some((c) => c.startsWith(`${LINK}=`) && !/Max-Age=0/.test(c)), false);
  const st = await s.call('/api/ads/session', { headers: browser(s, []) });
  assert.deepEqual(st.body, { ok: true, linked: false, reason: 'login_id_missing' });
  assert.equal(seen.length, before);

  // A fresh password sign-in issues the login id (__Host-, Secure, Strict).
  const { login, setCookie } = await freshLogin(s);
  assert.ok(login, 'login id issued');
  assert.match(setCookie.find((c) => c.startsWith(`${LOGIN}=`)), /Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);
  const linked = await s.call('/api/ads/session', { method: 'POST', headers: browser(s, [login], true), body: JSON.stringify({ username: 'm', password: 'p' }) });
  assert.equal(linked.status, 200, linked.text);
  const seal = cookieOf(linked.headers.getSetCookie(), LINK);
  assert.ok(seal);
  const me = await s.call('/api/ads/session', { headers: browser(s, [login, seal]) });
  assert.equal(me.body.linked, true);
  assert.deepEqual(Object.keys(me.body.user), ['id', 'username', 'display_name', 'role', 'permissions', 'avatar']);
  const lg = seen.find((x) => x.url === '/api/login');
  assert.equal(lg.headers.origin, APP);
  assert.equal(lg.headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(lg.headers.cookie, undefined);

  // Grabbit logout: login id and seal record dropped, upstream logout, both cookies cleared.
  const mark = seen.length;
  const out = await fetch(`${s.base}/logout`, { method: 'POST', headers: { Cookie: [s.headers.Cookie, login, seal].join('; ') }, redirect: 'manual' });
  assert.equal(out.status, 302);
  const cleared = out.headers.getSetCookie();
  for (const n of [LOGIN, LINK]) assert.ok(cleared.some((c) => c.startsWith(`${n}=;`) && /Max-Age=0/.test(c)), n);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(seen.slice(mark).some((x) => x.url === '/api/logout'), 'upstream logout, best effort');
  // Replay of the old cookies with a valid grabbit_auth: no link, no upstream call.
  const after = seen.length;
  const replay = await s.call('/api/ads/session', { headers: browser(s, [login, seal]) });
  assert.deepEqual(replay.body, { ok: true, linked: false, reason: 'login_id_missing' });
  const relink = await s.call('/api/ads/session', { method: 'POST', headers: browser(s, [login, seal], true), body: JSON.stringify({ username: 'm', password: 'p' }) });
  assert.equal(relink.status, 409);
  assert.equal(seen.length, after);
  // The log names no user, password or token.
  assert.ok(!/srv\d|"m"|password/.test(s.logs().split('\n').filter((l) => l.includes('[ads]')).join('\n')));
});

test('S3 over HTTP: unlink kills the seal; a replayed seal is unlinked', async (t) => {
  const s = await boot(t, { env: nativeEnv(), apps: false });
  const { login } = await freshLogin(s);
  const linked = await s.call('/api/ads/session', { method: 'POST', headers: browser(s, [login], true), body: JSON.stringify({ username: 'm', password: 'p' }) });
  const seal = cookieOf(linked.headers.getSetCookie(), LINK);
  const del = await s.call('/api/ads/session', { method: 'DELETE', headers: browser(s, [login, seal], true) });
  assert.equal(del.status, 200);
  const replay = await s.call('/api/ads/session', { headers: browser(s, [login, seal]) });
  assert.deepEqual(replay.body, { ok: true, linked: false });
  // Writes need the full configured origin.
  const foreign = await s.call('/api/ads/session', { method: 'DELETE', headers: { ...browser(s, [login], true), Origin: 'https://grabbit.example.com.evil.example' } });
  assert.equal(foreign.status, 403);
});

test('H2 boot drops: a changed password or mode drops every link; the cache generation follows the mode', async (t) => {
  const first = await boot(t, { env: nativeEnv(), apps: false });
  const { login } = await freshLogin(first);
  const linked = await first.call('/api/ads/session', { method: 'POST', headers: browser(first, [login], true), body: JSON.stringify({ username: 'm', password: 'p' }) });
  const seal = cookieOf(linked.headers.getSetCookie(), LINK);
  assert.ok(seal);
  const gen1 = first.call('/api/config').then((r) => cookieOf(r.headers.getSetCookie(), 'grabbit_cache_gen'));
  const g1 = await gen1;
  assert.match(g1, /^grabbit_cache_gen=\d+$/);
  const keep = path.join(first.root, 'keep');
  fs.mkdirSync(keep);
  for (const f of ['ads-seal-key.json', 'ads-logins.json', 'ads-mode.json']) fs.copyFileSync(path.join(first.dataDir, f), path.join(keep, f));
  const copy = (dataDir) => { for (const f of fs.readdirSync(keep)) fs.copyFileSync(path.join(keep, f), path.join(dataDir, f)); };

  // Same settings: the link survives a restart, and so does the generation.
  const same = await boot(t, { env: nativeEnv(), apps: false, seed: copy });
  assert.equal((await same.call('/api/ads/session', { headers: browser(same, [login, seal]) })).body.linked, true);
  const withGen = await same.call('/api/config', { headers: { Cookie: [same.headers.Cookie, g1].join('; ') } });
  assert.equal(withGen.headers.get('clear-site-data'), null);

  // A new Grabbit password: dropped.
  // (boot() signs in with the default password, so the new one is the default here.)
  const pw = await boot(t, { env: { ...nativeEnv(), GRABBIT_SECRET: 'rotated-secret' }, apps: false, seed: copy });
  assert.match(pw.logs(), /dropped [1-9]\d* link record/);

  // A new mode (embed) and back to native: dropped, generation bumped.
  const embed = await boot(t, { env: { ADSHORTIS_MODE: 'embed', ADSHORTIS_EMBED_URL: EMBED }, apps: false, seed: copy });
  const cfg = await embed.call('/api/config', { headers: { Cookie: [embed.headers.Cookie, g1].join('; ') } });
  assert.equal(cfg.headers.get('clear-site-data'), '"cache"');
  const g2 = cookieOf(cfg.headers.getSetCookie(), 'grabbit_cache_gen');
  assert.notEqual(g2, g1);
  assert.match(embed.logs(), /dropped [1-9]\d* link record/);
});

test('folder page (H1, H19, H46, H53): only with the flag, never in native; private, no-store', async (t) => {
  const rows = [
    ['off + flag', { ADSHORTIS_FOLDER_PAGE: '1' }, true],
    ['embed + flag', { ADSHORTIS_FOLDER_PAGE: '1', ADSHORTIS_MODE: 'embed', ADSHORTIS_EMBED_URL: EMBED }, true],
    ['off without flag', {}, false],
    ['native + flag', { ...nativeEnv(), ADSHORTIS_FOLDER_PAGE: '1' }, false],
  ];
  for (const [name, env, mounted] of rows) {
    await t.test(name, async (tt) => {
      const libRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-adslib-'));
      tt.after(() => fs.rmSync(libRoot, { recursive: true, force: true }));
      const s2 = await boot(tt, { env: { ...env, ADSHORTIS_LIBRARY: seedLibrary(libRoot) }, apps: false });
      const cfg = await s2.call('/api/config');
      assert.equal(cfg.body.adshortisLibrary, mounted, name);
      const list = await s2.call('/api/hub/adshortis');
      const file = await s2.call('/api/hub/adshortis/file?id=creator/clip.web.mp4&v=video&r=2');
      if (mounted) {
        assert.equal(list.status, 200, name);
        assert.equal(list.headers.get('cache-control'), 'private, no-store');
        assert.equal(file.status, 200, name);
        assert.equal(file.headers.get('cache-control'), 'private, no-store');
      } else {
        assert.equal(list.status, 404, name);
        assert.equal(file.status, 404, name);
      }
      if (env.ADSHORTIS_MODE === 'native') {
        // Retired routes: 404 with Clear-Site-Data even for a current generation.
        const gen = cookieOf(cfg.headers.getSetCookie(), 'grabbit_cache_gen');
        const again = await s2.call('/api/hub/adshortis', { headers: { Cookie: [s2.headers.Cookie, gen].join('; ') } });
        assert.equal(again.status, 404);
        assert.equal(again.headers.get('clear-site-data'), '"cache"');
        assert.match(s2.logs(), /ADSHORTIS_FOLDER_PAGE=1 is ignored/);
      }
    });
  }
});
