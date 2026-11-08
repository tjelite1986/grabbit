'use strict';
// The Instagram inbox's pure part: reading the drop folder, entry identity,
// carousel grouping and the delivery plan. Network-free, temp folders only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const inbox = require('../inbox');

const NOW = Date.parse('2026-11-08T15:00:00Z');
const MIN = 60 * 1000;

function tmpDrop() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-inbox-'));
}
function put(root, rel, content, ageMs) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  const t = new Date(NOW - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}
const post = (over = {}) => JSON.stringify({
  schema_version: 2,
  source: 'instagram',
  media_file: 'some.user_4023663648274562195.jpg',
  username: 'some.user',
  shortcode: 'DfXaVh5jpDA',
  media_pk: '4023663648274562195',
  post_url: 'https://www.instagram.com/p/DfXaVh5jpDA/',
  is_video: false,
  carousel_size: 1,
  media_index: 0,
  caption: 'Afternoon walk\n- #amsterdam #november',
  ...over,
});

test('a settled media file with its sidecar becomes one entry keyed by shortcode', () => {
  const root = tmpDrop();
  put(root, 'some.user/some.user_4023663648274562195.jpg', 'img', 5 * MIN);
  put(root, 'some.user/some.user_4023663648274562195.json', post(), 5 * MIN);
  const r = inbox.scanDrop(root, { now: NOW });
  assert.equal(r.entries.length, 1);
  const e = r.entries[0];
  assert.equal(e.kind, 'media');
  assert.equal(e.entry, 'some.user/some.user_4023663648274562195');
  assert.equal(e.key, 'id:instagram:DfXaVh5jpDA');
  assert.equal(e.mediaType, 'image');
  assert.equal(e.job.creator, 'some.user');
  assert.equal(e.job.sourceUrl, 'https://www.instagram.com/p/DfXaVh5jpDA/');
  assert.ok(e.job.title.endsWith(' DfXaVh5jpDA'), 'the title ends in the site id');
  assert.equal(e.job.title, 'Afternoon walk DfXaVh5jpDA');
  assert.deepEqual(e.job.tags, ['amsterdam', 'november']);
  assert.equal(r.waiting, 0);
});

test('carousel members get the position in their key and share a group', () => {
  const root = tmpDrop();
  for (const [i, pk] of [[0, '111111111'], [1, '222222222']]) {
    put(root, `u1/u1_${pk}.mp4`, 'v', 5 * MIN);
    put(root, `u1/u1_${pk}.json`, post({ media_file: `u1_${pk}.mp4`, media_pk: pk, carousel_size: 3, media_index: i, is_video: true }), 5 * MIN);
  }
  const r = inbox.scanDrop(root, { now: NOW });
  const keys = r.entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ['id:instagram:DfXaVh5jpDA-0', 'id:instagram:DfXaVh5jpDA-1']);
  assert.ok(r.entries.every((e) => e.groupKey === 'DfXaVh5jpDA' && e.groupSize === 3 && e.mediaType === 'video'));
});

test('young files, and a media file still waiting for its sidecar, are left alone', () => {
  const root = tmpDrop();
  put(root, 'u2/u2_1234567.jpg', 'img', 30 * 1000);
  put(root, 'u2/u2_1234567.json', post({ media_file: 'u2_1234567.jpg' }), 30 * 1000);
  put(root, 'u2/u2_7654321.jpg', 'img', 5 * MIN);
  const r = inbox.scanDrop(root, { now: NOW });
  assert.equal(r.entries.length, 0);
  assert.equal(r.waiting, 2);
});

test('a media file whose sidecar never came is taken after the orphan wait, keyed by its media pk', () => {
  const root = tmpDrop();
  put(root, 'u3/u3_7654321.jpg', 'img', 40 * MIN);
  const r = inbox.scanDrop(root, { now: NOW });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].key, 'id:instagram:pk7654321');
  assert.equal(r.entries[0].sidecarFile, null);
});

test('a profile sidecar is a profile entry; one naming another user is left in place', () => {
  const root = tmpDrop();
  const prof = (u) => JSON.stringify({ schema_version: 2, source: 'instagram', kind: 'profile', username: u });
  put(root, 'good.one/good.one.json', prof('good.one'), 5 * MIN);
  put(root, 'other/other.json', prof('someone.else'), 5 * MIN);
  const r = inbox.scanDrop(root, { now: NOW });
  assert.deepEqual(r.entries.map((e) => [e.kind, e.entry]), [['profile', 'good.one/good.one']]);
  assert.ok(r.ignored.some((i) => i.path === 'other/other.json'));
});

