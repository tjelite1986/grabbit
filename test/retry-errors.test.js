'use strict';
// Parity for the Phase 2 slice 7 move (expected values captured from the
// pre-move server.js). A behaviour change belongs in its own commit with its
// own test update.
const test = require('node:test');
const assert = require('node:assert');
const {
  isTransientDownloadError, RETRY_BACKOFF_MIN, retryDelayMs, isRetryableError,
} = require('../retry-errors');

// [message, isTransientDownloadError, isRetryableError(null, message)]
const CASES = [
  ['HTTP Error 403: Forbidden', true, false],
  ['HTTP Error 404: Not Found', false, false],
  ['HTTP Error 503', true, false],
  ['Too Many Requests', true, false],
  ['Read timed out', true, true],
  ['Connection reset by peer', true, false],
  ['stalled: no data for 120s', true, true],
  ['getaddrinfo EAI_AGAIN', true, true],
  ['Unsupported URL', false, false],
  ['Private video', false, false],
  ['HTTP 404', false, true],
  ['HTTP 425', false, true],
  ['not published yet', false, true],
  ['network error', false, true],
  ['timeout', true, true],
];

test('isTransientDownloadError classifies by message for errors and strings', () => {
  for (const [msg, transient] of CASES) {
    assert.strictEqual(isTransientDownloadError(new Error(msg)), transient, msg);
    assert.strictEqual(isTransientDownloadError(msg), transient, msg);
  }
  assert.strictEqual(isTransientDownloadError(null), false);
  assert.strictEqual(isTransientDownloadError(undefined), false);
});

test('isRetryableError classifies by the message argument', () => {
  for (const [msg, , retryable] of CASES) assert.strictEqual(isRetryableError(null, msg), retryable, msg);
  assert.strictEqual(isRetryableError(null, undefined), false);
});

test('an explicit err.retryable flag wins over the message in both classifiers', () => {
  const yes = Object.assign(new Error('Unsupported URL'), { retryable: true });
  const no = Object.assign(new Error('HTTP Error 503'), { retryable: false });
  assert.strictEqual(isTransientDownloadError(yes), true);
  assert.strictEqual(isTransientDownloadError(no), false);
  assert.strictEqual(isRetryableError(yes, 'Unsupported URL'), true);
  assert.strictEqual(isRetryableError(no, 'timeout'), false);
  // Only the booleans count; a truthy non-boolean falls through to the message.
  assert.strictEqual(isRetryableError({ retryable: 1 }, 'Unsupported URL'), false);
});

test('retryDelayMs walks the backoff table and repeats the last step', () => {
  assert.deepStrictEqual(RETRY_BACKOFF_MIN, [20, 40, 60, 120, 180, 240, 360]);
  assert.deepStrictEqual([0, 1, 6, 7, 50].map(retryDelayMs), [1200000, 2400000, 21600000, 21600000, 21600000]);
});
