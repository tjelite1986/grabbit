'use strict';
// Parity for the Phase 2 slice 8 move (expected values captured from the
// pre-move server.js). A behaviour change belongs in its own commit with its
// own test update.
const test = require('node:test');
const assert = require('node:assert');
const { durationKnown, fmtClock, contentDisposition, safeExt, imageMime } = require('../media-format');

test('durationKnown accepts anything Number() turns finite', () => {
  const jobs = [{ duration: 12 }, { duration: '12' }, { duration: '' }, { duration: null }, {}, null, { duration: 'abc' }, { duration: Infinity }];
  // '' and null count as known (Number() gives 0); a missing field and Infinity do not.
  assert.deepStrictEqual(jobs.map(durationKnown), [true, true, true, true, false, true, false, false]);
});

test('fmtClock rounds to whole seconds and never goes negative', () => {
  assert.deepStrictEqual(
    [0, 59, 59.5, 60, 61, 600, 3600, -5, '90', null, NaN].map(fmtClock),
    ['0:00', '0:59', '1:00', '1:00', '1:01', '10:00', '60:00', '0:00', '1:30', '0:00', '0:00']
  );
});

test('contentDisposition gives an ASCII fallback and a UTF-8 filename*', () => {
  assert.strictEqual(contentDisposition('clip.mp4'), `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`);
  assert.strictEqual(
    contentDisposition('Låt – ÅÄÖ.mp3'),
    `attachment; filename="L_t _ ___.mp3"; filename*=UTF-8''L%C3%A5t%20%E2%80%93%20%C3%85%C3%84%C3%96.mp3`
  );
  assert.strictEqual(contentDisposition('日本.webm'), `attachment; filename="__.webm"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.webm`);
  assert.strictEqual(contentDisposition(''), `attachment; filename="download"; filename*=UTF-8''`);
  assert.throws(() => contentDisposition(null), TypeError);
});

test('safeExt keeps lowercase alphanumerics and falls back when nothing is left', () => {
  assert.deepStrictEqual(['MP4', '.jpg', 'we bp', null, '', '###'].map((e) => safeExt(e, 'bin')), ['mp4', 'jpg', 'webp', 'bin', 'bin', 'bin']);
});

test('imageMime maps png, webp and gif and treats everything else as JPEG', () => {
  assert.deepStrictEqual(
    ['png', 'webp', 'gif', 'jpg', 'PNG', undefined].map(imageMime),
    ['image/png', 'image/webp', 'image/gif', 'image/jpeg', 'image/jpeg', 'image/jpeg']
  );
});
