'use strict';
// Pure helpers for the retry queue (server.js owns the I/O). Kept separate so
// they can be tested without starting the server.
const path = require('path');

// Dedup on the exact URL (not mediaKey, which drops the query string — xfree
// distinguishes clips only by ?id=). The quality cap is part of the key: the
// same clip queued at 720 and at 1080 are different requests. A missing
// quality and an explicit null/'' are the same request.
function retryKey(e) {
  const q = parseInt(e.quality, 10);
  return `${e.dest || 'elite'}:${e.channel || ''}:${e.folder || ''}:${Number.isFinite(q) ? q : ''}:${e.url}`;
}

// The file name that was actually written: the save functions return the final
// path, so history shows what is on disk (".web.mp4", bracket format, ...).
// Falls back to the computed name only when no path was returned.
function savedFilename(savedPath, fallback) {
  return typeof savedPath === 'string' && savedPath ? path.basename(savedPath) : fallback;
}

// True when the resolved clip is already in the downloaded registry FOR THE
// SAME CHANNEL, so the retry must not download it again. `lookup(sourceUrl,
// site, mediaId)` returns the registry record or null. The registry stores the
// channel for app saves (null for the server shelf), and a clip saved to one
// channel must not cancel a parked save to another: that would silently drop a
// delivery (e.g. main -> 18plus).
function alreadyDownloaded(entry, job, lookup) {
  const rec = lookup(job.sourceUrl || entry.url, job.site, job.mediaId);
  if (!rec) return false;
  const want = (entry.dest || 'elite') === 'elite' ? (entry.channel || null) : null;
  return (rec.channel || null) === want;
}

module.exports = { retryKey, savedFilename, alreadyDownloaded };
