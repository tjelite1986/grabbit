'use strict';
// Grabbit 2.0 Instagram inbox: the pure part. The patched Instagram app drops
// what it saves into a folder per username (media file + schema-2 JSON
// sidecar, and a `<username>.json` profile sidecar now and then). This module
// reads that folder and turns what it finds into inbox entries; the server
// stages them, runs the audience gate and delivers. Nothing here writes,
// moves or deletes a file, so it can be tested on a plain temp folder.
//
// Rules, each one a promise to the owner:
// - A file younger than the settle time is left alone: the upload may still
//   be running. Dotfiles and partial names are never touched.
// - A sidecar is read, never trusted for paths: its `media_file` must name a
//   file in the same folder, and the creator is the folder name.
// - A folder name that is not an Instagram username is left in place and
//   reported, never guessed at.
// - Every item key ends in a stable site id: the post shortcode, plus the
//   position for a carousel, so two pictures of one post never collide.
// - Delivery plans only ever name general apps for a general item; the server's
//   gate and the database trigger still decide.

const fs = require('fs');
const path = require('path');

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|heic|mp4|m4v|mov|webm)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const PARTIAL = /\.(part|tmp|crdownload|filepart|partial|download)$/i;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;

// The destinations an inbox item can be delivered to automatically, in order.
const AUTO_DESTINATIONS = ['egram', 'main', 'platform'];
// Apps that take videos only (Tikshortis and Platform are shorts apps).
const VIDEO_ONLY = new Set(['main', 'platform', '18plus']);

const DEFAULTS = {
  settleMs: 2 * 60 * 1000,
  // A media file whose sidecar never arrives (or the reverse) waits this long.
  orphanMs: 30 * 60 * 1000,
  // A carousel is delivered as one post; members that are late get this long.
  groupWaitMs: 30 * 60 * 1000,
};

const SETTINGS_DEFAULT = { auto: { egram: true, main: false, platform: false }, keepDays: 7 };

// The owner's inbox settings, with anything unknown dropped. egram is on by
// default because it is what the bridge did before; the general shorts apps
// are opt-in.
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const a = r.auto && typeof r.auto === 'object' ? r.auto : {};
  const auto = {};
  for (const d of AUTO_DESTINATIONS) auto[d] = typeof a[d] === 'boolean' ? a[d] : SETTINGS_DEFAULT.auto[d];
  const n = Number(r.keepDays);
  const keepDays = Number.isInteger(n) && n >= 1 && n <= 90 ? n : SETTINGS_DEFAULT.keepDays;
  return { auto, keepDays };
}

// A schema-2 Instagram sidecar, or null.
function parseSidecar(text) {
  let j;
  try {
    j = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (Number(j.schema_version) !== 2 || j.source !== 'instagram') return null;
  return j;
}

const isPlainName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.startsWith('.') &&
  !/[/\\\0]/.test(n) && n !== '..';
const stemOf = (name) => name.replace(/\.[^.]+$/, '');
const intOr = (v, min) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : null;
};
function httpsInstagram(u) {
  try {
    const p = new URL(String(u));
    const host = p.hostname.replace(/^(www|m)\./, '');
    return p.protocol === 'https:' && host === 'instagram.com' ? p.href.slice(0, 2000) : null;
  } catch {
    return null;
  }
}

// The caption's first line, cut on a word boundary, for a title.
function captionHead(caption, max = 60) {
  const line = String(caption || '').split('\n').map((l) => l.trim()).find((l) => l && !/^[-.\s]+$/.test(l)) || '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trim();
}

