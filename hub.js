'use strict';
// Grabbit 2.0 hub: the numbers the dashboard shows, computed from the
// downloaded registry. Kept apart from server.js so the counting rules can be
// tested without a running server.
//
// Counting rules (each one is there because the registry is not a file list):
// - One file can sit under several keys (`id:<site>:<id>` and the URL key), so
//   files are counted by unique filename, never by key.
// - A key without a filename is a mark (playlist dedup, manual mark), not a
//   file. Those are reported apart as `marks`.
// - The kind comes from the extension. Anything not listed is `other`.
// - The creator is the part before `_-_` (the shorts naming). Music and other
//   library files have no creator and are left out of the creator count.

const KINDS = {
  video: ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif'],
  audio: ['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aac', 'm4b'],
};
const KIND_OF = Object.fromEntries(
  Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind]))
);

function kindOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return (m && KIND_OF[m[1].toLowerCase()]) || 'other';
}

// The shorts naming is `<creator>_-_<title>.<ext>`.
function creatorOf(filename) {
  const name = String(filename || '');
  const at = name.indexOf('_-_');
  const creator = at > 0 ? name.slice(0, at) : null;
  // The naming's own fallback for a missing creator is not a creator.
  return creator && creator.toLowerCase() !== 'unknown' ? creator : null;
}

// The site a registry key belongs to: `id:<site>:<id>`, `yt:<id>` or
// `<host><path>`. Hosts lose a leading www./m./music. and a trailing .com so
// that `id:redgifs:x` and `redgifs.com/watch/x` land on the same name.
function siteOf(key) {
  const k = String(key || '');
  if (k.startsWith('yt:')) return 'youtube';
  const raw = k.startsWith('id:') ? k.split(':')[1] || '' : k.split('/')[0];
  const site = raw
    .toLowerCase()
    .replace(/^(www|m|music)\./, '')
    .replace(/\.com$/, '');
  return site || 'unknown';
}

// Midnight of `now` in the server's local time zone (TZ in the container).
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// registry: the downloaded.json object ({ key: { filename, at } }).
function summarize(registry, now = Date.now()) {
  const files = new Map(); // filename -> { at, site }
  let marks = 0;
  for (const [key, entry] of Object.entries(registry || {})) {
    const filename = entry && typeof entry.filename === 'string' && entry.filename ? entry.filename : null;
    if (!filename) {
      marks++;
      continue;
    }
    const at = Number(entry.at) || 0;
    const prev = files.get(filename);
    // A site-native id key names the site better than a URL key does.
    if (!prev) files.set(filename, { at, site: siteOf(key), byId: key.startsWith('id:') || key.startsWith('yt:') });
    else {
      if (at > prev.at) prev.at = at;
      if (!prev.byId && (key.startsWith('id:') || key.startsWith('yt:'))) {
        prev.site = siteOf(key);
        prev.byId = true;
      }
    }
  }
  const today = startOfDay(now);
  const kinds = { video: 0, image: 0, audio: 0, other: 0 };
  const sites = {};
  const creators = new Set();
  let addedToday = 0;
  for (const [filename, f] of files) {
    kinds[kindOf(filename)]++;
    sites[f.site] = (sites[f.site] || 0) + 1;
    const c = creatorOf(filename);
    if (c) creators.add(c.toLowerCase());
    if (f.at >= today) addedToday++;
  }
  return {
    files: files.size,
    addedToday,
    kinds,
    creators: creators.size,
    marks,
    keys: Object.keys(registry || {}).length,
    sites: Object.entries(sites)
      .map(([site, count]) => ({ site, count }))
      .sort((a, b) => b.count - a.count || a.site.localeCompare(b.site)),
  };
}

// Creators with their file counts and sites, most files first. Derived from
// the registry only; the editable profiles (accounts, merge, split) live in
// profiles.js.
function creatorList(registry, { q = '', limit = 200 } = {}) {
  const byCreator = new Map();
  const seen = new Set();
  for (const [key, entry] of Object.entries(registry || {})) {
    const filename = entry && entry.filename;
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    const name = creatorOf(filename);
    if (!name) continue;
    const id = name.toLowerCase();
    let c = byCreator.get(id);
    if (!c) byCreator.set(id, (c = { name, files: 0, sites: new Set(), lastAt: 0 }));
    c.files++;
    c.sites.add(siteOf(key));
    c.lastAt = Math.max(c.lastAt, Number(entry.at) || 0);
  }
  const needle = String(q || '').trim().toLowerCase();
  const all = [...byCreator.values()]
    .filter((c) => !needle || c.name.toLowerCase().includes(needle))
    .sort((a, b) => b.files - a.files || b.lastAt - a.lastAt);
  return {
    total: all.length,
    items: all.slice(0, Math.max(1, Math.min(1000, limit))).map((c) => ({
      name: c.name,
      files: c.files,
      sites: [...c.sites].sort(),
      lastAt: c.lastAt || null,
    })),
  };
}

// `Name|https://url,Name|https://url` -> [{ name, url }]. Only https URLs pass,
// so a typo cannot put a javascript: link in the sidebar.
function parseAppLinks(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => {
      const at = part.indexOf('|');
      if (at < 1) return null;
      const name = part.slice(0, at).trim().slice(0, 40);
      const url = part.slice(at + 1).trim();
      try {
        return name && new URL(url).protocol === 'https:' ? { name, url } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 8);
}

module.exports = { KINDS, kindOf, creatorOf, siteOf, startOfDay, summarize, creatorList, parseAppLinks };
