'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../profiles');

const T0 = 1_780_000_000_000;

// A registry with: one creator on two sites (two keys for one file), the same
// name in the main and the 18+ channel, a mark and a file without a creator.
const REGISTRY = {
  'id:tiktok:1': { filename: 'Anna_-_first 1.mp4', at: T0 + 1, channel: 'main' },
  'tiktok.com/@anna/video/1': { filename: 'Anna_-_first 1.mp4', at: T0 + 1, channel: 'main' },
  'id:instagram:2': { filename: 'anna_-_second 2.mp4', at: T0 + 5, channel: 'main' },
  'id:redgifs:3': { filename: 'Anna_-_other 3.mp4', at: T0 + 3, channel: '18plus' },
  'id:tiktok:4': { filename: 'Bert_-_clip 4.mp4', at: T0 + 2 },
  'mark:playlist': { at: T0 },
  'yt:5': { filename: 'Artist - Song.opus', at: T0 },
};

function seeded() {
  const stats = P.aliasStats(REGISTRY);
  return { stats, ...P.sync(P.emptyStore(), stats, T0) };
}
const byName = (store, name, audience = 'general') =>
  store.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.audience === audience);

test('aliasStats counts files once and splits general from adult', () => {
  const s = P.aliasStats(REGISTRY);
  assert.deepEqual([...s.keys()].sort(), ['adult:anna', 'general:anna', 'general:bert']);
  const anna = s.get('general:anna');
  assert.equal(anna.files, 2);
  assert.deepEqual([...anna.sites].sort(), ['instagram', 'tiktok']);
  assert.equal(anna.lastAt, T0 + 5);
  assert.equal(s.get('adult:anna').files, 1);
});

test('sync seeds one profile per alias and is a no-op the second time', () => {
  const { store, added, stats } = seeded();
  assert.equal(added, 3);
  assert.deepEqual(P.check(store), []);
  assert.equal(byName(store, 'anna', 'adult').audience, 'adult');
  const again = P.sync(store, stats, T0 + 10);
  assert.equal(again.added, 0);
  assert.equal(again.store, store, 'unchanged store is returned as is, so no write happens');
});

test('sync never changes an existing profile, only adds new aliases', () => {
  let { store } = seeded();
  const bert = byName(store, 'bert');
  store = P.update(store, bert.id, { name: 'Bert B' }, T0 + 1).store;
  const more = { ...REGISTRY, 'id:tiktok:9': { filename: 'Cecil_-_x 9.mp4', at: T0 + 9 } };
  const r = P.sync(store, P.aliasStats(more), T0 + 2);
  assert.equal(r.added, 1);
  assert.equal(P.findProfile(r.store, bert.id).name, 'Bert B');
});

test('update edits name, note and accounts; keeps source of kept accounts', () => {
  let { store } = seeded();
  const anna = byName(store, 'anna');
  store = P.update(store, anna.id, { accounts: [{ platform: 'TikTok', handle: '@anna', url: 'https://www.tiktok.com/@anna', source: 'importer' }] }, T0 + 1).store;
  const r = P.update(store, anna.id, {
    name: 'Anna A',
    note: 'same person on IG',
    accounts: [{ platform: 'tiktok', handle: 'anna' }, { platform: 'instagram', handle: 'anna.a' }],
  }, T0 + 2);
  const p = r.profile;
  assert.equal(p.name, 'Anna A');
  assert.deepEqual(p.accounts.map((a) => [a.platform, a.handle, a.source, a.addedAt]), [
    ['tiktok', 'anna', 'importer', T0 + 1],
    ['instagram', 'anna.a', 'manual', T0 + 2],
  ]);
  assert.equal(p.aliases.length, 1, 'aliases are untouched by an edit');
});

test('update refuses aliases, audience, bad urls and an account owned elsewhere', () => {
  let { store } = seeded();
  const anna = byName(store, 'anna');
  const bert = byName(store, 'bert');
  assert.throws(() => P.update(store, anna.id, { aliases: [] }, T0), /merge or split/);
  assert.throws(() => P.update(store, anna.id, { audience: 'adult' }, T0), /cannot be changed/);
  assert.throws(() => P.update(store, anna.id, { accounts: [{ platform: 'x', handle: 'a', url: 'javascript:alert(1)' }] }, T0), /https/);
  assert.throws(() => P.update(store, anna.id, { name: '  ' }, T0), /name is required/);
  store = P.update(store, anna.id, { accounts: [{ platform: 'tiktok', handle: 'anna' }] }, T0).store;
  assert.throws(
    () => P.update(store, bert.id, { accounts: [{ platform: 'tiktok', handle: 'ANNA' }] }, T0),
    (e) => e.status === 409 && /merge the two/.test(e.message)
  );
  assert.throws(() => P.update(store, 999, { name: 'x' }, T0), (e) => e.status === 404);
});