function hashtags(caption) {
  const out = new Set();
  for (const m of String(caption || '').matchAll(/#([\p{L}\p{N}_]{1,100})/gu)) out.add(m[1]);
  return [...out].slice(0, 50);
}

// One media entry: identity, grouping and the job the server's gate and drop
// code understand. `sidecar` may be null (a media file whose sidecar never came).
function mediaEntry(username, mediaName, sidecarName, sidecar) {
  const sc = sidecar || {};
  const stem = stemOf(mediaName);
  const shortcode = typeof sc.shortcode === 'string' && SHORTCODE.test(sc.shortcode) ? sc.shortcode : null;
  const size = intOr(sc.carousel_size, 1) || 1;
  const index = intOr(sc.media_index, 0);
  const pkMatch = String(sc.media_pk || '').match(/^\d{1,30}$/) || stem.match(/_(\d{6,30})$/);
  const mediaPk = pkMatch ? (pkMatch[1] || pkMatch[0]) : null;
  let mediaId = null;
  if (shortcode && size <= 1) mediaId = shortcode;
  else if (shortcode && index !== null) mediaId = `${shortcode}-${index}`;
  else if (shortcode && mediaPk) mediaId = `${shortcode}-pk${mediaPk}`;
  else if (mediaPk) mediaId = `pk${mediaPk}`;
  // No site id at all: the drop's own file name, which the app makes unique.
  else mediaId = `file-${stem.slice(0, 150)}`;
  const caption = typeof sc.caption === 'string' ? sc.caption.slice(0, 5000) : '';
  const sourceUrl = httpsInstagram(sc.post_url) || (shortcode ? `https://www.instagram.com/p/${shortcode}/` : null);
  const mediaType = VIDEO_EXT.test(mediaName) ? 'video' : 'image';
  const head = captionHead(caption);
  return {
    kind: 'media',
    entry: `${username}/${stem}`,
    username,
    mediaFile: mediaName,
    sidecarFile: sidecarName || null,
    key: `id:instagram:${mediaId}`,
    groupKey: shortcode,
    groupSize: shortcode ? size : 1,
    mediaType,
    job: {
      site: 'instagram',
      extractor: 'instagram-inbox',
      mediaId,
      sourceUrl,
      creator: username,
      sourceCreator: username,
      creatorUrl: httpsInstagram(sc.profile_url) || `https://www.instagram.com/${username}/`,
      title: `${head || 'Instagram post'} ${mediaId}`,
      description: caption,
      tags: hashtags(caption),
      mediaType,
      // The app's sidecar as it came, for the item store's raw record (capped
      // there). Instagram gives no tag list: the caption's hashtags are all.
      sourceMeta: sc && typeof sc === 'object' && !Array.isArray(sc) ? { sidecar: sc } : undefined,
    },
  };
}

function profileEntry(username, sidecarName) {
  return { kind: 'profile', entry: `${username}/${stemOf(sidecarName)}`, username, mediaFile: null, sidecarFile: sidecarName };
}

// Reads the drop folder. Returns entries ready to stage, how many stems wait
// (too young, or a half that has not arrived yet) and what is left in place
// for a reason the owner should see.
//   opts.now, opts.settleMs, opts.orphanMs, opts.since (ms; older files are not
//   inbox material and are skipped without a report)
function scanDrop(root, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const settleMs = opts.settleMs != null ? opts.settleMs : DEFAULTS.settleMs;
  const orphanMs = opts.orphanMs != null ? opts.orphanMs : DEFAULTS.orphanMs;
  const since = opts.since != null ? opts.since : null;
  const fsx = opts.fs || fs;
  const out = { entries: [], waiting: 0, ignored: [] };
  let dirs;
  try {
    dirs = fsx.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    throw new Error(`the drop folder cannot be read (${e.code || e.message})`);
  }
  for (const d of dirs) {
    if (d.name.startsWith('.')) continue;
    if (!d.isDirectory()) {
      out.ignored.push({ path: d.name, why: 'a file outside a username folder' });
      continue;
    }
    if (!USERNAME.test(d.name)) {
      out.ignored.push({ path: `${d.name}/`, why: 'the folder name is not an Instagram username' });
      continue;
    }
    scanUser(fsx, path.join(root, d.name), d.name, { now, settleMs, orphanMs, since }, out);
  }
  return out;
}

function scanUser(fsx, dir, username, { now, settleMs, orphanMs, since }, out) {
  let list;
  try {
    list = fsx.readdirSync(dir, { withFileTypes: true });
  } catch {
    out.ignored.push({ path: `${username}/`, why: 'the folder cannot be read' });
    return;
  }
  const stems = new Map();
  for (const f of list) {
    if (f.name.startsWith('.') || !f.isFile() || PARTIAL.test(f.name)) continue;
    let st;
    try {
      st = fsx.statSync(path.join(dir, f.name));
    } catch {
      continue;
    }
    if (since != null && st.mtimeMs < since) continue;
    const s = stemOf(f.name);
    const g = stems.get(s) || { media: [], json: null, other: [], newest: 0, oldest: Infinity };
    if (/\.json$/i.test(f.name)) g.json = f.name;
    else if (MEDIA_EXT.test(f.name)) g.media.push(f.name);
    else g.other.push(f.name);
    g.newest = Math.max(g.newest, st.mtimeMs);
    g.oldest = Math.min(g.oldest, st.mtimeMs);
    stems.set(s, g);
  }
  for (const g of stems.values()) {
    const rel = (n) => `${username}/${n}`;
    for (const n of g.other) out.ignored.push({ path: rel(n), why: 'not a media file or a sidecar' });
    if (!g.json && !g.media.length) continue;
    if (now - g.newest < settleMs) { out.waiting++; continue; }
    if (g.media.length > 1) {
      for (const n of g.media) out.ignored.push({ path: rel(n), why: 'two media files share one name' });
      continue;
    }
    const media = g.media[0] || null;
    if (g.json) {
      let sc = null;
      try {
        sc = parseSidecar(fsx.readFileSync(path.join(dir, g.json), 'utf8'));
      } catch { /* unreadable reads as invalid */ }
      if (!sc) {
        out.ignored.push({ path: rel(g.json), why: 'the sidecar is not schema-2 Instagram JSON' });
        continue;
      }
      if (sc.kind === 'profile') {
        if (media) out.ignored.push({ path: rel(media), why: 'a media file named like a profile sidecar' });
        if (String(sc.username || '').toLowerCase() !== username.toLowerCase()) {
          out.ignored.push({ path: rel(g.json), why: 'the profile sidecar names another username than its folder' });
          continue;
        }
        out.entries.push(profileEntry(username, g.json));
        continue;
      }
      if (media) {
        if (sc.media_file != null && sc.media_file !== media) {
          out.ignored.push({ path: rel(g.json), why: `the sidecar names "${String(sc.media_file).slice(0, 80)}", not ${media}` });
          continue;
        }
        out.entries.push(mediaEntry(username, media, g.json, sc));
        continue;
      }
      if (now - g.oldest < orphanMs) out.waiting++;
      else out.ignored.push({ path: rel(g.json), why: 'a sidecar without its media file' });
      continue;
    }
    if (now - g.oldest < orphanMs) { out.waiting++; continue; }
    if (!isPlainName(media)) continue;
    out.entries.push(mediaEntry(username, media, null, null));
  }
}

// A carousel goes out as one post (egram files a late picture of a known post
// as "already in the library"), so it waits until every member is staged, or
// until the oldest has waited long enough that the rest is not coming.
function groupReady(members, groupSize, now, groupWaitMs = DEFAULTS.groupWaitMs) {
  if (!Array.isArray(members) || !members.length) return false;
  if (!groupSize || groupSize <= 1) return true;
  if (members.length >= groupSize) return true;
  const oldest = Math.min(...members.map((m) => Number(m.received_at) || now));
  return now - oldest >= groupWaitMs;
}

// Which apps this entry goes to automatically. Only a general item goes
// anywhere; the gate and the trigger still have the last word.
//   available: { egram: bool, main: bool, platform: bool } (configured on this deploy)
// -> { deliver: [dest], skipped: [{ dest, why }] }
function deliveryPlan({ kind, mediaType, audience }, { auto = {}, available = {} } = {}) {
  const deliver = [];
  const skipped = [];
  if (audience !== 'general') return { deliver, skipped };
  for (const dest of AUTO_DESTINATIONS) {
    if (!auto[dest]) continue;
    if (kind === 'profile' && dest !== 'egram') continue;
    if (!available[dest]) { skipped.push({ dest, why: 'not configured on this server' }); continue; }
    if (kind !== 'profile' && VIDEO_ONLY.has(dest) && mediaType !== 'video') {
      skipped.push({ dest, why: 'takes videos only' });
      continue;
    }
    deliver.push(dest);
  }
  return { deliver, skipped };
}

// Why a hand delivery of this entry to `dest` cannot happen for reasons of the
// destination's own, or null. The audience gate is separate.
function manualRefusal({ kind, mediaType }, dest) {
  if (kind === 'profile') return dest === 'egram' ? null : 'A profile sidecar only goes to egram.';
  if (!['egram', 'main', 'platform', '18plus'].includes(dest)) return `Unknown destination "${dest}".`;
  if (VIDEO_ONLY.has(dest) && mediaType !== 'video') return 'That app takes videos only.';
  return null;
}

module.exports = {
  AUTO_DESTINATIONS,
  DEFAULTS,
  SETTINGS_DEFAULT,
  normalizeSettings,
  parseSidecar,
  captionHead,
  hashtags,
  mediaEntry,
  scanDrop,
  groupReady,
  deliveryPlan,
  manualRefusal,
};
