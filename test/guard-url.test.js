'use strict';
// Guard tests for URL safety (url-guard.js) and the extractor registry
// (extractors/index.js). Binding rules, CLAUDE.md "Security":
//  - every submitted URL goes through assertPublicUrl(); direct fetches use
//    safeFetch(), which re-checks each redirect hop;
//  - ::ffff:0:0/96 and 198.18.0.0/15 are deliberately NOT blocked;
//  - extractor match() compares the parsed hostname (exact or subdomain),
//    never a substring;
//  - `--` comes before the user URL in yt-dlp and gallery-dl argv.
// No test here touches the network: hosts are IP literals, `localhost`
// (resolved from /etc/hosts) or a stubbed global fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const guard = require('../url-guard');
const extractors = require('../extractors');

test('isAllowedAddress: blocked and allowed ranges', () => {
  const blocked = [
    '0.0.0.0', '0.255.255.255', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.168.1.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1',
    'not-an-ip', '', '1.2.3', '256.1.1.1',
  ];
  const allowed = [
    '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.0', '192.0.2.1', '192.167.255.255', '192.169.0.0', '223.255.255.255',
    // Deliberately allowed: Fake-IP proxies resolve real hosts into 198.18.0.0/15.
    '198.18.0.1', '198.19.255.254',
    // Deliberately allowed: an IPv4-mapped address is judged by its IPv4.
    '::ffff:8.8.8.8', '::ffff:1.1.1.1',
    '2001:4860:4860::8888', '2606:4700::1111',
  ];
  for (const ip of blocked) assert.equal(guard.isAllowedAddress(ip), false, `should block ${ip}`);
  for (const ip of allowed) assert.equal(guard.isAllowedAddress(ip), true, `should allow ${ip}`);
});

test('assertPublicUrl: schemes, literals and alternative encodings of private hosts', async () => {
  const refused = [
    ['file:///etc/passwd', /Refusing to fetch a file URL/],
    ['ftp://192.0.2.1/x', /Refusing to fetch a ftp URL/],
    ['javascript:alert(1)', /Refusing to fetch a javascript URL/],
    ['not a url', /Invalid URL/],
    ['', /Invalid URL/],
    ['http://127.0.0.1/', /non-public address 127\.0\.0\.1/],
    ['http://169.254.169.254/latest/meta-data/', /non-public address/],
    ['http://[::1]:8080/', /non-public address ::1/],
    ['http://[::ffff:127.0.0.1]/', /non-public address/],
    ['http://[fd00::1]/', /non-public address/],
    // WHATWG URL parsing normalises these to 127.0.0.1 / 10.0.0.1 before the check.
    ['http://2130706433/', /non-public address 127\.0\.0\.1/],
    ['http://0x7f.0.0.1/', /non-public address 127\.0\.0\.1/],
    ['http://0177.0.0.1/', /non-public address 127\.0\.0\.1/],
    ['http://127.1/', /non-public address 127\.0\.0\.1/],
    ['http://012.0.0.1/', /non-public address 10\.0\.0\.1/],
    // userinfo does not change the host that is checked.
    ['http://example.com@127.0.0.1/', /non-public address 127\.0\.0\.1/],
    ['http://localhost:3000/', /non-public address/],
  ];
  for (const [url, pattern] of refused) {
    await assert.rejects(guard.assertPublicUrl(url), pattern, url);
  }
  for (const url of ['https://192.0.2.1/x', 'http://198.18.0.5/x', 'https://[2001:4860:4860::8888]/x', 'https://127.0.0.1@192.0.2.1/x']) {
    await guard.assertPublicUrl(url); // must not throw
  }
});

