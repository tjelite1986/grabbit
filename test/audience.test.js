'use strict';
// The audience gate's rules, without a server: what an item is classified as,
// and which destination may receive it.
const test = require('node:test');
const assert = require('node:assert/strict');
const audience = require('../audience');
const profiles = require('../profiles');

const NOW = 1_700_000_000_000;
// The server's safeCreator() spelling, close enough for these names.
const keyOf = (n) => String(n || '').trim().replace(/\s+/g, '_');

function storeWith(list) {
  let store = profiles.emptyStore();
  for (const p of list) store = profiles.create(store, p, NOW).store;
  return store;
}

// A registry where `name` was saved to `channel` (null = server library).
function statsFor(entries) {
  const registry = {};
  entries.forEach(([name, channel], i) => {
    registry[`id:site:${i}`] = { filename: `${name}_-_clip ${i}.mp4`, at: NOW + i, channel };
  });
  return profiles.aliasStats(registry);
}
function synced(entries) {
  const stats = statsFor(entries);
  return { store: profiles.sync(profiles.emptyStore(), stats, NOW).store, stats };
}

const classify = (input, store, stats) => audience.classify(input, store, stats, { keyOf });

test('a creator no profile knows is unknown, and no general app takes it', () => {
  const c = classify({ creatorKey: 'nobody' }, profiles.emptyStore(), new Map());
  assert.equal(c.audience, 'unknown');
  for (const dest of ['main', 'platform', 'posts']) {
    assert.match(audience.refusal(c, dest, { mediaType: dest === 'posts' ? 'image' : 'video' }), /not classified/);
  }
  assert.equal(audience.refusal(c, '18plus', { mediaType: 'video' }), null);
});

test('no creator at all is unknown', () => {
  for (const creatorKey of [null, '', 'unknown', 'Unknown']) {
    const c = classify({ creatorKey }, storeWith([{ name: 'unknown', audience: 'general' }]), new Map());
    assert.equal(c.audience, 'unknown', String(creatorKey));
  }
});

test('a hand-made general profile makes its creator general, by name or alias spelling', () => {
  const store = storeWith([{ name: 'Jane Doe', audience: 'general' }]);
  for (const creatorKey of ['Jane Doe', 'jane doe', 'Jane_Doe']) {
    const c = classify({ creatorKey }, store, new Map());
    assert.equal(c.audience, 'general', creatorKey);
    assert.equal(audience.refusal(c, 'main', { mediaType: 'video' }), null);
    assert.equal(audience.refusal(c, 'posts', { mediaType: 'image' }), null);
  }
});

test('an account on the same platform matches; the same handle elsewhere does not', () => {
  const store = storeWith([{ name: 'Someone', audience: 'general', accounts: [{ platform: 'tiktok', handle: 'janed' }] }]);
  assert.equal(classify({ creatorKey: 'other', handle: 'janed', site: 'tiktok' }, store, new Map()).audience, 'general');
  assert.equal(classify({ creatorKey: 'other', handle: 'janed', site: 'instagram' }, store, new Map()).audience, 'unknown');
});

test('a registry alias counts as general only when it reached a general app', () => {
  const app = synced([['alice', 'main']]);
  assert.equal(classify({ creatorKey: 'alice' }, app.store, app.stats).audience, 'general');
  const plat = synced([['carol', 'platform']]);
  assert.equal(classify({ creatorKey: 'carol' }, plat.store, plat.stats).audience, 'general');
  // A save to the plain server library makes a "general" registry profile,
  // but that is not a classification.
  const lib = synced([['bob', null]]);
  assert.equal(lib.store.profiles[0].audience, 'general');
  const c = classify({ creatorKey: 'bob' }, lib.store, lib.stats);
  assert.equal(c.audience, 'unknown');
  assert.match(audience.refusal(c, 'main'), /not classified/);
});

test('every adult signal wins over a general profile', () => {
  const store = storeWith([{ name: 'alice', audience: 'general' }]);
  const signals = [
    { requested: 'adult' },
    { prior: 'adult' },
    { site: 'redgifs.com' },
    { site: 'RedGifs' },
    { extractor: 'erome' },
    { sourceUrl: 'https://www.xxxfollow.com/u/x' },
    { site: 'cdn.tik.porn' },
  ];
  for (const s of signals) {
    const c = classify({ creatorKey: 'alice', ...s }, store, new Map());
    assert.equal(c.audience, 'adult', JSON.stringify(s));
    for (const dest of ['main', 'platform', 'posts']) assert.match(audience.refusal(c, dest), /18\+/, dest);
  }
});