test('paths are never taken from a sidecar', () => {
  const root = tmpDrop();
  put(root, 'u4/u4_999999.jpg', 'img', 5 * MIN);
  put(root, 'u4/u4_999999.json', post({ media_file: '../../etc/passwd' }), 5 * MIN);
  const r = inbox.scanDrop(root, { now: NOW });
  assert.equal(r.entries.length, 0);
  assert.match(r.ignored[0].why, /the sidecar names/);
});

test('bad folder names, dotfiles, partials, invalid sidecars and old files are not entries', () => {
  const root = tmpDrop();
  put(root, 'not a user!/x.jpg', 'img', 5 * MIN);
  put(root, 'u5/.hidden.jpg', 'img', 5 * MIN);
  put(root, 'u5/u5_1.mp4.part', 'v', 5 * MIN);
  put(root, 'u5/u5_2222222.jpg', 'img', 5 * MIN);
  put(root, 'u5/u5_2222222.json', '{"schema_version":1}', 5 * MIN);
  put(root, 'u5/u5_3333333.jpg', 'img', 30 * 24 * 60 * MIN);
  put(root, 'loose.jpg', 'img', 5 * MIN);
  const r = inbox.scanDrop(root, { now: NOW, since: NOW - 24 * 60 * MIN });
  assert.equal(r.entries.length, 0);
  const why = Object.fromEntries(r.ignored.map((i) => [i.path, i.why]));
  assert.match(why['not a user!/'], /not an Instagram username/);
  assert.match(why['u5/u5_2222222.json'], /not schema-2/);
  assert.match(why['loose.jpg'], /outside a username folder/);
  assert.equal(Object.keys(why).length, 3);
});

test('a missing drop folder throws a readable error', () => {
  assert.throws(() => inbox.scanDrop('/nonexistent/grabbit-inbox'), /drop folder cannot be read/);
});

test('a carousel waits for all members or for the group wait', () => {
  const m = (ageMin) => ({ received_at: NOW - ageMin * MIN });
  assert.equal(inbox.groupReady([m(1)], 1, NOW), true);
  assert.equal(inbox.groupReady([m(1), m(1)], 3, NOW), false);
  assert.equal(inbox.groupReady([m(1), m(1), m(1)], 3, NOW), true);
  assert.equal(inbox.groupReady([m(31), m(1)], 3, NOW), true);
  assert.equal(inbox.groupReady([], 1, NOW), false);
});

test('the delivery plan names apps only for a general item, and videos only for shorts apps', () => {
  const all = { egram: true, main: true, platform: true };
  const plan = (x, auto = all, available = all) => inbox.deliveryPlan(x, { auto, available });
  assert.deepEqual(plan({ kind: 'media', mediaType: 'video', audience: 'unknown' }).deliver, []);
  assert.deepEqual(plan({ kind: 'media', mediaType: 'video', audience: 'adult' }).deliver, []);
  assert.deepEqual(plan({ kind: 'media', mediaType: 'video', audience: 'general' }).deliver, ['egram', 'main', 'platform']);
  const img = plan({ kind: 'media', mediaType: 'image', audience: 'general' });
  assert.deepEqual(img.deliver, ['egram']);
  assert.deepEqual(img.skipped.map((s) => s.dest), ['main', 'platform']);
  assert.deepEqual(plan({ kind: 'profile', audience: 'general' }).deliver, ['egram']);
  const off = plan({ kind: 'media', mediaType: 'video', audience: 'general' }, { egram: false, main: true, platform: false }, { main: false });
  assert.deepEqual(off.deliver, []);
  assert.deepEqual(off.skipped, [{ dest: 'main', why: 'not configured on this server' }]);
});

test('manual refusals follow the destination rules', () => {
  assert.equal(inbox.manualRefusal({ kind: 'media', mediaType: 'image' }, 'egram'), null);
  assert.match(inbox.manualRefusal({ kind: 'media', mediaType: 'image' }, '18plus'), /videos only/);
  assert.match(inbox.manualRefusal({ kind: 'profile' }, 'main'), /only goes to egram/);
  assert.match(inbox.manualRefusal({ kind: 'media', mediaType: 'video' }, 'posts'), /Unknown destination/);
});

test('settings keep egram on by default and drop unknown keys', () => {
  assert.deepEqual(inbox.normalizeSettings(null), { auto: { egram: true, main: false, platform: false }, keepDays: 7 });
  assert.deepEqual(
    inbox.normalizeSettings({ auto: { egram: false, main: true, evil: true, platform: 'yes' }, keepDays: 400 }),
    { auto: { egram: false, main: true, platform: false }, keepDays: 7 }
  );
});