test('ALLOW_PRIVATE_ADDRESSES: only an explicit truthy value turns the guard off', () => {
  const probe = (value) => {
    const env = { PATH: process.env.PATH };
    if (value !== undefined) env.ALLOW_PRIVATE_ADDRESSES = value;
    const r = spawnSync(
      process.execPath,
      ['-e', "require('./url-guard').assertPublicUrl('http://127.0.0.1/').then(() => console.log('open'), () => console.log('guarded'))"],
      { cwd: REPO, env, encoding: 'utf8' }
    );
    return r.stdout.trim();
  };
  for (const v of [undefined, '', '0', 'false', 'off', 'no', 'TRUE1']) assert.equal(probe(v), 'guarded', String(v));
  for (const v of ['1', 'true', 'TRUE', 'on', 'yes']) assert.equal(probe(v), 'open', v);
});

test('safeFetch: re-checks every redirect hop and never lets fetch follow redirects', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = [];
  const respond = (routes) => {
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), redirect: opts && opts.redirect });
      const to = routes[String(url)];
      if (to) return new Response(null, { status: 302, headers: { location: to } });
      return new Response('ok', { status: 200 });
    };
  };

  await t.test('a public URL redirecting to a private one is refused at the hop', async () => {
    calls.length = 0;
    respond({ 'https://192.0.2.1/start': 'http://169.254.169.254/latest/meta-data/' });
    await assert.rejects(guard.safeFetch('https://192.0.2.1/start'), /non-public address 169\.254\.169\.254/);
    assert.deepEqual(calls.map((c) => c.url), ['https://192.0.2.1/start'], 'the private hop must never be fetched');
    assert.ok(calls.every((c) => c.redirect === 'manual'));
  });

  await t.test('a relative Location is resolved against the current URL and checked', async () => {
    calls.length = 0;
    respond({ 'https://192.0.2.1/a': '/b', 'https://192.0.2.1/b': '//127.0.0.1/c' });
    await assert.rejects(guard.safeFetch('https://192.0.2.1/a'), /non-public address 127\.0\.0\.1/);
    assert.deepEqual(calls.map((c) => c.url), ['https://192.0.2.1/a', 'https://192.0.2.1/b']);
  });

  await t.test('public hops are followed and the final response returned', async () => {
    calls.length = 0;
    respond({ 'https://192.0.2.1/a': 'https://192.0.2.2/b' });
    const res = await guard.safeFetch('https://192.0.2.1/a');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(calls.map((c) => c.url), ['https://192.0.2.1/a', 'https://192.0.2.2/b']);
  });

  await t.test('a redirect loop stops after maxHops', async () => {
    calls.length = 0;
    respond({ 'https://192.0.2.1/a': 'https://192.0.2.1/b', 'https://192.0.2.1/b': 'https://192.0.2.1/a' });
    await assert.rejects(guard.safeFetch('https://192.0.2.1/a', {}, 3), /Too many redirects/);
    assert.equal(calls.length, 4);
  });

  await t.test('a private first URL is refused before any fetch', async () => {
    calls.length = 0;
    respond({});
    await assert.rejects(guard.safeFetch('http://10.1.2.3/'), /non-public address/);
    assert.equal(calls.length, 0);
  });
});

test('extractor registry: load filter and interface', () => {
  const files = fs.readdirSync(path.join(REPO, 'extractors')).filter((f) => f.endsWith('.js'));
  const expected = files.filter((f) => !['index.js', 'generic.js', 'util.js'].includes(f)).sort();
  assert.equal(extractors.siteExtractors.length, expected.length);
  for (const ex of extractors.siteExtractors) {
    assert.equal(typeof ex.name, 'string');
    assert.equal(typeof ex.match, 'function', ex.name);
    assert.equal(typeof ex.resolve, 'function', ex.name);
  }
  // The generic yt-dlp fallback never claims a URL itself; it is only the fallback.
  assert.equal(extractors.generic.match('https://www.youtube.com/watch?v=x'), false);
  assert.equal(extractors.pick('https://192.0.2.1/unknown'), extractors.generic);
});

// One URL each extractor must claim, so the negative cases below are not vacuous.
const SITES = [
  ['erome.com', '/a/AbC123'],
  ['imagefap.com', '/pictures/123/x'],
  ['nuditok.com', '/v/abc'],
  ['onlytik.com', '/v/abc'],
  ['reddclips.com', '/r/x/abc'],
  ['redgifs.com', '/watch/abc'],
  ['tik.porn', '/video/abc'],
  ['xfree.com', '/v/abc'],
  ['xxxfollow.com', '/u/abc'],
];

