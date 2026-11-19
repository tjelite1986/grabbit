'use strict';
// Smart Quality Selection: which copy to keep, and why.
const test = require('node:test');
const assert = require('node:assert/strict');
const { choose, scoreMember, RULES, RULE_LABELS, CODEC_EFFICIENCY } = require('../dupe-quality');

const img = (id, extra = {}) => ({ id, rel: `p${id}.jpg`, kind: 'image', bytes: 1000, mtime_ms: 1e12 + id, ...extra });
const vid = (id, extra = {}) => ({ id, rel: `v${id}.mp4`, kind: 'video', bytes: 1000, mtime_ms: 1e12 + id, width: 1920, height: 1080, duration: 60, vcodec: 'h264', acodec: 'aac', bitrate: 4e6, ...extra });

test('every rule has a label', () => {
  for (const r of RULES) assert.equal(typeof RULE_LABELS[r], 'string', r);
});

test('codec efficiency is relative to H.264', () => {
  assert.equal(CODEC_EFFICIENCY.h264, 1);
  assert.ok(CODEC_EFFICIENCY.hevc > 1);
});

test('higher resolution wins and says so', () => {
  const g = [img(1, { width: 1000, height: 1000 }), img(2, { width: 500, height: 500 })];
  const r = choose(g);
  assert.equal(r.keepId, 1);
  assert.ok(r.reasons.includes('Highest resolution (1000x1000)'));
  assert.ok(r.scores.get(2).reasons.includes('Lower resolution (500x500)'));
});

test('no "Highest resolution" reason when every copy is equal', () => {
  const g = [img(1, { width: 10, height: 10 }), img(2, { width: 10, height: 10 })];
  assert.ok(!scoreMember(g[0], g).reasons.some((x) => x.startsWith('Highest')));
});

test('the biggest file is not automatically the best', () => {
  const g = [img(1, { width: 1000, height: 1000, bytes: 4e6 }), img(2, { width: 2000, height: 2000, bytes: 1e6 })];
  assert.equal(choose(g).keepId, 2);
  assert.equal(choose(g, 'largest').keepId, 1);
});

test('a shorter video loses heavily, within 3% is full length', () => {
  const g = [vid(1, { duration: 60 }), vid(2, { duration: 50 }), vid(3, { duration: 58.5 })];
  assert.ok(scoreMember(g[1], g).reasons.some((x) => x.startsWith('Shorter than the others (50 s of 60 s)')));
  assert.ok(!scoreMember(g[2], g).reasons.some((x) => x.startsWith('Shorter')));
  assert.notEqual(choose(g).keepId, 2);
});

test('bitrate is weighed by codec efficiency', () => {
  // HEVC at 3 Mb/s carries more picture than H.264 at 4 Mb/s.
  const g = [vid(1, { vcodec: 'h264', bitrate: 4e6 }), vid(2, { vcodec: 'hevc', bitrate: 3e6 })];
  const r = choose(g);
  assert.equal(r.keepId, 2);
  assert.ok(r.reasons.some((x) => x.startsWith('Most picture data for its codec (hevc, 3000 kb/s)')));
});

test('a video without audio loses to one with audio', () => {
  const g = [vid(1, { acodec: null }), vid(2)];
  assert.equal(choose(g).keepId, 2);
  assert.ok(scoreMember(g[0], g).reasons.includes('No audio track'));
});

test('sharpest image wins among equal resolution', () => {
  const g = [img(1, { width: 10, height: 10, sharpness: 50 }), img(2, { width: 10, height: 10, sharpness: 100 })];
  const r = choose(g);
  assert.equal(r.keepId, 2);
  assert.ok(r.reasons.includes('Sharpest'));
});

test('image format is only a tie-breaker', () => {
  const png = { ...img(1, { width: 10, height: 10 }), rel: 'a.PNG' };
  const jpg = img(2, { width: 10, height: 10 });
  assert.equal(choose([png, jpg]).keepId, 1);
  const bigJpg = img(3, { width: 20, height: 20 });
  assert.equal(choose([png, bigJpg]).keepId, 3);
});

test('referenced and original copies are preferred, derivatives and web renditions are not', () => {
  const g = [img(1), img(2, { referenced: true })];
  assert.equal(choose(g).keepId, 2);
  assert.ok(scoreMember(g[1], g).reasons.includes('In use by a library item or an app post'));
  assert.equal(choose([img(1), img(2, { original: true })]).keepId, 2);
  assert.equal(choose([img(1, { webOptimized: true }), img(2)]).keepId, 2);
  assert.equal(choose([img(1, { derivative: true }), img(2)]).keepId, 2);
});

