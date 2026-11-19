'use strict';
// The app adapters: Grabbit asks an app to change its own files, and every
// failure says that nothing was changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppAdapter, AdapterError, readToken, noAdapterReason } = require('../dupe-adapters');

const TOKEN = 'x'.repeat(40);

// A fetch stub that records each call and answers with `reply(url, init)`.
function stubFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return reply(url, init);
  };
  fn.calls = calls;
  return fn;
}
const jsonRes = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
    return body;
  },
});

function adapter(extra = {}) {
  return new AppAdapter({
    id: 'tikshortis', app: 'TikShortis', root: '/lib/tik', url: 'http://tik.internal:3000', token: TOKEN,
    caps: ['lookup', 'link', 'cache'], ...extra,
  });
}

const rejectsAdapter = async (p, { status, message }) => {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof AdapterError, `expected AdapterError, got ${e && e.constructor && e.constructor.name}`);
    if (status != null) assert.equal(e.status, status);
    if (message) assert.match(e.message, message);
    return true;
  });
};

test('readToken accepts a trimmed secret of 32 chars or more and nothing else', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-dupe-adapters-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };
  assert.equal(readToken(f('ok', `  ${'a'.repeat(32)}\n`)), 'a'.repeat(32));
  assert.equal(readToken(f('short', 'a'.repeat(31))), null);
  assert.equal(readToken(f('padded', `   ${'a'.repeat(31)}   \n`)), null, 'whitespace does not count toward the length');
  assert.equal(readToken(f('empty', '')), null);
  assert.equal(readToken(path.join(dir, 'missing')), null);
  assert.equal(readToken(dir), null, 'a directory is not a token');
  assert.equal(readToken(undefined), null);
  assert.equal(readToken(''), null);
});

test('ready() names what is missing and how to fix it', () => {
  assert.deepEqual(adapter().ready(), { ok: true });
  const noUrl = adapter({ url: null }).ready();
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.why, /not connected/);
  assert.match(noUrl.fix, /TIKSHORTIS_API_URL/);
  const egramNoUrl = adapter({ id: 'egram', app: 'egram', url: '' }).ready();
  assert.match(egramNoUrl.fix, /EGRAM_API_URL/);
  const noToken = adapter({ token: null }).ready();
  assert.equal(noToken.ok, false);
  assert.match(noToken.why, /share no dedupe key/);
  assert.match(noToken.fix, /GRABBIT_DEDUPE_TOKEN_FILE/);
});

test('a call without url or token never reaches the network', async () => {
  const fetchImpl = stubFetch(() => jsonRes(200, { items: [] }));
  await rejectsAdapter(adapter({ url: null, fetchImpl }).lookup(['a.mp4']), { status: 409, message: /not connected/ });
  await rejectsAdapter(adapter({ token: null, fetchImpl }).link('a.mp4', 'b.mp4', 'f'.repeat(64)), { message: /dedupe key/ });
  await rejectsAdapter(adapter({ token: '', fetchImpl }).restore(1), { message: /dedupe key/ });
  assert.equal(fetchImpl.calls.length, 0);
});

test('appPath without a prefix passes the rel through unchanged', () => {
  const a = adapter();
  assert.equal(a.appPath('main/ann/clip.mp4'), 'main/ann/clip.mp4');
});

test('appPath refuses a backslash, a legal Linux name character, instead of turning it into a slash', () => {
  for (const a of [adapter(), adapter({ prefix: 'tik' })]) {
    for (const bad of ['main\\ann\\clip.mp4', 'tik\\main\\clip.mp4', 'tik/main/a\\b.mp4']) {
      assert.throws(() => a.appPath(bad), (e) => e instanceof AdapterError && /backslash/.test(e.message), bad);
    }
  }
});

test('appPath with a prefix strips it and refuses anything outside it', () => {
  const a = adapter({ prefix: 'tik' });
  assert.equal(a.appPath('tik/main/clip.mp4'), 'main/clip.mp4');
  for (const bad of ['other/clip.mp4', 'tikshortis/clip.mp4', 'tik', 'clip.mp4', '/tik/clip.mp4', '']) {
    assert.throws(() => a.appPath(bad), (e) => e instanceof AdapterError && /Not a TikShortis library file/.test(e.message), bad);
  }
});

test('lookup sends the token header, JSON body and app paths, and maps answers back to Grabbit rels', async () => {
  const fetchImpl = stubFetch(() => jsonRes(200, { items: [
    { path: 'main/a.mp4', role: 'media', refs: [{ type: 'post', id: 7 }], nlink: 1, ino: 11 },
    { path: 'main/b.mp4', role: 'media', refs: [], nlink: 2, ino: 12 },
  ] }));
  const a = adapter({ prefix: 'tik', fetchImpl });
  const out = await a.lookup(['tik/main/a.mp4', 'tik/main/b.mp4']);
  assert.equal(fetchImpl.calls.length, 1);
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'http://tik.internal:3000/api/dedupe/v1/lookup');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['x-grabbit-dedupe-token'], TOKEN);
  assert.equal(c.init.headers['content-type'], 'application/json');
  assert.equal(c.init.redirect, 'error', 'a redirect must not carry the token elsewhere');
  assert.ok(c.init.signal, 'every call carries an abort signal for the timeout');
  assert.deepEqual(c.body, { paths: ['main/a.mp4', 'main/b.mp4'] });
  assert.deepEqual([...out.keys()], ['tik/main/a.mp4', 'tik/main/b.mp4']);
  assert.equal(out.get('tik/main/a.mp4').refs[0].id, 7);
});

