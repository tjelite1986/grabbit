'use strict';
// What a scanned file is, from its folder and name alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, kindOf, extOf, renditionStem, relatedRenditions, audienceOf, CACHE_DIRS } = require('../dupe-classify');

test('extOf lowercases the extension and ignores a leading dot', () => {
  assert.equal(extOf('Clip.MP4'), 'mp4');
  assert.equal(extOf('a.b.webm'), 'webm');
  assert.equal(extOf('.hidden'), '');
  assert.equal(extOf('noext'), '');
});

test('kindOf sorts by extension and reads only the base name', () => {
  assert.equal(kindOf('a/b/clip.MKV'), 'video');
  assert.equal(kindOf('x.heic'), 'image');
  assert.equal(kindOf('song.flac'), 'audio');
  assert.equal(kindOf('notes.txt'), 'other');
  assert.equal(kindOf('video.mp4/readme'), 'other');
  assert.equal(kindOf('win\\dir\\pic.PNG'), 'image');
});

test('plain media is media, not regenerable, not web-optimised', () => {
  assert.deepEqual(classify({}, 'creator/clip.mp4'), { kind: 'video', cls: 'media', what: 'video', regenerable: false, webOptimized: false });
  assert.deepEqual(classify(null, 'pic.jpg'), { kind: 'image', cls: 'media', what: 'image', regenerable: false, webOptimized: false });
});

test('a cache folder segment makes a regenerable derivative, case-insensitive', () => {
  const c = classify({}, 'creator/Thumbs/a.jpg');
  assert.equal(c.cls, 'derivative');
  assert.equal(c.what, 'thumbnail');
  assert.equal(c.regenerable, true);
  assert.equal(c.kind, 'image');
});

test('the cache folder decides the label', () => {
  const what = (dir) => classify({}, `${dir}/f.jpg`).what;
  assert.equal(what('.posters'), 'poster');
  assert.equal(what('_previews'), 'preview');
  assert.equal(what('.tmp'), 'cache file');
  assert.equal(what('cache'), 'cache file');
  assert.equal(what('sprites'), 'sprite');
  assert.equal(what('.thumbnails'), 'thumbnail');
});

test('a cache folder name inside a longer name is media', () => {
  assert.equal(classify({}, 'thumbsup/a.jpg').cls, 'media');
  assert.equal(classify({}, 'mycache/a.jpg').cls, 'media');
});

test('only folder segments count, not the file name', () => {
  assert.equal(classify({}, 'creator/thumbs').cls, 'media');
  assert.equal(classify({}, 'thumbs.jpg').cls, 'media');
});

test('every listed cache dir is recognised', () => {
  for (const d of CACHE_DIRS) assert.equal(classify({}, `x/${d}/f.mp4`).cls, 'derivative', d);
});

test('web-optimised renditions are media flagged webOptimized', () => {
  for (const n of ['clip.web.mp4', 'clip.webopt.mp4', 'clip.web-opt.mp4', 'clip.optimized.jpg', 'clip.preview.mp4', 'clip.small.jpg', 'clip.MOBILE.mp4']) {
    const c = classify({}, `d/${n}`);
    assert.equal(c.cls, 'media', n);
    assert.equal(c.webOptimized, true, n);
  }
  assert.equal(classify({}, 'web.mp4').webOptimized, false);
  assert.equal(classify({}, 'clip.mp4').webOptimized, false);
  assert.equal(classify({}, 'clip-web.mp4').webOptimized, false);
});

test('egram: _thumbs and _tmp are regenerable derivatives', () => {
  assert.deepEqual(classify({ app: 'egram' }, '_thumbs/1.jpg'), { kind: 'image', cls: 'derivative', what: 'thumbnail', regenerable: true, webOptimized: false });
  assert.deepEqual(classify({ app: 'egram' }, '_tmp/up.mp4'), { kind: 'video', cls: 'derivative', what: 'temporary file', regenerable: true, webOptimized: false });
});

test('egram: other underscore folders are the app\'s own and not regenerable', () => {
  const c = classify({ app: 'egram' }, '_avatars/me.jpg');
  assert.equal(c.cls, 'app');
  assert.equal(c.what, 'avatar');
  assert.equal(c.regenerable, false);
  assert.equal(classify({ app: 'egram' }, '_banners/b.png').what, 'banner');
});

test('egram: the stories folder is labelled "story"', () => {
  assert.equal(classify({ app: 'egram' }, '_stories/s.mp4').what, 'story');
});

test('egram: a top-level file whose name starts with an underscore is media', () => {
  assert.equal(classify({ app: 'egram' }, '_x.jpg').cls, 'media');
});

test('egram: creator folders follow the generic rules', () => {
  assert.equal(classify({ app: 'egram' }, 'creator/p.jpg').cls, 'media');
  assert.equal(classify({ app: 'egram' }, 'creator/thumbs/p.jpg').cls, 'derivative');
  assert.equal(classify({ app: 'egram' }, 'creator/_thumbs/p.jpg').cls, 'derivative');
});

test('TikShortis: an image is a poster, a video is media', () => {
  const p = classify({ app: 'TikShortis' }, 'c/clip.jpg');
  assert.equal(p.cls, 'derivative');
  assert.equal(p.what, 'poster');
  assert.equal(p.regenerable, true);
  assert.equal(classify({ app: 'TikShortis' }, 'c/clip.mp4').cls, 'media');
});

test('app rules apply only to their own app', () => {
  assert.equal(classify({ app: 'other' }, '_avatars/me.jpg').cls, 'media');
  assert.equal(classify({}, 'c/clip.jpg').cls, 'media');
});

test('renditionStem strips the extension and a rendition suffix, lowercased', () => {
  assert.equal(renditionStem('a/Clip.WEB.mp4'), 'clip');
  assert.equal(renditionStem('clip.mp4'), 'clip');
  assert.equal(renditionStem('clip.web-opt.mp4'), 'clip');
  assert.equal(renditionStem('a.b.mp4'), 'a.b');
});

test('relatedRenditions: same folder and stem, one web-optimised', () => {
  const f = (rel, root = 1) => ({ rel, root, rootInfo: {} });
  assert.equal(relatedRenditions(f('d/clip.mp4'), f('d/clip.web.mp4')), true);
  assert.equal(relatedRenditions(f('d/clip.web.mp4'), f('d/clip.mp4')), true);
});

test('relatedRenditions refuses different folders, roots, stems or two plain copies', () => {
  const f = (rel, root = 1) => ({ rel, root, rootInfo: {} });
  assert.equal(relatedRenditions(f('d/clip.mp4'), f('e/clip.web.mp4')), false);
  assert.equal(relatedRenditions(f('d/clip.mp4', 1), f('d/clip.web.mp4', 2)), false);
  assert.equal(relatedRenditions(f('d/clip.mp4'), f('d/other.web.mp4')), false);
  assert.equal(relatedRenditions(f('d/clip.mp4'), f('d/clip.mkv')), false);
  assert.equal(relatedRenditions(f('d/clip.web.mp4'), f('d/clip.small.mp4')), false);
});

test('audienceOf: an adult root or item makes adult, nothing else invents general', () => {
  assert.equal(audienceOf({ adult: true }, 'general'), 'adult');
  assert.equal(audienceOf({}, 'adult'), 'adult');
  assert.equal(audienceOf({}, 'general'), 'general');
  assert.equal(audienceOf(null, undefined), 'unknown');
  assert.equal(audienceOf({ adult: false }, 'something'), 'unknown');
});