test('merge moves every alias and account and remembers the merged ids', () => {
  let { store } = seeded();
  const anna = byName(store, 'anna');
  const bert = byName(store, 'bert');
  store = P.update(store, bert.id, { accounts: [{ platform: 'tiktok', handle: 'bert' }] }, T0).store;
  const r = P.merge(store, anna.id, [bert.id], T0 + 1);
  assert.equal(r.store.profiles.length, 2);
  assert.deepEqual(r.profile.aliases.map((a) => a.name).sort(), ['Anna', 'Bert']);
  assert.equal(r.profile.accounts[0].handle, 'bert');
  assert.deepEqual(r.profile.mergedFrom, [bert.id]);
  assert.deepEqual(P.check(r.store), []);
  // Every registry alias still resolves after the merge.
  const again = P.sync(r.store, P.aliasStats(REGISTRY), T0 + 2);
  assert.equal(again.added, 0);
});

test('merge refuses general into adult, self-merge and unknown ids', () => {
  const { store } = seeded();
  const anna = byName(store, 'anna');
  const annaAdult = byName(store, 'anna', 'adult');
  assert.throws(() => P.merge(store, anna.id, [annaAdult.id], T0), (e) => e.status === 409 && /never merged/.test(e.message));
  assert.throws(() => P.merge(store, anna.id, [anna.id], T0), /itself/);
  assert.throws(() => P.merge(store, anna.id, [12345], T0), (e) => e.status === 404);
  assert.throws(() => P.merge(store, anna.id, [], T0), /at least one/);
});

test('split moves the chosen aliases and accounts and undoes a merge', () => {
  let { store } = seeded();
  const anna = byName(store, 'anna');
  const bert = byName(store, 'bert');
  store = P.update(store, bert.id, { accounts: [{ platform: 'tiktok', handle: 'bert' }] }, T0).store;
  store = P.merge(store, anna.id, [bert.id], T0).store;
  const r = P.split(store, anna.id, { name: 'Bert', aliases: ['bert'], accounts: ['tiktok:bert'] }, T0 + 1);
  assert.deepEqual(r.from.aliases.map((a) => a.name), ['Anna']);
  assert.deepEqual(r.profile.aliases.map((a) => a.name), ['Bert']);
  assert.equal(r.profile.accounts[0].handle, 'bert');
  assert.equal(r.profile.audience, 'general');
  assert.equal(r.profile.origin, `split:${anna.id}`);
  assert.deepEqual(P.check(r.store), []);
  assert.equal(P.sync(r.store, P.aliasStats(REGISTRY), T0 + 2).added, 0);
});

test('split refuses moving everything, nothing, or what the profile does not hold', () => {
  const { store } = seeded();
  const anna = byName(store, 'anna');
  assert.throws(() => P.split(store, anna.id, { name: 'X', aliases: ['anna'] }, T0), /leave something/);
  assert.throws(() => P.split(store, anna.id, { name: 'X' }, T0), /choose the aliases/);
  assert.throws(() => P.split(store, anna.id, { name: 'X', aliases: ['bert'] }, T0), /not in this profile/);
});

test('create needs an explicit audience', () => {
  const { store } = seeded();
  assert.throws(() => P.create(store, { name: 'New' }, T0), /audience/);
  const r = P.create(store, { name: 'New', audience: 'general', accounts: [{ platform: 'facebook', handle: 'new.page' }] }, T0);
  assert.equal(r.profile.origin, 'manual');
  assert.equal(r.profile.aliases.length, 0);
  assert.equal(r.store.profiles.length, 4);
});

test('operations never mutate the store they were given', () => {
  const { store } = seeded();
  const before = JSON.stringify(store);
  const anna = byName(store, 'anna');
  const bert = byName(store, 'bert');
  P.update(store, anna.id, { name: 'Z' }, T0);
  P.merge(store, anna.id, [bert.id], T0);
  assert.equal(JSON.stringify(store), before);
});

test('normalizeStore round-trips and refuses a broken file', () => {
  const { store } = seeded();
  const back = P.normalizeStore(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(back.profiles, store.profiles);
  assert.equal(back.nextId, store.nextId);
  assert.deepEqual(P.normalizeStore(null), P.emptyStore());
  const dup = JSON.parse(JSON.stringify(store));
  dup.profiles[1].aliases.push({ name: dup.profiles[0].aliases[0].name });
  dup.profiles[1].audience = dup.profiles[0].audience;
  assert.throws(() => P.normalizeStore(dup), /alias/);
  assert.throws(() => P.normalizeStore({ nope: 1 }), /not a profile store/);
});

test('list sums registry numbers per profile and filters', () => {
  let { store, stats } = seeded();
  const anna = byName(store, 'anna');
  const bert = byName(store, 'bert');
  store = P.merge(store, anna.id, [bert.id], T0).store;
  const all = P.list(store, stats);
  assert.equal(all.total, 2);
  assert.deepEqual(all.counts, { general: 1, adult: 1, linked: 0 });
  assert.equal(all.items[0].files, 3);
  assert.deepEqual(all.items[0].sites, ['instagram', 'tiktok']);
  assert.equal(P.list(store, stats, { audience: 'adult' }).items[0].files, 1);
  assert.equal(P.list(store, stats, { q: 'bert' }).items[0].id, anna.id, 'search finds a profile by an alias');
});