test('lookup refuses a rel outside the prefix before any request', async () => {
  const fetchImpl = stubFetch(() => jsonRes(200, { items: [] }));
  await rejectsAdapter(adapter({ prefix: 'tik', fetchImpl }).lookup(['tik/ok.mp4', 'egram/x.jpg']), { message: /Not a TikShortis library file/ });
  assert.equal(fetchImpl.calls.length, 0);
});

test('link sends keep, drop and sha256 as app paths', async () => {
  const fetchImpl = stubFetch(() => jsonRes(200, { id: 3, bytes: 99 }));
  const sha = 'a'.repeat(64);
  const j = await adapter({ prefix: 'tik', fetchImpl }).link('tik/keep.mp4', 'tik/drop.mp4', sha);
  assert.deepEqual(j, { id: 3, bytes: 99 });
  assert.equal(fetchImpl.calls[0].url, 'http://tik.internal:3000/api/dedupe/v1/link');
  assert.deepEqual(fetchImpl.calls[0].body, { keep: 'keep.mp4', drop: 'drop.mp4', sha256: sha });
});

test('restore, purge and cacheClean coerce their inputs; cache is a GET without a body', async () => {
  const fetchImpl = stubFetch(() => jsonRes(200, { ok: true }));
  const a = adapter({ fetchImpl });
  await a.restore('12');
  await a.purge(13);
  await a.cacheClean('yes');
  await a.cacheClean(0);
  await a.cache();
  const [r, p, c1, c2, g] = fetchImpl.calls;
  assert.deepEqual([r.url.split('/v1/')[1], r.body], ['restore', { id: 12 }]);
  assert.deepEqual([p.url.split('/v1/')[1], p.body], ['purge', { id: 13 }]);
  assert.deepEqual([c1.url.split('/v1/')[1], c1.body], ['cache/clean', { dryRun: true }]);
  assert.deepEqual(c2.body, { dryRun: false });
  assert.equal(g.init.method, 'GET');
  assert.equal(g.init.body, undefined);
  assert.equal(g.url, 'http://tik.internal:3000/api/dedupe/v1/cache');
});

test('caps gate the operations: lookup without the cap is an empty Map, link and cacheClean throw, cache is null', async () => {
  const fetchImpl = stubFetch(() => jsonRes(200, { items: [{ path: 'a.mp4' }] }));
  const a = adapter({ caps: [], fetchImpl });
  const m = await a.lookup(['a.mp4']);
  assert.ok(m instanceof Map);
  assert.equal(m.size, 0);
  await rejectsAdapter(a.link('a.mp4', 'b.mp4', 'f'.repeat(64)), { message: /cannot share one file/ });
  assert.throws(() => a.cacheClean(true), (e) => e instanceof AdapterError && /no cache cleanup/.test(e.message));
  assert.equal(await a.cache(), null);
  assert.equal(fetchImpl.calls.length, 0, 'a missing cap never reaches the app');
  // The server's own wiring: egram has lookup + cache, no link.
  const egram = adapter({ id: 'egram', app: 'egram', caps: ['lookup', 'cache'], fetchImpl });
  await rejectsAdapter(egram.link('a.mp4', 'b.mp4', 'f'.repeat(64)), { message: /egram cannot share/ });
  assert.equal(fetchImpl.calls.length, 0);
});

test('an unreachable app is a 424 that says nothing was changed', async () => {
  // undici reports a refused connection as TypeError('fetch failed') with the code on `cause`.
  const fetchImpl = stubFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); });
  await rejectsAdapter(adapter({ fetchImpl }).link('a.mp4', 'b.mp4', 'f'.repeat(64)), { status: 424, message: /not reachable/ });
  try {
    await adapter({ fetchImpl }).restore(1);
  } catch (e) {
    assert.match(e.fix, /nothing was changed/);
  }
});

test('a timeout aborts the request and is a 424 that says nothing was changed', async () => {
  // Never answers until the signal aborts, like a hung app.
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const a = adapter({ fetchImpl, timeoutMs: 30 });
  const t0 = Date.now();
  await assert.rejects(a.lookup(['a.mp4']), (e) => {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.status, 424);
    assert.match(e.fix, /nothing was changed/);
    return true;
  });
  assert.ok(Date.now() - t0 < 2000);
});

