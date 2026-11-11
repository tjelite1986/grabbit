'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { retryKey, savedFilename, alreadyDownloaded } = require('../retry-queue');

const base = { dest: 'elite', channel: 'main', folder: '', url: 'https://example.com/v?id=1' };

test('retryKey: same request collapses, quality and url differences do not', () => {
  assert.equal(retryKey(base), retryKey({ ...base, quality: null }));
  assert.equal(retryKey(base), retryKey({ ...base, quality: '' }));
  assert.equal(retryKey({ ...base, quality: 720 }), retryKey({ ...base, quality: '720' }));
  assert.notEqual(retryKey({ ...base, quality: 720 }), retryKey({ ...base, quality: 1080 }));
  assert.notEqual(retryKey(base), retryKey({ ...base, quality: 720 }));
  assert.notEqual(retryKey(base), retryKey({ ...base, url: 'https://example.com/v?id=2' }));
});

test('retryKey keeps dest and channel isolation', () => {
  assert.notEqual(retryKey(base), retryKey({ ...base, channel: '18plus' }));
  assert.notEqual(retryKey(base), retryKey({ ...base, dest: 'server' }));
});

test('savedFilename reports the file actually written', () => {
  assert.equal(savedFilename('/x/_import/A_-_B.web.mp4', 'A_-_B.mp4'), 'A_-_B.web.mp4');
  assert.equal(savedFilename('/x/_import/B [@A] [id=1].mp4', 'A_-_B.mp4'), 'B [@A] [id=1].mp4');
  assert.equal(savedFilename(undefined, 'A_-_B.mp4'), 'A_-_B.mp4');
});

test('alreadyDownloaded consults the registry with the resolved identity', () => {
  const calls = [];
  const reg = (u, s, m) => { calls.push([u, s, m]); return m === '1' ? { channel: 'main' } : null; };
  const job = { sourceUrl: 'https://example.com/v/1', site: 'example', mediaId: '1' };
  assert.equal(alreadyDownloaded(base, job, reg), true);
  assert.deepEqual(calls[0], ['https://example.com/v/1', 'example', '1']);
  assert.equal(alreadyDownloaded(base, { site: 'example', mediaId: '2' }, reg), false);
  assert.equal(calls[1][0], base.url); // falls back to the queued url
});

test('alreadyDownloaded is per channel: a save to main does not cancel a parked 18plus save', () => {
  const job = { sourceUrl: 'https://example.com/v/1', site: 'example', mediaId: '1' };
  const inMain = () => ({ channel: 'main' });
  assert.equal(alreadyDownloaded({ ...base, channel: 'main' }, job, inMain), true);
  assert.equal(alreadyDownloaded({ ...base, channel: '18plus' }, job, inMain), false);
  // Server shelf records no channel; an app save does not match it either way.
  const onServer = () => ({ channel: null });
  assert.equal(alreadyDownloaded({ ...base, dest: 'server', channel: 'main' }, job, onServer), true);
  assert.equal(alreadyDownloaded({ ...base, channel: 'main' }, job, onServer), false);
  assert.equal(alreadyDownloaded({ ...base, dest: 'server' }, job, inMain), false);
});

test('alreadyDownloaded: nothing in the registry means download', () => {
  assert.equal(alreadyDownloaded(base, { site: 'x', mediaId: '9' }, () => null), false);
});