test('a lookalike host is not an adult site, and a general profile still decides', () => {
  const store = storeWith([{ name: 'alice', audience: 'general' }]);
  for (const site of ['notredgifs.com', 'redgifs.com.example.com', 'example.com']) {
    assert.equal(classify({ creatorKey: 'alice', site }, store, new Map()).audience, 'general', site);
  }
});

test('the same name with an adult profile is adult, even when a general one exists too', () => {
  const store = storeWith([
    { name: 'sam', audience: 'general' },
    { name: 'sam', audience: 'adult' },
  ]);
  const c = classify({ creatorKey: 'sam' }, store, new Map());
  assert.equal(c.audience, 'adult');
  assert.ok(c.profileId);
});

test('a job can tighten to adult but nothing it says lowers the audience', () => {
  const store = storeWith([{ name: 'alice', audience: 'adult' }]);
  for (const requested of ['general', 'unknown', null, undefined, 'GENERAL', true]) {
    assert.equal(classify({ creatorKey: 'alice', requested }, store, new Map()).audience, 'adult', String(requested));
  }
  for (const prior of ['general', 'unknown', null]) {
    assert.equal(classify({ creatorKey: 'nobody', prior }, store, new Map()).audience, 'unknown', String(prior));
  }
});

test('stricter(): adult if either look is adult, general only if both are', () => {
  const g = { audience: 'general', reasons: ['g'], profileId: 1 };
  const a = { audience: 'adult', reasons: ['a'], profileId: 2 };
  const u = { audience: 'unknown', reasons: ['u'], profileId: null };
  assert.equal(audience.stricter(g, g).audience, 'general');
  assert.equal(audience.stricter(g, a).audience, 'adult');
  assert.equal(audience.stricter(a, g).audience, 'adult');
  assert.equal(audience.stricter(g, u).audience, 'unknown');
  assert.equal(audience.stricter(u, g).audience, 'unknown');
  assert.equal(audience.stricter(u, a).audience, 'adult');
});

test('Adshortis takes adult videos, never images', () => {
  const adult = { audience: 'adult', reasons: [] };
  assert.equal(audience.refusal(adult, '18plus', { mediaType: 'video' }), null);
  assert.match(audience.refusal(adult, '18plus', { mediaType: 'image' }), /videos only/);
});

test('refusal fails closed on bad input', () => {
  assert.match(audience.refusal({ audience: 'general' }, 'nowhere'), /Unknown destination/);
  for (const c of [null, undefined, {}, { audience: 'GENERAL' }, { audience: 'safe' }]) {
    assert.match(audience.refusal(c, 'main'), /not classified/, JSON.stringify(c));
  }
});

test('every destination is listed with an audience, and only Adshortis is adult', () => {
  const adult = Object.values(audience.DESTINATIONS).filter((d) => d.audience === 'adult').map((d) => d.id);
  assert.deepEqual(adult, ['18plus']);
  assert.ok(Object.values(audience.DESTINATIONS).every((d) => ['general', 'adult'].includes(d.audience)));
});

test('storedAudience never lowers', () => {
  assert.equal(audience.storedAudience('adult', 'general'), 'adult');
  assert.equal(audience.storedAudience('adult', 'unknown'), 'adult');
  assert.equal(audience.storedAudience('general', 'adult'), 'adult');
  assert.equal(audience.storedAudience('general', 'unknown'), 'general');
  assert.equal(audience.storedAudience(null, 'unknown'), 'unknown');
});

test('platforms match exactly; lookalike sites match no account', () => {
  const store = storeWith([{ name: 'Someone', audience: 'general', accounts: [{ platform: 'tiktok', handle: 'janed' }] }]);
  for (const site of ['tiktok', 'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com']) {
    assert.equal(audience.platformOfSite(site), 'tiktok', site);
    assert.equal(classify({ creatorKey: 'other', handle: 'janed', site }, store, new Map()).audience, 'general', site);
  }
  for (const site of ['nottiktok.com', 'tiktok.com.example.com', 'tiktokclips', 'mytiktok', 'evil-tiktok.net']) {
    assert.equal(audience.platformOfSite(site), null, site);
    assert.equal(classify({ creatorKey: 'other', handle: 'janed', site }, store, new Map()).audience, 'unknown', site);
  }
  assert.equal(audience.platformOfSite('x'), 'x');
  assert.equal(audience.platformOfSite('box.com'), null);
});
