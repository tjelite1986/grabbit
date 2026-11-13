"use strict";
// Read-only view of an 18+ film library, for the hub's film page.
//
// The library is `<root>/<section>/<studio>/...`: a film is either a loose
// video in the studio folder or a video in a folder of its own, beside a
// Kodi/Jellyfin style `<stem>.nfo` and a `<stem>-poster.png`. Folders whose
// name starts with `.` or `_` are skipped, and so is anything a browser cannot
// play (a DVD's VIDEO_TS, for one). Grabbit never writes here: mount the
// folder read-only.
//
// `<root>/.posters/<sha1 of the film's path>.jpg` is a frame the library's
// earlier player cached for every film; it is the grid thumbnail.
//
// The browser names a film by its path inside the root, and the server only
// serves a path its own scan listed, after checking that the real path stays
// inside the root.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  isPlainName,
  insideRoots,
  kindOfName,
  extOf,
} = require("./media-viewer");

// What a browser plays without help; .mkv and DVD files are left out.
const VIDEO_EXTS = ["mp4", "m4v", "webm", "mov"];
const POSTER_EXTS = ["jpg", "jpeg", "png", "webp"];
// How deep below a section a film may sit (section/studio/film/part/x.mp4 = 3).
const MAX_DEPTH = 3;
const THUMB_DIR = ".posters";
// Enough for any real .nfo; a bigger file is read only this far.
const NFO_BYTES = 256 * 1024;
const MAX_GENRES = 40;
const MAX_ACTORS = 30;
const MAX_PLOT = 4000;

const isListedName = (name) =>
  isPlainName(name) && !name.startsWith(".") && !name.startsWith("_");
const stemOf = (name) => {
  const e = extOf(name);
  return e ? name.slice(0, -(e.length + 1)) : name;
};

function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeCodePoint(parseInt(d, 10), m))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
function safeCodePoint(n, fallback) {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
  } catch {
    return fallback;
  }
}
const clean = (s) => decodeXml(s).replace(/\s+/g, " ").trim();

// Every `<tag>text</tag>` directly holding text, in order.
function tagValues(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml))) {
    const v = clean(m[1]);
    if (v && !v.includes("<")) out.push(v);
  }
  return out;
}

// The parts of an .nfo the page shows. -> {} when nothing is usable.
function parseNfo(xml) {
  const text = String(xml || "");
  if (!/<(movie|episodedetails|video)\b/i.test(text)) return {};
  const first = (tag) => tagValues(text, tag)[0] || "";
  const out = {};
  const title = first("title");
  if (title) out.title = title;
  const year = parseInt(first("year"), 10);
  if (year >= 1900 && year <= 2100) out.year = year;
  const date = first("premiered") || first("aired") || first("releasedate");
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) out.date = date.slice(0, 10);
  const plot = first("plot") || first("outline");
  if (plot) out.plot = plot.slice(0, MAX_PLOT);
  const runtime = parseInt(first("runtime"), 10);
  if (runtime > 0) out.runtime = runtime;
  const studio = first("studio");
  if (studio) out.studio = studio;
  const genres = [
    ...new Set([...tagValues(text, "genre"), ...tagValues(text, "tag")]),
  ];
  if (genres.length) out.genres = genres.slice(0, MAX_GENRES);
  const actors = [];
  const re = /<actor\b[^>]*>([\s\S]*?)<\/actor>/gi;
  let m;
  while ((m = re.exec(text)) && actors.length < MAX_ACTORS) {
    const name = tagValues(m[1], "name")[0];
    if (name && !actors.includes(name)) actors.push(name);
  }
  if (actors.length) out.actors = actors;
  return out;
}

// `Studio - 2024-06-25 - Some Title [WEBDL-720p]` -> { title, date }.
function titleFromName(stem, studio) {
  let t = String(stem || "");
  const low = t.toLowerCase();
  const st = String(studio || "").toLowerCase();
  if (st && (low.startsWith(`${st} - `) || low.startsWith(`${st}_-_`)))
    t = t.slice(st.length + 3);
  let date;
  const d = /^(\d{4}-\d{2}-\d{2}) - (.+)$/.exec(t);
  if (d) {
    date = d[1];
    t = d[2];
  }
  t = t
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title: t || String(stem || ""), date };
}

function readHead(
  file,
  max,
  { open = fs.openSync, read = fs.readSync, close = fs.closeSync } = {},
) {
  let fd;
  try {
    fd = open(file, "r");
    const buf = Buffer.alloc(max);
    const n = read(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8").replace(/^﻿/, "");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        close(fd);
      } catch {}
    }
  }
}

