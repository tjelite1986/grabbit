'use strict';
// Guard tests for the HTTP gate in server.js: who gets in, with which status
// code and body shape, and which requests are refused before the session is
// consulted. These pin today's contract so a later split of server.js cannot
// change it unnoticed. Binding rules: CLAUDE.md "Contracts with callers and
// deployments" (internal secret, cross-site refusal, 422 not 5xx).
//
// Jobs are always started with `at` a year ahead, so they are only scheduled:
// nothing is resolved or downloaded, and no network is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, PASSWORD, INTERNAL_TOKEN, FUTURE } = require('./helpers/guard-server');

const until = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const scheduledIds = (s) => {
  try {
    return s.readJson('scheduled.json').map((x) => x.id);
  } catch {
    return [];
  }
};
const startQuery = (extra = {}) =>
  new URLSearchParams({ url: 'https://example.com/clip/1', dest: 'server', channel: 'main', device: '0', at: String(FUTURE()), ...extra });

test('authentication gate', async (t) => {
  const s = await boot(t);

  await t.test('the shared password sets an HttpOnly, Secure, SameSite=Lax session cookie and redirects to /', async () => {
    const r = await s.login();
    assert.equal(r.status, 302);
    assert.equal(r.location, '/');
    assert.match(r.cookie, /^grabbit_auth=[0-9a-f]{64}$/);
    const raw = r.setCookie.find((v) => v.startsWith('grabbit_auth='));
    assert.match(raw, /;\s*HttpOnly/i);
    assert.match(raw, /;\s*Secure/i);
    assert.match(raw, /;\s*SameSite=Lax/i);
    // The same password always yields the same session value (HMAC of the password).
    assert.equal((await s.login()).cookie, r.cookie);
  });

  await t.test('a wrong or missing password is a 401 HTML page with no cookie', async () => {
    for (const body of ['password=wrong', 'password=', '']) {
      const r = await fetch(`${s.base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });
      assert.equal(r.status, 401, body);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.equal(r.headers.getSetCookie().filter((v) => /^grabbit_auth=[^;]/.test(v)).length, 0);
      await r.text();
    }
  });

  await t.test('unauthenticated API calls get 401 JSON; pages redirect to /login', async () => {
    for (const p of ['/api/history', '/api/jobs', '/api/jobs/start?url=https://example.com/x', '/api/download?url=https://example.com/x']) {
      const r = await s.call(p, { headers: {} });
      assert.equal(r.status, 401, p);
      assert.deepEqual(r.body, { ok: false, error: 'Unauthorized' }, p);
    }
    // Upper-case /API/ reaches the same Express routes, but the 401 branch
    // matches '/api/' case-sensitively, so it is redirected to the login page
    // instead. Either way nothing is served without a session.
    const upper = await s.call('/API/history', { headers: {} });
    assert.equal(upper.status, 302);
    assert.equal(upper.headers.get('location'), '/login');
    const v1 = await s.call('/api/v1/whoami', { headers: {} });
    assert.equal(v1.status, 401);
    assert.equal(v1.body.ok, false);
    assert.equal(v1.body.error.code, 'unauthorized');
    const page = await s.call('/', { headers: {} });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
  });

  await t.test('a forged session cookie is treated as no session', async () => {
    const r = await s.call('/api/history', { headers: { Cookie: `grabbit_auth=${'0'.repeat(64)}` } });
    assert.equal(r.status, 401);
  });

  await t.test('public assets and the release probe need no session', async () => {
    assert.equal((await s.call('/sw.js', { headers: {} })).status, 200);
    assert.equal((await s.call('/manifest.webmanifest', { headers: {} })).status, 200);
    const rel = await s.call('/api/health/release', { headers: {} });
    assert.equal(rel.status, 200, rel.text);
    assert.deepEqual(Object.keys(rel.body), ['sha'], rel.text);
    assert.equal(rel.headers.get('cache-control'), 'no-store');
  });

  await t.test('the owner session reaches the API', async () => {
    const r = await s.call('/api/history');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

test('internal principal: recognised only by the exact secret, never by a missing header', async (t) => {
  const s = await boot(t);

  await t.test('the right secret is admitted without a cookie', async () => {
    const r = await s.call('/api/history', { headers: { 'X-Grabbit-Token': INTERNAL_TOKEN } });
    assert.equal(r.status, 200);
  });

  await t.test('no credential at all is refused (absence of X-Forwarded-Host is not trust)', async () => {
    // The 2026 regression: a request without X-Forwarded-Host counted as internal.
    assert.equal((await s.call('/api/history', { headers: {} })).status, 401);
    assert.equal((await s.call(`/api/jobs/start?${startQuery()}`, { headers: {} })).status, 401);
  });

  await t.test('a wrong, empty or differently cased secret is refused', async () => {
    // (Surrounding whitespace is not tested: HTTP strips it from header values.)
    for (const v of ['wrong', '', INTERNAL_TOKEN.toUpperCase(), `${INTERNAL_TOKEN}x`, INTERNAL_TOKEN.slice(0, -1)]) {
      const r = await s.call('/api/history', { headers: { 'X-Grabbit-Token': v } });
      assert.equal(r.status, 401, JSON.stringify(v));
    }
  });

  await t.test('the right secret through the proxy (X-Forwarded-Host set) is not internal', async () => {
    const r = await s.call('/api/history', { headers: { 'X-Grabbit-Token': INTERNAL_TOKEN, 'X-Forwarded-Host': 'grabbit.example.com' } });
    assert.equal(r.status, 401);
  });

  await t.test('the internal principal may start jobs on every target and keeps owner-only parameters', async () => {
    const before = scheduledIds(s).length;
    const r = await s.call(`/api/jobs/start?${startQuery({ dest: 'elite', channel: '18plus', folder: 'custom-folder' })}`, {
      headers: { 'X-Grabbit-Token': INTERNAL_TOKEN },
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), ['jobId', 'ok', 'scheduled']);
    assert.equal(scheduledIds(s).length, before + 1);
    const sched = s.readJson('scheduled.json').find((x) => x.id === r.body.jobId);
    assert.equal(sched.params.folder, 'custom-folder');
    assert.equal(sched.clientId, 'internal');
  });
});

test('without GRABBIT_INTERNAL_TOKEN the internal header opens nothing', async (t) => {
  const s = await boot(t, { internalToken: null });
  for (const v of ['', 'undefined', 'null', INTERNAL_TOKEN]) {
    const r = await s.call('/api/history', { headers: { 'X-Grabbit-Token': v } });
    assert.equal(r.status, 401, JSON.stringify(v));
  }
});

test('cross-site requests to /api/* are refused before the session is used', async (t) => {
  const s = await boot(t);
  const blocked = { ok: false, error: 'Cross-site request blocked' };
  const host = new URL(s.base).host;

  await t.test('Sec-Fetch-Site: cross-site on the three GETs with side effects', async () => {
    const before = scheduledIds(s);
    for (const p of [`/api/jobs/start?${startQuery()}`, '/api/download?url=https://example.com/x', '/api/download-all?url=https://example.com/x', `/API/jobs/start?${startQuery()}`]) {
      const r = await s.call(p, { headers: { ...s.headers, 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.body, blocked, p);
    }
    assert.deepEqual(scheduledIds(s), before, 'a refused request must not schedule a job');
  });

  await t.test('an unauthenticated cross-site request gets the same 403, not a 401', async () => {
    // The cross-site check runs before the session is consulted, so a caller
    // with no credential at all learns nothing more than a signed-in one.
    for (const h of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://attacker.example' }]) {
      const r = await s.call(`/api/jobs/start?${startQuery()}`, { headers: h });
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.deepEqual(r.body, blocked, JSON.stringify(h));
    }
  });

  await t.test('the internal secret does not lift the cross-site refusal', async () => {
    const r = await s.call(`/api/jobs/start?${startQuery()}`, { headers: { ...s.internal, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
  });

  await t.test('a foreign, malformed or schemeless Origin is refused', async () => {
    for (const origin of ['https://attacker.example', `https://${host}.attacker.example`, 'not a url', `http://${host}:1`]) {
      const r = await s.call('/api/history', { headers: { ...s.headers, Origin: origin } });
      assert.equal(r.status, 403, origin);
      assert.deepEqual(r.body, blocked, origin);
    }
  });

  // Current behaviour, documented for the owner: `Origin: null` (sandboxed
  // frames, some redirects) is let through, and Origin is compared by host
  // only, so the scheme and a default port are not checked. CLAUDE.md says
  // "any Origin that doesn't match"; these exceptions are narrower than that
  // wording and are pinned here so a change is deliberate.
  await t.test('same-origin, same-site and no-header requests pass', async () => {
    for (const h of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'none' }, { Origin: `http://${host}` }, { Origin: 'null' }, {}]) {
      const r = await s.call('/api/history', { headers: { ...s.headers, ...h } });
      assert.equal(r.status, 200, JSON.stringify(h));
    }
  });

  await t.test('behind the proxy the Origin is compared with X-Forwarded-Host', async () => {
    const h = { ...s.headers, 'X-Forwarded-Host': 'grabbit.example.com' };
    assert.equal((await s.call('/api/history', { headers: { ...h, Origin: 'https://grabbit.example.com' } })).status, 200);
    assert.equal((await s.call('/api/history', { headers: { ...h, Origin: `http://${host}` } })).status, 403);
  });

  await t.test('non-API pages are not subject to the API cross-site check', async () => {
    const r = await s.call('/', { headers: { ...s.headers, 'Sec-Fetch-Site': 'cross-site' } });
    assert.notEqual(r.status, 403);
  });
});

