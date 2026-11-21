'use strict';
// Pure download-option parsers and MIME helpers, moved verbatim out of server.js
// (Phase 2, slice 2). No I/O, no requires: each function depends only on its
// arguments (parseAt also reads the clock), so behaviour is identical to the
// in-server originals. parseExtraArgs and ALLOWED_ARGS stay in server.js on
// purpose: they are the yt-dlp security allowlist and move separately, if ever.

// Output containers for a server-library video save (yt-dlp --merge-output-format).
const VIDEO_CONTAINERS = ['mp4', 'mkv', 'webm'];

// A resolution cap (e.g. "1080") for yt-dlp, or null. Bounded to sane heights.
function parseQuality(q) {
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n >= 144 && n <= 4320 ? n : null;
}

// yt-dlp --audio-quality: '0' (best VBR) for "best", '<n>K' for an allowed kbps,
// or null (leave yt-dlp's default). Accepts '0'/'best' as best.
function parseAudioQuality(q) {
  if (q === '0' || q === 'best') return '0';
  const n = parseInt(q, 10);
  return Number.isFinite(n) && n >= 32 && n <= 320 ? `${n}K` : null;
}

// A video output container for the server library (default mp4).
function parseContainer(c) {
  return VIDEO_CONTAINERS.includes(c) ? c : 'mp4';
}

// SponsorBlock mode: 'remove' cuts the segments out, 'mark' keeps them but
// embeds them as chapters. '1' is the legacy checkbox value (= remove).
function parseSponsor(v) {
  if (v === '1' || v === 'remove') return 'remove';
  return v === 'mark' ? 'mark' : null;
}

// yt-dlp flags for a parsed SponsorBlock mode.
function sponsorArgs(mode) {
  if (mode === 'remove') return ['--sponsorblock-remove', 'all'];
  if (mode === 'mark') return ['--sponsorblock-mark', 'all'];
  return [];
}

// "0:30-1:45, 90-120" -> ['*0:30-1:45', '*90-120'] for --download-sections.
// Each part is a start-end pair in seconds or [hh:]mm:ss. Throws on junk so the
// user learns the format instead of silently downloading the whole video.
const SECTION_RE = /^\d+(?::\d{1,2}){0,2}(?:\.\d+)?-\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/;
function parseSections(s) {
  const out = [];
  for (const part of String(s || '').split(',').map((t) => t.trim()).filter(Boolean)) {
    if (!SECTION_RE.test(part)) throw new Error(`Bad cut section "${part}" — use start-end like 1:30-2:45`);
    out.push('*' + part);
    if (out.length > 20) throw new Error('Too many cut sections (max 20)');
  }
  return out;
}

// Scheduled-download start time: epoch ms or an ISO datetime, capped to a year
// ahead. null when absent/invalid/already past.
function parseAt(v) {
  if (!v) return null;
  const n = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  if (!Number.isFinite(n)) return null;
  if (n < Date.now() + 15 * 1000) return null;
  return Math.min(n, Date.now() + 366 * 24 * 3600 * 1000);
}

// MIME for a delivered/served audio file.
function audioMime(afmt) {
  return (
    {
      mp3: 'audio/mpeg',
      opus: 'audio/ogg',
      vorbis: 'audio/ogg',
      flac: 'audio/flac',
      wav: 'audio/wav',
      aac: 'audio/aac',
      m4a: 'audio/mp4',
      alac: 'audio/mp4',
    }[afmt] || 'audio/mpeg'
  );
}

// MIME for a delivered/served video file by container.
function videoMime(container) {
  return container === 'webm' ? 'video/webm' : container === 'mkv' ? 'video/x-matroska' : 'video/mp4';
}

module.exports = {
  VIDEO_CONTAINERS,
  parseQuality,
  parseAudioQuality,
  parseContainer,
  parseSponsor,
  sponsorArgs,
  parseSections,
  parseAt,
  audioMime,
  videoMime,
};
