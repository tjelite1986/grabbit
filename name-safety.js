'use strict';
// Pure file-name sanitizers, moved verbatim out of server.js (Phase 2, slice 1).
// No I/O, no state, no requires: every function depends only on its arguments
// and the global Buffer, so behaviour is identical to the in-server originals.

// elite-v2's importer treats the part before `_-_` as the profile name and only
// accepts [A-Za-z0-9 ._-()] there, so sanitize the creator to that set.
// Filesystem name limits are counted in BYTES per path segment (255 on ext4),
// not characters — a 100-character Arabic or emoji title is well past that and
// the save dies with ENAMETOOLONG. Cut on a code-point boundary so no character
// is split in half.
function clampBytes(text, maxBytes) {
  const str = String(text || '');
  if (Buffer.byteLength(str) <= maxBytes) return str;
  let out = '';
  let used = 0;
  for (const ch of str) {
    const size = Buffer.byteLength(ch);
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out.trim();
}

function safeCreator(name) {
  return (
    String(name || 'unknown')
      .replace(/[^A-Za-z0-9 ._()-]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'unknown'
  );
}

// Title goes after `_-_`; underscores become spaces on import, so keep spaces
// and drop the separator-like sequences to avoid confusing the parser. Unicode
// letters/numbers (e.g. ÅÄÖ) are kept — only filesystem-unsafe chars are dropped.
// (elite-v2's importer only sanitizes the on-disk name; the real title still
// shows via the .md caption sidecar, and the profile part stays ASCII.)
function safeTitle(title) {
  const cut = (
    String(title || 'video')
      .replace(/[^\p{L}\p{N} ._()-]+/gu, ' ')
      .replace(/_-_| - /g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100)
  );
  // Non-latin titles fit far fewer characters into the byte budget.
  return clampBytes(cut, 120) || 'video';
}

// A single path segment of the Navidrome library tree ([Artist]/[Album (Year)]/
// [Title].ext). Unlike safeTitle, hyphens are kept (band/song names use them);
// only filesystem-unsafe characters go, and leading/trailing dots (hidden files
// / Windows quirks) are trimmed.
function safeMusicPart(name, fallback) {
  const cut = (
    String(name || '')
      .replace(/[<>:"\/\\|?*\u0000-\u001f]+/gu, " ")
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 80)
      .trim()
  );
  return clampBytes(cut, 100) || fallback;
}

module.exports = { clampBytes, safeCreator, safeTitle, safeMusicPart };
