'use strict';
// Read-only view of the 18+ shorts app's media library, for the hub's player.
//
// The library is `<root>/<creator folder>/<stem>.web.mp4` with `<stem>.jpg` as
// its poster. Folders whose name starts with `_` or `.` are the app's own
// (cookies, temp files, avatars), except `_unsorted`, which holds clips without
// a creator. Grabbit never writes here: the deploy mounts the folder read-only.
//
// The browser names a clip by `<folder>/<file>`, never by a full path. Every
// request is checked again: two plain segments, a listed folder, a media file,
// and a real path inside the root.
const fs = require('fs');
const path = require('path');
const { isPlainName, insideRoots, kindOfName, extOf } = require('./media-viewer');

const UNSORTED = '_unsorted';
const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mov'];
const POSTER_EXTS = ['jpg', 'jpeg', 'png', 'webp'];

// A folder the library lists: a plain name, not one of the app's own.
function isLibraryFolder(name) {
  if (!isPlainName(name)) return false;
  if (name === UNSORTED) return true;
  return !name.startsWith('_') && !name.startsWith('.');
}

// `x.web.mp4`, `x.src.mp4` and `x.jpg` all belong to the clip `x`.
// -> { stem, role: 'web'|'src'|'video'|'poster' } or null for anything else.
function partOf(name) {
  if (typeof name !== 'string' || name.startsWith('.')) return null;
  const m = /^(.+)\.(web|src)\.([a-z0-9]+)$/i.exec(name);
  if (m && VIDEO_EXTS.includes(m[3].toLowerCase())) return { stem: m[1], role: m[2].toLowerCase() };
  const ext = extOf(name);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : '';
  if (!stem) return null;
  if (VIDEO_EXTS.includes(ext)) return { stem, role: 'video' };
  if (POSTER_EXTS.includes(ext)) return { stem, role: 'poster' };
  return null;
}

// The app writes names like `Caption_words_h_tag_f_Creator_id_1a2b_`: the
// caption, then optional hashtag, creator and source id parts, all with
// underscores for spaces. Older imports use `<creator>_-_<caption>`.
// -> a caption for the screen; the stem itself when nothing is left.
function titleOf(stem) {
  const s = String(stem || '');
  const m = /^(.*?)(?:_h_(.*?))?(?:_f_(.+?))?(?:_id_([^_]+))?_?$/.exec(s);
  let t = m && m[1] ? m[1] : s;
  const dash = t.indexOf('_-_');
  if (dash > 0 && dash < t.length - 3) t = t.slice(dash + 3);
  t = t.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || s.replace(/_+/g, ' ').trim();
}

// One pass over the library. -> [{ id, folder, creator, title, video, poster,
// bytes, mtime }] newest first; `video` and `poster` are file names in `folder`.
function scanLibrary(root, { readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  let folders;
  try {
    folders = readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const d of folders) {
    if (!d.isDirectory() || !isLibraryFolder(d.name)) continue;
    let names;
    try {
      names = readdir(path.join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    const clips = new Map();
    // Regular files only: a symlink could point out of the library.
    for (const e of names) {
      if (!e.isFile()) continue;
      const n = e.name;
      const p = partOf(n);
      if (!p) continue;
      let c = clips.get(p.stem);
      if (!c) clips.set(p.stem, (c = {}));
      if (!c[p.role]) c[p.role] = n;
    }
    for (const [stem, c] of clips) {
      // The web copy is what the app itself plays; fall back to the original.
      const video = c.web || c.video || c.src;
      if (!video) continue;
      let st;
      try {
        st = stat(path.join(root, d.name, video));
      } catch {
        continue;
      }
      items.push({
        id: `${d.name}/${video}`,
        folder: d.name,
        creator: d.name === UNSORTED ? null : d.name,
        title: titleOf(stem),
        video,
        poster: c.poster || null,
        bytes: st.size,
        mtime: Math.round(st.mtimeMs),
      });
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
}

// `<folder>/<file>` from the browser -> the real path, or null. `want` is
// 'video' or 'poster'; a poster is looked up beside the clip, by its stem.
function resolveClip(root, id, want = 'video', { readdir = fs.readdirSync, realpath = fs.realpathSync } = {}) {
  if (!root || typeof id !== 'string') return null;
  const parts = id.split('/');
  if (parts.length !== 2) return null;
  const [folder, file] = parts;
  if (!isLibraryFolder(folder) || !isPlainName(file)) return null;
  const clip = partOf(file);
  if (!clip || clip.role === 'poster') return null;
  let name = file;
  if (want === 'poster') {
    let names;
    try {
      names = readdir(path.join(root, folder));
    } catch {
      return null;
    }
    name = names.find((n) => {
      const p = partOf(n);
      return p && p.role === 'poster' && p.stem === clip.stem;
    });
    if (!name) return null;
  } else if (want !== 'video') return null;
  const kind = kindOfName(name);
  if (kind !== (want === 'poster' ? 'image' : 'video')) return null;
  return insideRoots(path.join(root, folder, name), [root], realpath);
}

// The scan is cached for a short while: the page, the feed and a refresh all
// ask for the same list, and the library changes a few times an hour.
function createLibrary(root, { ttlMs = 60000, now = Date.now, scan = scanLibrary } = {}) {
  let cache = null;
  return {
    root,
    list({ fresh = false } = {}) {
      const t = now();
      if (fresh || !cache || t - cache.at > ttlMs) cache = { at: t, items: scan(root) };
      return cache.items;
    },
    resolve: (id, want) => resolveClip(root, id, want),
  };
}

module.exports = { UNSORTED, isLibraryFolder, partOf, titleOf, scanLibrary, resolveClip, createLibrary };
