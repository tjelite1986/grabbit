"use strict";
// The hub plays an 18+ film library straight from its folder. Only films the
// scan listed, their posters and their cached frames may ever be served.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("../adflix-library");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "grabbit-adflix-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "grabbit-adflix-out-"));
process.on("exit", () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function put(rel, body = "x", mtime) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

const SCENE = "Studio A - 2024-06-25 - Night Shift [WEBDL-720p]";
const NFO = `﻿<?xml version="1.0" encoding="utf-8"?>
<episodedetails>
  <plot>She &amp; he &#x2014; a <![CDATA[long]]> night.</plot>
  <title>Night Shift</title>
  <year>2024</year>
  <premiered>2024-06-25</premiered>
  <runtime>31</runtime>
  <genre>Drama</genre>
  <genre>Drama</genre>
  <tag>Office</tag>
  <actor><name>Jane Doe</name><role>Lead</role></actor>
  <actor><name>John Roe</name></actor>
</episodedetails>`;

put(`adults/Studio A/${SCENE}/${SCENE}.mp4`, "film1", 3000000);
put(`adults/Studio A/${SCENE}/${SCENE}.nfo`, NFO);
put(`adults/Studio A/${SCENE}/${SCENE}-poster.png`);
put("adults/Studio A/Studio A_-_Loose_Film.mp4", "film2", 2000000);
put("adults/Studio A/Studio A_-_Loose_Film.jpg");
put("adults/Studio A/tvshow.nfo", "<tvshow><title>Studio A</title></tvshow>");
put("adults/Studio B/Collection/Part 1/deep.mp4", "film3", 1000000);
put("adults/Studio B/notes.txt", "not media");
put("adults/Studio B/old.mkv", "mkv");
put("adults/swedish/Dvd/VIDEO_TS/VTS_01_1.VOB", "vob");
put("adults/swedish/Dvd/VIDEO_TS/menu.mp4", "dvd");
put("adults/_tmp/half.mp4", "tmp");
put("adults/.hidden/x.mp4", "hidden");
put(".posters/x.mp4", "cache");
put(
  `.posters/${lib.thumbName(`adults/Studio A/${SCENE}/${SCENE}.mp4`)}`,
  "frame",
);
put("_private/secret.mp4", "secret");
fs.writeFileSync(path.join(outside, "escape.mp4"), "outside");
fs.symlinkSync(
  path.join(outside, "escape.mp4"),
  path.join(root, "adults", "Studio B", "escape.mp4"),
);
fs.symlinkSync(outside, path.join(root, "adults", "Studio B", "linked"));

test("the nfo gives title, dates, plot, runtime, genres and cast", () => {
  const n = lib.parseNfo(NFO.replace(/^﻿/, ""));
  assert.equal(n.title, "Night Shift");
  assert.equal(n.year, 2024);
  assert.equal(n.date, "2024-06-25");
  assert.equal(n.plot, "She & he — a long night.");
  assert.equal(n.runtime, 31);
  assert.deepEqual(n.genres, ["Drama", "Office"]);
  assert.deepEqual(n.actors, ["Jane Doe", "John Roe"]);
  assert.deepEqual(lib.parseNfo("<tvshow><title>Show</title></tvshow>"), {});
  assert.deepEqual(lib.parseNfo("not xml"), {});
});

test("a title without an nfo comes from the file name", () => {
  assert.deepEqual(lib.titleFromName(SCENE, "Studio A"), {
    title: "Night Shift",
    date: "2024-06-25",
  });
  assert.deepEqual(lib.titleFromName("Studio A_-_Loose_Film", "Studio A"), {
    title: "Loose Film",
    date: undefined,
  });
  assert.equal(
    lib.titleFromName("Other - Title", "Studio A").title,
    "Other - Title",
  );
});

test("the listing holds playable films only, newest first", () => {
  const items = lib.scanLibrary(root);
  assert.deepEqual(
    items.map((i) => i.id),
    [
      `adults/Studio A/${SCENE}/${SCENE}.mp4`,
      "adults/Studio A/Studio A_-_Loose_Film.mp4",
      "adults/Studio B/Collection/Part 1/deep.mp4",
    ],
  );
  const [a, b, c] = items;
  assert.equal(a.studio, "Studio A");
  assert.equal(a.section, "adults");
  assert.equal(a.title, "Night Shift");
  assert.equal(a.year, 2024);
  assert.equal(a.poster, `adults/Studio A/${SCENE}/${SCENE}-poster.png`);
  assert.equal(a.thumb, `.posters/${lib.thumbName(a.id)}`);
  assert.equal(b.title, "Loose Film");
  assert.equal(b.poster, "adults/Studio A/Studio A_-_Loose_Film.jpg");
  assert.equal(b.thumb, null);
  assert.equal(c.studio, "Studio B");
  assert.equal(c.title, "deep");
});

test("resolve serves a listed film, its poster and its frame", () => {
  const l = lib.createLibrary(root);
  const id = `adults/Studio A/${SCENE}/${SCENE}.mp4`;
  assert.equal(fs.readFileSync(l.resolve(id, "video"), "utf8"), "film1");
  assert.ok(l.resolve(id, "poster").endsWith("-poster.png"));
  assert.equal(fs.readFileSync(l.resolve(id, "thumb"), "utf8"), "frame");
  assert.equal(
    l.resolve("adults/Studio A/Studio A_-_Loose_Film.mp4", "thumb"),
    null,
  );
});

test("resolve refuses everything the scan did not list", () => {
  const l = lib.createLibrary(root);
  for (const id of [
    "_private/secret.mp4",
    "adults/_tmp/half.mp4",
    "adults/.hidden/x.mp4",
    ".posters/x.mp4",
    "adults/Studio B/escape.mp4",
    "adults/Studio B/linked/escape.mp4",
    "adults/Studio B/old.mkv",
    "adults/Studio B/notes.txt",
    "adults/swedish/Dvd/VIDEO_TS/menu.mp4",
    "adults/Studio A/../../_private/secret.mp4",
    `adults/Studio A/${SCENE}/${SCENE}.nfo`,
    "",
    null,
  ]) {
    assert.equal(l.resolve(id, "video"), null, String(id));
  }
  assert.equal(l.resolve(`adults/Studio A/${SCENE}/${SCENE}.mp4`, "nfo"), null);
});

test("a listed file swapped for a link out of the root is refused", () => {
  const l = lib.createLibrary(root);
  const id = "adults/Studio B/Collection/Part 1/deep.mp4";
  assert.ok(l.resolve(id, "video"));
  const file = path.join(root, id);
  fs.renameSync(file, `${file}.bak`);
  fs.symlinkSync(path.join(outside, "escape.mp4"), file);
  try {
    assert.equal(l.resolve(id, "video"), null);
  } finally {
    fs.unlinkSync(file);
    fs.renameSync(`${file}.bak`, file);
  }
});

test("the library caches its scan for the ttl", () => {
  let t = 0;
  let scans = 0;
  const l = lib.createLibrary(root, {
    ttlMs: 1000,
    now: () => t,
    scan: (r) => (scans++, lib.scanLibrary(r)),
  });
  l.list();
  l.list();
  l.resolve("x", "video");
  assert.equal(scans, 1);
  t = 2000;
  l.list();
  assert.equal(scans, 2);
  l.list({ fresh: true });
  assert.equal(scans, 3);
});