test('job start: parameter validation and response shape', async (t) => {
  const s = await boot(t);

  await t.test('a missing, non-http or malformed URL is 400 JSON and schedules nothing', async () => {
    const before = scheduledIds(s);
    for (const url of [null, '', 'example.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/x', 'http://']) {
      const q = startQuery();
      if (url === null) q.delete('url');
      else q.set('url', url);
      const r = await s.call(`/api/jobs/start?${q}`);
      assert.equal(r.status, 400, String(url));
      assert.deepEqual(r.body, { ok: false, error: 'Invalid URL' }, String(url));
    }
    assert.deepEqual(scheduledIds(s), before);
  });

  await t.test('cutting or splitting outside the server and audiobook libraries is 400', async () => {
    for (const extra of [{ dest: 'elite', split: '1' }, { dest: 'elite', sections: '0:10-0:20' }]) {
      const r = await s.call(`/api/jobs/start?${startQuery(extra)}`);
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.deepEqual(r.body, { ok: false, error: 'Cutting/splitting is only supported for the server and audiobook libraries.' });
    }
    const bad = await s.call(`/api/jobs/start?${startQuery({ sections: 'nonsense' })}`);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^Bad cut section/);
  });

  await t.test('route=smart is refused for audio, non-video destinations and cuts', async () => {
    for (const [extra, msg] of [
      [{ route: 'smart', audio: '1' }, /only routes video saves/],
      [{ route: 'smart', dest: 'navidrome' }, /only routes video saves/],
      [{ route: 'smart', split: '1' }, /cannot be combined with cutting or splitting/],
    ]) {
      const r = await s.call(`/api/jobs/start?${startQuery(extra)}`);
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.match(r.body.error, msg, JSON.stringify(extra));
    }
  });

  await t.test('a scheduled job: 200 { ok, jobId, scheduled }, listed as scheduled, persisted in scheduled.json', async () => {
    const r = await s.call(`/api/jobs/start?${startQuery()}`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['jobId', 'ok', 'scheduled']);
    assert.equal(r.body.scheduled, true);
    assert.equal(typeof r.body.jobId, 'string');
    const { body } = await s.call('/api/jobs');
    const j = body.jobs.find((x) => x.id === r.body.jobId);
    assert.equal(j.status, 'scheduled');
    const sched = s.readJson('scheduled.json').find((x) => x.id === r.body.jobId);
    assert.equal(sched.params.url, 'https://example.com/clip/1');
    assert.equal(sched.clientId, 'legacy-shared');
  });

  await t.test('an `at` in the past or unparseable does not schedule (the job would run now)', async () => {
    // Characterisation only: such an `at` makes the job immediate. The URL is
    // a TEST-NET literal (no DNS lookup) and yt-dlp is /bin/false, so the
    // resolve fails and nothing leaves the machine.
    const before = scheduledIds(s);
    for (const at of ['1', 'not-a-date']) {
      const r = await s.call(`/api/jobs/start?${startQuery({ url: 'https://192.0.2.1/clip/now', at })}`);
      assert.equal(r.status, 200, `${at}: ${r.text}`);
      assert.equal(r.body.scheduled, false, at);
    }
    assert.deepEqual(scheduledIds(s), before, 'an immediate job must not be written to scheduled.json');
  });

  await t.test('cancel: scheduled jobs only; unknown id is 404; cancelled jobs leave scheduled.json', async () => {
    const r = await s.call(`/api/jobs/start?${startQuery()}`);
    const id = r.body.jobId;
    const c = await s.call(`/api/jobs/${id}/cancel`, { method: 'POST' });
    assert.equal(c.status, 200);
    assert.deepEqual(c.body, { ok: true });
    assert.ok(!scheduledIds(s).includes(id));
    const { body } = await s.call('/api/jobs');
    assert.equal(body.jobs.find((x) => x.id === id).status, 'cancelled');
    const again = await s.call(`/api/jobs/${id}/cancel`, { method: 'POST' });
    assert.equal(again.status, 400);
    const missing = await s.call('/api/jobs/no-such-job/cancel', { method: 'POST' });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { ok: false, error: 'Job not found' });
  });

  await t.test('the synchronous /api/download keeps its plain-text 400 for a bad URL', async () => {
    const r = await s.call('/api/download?url=notaurl&device=0');
    assert.equal(r.status, 400);
    assert.equal(r.text, 'Invalid URL');
  });

  await t.test('synchronous /api/download failures are 422, never 5xx, at each stage', async () => {
    // yt-dlp is /bin/false and 192.0.2.1 is a literal (no DNS lookup), so
    // nothing leaves the machine. 422 keeps Cloudflare from replacing the body.
    // The generic resolve tolerates a failed probe, so the two destinations
    // fail at different later stages; each is pinned with its own body.
    const at = (dest) => s.call(`/api/download?url=https://192.0.2.1/v/1&device=0&dest=${dest}`);
    // Shorts: refused by the audience gate (unknown creator, general app), JSON.
    const elite = await at('elite');
    assert.equal(elite.status, 422, elite.text);
    assert.equal(elite.body.ok, false, elite.text);
    assert.match(elite.body.error, /is not classified/, elite.text);
    // Server library: the download itself fails, plain text.
    const server = await at('server');
    assert.equal(server.status, 422, server.text);
    assert.match(server.text, /^Download failed: yt-dlp exited 1/, server.text);
    for (const r of [elite, server]) assert.doesNotMatch(r.text, /<html/i);
  });

  await t.test('a private address is refused by the URL guard with 422', async () => {
    for (const url of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://10.0.0.1/x']) {
      const r = await s.call(`/api/download?url=${encodeURIComponent(url)}&device=0`);
      assert.equal(r.status, 422, url);
      assert.match(r.text, /non-public address/, url);
    }
  });
});

