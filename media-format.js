'use strict';
// Small formatting helpers moved verbatim out of server.js (Phase 2, slice 8).
// Pure and stateless: no I/O, no requires, no module state. Callers in
// server.js: the shorts duration guard (durationKnown, fmtClock), file
// downloads (contentDisposition) and the image save path (safeExt, imageMime).

function durationKnown(job) {
  return Number.isFinite(Number(job && job.duration));
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// Content-Disposition value safe for non-ASCII names (RFC 6266): an ASCII
// fallback plus a UTF-8 filename* so ÅÄÖ etc. survive the download.
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function safeExt(ext, fallback) {
  const e = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e || fallback;
}

function imageMime(ext) {
  return ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/jpeg';
}

module.exports = { durationKnown, fmtClock, contentDisposition, safeExt, imageMime };