test('the oldest copy gets a small bonus only in a group', () => {
  const a = img(1, { mtime_ms: 5 });
  const b = img(2, { mtime_ms: 9 });
  assert.equal(scoreMember(a, [a, b]).score - scoreMember(b, [a, b]).score, 3);
  assert.ok(scoreMember(a, [a, b]).reasons.includes('Oldest copy'));
  assert.ok(!scoreMember(a, [a]).reasons.includes('Oldest copy'));
});

test('scores are rounded to one decimal', () => {
  const g = [img(1, { width: 3, height: 1 }), img(2, { width: 3, height: 3 })];
  const s = scoreMember(g[0], g).score;
  assert.equal(s, Math.round(s * 10) / 10);
  // 40 * 3/9 = 13.33..., plus 3 for the oldest copy and 1 for JPEG.
  assert.equal(s, 17.3);
});

test('ties go to the lower id', () => {
  const g = [img(5, { mtime_ms: 1 }), img(3, { mtime_ms: 1 })];
  assert.equal(choose(g).keepId, 3);
  assert.equal(choose(g, 'largest').keepId, 3);
  assert.equal(choose(g, 'smallest').keepId, 3);
});

test('size and age rules', () => {
  const g = [img(1, { bytes: 10, mtime_ms: 300 }), img(2, { bytes: 30, mtime_ms: 100 }), img(3, { bytes: 20, mtime_ms: 200 })];
  assert.equal(choose(g, 'largest').keepId, 2);
  assert.equal(choose(g, 'smallest').keepId, 1);
  assert.equal(choose(g, 'oldest').keepId, 2);
  assert.equal(choose(g, 'newest').keepId, 1);
});

test('highest_resolution puts pixels first and score second', () => {
  const g = [img(1, { width: 100, height: 100 }), img(2, { width: 200, height: 200, derivative: true }), img(3, { width: 200, height: 200 })];
  assert.equal(choose(g, 'highest_resolution').keepId, 3);
});

test('keep_original prefers the original, then a non-rendition, then the oldest', () => {
  assert.equal(choose([img(1, { mtime_ms: 1 }), img(2, { original: true, mtime_ms: 9e12 })], 'keep_original').keepId, 2);
  assert.equal(choose([img(1, { webOptimized: true, mtime_ms: 1 }), img(2, { mtime_ms: 9e12 })], 'keep_original').keepId, 2);
  assert.equal(choose([img(1, { mtime_ms: 2e12 }), img(2, { mtime_ms: 1e12 })], 'keep_original').keepId, 2);
});

test('manual picks the given id, accepting a string', () => {
  const g = [img(1), img(2)];
  const r = choose(g, 'manual', '2');
  assert.equal(r.keepId, 2);
  assert.equal(r.rule, 'manual');
  assert.deepEqual(r.reasons, r.scores.get(2).reasons);
});

test('manual with an unknown id keeps nothing', () => {
  const r = choose([img(1)], 'manual', 99);
  assert.equal(r.keepId, null);
  assert.deepEqual(r.reasons, []);
});

test('an unknown rule falls back to recommended', () => {
  const g = [img(1, { width: 1, height: 1 }), img(2, { width: 2, height: 2 })];
  const r = choose(g, 'nonsense');
  assert.equal(r.rule, 'recommended');
  assert.equal(r.keepId, 2);
  assert.equal(choose(g, 'highest_quality').rule, 'highest_quality');
});

test('choose returns a score for every member and leaves the input order alone', () => {
  const g = [img(2, { bytes: 1 }), img(1, { bytes: 5 })];
  const r = choose(g, 'largest');
  assert.deepEqual([...r.scores.keys()].sort(), [1, 2]);
  assert.deepEqual(g.map((m) => m.id), [2, 1]);
});

test('an empty group keeps nothing', () => {
  const r = choose([]);
  assert.equal(r.keepId, null);
  assert.equal(r.scores.size, 0);
});

test('a member with no metadata still scores', () => {
  const m = { id: 1, kind: 'other' };
  assert.deepEqual(scoreMember(m, [m]), { score: 0, reasons: [] });
});