test('a body that stalls after the headers still times out', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) });
  const a = adapter({ fetchImpl, timeoutMs: 30 });
  const outcome = await Promise.race([
    a.lookup(['a.mp4']).then(() => 'resolved', (e) => (e instanceof AdapterError && e.status === 424 ? 'timed out' : `other: ${e.message}`)),
    new Promise((r) => setTimeout(() => r('hung'), 500)),
  ]);
  assert.equal(outcome, 'timed out');
});

test('404 without an error body means the app lacks the dedupe routes (424)', async () => {
  for (const body of [undefined, null, {}, { message: 'Not Found' }]) {
    const fetchImpl = stubFetch(() => jsonRes(404, body));
    await rejectsAdapter(adapter({ fetchImpl }).lookup(['a.mp4']), { status: 424, message: /does not have the dedupe operations yet/ });
  }
});

test('404 with an app error is that app refusing (409, its message and fix)', async () => {
  const fetchImpl = stubFetch(() => jsonRes(404, { ok: false, error: 'No such post', fix: 'Rescan' }));
  await assert.rejects(adapter({ fetchImpl }).link('a.mp4', 'b.mp4', 'f'.repeat(64)), (e) => {
    assert.ok(e instanceof AdapterError);
    assert.equal(e.status, 409);
    assert.equal(e.message, 'No such post');
    assert.equal(e.fix, 'Rescan');
    return true;
  });
});

test('5xx from the app is a 424, never passed through as 5xx', async () => {
  for (const [status, body, msg] of [
    [500, { error: 'db locked' }, /db locked/],
    [502, undefined, /refused \(HTTP 502\)/],
    [503, { ok: false }, /refused \(HTTP 503\)/],
  ]) {
    const fetchImpl = stubFetch(() => jsonRes(status, body));
    await rejectsAdapter(adapter({ fetchImpl }).restore(1), { status: 424, message: msg });
  }
});

test('other refusals are 409: 4xx and ok:false on a 200', async () => {
  for (const [status, body] of [[403, { error: 'Bad token' }], [200, { ok: false, error: 'Bytes differ' }], [400, undefined]]) {
    const fetchImpl = stubFetch(() => jsonRes(status, body));
    await rejectsAdapter(adapter({ fetchImpl }).link('a.mp4', 'b.mp4', 'f'.repeat(64)), { status: 409 });
  }
});

test('a change whose outcome is unknown stays open (stalled): a reset after sending, or a 2xx with no JSON', async () => {
  for (const fetchImpl of [
    stubFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }),
    stubFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }); }),
    stubFetch(() => jsonRes(200, undefined)),
  ]) {
    await assert.rejects(adapter({ fetchImpl }).link('a.mp4', 'b.mp4', 'f'.repeat(64)), (e) => e.stalled === true && e.status === 424 && /may have been carried out/.test(e.fix));
    await assert.rejects(adapter({ fetchImpl }).restore('1:' + 'a'.repeat(32)), (e) => e.stalled === true);
  }
  // A lookup changes nothing, so a reset there is a plain failure.
  const reset = stubFetch(() => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); });
  await assert.rejects(adapter({ fetchImpl: reset, caps: ['lookup'] }).lookup(['a.mp4']), (e) => !e.stalled && /not reachable/.test(e.message));
});

test('noAdapterReason explains why an app copy cannot go', () => {
  assert.deepEqual(noAdapterReason(null), { why: 'Unknown folder', fix: null });
  assert.equal(noAdapterReason({ owner: 'grabbit' }), null);
  assert.match(noAdapterReason({ app: 'egram', importFor: 'egram' }).why, /import folder/);
  const r = noAdapterReason({ app: 'TikShortis', owner: 'tikshortis' });
  assert.match(r.why, /TikShortis owns this file/);
  assert.match(noAdapterReason({}).why, /This app owns/);
});

test('a change request that times out before the answer stays open (stalled), a lookup does not', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const a = adapter({ fetchImpl, timeoutMs: 30 });
  for (const p of [a.link('a.mp4', 'b.mp4', 'f'.repeat(64)), a.restore('7:u1'), a.purge('7:u1')]) {
    await assert.rejects(p, (e) => {
      assert.ok(e instanceof AdapterError);
      assert.equal(e.status, 424);
      assert.equal(e.stalled, true, 'the app may have done it: the operation stays pending');
      assert.match(e.fix, /may have been carried out/);
      return true;
    });
  }
  await assert.rejects(a.lookup(['a.mp4']), (e) => e.stalled !== true && /nothing was changed/.test(e.fix));
});

test('restore and purge send the id and uid of an "id:uid" reference, and the id alone for an old one', async () => {
  const fetchImpl = stubFetch(() => jsonRes(200, { ok: true }));
  const a = adapter({ fetchImpl });
  await a.restore('12:abc');
  await a.purge('13');
  assert.deepEqual(fetchImpl.calls.map((c) => c.body), [{ id: 12, uid: 'abc' }, { id: 13 }]);
});