test('extractor match(): hostname only, never a substring of the URL', () => {
  assert.equal(SITES.length, extractors.siteExtractors.length, 'a new extractor needs a row in SITES');
  for (const [host, p] of SITES) {
    const good = extractors.pick(`https://www.${host}${p}`);
    assert.notEqual(good, extractors.generic, `${host} is not claimed by any extractor`);
    for (const bad of [
      `https://attacker.example/${host}${p}`,
      `https://attacker.example${p}?u=https://${host}${p}`,
      `https://${host}.attacker.example${p}`,
      `https://not${host.replace(/^tik\./, 'tik-')}${p}`,
      `https://${host}@attacker.example${p}`,
      `https://attacker.example/#${host}`,
    ]) {
      assert.equal(extractors.pick(bad), extractors.generic, `${bad} was claimed by ${extractors.pick(bad).name}`);
    }
  }
});

test('resolve() and resolveProfile() run the URL guard before any extractor', async (t) => {
  const touched = [];
  const all = [...extractors.siteExtractors, extractors.generic];
  const saved = all.map((ex) => [ex, ex.resolve, ex.resolveProfile]);
  t.after(() => {
    for (const [ex, r, rp] of saved) {
      ex.resolve = r;
      if (rp) ex.resolveProfile = rp;
    }
  });
  for (const ex of all) {
    ex.resolve = async () => touched.push(ex.name);
    if (ex.resolveProfile) ex.resolveProfile = async () => touched.push(ex.name);
  }
  for (const [host, p] of SITES) {
    // A private literal: the hostname no longer matches the site, so this is
    // the generic path; the guard must refuse it before yt-dlp sees it.
    await assert.rejects(extractors.resolve(`http://127.0.0.1/${host}${p}`), /non-public address/);
  }
  await assert.rejects(extractors.resolve('http://[::1]/x'), /non-public address/);
  await assert.rejects(extractors.resolveProfile('http://10.0.0.1/x'), /non-public address/);
  await assert.rejects(extractors.resolve('file:///etc/passwd'), /Refusing to fetch a file URL/);
  assert.deepEqual(touched, []);
});

test('yt-dlp and gallery-dl argv in extractors put `--` before the URL', () => {
  const dir = path.join(REPO, 'extractors');
  let checked = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // Every argv array literal that ends with the url variable. The one
    // exception is xfree.js's `python -c <code> url`, where the URL is
    // sys.argv[1] of an inline script, not an option parser's operand.
    for (const m of src.matchAll(/\[([^\[\]]*),\s*url\s*\]/g)) {
      if (/^\s*'-c',\s*code\s*$/.test(m[1])) continue;
      checked++;
      assert.match(m[1], /'--'\s*$/, `${f}: ${m[0]}`);
    }
  }
  assert.ok(checked >= 3, `expected at least the generic and imagefap argv lists, found ${checked}`);
});

// D2 (open owner decision): eight extractors call plain fetch() rather than
// safeFetch(). This pins the list so a NEW plain fetch cannot slip in
// unreviewed; migrating a file off the list is fine and does not fail here.
// The desired end state is in test/known-gaps.test.js.
const D2_PLAIN_FETCH = ['erome.js', 'imagefap.js', 'nuditok.js', 'onlytik.js', 'reddclips.js', 'redgifs.js', 'tikporn.js', 'xxxfollow.js'];

test('D2: no extractor beyond the documented eight calls plain fetch()', () => {
  const dir = path.join(REPO, 'extractors');
  const plain = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /(^|[^.\w])fetch\(/m.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort();
  const unexpected = plain.filter((f) => !D2_PLAIN_FETCH.includes(f));
  assert.deepEqual(unexpected, [], 'a new extractor fetches without safeFetch(); see D2 in documentation/open-decisions.md');
});

module.exports = { D2_PLAIN_FETCH };
