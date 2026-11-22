'use strict';
// Download error classification and retry-queue backoff, moved verbatim out of
// server.js (Phase 2, slice 7). Pure and stateless: no I/O, no requires, no
// module state. Callers in server.js: the in-job retry loop and the playlist
// watcher (isTransientDownloadError), the sync save paths and queueJobRetry
// (isRetryableError), and the retry queue (retryDelayMs, isRetryableError).

// Some failures are the server saying "not right now" rather than "no":
// YouTube's signed media URLs are short-lived and its rate limiter answers 403
// (and 429) when several jobs run at once. Those deserve another attempt; a
// deleted video or an unsupported site does not.
function isTransientDownloadError(e) {
  // The direct-file path classifies the upstream status itself (err.retryable);
  // its message never matches the pattern below, so a 404 on a not-yet-encoded
  // CDN file used to fail at once under text that promised a retry.
  if (e && e.retryable === true) return true;
  if (e && e.retryable === false) return false;
  return /HTTP Error (403|408|429|5\d\d)|Forbidden|Too Many Requests|timed? ?out|Connection reset|Temporary failure|stalled|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(
    String((e && e.message) || e || '')
  );
}

const RETRY_BACKOFF_MIN = [20, 40, 60, 120, 180, 240, 360]; // minutes; last repeats
function retryDelayMs(attempts) {
  return RETRY_BACKOFF_MIN[Math.min(attempts, RETRY_BACKOFF_MIN.length - 1)] * 60 * 1000;
}
function isRetryableError(err, msg) {
  if (err && err.retryable === true) return true;
  if (err && err.retryable === false) return false;
  // 'stalled' is the stall guard's own wording (a dead-but-open TCP connection):
  // the textbook "try again later", and it used to match neither classifier.
  return /HTTP (403|404|408|425|429|5\d\d)|not published|timeout|timed out|stalled|ECONNRESET|network|EAI_AGAIN/i.test(String(msg || ''));
}

// RETRY_BACKOFF_MIN stays private: exporting the live array would let a caller
// change every later retryDelayMs() result.
module.exports = { isTransientDownloadError, retryDelayMs, isRetryableError };