test('route=smart access (D3, characterised; the decision stays with the owner)', async (t) => {
  const s = await boot(t, {
    seed: (dataDir) => {
      const gda = require('../gda');
      const reg = gda.createRegistry({ file: path.join(dataDir, 'gda-clients.json'), sessionSecret: 'x' });
      reg.upsertClient({
        client_id: 'guard-app',
        audience: 'general',
        allowed_targets: ['legacy.tikshortis', 'server.downloads'],
        allowed_ops: ['job', 'status'],
        legacy_main_target: 'legacy.tikshortis',
      });
      fs.writeFileSync(path.join(dataDir, 'guard-app.pw'), reg.setPassword('guard-app'));
    },
  });
  const smart = startQuery({ dest: 'elite', route: 'smart' });

  await t.test('the owner session may request smart routing', async () => {
    const r = await s.call(`/api/jobs/start?${smart}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(s.readJson('scheduled.json').find((x) => x.id === r.body.jobId).params.route, 'smart');
  });

  await t.test('an app client is refused with 400', async () => {
    const pw = fs.readFileSync(path.join(s.dataDir, 'guard-app.pw'), 'utf8');
    const { cookie } = await s.login(pw);
    assert.ok(cookie);
    const r = await s.call(`/api/jobs/start?${smart}`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: 'route=smart is only available to the owner.' });
  });

  await t.test('D3: the internal principal is admitted today (spec says owner web UI only)', async () => {
    // Current behaviour, pinned so a change is deliberate. The desired
    // behaviour, if the owner decides so, is in test/known-gaps.test.js.
    const r = await s.call(`/api/jobs/start?${smart}`, { headers: s.internal });
    assert.equal(r.status, 200, r.text);
    assert.equal(s.readJson('scheduled.json').find((x) => x.id === r.body.jobId).params.route, 'smart');
  });

  await t.test('the shared password is the owner (legacy-shared), not an app', async () => {
    assert.ok(PASSWORD);
    const r = await s.call('/api/v1/whoami');
    assert.equal(r.body.data.client_id, 'legacy-shared');
    assert.equal(r.body.data.audience, 'admin');
  });
});

test('rules: every field is validated server-side; a refused save leaves the stored rules intact', async (t) => {
  const stored = [{ id: 'r1', name: 'Keep', enabled: true, auto: false, match: { site: 'example' }, apply: { dest: 'server' } }];
  const s = await boot(t, { seed: (d) => fs.writeFileSync(path.join(d, 'rules.json'), JSON.stringify(stored)) });
  const post = (rules) =>
    s.call('/api/rules', { method: 'POST', headers: { ...s.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ rules }) });
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(s.dataDir, 'rules.json'), 'utf8'));

  await t.test('an invalid or catastrophic regex is 400 with the reason, nothing written', async () => {
    for (const [pattern, reason] of [
      ['/(unclosed/', /not a valid regular expression/],
      ['/(a+)+$/', /can hang the server/],
    ]) {
      const r = await post([{ name: 'Bad', match: { title: pattern }, apply: { dest: 'server' } }]);
      assert.equal(r.status, 400, pattern);
      assert.equal(r.body.ok, false);
      assert.match(r.body.error, reason, pattern);
      assert.match(r.body.error, /"Bad" title/, pattern);
      assert.deepEqual(onDisk(), stored, `${pattern}: the stored rules changed`);
    }
    const notList = await post('not a list');
    assert.equal(notList.status, 400);
    assert.deepEqual(notList.body, { ok: false, error: 'Invalid rules payload' });
    assert.deepEqual(onDisk(), stored);
  });

  await t.test('values outside each enum are dropped, never stored or replayed', async () => {
    const r = await post([
      {
        id: 'r2',
        name: 'Enums',
        match: { site: 'example', mediaType: 'script' },
        apply: {
          dest: '/etc', lib: 'root', channel: 'nope', quality: '9999', afmt: 'exe', aq: '1', container: 'sh',
          sponsor: 'all', device: 'yes', audio: 'true', web: 1, folder: '../../escape', extra: '--exec id',
        },
      },
    ]);
    assert.equal(r.status, 200, r.text);
    const [rule] = onDisk();
    assert.deepEqual(rule.match, { site: 'example' });
    // Only the folder survives, and only as a sanitised folder name.
    assert.deepEqual(Object.keys(rule.apply), ['folder'], JSON.stringify(rule.apply));
    assert.doesNotMatch(rule.apply.folder, /\.\.|\//, JSON.stringify(rule.apply));
    assert.deepEqual((await s.call('/api/rules')).body.rules, onDisk());
  });
});

test('synchronous co-hosted endpoints: /api/resolve, /api/download (device=0) and /api/download-all', async (t) => {
  await t.test('/api/resolve failures are 422 JSON, never 5xx', async (tt) => {
    const s = await boot(tt);
    for (const url of ['http://127.0.0.1/x', 'http://[::1]/x']) {
      const r = await s.call(`/api/resolve?url=${encodeURIComponent(url)}`, { headers: s.internal });
      assert.equal(r.status, 422, `${url}: ${r.text}`);
      assert.equal(r.body.ok, false, r.text);
      assert.match(r.body.error, /non-public address/, url);
      assert.deepEqual(Object.keys(r.body).sort(), ['error', 'ok']);
    }
    const bad = await s.call('/api/resolve?url=notaurl', { headers: s.internal });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { ok: false, error: 'Invalid URL' });
  });

  await t.test('/api/download-all: a refused profile URL is one SSE error event, then the stream ends', async (tt) => {
    const s = await boot(tt);
    const r = await s.call(`/api/download-all?url=${encodeURIComponent('http://127.0.0.1/profile')}&dest=server`, { headers: s.internal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/event-stream/);
    // An SSE client dispatches an event only at the blank line that ends it.
    assert.ok(r.text.endsWith('\n\n'), JSON.stringify(r.text));
    const events = r.text.split('\n\n').filter(Boolean);
    assert.equal(events.length, 1, r.text);
    assert.match(events[0], /^data: /);
    const ev = JSON.parse(events[0].slice('data: '.length));
    assert.equal(ev.type, 'error');
    assert.match(ev.error, /non-public address/);
  });

  // The media boot turns the URL guard off (ALLOW_PRIVATE_ADDRESSES) so the
  // server can fetch from the loopback fixture; these cases test shapes, not
  // the guard.
  await t.test('internal device=0 save: 200 JSON in the shape of each destination, and a history row', async (tt) => {
    // The creator needs a classified profile, or the general Shorts app refuses the clip.
    const s = await boot(tt, {
      media: true,
      seed: (dataDir) => {
        const profiles = require('../profiles');
        const store = profiles.create(profiles.emptyStore(), { name: 'Jane Doe', audience: 'general' }, 1).store;
        fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(store));
      },
    });
    for (const [dest, keys, extra] of [
      // The Shorts import (co-hosted apps): channel and file name.
      ['elite', ['channel', 'filename', 'ok', 'saved'], { channel: 'main' }],
      // The server library: its own shape, with the shelf it landed on.
      ['server', ['dest', 'dir', 'filename', 'ok', 'saved'], { dest: 'server' }],
    ]) {
      const url = s.fakeUrl('video', 'youtube', 'Jane Doe', `sync-${dest}`, '?w=1080&h=1920&dur=20');
      const r = await s.call(`/api/download?${new URLSearchParams({ url, dest, channel: 'main', device: '0' })}`, { headers: s.internal });
      assert.equal(r.status, 200, `${dest}: ${r.text}\n${s.logs()}`);
      assert.match(r.headers.get('content-type'), /application\/json/, dest);
      assert.deepEqual(Object.keys(r.body).sort(), keys, `${dest}: ${r.text}`);
      assert.equal(r.body.ok, true, dest);
      assert.equal(r.body.saved, true, dest);
      assert.equal(typeof r.body.filename, 'string', dest);
      for (const [k, v] of Object.entries(extra)) assert.equal(r.body[k], v, `${dest}: ${k}`);
      const rows = (await s.call('/api/history')).body.items.filter((h) => h.sourceUrl === url);
      assert.equal(rows.length, 1, `${dest}: ${JSON.stringify(rows)}`);
      assert.equal(rows[0].filename, r.body.filename, dest);
    }
  });

  await t.test('/api/download-all streams: each event arrives while later items are still downloading', async (tt) => {
    const s = await boot(tt, { media: true });
    s.media.state.mode = 'hold';
    const url = 'http://fake.test/profile/youtube/Jane%20Doe/2';
    const res = await fetch(`${s.base}/api/download-all?${new URLSearchParams({ url, dest: 'server' })}`, {
      headers: s.internal,
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let ended = false;
    // Next complete event (`data: <json>` + blank line), or null at EOF.
    const next = async () => {
      for (;;) {
        const cut = buf.indexOf('\n\n');
        if (cut >= 0) {
          const raw = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          assert.match(raw, /^data: [^\n]*$/, raw);
          return JSON.parse(raw.slice('data: '.length));
        }
        if (ended) {
          assert.equal(buf, '', `trailing bytes after the last event: ${JSON.stringify(buf)}`);
          return null;
        }
        const { value, done } = await reader.read();
        if (done) ended = true;
        else buf += decoder.decode(value, { stream: true });
      }
    };
    const p1 = '/media/Jane%20Doe-p1/clip.mp4';
    const p2 = '/media/Jane%20Doe-p2/clip.mp4';
    const start = await next();
    assert.deepEqual([start.type, start.total], ['start', 2], JSON.stringify(start));
    await until(() => s.media.heldPaths().includes(p1), 'item 1 to be requested');
    s.media.releaseOne(p1);
    const first = await next();
    assert.deepEqual([first.type, first.index, first.status], ['progress', 1, 'saved'], JSON.stringify(first));
    // Item 2 is still held, so the event above was streamed, not buffered.
    await until(() => s.media.heldPaths().includes(p2), 'item 2 to be requested');
    assert.equal(s.media.heldCount(), 1);
    s.media.releaseOne(p2);
    const second = await next();
    assert.deepEqual([second.type, second.index, second.status], ['progress', 2, 'saved'], JSON.stringify(second));
    assert.deepEqual(await next(), { type: 'done', saved: 2, skipped: 0, failed: 0 });
    assert.equal(await next(), null, 'the stream must end after done');
  });
});
