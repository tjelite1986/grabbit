'use strict';
// Grabbit 3.0 native Adshortis, phase 1: S5 isolation (PHASE1_GATEWAY_TESTS 7).
// A native Adshortis route never answers a general hub view, and general code
// never lists, searches or mirrors Adshortis objects. Static checks over the
// sources plus the other gateways' allowlists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tikGateway = require('../tikshortis-gateway');
const egramGateway = require('../egram-gateway');

const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const ADS_REF = /\/api\/ads\b|grabbit\.ads\.|__Host-grabbit_ads|as_session/;

function filesUnder(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(rel, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

test('S5: no general page or module references /api/ads or grabbit.ads.*', () => {
  const general = [
    ...filesUnder('public/hub/tik', ['.js', '.html']),
    // Adshortis phase 2: the shared player and helpers serve both modules,
    // so they name neither product's API nor its keys.
    ...filesUnder('public/hub/shared', ['.js']),
    ...filesUnder('public/hub/social', ['.js', '.html']),
    ...filesUnder('public/hub/dupes', ['.js', '.html']),
    'public/index.html',
    'public/sw.js',
    'public/hub/index.html',
  ].filter((f) => fs.existsSync(path.join(REPO, f)));
  assert.ok(general.length >= 5, 'the general sources were found');
  for (const f of general) assert.ok(!ADS_REF.test(read(f)), f);
});

test('S5: hub.js reaches /api/ads only to end the link at sign-out', () => {
  const lines = read('public/hub/hub.js').split('\n').filter((l) => ADS_REF.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /fetch\('\/api\/ads\/session', \{ method: 'DELETE'/);
  // The global search goes to TikShortis, Social or Media, never to the module.
  const search = read('public/hub/hub.js').split("$('#searchForm').addEventListener")[1].split('});')[0];
  assert.ok(!/ads/i.test(search), 'global search never routes to Adshortis');
});

test('S5: the TikShortis and Elitogram gateways know nothing of Adshortis and refuse its shapes', () => {
  for (const f of ['tikshortis-gateway.js', 'egram-gateway.js']) {
    const src = read(f);
    assert.ok(!ADS_REF.test(src), f);
    assert.ok(!/require\(['"]\.\/(adshortis-gateway|ads-links|ads-route-matrix)['"]\)/.test(src), f);
  }
  for (const [method, p] of [['GET', 'ads/session'], ['POST', 'ads/session'], ['GET', 'clips/1'], ['GET', 'm/video/1'], ['GET', 'm/avatar/user/7'], ['POST', 'login']]) {
    assert.equal(tikGateway.matchRoute(method, p), null, `tik ${method} ${p}`);
  }
  for (const [method, p] of [['GET', '/api/ads/session'], ['GET', '/api/clips/1'], ['GET', '/m/video/1'], ['POST', '/api/login']]) {
    assert.equal(egramGateway.matchRoute(method, p), null, `egram ${method} ${p}`);
  }
});

test('S5/S15: server.js uses the Adshortis gateway only at its mount, /login and /logout; no profile mirroring', () => {
  const src = read('server.js');
  const uses = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /ADS_GATEWAY\b/.test(l) && !/^\s*\/\//.test(l));
  const at = (n) => {
    // The enclosing route or block for line n: the nearest app.<verb>( or if ( above it.
    const before = src.split('\n').slice(0, n).reverse();
    return before.find((l) => /^(app\.(get|post|use|all)\(|if \(ADS_GATEWAY\)|const ADS_GATEWAY)/.test(l)) || '';
  };
  for (const [n, l] of uses) {
    const ctx = at(n);
    assert.ok(/app\.post\('\/login'|app\.post\('\/logout'|if \(ADS_GATEWAY\)|const ADS_GATEWAY/.test(ctx), `line ${n}: ${l.trim()} (in ${ctx.trim()})`);
  }
  // Adshortis creators are never written into Grabbit profiles.
  const adsBlocks = src.split('\n').filter((l) => /adsGateway|ADS_LINKS|ADS_GATEWAY/.test(l)).join('\n');
  assert.ok(!/saveProfiles|profiles\./.test(adsBlocks));
  assert.equal((src.match(/'\/api\/ads/g) || []).length, 0, 'the mount path comes from adsGateway.MOUNT only');
});
