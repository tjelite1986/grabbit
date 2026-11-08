'use strict';
// Grabbit 2.0 media viewer: from a history entry to the files on disk that
// belong to it.
//
// The browser names a file by a history entry id and a variant ('original',
// 'web' or 'poster'), never by a path. The server decides which folders an
// entry can live in (its save channel), lists those folders, and only accepts
// a file whose real path stays inside one of the roots this deploy configured.
// A file name from the history log is a single path segment or nothing.
const fs = require('fs');
const path = require('path');

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aac', 'm4b']);
const POSTER_EXT = ['jpg', 'jpeg', 'png', 'webp'];
const VARIANTS = ['original', 'web', 'poster'];
// What a browser can be expected to play or show without help.
const BROWSER_VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov']);
const BROWSER_IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

const extOf = (name) => ((/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1] || '').toLowerCase();

function kindOfName(name) {
  const e = extOf(name);
  if (VIDEO_EXT.has(e)) return 'video';
  if (IMAGE_EXT.has(e)) return 'image';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'other';
}

// A name the history log may hold: one path segment, no traversal, no NUL.
function isPlainName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) return false;
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) return false;
  return path.basename(name) === name;
}

// "x.web.mp4" and "x.mp4" share the stem "x"; so does the poster "x.jpg".
function stemOf(name) {
  if (/\.web\.mp4$/i.test(name)) return name.slice(0, -'.web.mp4'.length);
  const e = extOf(name);
  return e ? name.slice(0, -(e.length + 1)) : name;
}

// Importers tidy a name as they take it: Tikshortis drops trailing dots and
// spaces ("Title ....mp4" is filed as "Title.web.mp4") and collapses runs of
// underscores ("name_____-_x" becomes "name_-_x"). Compare stems that way;
// only names inside the entry's own folder are ever compared.
const looseStem = (stem) => String(stem).replace(/_+/g, '_').replace(/[\s.]+$/u, '');

// Real path of `file` when it lies strictly inside one of `roots`, else null.
// Both sides are resolved, so a symlink out of a root does not count as in it.
function insideRoots(file, roots, realpath = fs.realpathSync) {
  let real;
  try {
    real = realpath(file);
  } catch {
    return null;
  }
  for (const root of roots) {
    if (!root) continue;
    let rr;
    try {
      rr = realpath(root);
    } catch {
      continue;
    }
    const rel = path.relative(rr, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return real;
  }
  return null;
}

// Look for the entry's files in `dirs`, first folder with a match wins.
// -> { dir, original, web, poster } with real paths (any may be null), or null.
function findVariants(filename, dirs, roots, { readdir = fs.readdirSync, realpath = fs.realpathSync } = {}) {
  if (!isPlainName(filename)) return null;
  const stem = stemOf(filename);
  const want = looseStem(stem);
  const kind = kindOfName(filename);
  for (const dir of dirs) {
    if (!dir) continue;
    let names;
    try {
      names = readdir(dir);
    } catch {
      continue;
    }
    const found = { dir, original: null, web: null, poster: null };
    for (const n of names) {
      if (typeof n !== 'string' || n.startsWith('.')) continue;
      if (n !== filename && looseStem(stemOf(n)) !== want) continue;
      const rest = /\.web\.mp4$/i.test(n) ? 'web.mp4' : extOf(n);
      let slot = null;
      if (rest === 'web.mp4') slot = 'web';
      else if (n === filename || (kind !== 'image' && kindOfName(n) === kind)) slot = 'original';
      else if (kind === 'video' && POSTER_EXT.includes(rest)) slot = 'poster';
      if (!slot || found[slot]) continue;
      const real = insideRoots(path.join(dir, n), roots, realpath);
      if (real) found[slot] = real;
    }
    if (found.original || found.web) return found;
  }
  return null;
}

// ffprobe JSON -> the few fields the viewer shows.
function parseProbe(json) {
  let d;
  try {
    d = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const streams = Array.isArray(d.streams) ? d.streams : [];
  const v = streams.find((s) => s && s.codec_type === 'video' && Number(s.width) > 0);
  const a = streams.find((s) => s && s.codec_type === 'audio');
  const dur = Number(d.format && d.format.duration);
  return {
    width: v ? Number(v.width) : null,
    height: v ? Number(v.height) : null,
    videoCodec: v ? v.codec_name || null : null,
    audioCodec: a ? a.codec_name || null : null,
    duration: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 10) / 10 : null,
  };
}

// Whether a browser can show this file as is. HEVC in an mp4 plays in Safari
// and some Chrome builds only, so it is "maybe", not "no".
function playability(kind, ext, probe) {
  if (kind === 'image') return BROWSER_IMAGE.has(ext) ? 'yes' : 'no';
  if (kind === 'audio') return 'yes';
  if (kind !== 'video') return 'no';
  if (!BROWSER_VIDEO.has(ext)) return 'no';
  const c = probe && probe.videoCodec;
  if (!c || ['h264', 'vp8', 'vp9', 'av1'].includes(c)) return 'yes';
  if (c === 'hevc' || c === 'h265') return 'maybe';
  return 'no';
}

module.exports = {
  VARIANTS,
  extOf,
  kindOfName,
  isPlainName,
  stemOf,
  insideRoots,
  findVariants,
  parseProbe,
  playability,
};