// The poster that belongs to `stem` in a folder's file list, or null. A
// folder holding a single film may also use poster.jpg / folder.jpg.
function posterFor(stem, files, single) {
  const has = new Set(files);
  const tries = [];
  for (const e of POSTER_EXTS)
    tries.push(`${stem}-poster.${e}`, `${stem}.${e}`, `${stem}-thumb.${e}`);
  if (single)
    for (const base of ["poster", "folder", "cover"])
      for (const e of POSTER_EXTS) tries.push(`${base}.${e}`);
  return tries.find((n) => has.has(n)) || null;
}

const thumbName = (rel) =>
  `${crypto.createHash("sha1").update(rel).digest("hex")}.jpg`;

// One pass over the library. -> [{ id, section, studio, title, year, date,
// plot, runtime, genres, actors, video, poster, thumb, bytes, mtime }] newest
// first; `id`, `video`, `poster` and `thumb` are paths relative to the root,
// with `/`.
function scanLibrary(
  root,
  {
    readdir = fs.readdirSync,
    stat = fs.statSync,
    readText = (f) => readHead(f, NFO_BYTES),
  } = {},
) {
  let sections;
  try {
    sections = readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  let thumbs = new Set();
  try {
    thumbs = new Set(readdir(path.join(root, THUMB_DIR)));
  } catch {}
  const items = [];
  for (const s of sections) {
    if (!s.isDirectory() || !isListedName(s.name)) continue;
    walk([s.name], 0);
  }
  // `parts` is the folder's path below the root, one segment per entry.
  function walk(parts, depth) {
    let entries;
    try {
      entries = readdir(path.join(root, ...parts), { withFileTypes: true });
    } catch {
      return;
    }
    // Regular files and folders only: a symlink could point out of the library.
    const files = entries
      .filter((e) => e.isFile() && isPlainName(e.name))
      .map((e) => e.name);
    const videos = files.filter(
      (n) => VIDEO_EXTS.includes(extOf(n)) && !n.startsWith("."),
    );
    for (const name of videos) {
      const rel = [...parts, name];
      let st;
      try {
        st = stat(path.join(root, ...rel));
      } catch {
        continue;
      }
      const stem = stemOf(name);
      const studio = parts[1] || null;
      const thumb = thumbName(rel.join("/"));
      const nfoName = files.includes(`${stem}.nfo`)
        ? `${stem}.nfo`
        : videos.length === 1 && files.includes("movie.nfo")
          ? "movie.nfo"
          : null;
      const nfo = nfoName
        ? parseNfo(readText(path.join(root, ...parts, nfoName)))
        : {};
      const fromName = titleFromName(stem, studio);
      const poster = posterFor(stem, files, videos.length === 1);
      items.push({
        id: rel.join("/"),
        section: parts[0],
        studio,
        title: nfo.title || fromName.title,
        year:
          nfo.year ||
          (fromName.date ? Number(fromName.date.slice(0, 4)) : null),
        date: nfo.date || fromName.date || null,
        plot: nfo.plot || null,
        runtime: nfo.runtime || null,
        genres: nfo.genres || [],
        actors: nfo.actors || [],
        video: rel.join("/"),
        poster: poster ? [...parts, poster].join("/") : null,
        thumb: thumbs.has(thumb) ? `${THUMB_DIR}/${thumb}` : null,
        bytes: st.size,
        mtime: Math.round(st.mtimeMs),
      });
    }
    if (depth > MAX_DEPTH) return;
    for (const e of entries) {
      if (
        e.isDirectory() &&
        isListedName(e.name) &&
        e.name.toUpperCase() !== "VIDEO_TS"
      )
        walk([...parts, e.name], depth + 1);
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
}

// The scan is cached: the library is a finished collection that changes
// rarely, and it sits on a network share where a full walk takes a while.
function createLibrary(
  root,
  {
    ttlMs = 10 * 60000,
    now = Date.now,
    scan = scanLibrary,
    realpath = fs.realpathSync,
  } = {},
) {
  let cache = null;
  function load(fresh) {
    const t = now();
    if (fresh || !cache || t - cache.at > ttlMs) {
      const items = scan(root);
      cache = { at: t, items, byId: new Map(items.map((i) => [i.id, i])) };
    }
    return cache;
  }
  return {
    root,
    list: ({ fresh = false } = {}) => load(fresh).items,
    // A film id from the browser and 'video', 'poster' or 'thumb' -> the real
    // path of that file, or null. Only what the scan listed is ever served.
    resolve(id, want = "video") {
      if (
        typeof id !== "string" ||
        !["video", "poster", "thumb"].includes(want)
      )
        return null;
      const it = load(false).byId.get(id);
      const rel = it && it[want];
      if (!rel) return null;
      const segs = rel.split("/");
      if (!segs.every(isPlainName)) return null;
      if (kindOfName(rel) !== (want === "video" ? "video" : "image"))
        return null;
      return insideRoots(path.join(root, ...segs), [root], realpath);
    },
  };
}

module.exports = {
  THUMB_DIR,
  thumbName,
  parseNfo,
  titleFromName,
  posterFor,
  scanLibrary,
  createLibrary,
};
