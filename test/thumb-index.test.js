'use strict';
// The thumbnail provenance index on its own (H34, H42, H47, H69).
const test = require('node:test');
const assert = require('node:assert/strict');
const ti = require('../thumb-index');

const KEY = ti.keyOfUrl('https://cdn.example.com/a.jpg');
const auds = { Jane: 'general', Ada: 'adult' };
const classify = (input) => auds[input.creator] || 'unknown';

test('an unindexed key has no audience', () => {
  const ix = new ti.ThumbIndex({ classify });
  assert.equal(ix.audienceOf(KEY), null);
  assert.equal(ix.has(KEY), false);
});

test('a shared key takes its strictest provenance, whatever the order (H42)', () => {
  for (const order of [['Ada', 'Jane'], ['Jane', 'Ada']]) {
    const ix = new ti.ThumbIndex({ classify });
    order.forEach((creator, i) => ix.add(KEY, { kind: 'entry', ref: `h:${i}`, in: { creator } }));
    assert.equal(ix.audienceOf(KEY), 'adult', order.join(','));
  }
  const ix = new ti.ThumbIndex({ classify });
  ix.add(KEY, { kind: 'entry', ref: 'h:1', in: { creator: 'Jane' } });
  ix.add(KEY, { kind: 'entry', ref: 'h:2', in: { creator: 'Stranger' } });
  assert.equal(ix.audienceOf(KEY), 'unknown');
});

test('a preview carries the audience of the view it was resolved in', () => {
  const ix = new ti.ThumbIndex({ classify });
  ix.add(KEY, { kind: 'preview', aud: 'general' });
  assert.equal(ix.audienceOf(KEY), 'general');
  ix.add(KEY, { kind: 'entry', ref: 'r:x', in: { creator: 'Ada' } });
  assert.equal(ix.audienceOf(KEY), 'adult');
});

test('the audience follows a reclassification on the next check (H42, H94)', () => {
  const live = { Jane: 'general' };
  const ix = new ti.ThumbIndex({ classify: (i) => live[i.creator] || 'unknown' });
  ix.add(KEY, { kind: 'entry', ref: 'h:1', in: { creator: 'Jane' } });
  assert.equal(ix.audienceOf(KEY), 'general');
  live.Jane = 'adult';
  assert.equal(ix.audienceOf(KEY), 'adult');
});

test('a classify failure counts as unknown, never general', () => {
  const ix = new ti.ThumbIndex({ classify: () => { throw new Error('store damaged'); } });
  ix.add(KEY, { kind: 'entry', ref: 'h:1', in: { creator: 'Jane' } });
  assert.equal(ix.audienceOf(KEY), 'unknown');
});

test('keys are validated and the index survives a save and load', () => {
  const ix = new ti.ThumbIndex({ classify });
  assert.equal(ix.add('../etc/passwd', { kind: 'preview', aud: 'general' }), false);
  assert.equal(ix.add('local-' + 'a'.repeat(40), { kind: 'preview', aud: 'general' }), false);
  const frame = ti.frameId('h:1', Buffer.from('jpeg'));
  assert.match(frame, ti.FRAME_ID_RE);
  ix.add(frame, { kind: 'local', ref: 'h:1', in: { creator: 'Ada', channel: '18plus' } });
  ix.add(KEY, { kind: 'preview', aud: 'general' });
  ix.migratedAt = 123;
  const back = new ti.ThumbIndex({ classify });
  assert.equal(back.load(JSON.parse(JSON.stringify(ix))), true);
  assert.equal(back.migratedAt, 123);
  assert.equal(back.audienceOf(frame), 'adult');
  assert.equal(back.audienceOf(KEY), 'general');
  assert.equal(back.load({ version: 99, keys: {} }), false);
});

test('byte-identical frames of two entries get two ids (H47, H69)', () => {
  const buf = Buffer.from('same frame');
  assert.notEqual(ti.frameId('h:1', buf), ti.frameId('h:2', buf));
  assert.equal(ti.frameId('h:1', buf), ti.frameId('h:1', Buffer.from('same frame')));
});

test('eviction never drops a referenced key, whatever the count (H42)', () => {
  const refs = new Set();
  const ix = new ti.ThumbIndex({ classify, referenced: (r) => refs.has(r) });
  for (let i = 0; i < 30; i++) {
    const k = ti.keyOfUrl(`https://cdn.example.com/${i}.jpg`);
    if (i < 20) {
      refs.add(`h:${i}`);
      ix.add(k, { kind: 'entry', ref: `h:${i}`, in: { creator: 'Jane' }, at: i });
    } else ix.add(k, { kind: 'preview', aud: 'general', at: i });
  }
  const dropped = ix.prune(5);
  assert.equal(dropped.length, 5);
  assert.equal(ix.keys.size, 25);
  for (let i = 0; i < 20; i++) assert.ok(ix.has(ti.keyOfUrl(`https://cdn.example.com/${i}.jpg`)), `referenced ${i}`);
  // The oldest previews went first.
  for (let i = 20; i < 25; i++) assert.equal(ix.has(ti.keyOfUrl(`https://cdn.example.com/${i}.jpg`)), false);
  assert.deepEqual(ix.prune(5), []);
});

test('a key keeps its entry provenances when previews pile up', () => {
  const ix = new ti.ThumbIndex({ classify });
  ix.add(KEY, { kind: 'entry', ref: 'r:x', in: { creator: 'Ada' }, at: 1 });
  for (let i = 0; i < 60; i++) ix.add(KEY, { kind: 'job', ref: `j:${i}`, in: { creator: 'Jane' }, at: 100 + i });
  assert.ok(ix.provsOf(KEY).length <= 24);
  assert.equal(ix.audienceOf(KEY), 'adult');
  assert.deepEqual(ix.refsOf(KEY), ['r:x']);
});
