'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hub = require('../hub');

const NOW = new Date(2026, 10, 7, 15, 0, 0).getTime();
const YESTERDAY = NOW - 24 * 3600 * 1000;

test('kindOf reads the extension, case-insensitively', () => {
  assert.equal(hub.kindOf('a_-_b.mp4'), 'video');
  assert.equal(hub.kindOf('a_-_b.JPEG'), 'image');
  assert.equal(hub.kindOf('Artist - Song.opus'), 'audio');
  assert.equal(hub.kindOf('notes.txt'), 'other');
  assert.equal(hub.kindOf(null), 'other');
});

test('creatorOf takes the part before _-_ and nothing else', () => {
  assert.equal(hub.creatorOf('Some_One_-_A title.mp4'), 'Some_One');
  assert.equal(hub.creatorOf('Artist - Song.opus'), null);
  assert.equal(hub.creatorOf('_-_no creator.mp4'), null);
  assert.equal(hub.creatorOf('unknown_-_clip.mp4'), null);
});

test('siteOf puts id keys and URL keys of one site on the same name', () => {
  assert.equal(hub.siteOf('id:redgifs:abc'), 'redgifs');
  assert.equal(hub.siteOf('redgifs.com/watch/abc'), 'redgifs');
  assert.equal(hub.siteOf('id:reddclips.com:1'), 'reddclips');
  assert.equal(hub.siteOf('yt:xyz'), 'youtube');
  assert.equal(hub.siteOf('music.youtube.com/watch'), 'youtube');
  assert.equal(hub.siteOf('www.facebook.com/watch/'), 'facebook');
});

test('summarize counts files, not keys, and keeps marks apart', () => {
  const registry = {
    // One file under two keys: counted once, site from the id key.
    'id:tiktok:1': { filename: 'Ann_-_Clip 1.mp4', at: NOW - 1000 },
    'tiktok.com/@ann/video/1': { filename: 'Ann_-_Clip 1.mp4', at: NOW - 2000 },
    'id:facebook:2': { filename: 'ann_-_Photo 2.jpg', at: YESTERDAY },
    'yt:3': { filename: 'Band - Song.opus', at: YESTERDAY },
    // Marks: no file behind them.
    'yt:4': { filename: null, at: NOW },
    'id:facebook:5': { at: NOW },
  };
  const s = hub.summarize(registry, NOW);
  assert.equal(s.keys, 6);
  assert.equal(s.files, 3);
  assert.equal(s.marks, 2);
  assert.equal(s.addedToday, 1);
  assert.deepEqual(s.kinds, { video: 1, image: 1, audio: 1, other: 0 });
  // "Ann" and "ann" are one creator; the music file has none.
  assert.equal(s.creators, 1);
  assert.deepEqual(s.sites, [
    { site: 'facebook', count: 1 },
    { site: 'tiktok', count: 1 },
    { site: 'youtube', count: 1 },
  ]);
});

test('summarize prefers the id key for the site even when the URL key comes first', () => {
  const s = hub.summarize({
    'example.com/some/page': { filename: 'X_-_y.mp4', at: 1 },
    'id:erome:9': { filename: 'X_-_y.mp4', at: 2 },
  }, NOW);
  assert.deepEqual(s.sites, [{ site: 'erome', count: 1 }]);
});

test('summarize survives an empty or missing registry', () => {
  const s = hub.summarize(null, NOW);
  assert.equal(s.files, 0);
  assert.equal(s.creators, 0);
  assert.deepEqual(s.sites, []);
});

test('creatorList groups files per creator, filters and caps', () => {
  const registry = {
    'id:tiktok:1': { filename: 'Ann_-_a.mp4', at: 10 },
    'tiktok.com/x/1': { filename: 'Ann_-_a.mp4', at: 10 },
    'id:facebook:2': { filename: 'Ann_-_b.mp4', at: 20 },
    'id:tiktok:3': { filename: 'Bo_-_c.mp4', at: 30 },
    'yt:4': { filename: 'Band - Song.opus', at: 40 },
  };
  const all = hub.creatorList(registry);
  assert.equal(all.total, 2);
  assert.deepEqual(all.items[0], { name: 'Ann', files: 2, sites: ['facebook', 'tiktok'], lastAt: 20 });
  assert.equal(hub.creatorList(registry, { q: 'bo' }).items[0].name, 'Bo');
  assert.equal(hub.creatorList(registry, { limit: 1 }).items.length, 1);
});

test('parseAppLinks keeps https links only', () => {
  assert.deepEqual(hub.parseAppLinks('Social|https://social.example.com, Bad|javascript:alert(1),NoUrl|,|https://x.example.com,Plain|http://p.example.com'), [
    { name: 'Social', url: 'https://social.example.com' },
  ]);
  assert.deepEqual(hub.parseAppLinks(undefined), []);
});
