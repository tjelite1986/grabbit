// grabbit - plugin-based media grabber.
// Resolve a pasted URL, embed source + hashtags into the file metadata, name it
// for the shorts importer, save it into the chosen channel's _import
// folder (with a .md caption sidecar) and stream the result to the browser.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const postsPublish = require('./posts-publish');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const extractors = require('./extractors');
const { cleanDescription, parseTrackTitle } = require('./extractors/util');
const { COOKIES_DIR, cookieArgs, cookieFileFor, sanitizeCookieName, listCookieFiles, saveCookieFile, deleteCookieFile } = require('./cookies');
const { safeFetch } = require('./url-guard');
const { releaseSha } = require('./release');
const { isRecoverableYoutubeError, isMusicPremiumLock, findFreeAlternate } = require('./premium-fallback');
const gda = require('./gda');
const platformDrop = require('./platform-drop');
const hub = require('./hub');
const thumbIndexLib = require('./thumb-index');
const profiles = require('./profiles');
const audience = require('./audience');
const itemStore = require('./item-store');
const libraryLib = require('./library');
const tikshortisEmbed = require('./tikshortis-embed');
const tikGateway = require('./tikshortis-gateway');
const egramGateway = require('./egram-gateway');
const adsGateway = require('./adshortis-gateway');
const { createLinkStore: createAdsLinkStore, LOGIN_DAYS: ADS_LOGIN_DAYS } = require('./ads-links');
const modules = require('./modules');
const inbox = require('./inbox');
const mediaViewer = require('./media-viewer');
const adshortisLibrary = require('./adshortis-library');
const adflixLibrary = require('./adflix-library');
const { copyInto } = require('./safe-copy');
const { clampBytes, safeCreator, safeTitle, safeMusicPart } = require('./name-safety');
const {
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
} = require('./download-params');
const { foldName, plainName, titleClose } = require('./name-match');
const { splitArtists, splitList, splitGenres, addEntity, joinEntityRuns } = require('./name-lists');
const { musicNorm, artistParts, titleCandidates, namedIn } = require('./music-match');
const { cleanRuleStr, rulePatternError, ruleTextMatch } = require('./rule-patterns');
const { isTransientDownloadError, retryDelayMs, isRetryableError } = require('./retry-errors');
const { durationKnown, fmtClock, contentDisposition, safeExt, imageMime } = require('./media-format');
const sourceMeta = require('./source-meta');
const smartRouting = require('./smart-routing');
const itemMeta = require('./item-meta');
const dupeScan = require('./dupe-scan');
const { DupeTrash, TrashError } = require('./dupe-trash');
const dupeStore = require('./dupe-store');
const { Analyzer: DupeAnalyzer, readCfg: readDupeCfg } = require('./dupe-analyzer');
const { ModelManager: DupeModels } = require('./dupe-ai');
const { AppAdapter, readToken: readDedupeToken } = require('./dupe-adapters');
const { DupeService } = require('./dupe-service');
const dupeRoutes = require('./dupe-routes');

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
// The interpreter that runs the mutagen snippets: every audio tag Grabbit reads
// or writes goes through one. PYTHON_BIN was documented but never read, so an
// install whose python3 is not on PATH silently lost the whole music feature.
const PYTHON = process.env.PYTHON_BIN || 'python3';
// A child that stops making progress is indistinguishable from a working one:
// nothing here polls it, so it keeps its MAX_ACTIVE_JOBS slot until the
// container restarts — two of them deadlock the whole queue. Every
// long-running child gets a watchdog instead: SIGKILL after CHILD_IDLE_MS
// without a byte of output, and after CHILD_MAX_MS whatever it is doing. The
// reason reads as a timeout on purpose, so isTransientDownloadError() lets the
// job try again rather than giving up on a dead TCP connection.
const CHILD_IDLE_MS = Math.max(60, Number(process.env.CHILD_IDLE_SEC) || 600) * 1000;
const CHILD_MAX_MS = Math.max(300, Number(process.env.CHILD_MAX_SEC) || 6 * 3600) * 1000;

// Returns a reason-getter: non-null once the watchdog killed the child, so the
// close handler can report the timeout instead of a bare "exited null".
function guardChild(child, label) {
  let reason = null;
  const kill = (why) => {
    if (reason) return;
    reason = why;
    console.warn(`watchdog: ${why} — killing pid ${child.pid}`);
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
  };
  const mins = (ms) => Math.round(ms / 60000);
  const hard = setTimeout(() => kill(`${label} timed out after ${mins(CHILD_MAX_MS)} min`), CHILD_MAX_MS);
  if (hard.unref) hard.unref();
  let idle = null;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => kill(`${label} timed out (no output for ${mins(CHILD_IDLE_MS)} min)`), CHILD_IDLE_MS);
    if (idle.unref) idle.unref();
  };
  arm();
  // Also the only reader of a `-progress pipe:1` stream: leaving it unread
  // would fill the pipe buffer and stall the very process being watched.
  if (child.stdout) child.stdout.on('data', arm);
  if (child.stderr) child.stderr.on('data', arm);
  const stop = () => {
    clearTimeout(idle);
    clearTimeout(hard);
  };
  child.on('close', stop);
  child.on('error', stop);
  return () => reason;
}

// Roots of the shorts stores (host folders bind-mounted here). A clip lands in
// <root>/<channel>/_import/ where that library's importer files it minutes
// later. Both channels used to live in elite-v2 and each moved out into an app
// of its own: main to tikshortis on 2026-08-31, 18+ to adshortis on
// 2026-09-15. elite-v2 serves neither any more. The variable names still say
// ELITE because they are the compose keys; only the bind mount behind
// ELITE_ROOT was repointed at the adshortis tree.
//
// Both are opt-in. They are bind mounts of another app's library, so a deploy
// that runs neither app has nowhere for a shorts save to go, and defaulting
// them to this author's container paths only ever produced a dead folder
// inside the container that no importer was watching. Unset means the channel
// does not exist: see shortsUnavailable(), parseDest() and /api/config.
const ELITE_ROOT = process.env.ELITE_ROOT || null;
// No fallback to ELITE_ROOT: that root is the 18+ library, and a general
// channel must never be filed inside it. Unset means no main channel.
const TIKSHORTIS_ROOT = process.env.TIKSHORTIS_ROOT || null;
// A third, general channel: a social app's drop folder (drop-zone contract v1,
// see platform-drop.js). Unlike the other two, the root IS the drop folder: the
// importer removes every item it handles from it, and keeps its own record of
// what it took somewhere this app cannot see.
const PLATFORM_IMPORT_ROOT = process.env.PLATFORM_IMPORT_ROOT || null;
const CHANNELS = { main: 'main', '18plus': '18plus', platform: 'platform' };
const CHANNEL_ROOTS = { main: TIKSHORTIS_ROOT, '18plus': ELITE_ROOT, platform: PLATFORM_IMPORT_ROOT };
// The env var that would configure each channel, for the message a user reads.
const CHANNEL_ROOT_VARS = { main: 'TIKSHORTIS_ROOT', '18plus': 'ELITE_ROOT', platform: 'PLATFORM_IMPORT_ROOT' };
// The 18+ channel (Adshortis) is refused at boot when its folder shares a
// tree with any general destination, rather than risk filing adult clips where
// a general importer reads (or the reverse). realpath where the folder exists,
// so a symlink or a second spelling cannot hide the overlap.
function realDir(dir) {
  if (!dir) return null;
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}
const ADULT_OVERLAPS = CHANNEL_ROOTS['18plus']
  ? gda.adultOverlaps(realDir(path.join(CHANNEL_ROOTS['18plus'], '18plus')), {
      'main channel': realDir(CHANNEL_ROOTS.main && path.join(CHANNEL_ROOTS.main, 'main')),
      'platform drop folder': realDir(CHANNEL_ROOTS.platform),
      'posts import folder': realDir(process.env.ELITE_POSTS_IMPORT_DIR ||
        (process.env.ELITE_POSTS_ROOT ? path.join(process.env.ELITE_POSTS_ROOT, '_import') : null)),
      'egram import folder': realDir(process.env.EGRAM_IMPORT_DIR),
    })
  : [];
const ADULT_BLOCKED = ADULT_OVERLAPS.length
  ? `The 18+ channel is disabled: its folder shares a tree with the ${ADULT_OVERLAPS.map((o) => o.name).join(', ')}. ` +
    'Give ELITE_ROOT a folder of its own.'
  : null;
if (ADULT_BLOCKED) {
  console.error(`[grabbit] ${ADULT_BLOCKED}`);
  CHANNEL_ROOTS['18plus'] = null;
}
const SHORTS_ENABLED = Object.values(CHANNEL_ROOTS).some(Boolean);
// The app serving each channel, for the messages a user reads.
const CHANNEL_LIBRARY = { main: 'Tikshortis', '18plus': 'Adshortis', platform: 'Platform' };
// Root of the photo-posts store (a host folder bind-mounted here). Images saved
// with dest=elite land in <root>/_import/<creator>/, where that app's posts
// importer turns each drop folder into that creator's posts. The library left
// elite-v2 for Elitogram on 2026-09-16; the mount was repointed and the
// destination name kept, so a saved job still means what it did.
// Opt-in for the same reason the shorts roots are.
const POSTS_ROOT = process.env.ELITE_POSTS_ROOT || null;
// Grabbit 3.0 phase 2: POSTS_TO_EGRAM=1 sends those images to Elitogram's own
// import folder (EGRAM_IMPORT_DIR/<creator>/) with the sidecar Elitogram reads
// (<stem>.json: caption, post_key, audience, meta). Opt-in; unset keeps the
// ELITE_POSTS_ROOT folder and its sidecar exactly as before.
const POSTS_TO_EGRAM = process.env.POSTS_TO_EGRAM === '1' && !!process.env.EGRAM_IMPORT_DIR;
if (process.env.POSTS_TO_EGRAM === '1' && !process.env.EGRAM_IMPORT_DIR) {
  console.warn('[grabbit] POSTS_TO_EGRAM=1 needs EGRAM_IMPORT_DIR; posts keep their old destination.');
}
const POSTS_IMPORT_DIR = POSTS_TO_EGRAM
  ? process.env.EGRAM_IMPORT_DIR
  : process.env.ELITE_POSTS_IMPORT_DIR || (POSTS_ROOT ? path.join(POSTS_ROOT, '_import') : null);
const POSTS_ENABLED = !!POSTS_IMPORT_DIR;
// The Instagram inbox (see the inbox section): where the patched app drops,
// and egram's import folder. Both opt-in; unset means no inbox and no egram.
const INBOX_DROP_DIR = process.env.INBOX_DROP_DIR || null;
const EGRAM_IMPORT_DIR = process.env.EGRAM_IMPORT_DIR || null;
// The apps' own libraries, where their importers file what they took. Read by
// the duplicate scan only; mount them read-only. Unset means not scanned.
const ADSHORTIS_LIBRARY_DIR = process.env.ADSHORTIS_LIBRARY_DIR || null;
const EGRAM_LIBRARY_DIR = process.env.EGRAM_LIBRARY_DIR || null;
const PLATFORM_LIBRARY_DIR = process.env.PLATFORM_LIBRARY_DIR || null;
const INBOX_MODE = ['off', 'shadow', 'on'].includes(process.env.INBOX_MODE) ? process.env.INBOX_MODE : 'off';
// Drops older than this (ISO time) are not inbox material: an old app's leftovers.
const INBOX_SINCE = Number.isFinite(Date.parse(process.env.INBOX_SINCE || '')) ? Date.parse(process.env.INBOX_SINCE) : null;
// Whether dest=elite means anything at all on this deploy.
const ELITE_ENABLED = SHORTS_ENABLED || POSTS_ENABLED;
// Audio extraction targets (yt-dlp --audio-format). 'best' keeps the source codec.
const AUDIO_FORMATS = ['best', 'm4a', 'mp3', 'opus', 'flac', 'wav', 'vorbis', 'aac', 'alac'];
// Where the state files live. The container sets DATA_DIR (see the Dockerfile);
// outside Docker the default is repo-relative, because a plain `npm start` as a
// normal user cannot create /data and the README promises it needs no config.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Plain server download library (alternative to the elite-v2 import). Files are
// auto-routed by type; PHOTOS_DIR takes the images that are not sent to posts.
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads');
const VIDEOS_DIR = process.env.VIDEOS_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'videos');
const AUDIO_DIR = process.env.AUDIO_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'mp3');
const ADULTS_DIR = process.env.ADULTS_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'adults');
const PHOTOS_DIR = process.env.PHOTOS_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'photos');
// Navidrome music library (host mount). dest=navidrome saves extracted audio
// here; Navidrome's scanner picks it up.
const NAVIDROME_DIR = process.env.NAVIDROME_MUSIC_DIR || path.join(DOWNLOAD_DIR, 'navidrome');
// Second, fully separate music library served by its own Navidrome instance
// (kids). Same tagging/layout, different root — nothing saved here ever shows
// up in the main library.
const NAVIDROME_KIDS_DIR = process.env.NAVIDROME_KIDS_DIR || path.join(DOWNLOAD_DIR, 'navidrome-kids');
// Audiobook / audio-story library (host mount). dest=audiobooks saves extracted
// audio into <root>/<Author>/<Book>/ — one folder per book or story, whether it
// ends up holding a single file or one file per chapter.
const AUDIOBOOKS_DIR = process.env.AUDIOBOOKS_DIR || path.join(DOWNLOAD_DIR, 'audiobooks');

// Download destination: elite (shorts import), server (plain library),
// navidrome (music library) or audiobooks (book/story library). The last two
// are audio-only and force audio extraction.
function parseDest(v) {
  if (v === 'server' || v === 'navidrome' || v === 'audiobooks') return v;
  // 'elite' is the historical default, but only where it can be written to.
  return ELITE_ENABLED ? 'elite' : 'server';
}

// The two destinations the batch and retry paths pick between, under the same
// rule: with no import root configured the server library is the only answer.
function parseImportDest(v) {
  return v === 'server' || !ELITE_ENABLED ? 'server' : 'elite';
}

// Why a shorts save into this channel cannot happen, or null when it can.
function shortsUnavailable(channel) {
  const ch = CHANNELS[channel] || 'main';
  if (CHANNEL_ROOTS[ch]) return null;
  if (ch === '18plus' && ADULT_BLOCKED) return ADULT_BLOCKED;
  return (
    `No shorts library is configured for the ${ch} channel — set ` +
    `${CHANNEL_ROOT_VARS[ch]} to a bind-mounted host path, or save to the server library instead.`
  );
}

// Same, for the photo-posts import.
function postsUnavailable() {
  return POSTS_ENABLED
    ? null
    : 'No posts library is configured — set ELITE_POSTS_ROOT to a bind-mounted host path, or save to the server library instead.';
}

// The audio-library destinations: extracted audio, tagged, filed into a tree.
function isAudioLibraryDest(dest) {
  return dest === 'navidrome' || dest === 'audiobooks';
}

// Which Navidrome library a dest=navidrome save lands in.
const NAV_LIBS = { main: NAVIDROME_DIR, kids: NAVIDROME_KIDS_DIR };
function parseNavLib(v) {
  return v === 'kids' ? 'kids' : 'main';
}

// Built-in server-library video folders (audio always goes to mp3). Users can
// also pick or create any other subfolder of DOWNLOAD_DIR.
const SERVER_VIDEO_FOLDERS = { videos: VIDEOS_DIR, adults: ADULTS_DIR, photos: PHOTOS_DIR };

// A user-supplied folder name -> a single safe path segment (no traversal).
// Empty -> videos.
function sanitizeFolder(name) {
  return (
    String(name || '')
      .replace(/[^a-zA-Z0-9 _-]+/g, '')
      .replace(/^[ ._-]+|[ ._-]+$/g, '')
      .slice(0, 40) || 'videos'
  );
}

// Library folder for a saved video, chosen explicitly by the user (default
// videos). A built-in name keeps its env-configured path; any other name is a
// (sanitized) subfolder of the grabbit downloads dir, created on demand.
function serverVideoDir(folder) {
  // Own-property check: a plain object lookup lets folder=constructor reach
  // the prototype and return a function, which then crashes path.join.
  if (Object.hasOwn(SERVER_VIDEO_FOLDERS, folder)) return SERVER_VIDEO_FOLDERS[folder];
  return path.join(DOWNLOAD_DIR, sanitizeFolder(folder));
}

// With ADULTS_BY_UPLOADER=1, saves to the adults folder are filed one level
// deeper, in a subfolder named after the uploader (adults/<uploader>/), the
// per-site layout a film library such as Jellyfin or Stash browses by.
const ADULTS_BY_UPLOADER = process.env.ADULTS_BY_UPLOADER === '1';

// Uploader subfolder name inside `dir`. An existing folder that differs only in
// case is reused, so "pervmom" lands beside the "PervMom" already there.
function uploaderFolder(dir, creator) {
  // safeCreator keeps dots, so strip leading ones: "." or ".." must never
  // become a path segment, and a dot folder would be hidden from scanners.
  const name = safeCreator(creator).replace(/^[. ]+|[. ]+$/g, '') || 'unknown';
  try {
    const want = name.toLowerCase();
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && d.name.toLowerCase() === want) return d.name;
    }
  } catch {
    /* dir may not exist yet */
  }
  return name;
}

// Directory a video save actually lands in: the chosen folder, or its uploader
// subfolder when that folder is filed by uploader.
function serverSaveDir(folder, creator) {
  const dir = serverVideoDir(folder);
  if (!ADULTS_BY_UPLOADER || dir !== ADULTS_DIR) return dir;
  return path.join(dir, uploaderFolder(dir, creator));
}

// Display name of a save location for history and messages: "videos", or
// "adults/<uploader>" for an uploader subfolder.
function serverShelf(folder, dir) {
  const base = serverVideoDir(folder);
  return dir === base ? path.basename(base) : `${path.basename(base)}/${path.basename(dir)}`;
}

// List the server-library subfolders (built-ins always included).
function listServerFolders() {
  const set = new Set(['videos', 'adults', 'photos']);
  try {
    for (const d of fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) set.add(d.name);
    }
  } catch {
    /* DOWNLOAD_DIR may not exist yet */
  }
  return [...set].sort();
}

// User-supplied extra yt-dlp flags. Tokenized shell-style, then validated
// against an ALLOWLIST of known-safe long options (value = does it take an
// argument). A denylist is not tenable here: optparse accepts bundled short
// forms (-P/tmp) and flags like --exec/--use-postprocessor/--ppa run programs
// or write arbitrary paths — so short flags, unknown flags and stray
// positional tokens (which yt-dlp would treat as extra URLs) are all refused.
const ALLOWED_ARGS = new Map(Object.entries({
  // subtitles
  '--write-subs': false, '--no-write-subs': false,
  '--write-auto-subs': false, '--no-write-auto-subs': false,
  '--sub-langs': true, '--sub-format': true, '--convert-subs': true,
  '--embed-subs': false, '--no-embed-subs': false,
  // format selection / conversion
  '--format': true, '--format-sort': true,
  '--audio-format': true, '--audio-quality': true,
  '--remux-video': true, '--recode-video': true, '--prefer-free-formats': false,
  // metadata / embedding
  '--embed-metadata': false, '--no-embed-metadata': false,
  '--embed-thumbnail': false, '--no-embed-thumbnail': false,
  '--embed-chapters': false, '--no-embed-chapters': false,
  // SponsorBlock category tuning
  '--sponsorblock-remove': true, '--sponsorblock-mark': true,
  // network / pacing
  '--limit-rate': true, '--retries': true, '--fragment-retries': true,
  '--concurrent-fragments': true, '--socket-timeout': true,
  '--sleep-requests': true, '--sleep-interval': true, '--max-sleep-interval': true,
  '--geo-bypass': false, '--geo-bypass-country': true, '--proxy': true,
  '--force-ipv4': false, '--force-ipv6': false, '--impersonate': true,
  // site auth / tuning
  '--username': true, '--password': true, '--video-password': true, '--twofactor': true,
  '--extractor-args': true, '--referer': true, '--user-agent': true,
  // live streams
  '--live-from-start': false, '--no-live-from-start': false,
}));
function parseExtraArgs(s) {
  const str = String(s || '').trim().slice(0, 500);
  if (!str) return [];
  const tokens = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  for (const ch of str) {
    if (escaped) { cur += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { tokens.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  if (tokens.length > 40) throw new Error('Too many extra arguments');
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eq = t.indexOf('=');
    const flag = eq > 0 ? t.slice(0, eq) : t;
    const takesValue = ALLOWED_ARGS.get(flag);
    if (takesValue === undefined) {
      throw new Error(`Extra argument "${flag}" is not allowed — only a safe subset of long yt-dlp flags is supported`);
    }
    if (!takesValue && eq > 0) throw new Error(`${flag} does not take a value`);
    out.push(t);
    if (takesValue && eq < 0) {
      const v = tokens[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      out.push(v);
    }
  }
  return out;
}

// Shorts are short clips, so a long video must not be imported into the elite-v2
// shorts library — it belongs in the plain server library instead. The cap (in
// seconds) is configurable; 0 disables the guard.
const SHORTS_MAX_DURATION = (() => {
  const n = parseInt(process.env.SHORTS_MAX_DURATION, 10);
  return Number.isFinite(n) && n >= 0 ? n : 600;
})();
function tooLongForShorts(job) {
  return SHORTS_MAX_DURATION > 0 && durationKnown(job) && Number(job.duration) > SHORTS_MAX_DURATION;
}
function shortsTooLongError(job) {
  return `This video is ${fmtClock(job.duration)} long — too long for shorts (max ${fmtClock(SHORTS_MAX_DURATION)}). Save it to the server library instead.`;
}
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = 200;

// Nothing works without it: every state file, the log and the thumbnail cache
// live here. Swallowing the failure left the process up and failing one write
// at a time, with the first symptom somewhere else entirely.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(
    `Cannot create the data directory ${DATA_DIR}: ${e.message}\n` +
      'Set DATA_DIR to a writable path (in Docker it is the /data volume).'
  );
  process.exit(1);
}

// Mirror the console to a file on the data volume. Docker's own log is wiped
// whenever the container is recreated (an image rebuild), which loses exactly
// the failure output worth reading; this one lives with the rest of the data.
// One rotation at LOG_MAX keeps it bounded.
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const LOG_MAX = 5 * 1024 * 1024;
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      const line = `${new Date().toISOString()} [${level}] ${args
        .map((a) => (typeof a === 'string' ? a : a && a.stack ? a.stack : JSON.stringify(a)))
        .join(' ')}\n`;
      if ((fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0) > LOG_MAX) {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      }
      fs.appendFileSync(LOG_FILE, line);
    } catch {
      /* logging must never break a download */
    }
  };
}

// Smart routing decisions, one JSON line each, so every routing choice can be
// traced after the job list and the 200-row history have moved on. Rotated
// once at ROUTING_LOG_MAX like the server log.
const ROUTING_LOG = path.join(DATA_DIR, 'routing.jsonl');
const ROUTING_LOG_MAX = 5 * 1024 * 1024;
function logRoutingDecision(entry) {
  try {
    if ((fs.existsSync(ROUTING_LOG) ? fs.statSync(ROUTING_LOG).size : 0) > ROUTING_LOG_MAX) {
      fs.renameSync(ROUTING_LOG, `${ROUTING_LOG}.1`);
    }
    fs.appendFileSync(ROUTING_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.warn('routing log write failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// State files. Everything Grabbit remembers between restarts is a JSON file in
// DATA_DIR, rewritten whole every time it changes. Two rules keep that safe:
//
//  1. Write through a sibling temp file and rename. A plain writeFileSync
//     truncates the real file before it writes, so a crash, a `docker kill` or
//     a full disk in that window leaves half a file on disk. rename(2) is
//     atomic within a directory: a reader sees either the old file or the new
//     one, never a fragment.
//  2. Never quietly start over. A file that exists but does not parse is
//     damage, not a fresh install. It is set aside as `<name>.corrupt-<stamp>`
//     and restored from the newest daily snapshot when there is one. The dedup
//     registry is the one that really matters — rebuilt empty, every clip ever
//     downloaded looks new again and a watched playlist re-fetches all of it.
const STATE_BACKUP_DIR = path.join(DATA_DIR, 'backups');
// Daily snapshots of the state files, kept this many days. 0 turns them off.
const STATE_BACKUP_DAYS = (() => {
  const n = parseInt(process.env.STATE_BACKUP_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7;
})();
// Snapshotted and reported by /api/health. A file not listed here still gets
// atomic writes; it just isn't worth a snapshot.
const STATE_FILES = [
  'downloaded.json',
  'music.json',
  'history.json',
  'playlists.json',
  'rules.json',
  'templates.json',
  'scheduled.json',
  'retry-queue.json',
  'genres.json',
  'push-subscriptions.json',
  'gda-clients.json',
  'profiles.json',
  'inbox-settings.json',
  'thumb-index.json',
  // Native Adshortis: the key that seals linked sessions. Its login records
  // (ads-logins.json) are left out on purpose: a restored copy would bring
  // revoked links back (see ads-links.js).
  'ads-seal-key.json',
];

// `mode` (optional) is the file mode for a new file, e.g. 0o600 for a key.
function writeJsonAtomic(file, value, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const fd = mode === undefined ? fs.openSync(tmp, 'w') : fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      // rename(2) orders the directory entry, not the data behind it. Without
      // this the file can be in place while its contents are still only in the
      // page cache — which is exactly the state a power cut turns into zeros.
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

// The newest daily snapshot of one state file, or null when none exists.
function newestSnapshot(name) {
  try {
    const days = fs
      .readdirSync(STATE_BACKUP_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
    for (const day of days) {
      const file = path.join(STATE_BACKUP_DIR, day, name);
      try {
        if (fs.statSync(file).size > 0) return file;
      } catch { /* that day didn't hold this file */ }
    }
  } catch { /* no snapshots yet */ }
  return null;
}

// Read a state file. A missing file is a fresh install and returns `fallback`
// silently; a file that exists and does not parse is kept, reported loudly and
// recovered from a snapshot when possible.
function readJsonState(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const name = path.basename(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const kept = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(file, kept);
    } catch {
      // Could not move it aside — leave it alone rather than risk deleting the
      // only copy. It will be reported again on the next read.
    }
    console.error(
      `${name} did not parse (${e.message}). The damaged file is kept as ${path.basename(kept)}.`
    );
    const snap = newestSnapshot(name);
    if (snap) {
      try {
        const restored = JSON.parse(fs.readFileSync(snap, 'utf8'));
        writeJsonAtomic(file, restored);
        console.error(`${name} restored from the snapshot of ${path.basename(path.dirname(snap))}.`);
        return restored;
      } catch {
        console.error(`${name}: the newest snapshot is damaged too.`);
      }
    }
    console.error(`${name}: no usable snapshot — starting empty. Repair the kept file by hand to recover it.`);
    return fallback;
  }
}

// One snapshot directory per day, so a file damaged today can be recovered from
// yesterday. Copies are cheap (the whole state is a couple of megabytes) and a
// day that already ran is skipped, so a container recreated hourly costs nothing.
function snapshotState() {
  if (!STATE_BACKUP_DAYS) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(STATE_BACKUP_DIR, day);
  try {
    if (fs.existsSync(dir)) return dir;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of STATE_FILES) {
      const src = path.join(DATA_DIR, name);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(dir, name);
      fs.copyFileSync(src, `${dst}.part`);
      fs.renameSync(`${dst}.part`, dst);
    }
    // items.db is live SQLite (WAL): a file copy could miss the -wal pages, so
    // the snapshot is a consistent VACUUM INTO copy instead.
    if (ITEM_STORE) {
      try {
        ITEM_STORE.snapshotTo(path.join(dir, 'items.db'));
      } catch (e) {
        console.warn('items.db snapshot failed:', e.message);
      }
    }
    if (DUPE_DX) {
      try {
        DUPE_DX.snapshotTo(path.join(dir, 'dupes.db'));
      } catch (e) {
        console.warn('dupes.db snapshot failed:', e.message);
      }
    }
    // Prune whole days past the retention window.
    const days = fs
      .readdirSync(STATE_BACKUP_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
    for (const old of days.slice(STATE_BACKUP_DAYS)) {
      fs.rmSync(path.join(STATE_BACKUP_DIR, old), { recursive: true, force: true });
    }
    console.log(`state snapshot written to backups/${day}`);
    return dir;
  } catch (e) {
    console.warn('state snapshot failed:', e.message);
    return null;
  }
}

// One shortly after boot (a container recreated daily would otherwise never
// snapshot) and one a day after that.
setTimeout(snapshotState, 60 * 1000).unref();
setInterval(snapshotState, 24 * 60 * 60 * 1000).unref();

let historySeq = 0;

// Number of sites yt-dlp can handle (its --list-extractors count). Filled once
// at boot so /api/sites can advertise "+N more via yt-dlp" without a per-request
// cost. Stays 0 until the (slow) listing finishes.
let ytdlpCount = 0;
function countYtdlpExtractors() {
  const p = spawn(YTDLP, ['--list-extractors']);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => {
    const n = out.split('\n').filter((l) => l.trim()).length;
    if (n > 0) ytdlpCount = n;
  });
  p.on('error', () => {});
}

function readHistory() {
  const list = readJsonState(HISTORY_FILE, []);
  if (!Array.isArray(list)) return [];
  // Backfill ids for any legacy entries so every row is deletable.
  return list.map((e, i) => (e.id ? e : { ...e, id: `legacy-${e.time || 0}-${i}` }));
}

// Prepend an entry and keep the log bounded.
function recordHistory(entry) {
  try {
    const list = readHistory();
    const id = `${Date.now()}-${historySeq++}`;
    list.unshift({ id, time: Date.now(), ...entry });
    writeJsonAtomic(HISTORY_FILE, list.slice(0, HISTORY_MAX));
    noteHistoryThumb(list[0]);
    warmThumb(entry && entry.thumbnail);
  } catch (e) {
    console.warn('history write failed:', e.message);
  }
}

// Remove one entry by id, or all when id is omitted. Returns the new count.
function deleteHistory(id) {
  const list = id ? readHistory().filter((e) => e.id !== id) : [];
  writeJsonAtomic(HISTORY_FILE, list);
  return list.length;
}

// ---------------------------------------------------------------------------
// Downloaded registry: which source videos have already been saved, so
// playlist views can mark them and "download new" skips them. Unlike the
// history log this is unbounded (it's the source of truth for dedup).
const DOWNLOADED_FILE = path.join(DATA_DIR, 'downloaded.json');
let downloadedCache = null;

// Stable identity for a media URL: YouTube variants (music./www./youtu.be/
// shorts) collapse to the video id; other URLs drop query/hash noise.
function mediaKey(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.replace(/^(www|music|m)\./, '');
    if (host === 'youtube.com' || host === 'youtu.be') {
      const id = host === 'youtu.be'
        ? u.pathname.split('/').filter(Boolean)[0]
        : u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
      if (id) return `yt:${id}`;
    }
    return `${host}${u.pathname}`;
  } catch {
    return String(url || '');
  }
}

function readDownloaded() {
  if (!downloadedCache) {
    const stored = readJsonState(DOWNLOADED_FILE, null);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      downloadedCache = stored;
      return downloadedCache;
    }
    // Nothing on disk (or nothing recoverable): seed from the history log so a
    // first run still counts earlier downloads. History is capped at
    // HISTORY_MAX, so this is a floor, not the real registry — readJsonState
    // has already kept any damaged file, which is the copy worth repairing.
    downloadedCache = {};
    for (const e of readHistory()) {
      if (e.sourceUrl) downloadedCache[mediaKey(e.sourceUrl)] = { filename: e.filename || null, at: e.time || Date.now() };
    }
    try {
      writeJsonAtomic(DOWNLOADED_FILE, downloadedCache);
    } catch {
      /* best effort */
    }
  }
  return downloadedCache;
}

// A clip is registered under its URL AND, when the site gave us one, under its
// site-native id — the same video shared as a new link has a different URL but
// the same id, and only the id-key recognises it.
function idKey(site, mediaId) {
  return site && mediaId ? `id:${site}:${mediaId}` : null;
}

// `job` (optional) is the saved item: its picture's provenance is recorded
// with the registry row here, on every save path, so it outlives the
// 200-row history (H47, Codex phase-0 B2). `classChannel` is the channel the
// audience reads (`server/adults` for an 18+ server save); it defaults to
// `channel`.
function markDownloaded(sourceUrl, filename, site, mediaId, channel, job = null, classChannel = undefined) {
  if (!sourceUrl) return;
  if (job && job.thumbnail) {
    noteThumb(job.thumbnail, {
      kind: 'entry',
      ref: `r:${mediaKey(sourceUrl)}`,
      in: thumbIn({ ...job, sourceUrl }, classChannel === undefined ? channel || null : classChannel),
    });
  }
  const map = readDownloaded();
  const entry = { filename: filename || null, at: Date.now(), channel: channel || null };
  map[mediaKey(sourceUrl)] = entry;
  const key = idKey(site, mediaId);
  if (key) map[key] = entry;
  try {
    writeJsonAtomic(DOWNLOADED_FILE, map);
  } catch (e) {
    console.warn('downloaded registry write failed:', e.message);
  }
}

function downloadedEntry(sourceUrl, site, mediaId) {
  const map = readDownloaded();
  const key = idKey(site, mediaId);
  if (key && map[key]) return map[key];
  const urlKey = sourceUrl ? mediaKey(sourceUrl) : null;
  if (!urlKey) return null;
  // The site slug is not stable across the two paths that produce it: a single
  // URL is resolved by yt-dlp and names itself ("youtube"), while a playlist
  // listing has no extractor info and falls back to the hostname
  // ("music.youtube.com"). So an id-key miss is not proof of a new clip and
  // the URL key gets a second chance — but only when it identifies THIS clip.
  // Some extractors (xxxfollow) set sourceUrl to the shared PROFILE url, and
  // trusting that key would mark every clip of a creator as downloaded the
  // moment any single one of them was; such a key never carries the clip's
  // own id, which is exactly what this test looks for.
  if (key && !urlKey.includes(String(mediaId))) return null;
  return map[urlKey] || null;
}

function isDownloaded(sourceUrl, site, mediaId) {
  return !!downloadedEntry(sourceUrl, site, mediaId);
}

// A registry key back into a URL, for rows whose own source url was never
// stored (the registry predates the music log). Only the URL-shaped keys can
// be turned back — an `id:site:mediaId` key carries no address.
function urlFromKey(key) {
  if (!key || key.startsWith('id:')) return null;
  if (key.startsWith('yt:')) return `https://www.youtube.com/watch?v=${key.slice(3)}`;
  return `https://${key}`;
}

// ---------------------------------------------------------------------------
// Music log: one row per track that lives in a Navidrome library. The download
// history is capped at HISTORY_MAX and dominated by video saves, so music
// scrolls out of it within days — this log is uncapped and answers "which
// songs are in the library, and where did each come from". Rows are keyed by
// the track's path inside its library, so a scan can also pick up files that
// arrived some other way (copied in by hand, or downloaded before this log
// existed).
const MUSIC_FILE = path.join(DATA_DIR, 'music.json');
const AUDIO_EXTS = new Set(['.opus', '.m4a', '.mp3', '.flac', '.ogg', '.aac', '.wav', '.webm']);
let musicCache = null;
let musicScanRunning = false;
let musicLastScan = 0;
let musicSeq = 0;
// Artist/title index over the log, rebuilt lazily whenever it changes.
let musicIndex = null;
let musicIndexVersion = -1;
let musicVersion = 0;

function readMusic() {
  if (!musicCache) {
    const data = readJsonState(MUSIC_FILE, null) || {};
    musicCache = Array.isArray(data.tracks) ? data.tracks : [];
    musicLastScan = Number(data.lastScan) || 0;
  }
  return musicCache;
}

function writeMusic(tracks) {
  musicCache = tracks;
  // Invalidates the artist/title index built for library lookups.
  musicVersion++;
  try {
    writeJsonAtomic(MUSIC_FILE, { lastScan: musicLastScan, tracks });
  } catch (e) {
    console.warn('music log write failed:', e.message);
  }
}

function musicKey(lib, file) {
  return `${lib}/${file}`;
}

// Add (or refresh) one track. A re-download of the same path replaces its row
// rather than stacking a second one — the library only holds one such file.
function recordMusic(entry) {
  const tracks = readMusic();
  const key = musicKey(entry.lib, entry.file);
  const at = entry.time || Date.now();
  const i = tracks.findIndex((t) => musicKey(t.lib, t.file) === key);
  const row = { id: `${at}-${musicSeq++}`, time: at, missing: false, ...entry };
  if (i >= 0) tracks[i] = { ...tracks[i], ...row, id: tracks[i].id };
  else tracks.unshift(row);
  writeMusic(tracks);
}

// ---------------------------------------------------------------------------
// "Do we already have this song?" — matching a clip against the library by its
// tags rather than its URL. The downloaded registry only recognises a repeat of
// the same SOURCE; the same track uploaded again (a different video id, another
// channel, a re-upload) is a different source but the same song, and Navidrome
// would end up with it twice.

// Library rows are indexed under every reading of their title, not just the
// tagged one: a YouTube rip is filed with the whole video title as the song
// title ("STARSET - Brave New World (Official Music Video)"), and the song it
// holds is what a later download has to be recognised against.
const TITLE_ROWS_MAX = 25;

function buildMusicIndex() {
  const byTrack = new Map();
  const byTitle = new Map();
  for (const t of readMusic()) {
    if (t.missing) continue;
    const titles = titleCandidates(t.title, t.artists);
    if (!titles.length) continue;
    const parts = artistParts(t.artists && t.artists.length ? t.artists : ['']);
    for (const title of titles) {
      const rows = byTitle.get(title);
      if (!rows) byTitle.set(title, [t]);
      else if (rows.length < TITLE_ROWS_MAX) rows.push(t);
      for (const a of parts.length ? parts : ['']) {
        const key = `${a}|${title}`;
        if (!byTrack.has(key)) byTrack.set(key, t);
      }
    }
  }
  return { byTrack, byTitle };
}

function getMusicIndex() {
  if (!musicIndex || musicIndexVersion !== musicVersion) {
    musicIndex = buildMusicIndex();
    musicIndexVersion = musicVersion;
  }
  return musicIndex;
}

// Artist names the library already files as ONE artist although they look like
// a credit line ("Simon & Garfunkel", "Earth, Wind & Fire"). splitArtists keeps
// those whole on the write surface; a tagged library is the only deterministic
// evidence that "A & B" is a band rather than two people. Only names holding a
// separator are worth keeping. Rebuilt when the library changes.
let knownArtistSet = null;
let knownArtistVersion = -1;

function knownArtist(name) {
  if (!knownArtistSet || knownArtistVersion !== musicVersion) {
    const set = new Set();
    for (const t of readMusic()) {
      for (const a of t.artists || []) {
        if (/[,;&]/.test(String(a))) set.add(foldName(a));
      }
    }
    knownArtistSet = set;
    knownArtistVersion = musicVersion;
  }
  const f = foldName(name);
  return Boolean(f) && knownArtistSet.has(f);
}

// Deezer artist names that read like a credit line, collected per lookup so
// joinEntityRuns (name-lists.js) can put a split band back together.
function addDeezerEntity(entities, c) {
  if (!c || c.source !== 'deezer' || !c.artists || c.artists.length !== 1) return;
  addEntity(entities, c.artists[0], foldName);
}

// A track already in a Navidrome library, or null. `weak` means only the title
// matched (the artist read differently on the two sides) — enough to warn about
// but never enough to skip a download on its own.
function libraryMatch({ artists, title }) {
  const cands = titleCandidates(title, artists);
  if (!cands.length) return null;
  const { byTrack, byTitle } = getMusicIndex();
  const hitOf = (t, weak) => ({ lib: t.lib, file: t.file, title: t.title, artists: t.artists || [], weak });
  const mine = artistParts(artists);
  for (const c of cands) {
    for (const a of mine) {
      const hit = byTrack.get(`${a}|${c}`);
      if (hit) return hitOf(hit, false);
    }
  }
  // A title-only hit is still conclusive when one side names the other's
  // artist inside its title. YouTube rips are filed under the channel with the
  // whole video title as the song title ("You Love Dance.TV" / "Rocco,
  // Pulsedriver & Ninkid – Take me to the Rave"), so the artist regularly
  // lives in the title on exactly one of the two sides.
  const myTitle = musicNorm(title);
  for (const c of cands) {
    const rows = byTitle.get(c);
    if (!rows || !rows.length) continue;
    // Several tracks can share a title; prefer one that ties to this artist.
    const named = rows.find((r) => {
      const theirTitle = musicNorm(r.title);
      return artistParts(r.artists || []).some((a) => namedIn(a, myTitle))
        || mine.some((a) => namedIn(a, theirTitle));
    });
    return hitOf(named || rows[0], !named);
  }
  return null;
}

// The artist/title a resolved job would be filed under, for the lookup above.
// Site music metadata wins; the uploader/title are the fallback every clip has.
function musicIdentity(job) {
  const m = (job && job.music) || {};
  const artists = m.artist ? splitArtists(m.artist) : [];
  if (job && job.creator) artists.push(job.creator);
  return { artists, title: m.track || (job && job.title) || '' };
}

// Read tags off a batch of files in one python process (mutagen, the same
// library the tagger writes with). One JSON object per line back.
const READ_TAGS_SCRIPT = [
  'import sys, json',
  'from mutagen import File',
  'for line in sys.stdin:',
  "    p = line.rstrip('\\n')",
  '    if not p: continue',
  "    out = {'path': p}",
  '    try:',
  '        f = File(p, easy=True)',
  '        t = dict(f.tags or {}) if f is not None else {}',
  '        def vals(k):',
  '            v = t.get(k)',
  '            if v is None: return []',
  '            if isinstance(v, list): return [str(x) for x in v if str(x).strip()]',
  '            return [str(v)] if str(v).strip() else []',
  "        out['artists'] = vals('artist') or vals('albumartist')",
  "        out['title'] = (vals('title') or [''])[0]",
  "        out['album'] = (vals('album') or [''])[0]",
  "        out['date'] = (vals('date') or [''])[0]",
  "        out['genres'] = vals('genre')",
  "        info = getattr(f, 'info', None)",
  "        out['duration'] = round(info.length) if info is not None and getattr(info, 'length', None) else None",
  '    except Exception as e:',
  "        out['error'] = str(e)",
  '    print(json.dumps(out))',
].join('\n');

const READ_DESC_SCRIPT = [
  'import sys, json',
  'from mutagen import File',
  'f = File(sys.argv[1])',
  'out = []',
  'if f is not None and f.tags:',
  '    for k, v in f.tags.items():',
  // MP4 spells its text tags with a leading (c) sign (\xa9des); strip it so one
  // list of names covers every container.
  "        if str(k).lower().lstrip('\\xa9') in ('description', 'des', 'desc', 'ldes', 'comment', 'comm', 'synopsis'):",
  '            text = v if isinstance(v, str) else (str(v[0]) if isinstance(v, list) and v else str(v))',
  '            if text.strip(): out.append(text.strip())',
  'print(json.dumps(out))',
].join('\n');

// The description text carried by the file itself (yt-dlp writes the video
// description into it unless Grabbit cleared it), newest tag first.
function readFileDescription(file) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, ['-c', READ_DESC_SCRIPT, file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve([]));
    p.on('close', () => {
      try {
        const list = JSON.parse(out.trim() || '[]');
        resolve(Array.isArray(list) ? list : []);
      } catch {
        resolve([]);
      }
    });
  });
}

function readTags(paths) {
  return new Promise((resolve) => {
    if (!paths.length) return resolve(new Map());
    const p = spawn(PYTHON, ['-c', READ_TAGS_SCRIPT]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve(new Map()));
    p.on('close', () => {
      if (err.trim()) console.warn('tag read warnings:', err.trim().split('\n').pop());
      const map = new Map();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          map.set(row.path, row);
        } catch {
          /* skip an unparsable row */
        }
      }
      resolve(map);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(paths.join('\n') + '\n');
  });
}

function walkAudio(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) found.push(p);
    }
  }
  return found;
}

// Where a file on disk came from, best effort: the history log knows the exact
// source url of anything grabbit downloaded, the downloaded registry knows at
// least the identity. Both are matched on the file NAME — the library layout
// (artist/album folders) is derived from tags that may since have changed.
function sourceIndexByFilename() {
  const byName = new Map();
  for (const [key, v] of Object.entries(readDownloaded())) {
    if (v && v.filename && !byName.has(v.filename)) byName.set(v.filename, urlFromKey(key));
  }
  // History wins where it has a row: it stores the real url, not a rebuilt one.
  for (const e of readHistory()) {
    if (e.filename && e.sourceUrl) byName.set(e.filename, e.sourceUrl);
  }
  return byName;
}

// Reconcile the log with what is actually on disk: add tracks it has never
// seen (with their tags), and flag rows whose file is gone. Never deletes a
// row — a track that was downloaded and later removed is still an answer to
// "did grabbit fetch this".
async function scanMusicLibraries() {
  if (musicScanRunning) return { skipped: true };
  musicScanRunning = true;
  try {
    const tracks = readMusic();
    const known = new Map(tracks.map((t) => [musicKey(t.lib, t.file), t]));
    const seen = new Set();
    const fresh = [];
    for (const [lib, root] of Object.entries(NAV_LIBS)) {
      for (const p of walkAudio(root)) {
        const file = path.relative(root, p);
        const key = musicKey(lib, file);
        seen.add(key);
        if (!known.has(key)) fresh.push({ lib, root, file, path: p, key });
      }
    }
    const tags = await readTags(fresh.map((f) => f.path));
    const sources = sourceIndexByFilename();
    for (const f of fresh) {
      const t = tags.get(f.path) || {};
      let mtime = Date.now();
      try {
        mtime = fs.statSync(f.path).mtimeMs;
      } catch {
        /* keep the fallback */
      }
      const name = path.basename(f.file);
      tracks.push({
        id: `scan-${Math.round(mtime)}-${musicSeq++}`,
        time: Math.round(mtime),
        lib: f.lib,
        file: f.file,
        filename: name,
        artists: t.artists && t.artists.length ? t.artists : [],
        title: t.title || path.parse(name).name,
        album: t.album || null,
        year: (String(t.date || '').match(/\d{4}/) || [null])[0],
        genres: t.genres || [],
        duration: t.duration || null,
        sourceUrl: sources.get(name) || null,
        // The row was reconstructed from the file itself, not written when the
        // track was downloaded — its time is the file's, not a download time.
        source: 'scan',
        missing: false,
      });
    }
    let gone = 0;
    for (const t of tracks) {
      let missing = !seen.has(musicKey(t.lib, t.file));
      // The walk is a snapshot. A track downloaded while it ran (or while the
      // tag reader worked through the new files) is absent from `seen` even
      // though its file is there — and a row flagged missing is skipped by the
      // library duplicate check, so the same song downloads again. One stat per
      // apparently-missing row settles it.
      if (missing && NAV_LIBS[t.lib]) {
        try {
          missing = !fs.existsSync(path.join(NAV_LIBS[t.lib], t.file));
        } catch { /* unreadable root: trust the walk */ }
      }
      if (missing !== !!t.missing) t.missing = missing;
      if (missing) gone++;
    }
    tracks.sort((a, b) => b.time - a.time);
    musicLastScan = Date.now();
    writeMusic(tracks);
    pruneCovers();
    warmCovers();
    return { added: fresh.length, missing: gone, total: tracks.length };
  } finally {
    musicScanRunning = false;
  }
}

// First pass after boot so the log reflects the library even on a fresh
// install (or after an upgrade that introduced it). Later scans are on demand.
setTimeout(() => {
  scanMusicLibraries()
    .then((r) => r && !r.skipped && console.log(`music scan: ${r.added} new, ${r.missing} missing, ${r.total} total`))
    .catch((e) => console.warn('music scan failed:', String(e.message || e)));
}, 20 * 1000).unref();

// ---------------------------------------------------------------------------
// Saved playlists: subscriptions the user re-opens to check for new tracks.
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
function readPlaylists() {
  const list = readJsonState(PLAYLISTS_FILE, []);
  return Array.isArray(list) ? list : [];
}
function writePlaylists(list) {
  writeJsonAtomic(PLAYLISTS_FILE, list);
}

const app = express();
// Before anything can answer: every /api response, including the gate's 401
// and a parser's 400, carries the cache generation (H62), and every /api/ads
// response the gateway's answer headers.
app.use(cacheGeneration);
app.use((req, res, next) => {
  if (adsGateway.isMountPath(req.path)) adsGateway.baseHeaders(res);
  next();
});
// /api/ads reads its own body, bounded, after its own checks.
const urlencodedParser = express.urlencoded({ extended: false });
const jsonParser = express.json();
app.use((req, res, next) => (adsGateway.isMountPath(req.path) ? next() : urlencodedParser(req, res, next)));
app.use((req, res, next) => (adsGateway.isMountPath(req.path) ? next() : jsonParser(req, res, next)));

// Behind a proxy the socket peer is the proxy, so req.ip carries the same value
// for every visitor unless Express is told which hops to skip. The login
// throttle below keys on req.ip, and getting this wrong is worse than having no
// throttle: too trusting and a forged X-Forwarded-For picks its own key, not
// trusting enough and ten typos from one stranger lock out everybody at once.
// The correct value is deployment-specific — here the Traefik docker network
// plus Cloudflare's ranges, set in compose — so it is configured, never guessed.
// Unset means "no proxy", which is the right answer for a directly exposed port
// and leaves req.ip as the socket peer.
const TRUST_PROXY = (process.env.GRABBIT_TRUST_PROXY || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
if (TRUST_PROXY.length) app.set('trust proxy', TRUST_PROXY);

// --- Auth -----------------------------------------------------------------
// A single shared password gates the public web UI. Only EXTERNAL traffic (via
// Traefik, which sets X-Forwarded-Host) is gated; elite-v2 reaches grabbit
// directly over the docker network (no such header) and stays open, so the
// internal grab integration keeps working. Auth is off entirely when no
// GRABBIT_PASSWORD is set.
//
// Header absence proves nothing about the caller, so on a shared docker
// network every neighbouring container would get the internal bypass. Set
// GRABBIT_INTERNAL_TOKEN to require internal callers to also present it in an
// X-Grabbit-Token header; unset keeps the plain header-based split.
//
// "No password" and "password lost on the way in" look identical to the gate,
// and this service is published. So the open mode has to be asked for: an
// empty GRABBIT_PASSWORD without GRABBIT_AUTH_DISABLED=1 is a misconfigured
// deploy, not a decision, and refusing to start is the only answer that cannot
// be missed. A .env that failed to load, a typo in the key, a compose file
// built from the wrong directory — all of them used to come up wide open.
const GRABBIT_PASSWORD = process.env.GRABBIT_PASSWORD || '';
const AUTH_DISABLED = process.env.GRABBIT_AUTH_DISABLED === '1';
if (!GRABBIT_PASSWORD && !AUTH_DISABLED) {
  console.error(
    'grabbit: GRABBIT_PASSWORD is empty — refusing to start an ungated service.\n' +
      '  Set GRABBIT_PASSWORD (compose/grabbit/.env), or set GRABBIT_AUTH_DISABLED=1\n' +
      '  to run without a login on purpose.'
  );
  process.exit(1);
}
const INTERNAL_TOKEN = process.env.GRABBIT_INTERNAL_TOKEN || '';
const AUTH_SECRET = process.env.GRABBIT_SECRET || GRABBIT_PASSWORD || 'grabbit-dev';
const AUTH_COOKIE = 'grabbit_auth';
const AUTH_TOKEN = crypto
  .createHmac('sha256', AUTH_SECRET)
  .update('grabbit-auth-v1')
  .digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const raw = part.slice(i + 1).trim();
    // A malformed %-sequence (cookie set by some other app on the domain) must
    // not throw inside the auth middleware — that would 500 every request.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw;
    }
  }
  return out;
}

// A missing X-Forwarded-Host used to be enough to count as internal. But that
// header is absent only because Traefik is the thing that adds it, so a request
// that reaches a published container port directly arrives without it too — and
// publishing the port is exactly what the deploy guide's own compose file does.
// Every such deploy ran wide open with GRABBIT_PASSWORD set and no sign of it.
// So the bypass now has to be asked for: without GRABBIT_INTERNAL_TOKEN there is
// no way to tell a neighbouring container from the internet, and therefore no
// internal traffic either.
const isInternal = (req) =>
  !!INTERNAL_TOKEN &&
  !req.headers['x-forwarded-host'] &&
  req.headers['x-grabbit-token'] === INTERNAL_TOKEN;
const isAuthed = (req) => parseCookies(req.headers.cookie)[AUTH_COOKIE] === AUTH_TOKEN;

// --- GDA v1 app clients (gda.js) --------------------------------------------
// Apps may sign in with a password of their own (legacy /login, same cookie
// name, so installed APKs need only a new password in their settings) or with a
// bearer token. Either names a client in DATA_DIR/gda-clients.json, and the
// client's audience and targets decide what it may save. The shared password
// stays the `legacy-shared` client with today's full access.
const gdaRegistry = gda.createRegistry({
  file: path.join(DATA_DIR, 'gda-clients.json'),
  sessionSecret: AUTH_SECRET,
});
const gdaIdempotency = gda.createIdempotency();

function bearerToken(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

// Who a request acts as: a principal, { revoked: true } for a revoked token,
// or null when it carries no valid credential.
function principalOf(req) {
  if (!GRABBIT_PASSWORD) return gda.LEGACY_SHARED; // auth switched off on purpose
  if (isInternal(req)) return gda.INTERNAL;
  if (isAuthed(req)) return gda.LEGACY_SHARED;
  const token = bearerToken(req);
  if (token) {
    const found = gdaRegistry.clientForToken(token);
    if (found && found.client) return gda.principalFor(found.client, 'token');
    return found && found.revoked ? { revoked: true } : null;
  }
  const client = gdaRegistry.clientForSession(parseCookies(req.headers.cookie)[AUTH_COOKIE]);
  return client ? gda.principalFor(client, 'password') : null;
}

// The only paths an app client reaches: sending a link the legacy way, and the
// v1 API. The web UI, history, cookies, music editing and the rest stay with
// the shared password.
function isAppClientPath(req) {
  return (req.method === 'GET' && req.path === '/api/jobs/start') || req.path.startsWith('/api/v1/');
}

// Three endpoints below are GETs with side effects (/api/download,
// /api/download-all, /api/jobs/start) and the session cookie is SameSite=Lax,
// which still rides along on a cross-site top-level navigation. A link, a
// redirect or a window.open from any page on the internet could therefore queue
// a job as the signed-in user. Turning those three into POSTs would break the
// apps that call them synchronously, so the gate refuses what the browser
// itself labels as cross-site instead.
//
// Server-to-server callers send neither header, so the apps on the docker
// network are unaffected. Sec-Fetch-Site covers every current browser; the
// Origin comparison catches a request that carries one without the other.
function isCrossSite(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  const expected = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  let actual;
  try {
    actual = new URL(origin).host.toLowerCase();
  } catch {
    return true; // an Origin no first-party page would send
  }
  return !expected || actual !== expected;
}

// --- Grabbit 3.0: native Adshortis (adshortis-gateway.js, ads-links.js) --------
// ADSHORTIS_MODE=native draws the 18+ module in the hub over Adshortis' API,
// through /api/ads/*. It needs Adshortis' LAN address (ADSHORTIS_API_URL), the
// public origin Adshortis checks writes against (ADSHORTIS_APP_ORIGIN), this
// hub's own public https origin (GRABBIT_PUBLIC_ORIGIN, compared exactly on
// every write) and Grabbit's own sign-in. Missing any: embed (a plain link to
// ADSHORTIS_EMBED_URL) or off. See modules.js adshortisMode().
const ADSHORTIS_API = adsGateway.parseOrigin(process.env.ADSHORTIS_API_URL);
const ADSHORTIS_APP_ORIGIN = adsGateway.parseOrigin(process.env.ADSHORTIS_APP_ORIGIN);
const GRABBIT_PUBLIC_ORIGIN = adsGateway.parseHttpsOrigin(process.env.GRABBIT_PUBLIC_ORIGIN);
const ADSHORTIS_EMBED = adsGateway.parseHttpsOrigin(process.env.ADSHORTIS_EMBED_URL);
for (const [name, ok] of [
  ['ADSHORTIS_API_URL', ADSHORTIS_API],
  ['ADSHORTIS_APP_ORIGIN', ADSHORTIS_APP_ORIGIN],
  ['GRABBIT_PUBLIC_ORIGIN', GRABBIT_PUBLIC_ORIGIN],
  ['ADSHORTIS_EMBED_URL', ADSHORTIS_EMBED],
]) {
  if (process.env[name] && !ok) console.warn(`[grabbit] ${name} is not a valid origin; it is ignored.`);
}
const { mode: ADSHORTIS_MODE, warnings: ADS_MODE_WARNINGS } = modules.adshortisMode(process.env, {
  apiOrigin: ADSHORTIS_API,
  appOrigin: ADSHORTIS_APP_ORIGIN,
  publicOrigin: GRABBIT_PUBLIC_ORIGIN,
  embed: ADSHORTIS_EMBED,
  authOn: !!GRABBIT_PASSWORD && !AUTH_DISABLED,
});
for (const w of ADS_MODE_WARNINGS) console.warn(`[grabbit] ${w}`);
const ADS_LINKS = createAdsLinkStore({ dir: DATA_DIR, writeJsonAtomic });
// A changed mode or Grabbit password drops every Adshortis link (H2), and a
// changed mode bumps the cache generation (H62).
const ADS_BOOT = ADS_LINKS.bootCheck({ mode: ADSHORTIS_MODE, password: GRABBIT_PASSWORD, secret: process.env.GRABBIT_SECRET || '' });
if (ADS_BOOT.dropped) console.log(`[grabbit] Adshortis: dropped ${ADS_BOOT.dropped} link record(s) (${ADS_BOOT.reason}).`);
const CACHE_GEN = ADS_BOOT.gen;
const CACHE_GEN_COOKIE = 'grabbit_cache_gen';
const ADS_GATEWAY =
  ADSHORTIS_MODE === 'native'
    ? adsGateway.createGateway({
        apiUrl: ADSHORTIS_API,
        appOrigin: ADSHORTIS_APP_ORIGIN,
        publicOrigin: GRABBIT_PUBLIC_ORIGIN,
        links: ADS_LINKS,
        // Only the owner's browser session: never the internal token, never an
        // app client (the gate already keeps those off /api/ads).
        isOwner: (req) => req.principal === gda.LEGACY_SHARED,
        clientIp: (req) => req.ip || '',
      })
    : null;

function loginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grabbit — sign in</title>
<link rel="icon" type="image/png" href="/favicon-32.png">
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0c0c0f; color:#eee; font:15px/1.5 system-ui, sans-serif; }
  form { width:280px; padding:28px; background:#16161c; border:1px solid #26262e; border-radius:14px; }
  h1 { margin:0 0 4px; font-size:20px; }
  p { margin:0 0 18px; color:#888; font-size:13px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; margin-bottom:12px;
    background:#0c0c0f; border:1px solid #2c2c36; border-radius:9px; color:#eee; font-size:14px; }
  button { width:100%; padding:10px; border:0; border-radius:9px; background:#e11d48; color:#fff;
    font-size:14px; font-weight:600; cursor:pointer; }
  .err { color:#f87171; font-size:13px; margin-bottom:12px; }
</style></head><body>
<form method="post" action="/login">
  <img src="/icon-192.png" alt="" width="72" height="72" style="display:block;margin:0 auto 10px;border-radius:16px">
  <h1 style="text-align:center">Grabbit</h1>
  <p style="text-align:center">Sign in to continue</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" />
  <button type="submit">Sign in</button>
</form></body></html>`;
}

app.get('/login', (req, res) => {
  if (!GRABBIT_PASSWORD || isAuthed(req)) return res.redirect('/');
  res.type('html').send(loginPage(null));
});

// Password guessing had nothing in its way: unlimited attempts, no delay, and
// no trace in the log that anyone had ever tried. The compare itself is already
// constant-time, so the gap here is rate, not timing.
//
// Counted per client (see the trust proxy note above), never globally: a global
// counter would hand any stranger a standing denial of service against the
// owner's own service for the price of ten wrong passwords. A correct password
// clears the window, so someone who fumbles twice and then gets it right keeps
// a clean slate — but it does NOT bypass the cap: the window is checked first,
// so once it is full every attempt is refused, right password included, until
// the window expires. Verified 2026-09-19 against the live container.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const LOGIN_MAX_KEYS = 5000;
const LOGIN_MAX_DELAYED = 8;
const loginFails = new Map();
let loginDelayed = 0;

// Keys arrive from the network, so the Map is pruned on every write instead of
// being left to grow: expired windows go first, and a hard cap drops the oldest
// if a flood still outruns that.
function pruneLoginFails(now) {
  for (const [key, rec] of loginFails) if (now - rec.first > LOGIN_WINDOW_MS) loginFails.delete(key);
  while (loginFails.size > LOGIN_MAX_KEYS) loginFails.delete(loginFails.keys().next().value);
}

function loginWindow(key) {
  const now = Date.now();
  const rec = loginFails.get(key);
  if (rec && now - rec.first <= LOGIN_WINDOW_MS) return rec;
  const fresh = { first: now, fails: 0 };
  loginFails.set(key, fresh);
  return fresh;
}

// Each failure waits a little longer, which costs a guesser far more than it
// costs a human who mistyped. The cap on concurrently delayed responses is the
// point of the counter: without it an attacker could park the event loop full
// of sleeping handlers, a cheaper attack than the one being prevented.
function delayFailedLogin(fails) {
  if (loginDelayed >= LOGIN_MAX_DELAYED) return Promise.resolve();
  loginDelayed++;
  return new Promise((resolve) =>
    setTimeout(() => {
      loginDelayed--;
      resolve();
    }, Math.min(2000, fails * 250))
  );
}

app.post('/login', async (req, res) => {
  if (!GRABBIT_PASSWORD) return res.redirect('/');
  const key = req.ip || 'unknown';
  const win = loginWindow(key);
  if (win.fails >= LOGIN_MAX_FAILS) {
    const left = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - win.first)) / 1000));
    res.set('Retry-After', String(left));
    return res.status(429).type('html').send(loginPage('Too many attempts. Try again later.'));
  }
  // Compare byte lengths, not string lengths — timingSafeEqual throws on a
  // byte-length mismatch, which multibyte input could otherwise trigger.
  const attempt = typeof req.body.password === 'string' ? Buffer.from(req.body.password) : null;
  const expected = Buffer.from(GRABBIT_PASSWORD);
  const ok = attempt && attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
  // Not the shared password: maybe an app's own (GDA client registry). Bounded
  // length, because every client's scrypt runs on the attempt.
  const client =
    !ok && attempt && attempt.length <= 200 ? gdaRegistry.clientForPassword(req.body.password) : null;
  if (!ok && !client) {
    win.fails++;
    pruneLoginFails(Date.now());
    console.warn(`login: wrong password from ${key} (${win.fails}/${LOGIN_MAX_FAILS} this window)`);
    await delayFailedLogin(win.fails);
    return res.status(401).type('html').send(loginPage('Wrong password.'));
  }
  // Only the shared password clears the failure window. An app password must
  // not: whoever holds one could otherwise reset the window between guesses
  // at the shared password and guess without limit.
  if (ok) loginFails.delete(key);
  if (client) console.log(`login: app client ${client.client_id} from ${key}`);
  res.cookie(AUTH_COOKIE, client ? gdaRegistry.sessionValue(client) : AUTH_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 30 * 24 * 3600 * 1000,
  });
  // Native Adshortis: a fresh per-login id, issued only here and only for the
  // shared password (H2). It replaces any id this browser held before.
  // A failed state write costs the Adshortis id, never the sign-in itself.
  if (ok && ADS_GATEWAY) {
    try {
      const prev = adsGateway.readCookie(req, adsGateway.LOGIN_COOKIE);
      if (prev) ADS_LINKS.dropLogin(prev);
      res.append('Set-Cookie', adsGateway.loginCookie(ADS_LINKS.issueLogin(), ADS_LOGIN_DAYS));
    } catch (e) {
      console.error(`[ads] could not issue a login id: ${e.code || e.message}`);
    }
  }
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  // Native Adshortis: the login id and its seal record go first (that alone
  // ends the link), then the upstream session, best effort (G2). Only for the
  // owner's own page over https: this route sits before the auth gate, and a
  // sibling site's form or a signed-out browser must not reach the link.
  const adsLogin = adsGateway.readCookie(req, adsGateway.LOGIN_COOKIE);
  req.principal = principalOf(req);
  const adsRevoke = !ADS_GATEWAY || ADS_GATEWAY.mayRevoke(req);
  if (adsLogin && ADS_GATEWAY && adsRevoke) {
    const cur = ADS_GATEWAY.sealOf(req, adsLogin);
    try {
      ADS_LINKS.dropLogin(adsLogin);
    } catch (e) {
      console.error(`[ads] could not drop a login id: ${e.code || e.message}`);
    }
    if (cur) ADS_GATEWAY.upstreamLogout(req, cur.t);
  }
  if (adsRevoke) {
    res.append('Set-Cookie', adsGateway.clearCookie(adsGateway.LOGIN_COOKIE));
    res.append('Set-Cookie', adsGateway.clearCookie(adsGateway.LINK_COOKIE));
  }
  // Grabbit 3.0: the linked TikShortis session goes with the Grabbit one, so the
  // next sign-in in this browser does not inherit it. (The hub ends it upstream
  // first; this clears it even when that call did not get through.)
  res.clearCookie(tikGateway.TIK_COOKIE, { path: '/api/tik' });
  res.clearCookie(egramGateway.EGRAM_COOKIE, { path: egramGateway.COOKIE_PATH });
  res.clearCookie(egramGateway.EGRAM_COOKIE_SECURE, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
  res.redirect('/login');
});

// Icons are needed by the login page and browser tabs before auth. The PWA
// manifest and service worker must also stay reachable without a session,
// otherwise install and SW updates break when the auth cookie expires.
const PUBLIC_ASSETS = new Set([
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/manifest.webmanifest',
  '/sw.js',
]);

// Retired in native mode (D3, H1, H19): the folder routes answer 404 and tell
// the browser to drop what it cached from them (H62, H92), signed in or not,
// so a browser whose session ended still gets the header.
if (ADSHORTIS_MODE === 'native') {
  app.all(['/api/hub/adshortis', '/api/hub/adshortis/*'], (_req, res) => {
    res.setHeader('Clear-Site-Data', '"cache"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(404).json({ ok: false, error: 'Not available' });
  });
}

// Gate everything below for external, unauthenticated requests. API calls get a
// 401 JSON; page/asset requests are redirected to the login form.
app.use((req, res, next) => {
  if (PUBLIC_ASSETS.has(req.path)) return next();
  // Deployer identity probe: returns only the release sha, nothing else.
  if (req.path === '/api/health/release' && (req.method === 'GET' || req.method === 'HEAD')) return next();
  // Refused before the session is consulted: a cross-site caller must not be
  // able to act as the signed-in user just because the cookie came along.
  // Express routes ignore case, so this check must too (/API/... reaches /api/...).
  if (req.path.toLowerCase().startsWith('/api/') && isCrossSite(req)) {
    return res.status(403).json({ ok: false, error: 'Cross-site request blocked' });
  }
  const who = principalOf(req);
  if (who && !who.revoked) {
    req.principal = who;
    if (who.audience === 'admin') return next();
    if (isAppClientPath(req)) {
      gdaRegistry.touch(who.id);
      return next();
    }
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ ok: false, error: 'This app password can only send links to Grabbit.' });
    }
    return res.status(403).type('text').send('This password belongs to an app. Sign in with the main password.');
  }
  if (req.path.startsWith('/api/v1/')) {
    return res.status(401).json(new gda.GdaError(who && who.revoked ? 'token_revoked' : 'unauthorized').toJSON());
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return res.redirect('/login');
});

// Cache generation (H62): an /api response to a browser whose generation cookie
// is missing or stale carries Clear-Site-Data: "cache" and the current
// generation. The generation changes with the effective Adshortis mode, so a
// browser drops bytes it was given under the previous mode. The cookie holds no
// secret. Installed first thing after the app is created (see there), so it
// also covers answers given before the auth gate.
function cacheGeneration(req, res, next) {
  if (!req.path.toLowerCase().startsWith('/api/')) return next();
  if (parseCookies(req.headers.cookie)[CACHE_GEN_COOKIE] !== String(CACHE_GEN)) {
    res.setHeader('Clear-Site-Data', '"cache"');
    res.append(
      'Set-Cookie',
      `${CACHE_GEN_COOKIE}=${CACHE_GEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${adsGateway.isSecure(req) ? '; Secure' : ''}`
    );
  }
  next();
}

// The app shell, the service worker, the manifest and the icons must always be
// revalidated. Express sends no Cache-Control of its own, so Cloudflare falls
// back to its default browser TTL of 4 hours — a new icon or a new build then
// stays invisible for that long, and the service worker re-caches the stale
// copy it was served. 'no-cache' still allows caching, it just forces an
// ETag revalidation, which is a cheap 304 for these few small files.
const REVALIDATE = new Set([
  'index.html',
  'sw.js',
  'manifest.webmanifest',
  'favicon-32.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  // The hub's own shell (public/hub/), same reason.
  'hub.js',
  'hub.css',
  // Helpers shared by the native modules (public/hub/shared/).
  'links.js',
  'sheets.js',
  'feed-player.js',
  'feed-player.css',
  // Grabbit 3.0 native TikShortis pages (public/hub/tik/).
  'tik.js',
  'tik.css',
  // Grabbit 3.0.4 Smart Duplicate Manager (public/hub/dupes/).
  'dupes.js',
  'dupes.css',
]);

// The hub is the start page. Grabbit 1's interface lives on at /classic/; it
// still owns the share target (/share) and the old deep links (?tab=, ?action=),
// which installed apps and push notifications keep sending to / and which are
// passed on to it. /hub/ was the hub's address before it became the start page.
const PUBLIC_DIR = path.join(__dirname, 'public');
const queryOf = (req) => {
  const i = req.originalUrl.indexOf('?');
  return i < 0 ? '' : req.originalUrl.slice(i);
};
// The hub's shell carries the build it was served by (H85), so a page can tell
// when the server under it has changed. No sha (not a release build): no meta.
const BUILD_SHA = releaseSha();
const BUILD_META = BUILD_SHA ? `<meta name="grabbit-build" content="${BUILD_SHA}">` : '';
const sendShell = (res, file) => {
  res.setHeader('Cache-Control', 'no-cache');
  if (file === 'hub/index.html' && BUILD_META) {
    return fs.readFile(path.join(PUBLIC_DIR, file), 'utf8', (err, html) => {
      if (err) return res.sendFile(path.join(PUBLIC_DIR, file), { cacheControl: false });
      res.type('html').send(html.replace('<head>', `<head>\n    ${BUILD_META}`));
    });
  }
  res.sendFile(path.join(PUBLIC_DIR, file), { cacheControl: false });
};
app.get('/', (req, res) => {
  if (req.query.tab != null || req.query.action != null) return res.redirect(302, '/classic/' + queryOf(req));
  sendShell(res, 'hub/index.html');
});
// One route for both: Express matches /classic and /classic/ alike (non-strict
// routing), so separate handlers would send /classic/ back to itself.
app.get('/classic', (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect(302, '/classic/' + queryOf(req));
  sendShell(res, 'index.html');
});
app.get(['/hub', '/hub/', '/hub/index.html'], (req, res) => res.redirect(302, '/' + queryOf(req)));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (REVALIDATE.has(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// UMD build of html-to-image, loaded lazily by the client-side screenshot
// tool (privacy panel). Served from node_modules so the repo stays vendor-free.
app.get('/vendor/html-to-image.js', (_req, res) =>
  res.sendFile(require.resolve('html-to-image/dist/html-to-image.js')));

// PWA share-target entry: Android's share sheet opens /share?url=…&text=…; the
// SPA reads the query client-side and prefills the grab box.
app.get('/share', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- Web Push ---------------------------------------------------------------
// Job-finished notifications to installed PWAs. Enabled only when VAPID keys
// are set (generate once with `npx web-push generate-vapid-keys`). Routes sit
// below the auth gate, so only signed-in clients can (un)subscribe.
const VAPID_PUBLIC = process.env.GRABBIT_VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.GRABBIT_VAPID_PRIVATE || '';
const VAPID_SUBJECT = process.env.GRABBIT_VAPID_SUBJECT || 'mailto:admin@mecloud.win';
const pushEnabled = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushEnabled) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
function loadPushSubs() {
  const list = readJsonState(PUSH_SUBS_FILE, []);
  return Array.isArray(list) ? list : [];
}
function savePushSubs() {
  try {
    writeJsonAtomic(PUSH_SUBS_FILE, pushSubs);
  } catch { /* non-fatal; resubscribe survives restarts anyway */ }
}
let pushSubs = loadPushSubs();

app.get('/api/push/key', (_req, res) => res.json({ ok: pushEnabled, key: VAPID_PUBLIC || null }));

app.post('/api/push/subscribe', (req, res) => {
  if (!pushEnabled) return res.status(400).json({ ok: false, error: 'Push is not configured' });
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) {
    return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  }
  pushSubs = pushSubs.filter((s) => s.endpoint !== sub.endpoint).concat([sub]);
  savePushSubs();
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  pushSubs = pushSubs.filter((s) => s.endpoint !== endpoint);
  savePushSubs();
  res.json({ ok: true });
});

function sendPush(payload) {
  if (!pushEnabled || !pushSubs.length) return;
  const body = JSON.stringify(payload);
  for (const sub of [...pushSubs]) {
    webpush.sendNotification(sub, body, { TTL: 3600 }).catch((e) => {
      // Drop expired/revoked subscriptions.
      if (e.statusCode === 404 || e.statusCode === 410) {
        pushSubs = pushSubs.filter((s) => s.endpoint !== sub.endpoint);
        savePushSubs();
      }
    });
  }
}

// A notification is a general surface (a lock screen): an item not
// classified general is named the way the reduced job feed names it (Codex
// phase-0 B5).
function notifyJobFinished(j) {
  if (!pushEnabled || !pushSubs.length) return;
  const hidden = jobAudience(j) !== 'general';
  const shown = hidden ? reducedJob(publicJob(j)) : j;
  const name = hidden ? '18+ or unclassified item' : j.title || j.filename || j.sourceUrl || 'download';
  sendPush(
    j.status === 'done'
      ? { title: 'Download complete', body: name, tag: 'job-' + j.id, url: '/classic/?tab=queue' }
      : { title: 'Download failed', body: name + (shown.error ? ' — ' + shown.error : ''), tag: 'job-' + j.id, url: '/classic/?tab=queue' }
  );
}

// --- Rules engine -----------------------------------------------------------
// Deterministic if-this-then-that rules: when a resolved link matches a rule's
// conditions, the rule's settings pre-fill the download sheet (and, with
// auto=true, a share-target/shortcut entry starts the job without the sheet).
// Plain substring/regex matching, no external services — evaluation is free.
// First enabled matching rule wins, top to bottom; an empty match section
// matches everything (documented catch-all).
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const RULE_QUALITIES = ['best', '2160', '1440', '1080', '720', '480', '360'];
const RULE_BITRATES = ['best', '320', '256', '192', '160', '128', '96'];

function readRules() {
  const list = readJsonState(RULES_FILE, []);
  return Array.isArray(list) ? list : [];
}

// Whitelist every field: rules come from the (authed) UI but are stored and
// replayed into download params, so enum-validate like any other request input.
function sanitizeRules(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  const errors = [];
  for (const r of input.slice(0, 100)) {
    if (!r || typeof r !== 'object') continue;
    const match = r.match && typeof r.match === 'object' ? r.match : {};
    const apply = r.apply && typeof r.apply === 'object' ? r.apply : {};
    const m = {};
    const label = cleanRuleStr(r.name, 60) || 'Rule';
    for (const k of ['site', 'creator', 'title']) {
      const v = cleanRuleStr(match[k], 200);
      if (!v) continue;
      const bad = rulePatternError(v);
      if (bad) errors.push(`"${label}" ${k}: ${bad}`);
      else m[k] = v;
    }
    if (match.mediaType === 'video' || match.mediaType === 'image') m.mediaType = match.mediaType;
    for (const k of ['minDuration', 'maxDuration']) {
      const n = Number(match[k]);
      if (Number.isFinite(n) && n > 0) m[k] = Math.round(n);
    }
    const a = {};
    if ('dest' in apply && ['', 'server', 'navidrome', 'audiobooks'].includes(apply.dest)) a.dest = apply.dest;
    if ('lib' in apply && ['main', 'kids'].includes(apply.lib)) a.lib = apply.lib;
    if ('channel' in apply && CHANNELS[apply.channel]) a.channel = apply.channel;
    const folder = cleanRuleStr(apply.folder, 40);
    if (folder) a.folder = sanitizeFolder(folder);
    if ('quality' in apply && RULE_QUALITIES.includes(apply.quality)) a.quality = apply.quality;
    if (apply.audio === true) a.audio = true;
    if ('afmt' in apply && AUDIO_FORMATS.includes(apply.afmt)) a.afmt = apply.afmt;
    if ('aq' in apply && RULE_BITRATES.includes(apply.aq)) a.aq = apply.aq;
    if ('container' in apply && VIDEO_CONTAINERS.includes(apply.container)) a.container = apply.container;
    if (apply.web === true) a.web = true;
    if ('sponsor' in apply && ['remove', 'mark'].includes(apply.sponsor)) a.sponsor = apply.sponsor;
    if ('device' in apply && ['1', '0'].includes(String(apply.device))) a.device = String(apply.device);
    const creator = cleanRuleStr(apply.creatorOverride, 80);
    if (creator) a.creatorOverride = creator;
    out.push({
      id: cleanRuleStr(r.id, 40) || `r${Date.now()}-${out.length}`,
      name: cleanRuleStr(r.name, 60) || 'Rule',
      enabled: r.enabled !== false,
      auto: r.auto === true,
      match: m,
      apply: a,
    });
  }
  return { rules: out, errors };
}

function matchRule(ctx) {
  let host = '';
  try {
    host = new URL(ctx.url).hostname;
  } catch { /* leave empty */ }
  for (const r of readRules()) {
    if (r.enabled === false) continue;
    const m = r.match || {};
    if (m.site && !(ruleTextMatch(m.site, host) || ruleTextMatch(m.site, ctx.extractor))) continue;
    if (m.creator && !ruleTextMatch(m.creator, ctx.creator)) continue;
    if (m.title && !ruleTextMatch(m.title, ctx.title)) continue;
    if (m.mediaType && ctx.mediaType !== m.mediaType) continue;
    // Duration bounds require a known duration; unknown never satisfies them.
    // (Number(null) is 0, which would slip through a max-only bound.)
    if ((m.minDuration || m.maxDuration) && !Number.isFinite(Number(ctx.duration ?? NaN))) continue;
    if (m.minDuration && !(Number(ctx.duration) >= m.minDuration)) continue;
    if (m.maxDuration && !(Number(ctx.duration) <= m.maxDuration)) continue;
    return r;
  }
  return null;
}

// The slice of a matched rule the UI needs.
function publicRule(r) {
  return r ? { id: r.id, name: r.name, auto: r.auto === true, apply: r.apply || {} } : null;
}

app.get('/api/rules', (_req, res) => res.json({ ok: true, rules: readRules() }));

// Whole-list save: the UI owns ordering, so it always posts the full array.
app.post('/api/rules', (req, res) => {
  const parsed = sanitizeRules(req.body && req.body.rules);
  if (!parsed) return res.status(400).json({ ok: false, error: 'Invalid rules payload' });
  // A refused pattern is reported, never quietly dropped: a rule that loses its
  // only condition matches every link instead of none.
  if (parsed.errors.length) return res.status(400).json({ ok: false, error: parsed.errors.join('; ') });
  const rules = parsed.rules;
  try {
    writeJsonAtomic(RULES_FILE, rules);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
  res.json({ ok: true, rules });
});

function validUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

// The channel's own library folder, and the drop folder inside it.
function channelRoot(channel) {
  const ch = CHANNELS[channel] || 'main';
  // Callers guard with shortsUnavailable() first; this is the backstop that
  // names the missing variable instead of failing inside path.join(null).
  const unavailable = shortsUnavailable(ch);
  if (unavailable) throw new Error(unavailable);
  if (ch === 'platform') return CHANNEL_ROOTS.platform;
  return path.join(CHANNEL_ROOTS[ch], ch);
}

function channelDir(channel) {
  if ((CHANNELS[channel] || 'main') === 'platform') return channelRoot('platform');
  return path.join(channelRoot(channel), '_import');
}

// Why this item cannot be saved into this channel for reasons of its own (not
// the deploy's), or null. First the platform channel's own contract rules.
// Then the audience gate (audience.js): a general app receives only items
// classified general, and Adshortis takes videos only.
function channelRefusal(channel, job) {
  const ch = CHANNELS[channel] || 'main';
  if (ch === 'platform') {
    const own = platformDrop.platformRefusal(job);
    if (own) return own;
  }
  return audienceRefusal(destinationOf(ch, job), job);
}

// The app that will show a clip saved to this channel.
function channelLibrary(channel) {
  return CHANNEL_LIBRARY[CHANNELS[channel] || 'main'];
}

// Mirror lib/shorts-storage.ts profileSlug() so we can find a creator's folder.
function profileSlug(name) {
  return (
    String(name || 'unknown')
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 64) || 'unknown'
  );
}

// Has this clip already been imported into the channel?
//   'imported' -> sitting in the creator's profile folder
//   'pending'  -> still waiting in _import
//   null       -> not present
// The folders an importer may have filed a creator's clips in. Folder names are
// case-sensitive, and Tikshortis files a creator under the spelling of the
// profile it first saw (often lower case), so `SomeCreator` can live in
// `somecreator/`. Checking only the exact spelling made the dedup miss and
// re-drop clips the library already had; its importer then skipped them and
// left them in _import for good.
function creatorDirs(root, creator) {
  const slug = profileSlug(safeCreator(creator));
  const dirs = [path.join(root, slug)];
  if (slug.toLowerCase() !== slug) dirs.push(path.join(root, slug.toLowerCase()));
  return dirs;
}

function importedStatus(channel, creator, stem) {
  const root = channelRoot(channel);
  // The platform drop folder has no creator folders and keeps nothing it took:
  // a clip still in it is waiting, and once gone we cannot tell taken from
  // refused. A re-save is harmless, since the importer dedups on the site id.
  if ((CHANNELS[channel] || 'main') === 'platform') {
    try {
      return fs.readdirSync(root).includes(`${stem}.mp4`) ? 'pending' : null;
    } catch {
      return null;
    }
  }
  for (const profDir of creatorDirs(root, creator)) {
    try {
      if (!fs.existsSync(profDir)) continue;
      const files = fs.readdirSync(profDir);
      if (files.includes(`${stem}.mp4`) || files.includes(`${stem}.web.mp4`)) return 'imported';
    } catch {
      /* ignore */
    }
  }
  try {
    const imp = path.join(root, '_import');
    if (fs.existsSync(imp)) {
      const queued = fs.readdirSync(imp);
      if (queued.includes(`${stem}.mp4`) || queued.includes(`${stem}.web.mp4`)) return 'pending';
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Where a track belongs inside a music library:
// [Artist]/[Album(Year)]/[Artist] - [Album(Year)] - [Title].ext
// Artist + album repeat in the file name on purpose — the file stays traceable
// even when it ends up outside its folder.
function musicLibraryTarget(root, { artist, album, year, title, ext }) {
  const artistDir = safeMusicPart(artist, 'Unknown Artist');
  const albumDir = safeMusicPart(album, 'Unknown Album') + (year ? `(${year})` : '');
  // Three parts of up to 100 bytes each would still overflow the 255-byte
  // limit on their own, so the assembled stem gets its own budget.
  const stemName = `${artistDir} - ${albumDir} - ${safeMusicPart(title, 'Unknown')}`;
  return {
    dir: path.join(root, artistDir, albumDir),
    filename: `${clampBytes(stemName, 200) || 'track'}.${ext}`,
  };
}

// ---------------------------------------------------------------------------
// Audiobook library layout: [Author]/[Book]/[NN - ][Part].ext — one folder per
// book or story. A story that arrives as a single file keeps the plain book
// name; parts (chapter split, or a second file added to an existing book) get
// a zero-padded prefix so the folder sorts in reading order.
const AUDIO_FILE_RE = /\.(m4a|m4b|mp3|opus|ogg|oga|flac|wav|aac|alac|wma)$/i;

function audiobookDir(root, author, book) {
  return path.join(root, safeMusicPart(author, 'Unknown Author'), safeMusicPart(book, 'Unknown Book'));
}

// How many parts a book folder already holds — the basis for the next part
// number, so adding a chapter later continues the numbering instead of
// overwriting part one.
function audiobookPartCount(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => AUDIO_FILE_RE.test(f)).length;
  } catch {
    return 0; // The book folder does not exist yet.
  }
}

// track = null -> unnumbered (the single-file story case).
function audiobookFileName(part, ext, track) {
  const name = clampBytes(safeMusicPart(part, 'Part'), 180) || 'Part';
  return `${track ? String(track).padStart(2, '0') + ' - ' : ''}${name}.${ext}`;
}

// Two jobs run at once by default (MAX_ACTIVE_JOBS), and both may be adding
// parts to the same book. Reserving a part number is read-then-write, so the
// whole reserve+copy runs serialized per book folder.
const bookFolderLocks = new Map();
function withBookFolderLock(dir, fn) {
  const prev = bookFolderLocks.get(dir) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive on failure; the caller still sees the rejection.
  bookFolderLocks.set(dir, next.catch(() => {}));
  return next;
}

// Best effort: drop the source thumbnail next to the book as cover.jpg, which
// is what audiobook players (Audiobookshelf, Symfonium, Navidrome) look for.
async function saveBookCover(meta, dir) {
  const url = meta.thumbnail;
  if (!url) return;
  const target = path.join(dir, 'cover.jpg');
  if (fs.existsSync(target)) return;
  try {
    await downloadDirect({ ...meta, downloadUrl: url, fallbackUrls: [] }, target);
  } catch (e) {
    console.warn('audiobook cover download failed:', String(e.message || e));
    fs.rm(target, { force: true }, () => {});
  }
}

// The tag set written to every audiobook file. Keeping album=book and
// albumartist=author is what makes a book show up as one item in the players.
function audiobookTags({ author, book, part, track, date, year, genres }) {
  return {
    title: part,
    artist: [author],
    albumartist: author,
    album: book,
    tracknumber: track ? String(track) : null,
    // Implausible dates are dropped entirely, not written half-wrong.
    date: year ? date : null,
    genre: genres,
    releasetype: 'audiobook',
    // Clear the video-site leftovers (description, watch links) that yt-dlp's
    // --embed-metadata writes.
    synopsis: '',
    description: '',
    comment: '',
    purl: '',
  };
}

// Author/book/part/date/genres for a job, from the UI fields with the site
// metadata filling the gaps. A one-file story ends up with part == book.
function audiobookMeta(meta, params) {
  const m = meta.music || {};
  const author = (params.artists ? splitList(params.artists)[0] : null) || m.artist || meta.creator || 'Unknown Author';
  const book = (params.album || meta.title || 'Unknown Book').trim();
  const part = (params.titleOverride || meta.title || book).trim();
  const date = params.date || (m.year ? String(m.year) : null);
  // Only a plausible year is written into the tag — sites hand out nonsense
  // release years often enough.
  const yearNum = Number(String(date || '').slice(0, 4));
  const year = yearNum >= 1900 && yearNum <= new Date().getFullYear() + 1 ? String(yearNum) : null;
  // No genre lookup here (the music databases know nothing about audiobooks);
  // an unset genre just gets the obvious default.
  const genres = params.genres ? splitGenres(params.genres) : m.genre ? [m.genre] : ['Audiobook'];
  return { author, book, part, date, year, genres };
}

// Rewrite the tags of an audio file in place via mutagen (yt-dlp's tag
// library, present in the image). Values: string, list (multi-value tag —
// several artists/genres, which Navidrome reads natively), '' / [] (clears
// the field) or null (leaves it alone). Mutagen edits tags without remuxing,
// so embedded cover art survives — ffmpeg's ogg muxer would drop it.
const TAG_SCRIPT = [
  'import sys, json',
  'from mutagen import File',
  'f = File(sys.argv[1], easy=True)',
  "if f is None: sys.exit('unsupported audio file')",
  'for k, v in json.loads(sys.argv[2]).items():',
  '    if v is None: continue',
  '    try:',
  "        if v == '' or v == []:",
  '            if k in f: del f[k]',
  '        else:',
  '            f[k] = v',
  '    except Exception:',
  '        pass',
  'f.save()',
].join('\n');
// A missing interpreter or a missing mutagen is a setup problem, and python's
// own wording for it ("No module named 'mutagen'", ENOENT) does not say which
// knob fixes it. Name the dependency and the variable instead; anything else is
// a real tagging failure and passes through as it is.
function tagDependencyError(text) {
  if (/No module named ['"]?mutagen/i.test(text)) {
    return `mutagen is not installed for ${PYTHON} — install it with \`pip install mutagen\` (or set PYTHON_BIN to an interpreter that has it)`;
  }
  return null;
}

function tagAudio(src, tags) {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, ['-c', TAG_SCRIPT, src, JSON.stringify(tags)]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) =>
      reject(
        new Error(
          e.code === 'ENOENT'
            ? `python3 not found (tried "${PYTHON}") — it and mutagen are required for audio tagging; set PYTHON_BIN to its path`
            : String(e.message || e)
        )
      )
    );
    p.on('close', (code) => {
      if (code === 0) return resolve();
      const last = err.trim().split('\n').pop() || '';
      reject(new Error(tagDependencyError(err) || last || 'tagging failed'));
    });
  });
}

// Build the caption shown in elite-v2: original text + hashtags + source link.
function buildCaption(job) {
  const parts = [];
  const desc = cleanDescription(job.description);
  if (desc) parts.push(desc);
  const hasTags = /#[\p{L}\p{N}_]/u.test(desc);
  if (Array.isArray(job.tags) && job.tags.length && !hasTags) {
    parts.push(job.tags.map((t) => (t.startsWith('#') ? t : '#' + t)).join(' '));
  }
  parts.push('Source: ' + (job.sourceUrl || ''));
  return parts.filter(Boolean).join('\n\n');
}

// How each channel's importer wants a dropped clip named. `legacy` is
// `<creator>_-_<title>.mp4` plus a `.md` caption (elite-v2's grammar, still read
// by tikshortis). `brackets` is `<title> [@<creator>] [id=<media id>].mp4` plus
// a yt-dlp style `.json` sidecar, for importers that file by a bracket group.
const DROP_FORMATS = {
  main: process.env.DROP_FORMAT_MAIN === 'brackets' ? 'brackets' : 'legacy',
  '18plus': process.env.DROP_FORMAT_18PLUS === 'brackets' ? 'brackets' : 'legacy',
};

// The clip's file name and its sidecar for a save into this channel's _import.
function dropFiles(channel, job, web) {
  const legacyStem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  if ((CHANNELS[channel] || 'main') === 'platform') {
    // Always `.mp4`: the importer makes its own web copy.
    const outName = `${legacyStem}.mp4`;
    return {
      outName,
      sidecarName: `${legacyStem}.json`,
      sidecar: JSON.stringify(platformDrop.platformSidecar(job, outName, cleanDescription), null, 2),
    };
  }
  if (DROP_FORMATS[CHANNELS[channel] || 'main'] !== 'brackets') {
    return {
      outName: `${legacyStem}${web ? '.web.mp4' : '.mp4'}`,
      sidecarName: `${legacyStem}.md`,
      sidecar: buildCaption(job),
    };
  }
  const id = String(job.mediaId || '').replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 64);
  const base = `${safeTitle(job.title)} [@${safeCreator(job.creator)}]${id ? ` [id=${id}]` : ''}`;
  const tags = (Array.isArray(job.tags) ? job.tags : []).map((t) => String(t).replace(/^#+/, '')).filter(Boolean);
  return {
    outName: `${base}.mp4`,
    sidecarName: `${base}.json`,
    sidecar: JSON.stringify({
      id: id || undefined,
      title: job.title || undefined,
      description: cleanDescription(job.description) || undefined,
      tags,
      uploader: job.creator || undefined,
      webpage_url: job.sourceUrl || undefined,
    }, null, 2),
  };
}

// Publishes a finished drop: the clip at buildPath goes to finalPath and the
// sidecar beside it, in the order the channel's importer needs. The legacy
// importers read the caption when the clip appears, so theirs goes first; the
// platform importer treats the sidecar as the "complete" signal, so it goes last.
// The audience gate runs again here, as the last step before anything lands
// in the app's folder, so no caller can skip it.
function commitDrop(channel, job, destDir, buildPath, finalPath, sidecarName, sidecar) {
  const destination = destinationOf(channel, { ...job, mediaType: 'video' });
  assertDeliverable(destination, job);
  if ((CHANNELS[channel] || 'main') === 'platform') {
    platformDrop.commitPlatformDrop(destDir, buildPath, finalPath, sidecarName, sidecar);
  } else {
    fs.writeFileSync(path.join(destDir, sidecarName), sidecar);
    fs.renameSync(buildPath, finalPath);
  }
  recordDrop(destination, job, path.basename(finalPath), finalPath);
}

// GET /api/resolve?url=... -> metadata preview.
app.get('/api/resolve', async (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  try {
    const job = await extractors.resolve(url);
    const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
    const isImage = job.mediaType === 'image';
    // A resolve preview is shown to the view that asked for it (H34), unless
    // the item is classified 18+ (B1); the preview key still shows it here.
    const thumbToken = notePreviewThumb(req, job, url);
    res.json({
      ok: true,
      extractor: job.extractor,
      creator: job.creator || null,
      title: job.title || null,
      tags: job.tags || [],
      thumbnail: job.thumbnail || null,
      thumbToken,
      duration: durationKnown(job) ? Number(job.duration) : null,
      mediaType: isImage ? 'image' : 'video',
      // A lighter copy of the video the card can play in place as a moving
      // preview. Only sites that offer one set it; everywhere else the card
      // stays a still picture.
      preview: job.preview || null,
      // The full description often carries the real song title/artist for
      // reposted music — shown collapsed under the result card.
      description: job.description || null,
      // Site-provided music metadata (artist/track/album/year), when available;
      // pre-fills the Navidrome tag fields in the UI.
      music: job.music || null,
      // The site's metadata could not be read (a broken extractor, or content
      // that needs a login). The download may still work, so this is a warning
      // on the card rather than an error — without it the result just reads
      // "unknown" with no explanation.
      probeError: job.probeError || null,
      // True when the failure also blocks the download (same extraction), so
      // the UI can warn instead of suggesting it might work anyway.
      probeFatal: !!job.probeFatal,
      // Already saved once (any destination) per the downloaded registry.
      downloaded: isDownloaded(job.sourceUrl || url, job.site, job.mediaId),
      // The same song already in a Navidrome library, even when it was grabbed
      // from a different upload (null when it isn't).
      inLibrary: libraryMatch(musicIdentity(job)),
      // Too long to belong in the shorts library (UI forces the server library).
      tooLongForShorts: !isImage && tooLongForShorts(job),
      filename: isImage ? `${stem}.${safeExt(job.ext, 'jpg')}` : `${stem}.mp4`,
      kind: job.kind,
      // Whether this clip is already in the library serving each channel (for a
      // UI warning).
      imported: {
        main: isImage ? imageStatus(job.creator, stem) : importedStatus('main', job.creator, stem),
        '18plus': isImage ? null : importedStatus('18plus', job.creator, stem),
      },
      // First matching rule (if any): pre-fills the sheet; auto rules start
      // share-target entries without the sheet.
      rule: publicRule(matchRule({
        url,
        extractor: job.extractor,
        creator: job.creator,
        title: job.title,
        mediaType: isImage ? 'image' : 'video',
        duration: durationKnown(job) ? Number(job.duration) : null,
      })),
    });
  } catch (e) {
    // 422 (not 5xx) so Cloudflare passes the JSON body through unchanged.
    res.status(422).json({ ok: false, error: String(e.message || e) });
  }
});

// GET /api/sites -> supported sites (for the UI list).
app.get('/api/sites', (_req, res) => {
  const sites = extractors.siteExtractors
    .map((e) => ({ name: e.name, domain: e.domain || e.name, profiles: e.profiles || false }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
  // ytdlpCount is filled once at boot (see countYtdlpExtractors); 0 until ready.
  res.json({ ok: true, sites, ytdlp: ytdlpCount });
});

// GET /api/folders -> server-library subfolders (for the folder picker).
// ---------------------------------------------------------------------------
// Thumbnail proxy.
//
// Site thumbnails are served from hotlink-protected CDNs. redgifs' CDN77
// answers 403 to any request whose Referer is not redgifs' own — which is
// exactly what a browser sends for an <img> served by grabbit — so every
// redgifs card rendered as a grey box although the URL itself was fine.
// Fetching the picture here lets grabbit send the Referer the CDN wants, and
// the browser only ever loads a same-origin image.
//
// Cached on disk under the URL's hash: a profile listing is hundreds of
// pictures, and re-opening it must not re-fetch every one of them. The endpoint
// sits behind the same auth middleware as the rest of /api, which an <img> tag
// satisfies on its own — the session is a cookie, and a same-origin image
// request carries it (an Authorization header would not have been sent).
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
// Content types worth caching as a thumbnail, and the extension each is stored
// under. Anything else is refused rather than guessed at.
const THUMB_TYPES = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const THUMB_EXTS = [...new Set(Object.values(THUMB_TYPES))];
const THUMB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const THUMB_MAX_BYTES = 10 * 1024 * 1024;
// Roughly a few hundred MB of pictures at the sizes sites serve. Trimmed back
// to 80% when exceeded, oldest first.
const THUMB_MAX_FILES = 5000;
let thumbStores = 0;

try {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
} catch {
  /* best effort; the endpoint reports the failure per request */
}

function thumbKey(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex');
}

// The cached file for a URL, or null. The extension is part of the name (it
// carries the content type), so the few candidates are probed directly rather
// than listing the directory on every request.
// A picture fetched from its site URL is cached as `u-<key>`. The prefix keeps
// it apart from the plain `<key>` files of the cache before the provenance
// index, so a file the upgrade could not set aside is never served (Codex
// phase-0 B3).
const urlCacheName = (key) => `u-${key}`;
function cachedUrlThumb(key) {
  return cachedThumb(urlCacheName(key));
}
function cachedThumb(key) {
  for (const ext of THUMB_EXTS) {
    const file = path.join(THUMB_DIR, `${key}.${ext}`);
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
}

// The Referer a hotlink check expects: the site the picture belongs to, not the
// CDN subdomain serving it (media.redgifs.com -> https://www.redgifs.com/).
function thumbReferer(url) {
  try {
    const host = new URL(url).hostname.split('.').slice(-2).join('.');
    return host ? `https://www.${host}/` : null;
  } catch {
    return null;
  }
}

// Keep the cache from growing without bound. Runs on boot and every 200 stores
// — a directory listing per picture would cost more than the pictures do.
// A picture that neither the site nor a local file could give is not asked for
// again for this long, so a page of dead links does not hit the sites on every view.
const THUMB_MISS_MS = 6 * 3600 * 1000;
const THUMB_MISS_MAX = 5000;
const thumbMisses = new Map();

// --- Thumbnail provenance index (H34, H42, H47, H57, H69, H83, H94) ---------
// /api/thumb serves or fetches a picture only for a key thumb-index.json
// knows, and only to a view the key's strictest provenance allows (see
// thumb-index.js). Grabbit records a provenance wherever it learns or hands out
// a picture: a history row, a registry row, a library item, a job, a resolve.
const THUMB_INDEX_FILE = path.join(DATA_DIR, 'thumb-index.json');
// Classification inputs of a history row, a job or a library item.
function thumbIn(e, channel) {
  return thumbIndexLib.cleanIn({
    creator: e.creator, sourceCreator: e.sourceCreator, site: e.site, extractor: e.extractor,
    sourceUrl: e.sourceUrl || e.url, channel: channel === undefined ? e.channel : channel, filename: e.filename,
    itemKey: e.itemKey, audience: e.audience === 'adult' ? 'adult' : undefined,
  });
}
// readProfiles() counts the whole registry to sync it, too much for every
// picture on a page: a full read at most every few seconds, the cached store
// in between (a store that cannot be read gives null, so nothing is general).
let thumbStoreReadAt = 0;
function thumbProfileStore() {
  if (Date.now() - thumbStoreReadAt > 5000) {
    thumbStoreReadAt = Date.now();
    return readProfileStoreQuietly();
  }
  try {
    return readProfilesReadOnly().store;
  } catch {
    return null;
  }
}
// What "still referenced" means during one prune: a history row, a registry
// key, an item or a live job. Built once per prune, never per key.
let thumbRefCtx = null;
const THUMBS = new thumbIndexLib.ThumbIndex({
  classify: (input) => entryClassification(input, thumbProfileStore()).audience,
  referenced: (ref) => {
    const c = thumbRefCtx;
    if (!c) return true;
    const kind = ref.slice(0, 2);
    const rest = ref.slice(2);
    if (kind === 'h:') return c.history.has(rest);
    if (kind === 'r:') return Object.hasOwn(c.registry, rest);
    if (kind === 'i:') return !!(ITEM_STORE && ITEM_STORE.get(rest));
    if (kind === 'j:') return jobsMap.has(rest);
    return false;
  },
});
// An index file that exists but cannot be read, or that parses to nothing
// usable, is damage (Codex phase-0 B3): /api/thumb then serves nothing, the
// file is never written over and the upgrade does not run, until the owner
// restores it (or moves it aside for a fresh start) and restarts. A missing
// file is a fresh install.
let thumbIndexBroken = null;
{
  let exists = false;
  try {
    fs.statSync(THUMB_INDEX_FILE);
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') thumbIndexBroken = e.message;
  }
  if (exists) {
    try {
      fs.readFileSync(THUMB_INDEX_FILE);
      const raw = readJsonState(THUMB_INDEX_FILE, null);
      if (!raw || !THUMBS.load(raw)) thumbIndexBroken = 'it did not parse to a usable index and no snapshot restored it';
    } catch (e) {
      thumbIndexBroken = e.message;
    }
  }
  if (thumbIndexBroken) {
    console.error(`thumbs: thumb-index.json could not be read (${thumbIndexBroken}). Thumbnails are held back until it is restored ` +
      'from a snapshot (or moved aside for a fresh start) and Grabbit is restarted.');
  }
}
let thumbIndexTimer = null;
function saveThumbIndex(now = false) {
  if (!THUMBS.dirty || thumbIndexBroken) return;
  const write = () => {
    thumbIndexTimer = null;
    try {
      writeJsonAtomic(THUMB_INDEX_FILE, THUMBS.toJSON());
      THUMBS.dirty = false;
    } catch (e) {
      console.warn('thumbs: thumb-index.json write failed:', e.message);
    }
  };
  if (now) {
    clearTimeout(thumbIndexTimer);
    return write();
  }
  if (!thumbIndexTimer) {
    thumbIndexTimer = setTimeout(write, 1000);
    if (thumbIndexTimer.unref) thumbIndexTimer.unref();
  }
}
process.on('exit', () => saveThumbIndex(true));
// The index key of a picture address: a site URL or Grabbit's own frame id.
function thumbKeyOf(thumbnail) {
  const s = String(thumbnail || '');
  if (/^https?:\/\//i.test(s)) return validUrl(s) ? thumbKey(s) : null;
  const m = /^\/api\/thumb\?id=(f-[0-9a-f]{40})$/.exec(s);
  return m ? m[1] : null;
}
function noteThumb(thumbnail, prov) {
  const key = thumbKeyOf(thumbnail);
  if (!key) return null;
  if (key.startsWith('f-') && prov.kind === 'entry') prov = { ...prov, kind: 'local' };
  THUMBS.add(key, prov);
  saveThumbIndex();
  return key;
}
function noteHistoryThumb(e) {
  if (e && e.thumbnail && e.id) noteThumb(e.thumbnail, { kind: 'entry', ref: `h:${e.id}`, in: thumbIn(e) });
}
// The audience a key is served to: its strictest provenance, or null when no
// provenance was ever recorded.
function thumbPasses(key, adultView) {
  if (thumbIndexBroken) return { ok: false, aud: null };
  const aud = THUMBS.audienceOf(key);
  if (aud === null) return { ok: false, aud: null };
  return { ok: passesAudience(aud, adultView), aud };
}
// Codex phase-0 B1: a resolve on a general view records its picture as a
// "soft" preview with the item's own classification inputs, so a link to an
// item classified 18+ never makes its picture general. The view that resolved
// the link gets a preview key (`thumbToken`, `pt=` on /api/thumb) that opens
// that one picture for it alone, never stored by the browser. The secret lives
// as long as the process: a restart ends every preview key.
const PREVIEW_SECRET = crypto.randomBytes(32);
function previewToken(key) {
  return crypto.createHmac('sha256', PREVIEW_SECRET).update(`thumb-preview\0${key}`).digest('hex').slice(0, 32);
}
function previewTokenOk(key, token) {
  const t = String(token || '');
  if (!/^[0-9a-f]{32}$/.test(t)) return false;
  const want = Buffer.from(previewToken(key));
  return crypto.timingSafeEqual(want, Buffer.from(t)) && THUMBS.provsOf(key).some((p) => p.kind === 'preview');
}
// Records a resolve result's picture for the view that asked, and returns the
// preview key the response carries (null without a picture).
function notePreviewThumb(req, item, url) {
  const key = noteThumb(item.thumbnail, {
    kind: 'preview',
    aud: wantsAdultView(req) ? 'adult' : 'general',
    in: thumbIn({ ...item, sourceUrl: item.sourceUrl || url }, null),
    soft: true,
  });
  return key && !key.startsWith('f-') ? previewToken(key) : null;
}

// Files in THUMB_DIR: `<key>.<ext>` is a picture fetched from its site URL;
// `keep-<refTag>-<key>.<ext>` one made again from an entry's own file when the
// site link died (H47); `f-<40 hex>.<ext>` a frame Grabbit took for one entry.
// Anything else at the top level predates the index and was moved to a
// quarantine folder by the upgrade. A file whose key the index dropped goes.
// Atomic write of one picture into THUMB_DIR as <name>.<ext>, via a per-call
// temp name: two cards can ask for the same picture at once.
function writeThumbFile(name, buf, ext) {
  const file = path.join(THUMB_DIR, `${name}.${ext}`);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    return { file, ext };
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw e;
  }
}
// u-<key>, keep-<tag>-<key> or f-<id>; a bare <key> is from before the index.
const THUMB_FILE_RE = /^(?:u-([0-9a-f]{40})|keep-([0-9a-f]{16})-([0-9a-f]{40})|(f-[0-9a-f]{40}))\.([a-z0-9]+)$/;
function keptFileFor(key, ref) {
  return cachedThumb(`keep-${thumbIndexLib.refTag(ref)}-${key}`);
}
function pruneThumbs() {
  // An index that could not be read knows no key: pruning would delete every picture.
  if (thumbIndexBroken) return;
  thumbRefCtx = { history: new Set(readHistory().map((e) => e.id)), registry: readDownloaded() };
  try {
    THUMBS.prune();
    saveThumbIndex();
    let all;
    try {
      all = fs.readdirSync(THUMB_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    const plain = [];
    for (const d of all) {
      if (!d.isFile() || d.name.endsWith('.part')) continue;
      const m = THUMB_FILE_RE.exec(d.name);
      if (!m) continue; // left for the owner; never served
      const tag = m[2] || null;
      const key = m[1] || m[3] || m[4];
      let drop = !THUMBS.has(key);
      if (!drop && tag) drop = !THUMBS.refsOf(key).some((ref) => thumbIndexLib.refTag(ref) === tag);
      if (drop) {
        try {
          fs.unlinkSync(path.join(THUMB_DIR, d.name));
        } catch {
          /* already gone */
        }
      } else if (!tag && !key.startsWith('f-') && !THUMBS.isReferenced(key)) plain.push(d.name);
    }
    // Pictures only previews point at are plain cache, capped oldest first.
    if (plain.length <= THUMB_MAX_FILES) return;
    const files = [];
    for (const name of plain) {
      try {
        files.push({ name, at: fs.statSync(path.join(THUMB_DIR, name)).mtimeMs });
      } catch {
        /* vanished between the listing and the stat */
      }
    }
    files.sort((a, b) => a.at - b.at);
    for (const f of files.slice(0, files.length - Math.floor(THUMB_MAX_FILES * 0.8))) {
      try {
        fs.unlinkSync(path.join(THUMB_DIR, f.name));
      } catch {
        /* already gone */
      }
    }
  } finally {
    thumbRefCtx = null;
  }
}

// Fetch one picture, sending the Referer its CDN expects. A CDN that instead
// refuses every foreign Referer (rather than requiring its own) answers 403, so
// the second attempt sends none at all — between them the two cover both kinds
// of hotlink check.
async function fetchThumb(url) {
  const referer = thumbReferer(url);
  for (const headers of referer ? [{ Referer: referer }, {}] : [{}]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await safeFetch(url, {
        headers: { 'User-Agent': THUMB_UA, Accept: 'image/*,*/*;q=0.8', ...headers },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 403 && referer && Object.keys(headers).length) {
      if (res.body) res.body.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) {
      if (res.body) res.body.cancel().catch(() => {});
      const err = new Error(`upstream HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = THUMB_TYPES[type];
    if (!ext) {
      if (res.body) res.body.cancel().catch(() => {});
      // A login wall or an error page arrives as a 200 full of HTML; storing it
      // would cache the failure under the picture's name.
      const err = new Error(`not an image (${type || 'no content-type'})`);
      err.status = 415;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > THUMB_MAX_BYTES) {
      const err = new Error('image too large or empty');
      err.status = 502;
      throw err;
    }
    return { buf, ext };
  }
  const err = new Error('upstream HTTP 403');
  err.status = 403;
  throw err;
}

// Fetch a site thumbnail into the cache while its link still works. CDN links
// are signed and expire within hours, so a picture nobody looked at on the day
// of the download could never be shown later. Best effort, in the background,
// and only for a key the index knows (the caller records it first).
const thumbsWarming = new Set();
function warmThumb(url) {
  if (!url || !/^https?:\/\//i.test(String(url)) || !validUrl(url)) return;
  const key = thumbKey(url);
  if (!THUMBS.has(key) || thumbsWarming.has(key) || cachedUrlThumb(key)) return;
  thumbsWarming.add(key);
  fetchThumb(url)
    .then(({ buf, ext }) => {
      writeThumbFile(urlCacheName(key), buf, ext);
    })
    .catch(() => {
      /* the picture is gone or refused: the hub shows a placeholder */
    })
    .finally(() => thumbsWarming.delete(key));
}

// Store a frame Grabbit took for one entry. Its id names the entry and the
// bytes (H47, H69), so a byte-identical frame of another entry is another
// file; the index records the entry the frame belongs to.
function storeFrame(ref, input, buf, ext) {
  const id = thumbIndexLib.frameId(ref, buf);
  const file = path.join(THUMB_DIR, `${id}.${THUMB_EXTS.includes(ext) ? ext : 'jpg'}`);
  try {
    if (!fs.existsSync(file)) writeThumbFile(id, buf, THUMB_EXTS.includes(ext) ? ext : 'jpg');
  } catch (e) {
    console.warn('thumb cache write failed:', e.message);
    return null;
  }
  THUMBS.add(id, { kind: 'local', ref, in: input });
  saveThumbIndex();
  return id;
}

// GET /api/thumb?url=...|id=f-...[&audience=adult][&v=2] -> the picture.
// Only an indexed key is served or fetched, and only to a view its strictest
// provenance allows; anything else is 404 (no outbound request). A general
// picture is revalidated on every use (ETag), so a key that turns 18+ stops
// at once; an 18+ picture is never stored by the browser (H42, H60).
app.get('/api/thumb', async (req, res) => {
  const adultView = wantsAdultView(req);
  const none = (why = 'No such thumbnail') => res.status(404).json({ ok: false, error: why });
  const headersFor = (aud) => ({ 'Cache-Control': aud === 'general' ? 'private, no-cache' : 'private, no-store' });
  const send = (file, ext, aud) => {
    res.type(imageMime(ext));
    res.sendFile(file, { cacheControl: false, headers: headersFor(aud) }, (err) => {
      if (err && !res.headersSent) none();
    });
  };
  const id = String(req.query.id || '');
  if (id) {
    // A legacy `local-` frame has no provenance anyone can prove (H83).
    if (thumbIndexLib.LEGACY_LOCAL_RE.test(id)) return none();
    if (!thumbIndexLib.FRAME_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const gate = thumbPasses(id, adultView);
    if (!gate.ok) return none();
    const local = cachedThumb(id);
    if (!local) return none();
    return send(local.file, local.ext, gate.aud);
  }
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const key = thumbKey(url);
  let gate = thumbPasses(key, adultView);
  // The view that resolved the link may see its own preview (B1); anything
  // but a general key then goes out as `no-store`.
  const byPreview = !gate.ok && gate.aud !== null && req.query.pt !== undefined && previewTokenOk(key, req.query.pt);
  if (byPreview) gate = { ok: true, aud: gate.aud };
  if (!gate.ok) return none();
  const refs = THUMBS.refsOf(key);
  const hit = cachedUrlThumb(key) || refs.map((ref) => keptFileFor(key, ref)).find(Boolean);
  if (hit) return send(hit.file, hit.ext, gate.aud);
  const missAt = thumbMisses.get(key);
  if (missAt && Date.now() - missAt < THUMB_MISS_MS) return none('No picture (tried recently)');
  let got = null;
  let failure = null;
  let madeFor = null;
  try {
    got = await fetchThumb(url);
  } catch (e) {
    failure = e;
    // The site's link has expired or the picture is gone: make it again from
    // the downloaded file of an entry this key belongs to (H42: only an entry
    // the gate above already passed, never "the first row with this URL").
    for (const ref of refs) {
      got = await thumbFromEntry(ref).catch(() => null);
      if (got) {
        madeFor = ref;
        break;
      }
    }
  }
  if (!got) {
    if (thumbMisses.size >= THUMB_MISS_MAX) thumbMisses.delete(thumbMisses.keys().next().value);
    thumbMisses.set(key, Date.now());
    return res.status(failure && failure.status === 404 ? 404 : 502).json({
      ok: false,
      error: String((failure && failure.message) || failure || 'No picture'),
    });
  }
  // The index may have changed while the picture was fetched.
  let again = thumbPasses(key, adultView);
  if (!again.ok && byPreview && again.aud !== null) again = { ok: true, aud: again.aud };
  if (!again.ok) return none();
  const name = madeFor ? `keep-${thumbIndexLib.refTag(madeFor)}-${key}` : urlCacheName(key);
  try {
    const saved = writeThumbFile(name, got.buf, got.ext);
    if (++thumbStores % 200 === 0) pruneThumbs();
    send(saved.file, saved.ext, again.aud);
  } catch (e) {
    // An unwritable cache must not cost the user the picture.
    console.warn('thumb cache write failed:', e.message);
    res.set(headersFor(again.aud));
    res.type(imageMime(got.ext)).send(got.buf);
  }
});

// GET /api/media?url=... -> the video, streamed.
//
// The clip a card plays as a preview sits on the same hotlink-protected CDN as
// its poster, so the browser cannot fetch it directly (see /api/thumb). This
// forwards the request with the Referer the CDN expects — Range included, which
// is what lets a <video> start playing before the whole file has arrived — and
// streams the answer straight back. Nothing is cached on disk: a preview is
// megabytes, and the browser's own media cache already covers a replay.
// A history entry's picture made from its downloaded file: the poster beside a
// video, the image itself, or a frame from the video. At most two ffmpeg runs
// at a time, so a page full of expired links cannot pile them up on the Pi.
const LOCAL_THUMB_CONCURRENCY = 2;
let localThumbRunning = 0;
const localThumbWaiting = [];
async function withLocalThumbSlot(fn) {
  if (localThumbRunning >= LOCAL_THUMB_CONCURRENCY) await new Promise((r) => localThumbWaiting.push(r));
  localThumbRunning++;
  try {
    return await fn();
  } finally {
    localThumbRunning--;
    const next = localThumbWaiting.shift();
    if (next) next();
  }
}

// A picture made again from one history entry's own library file: the poster
// beside a video, the image itself, or a frame from the video. The folders
// come from the entry's channel and must lie inside a media root. Only a row
// still in the history can be traced to its file; anything else keeps the
// placeholder (H96).
async function thumbFromEntry(ref) {
  if (!String(ref).startsWith('h:')) return null;
  const id = String(ref).slice(2);
  const entry = readHistory().find((e) => e && e.id === id && e.filename);
  if (!entry || !mediaViewer.isPlainName(entry.filename)) return null;
  const found = mediaViewer.findVariants(entry.filename, mediaDirsOf(entry), MEDIA_ROOTS);
  if (!found) return null;
  if (found.poster) {
    const ext = mediaViewer.extOf(found.poster) === 'jpeg' ? 'jpg' : mediaViewer.extOf(found.poster);
    if (THUMB_EXTS.includes(ext)) {
      const buf = fs.readFileSync(found.poster);
      if (buf.length && buf.length <= THUMB_MAX_BYTES) return { buf, ext };
    }
  }
  const src = found.original || found.web;
  const kind = src ? mediaViewer.kindOfName(src) : null;
  if (kind !== 'video' && kind !== 'image') return null;
  const buf = await withLocalThumbSlot(() => (kind === 'video' ? frameFromVideo(src, entry.duration) : frameFromImage(src)));
  return buf ? { buf, ext: 'jpg' } : null;
}

// Points one history row at a new picture, if it still shows the old one.
function setHistoryThumb(id, from, to) {
  const list = readHistory();
  const row = list.find((e) => e.id === id);
  if (!row || row.thumbnail !== from) return false;
  row.thumbnail = to;
  writeJsonAtomic(HISTORY_FILE, list);
  return true;
}

// At boot, after start-up: the index learns every history row's picture. The
// first boot with the index (the H4 release) also moves every picture file
// from before it into thumbs/quarantine-<stamp>/ (kept, never served: the
// URL cache is refetchable, `keep-` and `local-` copies have no provable
// owner, H47, H83), and makes each history row's legacy `local-` frame again
// from that row's own library file under a per-entry id (H83, H94). A row
// whose file is gone keeps the placeholder.
const LEGACY_LOCAL_THUMB_RE = /^\/api\/thumb\?id=(local-[0-9a-f]{40})$/;
async function upgradeThumbs() {
  if (thumbIndexBroken) return;
  const history = readHistory();
  let quarantined = 0;
  let mixed = 0;
  const firstRun = !THUMBS.migratedAt;
  if (firstRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const qdir = path.join(THUMB_DIR, `quarantine-${stamp}`);
    let names = [];
    try {
      names = fs.readdirSync(THUMB_DIR, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    } catch {
      /* no cache yet */
    }
    for (const name of names) {
      if (name.endsWith('.part')) continue;
      try {
        fs.mkdirSync(qdir, { recursive: true });
        fs.renameSync(path.join(THUMB_DIR, name), path.join(qdir, name));
        quarantined++;
      } catch (e) {
        console.warn(`thumbs: could not set aside ${name}: ${e.message}`);
      }
    }
    // H69: legacy frames that entries of different audiences pointed at.
    const byId = new Map();
    // Read only: start-up never writes profiles.json.
    let store = null;
    try {
      ({ store } = readProfilesReadOnly());
    } catch {
      store = null;
    }
    for (const e of history) {
      const m = LEGACY_LOCAL_THUMB_RE.exec(String(e.thumbnail || ''));
      if (!m) continue;
      if (!byId.has(m[1])) byId.set(m[1], new Set());
      byId.get(m[1]).add(entryClassification(e, store).audience === 'general' ? 'general' : 'adult');
    }
    mixed = [...byId.values()].filter((set) => set.size > 1).length;
  }
  for (const e of history) noteHistoryThumb(e);
  THUMBS.migratedAt = THUMBS.migratedAt || Date.now();
  THUMBS.dirty = true;
  saveThumbIndex(true);
  if (firstRun) {
    console.log(`thumbs: upgrade to the provenance index: ${quarantined} earlier picture files set aside in quarantine, ` +
      `${mixed} legacy frame ids were shared by general and 18+ or unclassified entries`);
  }
  // Legacy frames still named by history rows, every boot until they are made again.
  const legacy = history.filter((e) => LEGACY_LOCAL_THUMB_RE.test(String(e.thumbnail || '')));
  let made = 0;
  let placeholder = 0;
  for (const e of legacy) {
    const got = await thumbFromEntry(`h:${e.id}`).catch(() => null);
    const id = got ? storeFrame(`h:${e.id}`, thumbIn(e), got.buf, got.ext) : null;
    if (id && setHistoryThumb(e.id, e.thumbnail, `/api/thumb?id=${id}`)) {
      noteHistoryThumb({ ...e, thumbnail: `/api/thumb?id=${id}` });
      made++;
    } else placeholder++;
  }
  if (legacy.length) console.log(`thumbs: ${made} legacy frames made again from their entries' files, ${placeholder} entries keep the placeholder`);
  pruneThumbs();
}
// After start-up: classification needs the item store, the profiles and the
// job list, which are set up further down this file.
setImmediate(() => {
  upgradeThumbs().catch((e) => console.warn('thumbs: the index upgrade failed:', e.message));
});

app.get('/api/media', async (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const headers = { 'User-Agent': THUMB_UA };
  const referer = thumbReferer(url);
  if (referer) headers.Referer = referer;
  if (req.headers.range) headers.Range = req.headers.range;
  let upstream;
  try {
    upstream = await safeFetch(url, { headers });
    if (!upstream.ok || !upstream.body) {
      if (upstream.body) upstream.body.cancel().catch(() => {});
      return res.status(upstream.status === 404 ? 404 : 502).end();
    }
    const type = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // Media only. An error page or a login wall arrives as 200 HTML, which must
    // not reach a <video> — and it keeps this from being a general-purpose
    // proxy for anything the CDN happens to serve.
    if (!/^(video|audio)\//.test(type)) {
      upstream.body.cancel().catch(() => {});
      return res.status(415).end();
    }
    // 206 and its Content-Range have to survive intact, or seeking breaks.
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // Never stored by the browser: this route does not know the clip's
    // audience, and a general view must not find an 18+ preview in its cache
    // (Codex phase-0 B1). The browser's in-page media buffer still serves seeks.
    res.setHeader('Cache-Control', 'private, no-store');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    // Stopping a preview aborts the response mid-stream, which lands here as a
    // premature-close error; there is nothing to report about it.
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
});

// GET /api/config -> which destinations this deploy can actually write to, so
// the UI does not offer a library that is not mounted. Read once at boot.
app.get('/api/config', (_req, res) =>
  res.json({
    ok: true,
    shorts: SHORTS_ENABLED,
    posts: POSTS_ENABLED,
    elite: ELITE_ENABLED,
    channels: Object.keys(CHANNELS).filter((ch) => !!CHANNEL_ROOTS[ch]),
    // The app behind each configured channel and its audience, so a UI can keep
    // the 18+ app apart from the general ones instead of guessing from a name.
    apps: Object.keys(CHANNELS)
      .filter((ch) => !!CHANNEL_ROOTS[ch])
      .map((ch) => ({ channel: ch, app: CHANNEL_LIBRARY[ch], audience: ch === '18plus' ? 'adult' : 'general' })),
    adultBlocked: ADULT_BLOCKED,
    // The old Adshortis folder page: mounted only with ADSHORTIS_FOLDER_PAGE=1,
    // outside native mode (H1, H19).
    adshortisLibrary: ADS_FOLDER_PAGE,
    adflixLibrary: !!ADFLIX_LIBRARY,
    // Grabbit 2.2: the TikShortis app shown in a hub frame. Null = off, and
    // null whenever TIKSHORTIS_MODE picked another mode.
    tikshortisEmbed: TIKSHORTIS_MODE === 'embed' ? TIKSHORTIS_EMBED : null,
    // Grabbit 3.0: native | embed | off (see modules.js), and the module list
    // the hub draws its navigation from.
    tikshortisMode: TIKSHORTIS_MODE,
    // Grabbit 3.0 native Adshortis: the effective mode, and the standalone app's
    // address for the plain link (never an iframe), null when there is none.
    adshortisMode: ADSHORTIS_MODE,
    adshortisEmbed: ADSHORTIS_MODE !== 'off' && ADSHORTIS_EMBED ? `${ADSHORTIS_EMBED}/` : null,
    // The release this server runs (40 hex) or null; null turns the hub's
    // build check off.
    build: BUILD_SHA,
    modules: modules.modulesFor({ tikMode: TIKSHORTIS_MODE, egramMode: EGRAM_MODE, adsMode: ADSHORTIS_MODE }),
  })
);

// TIKSHORTIS_EMBED_URL: see tikshortis-embed.js. Off unless it is a plain
// https origin; TikShortis must list this hub in its EMBED_FRAME_ANCESTORS.
const TIKSHORTIS_EMBED = tikshortisEmbed.parseEmbedUrl(process.env.TIKSHORTIS_EMBED_URL);
if (process.env.TIKSHORTIS_EMBED_URL && !TIKSHORTIS_EMBED) {
  console.warn('[grabbit] TIKSHORTIS_EMBED_URL is not a plain https origin; the TikShortis hub page is off.');
}

// --- Grabbit 3.0: native TikShortis (tikshortis-gateway.js) ----------------------
// TIKSHORTIS_MODE=native draws TikShortis in the hub itself and reaches its API
// through /api/tik/*, a gateway to TIKSHORTIS_API_URL (TikShortis' LAN port).
// TikShortis keeps its database, accounts and media. Unset mode keeps 2.2's
// behaviour; a mode whose setting is missing falls back (native -> embed -> off).
const TIKSHORTIS_API = tikGateway.parseApiUrl(process.env.TIKSHORTIS_API_URL);
if (process.env.TIKSHORTIS_API_URL && !TIKSHORTIS_API) {
  console.warn('[grabbit] TIKSHORTIS_API_URL is not a plain http(s) origin; native TikShortis is off.');
}
const { mode: TIKSHORTIS_MODE, warnings: TIK_MODE_WARNINGS } = modules.tikshortisMode(process.env, {
  apiOrigin: TIKSHORTIS_API,
  embed: TIKSHORTIS_EMBED,
});
for (const w of TIK_MODE_WARNINGS) console.warn(`[grabbit] ${w}`);

// Adult source ids from items.db. Lists are filtered against a set re-read at
// most once a minute; the per-clip gate (video, poster, any route acting on one
// clip) passes fresh=true and reads the database on every request. If items.db
// is not open the gateway cannot check, so it refuses every clip that has a
// source id rather than guess (fail closed).
const ADULT_IDS_TTL_MS = 60 * 1000;
let adultIds = { at: 0, set: null };
function tikClipIsAdult(clip, fresh = false) {
  const sid = clip && clip.source_id != null ? String(clip.source_id) : '';
  if (!sid) return false;
  if (!ITEM_STORE) return true;
  if (fresh) {
    try {
      return ITEM_STORE.isAdultSourceId(sid);
    } catch (e) {
      console.warn('[tik] adult id lookup failed:', e.message);
      return true;
    }
  }
  if (!adultIds.set || Date.now() - adultIds.at > ADULT_IDS_TTL_MS) {
    try {
      adultIds = { at: Date.now(), set: ITEM_STORE.adultSourceIds() };
    } catch (e) {
      console.warn('[tik] adult id lookup failed:', e.message);
      return true;
    }
  }
  return adultIds.set.has(sid);
}

if (TIKSHORTIS_MODE === 'native') {
  const gateway = tikGateway.createGateway({
    apiUrl: TIKSHORTIS_API,
    secret: AUTH_SECRET,
    isAdult: tikClipIsAdult,
    clientIp: (req) => req.ip || '',
  });
  // Below the auth gate, so only a signed-in browser gets here. App passwords
  // never reach /api/tik (the gate keeps them to their own paths); the
  // internal token is refused here, because the gateway acts for a person.
  app.use('/api/tik', (req, res, next) => {
    if (req.principal === gda.INTERNAL) return res.status(403).json({ ok: false, error: 'Not for internal callers' });
    next();
  }, (req, res) => {
    gateway.proxy(req, res).catch((e) => {
      console.warn('[tik] gateway error:', e.message);
      if (!res.headersSent) res.status(424).json({ ok: false, error: 'TikShortis is not reachable right now' });
      else res.destroy();
    });
  });
  console.log(`[grabbit] TikShortis: native, API at ${TIKSHORTIS_API}`);
} else {
  console.log(`[grabbit] TikShortis: ${TIKSHORTIS_MODE}`);
}

// --- Grabbit 3.0 phase 2: Social & Photos over Elitogram (egram-gateway.js) -------
// EGRAM_MODE=native draws Social & Photos in the hub and reaches Elitogram's API
// through /api/egram/*, a gateway to EGRAM_API_URL (Elitogram on the internal
// network). Unset or off: no module, no routes.
const EGRAM_API = tikGateway.parseApiUrl(process.env.EGRAM_API_URL);
if (process.env.EGRAM_API_URL && !EGRAM_API) {
  console.warn('[grabbit] EGRAM_API_URL is not a plain http(s) origin; Social & Photos is off.');
}
const { mode: EGRAM_MODE, warnings: EGRAM_MODE_WARNINGS } = modules.egramMode(process.env, { apiOrigin: EGRAM_API });
for (const w of EGRAM_MODE_WARNINGS) console.warn(`[grabbit] ${w}`);

// Elitogram does not know Grabbit's classification, so the gateway drops every
// item whose author matches a Grabbit profile classified 18+: its aliases (in
// file-name spelling) and its account handles on any platform. Rebuilt when
// the profile store changes. If the store cannot be read, every author counts
// as 18+ and the module shows nothing (fail closed).
// The read-only store is the server's cached copy once anything has loaded it;
// before that it is read from disk, at most once a minute.
let egramAdultNames = { store: null, set: null, folded: null, at: 0 };
// The same person is often spelled differently in the two apps ("katerina-23"
// in Grabbit, "katerina23" in Elitogram; "Lillie Lucas" and "lillielucas"), so
// every 18+ name is also kept folded: compatibility forms and accents folded,
// lower case, letters and digits only. A folded match only ever hides an author
// (18+), never shows one, so a looser match fails closed. Too short a fold is
// not used: it would hide unrelated short handles.
const EGRAM_FOLD_MIN = 4;
function egramFold(name) {
  const f = String(name == null ? '' : name).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return f.length >= EGRAM_FOLD_MIN ? f : '';
}
function egramAdultLookup() {
  if (egramAdultNames.set && (profilesCache ? egramAdultNames.store === profilesCache : Date.now() - egramAdultNames.at < 60000)) {
    return egramAdultNames;
  }
  const { store } = readProfilesReadOnly();
  {
    const set = new Set();
    const folded = new Set();
    const add = (name, key) => {
      set.add(key);
      const f = egramFold(name);
      if (f) folded.add(f);
    };
    for (const p of store.profiles) {
      if (profiles.effectiveAudience(p) !== 'adult') continue;
      for (const a of p.aliases || []) add(a.name, creatorKey(a.name).toLowerCase());
      for (const a of p.accounts || []) add(a.handle, String(a.handle).toLowerCase());
      if (p.origin === 'manual') add(p.name, creatorKey(p.name).toLowerCase());
    }
    egramAdultNames = { store, set, folded, at: Date.now() };
  }
  return egramAdultNames;
}
function egramIsAdultHandle(handle) {
  try {
    const { set, folded } = egramAdultLookup();
    const h = String(handle || '').toLowerCase();
    if (set.has(h) || set.has(creatorKey(h).toLowerCase())) return true;
    const f = egramFold(handle);
    return !!f && folded.has(f);
  } catch (e) {
    console.warn('[egram] adult profile lookup failed:', e.message);
    return true;
  }
}

// Mirrors an Elitogram classification into Grabbit's profiles, so the two
// apps agree: profiles that match the handle (alias, manual name, or an
// egram/instagram account) are classified; without a match a manual profile
// is created with the egram account (and the Instagram one Elitogram knows).
// A profile found only through the Instagram account gets the egram account
// added, so later reads and media checks find it under the egram handle too.
// Returns { changed: [ids], created: id|null, linked: id|null }.
function mirrorEgramClassification(handle, aud, igHandle) {
  const { store } = readProfiles();
  const key = creatorKey(handle).toLowerCase();
  const own = audience.matchProfiles(store, { creatorKey: key, handle: handle.toLowerCase(), platform: 'egram' }, creatorKey);
  const viaIg = igHandle
    ? audience.matchProfiles(store, { creatorKey: '', handle: igHandle.toLowerCase(), platform: 'instagram' }, creatorKey).filter((m) => !own.some((o) => o.profile.id === m.profile.id))
    : [];
  const matches = [...own, ...viaIg];
  const ids = [...new Set(matches.filter((m) => profiles.effectiveAudience(m.profile) !== aud).map((m) => m.profile.id))];
  if (matches.length) {
    const now = Date.now();
    let next = store;
    let dirty = false;
    let changed = [];
    if (ids.length) {
      const r = profiles.classifyProfiles(next, ids, aud, now);
      next = r.store;
      changed = r.changed;
      dirty = r.changed.length > 0;
    }
    let linked = null;
    if (!own.length && viaIg.length) {
      const p = next.profiles.find((x) => x.id === viaIg[0].profile.id);
      try {
        const r = profiles.update(next, p.id, { accounts: [...p.accounts, { platform: 'egram', handle, url: null, source: 'egram' }] }, now);
        next = r.store;
        dirty = true;
        linked = p.id;
      } catch (e) {
        // The egram account belongs to another profile already; leave it there.
        console.warn(`[egram] could not add egram @${handle} to profile #${p.id}: ${e.message}`);
      }
    }
    if (dirty) saveProfiles(next);
    return { changed, created: null, linked };
  }
  const accounts = [{ platform: 'egram', handle, url: null, source: 'egram' }];
  if (igHandle) accounts.push({ platform: 'instagram', handle: igHandle, url: `https://www.instagram.com/${igHandle}/`, source: 'egram' });
  const r = profiles.create(store, { name: handle, audience: aud, note: 'Created when classified in Social & Photos', accounts }, Date.now());
  saveProfiles(r.store);
  return { changed: [], created: r.profile.id };
}

// The key that seals Elitogram session tokens into the link cookie. With no
// GRABBIT_SECRET and no password, AUTH_SECRET is the public 'grabbit-dev'
// literal, so a random key is generated once and kept in DATA_DIR instead.
function egramSealSecret() {
  if (process.env.GRABBIT_SECRET || GRABBIT_PASSWORD) return AUTH_SECRET;
  const file = path.join(DATA_DIR, 'egram-seal.key');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`${file} does not hold a 64-hex-digit key; remove it to generate a new one`);
  return key;
}

if (EGRAM_MODE === 'native') {
  const gateway = egramGateway.createGateway({
    apiUrl: EGRAM_API,
    secret: egramSealSecret(),
    isAdultHandle: egramIsAdultHandle,
    // The Elitogram link is bound to this Grabbit sign-in (a hash, never the cookie itself).
    bindingOf: (req) => crypto.createHash('sha256').update(`egram-link|${parseCookies(req.headers.cookie)[AUTH_COOKIE] || ''}`).digest('base64url').slice(0, 22),
    clientIp: (req) => req.ip || '',
    // The most one upload may carry in all (default 4096 MB, as Elitogram's per-file limit).
    uploadMaxBytes: (Number(process.env.EGRAM_UPLOAD_MAX_MB) > 0 ? Number(process.env.EGRAM_UPLOAD_MAX_MB) : 4096) * 1024 * 1024,
  });
  // Writes to Grabbit's own egram routes: Sec-Fetch-Site must say same-origin
  // when present; otherwise an Origin or Referer on this host is required.
  const egramWriteFromOwnPage = (req) => {
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    for (const v of [req.headers.origin, req.headers.referer]) {
      if (!v || v === 'null') continue;
      try { return !!host && new URL(v).host.toLowerCase() === host; } catch { return false; }
    }
    return false;
  };
  const notInternal = (req, res, next) => {
    if (req.principal === gda.INTERNAL) return res.status(403).json({ ok: false, error: 'Not for internal callers' });
    next();
  };

  // Who a handle is in Elitogram, read before any write: the creator as the
  // review lane sees it, else as the general lane does. -> creator | null
  async function egramCreatorOf(req, handle) {
    for (const lane of ['review', 'general']) {
      const c = await gateway.callJson(req, 'GET', `/api/creators/${encodeURIComponent(handle)}`, undefined, lane);
      // A revoked Elitogram session answers 401: that is "relink", not "creator missing".
      if (!c.linked || c.status === 401) return { linked: false };
      if (c.status === 200 && c.json && typeof c.json.handle === 'string' && !c.json.out_of_scope) return { linked: true, creator: c.json };
      if (c.status >= 500) throw new Error(`Elitogram answered ${c.status}`);
    }
    return { linked: true, creator: null };
  }
  // The names a creator goes by in Elitogram: its handle, its Instagram account
  // and its aliases. Each of them is checked against Grabbit's 18+ profiles.
  const egramNamesOf = (handle, c) =>
    [handle, c && c.ig_handle, ...(c && Array.isArray(c.aliases) ? c.aliases : [])].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase());
  const egramIgOf = (c) => (c && /^[a-z0-9._]{1,30}$/.test(String(c.ig_handle || '')) ? c.ig_handle : null);

  // POST /api/egram/creators-classify { handles: [..], audience: general|adult, lane }
  // Classifies in Elitogram and mirrors the decision into Grabbit's profiles.
  // A creator is made general only when Elitogram knows it and none of the
  // names it goes by matches a Grabbit 18+ profile; that is checked before
  // Elitogram is written to.
  app.post('/api/egram/creators-classify', notInternal, async (req, res) => {
    try {
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const aud = b.audience === 'general' || b.audience === 'adult' ? b.audience : null;
      if (!aud) return res.status(400).json({ ok: false, error: 'audience must be general or adult' });
      const raw = b.handles;
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200 || !raw.every((h) => typeof h === 'string' && h.length <= 101)) {
        return res.status(400).json({ ok: false, error: 'Send 1 to 200 valid handles' });
      }
      const handles = [...new Set(raw.map((h) => h.trim().toLowerCase().replace(/^@/, '')).filter((h) => /^[a-z0-9._-]{1,60}$/.test(h)))];
      if (handles.length !== raw.length) return res.status(400).json({ ok: false, error: 'Send 1 to 200 valid handles' });
      // A write: it must come from one of Grabbit's own pages. With Fetch Metadata
      // that is Sec-Fetch-Site: same-origin; without it, an Origin (or Referer)
      // on this host. A request with neither is refused, unlike a read.
      if (!egramWriteFromOwnPage(req)) return res.status(403).json({ ok: false, error: 'Request not from this site' });
      const lane = b.lane === 'review' ? 'review' : 'general';

      let send = [];
      const skipped = [];
      const igOf = new Map();
      const creatorOf = new Map();
      for (const h of handles) {
        const r = await egramCreatorOf(req, h);
        if (!r.linked) return res.status(401).json({ ok: false, error: 'Link your Elitogram account first', relink: true });
        igOf.set(h, egramIgOf(r.creator));
        creatorOf.set(h, r.creator);
        if (aud === 'general' && !r.creator) { skipped.push({ handle: h, reason: 'not found in Elitogram' }); continue; }
        send.push(h);
      }
      // Checked against Grabbit's 18+ profiles as they are now, after every lookup
      // above has finished: a creator marked 18+ while a later lookup was pending
      // is not promoted. Nothing awaits between this check and the dispatch.
      if (aud === 'general') {
        const adult = new Set(send.filter((h) => egramNamesOf(h, creatorOf.get(h)).some((n) => egramIsAdultHandle(n))));
        for (const h of adult) skipped.push({ handle: h, reason: 'matches an 18+ profile in Grabbit' });
        send = send.filter((h) => !adult.has(h));
      }
      const mirrored = [];
      if (send.length) {
        const up = await gateway.callJson(req, 'POST', '/api/creators-classify', { handles: send, audience: aud }, lane);
        if (!up.linked) return res.status(401).json({ ok: false, error: 'Link your Elitogram account first' });
        if (up.status !== 200 || !up.json) {
          const status = up.status >= 500 ? 424 : up.status;
          return res.status(status).json({ ok: false, error: (up.json && typeof up.json.error === 'string' && up.json.error) || `Elitogram answered ${up.status}` });
        }
        if (Array.isArray(up.json.skipped)) skipped.push(...up.json.skipped);
        for (const h of Array.isArray(up.json.updated) ? up.json.updated : []) {
          if (typeof h !== 'string' || !send.includes(h)) continue;
          try {
            mirrored.push({ handle: h, ...mirrorEgramClassification(h, aud, igOf.get(h) || null) });
          } catch (e) {
            mirrored.push({ handle: h, error: e.message });
          }
        }
      }
      // Elitogram accepted these; a failed local mirror is reported apart, so the
      // two apps never silently disagree. Classifying again retries the mirror.
      const failed = mirrored.filter((m) => m.error);
      for (const m of failed) console.warn(`[egram] classified ${m.handle} ${aud} in Elitogram but not in Grabbit's profiles: ${m.error}`);
      console.log(`egram: ${mirrored.length - failed.length} creator(s) classified ${aud} by hand, ${failed.length} not mirrored, ${skipped.length} skipped`);
      res.set('Cache-Control', 'no-store').json({
        ok: true,
        audience: aud,
        updated: mirrored.filter((m) => !m.error).map((m) => m.handle),
        mirror_failed: failed.map((m) => ({ handle: m.handle, error: 'Saved in Elitogram, but Grabbit could not record it. Classify again to retry.' })),
        mirrored: mirrored.filter((m) => !m.error),
        skipped,
      });
    } catch (e) {
      console.warn('[egram] classify:', e.message);
      if (!res.headersSent) res.status(424).json({ ok: false, error: 'Elitogram is not reachable right now' });
    }
  });

  app.use('/api/egram', notInternal, (req, res) => {
    gateway.proxy(req, res).catch((e) => {
      console.warn('[egram] gateway error:', e.message);
      if (!res.headersSent) res.status(424).json({ ok: false, error: 'Elitogram is not reachable right now' });
      else res.destroy();
    });
  });
  console.log(`[grabbit] Social & Photos: native, Elitogram API at ${EGRAM_API}`);
} else {
  console.log(`[grabbit] Social & Photos: ${EGRAM_MODE}`);
}

// --- Grabbit 3.0: native Adshortis gateway (/api/ads/*) ------------------------------
// Mounted only in effective native mode; otherwise /api/ads does not exist.
// Below the auth gate, so a signed-out caller already got 401 and an app client
// 403; the gateway refuses everything that is not the owner's browser session.
if (ADS_GATEWAY) {
  app.use(adsGateway.MOUNT, (req, res) => {
    ADS_GATEWAY.handle(req, res).catch(() => {
      console.warn('[ads] gateway error');
      if (!res.headersSent) res.status(424).set('Cache-Control', 'private, no-store').json({ ok: false, error: 'Adshortis is not reachable right now' });
      else res.destroy();
    });
  });
  console.log('[grabbit] Adshortis: native');
} else {
  console.log(`[grabbit] Adshortis: ${ADSHORTIS_MODE}`);
}

// --- Grabbit 2.0 hub ----------------------------------------------------------
// HUB_BRAND: the line under the logo. HUB_APP_LINKS: the sidebar's app list,
// `Name|https://url,Name|https://url`. Both are deploy settings, not code, so
// this public repo names no real app or domain. Non-https links are dropped.
const HUB_BRAND = String(process.env.HUB_BRAND || 'Media hub').slice(0, 60);
const HUB_APP_LINKS = hub.parseAppLinks(process.env.HUB_APP_LINKS);
// Read-only numbers for the hub dashboard (public/hub/), counted from the
// downloaded registry by hub.js. Nothing here is estimated: a count the
// registry cannot answer is left out rather than guessed.
app.get('/api/hub/summary', async (req, res) => {
  const summary = hub.summarize(registryForView(readDownloaded(), wantsAdultView(req), readProfileStoreQuietly()));
  let storage = null;
  try {
    const fsx = await fs.promises.statfs(DOWNLOAD_DIR);
    storage = { path: 'downloads', size: fsx.blocks * fsx.bsize, free: fsx.bavail * fsx.bsize };
  } catch {
    /* not mounted or not reachable: the dashboard shows no storage row */
  }
  res.json({
    ok: true,
    ...summary,
    storage,
    channels: Object.keys(CHANNELS).filter((ch) => !!CHANNEL_ROOTS[ch]),
    brand: HUB_BRAND,
    apps: HUB_APP_LINKS,
  });
});

// GET /api/hub/creators?q=&limit= -> creators seen in file names, most files first.
app.get('/api/hub/creators', (req, res) => {
  const registry = registryForView(readDownloaded(), wantsAdultView(req), readProfileStoreQuietly());
  res.json({ ok: true, ...hub.creatorList(registry, { q: req.query.q, limit: Number(req.query.limit) || 200 }) });
});

// --- Grabbit 2.0 profiles -------------------------------------------------------
// One creator profile holds many platform accounts and the creator names seen in
// file names (see profiles.js for the rules). The store is profiles.json; files on
// disk and the downloaded registry are never touched. Only the admin session gets
// here: app passwords are refused by the gate above.
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
let profilesCache = null;

// The store, with every creator the registry knows given a profile. A file that
// is readable JSON but breaks the invariants is refused rather than "repaired":
// writing a reconstruction over it could drop links the owner made by hand.
// The store as it is, for the read-only preview: no registry sync, no save, no
// quarantine of a damaged file. Throws when the file cannot be used, and the
// caller then fails closed.
function readProfilesReadOnly() {
  if (profilesDamaged) throw new Error(profilesDamaged);
  if (profilesCache) return { store: profilesCache };
  const onDisk = profilesDamageOnDisk();
  if (onDisk) throw new Error(onDisk);
  let raw = null;
  try {
    raw = fs.readFileSync(PROFILES_FILE, 'utf8');
  } catch (e) {
    // Only a missing file is a fresh install. Any other failure is thrown, so
    // a caller such as the egram gateway fails closed instead of reading an
    // empty store.
    if (e.code !== 'ENOENT') throw e;
  }
  if (raw === null) return { store: profiles.normalizeStore(null) };
  const parsed = JSON.parse(raw);
  if (!isProfileStoreShape(parsed)) throw new Error('profiles.json does not hold a profile store');
  return { store: profiles.normalizeStore(parsed) };
}
// An existing profiles.json must hold a store object; only a missing file is a fresh install.
function isProfileStoreShape(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
// Set when profiles.json was damaged and no snapshot restored it. Every read
// then fails, so the adult filter that depends on the store fails closed until
// the owner repairs the kept file and restarts.
let profilesDamaged = null;
// The damage must outlive a restart: after a failed recovery the active file is
// gone (moved aside as .corrupt-<stamp>), and a fresh process would otherwise
// read "missing" as a fresh install and open the adult filter. A marker file
// records it; a missing profiles.json next to a kept .corrupt copy counts too.
// The owner repairs the store, then removes the marker (and the .corrupt file).
const PROFILES_DAMAGED_MARKER = `${PROFILES_FILE}.damaged`;
function profilesDamageOnDisk() {
  try {
    const why = fs.readFileSync(PROFILES_DAMAGED_MARKER, 'utf8').trim();
    return why || 'profiles.json is marked damaged';
  } catch (e) {
    if (e.code !== 'ENOENT') return `profiles.json damage marker unreadable: ${e.message}`;
  }
  let names = [];
  try {
    names = fs.readdirSync(path.dirname(PROFILES_FILE));
  } catch (e) {
    return `profiles.json folder unreadable: ${e.message}`;
  }
  const base = path.basename(PROFILES_FILE);
  if (!names.includes(base) && names.some((n) => n.startsWith(`${base}.corrupt-`))) {
    return 'profiles.json is missing next to a kept .corrupt copy; repair it (or remove the .corrupt file for a fresh store) and restart';
  }
  return null;
}
function markProfilesDamaged(why) {
  profilesDamaged = why;
  try {
    writeJsonAtomic(PROFILES_DAMAGED_MARKER, why);
  } catch (e) {
    console.error(`could not record the profiles damage marker: ${e.message}`);
  }
}
// The store, cached only once it is known good: a missing file (fresh install),
// a file that parses, or one restored from a snapshot. An unreadable file
// (EACCES, EIO, ...) is thrown and not cached, so no caller, including the
// egram gateway that shares the cache, ever sees an empty stand-in.
function loadProfilesStore() {
  if (profilesDamaged) throw new Error(profilesDamaged);
  const onDisk = profilesDamageOnDisk();
  if (onDisk) {
    profilesDamaged = onDisk;
    throw new Error(onDisk);
  }
  let raw;
  try {
    raw = fs.readFileSync(PROFILES_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return profiles.normalizeStore(null);
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch { /* damaged: quarantine and restore below */ }
  if (parsed !== undefined) {
    // JSON that parses but is not a store (null, an array, a number) is not a
    // fresh install: refuse it instead of starting empty.
    if (isProfileStoreShape(parsed)) return profiles.normalizeStore(parsed);
    markProfilesDamaged('profiles.json does not hold a profile store; repair it, remove profiles.json.damaged and restart');
    throw new Error(profilesDamaged);
  }
  const unrestored = Symbol('unrestored');
  const restored = readJsonState(PROFILES_FILE, unrestored);
  if (restored === unrestored || !isProfileStoreShape(restored)) {
    markProfilesDamaged('profiles.json is damaged and no snapshot restored it; repair the kept .corrupt file, remove profiles.json.damaged and restart');
    throw new Error(profilesDamaged);
  }
  return profiles.normalizeStore(restored);
}
function readProfiles() {
  if (!profilesCache) profilesCache = loadProfilesStore();
  const stats = profiles.aliasStats(readDownloaded());
  const synced = profiles.sync(profilesCache, stats, Date.now());
  if (synced.added) saveProfiles(synced.store);
  return { store: profilesCache, stats };
}
function saveProfiles(store) {
  writeJsonAtomic(PROFILES_FILE, store);
  profilesCache = store;
  scheduleAudienceChanged();
}
// Batches the re-send that follows a classification change (H97, H99). It
// runs after the current request, never during module start-up.
let audienceChangePending = false;
function scheduleAudienceChanged() {
  if (audienceChangePending) return;
  audienceChangePending = true;
  setImmediate(() => {
    audienceChangePending = false;
    try {
      audienceChanged();
    } catch (e) {
      console.warn('jobs: re-sending after a classification change failed:', e.message);
    }
  });
}
function profileError(res, e) {
  if (e instanceof profiles.ProfileError) return res.status(e.status).json({ ok: false, error: e.message });
  console.error('profiles:', e.message);
  return res.status(500).json({ ok: false, error: 'The profile store could not be used. See the server log.' });
}
// Runs one store operation and saves its result.
function changeProfiles(res, op) {
  try {
    const { store, stats } = readProfiles();
    const r = op(store, Date.now());
    saveProfiles(r.store);
    res.json({
      ok: true,
      profile: r.profile ? profiles.view(r.profile, stats) : null,
      from: r.from ? profiles.view(r.from, stats) : null,
    });
  } catch (e) {
    profileError(res, e);
  }
}

// --- Grabbit 2.0 items and the audience gate --------------------------------------
// Every item Grabbit delivers into an app gets a row in items.db (SQLite, WAL)
// with its audience, and every delivery gets a row of its own. The gate
// (audience.js) runs before any byte is written into an app's folder, and the
// database refuses a general delivery of an item that is not general on its
// own, so a code path that forgets the gate still cannot record one.
const ITEMS_DB_FILE = path.join(DATA_DIR, 'items.db');
let ITEM_STORE = null;
let ITEM_STORE_ERROR = null;
try {
  ITEM_STORE = itemStore.open(ITEMS_DB_FILE);
  if (ITEM_STORE.migrationBackup) {
    console.log(`items.db migrated to schema ${ITEM_STORE.SCHEMA_VERSION}; the old copy is ${path.basename(ITEM_STORE.migrationBackup)}`);
  }
  // Phase A: the registry is the source of truth until the index is proven
  // against it. Read-only on downloaded.json; adds what is missing.
  const r = ITEM_STORE.importRegistry(readDownloaded());
  const c = ITEM_STORE.counts();
  console.log(
    `items.db: ${c.items} items (${c.general} general, ${c.adult} 18+, ${c.unknown} unclassified), ` +
    `${c.deliveries} deliveries; registry has ${r.registryItems} items, ${r.added} added, ${r.tightened} tightened`
  );
} catch (e) {
  ITEM_STORE = null;
  ITEM_STORE_ERROR = e.message;
  console.error(`[grabbit] items.db could not be opened (${e.message}). No app receives anything until it can.`);
}

// The duplicate scan (dupe-scan.js): Grabbit's own folders and the apps'
// media folders, read-only. It starts only when the owner starts it on the
// hub's Duplicates page, and resumes after a restart only if it was running.
// DUPES_SCAN=off leaves it out entirely; DUPES_SCAN_MBPS caps its reads.
const DUPE_ROOT_CANDIDATES = [
  { path: DOWNLOAD_DIR, label: 'Grabbit library', owner: 'grabbit' },
  { path: VIDEOS_DIR, label: 'Grabbit videos', owner: 'grabbit' },
  { path: PHOTOS_DIR, label: 'Grabbit photos', owner: 'grabbit' },
  { path: AUDIO_DIR, label: 'Grabbit audio', owner: 'grabbit' },
  { path: ADULTS_DIR, label: 'Grabbit 18+ library', owner: 'grabbit', adult: true },
  { path: NAVIDROME_DIR, label: 'Music library', owner: 'grabbit', app: 'Navidrome' },
  { path: NAVIDROME_KIDS_DIR, label: 'Kids music library', owner: 'grabbit', app: 'Navidrome' },
  { path: AUDIOBOOKS_DIR, label: 'Audiobooks', owner: 'grabbit' },
  { path: TIKSHORTIS_ROOT, label: 'TikShortis', owner: 'app', app: 'TikShortis' },
  { path: PLATFORM_IMPORT_ROOT, label: 'Platform import', owner: 'app', app: 'Platform', import: true, importFor: PLATFORM_LIBRARY_DIR },
  { path: POSTS_ROOT, label: 'Posts import', owner: 'app', app: 'Posts', import: true },
  { path: EGRAM_IMPORT_DIR, label: 'egram import', owner: 'app', app: 'egram', import: true, importFor: EGRAM_LIBRARY_DIR },
  // egram holds general and 18+ posts side by side: its copies count as 18+
  // until egram itself reports every post using them as general.
  { path: EGRAM_LIBRARY_DIR, label: 'egram library', owner: 'app', app: 'egram', mixedAudience: true },
  { path: PLATFORM_LIBRARY_DIR, label: 'Platform library', owner: 'app', app: 'Platform' },
];
// D12: the 18+ app's import folder (ELITE_ROOT) and its library are not
// Duplicate Manager roots in any mode, and no flag brings them back. Rows an
// earlier scan recorded under them are marked gone at boot, their cached
// previews are deleted, and every preview route refuses them per request.
const DUPE_RETIRED_ROOTS = [ELITE_ROOT, ADSHORTIS_LIBRARY_DIR].filter(Boolean).map((p) => path.resolve(p));
const realPathOrNull = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
// Codex phase-0 B7: a retired folder may also sit inside another scan root, so
// every check takes the file's whole path (root + rel), lexically and as
// resolved on disk (a symlink is followed).
function isRetiredDupeRoot(p, rel = '') {
  if (!p) return false;
  const abs = path.resolve(String(p), String(rel || ''));
  const under = (x, r) => x === r || x.startsWith(r + path.sep);
  if (DUPE_RETIRED_ROOTS.some((r) => under(abs, r))) return true;
  const real = realPathOrNull(abs);
  if (!real) return false;
  return DUPE_RETIRED_ROOTS.some((r) => under(real, r) || under(real, realPathOrNull(r) || r));
}
// An import folder's copy may go only when its app's library has the bytes.
// importFor is null when that library is not mounted here.
// The retired 18+ folders are never entered, also when they sit inside
// another root (Codex phase-0 B7).
const dupeRoots = () => dupeScan.planRoots(DUPE_ROOT_CANDIDATES, [DATA_DIR, INBOX_DROP_DIR, ...DUPE_RETIRED_ROOTS]);
const dupeRootOf = (p) => DUPE_ROOT_CANDIDATES.find((r) => r.path && r.path === p) || null;
// Smart Duplicate Manager 2.0 state: dupes.db, attached to items.db's
// connection (dupe-store.js). items.db itself keeps schema 6, so 3.0.3 can
// still open it after a rollback.
let DUPE_DX = null;
if (ITEM_STORE && ITEM_STORE.raw && ITEM_STORE.trashAdd) {
  try {
    DUPE_DX = dupeStore.attach(ITEM_STORE.raw, path.join(DATA_DIR, 'dupes.db'));
  } catch (e) {
    console.error(`dupes: dupes.db could not be opened (${e.message}); the Duplicate Manager runs without it`);
  }
}
// Removed duplicate copies wait here (outside every scan root). How long is
// the owner's retention setting (30 days by default; 0 = manual cleanup).
const DUPE_TRASH_DIR = path.join(DATA_DIR, 'dupe-trash');
const DUPE_TRASH = ITEM_STORE && ITEM_STORE.trashAdd ? new DupeTrash({
  store: ITEM_STORE,
  trashDir: DUPE_TRASH_DIR,
  rootOf: dupeRootOf,
  holdMs: () => (ITEM_STORE ? readDupeCfg(ITEM_STORE).trashRetentionDays * 24 * 3600 * 1000 : 0),
  onRemoved: DUPE_DX ? (id, row, info) => {
    const r = dupeRootOf(row.root) || {};
    const kind = require('./dupe-classify').kindOf(row.rel);
    const k = info.keep || {};
    DUPE_DX.putTrashMeta(id, {
      reason: info.reason || 'Identical copy', app: r.app || 'Grabbit', kind,
      audience: require('./dupe-classify').audienceOf(r, null), keep_root: k.root || null, keep_rel: k.rel || null,
      keep_sha256: k.sha256 || null,
    });
  } : null,
  // Local moves into the trash are journaled like app operations, so one
  // cut short by a crash is listed under unfinished operations.
  journal: DUPE_DX ? {
    begin: (payload, by) => DUPE_DX.opBegin('grabbit', 'trash', payload, by, Date.now()),
    end: (id, ok, error = null) => DUPE_DX.opEnd(id, ok, { error }, Date.now()),
    note: (id, result) => DUPE_DX.opNote(id, result),
    tx: (fn) => DUPE_DX.tx(fn),
  } : null,
  mergeOf: DUPE_DX ? (id) => {
    const m = DUPE_DX.trashMeta(id);
    return m && m.reason === 'merged' ? m : null;
  } : null,
  // The copy kept in place of a trashed one (any reason), for the last-copy
  // check of a permanent delete.
  keepOf: DUPE_DX ? (id) => DUPE_DX.trashMeta(id) || null : null,
}) : null;
if (DUPE_TRASH) {
  const purge = async () => {
    try {
      const n = DUPE_SERVICE ? await DUPE_SERVICE.purgeGrabbitTrash() : await DUPE_TRASH.purge();
      if (n) console.log(`dupes: purged ${n} trashed copies past the hold time`);
    } catch (e) {
      console.error(`dupes: trash purge failed (${e.message})`);
    }
    if (DUPE_SERVICE) {
      try {
        const n = await DUPE_SERVICE.purgeAppTrash();
        if (n) console.log(`dupes: ${n} app-held copies purged past the hold time`);
      } catch (e) {
        console.error(`dupes: app trash purge failed (${e.message})`);
      }
    }
  };
  setTimeout(purge, 60 * 1000).unref();
  setInterval(purge, 60 * 60 * 1000).unref();
}
// D12, once per boot: forget what an earlier scan saw under the retired roots.
if (ITEM_STORE && ITEM_STORE.raw && ITEM_STORE.filesGoneBefore && DUPE_RETIRED_ROOTS.length) {
  try {
    const db = ITEM_STORE.raw;
    const all = db.prepare('SELECT DISTINCT root FROM file_hashes WHERE gone_at IS NULL').pluck().all();
    const roots = all.filter((r) => isRetiredDupeRoot(r));
    let rows = 0;
    let thumbs = 0;
    const thumbDir = path.join(DATA_DIR, 'dupe-thumbs');
    const dropThumb = (sha) => {
      if (!/^[0-9a-f]{64}$/.test(String(sha))) return;
      try {
        fs.unlinkSync(path.join(thumbDir, sha.slice(0, 2), `${sha}.jpg`));
        thumbs++;
      } catch {
        /* never made */
      }
    };
    for (const root of roots) {
      for (const sha of db.prepare('SELECT DISTINCT sha256 FROM file_hashes WHERE root = ? AND sha256 IS NOT NULL').pluck().all(root)) dropThumb(sha);
      rows += ITEM_STORE.filesGoneBefore(root, Number.MAX_SAFE_INTEGER);
    }
    // A retired folder inside another root (B7): its files under that root.
    const goneOne = db.prepare('UPDATE file_hashes SET gone_at = ? WHERE id = ? AND gone_at IS NULL');
    for (const root of all.filter((r) => !roots.includes(r))) {
      const nested = DUPE_RETIRED_ROOTS.filter((r) => r.startsWith(path.resolve(root) + path.sep));
      if (!nested.length) continue;
      for (const f of db.prepare('SELECT id, rel, sha256 FROM file_hashes WHERE root = ? AND gone_at IS NULL').all(root)) {
        if (!isRetiredDupeRoot(root, f.rel)) continue;
        dropThumb(f.sha256);
        rows += goneOne.run(Date.now(), f.id).changes;
      }
    }
    if (rows || thumbs) console.log(`dupes: the 18+ app's folders are no longer scanned; ${rows} recorded files set aside, ${thumbs} cached previews deleted`);
  } catch (e) {
    console.error(`dupes: setting aside the 18+ app's recorded files failed (${e.message})`);
  }
}
let DUPE_SCANNER = null;
if (ITEM_STORE && ITEM_STORE.fileSeen && String(process.env.DUPES_SCAN || '').toLowerCase() !== 'off') {
  let passHistory = null;
  DUPE_SCANNER = new dupeScan.DupeScanner({
    store: ITEM_STORE,
    roots: dupeRoots,
    mbPerSec: (DUPE_DX && readDupeCfg(ITEM_STORE).scanMbps) || Number(process.env.DUPES_SCAN_MBPS) || 20,
    defaultMbPerSec: Number(process.env.DUPES_SCAN_MBPS) || 20,
    onPass: DUPE_DX ? (phase, info) => {
      if (phase === 'start') passHistory = DUPE_DX.historyStart('exact');
      else if (passHistory) {
        DUPE_DX.historyEnd(passHistory, { files: info.files, bytes: info.bytes, outcome: 'complete' });
        passHistory = null;
        if (DUPE_SERVICE) DUPE_SERVICE.invalidate();
      }
    } : null,
  });
  try {
    DUPE_SCANNER.boot();
  } catch (e) {
    console.error(`dupes: the scan could not resume (${e.message})`);
  }
}

// The engines, the app adapters and the service behind the Smart Duplicate
// Manager (/api/hub/dupes/v2). DUPES_PHOTO / DUPES_AI / DUPES_VIDEO = off
// switch an analysis engine off; the exact scan does not depend on them.
const DUPE_MODELS = new DupeModels({ dir: path.join(DATA_DIR, 'models') });
let DUPE_ANALYZER = null;
let DUPE_SERVICE = null;
if (DUPE_DX) {
  DUPE_ANALYZER = new DupeAnalyzer({ store: ITEM_STORE, dx: DUPE_DX, rootOf: dupeRootOf, models: DUPE_MODELS });
  const dedupeToken = readDedupeToken(process.env.GRABBIT_DEDUPE_TOKEN_FILE);
  const adapters = new Map();
  const tikUrl = (() => { try { return process.env.TIKSHORTIS_API_URL ? new URL(process.env.TIKSHORTIS_API_URL).origin : null; } catch { return null; } })();
  const egramUrl = (() => { try { return process.env.EGRAM_API_URL ? new URL(process.env.EGRAM_API_URL).origin : null; } catch { return null; } })();
  if (TIKSHORTIS_ROOT) {
    adapters.set(TIKSHORTIS_ROOT, new AppAdapter({ id: 'tikshortis', app: 'TikShortis', root: TIKSHORTIS_ROOT, url: tikUrl, token: dedupeToken, caps: ['lookup', 'link', 'opstatus', 'hold'] }));
  }
  if (EGRAM_LIBRARY_DIR) {
    adapters.set(EGRAM_LIBRARY_DIR, new AppAdapter({ id: 'egram', app: 'egram', root: EGRAM_LIBRARY_DIR, url: egramUrl, token: dedupeToken, caps: ['lookup', 'cache'] }));
  }
  DUPE_SERVICE = new DupeService({
    store: ITEM_STORE, dx: DUPE_DX, roots: DUPE_ROOT_CANDIDATES, rootOf: dupeRootOf, trash: DUPE_TRASH,
    analyzer: DUPE_ANALYZER, scanner: DUPE_SCANNER, adapters, models: DUPE_MODELS,
  });
  DUPE_SERVICE.onJobDuplicate = (job, hit) => {
    if (jobsMap.get(job.id) === job) setJob(job, { duplicate: hit });
  };
  try {
    DUPE_ANALYZER.boot();
  } catch (e) {
    console.error(`dupes: the analysis could not resume (${e.message})`);
  }
  console.log(`dupes: Smart Duplicate Manager on (adapters: ${[...adapters.values()].map((a) => `${a.app}${a.ready().ok ? '' : ' (not connected)'}`).join(', ') || 'none'})`);
}

// What the source said about an item (caption, tags, raw record), kept in
// items.db beside the owner's own metadata. Called wherever a save completes.
// A save that has no item row yet gets one under the registry's rule for its
// channel (18+ channel -> adult, else unknown; a job's own adult signal
// tightens it), exactly as the next registry import would have added it.
// It never makes anything general. `meta` is a fromJob() result taken before
// any owner override; without it the job itself is read.
const SOURCE_META = new WeakMap();
function noteSourceMeta(job, filename, channel, meta) {
  if (!ITEM_STORE || !ITEM_STORE.recordSourceMeta || !job) return;
  const key = itemKeyOf(job);
  if (!key) return;
  try {
    const m = meta !== undefined ? meta : sourceMeta.fromJob(job);
    if (!m) return;
    let item = ITEM_STORE.get(key);
    if (!item) {
      const aud = job.audience === 'adult' ? 'adult' : itemStore.audienceOfRegistryChannel(channel);
      item = ITEM_STORE.upsert({
        key,
        site: job.site,
        sourceId: job.mediaId,
        sourceUrl: job.sourceUrl,
        kind: itemKindOf(job),
        audience: aud,
        reasons: [job.audience === 'adult' ? 'the source marks it 18+' : `registry channel ${channel || 'none'}`],
        creator: job.creator,
        title: job.title,
        filename: filename || null,
        origin: 'save',
      });
    }
    ITEM_STORE.recordSourceMeta(item.id, m);
  } catch (e) {
    console.error(`[grabbit] source metadata of ${key} was not recorded: ${e.message}`);
  }
}

// The app destination a save into this channel lands in. With dest=elite an
// image in a non-platform channel goes to the posts import.
function destinationOf(channel, job) {
  const ch = CHANNELS[channel] || 'main';
  if (ch === 'platform' || ch === '18plus') return ch;
  return job && job.mediaType === 'image' ? 'posts' : 'main';
}

// The item key: the registry's site-native id key, else its URL key.
function itemKeyOf(job) {
  if (!job) return null;
  return idKey(job.site, job.mediaId) || (job.sourceUrl ? mediaKey(job.sourceUrl) : null);
}

function itemKindOf(job) {
  if (job && job.mediaType === 'image') return 'image';
  return job && job.audioOnly ? 'audio' : 'video';
}

const creatorKey = (name) => safeCreator(name);

// The audience of the item behind this job, for a save into `destination`.
// A save into the 18+ app tightens it to adult; a job's own `audience: adult`
// does too. Nothing a job says can make an item general.
// readOnly (the route preview) reads the profile store without syncing or
// saving it, and takes the item's own row as `priorRow`.
function classifyJob(destination, job, { readOnly = false, priorRow = null } = {}) {
  const prior = priorRow || (ITEM_STORE && itemKeyOf(job) ? ITEM_STORE.get(itemKeyOf(job)) : null);
  let store = null;
  let storeProblem = null;
  try {
    ({ store } = readOnly ? readProfilesReadOnly() : readProfiles());
  } catch (e) {
    storeProblem = `the profile store could not be read (${e.message})`;
  }
  const look = (creator) =>
    audience.classify(
      {
        creatorKey: creator,
        handle: creator,
        site: job && job.site,
        extractor: job && job.extractor,
        sourceUrl: job && job.sourceUrl,
        requested: destination === '18plus' || (job && job.audience === 'adult') ? 'adult' : null,
        prior: prior ? prior.audience : null,
        priorByHand: Boolean(prior && prior.classified_by_hand),
      },
      store,
      { keyOf: creatorKey }
    );
  // The creator as the job names it, and as the site named it when the job
  // renamed it: a rename never borrows another creator's general profile.
  let c = look(job && job.creator);
  if (job && job.sourceCreator !== undefined && job.sourceCreator !== job.creator) {
    c = audience.stricter(c, look(job.sourceCreator));
  }
  if (storeProblem && c.audience === 'general') return { audience: 'unknown', reasons: [storeProblem], profileId: null };
  if (storeProblem) c.reasons.push(storeProblem);
  return c;
}

function recordItem(job, classification, filename) {
  const key = itemKeyOf(job);
  if (!ITEM_STORE || !key) return null;
  return ITEM_STORE.upsert({
    key,
    site: job.site,
    sourceId: job.mediaId,
    sourceUrl: job.sourceUrl,
    kind: itemKindOf(job),
    audience: classification.audience,
    reasons: classification.reasons,
    profileId: classification.profileId,
    creator: job.creator,
    title: job.title,
    filename,
    origin: 'save',
  });
}

// recordItem plus the source's metadata, for the delivery paths.
function recordItemWithMeta(job, classification, filename) {
  const item = recordItem(job, classification, filename);
  if (item && ITEM_STORE.recordSourceMeta) {
    try {
      const m = SOURCE_META.has(job) ? SOURCE_META.get(job) : sourceMeta.fromJob(job);
      if (m) ITEM_STORE.recordSourceMeta(item.id, m);
    } catch (e) {
      console.error(`[grabbit] source metadata of ${item.key} was not recorded: ${e.message}`);
    }
  }
  return item;
}

// Why this job may not be delivered to this app destination, or null. Fails
// closed: without the item store no app gets anything (18+ included, since its
// deliveries could not be recorded either); no key or any error means a general
// app gets nothing.
function audienceRefusal(destination, job) {
  try {
    const { why, c } = audienceVerdict(destination, job);
    if (why && c) {
      const item = recordItemWithMeta(job, c, null);
      if (item) ITEM_STORE.recordDelivery(item.id, destination, 'refused', { detail: why });
    }
    return why;
  } catch (e) {
    console.error('audience gate:', e.message);
    return `The audience check failed (${e.message}); nothing is delivered.`;
  }
}

// The decision itself, with no recording: { why, c }. Shared by the gate and
// the read-only route preview so the two can never disagree.
function audienceVerdict(destination, job, opts = {}) {
  const app = audience.DESTINATIONS[destination];
  const general = app && app.audience === 'general';
  if (app && !ITEM_STORE) {
    return { why: `The item store is unavailable (${ITEM_STORE_ERROR || 'not opened'}), so nothing is delivered to any app.`, c: null };
  }
  if (general && !itemKeyOf(job)) {
    return { why: 'This item has no source id or URL, so its audience cannot be recorded; nothing is delivered to a general app.', c: null };
  }
  const c = classifyJob(destination, job, opts);
  const why = audience.refusal(c, destination, { mediaType: job && job.mediaType, creator: job && job.creator });
  return { why, c };
}

// The last check before bytes go into an app's folder. Throws on refusal.
function assertDeliverable(destination, job) {
  const why = audienceRefusal(destination, job);
  if (why) throw new Error(why);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let bytes = 0;
    fs.createReadStream(file)
      .on('data', (d) => { h.update(d); bytes += d.length; })
      .on('error', reject)
      .on('end', () => resolve({ sha256: h.digest('hex'), bytes }));
  });
}

// Records a finished drop. The database trigger is the second lock: if this
// item is not general, a general delivery cannot be recorded, and that is
// logged loudly because the file is already in place.
function recordDrop(destination, job, filename, filePath) {
  if (!ITEM_STORE || !itemKeyOf(job)) return;
  try {
    const c = classifyJob(destination, job);
    const item = recordItemWithMeta(job, c, filename);
    ITEM_STORE.recordDelivery(item.id, destination, 'dropped', { filename });
    if (filePath) {
      sha256File(filePath)
        .then(({ sha256, bytes }) => {
          const twin = ITEM_STORE.recordHash(item.id, sha256, bytes);
          if (twin) console.warn(`duplicate content: ${filename} has the same bytes as item ${twin.key} (${twin.filename || 'no file name'})`);
        })
        .catch(() => { /* the importer may already have taken the file */ });
    }
  } catch (e) {
    console.error(`[grabbit] delivery of ${filename} to ${destination} could not be recorded: ${e.message}`);
  }
}

// GET /api/hub/route-preview?channel=main|18plus|platform&key=<item key>|url=<source url>
// -> where a KNOWN item would be filed and whether the gate lets it through.
// Read-only: it runs the same destinationOf / platformRefusal / audience
// verdict as a real save, but writes no item, delivery or profile row, fetches
// nothing, and never lowers a refusal. An item the store does not know gets 404
// (its audience cannot be judged without resolving it); a failing check is
// reported as refused, never as allowed.
app.get('/api/hub/route-preview', (req, res) => {
  const channel = String(req.query.channel || '');
  if (!Object.prototype.hasOwnProperty.call(CHANNELS, channel)) {
    return res.status(400).json({ ok: false, error: `Unknown channel "${channel.slice(0, 40)}". Use one of: ${Object.keys(CHANNELS).join(', ')}.` });
  }
  const key = String(req.query.key || '').trim() || (req.query.url ? mediaKey(String(req.query.url)) : '');
  if (!key) return res.status(400).json({ ok: false, error: 'Give key= (an item key) or url= (a source URL).' });
  const refuse = (extra) => res.json({ ok: true, allowed: false, channel, ...extra });
  if (!ITEM_STORE) {
    return refuse({ known: false, destination: null, reason: `The item store is unavailable (${ITEM_STORE_ERROR || 'not opened'}), so nothing is delivered to any app.` });
  }
  let row = null;
  try {
    row = ITEM_STORE.get(key) || (req.query.url ? ITEM_STORE.getBySourceUrl(String(req.query.url)) : null);
  } catch (e) {
    return refuse({ known: false, destination: null, reason: `The item store could not be read (${e.message}).` });
  }
  if (!row) return res.status(404).json({ ok: false, known: false, error: 'This item is not known to Grabbit, so its route cannot be previewed without resolving it.' });
  const job = {
    site: row.site,
    mediaId: row.source_id,
    sourceUrl: row.source_url,
    creator: row.creator,
    title: row.title,
    mediaType: row.kind === 'image' ? 'image' : 'video',
    audioOnly: row.kind === 'audio',
  };
  const destination = destinationOf(channel, job);
  const base = { known: true, key: row.key, destination, itemAudience: row.audience };
  try {
    const unavailable = shortsUnavailable(channel) || (destination === 'posts' ? postsUnavailable() : null);
    if (unavailable) return refuse({ ...base, reason: unavailable });
    if (CHANNELS[channel] === 'platform') {
      const own = platformDrop.platformRefusal(job);
      if (own) return refuse({ ...base, reason: own });
    }
    const { why, c } = audienceVerdict(destination, job, { readOnly: true, priorRow: row });
    if (why) return refuse({ ...base, audience: c ? c.audience : null, reasons: c ? c.reasons : [], reason: why });
    return res.json({ ok: true, allowed: true, channel, ...base, audience: c.audience, reasons: c.reasons, reason: null });
  } catch (e) {
    return refuse({ ...base, reason: `The audience check failed (${e.message}); nothing is delivered.` });
  }
});

// GET /api/hub/profiles?q=&audience=general|adult&limit=
app.get('/api/hub/profiles', (req, res) => {
  try {
    const { store, stats } = readProfiles();
    const audience = profiles.AUDIENCES.includes(req.query.audience) ? req.query.audience : '';
    res.json({ ok: true, platforms: profiles.PLATFORMS, ...profiles.list(store, stats, { q: req.query.q, audience, limit: Number(req.query.limit) || 200 }) });
  } catch (e) {
    profileError(res, e);
  }
});
// GET /api/hub/profiles/:id
app.get('/api/hub/profiles/:id', (req, res) => {
  try {
    const { store, stats } = readProfiles();
    res.json({ ok: true, platforms: profiles.PLATFORMS, profile: profiles.view(profiles.findProfile(store, req.params.id), stats) });
  } catch (e) {
    profileError(res, e);
  }
});
// POST /api/hub/profiles { name, audience, note?, accounts? } -> a manual profile.
app.post('/api/hub/profiles', (req, res) => changeProfiles(res, (s, now) => profiles.create(s, req.body, now)));
// POST /api/hub/profiles/merge { target, sources: [id] }
app.post('/api/hub/profiles/merge', (req, res) =>
  changeProfiles(res, (s, now) => profiles.merge(s, (req.body || {}).target, (req.body || {}).sources, now)));
// POST /api/hub/profiles/:id { name?, note?, accounts? }
app.post('/api/hub/profiles/:id', (req, res) => changeProfiles(res, (s, now) => profiles.update(s, req.params.id, req.body, now)));
// POST /api/hub/profiles/:id/split { name, aliases: [name], accounts: ['platform:handle'] }
app.post('/api/hub/profiles/:id/split', (req, res) =>
  changeProfiles(res, (s, now) => profiles.split(s, req.params.id, req.body, now)));

// --- Grabbit 2.0 Instagram inbox ---------------------------------------------------
// The patched Instagram app drops into INBOX_DROP_DIR (one folder per username).
// With INBOX_MODE=on every settled drop is moved into DATA_DIR/inbox/staged,
// recorded in items.db, run through the audience gate and delivered to the apps
// the owner switched on (inbox-settings.json). An unclassified creator's items
// wait in the inbox until the owner classifies the creator in the hub; nothing is
// general by default. INBOX_MODE=shadow only reads the drop folder and logs what
// it would do (inbox/shadow.jsonl), so it can run beside the old bridge.
// Off by default: unset means the inbox does not exist.
const INBOX_STAGING = path.join(DATA_DIR, 'inbox', 'staged');
const INBOX_REDROPS = path.join(DATA_DIR, 'inbox', 'redrops');
const INBOX_SHADOW_LOG = path.join(DATA_DIR, 'inbox', 'shadow.jsonl');
const INBOX_SETTINGS_FILE = path.join(DATA_DIR, 'inbox-settings.json');
const INBOX_INTERVAL_MS = 60 * 1000;
const INBOX_STATUS = {
  mode: INBOX_DROP_DIR ? INBOX_MODE : 'off',
  dropDir: Boolean(INBOX_DROP_DIR),
  lastRun: null,
};

function readInboxSettings() {
  return inbox.normalizeSettings(readJsonState(INBOX_SETTINGS_FILE, null));
}
// Which inbox destinations this deploy can write to at all.
function inboxAvailable() {
  return {
    egram: Boolean(EGRAM_IMPORT_DIR),
    main: !shortsUnavailable('main'),
    platform: !shortsUnavailable('platform'),
    '18plus': !shortsUnavailable('18plus'),
  };
}

const stagedPath = (row, name) => path.join(INBOX_STAGING, row.username, name);
const TO_EGRAM = (mtime) => ({ root: EGRAM_IMPORT_DIR, srcRoot: INBOX_STAGING, mtime, ownerRef: EGRAM_IMPORT_DIR });

// The entry behind a staged row, rebuilt from its own sidecar so identity never
// depends on what a later code version would make of it.
function inboxEntryOf(row) {
  if (row.kind === 'profile') return { kind: 'profile', username: row.username, job: { site: 'instagram', creator: row.username, sourceCreator: row.username } };
  let sc = null;
  if (row.sidecar_file) {
    try { sc = inbox.parseSidecar(fs.readFileSync(stagedPath(row, row.sidecar_file), 'utf8')); } catch { sc = null; }
  }
  return inbox.mediaEntry(row.username, row.media_file, row.sidecar_file, sc);
}

// Moves one scanned entry from the drop folder into staging and records it.
// Copy first, row second, unlink last: a crash in between leaves a source
// whose staged twin is already there, and the next run only removes the source.
async function stageInboxEntry(e) {
  const srcDir = path.join(INBOX_DROP_DIR, e.username);
  const dstDir = path.join(INBOX_STAGING, e.username);
  const names = [e.sidecarFile, e.mediaFile].filter(Boolean);
  const known = ITEM_STORE.inboxByEntry(e.entry);
  if (known) {
    // The same file name again. Same bytes as the staged copy: our own leftover
    // from an interrupted move. Otherwise a re-drop, kept aside for the owner.
    for (const n of names) {
      const src = path.join(srcDir, n);
      let same = false;
      try { same = fs.statSync(src).size === fs.statSync(path.join(dstDir, n)).size; } catch { same = false; }
      if (!same) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        copyInto(src, path.join(INBOX_REDROPS, e.username), `${stamp}_${n}`, { root: INBOX_REDROPS, srcRoot: INBOX_DROP_DIR, mode: 0o600 });
        console.warn(`inbox: ${e.username}/${n} was dropped again with other bytes; kept in inbox/redrops`);
      }
      fs.rmSync(src, { force: true });
    }
    return null;
  }
  for (const n of names) copyInto(path.join(srcDir, n), dstDir, n, { root: INBOX_STAGING, srcRoot: INBOX_DROP_DIR, mode: 0o600 });
  let row;
  if (e.kind === 'profile') {
    row = ITEM_STORE.inboxAdd({ entry: e.entry, kind: 'profile', username: e.username, sidecarFile: e.sidecarFile, state: 'held', reason: 'new' });
  } else {
    const c = classifyJob('egram', e.job);
    const item = recordItemWithMeta(e.job, c, e.mediaFile);
    if (!item) throw new Error(`no item key for ${e.entry}`);
    let state = 'held';
    let reason = 'new';
    const { sha256, bytes } = await sha256File(path.join(dstDir, e.mediaFile));
    const twin = ITEM_STORE.recordHash(item.id, sha256, bytes);
    if (ITEM_STORE.everDelivered(item.id)) {
      state = 'duplicate';
      reason = 'this item was delivered before';
    } else if (twin && ITEM_STORE.everDelivered(twin.id)) {
      state = 'duplicate';
      reason = `the same bytes were delivered before as ${twin.key}`;
    }
    row = ITEM_STORE.inboxAdd({
      entry: e.entry, kind: 'media', itemId: item.id, username: e.username, groupKey: e.groupKey, groupSize: e.groupSize,
      mediaFile: e.mediaFile, sidecarFile: e.sidecarFile, state, reason,
    });
  }
  for (const n of names) fs.rmSync(path.join(srcDir, n), { force: true });
  return row;
}

// Delivers one staged row to one app. Returns null on success, else why not;
// a refusal or a failure is also recorded as a delivery row.
function deliverInboxRow(row, entry, dest, { mtime = null } = {}) {
  const item = row.item_id ? ITEM_STORE.getById(row.item_id) : null;
  const own = inbox.manualRefusal({ kind: row.kind, mediaType: entry.mediaType }, dest);
  if (own) return own;
  if (row.kind === 'profile') {
    // Profile metadata, no media: egram only, and only for a general creator.
    const c = classifyJob('egram', entry.job);
    if (c.audience !== 'general') return `The creator is not classified general (${c.reasons.join('; ')}).`;
    if (!EGRAM_IMPORT_DIR) return 'EGRAM_IMPORT_DIR is not set.';
    copyInto(stagedPath(row, row.sidecar_file), path.join(EGRAM_IMPORT_DIR, row.username), row.sidecar_file, TO_EGRAM(mtime));
    return null;
  }
  const job = entry.job;
  const fail = (why) => {
    if (item) ITEM_STORE.recordDelivery(item.id, dest, 'failed', { detail: why });
    return why;
  };
  try {
    if (dest === 'egram') {
      if (!EGRAM_IMPORT_DIR) return 'EGRAM_IMPORT_DIR is not set.';
      const refused = audienceRefusal('egram', job);
      if (refused) return refused;
      // egram reads the sidecar when it meets the media file, so the sidecar
      // goes first; both get one mtime so a carousel ripens as one post.
      const dir = path.join(EGRAM_IMPORT_DIR, row.username);
      if (row.sidecar_file) copyInto(stagedPath(row, row.sidecar_file), dir, row.sidecar_file, TO_EGRAM(mtime));
      const final = copyInto(stagedPath(row, row.media_file), dir, row.media_file, TO_EGRAM(mtime));
      recordDrop('egram', job, row.media_file, final);
      return null;
    }
    const unavailable = shortsUnavailable(dest);
    if (unavailable) return unavailable;
    const refused = channelRefusal(dest, job);
    if (refused) return refused;
    const destDir = channelDir(dest);
    fs.mkdirSync(destDir, { recursive: true });
    const { outName, sidecarName, sidecar } = dropFiles(dest, job, false);
    const buildPath = path.join(destDir, `.${outName}.part-${process.pid}`);
    try {
      fs.copyFileSync(stagedPath(row, row.media_file), buildPath);
      commitDrop(dest, job, destDir, buildPath, path.join(destDir, outName), sidecarName, sidecar);
    } finally {
      fs.rmSync(buildPath, { force: true });
    }
    return null;
  } catch (e) {
    console.error(`inbox: delivery of ${row.entry} to ${dest} failed: ${e.message}`);
    return fail(e.message);
  }
}

// Decides every open row again: a creator classified since the last run
// releases its items, and an 18+ signal that appeared holds them.
function releaseInbox(settings, now = Date.now()) {
  const available = inboxAvailable();
  const out = { delivered: 0, held: 0, ready: 0, failed: 0 };
  const groupTime = new Date(now);
  for (const row of ITEM_STORE.inboxOpen()) {
    try {
      const entry = inboxEntryOf(row);
      const c = classifyJob('egram', entry.job);
      if (row.kind === 'media') recordItemWithMeta(entry.job, c, row.media_file);
      if (c.audience !== 'general') {
        const why = c.audience === 'adult' ? `18+: ${c.reasons.join('; ')}` : c.reasons.join('; ');
        if (row.state !== 'held' || row.reason !== why) ITEM_STORE.inboxSetState(row.id, 'held', why, now);
        out.held++;
        continue;
      }
      if (row.kind === 'media' && row.group_key && row.group_size > 1) {
        const members = ITEM_STORE.inboxGroup(row.username, row.group_key);
        if (!inbox.groupReady(members, row.group_size, now)) {
          ITEM_STORE.inboxSetState(row.id, 'held', `waiting for the rest of the carousel (${members.length} of ${row.group_size})`, now);
          out.held++;
          continue;
        }
      }
      const plan = inbox.deliveryPlan({ kind: row.kind, mediaType: entry.mediaType, audience: 'general' }, { auto: settings.auto, available });
      if (!plan.deliver.length) {
        if (row.state !== 'ready') {
          const why = plan.skipped.length
            ? plan.skipped.map((s) => `${s.dest}: ${s.why}`).join('; ')
            : 'no automatic destination is switched on';
          ITEM_STORE.inboxSetState(row.id, 'ready', `general; waiting for a hand delivery (${why})`, now);
        }
        out.ready++;
        continue;
      }
      const errors = [];
      for (const dest of plan.deliver) {
        if (row.item_id && ITEM_STORE.deliveredTo(row.item_id, dest)) continue;
        const why = deliverInboxRow(row, entry, dest, { mtime: groupTime });
        if (why) errors.push(`${dest}: ${why}`);
      }
      if (errors.length) {
        ITEM_STORE.inboxSetState(row.id, 'ready', errors.join('; '), now);
        out.failed++;
      } else {
        ITEM_STORE.inboxSetState(row.id, 'delivered', `delivered to ${plan.deliver.join(', ')}`, now);
        out.delivered++;
      }
    } catch (e) {
      console.error(`inbox: ${row.entry}: ${e.message}`);
      out.failed++;
    }
  }
  return out;
}

// Staged files of settled rows are removed after keepDays: every app holds its
// own copy by then, and Grabbit keeps none (owner decision D).
function purgeInbox(settings, now = Date.now()) {
  let purged = 0;
  for (const row of ITEM_STORE.inboxPurgeDue(now - settings.keepDays * 24 * 60 * 60 * 1000)) {
    for (const n of [row.media_file, row.sidecar_file].filter(Boolean)) fs.rmSync(stagedPath(row, n), { force: true });
    ITEM_STORE.inboxMarkPurged(row.id, now);
    purged++;
  }
  return purged;
}

// Shadow mode: what the inbox WOULD do, one line per entry, never a write
// outside DATA_DIR and never a file moved.
let shadowSeen = null;
function shadowInbox(scan, settings, now) {
  if (!shadowSeen) {
    shadowSeen = new Set();
    try {
      for (const line of fs.readFileSync(INBOX_SHADOW_LOG, 'utf8').split('\n')) {
        try { shadowSeen.add(JSON.parse(line).entry); } catch { /* skip */ }
      }
    } catch { /* first run */ }
  }
  const available = inboxAvailable();
  const lines = [];
  for (const e of scan.entries) {
    if (shadowSeen.has(e.entry)) continue;
    shadowSeen.add(e.entry);
    const c = classifyJob('egram', e.job);
    const prior = e.key ? ITEM_STORE.get(e.key) : null;
    const plan = inbox.deliveryPlan({ kind: e.kind, mediaType: e.mediaType, audience: c.audience }, { auto: settings.auto, available });
    lines.push(JSON.stringify({
      at: now, entry: e.entry, kind: e.kind, key: e.key || null, mediaType: e.mediaType || null,
      groupKey: e.groupKey || null, audience: c.audience, reasons: c.reasons,
      duplicate: Boolean(prior && ITEM_STORE.everDelivered(prior.id)),
      wouldDeliver: plan.deliver, skipped: plan.skipped,
    }));
  }
  if (lines.length) {
    fs.mkdirSync(path.dirname(INBOX_SHADOW_LOG), { recursive: true });
    fs.appendFileSync(INBOX_SHADOW_LOG, lines.join('\n') + '\n');
  }
  return lines.length;
}

let inboxBusy = false;
async function runInbox(reason = 'interval') {
  if (!INBOX_DROP_DIR || INBOX_MODE === 'off' || inboxBusy) return INBOX_STATUS.lastRun;
  if (!ITEM_STORE) {
    INBOX_STATUS.lastRun = { at: Date.now(), reason, error: `the item store is unavailable (${ITEM_STORE_ERROR || 'not opened'})` };
    return INBOX_STATUS.lastRun;
  }
  inboxBusy = true;
  const now = Date.now();
  const run = { at: now, reason, staged: 0, waiting: 0, ignored: [], error: null };
  try {
    const settings = readInboxSettings();
    const scan = inbox.scanDrop(INBOX_DROP_DIR, { now, since: INBOX_SINCE });
    run.waiting = scan.waiting;
    run.ignored = scan.ignored.slice(0, 50);
    run.ignoredTotal = scan.ignored.length;
    if (INBOX_MODE === 'shadow') {
      run.shadowLogged = shadowInbox(scan, settings, now);
    } else {
      for (const e of scan.entries) {
        try {
          if (await stageInboxEntry(e)) run.staged++;
        } catch (err) {
          console.error(`inbox: staging ${e.entry} failed: ${err.message}`);
          run.ignored.push({ path: e.entry, why: `staging failed: ${err.message}` });
        }
      }
      run.release = releaseInbox(settings, Date.now());
      run.purged = purgeInbox(settings, Date.now());
      if (run.staged || run.release.delivered) {
        console.log(`inbox: ${run.staged} staged, ${run.release.delivered} delivered, ${run.release.held} held, ${run.release.ready} ready`);
      }
    }
  } catch (e) {
    run.error = e.message;
    console.error(`inbox: ${e.message}`);
  } finally {
    inboxBusy = false;
  }
  INBOX_STATUS.lastRun = run;
  return run;
}
if (INBOX_DROP_DIR && INBOX_MODE !== 'off') {
  console.log(`inbox: ${INBOX_MODE} mode, reading ${INBOX_DROP_DIR}`);
  setTimeout(() => runInbox('boot'), 15 * 1000).unref();
  setInterval(() => runInbox('interval'), INBOX_INTERVAL_MS).unref();
}

const inboxUnavailable = (res) => {
  if (!ITEM_STORE) return res.status(503).json({ ok: false, error: `The item store is unavailable (${ITEM_STORE_ERROR || 'not opened'}).` }), true;
  return false;
};

// GET /api/hub/inbox?state=&q=&limit=&offset=
app.get('/api/hub/inbox', (req, res) => {
  if (inboxUnavailable(res)) return;
  try {
    const r = ITEM_STORE.inboxList({ state: req.query.state, q: req.query.q, limit: req.query.limit, offset: req.query.offset });
    const items = r.items.map((x) => ({
      ...x,
      deliveries: x.item_id ? ITEM_STORE.deliveries(x.item_id).map((d) => ({ destination: d.destination, status: d.status, at: d.at, detail: d.detail })) : [],
    }));
    res.json({
      ok: true,
      mode: INBOX_STATUS.mode,
      settings: readInboxSettings(),
      available: inboxAvailable(),
      counts: ITEM_STORE.inboxCounts(),
      lastRun: INBOX_STATUS.lastRun,
      total: r.total,
      offset: r.offset,
      items,
    });
  } catch (e) {
    console.error('inbox list:', e.message);
    res.status(500).json({ ok: false, error: 'The inbox could not be read. See the server log.' });
  }
});

// GET /api/hub/inbox/:id/file -> the staged media file (until it is purged).
app.get('/api/hub/inbox/:id/file', (req, res) => {
  if (inboxUnavailable(res)) return;
  const row = ITEM_STORE.inboxGet(req.params.id);
  if (!row || !row.media_file || row.purged_at) return res.status(404).json({ ok: false, error: 'No staged file' });
  let file;
  try {
    file = fs.realpathSync(stagedPath(row, row.media_file));
  } catch {
    return res.status(404).json({ ok: false, error: 'No staged file' });
  }
  const root = fs.realpathSync(INBOX_STAGING);
  if (!file.startsWith(root + path.sep)) return res.status(404).json({ ok: false, error: 'No staged file' });
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, max-age=3600' } }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// POST /api/hub/inbox/settings { auto: { egram, main, platform }, keepDays }
app.post('/api/hub/inbox/settings', (req, res) => {
  try {
    const next = inbox.normalizeSettings({ ...readInboxSettings(), ...(req.body || {}) });
    writeJsonAtomic(INBOX_SETTINGS_FILE, next);
    console.log(`inbox: settings changed, automatic: ${Object.keys(next.auto).filter((k) => next.auto[k]).join(', ') || 'none'}`);
    res.json({ ok: true, settings: next });
  } catch (e) {
    console.error('inbox settings:', e.message);
    res.status(500).json({ ok: false, error: 'The settings could not be saved. See the server log.' });
  }
});

// POST /api/hub/inbox/creators { username, audience } -> the owner's hand
// classification of one Instagram creator. A profile that already matches the
// username is classified; without one, a manual profile with the Instagram
// account is created. Held items are re-decided right away.
app.post('/api/hub/inbox/creators', async (req, res) => {
  const b = req.body || {};
  const aud = reviewAudience(b.audience);
  const username = String(b.username || '');
  if (!aud) return res.status(400).json({ ok: false, error: 'audience must be general or adult' });
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) return res.status(400).json({ ok: false, error: 'not an Instagram username' });
  try {
    const { store } = readProfiles();
    const matches = audience.matchProfiles(
      store,
      { creatorKey: safeCreator(username).toLowerCase(), handle: username.toLowerCase(), platform: 'instagram' },
      creatorKey
    );
    let changed = [];
    let created = null;
    if (matches.length) {
      const adult = matches.find((m) => profiles.effectiveAudience(m.profile) === 'adult');
      if (aud === 'general' && adult) {
        return res.status(409).json({ ok: false, error: `${username} matches the 18+ profile #${adult.profile.id}; an 18+ creator is never made general.` });
      }
      const ids = matches.filter((m) => profiles.effectiveAudience(m.profile) !== aud).map((m) => m.profile.id);
      if (ids.length) {
        const r = profiles.classifyProfiles(store, ids, aud, Date.now());
        if (r.changed.length) saveProfiles(r.store);
        changed = r.changed;
      }
    } else {
      const r = profiles.create(store, {
        name: username,
        audience: aud,
        note: 'Created from the Instagram inbox',
        accounts: [{ platform: 'instagram', handle: username, url: `https://www.instagram.com/${username}/`, source: 'inbox' }],
      }, Date.now());
      saveProfiles(r.store);
      created = r.profile.id;
    }
    console.log(`inbox: creator ${username} classified ${aud} by hand${created ? ` (new profile #${created})` : ''}`);
    const run = INBOX_MODE === 'on' ? await runInbox('classify') : null;
    res.json({ ok: true, changed, created, run });
  } catch (e) {
    profileError(res, e);
  }
});

// POST /api/hub/inbox/:id/deliver { destination } -> a hand delivery of one row
// (and, for a carousel, every staged member of its post, so egram files them
// as one post). The audience gate still decides.
app.post('/api/hub/inbox/:id/deliver', (req, res) => {
  if (inboxUnavailable(res)) return;
  const dest = String((req.body || {}).destination || '');
  const row = ITEM_STORE.inboxGet(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'No such inbox entry' });
  if (row.purged_at) return res.status(409).json({ ok: false, error: 'The staged file was already removed.' });
  const rows = row.kind === 'media' && row.group_key && row.group_size > 1
    ? ITEM_STORE.inboxGroup(row.username, row.group_key).filter((r) => !r.purged_at)
    : [row];
  const mtime = new Date();
  const results = [];
  for (const r of rows) {
    if (r.item_id && ITEM_STORE.deliveredTo(r.item_id, dest)) { results.push({ id: r.id, ok: true, note: 'already there' }); continue; }
    const why = deliverInboxRow(r, inboxEntryOf(r), dest, { mtime });
    if (!why) ITEM_STORE.inboxSetState(r.id, 'delivered', `delivered to ${dest} by hand`);
    results.push({ id: r.id, ok: !why, error: why || undefined });
  }
  const failed = results.filter((r) => !r.ok);
  res.status(failed.length === results.length ? 422 : 200).json({ ok: failed.length < results.length, error: failed[0] ? failed[0].error : undefined, results });
});

// POST /api/hub/inbox/run -> one inbox run now.
app.post('/api/hub/inbox/run', async (_req, res) => {
  if (!INBOX_DROP_DIR || INBOX_MODE === 'off') return res.status(409).json({ ok: false, error: 'The inbox is off on this server (INBOX_MODE, INBOX_DROP_DIR).' });
  res.json({ ok: true, run: await runInbox('manual') });
});

// GET /api/hub/inbox/shadow -> the shadow log summed up, for the switchover.
app.get('/api/hub/inbox/shadow', (_req, res) => {
  let lines = [];
  try {
    lines = fs.readFileSync(INBOX_SHADOW_LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no log yet */ }
  const sum = { entries: lines.length, media: 0, profiles: 0, audience: { general: 0, adult: 0, unknown: 0 }, duplicates: 0, wouldDeliver: {}, creators: {} };
  for (const l of lines) {
    if (l.kind === 'profile') sum.profiles++; else sum.media++;
    if (sum.audience[l.audience] !== undefined) sum.audience[l.audience]++;
    if (l.duplicate) sum.duplicates++;
    for (const d of l.wouldDeliver || []) sum.wouldDeliver[d] = (sum.wouldDeliver[d] || 0) + 1;
    const u = String(l.entry).split('/')[0];
    const c = sum.creators[u] || (sum.creators[u] = { media: 0, audience: l.audience });
    if (l.kind !== 'profile') c.media++;
    if (l.audience === 'adult' || (l.audience === 'unknown' && c.audience === 'general')) c.audience = l.audience;
  }
  res.json({ ok: true, mode: INBOX_STATUS.mode, first: lines.length ? lines[0].at : null, last: lines.length ? lines[lines.length - 1].at : null, ...sum });
});

// --- Review queue: the owner classifies creators and items by hand ----------------
// Nothing here downgrades 18+: the profile store and the item store both refuse
// to classify an 18+ creator or item general, and say so per id.
const reviewAudience = (v) => (v === 'general' || v === 'adult' ? v : null);

// GET /api/hub/review -> how much is waiting.
app.get('/api/hub/review', (_req, res) => {
  try {
    const { store } = readProfiles();
    const unclassified = store.profiles.filter((p) => profiles.effectiveAudience(p) === 'unknown').length;
    res.json({ ok: true, creators: { unclassified }, items: ITEM_STORE ? ITEM_STORE.counts() : null, itemStoreError: ITEM_STORE ? null : ITEM_STORE_ERROR });
  } catch (e) {
    profileError(res, e);
  }
});
// GET /api/hub/review/groups?q= -> unclassified profiles grouped by site and
// delivery history, so the owner can look at one kind of creator at a time.
app.get('/api/hub/review/groups', (req, res) => {
  try {
    const { store, stats } = readProfiles();
    // A General-source suggestion per group: shown to the owner, who confirms
    // it. It never classifies anything by itself.
    const groups = profiles.groups(store, stats, { status: 'unknown', q: req.query.q })
      .map((g) => ({ ...g, suggestion: smartRouting.suggestionForSites(g.sites) }));
    res.json({ ok: true, groups });
  } catch (e) {
    profileError(res, e);
  }
});
// GET /api/hub/sources -> the source table of the Settings spec and every
// source the registry has seen. A site outside the table is a newly detected
// source and is Review until the table names it. Read-only.
app.get('/api/hub/sources', (_req, res) => {
  try {
    const { stats } = readProfiles();
    const seen = new Set();
    for (const s of stats.values()) s.sites.forEach((x) => seen.add(x));
    res.json({ ok: true, reviewFolder: smartRouting.REVIEW_FOLDER, sources: smartRouting.sourceOverview([...seen]) });
  } catch (e) {
    profileError(res, e);
  }
});
// GET /api/hub/review/creators?q=&group=&limit=&offset= -> unclassified profiles, most files first.
app.get('/api/hub/review/creators', (req, res) => {
  try {
    const { store, stats } = readProfiles();
    const r = profiles.list(store, stats, { q: req.query.q, group: req.query.group, status: 'unknown', limit: Number(req.query.limit) || 100, offset: req.query.offset });
    r.items = r.items.map((v) => ({ ...v, suggestion: smartRouting.suggestionForSites(v.sites) }));
    res.json({ ok: true, ...r });
  } catch (e) {
    profileError(res, e);
  }
});
// POST /api/hub/review/creators { audience, ids: [id] } or { audience, all: true, q, group, expected }
// `all` classifies every unclassified profile matching q (and group, when
// given); `expected` must be the count the owner saw, so a list that changed
// meanwhile is not classified blind. Without `expected` nothing is classified.
// `reason: 'source-suggestion'` records that the owner confirmed a General-source
// suggestion; it is accepted for general only, and only for profiles the
// suggestion actually covers, so the trace never claims a suggestion that was
// not there.
app.post('/api/hub/review/creators', (req, res) => {
  const b = req.body || {};
  const aud = reviewAudience(b.audience);
  if (!aud) return res.status(400).json({ ok: false, error: 'audience must be general or adult' });
  const reason = b.reason == null ? 'hand' : b.reason;
  if (!profiles.CLASSIFY_REASONS.includes(reason)) {
    return res.status(400).json({ ok: false, error: `reason must be one of ${profiles.CLASSIFY_REASONS.join(', ')}` });
  }
  if (reason === 'source-suggestion' && aud !== 'general') {
    return res.status(400).json({ ok: false, error: 'a source suggestion is only ever General' });
  }
  try {
    const { store, stats } = readProfiles();
    let ids = b.ids;
    if (b.all === true) {
      if (b.group != null && typeof b.group !== 'string') return res.status(400).json({ ok: false, error: 'group must be a string' });
      ids = profiles.matching(store, { q: b.q, group: b.group || '', stats, status: 'unknown' }).map((p) => p.id);
      if (b.expected == null || Number(b.expected) !== ids.length) {
        return res.status(409).json({ ok: false, error: `The list changed: ${ids.length} creators match now, not ${b.expected}. Reload and check again.` });
      }
    }
    const notSuggested = [];
    if (reason === 'source-suggestion' && Array.isArray(ids)) {
      const covered = new Set(store.profiles
        .filter((p) => smartRouting.suggestionForSites(profiles.view(p, stats).sites))
        .map((p) => p.id));
      ids = ids.filter((id) => {
        if (covered.has(Number(id))) return true;
        notSuggested.push({ id: Number(id), reason: 'no General-source suggestion for this profile' });
        return false;
      });
      if (!ids.length) return res.status(409).json({ ok: false, error: 'None of these profiles has a General-source suggestion.', skipped: notSuggested });
    }
    const r = profiles.classifyProfiles(store, ids, aud, Date.now(), { reason });
    if (r.changed.length) saveProfiles(r.store);
    console.log(`review: ${r.changed.length} creator profile(s) classified ${aud} by hand (${reason}), ${r.skipped.length + notSuggested.length} skipped`);
    res.json({ ok: true, changed: r.changed, skipped: [...r.skipped, ...notSuggested] });
  } catch (e) {
    profileError(res, e);
  }
});
// GET /api/hub/review/items?audience=unknown&refused=1&q=&limit=&offset=
app.get('/api/hub/review/items', (req, res) => {
  if (!ITEM_STORE) return res.status(503).json({ ok: false, error: `The item store is unavailable (${ITEM_STORE_ERROR || 'not opened'}).` });
  try {
    const r = ITEM_STORE.listItems({
      audience: req.query.audience || 'unknown',
      refused: req.query.refused === '1',
      q: req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('review items:', e.message);
    res.status(500).json({ ok: false, error: 'The item store could not be read. See the server log.' });
  }
});
// POST /api/hub/review/items { audience, ids: [id] }
app.post('/api/hub/review/items', (req, res) => {
  const b = req.body || {};
  const aud = reviewAudience(b.audience);
  if (!aud) return res.status(400).json({ ok: false, error: 'audience must be general or adult' });
  if (!ITEM_STORE) return res.status(503).json({ ok: false, error: `The item store is unavailable (${ITEM_STORE_ERROR || 'not opened'}).` });
  try {
    const r = ITEM_STORE.classifyItems(b.ids, aud);
    if (r.changed.length) scheduleAudienceChanged();
    console.log(`review: ${r.changed.length} item(s) classified ${aud} by hand, ${r.skipped.length} skipped`);
    res.json({ ok: true, changed: r.changed, skipped: r.skipped });
  } catch (e) {
    if (e instanceof itemStore.StoreError) return res.status(400).json({ ok: false, error: e.message });
    console.error('review items:', e.message);
    res.status(500).json({ ok: false, error: 'The item store could not be changed. See the server log.' });
  }
});

// --- Grabbit 2.1 library: media tree, categories, profile tree ---------------------
// Virtual views over items.db; nothing here touches a media file. Every route
// names its scope ('general' or 'adult') and library.js filters on the item's
// audience first, so a general request never sees an adult item or profile.
function libraryStore(res) {
  if (!ITEM_STORE || !ITEM_STORE.library) {
    res.status(503).json({ ok: false, error: `The library is unavailable (${ITEM_STORE_ERROR || 'item store not upgraded to schema 6'}).` });
    return null;
  }
  return ITEM_STORE.library;
}
function libraryRoute(fn) {
  return (req, res) => {
    const lib = libraryStore(res);
    if (!lib) return;
    try {
      res.json({ ok: true, ...fn(lib, req, req.body || {}) });
    } catch (e) {
      if (e instanceof libraryLib.LibraryError) return res.status(e.status).json({ ok: false, error: e.message });
      if (e instanceof itemStore.StoreError) return res.status(400).json({ ok: false, error: e.message });
      console.error('library:', e.message);
      res.status(500).json({ ok: false, error: 'The library could not be read or changed. See the server log.' });
    }
  };
}
const libScope = (req, b) => (req.method === 'GET' ? req.query.scope : b.scope);
app.get('/api/library/media-tree', libraryRoute((lib, req) => ({ tree: lib.mediaTree(libScope(req)) })));
// Source metadata rarely holds a thumbnail, but the history log does (and
// Grabbit keeps a local copy of it). A listed item that matches a history
// entry by source URL or file name gets that picture, and the entry's id when
// the hub's media viewer can play it. The item list is already scoped, so
// this only decorates items the caller may see.
function withHistory(out) {
  const history = readHistory();
  const byUrl = new Map();
  const byName = new Map();
  for (const e of history) {
    if (e.sourceUrl && !byUrl.has(e.sourceUrl)) byUrl.set(e.sourceUrl, e);
    if (e.filename && !byName.has(e.filename)) byName.set(e.filename, e);
  }
  const stem = (f) => String(f || '').replace(/\.[A-Za-z0-9]+$/, '');
  for (const it of out.items) {
    const e = (it.sourceUrl && byUrl.get(it.sourceUrl)) || byName.get(it.filename) || byName.get(stem(it.filename));
    if (!e) continue;
    if (!it.thumb && /^https?:\/\//i.test(e.thumbnail || '')) it.thumb = e.thumbnail;
    if (mediaViewer.isPlainName(e.filename)) it.historyId = e.id;
  }
  // The item itself is the provenance of the picture it is listed with.
  for (const it of out.items) {
    if (it.thumb && it.key) {
      noteThumb(it.thumb, { kind: 'entry', ref: `i:${it.key}`, in: { itemKey: it.key, creator: it.creator, site: it.site, sourceUrl: it.sourceUrl, filename: it.filename } });
    }
  }
  return out;
}
app.get('/api/library/items', libraryRoute((lib, req) => withHistory(lib.listItems({
  scope: libScope(req), node: req.query.node, q: req.query.q, uncertain: req.query.uncertain === '1',
  limit: req.query.limit, offset: req.query.offset, store: readProfilesReadOnly().store,
}))));
app.post('/api/library/format', libraryRoute((lib, req, b) => lib.setFormat({ scope: b.scope, ids: b.ids, value: b.value === undefined ? null : b.value, by: actorOf(req) })));
app.get('/api/library/categories', libraryRoute((lib, req) => lib.categoryTree(libScope(req))));
app.post('/api/library/categories', libraryRoute((lib, req, b) => ({ category: lib.createCategory({ scope: b.scope, name: b.name, parentId: b.parentId, by: actorOf(req) }) })));
app.post('/api/library/categories/:id/rename', libraryRoute((lib, req, b) => ({ category: lib.renameCategory({ scope: b.scope, id: req.params.id, name: b.name, by: actorOf(req) }) })));
app.post('/api/library/categories/:id/move', libraryRoute((lib, req, b) => ({ category: lib.moveCategory({ scope: b.scope, id: req.params.id, parentId: b.parentId, by: actorOf(req) }) })));
app.post('/api/library/categories/:id/merge', libraryRoute((lib, req, b) => ({ category: lib.mergeCategories({ scope: b.scope, sourceId: req.params.id, targetId: b.targetId, by: actorOf(req) }) })));
app.post('/api/library/assign', libraryRoute((lib, req, b) => lib.assign({ scope: b.scope, ids: b.ids, categoryIds: b.categoryIds, remove: b.remove === true, by: actorOf(req) })));
app.get('/api/library/suggest', libraryRoute((lib, req) => (req.query.itemId
  ? { categories: lib.suggestForItem({ scope: libScope(req), itemId: req.query.itemId }) }
  : lib.suggestForCategory({ scope: libScope(req), categoryId: req.query.categoryId }))));
app.get('/api/library/profiles', libraryRoute((lib, req) => ({ tree: lib.profileTree(libScope(req), readProfilesReadOnly().store) })));

// --- Grabbit 2.0 duplicates and metadata ------------------------------------------
// Both pages read and write items.db only. Nothing here touches a file in any
// folder, and nothing here changes an item's audience: the gate never reads
// the owner's title, creator or tags.
const actorOf = (req) => (req.principal && req.principal.id) || null;
function metaStore(res) {
  if (!ITEM_STORE) {
    res.status(503).json({ ok: false, error: `The item store is unavailable (${ITEM_STORE_ERROR || 'not opened'}).` });
    return null;
  }
  if (!ITEM_STORE.listMeta) {
    res.status(503).json({ ok: false, error: 'The item store has not been upgraded to schema 4.' });
    return null;
  }
  return ITEM_STORE;
}
function metaError(res, e, what) {
  if (e instanceof itemMeta.MetaError || e instanceof itemStore.StoreError) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  console.error(`${what}:`, e.message);
  return res.status(500).json({ ok: false, error: `${what} failed. See the server log.` });
}
const SHA256_RE = /^[0-9a-f]{64}$/;

// Smart Duplicate Manager 2.0 (dupe-routes.js).
if (DUPE_SERVICE) {
  app.use('/api/hub/dupes/v2', dupeRoutes.createRouter({
    service: DUPE_SERVICE, scanner: DUPE_SCANNER, analyzer: DUPE_ANALYZER, models: DUPE_MODELS, trash: DUPE_TRASH,
    actorOf, kindOfName: (n) => mediaViewer.kindOfName(n),
    thumbDir: path.join(DATA_DIR, 'dupe-thumbs'), media: require('./dupe-media'),
    retiredRoot: isRetiredDupeRoot,
  }));
} else {
  app.use('/api/hub/dupes/v2', (req, res) => res.status(409).json({ ok: false, error: 'The Duplicate Manager needs the item store; see the server log.' }));
}

// GET /api/hub/dupes?state=open|acked|all&limit=&offset= -> scan status and
// exact duplicate groups (each member with its folder, app and item).
app.get('/api/hub/dupes', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  try {
    const scan = DUPE_SCANNER
      ? DUPE_SCANNER.status()
      : { state: 'off', active: false, roots: [], totals: {}, reason: String(process.env.DUPES_SCAN || '').toLowerCase() === 'off' ? 'DUPES_SCAN=off' : 'unavailable' };
    const state = ['open', 'acked', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const groups = store.dupeGroups({ state, limit: req.query.limit, offset: req.query.offset });
    const rootOf = new Map(DUPE_ROOT_CANDIDATES.filter((r) => r.path).map((r) => [r.path, r]));
    for (const g of groups.items) {
      g.members = g.members.map((m) => {
        const r = rootOf.get(m.root) || {};
        return { ...m, rootLabel: r.label || m.root, app: r.app || null, owner: r.owner || null, adultFolder: Boolean(r.adult) };
      });
      // The same bytes in an 18+ folder and in a folder a general app reads:
      // worth the owner's eye even when the group is otherwise harmless.
      g.crossesAudience = g.members.some((m) => m.adultFolder) && g.members.some((m) => !m.adultFolder && m.owner === 'app');
      if (DUPE_TRASH) {
        const plan = DUPE_TRASH.plan(g.members);
        const byId = new Map(plan.members.map((p) => [p.id, p]));
        g.members = g.members.map((m) => ({ ...m, ...byId.get(m.id) }));
        g.removable = plan.members.filter((p) => p.suggested).length;
      }
    }
    res.locals.trash = DUPE_TRASH ? DUPE_TRASH.held().length : 0;
    res.json({ ok: true, scan, ...groups, canRemove: Boolean(DUPE_TRASH), trashHeld: res.locals.trash });
  } catch (e) {
    metaError(res, e, 'Duplicates');
  }
});

// GET /api/hub/dupes/file/:id -> a scanned file, for the preview in a group.
// Read only: the row must be a present file of a known scan root, the path
// must stay inside that root, a symlink is refused, and only media is served.
app.get('/api/hub/dupes/file/:id', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  const notFound = () => res.status(404).json({ ok: false, error: 'Not available' });
  try {
    const row = store.hashedFile(req.params.id);
    if (!row || !DUPE_ROOT_CANDIDATES.some((r) => r.path && r.path === row.root)) return notFound();
    if (isRetiredDupeRoot(row.root, row.rel)) return notFound();
    const abs = path.resolve(row.root, row.rel);
    if (!abs.startsWith(path.resolve(row.root) + path.sep)) return notFound();
    const kind = mediaViewer.kindOfName(abs);
    if (!['video', 'image', 'audio'].includes(kind)) return notFound();
    if (!fs.lstatSync(abs).isFile()) return notFound();
    // A symlinked parent folder would pass the lexical check above, so the
    // real path must stay inside the real root as well.
    const realRoot = fs.realpathSync(row.root);
    const realAbs = fs.realpathSync(abs);
    if (realAbs !== path.join(realRoot, path.relative(path.resolve(row.root), abs))) return notFound();
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(realAbs, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, max-age=3600' } }, (err) => {
      if (err && !res.headersSent) res.status(err.status === 416 ? 416 : 404).end();
    });
  } catch (e) {
    if (!res.headersSent) notFound();
  }
});

// POST /api/hub/dupes/scan { action: 'start' | 'pause' }
app.post('/api/hub/dupes/scan', (req, res) => {
  if (!metaStore(res)) return;
  if (!DUPE_SCANNER) return res.status(409).json({ ok: false, error: 'The duplicate scan is switched off on this server (DUPES_SCAN=off).' });
  const action = req.body && req.body.action;
  if (action === 'start') {
    console.log(`dupes: scan started by ${actorOf(req) || 'owner'}`);
    return res.json({ ok: true, scan: DUPE_SCANNER.start() });
  }
  if (action === 'pause') {
    console.log(`dupes: scan paused by ${actorOf(req) || 'owner'}`);
    return res.json({ ok: true, scan: DUPE_SCANNER.pause() });
  }
  res.status(400).json({ ok: false, error: 'action must be start or pause' });
});

// --- removing duplicate copies ----------------------------------------------
// A removed copy moves to Grabbit's trash and can be restored for 30 days.
// Only copies in Grabbit's own folders, or in an app's import folder whose
// library already has the bytes, can go; the last copy and the only copy
// linked to an item never do. Both files are hashed again before the move.
const trashOff = (res) => {
  if (DUPE_TRASH) return false;
  res.status(409).json({ ok: false, error: 'Removing copies needs the item store (schema v5).' });
  return true;
};
const trashError = (res, e, what) => {
  if (e instanceof TrashError) return res.status(409).json({ ok: false, error: e.message });
  if (e && e.name !== 'TypeError' && e.status === 409) return res.status(409).json({ ok: false, error: e.message });
  console.error(`dupes: ${what} failed (${e.message})`);
  res.status(500).json({ ok: false, error: `${what} failed` });
};
let dupeRemoveBusy = false;

// POST /api/hub/dupes/remove { id } -> one copy to the trash.
app.post('/api/hub/dupes/remove', async (req, res) => {
  if (!metaStore(res) || trashOff(res)) return;
  const id = Number(req.body && req.body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'id must be a file id' });
  if (dupeRemoveBusy) return res.status(409).json({ ok: false, error: 'Another removal is running' });
  dupeRemoveBusy = true;
  try {
    // Same lock as the v2 actions: prevention, a retention purge or a v2
    // removal never decides on the same group while this one runs.
    const run = () => DUPE_TRASH.remove(id, { by: actorOf(req) });
    const trashId = DUPE_SERVICE ? await DUPE_SERVICE.exclusive('remove', run) : await run();
    console.log(`dupes: file ${id} moved to the trash (entry ${trashId}) by ${actorOf(req) || 'owner'}`);
    res.json({ ok: true, trashId });
  } catch (e) {
    trashError(res, e, 'Removing the copy');
  } finally {
    dupeRemoveBusy = false;
  }
});

// POST /api/hub/dupes/remove-all { confirm?, expect?, sha256? } -> every
// suggested extra copy of every open group (or of one group), best copy kept.
// Without `confirm: true` it is a dry run (an empty request moves nothing).
// A confirmed run over every group also needs `expect` ({ files, bytes,
// fingerprint }, the dry run the owner saw); if the plan changed since in any
// way (another kept copy, other copies of the same total), nothing moves.
app.post('/api/hub/dupes/remove-all', async (req, res) => {
  if (!metaStore(res) || trashOff(res)) return;
  const body = req.body || {};
  if (body.sha256 != null && !SHA256_RE.test(String(body.sha256))) return res.status(400).json({ ok: false, error: 'Not a SHA-256 hash' });
  const dryRun = body.confirm !== true;
  const sha256s = body.sha256 ? [String(body.sha256)] : null;
  const expect = body.expect && typeof body.expect === 'object' ? body.expect : null;
  if (!dryRun && !sha256s && (!expect || !Number.isSafeInteger(expect.files) || !Number.isSafeInteger(expect.bytes) || !SHA256_RE.test(String(expect.fingerprint || '')))) {
    return res.status(400).json({ ok: false, error: 'Removing every extra copy needs the plan you confirmed (expect)' });
  }
  if (!dryRun && dupeRemoveBusy) return res.status(409).json({ ok: false, error: 'Another removal is running' });
  if (!dryRun) dupeRemoveBusy = true;
  try {
    const run = async () => {
      if (!dryRun && !sha256s) {
        const p = await DUPE_TRASH.removeAll({ by: actorOf(req), dryRun: true, sha256s: null });
        if (p.files !== expect.files || p.bytes !== expect.bytes) {
          throw Object.assign(new Error('The duplicates changed since you confirmed; check them again'), { status: 409 });
        }
      }
      // The run itself plans again and moves nothing unless that plan is the
      // one confirmed (same groups, kept copies and copies to move).
      try {
        return await DUPE_TRASH.removeAll({ by: actorOf(req), dryRun, sha256s, fingerprint: !dryRun && !sha256s ? String(expect.fingerprint) : null });
      } catch (e) {
        if (e.stale) throw Object.assign(new Error(e.message), { status: 409 });
        throw e;
      }
    };
    let r;
    try {
      r = DUPE_SERVICE && !dryRun ? await DUPE_SERVICE.exclusive('remove all', run) : await run();
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ ok: false, error: e.message });
      throw e;
    }
    if (!dryRun) console.log(`dupes: ${r.files} copies (${r.bytes} bytes) moved to the trash by ${actorOf(req) || 'owner'}, ${r.failed.length} refused`);
    res.json({ ok: true, dryRun, ...r });
  } catch (e) {
    trashError(res, e, 'Removing copies');
  } finally {
    if (!dryRun) dupeRemoveBusy = false;
  }
});

// GET /api/hub/dupes/trash -> removed copies still held.
app.get('/api/hub/dupes/trash', (req, res) => {
  if (!metaStore(res) || trashOff(res)) return;
  const items = DUPE_TRASH.held().map((t) => {
    const r = dupeRootOf(t.root) || {};
    return { id: t.id, rel: t.rel, rootLabel: r.label || t.root, bytes: t.bytes, at: t.at, by: t.by, purgeAt: t.purgeAt };
  });
  res.json({ ok: true, items, bytes: items.reduce((n, t) => n + t.bytes, 0) });
});

// POST /api/hub/dupes/trash/:id/restore -> back to where it was.
app.post('/api/hub/dupes/trash/:id/restore', async (req, res) => {
  if (!metaStore(res) || trashOff(res)) return;
  try {
    // Same lock as the v2 trash actions, so a delete or a retention purge
    // never runs while this restore is still staging the copy.
    const run = () => DUPE_TRASH.restore(req.params.id);
    const t = DUPE_SERVICE ? await DUPE_SERVICE.exclusive('restore', run) : await run();
    console.log(`dupes: trash entry ${t.id} restored to ${t.rel} by ${actorOf(req) || 'owner'}`);
    res.json({ ok: true });
  } catch (e) {
    trashError(res, e, 'Restoring the copy');
  }
});

// POST /api/hub/dupes/:sha256/ack { note? } and .../unack: mark a group known
// or open it again. Nothing on disk changes.
app.post('/api/hub/dupes/:sha/ack', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  if (!SHA256_RE.test(req.params.sha)) return res.status(400).json({ ok: false, error: 'Not a SHA-256 hash' });
  try {
    const r = store.ackGroup(req.params.sha, { note: req.body && req.body.note, by: actorOf(req) });
    res.json({ ok: true, ...r });
  } catch (e) {
    metaError(res, e, 'Acknowledging the group');
  }
});
app.post('/api/hub/dupes/:sha/unack', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  if (!SHA256_RE.test(req.params.sha)) return res.status(400).json({ ok: false, error: 'Not a SHA-256 hash' });
  res.json({ ok: true, removed: store.unackGroup(req.params.sha) });
});

// GET /api/hub/meta?q=&tag=&origin=any|source|site|caption|user&creator=&tagged=any|none|source|user&edited=1&audience=&limit=&offset=
app.get('/api/hub/meta', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  try {
    const q = req.query;
    const r = store.listMeta({
      q: q.q, tag: q.tag, origin: q.origin, creator: q.creator, tagged: q.tagged,
      edited: q.edited === '1', audience: q.audience, limit: q.limit, offset: q.offset,
    });
    res.json({ ok: true, counts: store.metaCounts(), ...r });
  } catch (e) {
    metaError(res, e, 'Metadata list');
  }
});

// GET /api/hub/meta/tags?origin=&q=&limit= -> the most used tags.
app.get('/api/hub/meta/tags', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  try {
    res.json({ ok: true, tags: store.tagCounts({ origin: req.query.origin, q: req.query.q, limit: req.query.limit }) });
  } catch (e) {
    metaError(res, e, 'Tag list');
  }
});

// GET /api/hub/meta/creators?q=&limit= -> creators as shown, with counts.
app.get('/api/hub/meta/creators', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  try {
    res.json({ ok: true, creators: store.creatorCounts({ q: req.query.q, limit: req.query.limit }) });
  } catch (e) {
    metaError(res, e, 'Creator list');
  }
});

// POST /api/hub/meta/tags { ids: [itemId], add: [label], remove: [label] }
// -> the owner's own tags. Source and caption tags cannot be removed.
app.post('/api/hub/meta/tags', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  const b = req.body || {};
  const add = Array.isArray(b.add) ? b.add : [];
  const remove = Array.isArray(b.remove) ? b.remove : [];
  if (!add.length && !remove.length) return res.status(400).json({ ok: false, error: 'Nothing to add or remove' });
  try {
    const out = { added: null, removed: null };
    if (add.length) out.added = store.addUserTags(b.ids, add, actorOf(req));
    if (remove.length) out.removed = store.removeUserTags(b.ids, remove, actorOf(req));
    res.json({ ok: true, ...out });
  } catch (e) {
    metaError(res, e, 'Changing tags');
  }
});

// POST /api/hub/meta/creator-rename { from, to, expected } -> every item shown
// under `from` is shown under `to`. `expected` must match the count the owner
// saw, so a list that changed in between is not renamed blind.
app.post('/api/hub/meta/creator-rename', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  const b = req.body || {};
  try {
    const now = store.creatorCounts({ q: b.from, limit: 500 }).find((c) => c.creator === b.from);
    const n = now ? now.items : 0;
    if (b.expected == null || Number(b.expected) !== n) {
      return res.status(409).json({ ok: false, error: `The list changed: ${n} items are shown under that creator now, not ${b.expected}. Reload and check again.` });
    }
    const r = store.renameCreator(b.from, b.to, actorOf(req));
    console.log(`meta: ${r.changed} item(s) moved from creator "${b.from}" to "${b.to}" (batch ${r.batch})`);
    res.json({ ok: true, ...r });
  } catch (e) {
    metaError(res, e, 'Renaming the creator');
  }
});

// GET /api/hub/meta/:id -> one item: source and edited fields, caption, raw
// record, tags by origin, edit log.
app.get('/api/hub/meta/:id', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  if (!/^\d{1,12}$/.test(req.params.id)) return res.status(404).json({ ok: false, error: 'No such item' });
  try {
    res.json({ ok: true, item: store.getMeta(Number(req.params.id)) });
  } catch (e) {
    if (e instanceof itemMeta.MetaError) return res.status(404).json({ ok: false, error: e.message });
    metaError(res, e, 'Metadata');
  }
});

// POST /api/hub/meta/:id { title?, creator? } -> the owner's edit ('' removes it).
app.post('/api/hub/meta/:id', (req, res) => {
  const store = metaStore(res);
  if (!store) return;
  if (!/^\d{1,12}$/.test(req.params.id)) return res.status(404).json({ ok: false, error: 'No such item' });
  const b = req.body || {};
  const fields = {};
  for (const k of ['title', 'creator']) if (Object.prototype.hasOwnProperty.call(b, k)) fields[k] = b[k];
  if (!Object.keys(fields).length) return res.status(400).json({ ok: false, error: 'Nothing to change' });
  try {
    const r = store.editItem(Number(req.params.id), fields, actorOf(req));
    res.json({ ok: true, ...r, item: store.getMeta(Number(req.params.id)) });
  } catch (e) {
    metaError(res, e, 'Editing the item');
  }
});

// --- Grabbit 2.0 media viewer -----------------------------------------------------
// The hub's Media page plays videos and shows pictures in place. Entries come
// from the history log; their files are looked up in the folders the entry's
// save channel writes to (media-viewer.js). A request names an entry id and a
// variant, never a path, and a file is served only when its real path lies
// inside one of the roots below. Only the admin session gets here: the gate
// above refuses app passwords on every path but the job API.
const MEDIA_ROOTS = [
  CHANNEL_ROOTS.main && path.join(CHANNEL_ROOTS.main, 'main'),
  // Null when the boot check found the 18+ folder overlapping a general one.
  CHANNEL_ROOTS['18plus'] && path.join(CHANNEL_ROOTS['18plus'], '18plus'),
  CHANNEL_ROOTS.platform,
  POSTS_IMPORT_DIR,
  DOWNLOAD_DIR,
  VIDEOS_DIR,
  ADULTS_DIR,
  PHOTOS_DIR,
  AUDIO_DIR,
].filter(Boolean);
// What each channel is called on screen.
function mediaPlace(channel) {
  const ch = String(channel || '');
  if (ch === 'main') return `${CHANNEL_LIBRARY.main} library`;
  if (ch === '18plus') return `${CHANNEL_LIBRARY['18plus']} (18+)`;
  if (ch === 'platform') return `${CHANNEL_LIBRARY.platform} drop folder`;
  if (ch === 'elite/posts') return 'Posts import';
  if (ch.startsWith('server/')) return `Server library: ${ch.slice(7)}`;
  return ch || 'unknown';
}
// The folders an entry's files can be in, most likely first.
function mediaDirsOf(entry) {
  const ch = String(entry.channel || '');
  if (ch === 'main' || ch === '18plus') {
    if (!CHANNEL_ROOTS[ch]) return [];
    const root = path.join(CHANNEL_ROOTS[ch], ch);
    // Imported clips sit in the creator's folder; queued ones in _import.
    return [...creatorDirs(root, entry.creator), path.join(root, '_import')];
  }
  if (ch === 'platform') return CHANNEL_ROOTS.platform ? [CHANNEL_ROOTS.platform] : [];
  if (ch === 'elite/posts') return POSTS_IMPORT_DIR ? [path.join(POSTS_IMPORT_DIR, postsCreator(entry.creator))] : [];
  const m = /^server\/([^/]+)(?:\/([^/]+))?$/.exec(ch);
  if (!m) return []; // navidrome/*, audiobooks/*, audio/* and failed saves
  const [, shelf, sub] = m;
  if (shelf === 'mp3') return sub ? [] : [AUDIO_DIR];
  if (sub !== undefined && !mediaViewer.isPlainName(sub)) return [];
  const base = Object.hasOwn(SERVER_VIDEO_FOLDERS, shelf) ? SERVER_VIDEO_FOLDERS[shelf] : path.join(DOWNLOAD_DIR, sanitizeFolder(shelf));
  return [sub ? path.join(base, sub) : base];
}
const MEDIA_ID_RE = /^(legacy-)?\d+-\d+$/;
function mediaEntry(id) {
  if (!MEDIA_ID_RE.test(String(id || ''))) return null;
  const e = readHistory().find((x) => x.id === id);
  return e && mediaViewer.isPlainName(e.filename) ? e : null;
}
function siteOfUrl(u) {
  try {
    return new URL(u).hostname.replace(/^(www|m|music)\./, '');
  } catch {
    return null;
  }
}
// The item's audience as the gate would see it: the item store's row (by file
// name or source URL), the creator's profile, and the place it was saved. A
// save into the 18+ app or the adults shelf makes it 18+; nothing here can
// make an item general that the owner did not classify general.
// `memo` (optional, per request) reuses a classification for identical inputs,
// so a registry of thousands of rows costs one classify per distinct creator.
// `items` (optional) is an ITEM_STORE.audienceIndex() read once for many rows.
function entryClassification(entry, store, memo = null, items = ITEM_STORE) {
  const names = entry.filename ? [...new Set([entry.filename, `${mediaViewer.stemOf(entry.filename)}.mp4`])] : [];
  let row = null;
  if (items) {
    try {
      row = (entry.itemKey && items.get(entry.itemKey)) || (!entry.itemKey && entry.sourceUrl && items.get(mediaKey(entry.sourceUrl))) || null;
      for (const n of names) row = row || items.getByFilename(n);
    } catch {
      row = null;
    }
  }
  const ch = String(entry.channel || '');
  const savedAdult = ch === '18plus' || ch === 'server/adults' || ch.startsWith('server/adults/');
  // classify() reads the source URL only to see whether it names an 18+ site,
  // so only an 18+ URL is passed on; that keeps the memo key free of per-item
  // URLs.
  const input = {
    creatorKey: entry.creator,
    handle: entry.creator,
    site: entry.site || siteOfUrl(entry.sourceUrl),
    extractor: entry.extractor,
    sourceUrl: entry.sourceUrl && audience.isAdultSite(entry.sourceUrl) ? entry.sourceUrl : null,
    requested: savedAdult ? 'adult' : null,
    prior: row ? row.audience : null,
    priorByHand: Boolean(row && row.classified_by_hand),
  };
  // A row whose creator was renamed is classified by both names, the way
  // the delivery gate does (Codex phase-0 B4).
  const renamed = entry.sourceCreator != null && entry.sourceCreator !== entry.creator ? String(entry.sourceCreator) : null;
  if (entry.audience === 'adult') input.requested = 'adult';
  const mk = memo ? JSON.stringify([input, renamed]) : null;
  if (memo && memo.has(mk)) return memo.get(mk);
  let c = audience.classify(input, store, { keyOf: creatorKeyCached, index: profileIndexOf(store) });
  if (renamed) {
    const other = audience.classify({ ...input, creatorKey: renamed, handle: renamed }, store, { keyOf: creatorKeyCached, index: profileIndexOf(store) });
    c = audience.stricter(c, other);
  }
  if (memo) memo.set(mk, c);
  return c;
}
function mediaAudience(entry, store) {
  const c = entryClassification(entry, store);
  // The creator's profile, for the "open profile" link, whatever its status.
  let profileId = c.profileId;
  if (!profileId && store && entry.creator) {
    const m = audience.matchProfiles(store, {
      creatorKey: creatorKey(entry.creator).trim().toLowerCase(),
      handle: String(entry.creator).trim().toLowerCase(),
      platform: audience.platformOfSite(siteOfUrl(entry.sourceUrl)),
    }, creatorKey);
    if (m.length) profileId = m[0].profile.id;
  }
  return { audience: c.audience, reasons: c.reasons, profileId: profileId || null };
}
// creatorKey() is pure and classify() runs it over every profile name for each
// creator, so the gate's bulk paths reuse earlier answers.
const creatorKeyMemo = new Map();
function creatorKeyCached(name) {
  const k = String(name);
  let v = creatorKeyMemo.get(k);
  if (v === undefined) {
    if (creatorKeyMemo.size >= 50000) creatorKeyMemo.clear();
    v = creatorKey(name);
    creatorKeyMemo.set(k, v);
  }
  return v;
}
// One profile index per store object; a saved store is a new object.
const profileIndexes = new WeakMap();
function profileIndexOf(store) {
  if (!store || typeof store !== 'object') return null;
  let ix = profileIndexes.get(store);
  if (!ix) profileIndexes.set(store, (ix = audience.indexProfiles(store, creatorKeyCached)));
  return ix;
}
// H4 (audience gate on Grabbit's own surfaces): an entry that is 18+ or not
// classified general reaches a list, a count, a detail or a file only when the
// request asks for the 18+ view with `audience=adult`. Only the hub's 18+ view
// sends it. Everything else answers as if the entry did not exist.
function wantsAdultView(req) {
  return String((req && req.query && req.query.audience) || '') === 'adult';
}
function passesAudience(aud, adultView) {
  return adultView || aud === 'general';
}
// The downloaded registry with only the rows this view may count. A file name
// is general only when every row that names it is; a row without a file name
// is classified from its key alone.
function registryForView(registry, adultView, store) {
  if (adultView) return registry;
  const memo = new Map();
  const hostAdult = new Map();
  let items = null;
  try {
    items = ITEM_STORE ? ITEM_STORE.audienceIndex() : null;
  } catch {
    items = null;
  }
  const byName = new Map();
  const rows = Object.entries(registry || {});
  const audOf = (key, entry) => {
    const filename = entry && typeof entry.filename === 'string' ? entry.filename : null;
    const host = key.startsWith('id:') || key.startsWith('yt:') ? null : key.split('/')[0];
    let adultHost = host ? hostAdult.get(host) : false;
    if (adultHost === undefined) hostAdult.set(host, (adultHost = audience.isAdultSite(`https://${host}/`)));
    return entryClassification({
      filename,
      channel: entry && entry.channel,
      creator: hub.creatorOf(filename),
      site: hub.siteOf(key),
      sourceUrl: adultHost ? urlFromKey(key) : null,
      itemKey: key,
    }, store, memo, items).audience;
  };
  const verdict = new Map();
  for (const [key, entry] of rows) {
    const a = audOf(key, entry);
    verdict.set(key, a);
    const name = entry && entry.filename;
    if (name && a !== 'general') byName.set(name, false);
    else if (name && !byName.has(name)) byName.set(name, true);
  }
  const out = {};
  for (const [key, entry] of rows) {
    const name = entry && entry.filename;
    if (name ? byName.get(name) : verdict.get(key) === 'general') out[key] = entry;
  }
  return out;
}
function readProfileStoreQuietly() {
  try {
    return readProfiles().store;
  } catch {
    return null;
  }
}
function mediaListItem(e, store) {
  const a = mediaAudience(e, store);
  return {
    id: e.id,
    time: e.time || null,
    kind: mediaViewer.kindOfName(e.filename),
    creator: e.creator || null,
    title: e.title || null,
    filename: e.filename,
    channel: e.channel || null,
    place: mediaPlace(e.channel),
    site: siteOfUrl(e.sourceUrl),
    sourceUrl: /^https?:\/\//i.test(e.sourceUrl || '') ? e.sourceUrl : null,
    thumbnail: e.thumbnail || null,
    audience: a.audience,
    profileId: a.profileId,
  };
}
// ffprobe results by path + size + mtime; a replaced file probes again.
const probeCache = new Map();
function probeMedia(file, st) {
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (probeCache.has(key)) return Promise.resolve(probeCache.get(key));
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height', '--', file];
    const p = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const r = code === 0 ? mediaViewer.parseProbe(out) : null;
      if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value);
      probeCache.set(key, r);
      resolve(r);
    });
  });
}

// GET /api/hub/media -> the history entries that name a file, newest first,
// with the audience each one has under the gate's rules.
// Also `misses`: the newest entries without a file (those newer than the
// newest entry with one, out of the last ten), each with where its item stands
// now. The history line keeps the error of the moment it failed; a later hand
// classification only shows up here.
app.get('/api/hub/media', (req, res) => {
  const store = readProfileStoreQuietly();
  const adultView = wantsAdultView(req);
  const history = readHistory();
  const items = history
    .filter((e) => mediaViewer.isPlainName(e.filename))
    .map((e) => mediaListItem(e, store))
    .filter((it) => passesAudience(it.audience, adultView));
  const recent = history.slice(0, 10);
  const lastFile = recent.findIndex((e) => e.filename);
  const misses = (lastFile === -1 ? recent : recent.slice(0, lastFile))
    .filter((e) => !e.filename)
    .filter((e) => passesAudience(entryClassification(e, store).audience, adultView))
    .map((e) => ({
      id: e.id,
      time: e.time || null,
      creator: e.creator || null,
      title: e.title || null,
      sourceUrl: /^https?:\/\//i.test(e.sourceUrl || '') ? e.sourceUrl : null,
      error: e.error || null,
      ...missStatus(e),
    }));
  res.json({ ok: true, items, misses });
});

// Where the item behind a no-file history entry stands now. `resend` is true
// only when a general app refused it and the item has since been classified
// general by hand: the one case a plain second attempt can now get through.
// Anything else (still unclassified, 18+, a failed download) is not offered.
function missStatus(e) {
  const none = { itemAudience: null, destination: null, app: null, resend: false };
  if (!ITEM_STORE || !e || e.filename || !e.sourceUrl) return none;
  let item;
  let last;
  try {
    item = ITEM_STORE.getBySourceUrl(e.sourceUrl);
    last = item ? ITEM_STORE.deliveries(item.id).slice(-1)[0] || null : null;
  } catch {
    return none;
  }
  if (!item) return none;
  const app = last ? audience.DESTINATIONS[last.destination] : null;
  return {
    itemAudience: item.audience,
    destination: last ? last.destination : null,
    app: app ? app.app : null,
    resend: !!(app && app.audience === 'general' && last.status === 'refused' && item.audience === 'general'),
  };
}

// POST /api/hub/media/:id/resend -> download a refused entry again, to the
// general app that refused it, once its item is classified general. The job
// list lives in memory, so after a restart this is the only way back to a
// refused download; the gate checks the new job like any other.
app.post('/api/hub/media/:id/resend', (req, res) => {
  const id = String(req.params.id || '');
  const e = MEDIA_ID_RE.test(id) ? readHistory().find((x) => x.id === id) : null;
  if (!e) return res.status(404).json({ ok: false, error: 'No such history entry' });
  const st = missStatus(e);
  if (!st.resend) {
    const why = e.filename
      ? 'This entry already has a file'
      : st.itemAudience !== 'general'
        ? 'Classify the item as general on the Review page first'
        : 'Only a download a general app refused can be sent again from here';
    return res.status(409).json({ ok: false, error: why });
  }
  const query = { url: e.sourceUrl, dest: 'elite', channel: st.destination === 'platform' ? 'platform' : 'main', device: '0' };
  const out = startJobFromQuery(query, req.principal || gda.LEGACY_SHARED, 'legacy');
  if (out.gdaError) return res.status(out.gdaError.status).json({ ok: false, error: out.gdaError.message });
  if (out.status === 200) console.log(`hub: resend of history ${e.id} to ${st.destination} queued as job ${out.body.jobId}`);
  res.status(out.status).json(out.body);
  if (out.run) out.run();
});

// GET /api/hub/media/:id -> one entry with its files on disk and their metadata.
app.get('/api/hub/media/:id', async (req, res) => {
  const e = mediaEntry(req.params.id);
  if (!e) return res.status(404).json({ ok: false, error: 'No such media entry' });
  const store = readProfileStoreQuietly();
  const item = mediaListItem(e, store);
  const a = mediaAudience(e, store);
  if (!passesAudience(a.audience, wantsAdultView(req))) return res.status(404).json({ ok: false, error: 'No such media entry' });
  const found = mediaViewer.findVariants(e.filename, mediaDirsOf(e), MEDIA_ROOTS);
  const variants = [];
  for (const v of ['original', 'web']) {
    const file = found && found[v];
    if (!file) continue;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const kind = mediaViewer.kindOfName(file);
    const ext = mediaViewer.extOf(file);
    const probe = kind === 'video' || kind === 'image' ? await probeMedia(file, st) : null;
    variants.push({
      variant: v,
      name: path.basename(file),
      kind,
      format: ext,
      bytes: st.size,
      modified: st.mtimeMs,
      ...(probe || {}),
      playable: mediaViewer.playability(kind, ext, probe),
    });
  }
  res.json({
    ok: true,
    item: {
      ...item,
      extractor: e.extractor || null,
      description: e.description || null,
      reasons: a.reasons,
      available: variants.length > 0,
      variants,
      poster: Boolean(found && found.poster),
      error: e.error || null,
    },
  });
});

// GET /api/hub/media/:id/file?v=original|web|poster[&download=1] -> the file,
// with Range support so a video can seek before it has fully arrived.
app.get('/api/hub/media/:id/file', (req, res) => {
  const e = mediaEntry(req.params.id);
  const v = String(req.query.v || 'original');
  if (!e || !mediaViewer.VARIANTS.includes(v)) return res.status(404).json({ ok: false, error: 'Not available' });
  const fileAudience = entryClassification(e, readProfileStoreQuietly()).audience;
  if (!passesAudience(fileAudience, wantsAdultView(req))) return res.status(404).json({ ok: false, error: 'Not available' });
  const found = mediaViewer.findVariants(e.filename, mediaDirsOf(e), MEDIA_ROOTS);
  const file = found && found[v];
  // Media only: a name the history log got from a site could end in .html or
  // .svg, and that must never render as a page on this origin.
  const kind = mediaViewer.kindOfName(file);
  if (!file || !['video', 'image', 'audio'].includes(kind) || (v === 'poster' && kind !== 'image')) {
    return res.status(404).json({ ok: false, error: 'Not available' });
  }
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  if (req.query.download === '1') res.setHeader('Content-Disposition', contentDisposition(path.basename(file)));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // H98: a general file is revalidated on every use (ETag), so an entry
  // reclassified 18+ stops at the gate above at once; an 18+ file is never
  // stored. The hub's URLs carry `gen=2`, so nothing cached under the old
  // `max-age=3600` rule is asked for again.
  const cacheControl = fileAudience === 'general' ? 'private, no-cache' : 'private, no-store';
  res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': cacheControl } }, (err) => {
    if (err && !res.headersSent) res.status(err.status === 416 ? 416 : 404).end();
  });
});

// --- Adshortis library player ------------------------------------------------
// ADSHORTIS_LIBRARY: the 18+ app's own media folder (`<creator>/<clip>.web.mp4`
// plus a `.jpg` poster), mounted read-only. Opt-in: unset, the hub has no
// Adshortis page and these routes answer 404. Grabbit only reads here; the app
// owns the folder. See adshortis-library.js for what is listed and served.
const ADS_LIBRARY = process.env.ADSHORTIS_LIBRARY ? adshortisLibrary.createLibrary(process.env.ADSHORTIS_LIBRARY) : null;
// Grabbit 3.0 retires the folder page (D3, H1, H19): it serves files by folder
// path and bypasses Adshortis' own visibility rules. It is mounted only when
// ADSHORTIS_FOLDER_PAGE=1 is set AND the effective Adshortis mode is off or
// embed; in native mode it is never mounted, whatever the flag says.
const ADS_FOLDER_FLAG = process.env.ADSHORTIS_FOLDER_PAGE === '1';
const ADS_FOLDER_PAGE = ADS_FOLDER_FLAG && ADSHORTIS_MODE !== 'native' && !!ADS_LIBRARY;
if (ADS_FOLDER_FLAG && ADSHORTIS_MODE === 'native') {
  console.warn('[grabbit] ADSHORTIS_FOLDER_PAGE=1 is ignored in native Adshortis mode; the folder page stays off.');
}
// (In native mode the retired folder routes answer before the auth gate; see
// "Retired in native mode" above the gate.)

// GET /api/hub/adshortis -> every clip, newest first. The page filters and
// shuffles in the browser, so this is one compact list.
if (ADS_FOLDER_PAGE) app.get('/api/hub/adshortis', (req, res) => {
  if (!ADS_LIBRARY) return res.status(404).json({ ok: false, error: 'The Adshortis library is not configured' });
  const items = ADS_LIBRARY.list({ fresh: req.query.fresh === '1' }).map((i) => ({
    id: i.id,
    creator: i.creator,
    title: i.title,
    poster: !!i.poster,
    bytes: i.bytes,
    mtime: i.mtime,
  }));
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ ok: true, total: items.length, items });
});

// GET /api/hub/adshortis/file?id=<folder>/<file>&v=video|poster[&download=1]
// -> the clip or its poster, with Range support for seeking. private, no-store
// (H46): nothing from the folder page outlives a mode change in a browser cache.
if (ADS_FOLDER_PAGE) app.get('/api/hub/adshortis/file', (req, res) => {
  const v = req.query.v === 'poster' ? 'poster' : req.query.v === 'video' || !req.query.v ? 'video' : null;
  const file = ADS_LIBRARY && v ? ADS_LIBRARY.resolve(String(req.query.id || ''), v) : null;
  if (!file) return res.status(404).json({ ok: false, error: 'Not available' });
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  if (req.query.download === '1') res.setHeader('Content-Disposition', contentDisposition(path.basename(file)));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, no-store' } }, (err) => {
    if (err && !res.headersSent) res.status(err.status === 416 ? 416 : 404).end();
  });
});

// --- Adflix film library -----------------------------------------------------
// ADFLIX_LIBRARY: an 18+ film library (`<section>/<studio>/...` with .nfo
// metadata and posters), mounted read-only. Opt-in: unset, the hub has no
// Adflix page and these routes answer 404. See adflix-library.js.
const ADFLIX_LIBRARY = process.env.ADFLIX_LIBRARY ? adflixLibrary.createLibrary(process.env.ADFLIX_LIBRARY) : null;

// GET /api/hub/adflix -> every film with its metadata, newest first.
app.get('/api/hub/adflix', (req, res) => {
  if (!ADFLIX_LIBRARY) return res.status(404).json({ ok: false, error: 'The Adflix library is not configured' });
  const items = ADFLIX_LIBRARY.list({ fresh: req.query.fresh === '1' }).map((i) => ({
    id: i.id,
    studio: i.studio,
    title: i.title,
    year: i.year,
    date: i.date,
    plot: i.plot,
    runtime: i.runtime,
    genres: i.genres,
    actors: i.actors,
    poster: !!i.poster,
    thumb: !!i.thumb,
    bytes: i.bytes,
    mtime: i.mtime,
  }));
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ ok: true, total: items.length, items });
});

// GET /api/hub/adflix/file?id=<film id>&v=video|poster|thumb[&download=1]
// -> the film, its poster or its grid frame, with Range support for seeking.
app.get('/api/hub/adflix/file', (req, res) => {
  const v = req.query.v === undefined ? 'video' : ['video', 'poster', 'thumb'].includes(req.query.v) ? req.query.v : null;
  const file = ADFLIX_LIBRARY && v ? ADFLIX_LIBRARY.resolve(String(req.query.id || ''), v) : null;
  if (!file) return res.status(404).json({ ok: false, error: 'Not available' });
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  if (req.query.download === '1') res.setHeader('Content-Disposition', contentDisposition(path.basename(file)));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, max-age=3600' } }, (err) => {
    if (err && !res.headersSent) res.status(err.status === 416 ? 416 : 404).end();
  });
});

app.get('/api/folders', (_req, res) => {
  res.json({ ok: true, folders: listServerFolders() });
});

// --- Cookies ----------------------------------------------------------------
// Netscape cookies.txt files for logged-in/private content. One default file
// plus optional per-domain files; every yt-dlp invocation picks the matching
// one automatically (see cookies.js).

// GET /api/cookies -> stored cookie files.
app.get('/api/cookies', (_req, res) => res.json({ ok: true, cookies: listCookieFiles() }));

// POST /api/cookies/save?name=<domain|default>  (body = raw cookies.txt text)
app.post('/api/cookies/save', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) return res.status(400).json({ ok: false, error: 'Empty cookie file' });
  const name = sanitizeCookieName(req.query.name);
  try {
    saveCookieFile(name, text);
    res.json({ ok: true, name, cookies: listCookieFiles() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /api/cookies/delete?name=...
app.post('/api/cookies/delete', (req, res) => {
  try {
    deleteCookieFile(sanitizeCookieName(req.query.name));
    res.json({ ok: true, cookies: listCookieFiles() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// --- yt-dlp argument templates ----------------------------------------------
// Named sets of extra yt-dlp flags the sheet's template picker offers.
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
function readTemplates() {
  const list = readJsonState(TEMPLATES_FILE, []);
  return Array.isArray(list) ? list : [];
}

// GET /api/templates -> saved extra-args templates.
app.get('/api/templates', (_req, res) => res.json({ ok: true, templates: readTemplates() }));

// POST /api/templates/save?name=...&args=...  (same name overwrites)
app.post('/api/templates/save', (req, res) => {
  const name = String(req.query.name || '').trim().slice(0, 60);
  const args = String(req.query.args || '').trim().slice(0, 500);
  if (!name || !args) return res.status(400).json({ ok: false, error: 'Missing name or args' });
  try {
    parseExtraArgs(args); // validate (throws on blocked/broken flags)
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
  const list = readTemplates();
  const existing = list.find((t) => t.name === name);
  if (existing) existing.args = args;
  else list.push({ id: `${Date.now()}`, name, args });
  writeJsonAtomic(TEMPLATES_FILE, list);
  res.json({ ok: true, templates: list });
});

// POST /api/templates/delete?id=...
app.post('/api/templates/delete', (req, res) => {
  const list = readTemplates().filter((t) => t.id !== String(req.query.id));
  writeJsonAtomic(TEMPLATES_FILE, list);
  res.json({ ok: true, templates: list });
});

// --- Search -----------------------------------------------------------------
// GET /api/search?q=... -> video search results via yt-dlp's ytsearch, so the
// UI accepts plain words instead of a URL.
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
  const n = Math.min(24, Math.max(1, parseInt(req.query.n, 10) || 12));
  const p = spawn(YTDLP, ['--flat-playlist', '-J', '--no-warnings', '--', `ytsearch${n}:${q}`]);
  let out = '';
  let err = '';
  let sent = false;
  const fail = (msg) => {
    if (!sent) {
      sent = true;
      res.status(502).json({ ok: false, error: msg });
    }
  };
  const timer = setTimeout(() => {
    p.kill('SIGKILL');
    fail('Search timed out');
  }, 30000);
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (e) => {
    clearTimeout(timer);
    fail(String(e.message || e));
  });
  p.on('close', () => {
    clearTimeout(timer);
    if (sent) return;
    try {
      const data = JSON.parse(out);
      const results = (data.entries || []).filter(Boolean).map((e) => ({
        id: e.id || null,
        title: e.title || e.id || 'video',
        url: e.url || e.webpage_url || null,
        duration: Number.isFinite(e.duration) ? e.duration : null,
        channel: e.channel || e.uploader || null,
        views: Number.isFinite(e.view_count) ? e.view_count : null,
        thumbnail:
          (Array.isArray(e.thumbnails) && e.thumbnails.length
            ? e.thumbnails[e.thumbnails.length - 1].url
            : null) || (e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : null),
      })).filter((r) => r.url);
      sent = true;
      const previewAud = wantsAdultView(req) ? 'adult' : 'general';
      for (const r of results) noteThumb(r.thumbnail, { kind: 'preview', aud: previewAud });
      res.json({ ok: true, results });
    } catch {
      fail(err.trim().split('\n').pop() || 'Search failed');
    }
  });
});

// Genres the user has typed at least once. The library's own genres (read off
// the music log) already make a decent vocabulary, but a genre only becomes
// visible there once a track carrying it has been saved — this file remembers
// the moment it was entered, so the picker can offer it right away.
const GENRES_FILE = path.join(DATA_DIR, 'genres.json');
let typedGenresCache = null;

function readTypedGenres() {
  if (!typedGenresCache) {
    const list = readJsonState(GENRES_FILE, []);
    typedGenresCache = Array.isArray(list) ? list.filter((g) => typeof g === 'string') : [];
  }
  return typedGenresCache;
}

function rememberGenres(genres) {
  const list = readTypedGenres();
  let added = false;
  for (const g of genres || []) {
    const name = String(g).trim();
    if (!name || list.some((x) => x.toLowerCase() === name.toLowerCase())) continue;
    list.push(name);
    added = true;
  }
  if (!added) return;
  try {
    writeJsonAtomic(GENRES_FILE, list);
  } catch (e) {
    console.warn('genre list write failed:', e.message);
  }
}

// Every genre Grabbit knows about: those in the music library (with how many
// tracks carry them) plus the ones typed but not yet saved to a track.
function knownGenres() {
  const counts = new Map();
  const label = new Map();
  for (const t of readMusic()) {
    for (const g of t.genres || []) {
      const name = String(g).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!label.has(key)) label.set(key, name);
    }
  }
  for (const name of readTypedGenres()) {
    const key = name.toLowerCase();
    if (!counts.has(key)) {
      counts.set(key, 0);
      label.set(key, name);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ name: label.get(key), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Song metadata candidates from public music databases (iTunes Search and
// Deezer over keyless HTTP, SoundCloud through yt-dlp). Candidates:
// {source, title, artists[], album, date, genres[], cover}. Used by the
// /api/music-meta endpoint (UI auto-fill) and by the download-time genre
// auto-fill.
async function musicApiFetch(u) {
  // accept-language pins Deezer's localized genre names to English.
  const r = await fetch(u, {
    headers: { 'user-agent': 'grabbit/1.0', 'accept-language': 'en' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

// One iTunes song row in the shape the picker and the matcher expect.
function itunesCandidate(r) {
  return {
    source: 'itunes',
    title: r.trackName || null,
    artists: splitArtists(r.artistName, knownArtist),
    album: r.collectionName || null,
    date: r.releaseDate ? String(r.releaseDate).slice(0, 10) : null,
    // Normalised at the source like the SoundCloud arm, so the three arms
    // agree about the same genre and iTunes' "Hip-Hop/Rap" cannot reach the
    // field, the tag and the library raw on the path that skips lookupGenres.
    genres: normalizeGenres(r.primaryGenreName ? [r.primaryGenreName] : []),
    cover: r.artworkUrl100 || null,
  };
}

/**
 * Every song iTunes files under an artist, found by name.
 *
 * Term search ranks by popularity, so a small artist's own track can be
 * missing from it while the artist's page carries it — searching "Giannotti
 * Eyes Dem Open" answers with JayBlem and Harry Styles, and never with the
 * GIANNOTTI MUSIC album track it is a misspelling of. Asking who the artist
 * is and reading their catalogue is the only way to see it.
 */
async function artistCatalogue(name) {
  const wanted = foldName(name);
  if (!wanted) return [];
  const found = await musicApiFetch(
    `https://itunes.apple.com/search?entity=musicArtist&limit=5&term=${encodeURIComponent(name)}`
  ).catch(() => null);
  const artist = (found && found.results ? found.results : []).find((a) => {
    const got = foldName(a.artistName);
    return got && (got === wanted || ` ${got} `.includes(` ${wanted} `) || ` ${wanted} `.includes(` ${got} `));
  });
  if (!artist) return [];
  const songs = await musicApiFetch(
    `https://itunes.apple.com/lookup?id=${artist.artistId}&entity=song&limit=200`
  ).catch(() => null);
  return (songs && songs.results ? songs.results : [])
    .filter((r) => r.wrapperType === 'track' && r.trackName)
    .map(itunesCandidate);
}

/**
 * How long the SoundCloud arm may cost.
 *
 * Two bounds, not one. SOUNDCLOUD_TIMEOUT_MS is what a SINGLE search may take
 * — a process start plus yt-dlp's own request, where the two HTTP arms get 8s
 * each. SOUNDCLOUD_BUDGET_MS is what a whole lookup may spend on SoundCloud,
 * however many searches it runs, and it exists because musicMetaLookup tries
 * up to three terms in series: with a per-search bound only, three hung
 * searches stacked into a measured 36.8s for one /api/music-meta call, and
 * the same call sits in front of every audio download that needs a genre.
 * 12s for the lot, because that is about as long as a person watches a
 * "Searching…" select before deciding the page is broken, and a search that
 * has not answered in 12s has already lost to iTunes and Deezer, which
 * answered in two. A hit costs ~1.8s and never comes near either bound.
 */
const SOUNDCLOUD_TIMEOUT_MS = 12000;
const SOUNDCLOUD_BUDGET_MS = 12000;

// Every search is a Python process, and this host has four cores that also
// run the download jobs — 12 parallel lookups spawned 15 yt-dlps at once.
// Searches queue instead: two at a time, and one still queued when its budget
// has run out never spawns at all.
const SOUNDCLOUD_MAX_PARALLEL = 2;
let scActive = 0;
const scWaiting = [];
function scAcquire() {
  if (scActive < SOUNDCLOUD_MAX_PARALLEL) {
    scActive++;
    return Promise.resolve();
  }
  return new Promise((r) => scWaiting.push(r));
}
function scRelease() {
  // The slot is handed straight to the next waiter rather than counted down
  // and up again, so a burst cannot slip past the cap between two ticks.
  const next = scWaiting.shift();
  if (next) next();
  else scActive--;
}

// Answers by search term, for the few minutes one track's worth of clicking
// takes. The same term genuinely recurs: a lookup asks up to three of them
// and the next lookup for the same track asks the same three, the "Search
// again" button re-asks them, and the download-time genre fill asks once
// more. Only a real answer is cached — a kill or a parse failure is a fact
// about this second, not about the term.
const SOUNDCLOUD_CACHE_TTL_MS = 5 * 60 * 1000;
const SOUNDCLOUD_CACHE_MAX = 120;
const scCache = new Map();      // `${count}:${term}` -> {at, rows}
const scInFlight = new Map();   // same key -> Promise, so two callers share one process

/**
 * One SoundCloud search row in the shape the picker and the matcher expect.
 *
 * Two surfaces, kept apart on purpose:
 *   artists[]     what may be WRITTEN. index.html's applyMusicCandidate joins
 *                 this into the artist field, the field is sent back on
 *                 download and splitList turns it into the file's artist tag
 *                 and the music log — so only real performers belong in it.
 *   matchNames[]  the act's other spellings, read ONLY by candidateMatch()'s
 *                 artist gate. A SoundCloud display name is as often as not
 *                 typeset in small capitals ("ɢɪᴀɴɴᴏᴛᴛɪ ᴍᴜꜱɪᴄ" is U+0262
 *                 U+026A U+1D00 …), and carrying that spelling is what lets a
 *                 row the artist uploaded himself satisfy the gate. Carrying
 *                 it in artists[] instead is what put "Giannotti, ɢɪᴀɴɴᴏᴛᴛɪ
 *                 ᴍᴜꜱɪᴄ" in a Navidrome file's artist tag: two artists, one
 *                 of whom does not exist. iTunes and Deezer rows have no
 *                 matchNames at all, and the gate is unchanged for them.
 *
 * parseTrackTitle answers for a title with no separator too, by falling back
 * on the uploader as the artist and stripping the channel prefix off the track
 * ("GNT247 Alone" -> Alone) — the same answer this function would have to
 * reach on its own, so the two cases need no telling apart.
 */
function soundcloudCandidate(e) {
  const uploader = String(e.uploader || '').trim();
  const raw = String(e.title || e.track || '').trim();
  // yt-dlp's own artists[] for the row. On a flat search row it is usually
  // nothing but the uploader's display name again, which is why it is not
  // trusted as a co-artist below.
  const credited = Array.isArray(e.artists) ? e.artists.map((a) => String(a || '').trim()).filter(Boolean) : [];
  let parsed = parseTrackTitle(raw, uploader);
  // Plenty of uploads lead with the SONG and credit the act after the dash
  // ("OUTTA CONTROL - AXEL ALATRISTE, DXSKO, ZORK", uploaded by Axel
  // Alatriste), which parseTrackTitle reads as an artist called OUTTA CONTROL
  // and a song called AXEL ALATRISTE, DXSKO, ZORK. Whichever side names the
  // uploader is the credit line, so the two are swapped when the RIGHT side
  // names them and the left does not. When neither side does there is no
  // evidence either way and nothing is swapped.
  if (parsed && parsed.artist && parsed.track) {
    const known = [uploader, ...credited].map(foldName).filter(Boolean);
    const names = (s) => {
      const f = foldName(s);
      return Boolean(f) && known.some((k) => ` ${f} `.includes(` ${k} `));
    };
    if (!names(parsed.artist) && names(parsed.track)) parsed = { artist: parsed.track, track: parsed.artist };
  }
  const title = (parsed && parsed.track) || raw || null;
  // The credit line, split the way iTunes splits its own
  // (splitArtists(r.artistName, knownArtist)) — without it "SoDown,
  // Oblivinatti, TwinnFlame" travels as ONE artist and comes back out of splitList as three anyway,
  // with SoDown in the tag twice.
  const artists = [];
  const addArtists = (s) => {
    for (const part of splitArtists(s, knownArtist)) {
      const f = foldName(part);
      // Folds to nothing: an account literally named "." is punctuation, not
      // an artist, and it was reaching the tag as one.
      if (!f || artists.some((a) => foldName(a) === f)) continue;
      // Written as the letters it is drawn as. On a row whose title has no
      // separator the uploader's display name IS the credit line, and that is
      // how small capitals reached the tag; matchNames below still carries
      // the name as the uploader typed it.
      artists.push(plainName(part));
    }
  };
  addArtists(parsed && parsed.artist);
  const uploaderFold = foldName(uploader);
  for (const name of credited) {
    // The uploader's own name again (yt-dlp fills artists[] with it when the
    // upload carries no metadata of its own) — a re-upload channel, not a
    // second performer.
    if (uploaderFold && foldName(name) === uploaderFold) continue;
    addArtists(name);
  }
  // Nothing but the uploader to go on: then the display name IS the credit
  // line. A row that still has no artist is dropped by the caller.
  if (!artists.length) addArtists(uploader);
  const matchNames = [];
  for (const name of [uploader, ...credited]) {
    const f = foldName(name);
    if (!f || artists.some((a) => foldName(a) === f) || matchNames.some((m) => foldName(m) === f)) continue;
    // Kept whole, unsplit: the gate asks whether one name holds the other as
    // whole words, so a full credit line answers for every name in it.
    matchNames.push(name);
  }
  // yt-dlp hands SoundCloud's upload date over as YYYYMMDD or, on a flat
  // search row, as nothing but the unix `timestamp` — itunesCandidate's
  // YYYY-MM-DD is what the rest of the pipeline reads.
  let date = null;
  const stamped = String(e.release_date || e.upload_date || '').trim();
  if (/^\d{8}$/.test(stamped)) date = `${stamped.slice(0, 4)}-${stamped.slice(4, 6)}-${stamped.slice(6, 8)}`;
  else if (/^\d{4}-\d{2}-\d{2}/.test(stamped)) date = stamped.slice(0, 10);
  else if (Number.isFinite(e.timestamp)) {
    // Number.isFinite does not bound the Date range: a timestamp of
    // 99999999999999 threw RangeError out of toISOString, and one just under
    // the limit returned an expanded-year string whose first ten characters
    // are "+010000-01". Same 1900..now+1 window the download path uses.
    const d = new Date(e.timestamp * 1000);
    const y = d.getUTCFullYear();
    if (Number.isFinite(y) && y >= 1900 && y <= new Date().getUTCFullYear() + 1) date = d.toISOString().slice(0, 10);
  }
  const thumbs = Array.isArray(e.thumbnails) ? e.thumbnails : [];
  // SoundCloud serves one artwork at a ladder of fixed names. t500x500 before
  // original, because "original" is whatever the uploader dragged in — a 3000
  // pixel JPEG, or a banner that is not square at all.
  const pick =
    thumbs.find((t) => t && t.id === 't500x500') ||
    thumbs.find((t) => t && t.id === 'original') ||
    thumbs[thumbs.length - 1] ||
    null;
  return {
    source: 'soundcloud',
    title,
    artists,
    matchNames,
    // A flat search row never carries an album, and the field is coerced like
    // every other one because a row is JSON from the internet: an object here
    // rendered as " · [object Object]" in the picker.
    album: typeof e.album === 'string' ? e.album.trim() || null : null,
    date,
    // SoundCloud's genre is free text the uploader typed, where iTunes and
    // Deezer hand out controlled vocabularies. It is normalised HERE, at the
    // source, and not in lookupGenres: the picker writes this string straight
    // into the genre field and the download sends that field on to the tag, so
    // a raw "Hip Hop" never passes lookupGenres at all and would file itself
    // beside the "Hip-Hop" GENRE_VOCABULARY already calls canonical.
    genres: normalizeGenres((Array.isArray(e.genres) ? e.genres : []).map((g) => String(g || '').trim()).filter(Boolean)),
    cover: (pick && pick.url) || e.thumbnail || null,
  };
}

// One scsearch, start to finish: the semaphore slot, the subprocess, and the
// rows. Resolves {rows, cacheable} — cacheable false whenever the emptiness
// is this second's fault (killed, crashed, no binary) rather than the term's.
function scSearch(term, count, deadline) {
  return scAcquire().then(
    () =>
      new Promise((resolve) => {
        // What is left of the lookup's whole SoundCloud budget, never more
        // than one search's share of it. Queued time counts against it.
        const budget = deadline ? Math.min(SOUNDCLOUD_TIMEOUT_MS, deadline - Date.now()) : SOUNDCLOUD_TIMEOUT_MS;
        if (budget <= 0) {
          // An earlier search already spent the budget. Starting one now only
          // buys the caller a wait for an answer it has no time to use.
          scRelease();
          resolve({ rows: [], cacheable: false });
          return;
        }
        let p;
        try {
          p = spawn(YTDLP, ['--flat-playlist', '-J', '--no-warnings', '--', `scsearch${count}:${term}`]);
        } catch {
          // spawn only throws synchronously on a malformed argument list, and
          // every argument here is a literal. A MISSING yt-dlp does not come
          // through here at all — it arrives on the error event below.
          scRelease();
          resolve({ rows: [], cacheable: false });
          return;
        }
        let out = '';
        let done = false;
        let timer = null;
        const finish = (rows, cacheable) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          scRelease();
          resolve({ rows, cacheable });
        };
        timer = setTimeout(() => {
          p.kill('SIGKILL');
          finish([], false);
        }, budget);
        // Without an encoding every chunk is stringified on its own, and a
        // character split across the boundary becomes U+FFFD. This arm is the
        // one that cannot afford it: the names it exists to read are three
        // bytes per letter, and a corrupted one folds wrong and fails the
        // artist gate silently.
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d) => (out += d));
        // Drained and thrown away: an unread stderr pipe is what makes a chatty
        // child stop rather than exit.
        p.stderr.on('data', () => {});
        p.on('error', () => finish([], false));   // no yt-dlp binary on PATH
        p.on('close', () => {
          let data;
          try {
            // A non-zero exit, a kill mid-write and "no results" all land here
            // as something that is not a JSON document, and all mean the same
            // thing.
            data = JSON.parse(out);
          } catch {
            finish([], false);
            return;
          }
          const rows = [];
          for (const entry of (data && data.entries) || []) {
            if (!entry) continue;
            // Per row, because one row used to take the others with it: a
            // nonsense timestamp threw out of .map() and the catch below
            // returned [] for the whole search.
            try {
              const c = soundcloudCandidate(entry);
              if (c.title && c.artists.length) rows.push(c);
            } catch {
              // One unusable row is not an unusable search.
            }
          }
          finish(rows, true);
        });
      })
  );
}

/**
 * SoundCloud search results, by way of yt-dlp's scsearch.
 *
 * The third catalogue earns its place on the tracks the first two have never
 * heard of: iTunes answers "Giannotti Eyes Dem Open" with JayBlem and Harry
 * Styles, because the song was never released to a label — the artist put it
 * on SoundCloud himself and tagged it Drum & Bass. That is also the only
 * place the genre exists to be read.
 *
 * yt-dlp is the client on purpose: keeping a working client_id for
 * api-v2.soundcloud.com is a problem it already solves and re-solves.
 *
 * --flat-playlist is enough because a SEARCH row is rich — title, uploader,
 * genres, timestamp and the whole thumbnail ladder come back in the one JSON
 * document, so a hit costs one subprocess and never one resolve per result.
 *
 * `deadline` is an absolute Date.now() the WHOLE lookup shares, so three
 * attempts cost one budget between them rather than one each.
 *
 * Never rejects. It runs beside two fetches in a Promise.allSettled, and an
 * install with no yt-dlp on PATH must lose the SoundCloud arm, not the lookup.
 */
async function soundcloudCandidates(q, n = 4, deadline = 0) {
  const term = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const count = Math.min(10, Math.max(1, parseInt(n, 10) || 4));
  if (!term) return [];
  const key = `${count}:${term}`;
  const hit = scCache.get(key);
  if (hit && Date.now() - hit.at < SOUNDCLOUD_CACHE_TTL_MS) return hit.rows.slice();
  if (hit) scCache.delete(key);
  // Already running: wait on that one instead of spawning a second copy of
  // the same question — the three attempts of two parallel lookups for the
  // same track overlap exactly here.
  const flying = scInFlight.get(key);
  if (flying) return (await flying).slice();
  const run = scSearch(term, count, deadline).then(
    (res) => {
      scInFlight.delete(key);
      if (res.cacheable) {
        scCache.set(key, { at: Date.now(), rows: res.rows });
        // A Map iterates in insertion order, so the oldest entry is first.
        while (scCache.size > SOUNDCLOUD_CACHE_MAX) scCache.delete(scCache.keys().next().value);
      }
      return res.rows;
    },
    () => {
      scInFlight.delete(key);
      return [];
    }
  );
  scInFlight.set(key, run);
  return (await run).slice();
}

/**
 * The identity of a candidate row, for dropping the same song twice.
 *
 * The ARTIST is folded, because that is where the sources disagree:
 * SoundCloud's "ɢɪᴀɴɴᴏᴛᴛɪ ᴍᴜꜱɪᴄ" and iTunes' "GIANNOTTI MUSIC" are one act,
 * and only the first name counts because a song credited to three artists on
 * one site is credited to one on the next. The TITLE is only lowercased and
 * stripped of punctuation, never folded — foldName drops "(AG Remix)", and a
 * remix is a different song the picker must still be able to offer.
 */
function candidateKey(c) {
  // The first piece of the first artist, so a row that keeps a band whole
  // ("Simon & Garfunkel", Deezer) still dedupes against one that split it.
  const artist = foldName(splitArtists(((c && c.artists) || [])[0] || '')[0] || '');
  const title = String((c && c.title) || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return `${artist}|${title}`;
}

/**
 * The same song, arrived twice: keep the first row, but not at the cost of
 * what only the second one knew.
 *
 * Dropping a duplicate SoundCloud row also drops its matchNames, and those
 * are one of two places a re-upload channel's name is written down — a lookup
 * for artist=HEYZ title="Ocean Eyes" is answered by a row credited to Billie
 * Eilish precisely because the SoundCloud row knew HEYZ uploaded it. Merging
 * them onto the surviving row keeps the better metadata AND the match.
 *
 * The dropped row's artists[] carries the same weight and was not read at
 * all: the first row for a key is as often as not the one credited to the
 * bare account handle, so "The Neighbourhood" was thrown away and the row it
 * lost fell from a full match to a partial one. Both lists land in
 * matchNames — this is the match surface. The kept row's own credit line is
 * what may be written into a tag, and that is left exactly as it was.
 *
 * Returns a NEW row, never a mutated one: candidate objects are shared with
 * the search cache and with whatever the last lookup handed the picker.
 */
function mergeMatchNames(kept, extra) {
  const add = [];
  for (const name of [...((extra && extra.matchNames) || []), ...((extra && extra.artists) || [])]) {
    const f = foldName(name);
    if (!f) continue;
    const known = [...(kept.artists || []), ...(kept.matchNames || []), ...add];
    if (known.some((k) => foldName(k) === f)) continue;
    add.push(name);
  }
  if (!add.length) return null;
  return { ...kept, matchNames: [...(kept.matchNames || []), ...add] };
}

async function musicMetaCandidates(q, deadline = 0) {
  const out = [];
  const deezerEntities = [];
  const seen = new Map();   // candidateKey -> index in out
  const push = (c) => {
    if (!c.title || !c.artists.length) return;
    const key = candidateKey(c);
    const at = seen.get(key);
    if (at !== undefined) {
      const merged = mergeMatchNames(out[at], c);
      if (merged) out[at] = merged;
      return;
    }
    seen.set(key, out.length);
    out.push(c);
  };
  const jfetch = musicApiFetch;
  // All three lookups run in parallel; any one failing alone is fine.
  const [itunes, deezer, soundcloud] = await Promise.allSettled([
    jfetch(`https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(q)}`),
    jfetch(`https://api.deezer.com/search?limit=4&q=${encodeURIComponent(q)}`),
    soundcloudCandidates(q, 4, deadline),
  ]);
  if (itunes.status === 'fulfilled') {
    for (const r of itunes.value.results || []) push(itunesCandidate(r));
  }
  if (deezer.status === 'fulfilled') {
    const rows = deezer.value.data || [];
    // Deezer's search rows lack date/genres; the album lookup has both.
    const albums = await Promise.allSettled(
      rows.map((r) => (r.album && r.album.id ? jfetch(`https://api.deezer.com/album/${r.album.id}`) : Promise.reject(new Error('no album'))))
    );
    rows.forEach((r, i) => {
      const alb = albums[i].status === 'fulfilled' ? albums[i].value : null;
      addDeezerEntity(deezerEntities, { source: 'deezer', artists: [r.artist && r.artist.name].filter(Boolean) });
      push({
        source: 'deezer',
        title: r.title || null,
        // Deezer's artist object is one artist entity (featured artists are
        // contributors, not part of the name), so its name is never split.
        artists: r.artist && r.artist.name ? [r.artist.name] : [],
        album: (r.album && r.album.title) || null,
        date: (alb && alb.release_date) || null,
        genres: normalizeGenres(alb && alb.genres && Array.isArray(alb.genres.data) ? alb.genres.data.map((g) => g.name).filter(Boolean) : []),
        cover: (r.album && r.album.cover_medium) || null,
      });
    });
  }
  // Pushed LAST, deliberately. `push` keeps the FIRST row for a candidateKey,
  // and where two catalogues carry the same song the commercial row is the one
  // worth keeping: it has an album, a real release date and label artwork,
  // where SoundCloud has a re-upload's own spelling of each. That only works
  // because the key folds the artist and ignores punctuation — while the key
  // was the raw artists.join(',') it could not collide across sources at all,
  // and /api/music-meta?artist=SoDown&title=Supernova answered with nine rows
  // covering five songs. A remix keeps its own key, because the suffix is part
  // of the title and "Supernova (AG Remix)" is not "Supernova".
  if (soundcloud.status === 'fulfilled') {
    for (const c of soundcloud.value) push(c);
  }
  // 6 iTunes + 4 Deezer already fill the old cap of 10, so an arm pushed last
  // would be sliced away whole — including the one full match, on exactly the
  // queries SoundCloud was added to answer. The picker still sees 10: that cut
  // happens in musicMetaLookup, AFTER the rows are ranked by match, which is
  // the only place where dropping a candidate is a decision and not an
  // accident of arrival order.
  // Joined here, before musicMetaLookup sees the rows: `push` keeps only the
  // first row per candidateKey, so the Deezer row naming the band may already
  // have been merged into the iTunes row that split it.
  return out.slice(0, 14).map((c) =>
    c.source === 'deezer' ? c : { ...c, artists: joinEntityRuns(c.artists, deezerEntities, foldName) }
  );
}

/**
 * How well a database candidate answers what was asked for.
 *
 * 'full' means it is safe to write into the tags unasked; 'partial' means the
 * title lines up but nobody vouched for the artist, so it belongs in the picker
 * and nowhere else. Without this every lookup has to say yes to something —
 * searching "Giannotti Control" returns Giuseppe Giannotti's "Zero Control",
 * and auto-filling that is worse than leaving the fields empty.
 */
function candidateMatch(candidate, want) {
  const wantArtist = foldName(want.artist);
  const wantTitle = foldName(want.title);
  const cTitle = foldName(candidate.title);
  // artists[] is what may be written into a tag; matchNames[] is the extra
  // spellings the SoundCloud arm carries for this gate alone (the uploader's
  // small-capital display name, a whole credit line). iTunes and Deezer rows
  // have no matchNames, so the gate is exactly what it was for them.
  const cArtists = [...(candidate.artists || []), ...(candidate.matchNames || [])].map(foldName).filter(Boolean);
  // Whole words only: "control" sits inside "zero control" as a substring but
  // never as the same song.
  const holds = (a, b) => Boolean(a && b && ` ${a} `.includes(` ${b} `));
  const either = (a, b) => holds(a, b) || holds(b, a);

  // A full match needs the SAME title, not a title containing it — one extra
  // word is a different song ("Zero Control" vs "Control"). The version
  // suffix is already gone, so "(Radio Edit)" still counts as equal.
  const titleSame = Boolean(wantTitle) && cTitle === wantTitle;
  const titleNear = either(cTitle, wantTitle);
  // The credit line may name more artists than the catalogue does (a remix
  // credit) or fewer (a channel called "GIANNOTTI MUSIC"), so either side may
  // hold the other — but only as whole words, and only next to the same title.
  const artistOk =
    Boolean(wantArtist) &&
    (cArtists.some((a) => either(a, wantArtist)) ||
      // Channel-tagged uploads name the artist inside the title instead
      holds(cTitle, wantArtist) ||
      cArtists.some((a) => holds(wantTitle, a)));

  if (titleSame && artistOk) return 'full';
  // Same artist, one typo apart: the catalogue's spelling of the same song.
  if (artistOk && titleClose(cTitle, wantTitle)) return 'close';
  if (titleNear || (artistOk && !wantTitle)) return 'partial';
  return 'none';
}

const MATCH_RANK = { full: 0, close: 1, partial: 2, none: 3 };

/**
 * Look a song up in the music databases from the pieces we actually have.
 *
 * The searches are tried in order of how much they claim to know and stop at
 * the first FULL match, because a plain video title ("Giannotti – Control
 * (Electro / Jump Up Neurofunk | Official 2026)") returns nothing at all from
 * either database — the brackets and genre words are noise no catalogue
 * indexes. Everything found along the way is still returned, ranked, so the
 * picker can offer the near misses.
 */
async function musicMetaLookup({ artist, title, channel }) {
  const want = { artist: artist || channel || '', title: title || '' };
  const attempts = [];
  const add = (q) => {
    const term = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (term && !attempts.includes(term)) attempts.push(term);
  };
  add([artist, title].filter(Boolean).join(' '));
  // The channel is often the catalogue's artist name even when the title's
  // credit line is shorter ("Giannotti" vs "GIANNOTTI MUSIC").
  if (channel && channel !== artist) add([channel, title].filter(Boolean).join(' '));
  add(title);
  if (!attempts.length) add(artist || channel);

  const out = [];
  const seen = new Map();   // candidateKey -> index in out
  // Deezer artist names that read like a credit line (see joinEntityRuns),
  // for the iTunes catalogue rows, which no Deezer search came with.
  const entities = [];
  const take = (candidates, keepOnlyMatches) => {
    for (const c of candidates) {
      addDeezerEntity(entities, c);
      const key = candidateKey(c);
      const at = seen.get(key);
      if (at !== undefined) {
        // Already have this song, from another catalogue or another attempt.
        // Take the spellings it brought and read the verdict again — a row
        // that was 'none' under the name we asked with can become 'full'
        // once the duplicate hands over the uploader it was credited to.
        const merged = mergeMatchNames(out[at], c);
        if (merged) out[at] = { ...merged, match: candidateMatch(merged, want) };
        continue;
      }
      const match = candidateMatch(c, want);
      // A catalogue is 200 songs long — only the ones that answer the question
      // belong in a picker, or one artist would bury every other candidate.
      if (keepOnlyMatches && match !== 'full' && match !== 'close') continue;
      seen.set(key, out.length);
      out.push({ ...c, match });
    }
  };
  const settled = () => out.some((c) => c.match === 'full' || c.match === 'close');

  // ONE SoundCloud budget for the attempts between them. Each attempt used to
  // start its own 12s timer, so three hung searches cost 36s on a request a
  // person is watching; now the second and third attempt get what the first
  // one left, and none at all once it is spent.
  const soundcloudDeadline = Date.now() + SOUNDCLOUD_BUDGET_MS;
  for (const term of attempts) {
    take(await musicMetaCandidates(term, soundcloudDeadline));
    if (settled()) break;
  }
  // Still nothing: the search may simply not rank the artist's own track.
  // Read their catalogue and look for the title in there instead.
  if (!settled() && title) {
    for (const name of [channel, artist].filter(Boolean)) {
      take(await artistCatalogue(name).catch(() => []), true);
      if (settled()) break;
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i].source === 'deezer') continue;
    const joined = joinEntityRuns(out[i].artists, entities, foldName);
    if (joined.length !== out[i].artists.length) out[i] = { ...out[i], artists: joined };
  }
  out.sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match]);
  return out.slice(0, 10);
}

app.get('/api/music-meta', async (req, res) => {
  const str = (v) => String(v || '').trim().slice(0, 200);
  const channel = str(req.query.channel);
  let artist = str(req.query.artist);
  let title = str(req.query.title);
  const q = str(req.query.q);
  // Older callers (and the "search again" button) send one blob: read the
  // credit line out of it rather than handing the noise to the databases.
  if (!title && q) {
    const parsed = parseTrackTitle(q, channel);
    artist = artist || (parsed && parsed.artist) || '';
    title = (parsed && parsed.track) || q;
  }
  if (!artist && !title && !channel) return res.status(400).json({ ok: false, error: 'Missing q' });

  const candidates = await musicMetaLookup({ artist, title, channel });
  res.json({
    ok: true,
    candidates,
    // Safe to apply without asking; null when nothing vouched for the artist.
    // A 'close' row qualifies: same artist, same title bar a typo.
    best: candidates.find((c) => c.match === 'full' || c.match === 'close') || null,
    // What the video itself says, for when no database knows the track.
    tagGenres: genresFromTags(splitList(str(req.query.tags))),
  });
});

// The music library keeps every genre in English with one spelling: iTunes
// and Deezer disagree on names ("Hip-Hop/Rap" vs "Rap/Hip Hop"), Deezer
// sometimes localizes them (Swedish seen in the wild), and SoundCloud has a
// dropdown of its own that pairs genres up with an ampersand.
const GENRE_NORMALIZE = {
  'hårdrock': 'Hard Rock',
  'alternativmusik': 'Alternative',
  'internationell pop': 'Pop',
  'latinomusik': 'Latin',
  'klassisk': 'Classical',
  'filmmusik': 'Soundtrack',
  'film/videospel': 'Soundtrack',
  'rock och roll/rockabilly': 'Rockabilly',
  'dancehall/ragga': 'Dancehall',
  'modern dancehall': 'Dancehall',
  'hip-hop/rap': 'Hip-Hop',
  'rap/hip hop': 'Hip-Hop',
  // Seen live on a SoundCloud row (Nujabes / Feather), a third arrangement of
  // the same three words.
  'hip hop/rap': 'Hip-Hop',
  'hiphop': 'Hip-Hop',
  'rap': 'Hip-Hop',
  'indie rock': 'Indie Rock',
  'indie rock/rock pop': 'Indie Rock',
  'electronica': 'Electronic',
  // SoundCloud's own dropdown. Every one of these already exists in the
  // library under a shorter name, and an unmapped "Jazz & Blues" would file
  // itself BESIDE Jazz rather than in it. Only the halves the library already
  // spells — nothing new is invented here. 'Drum & Bass' is absent on purpose:
  // SoundCloud happens to spell it the way the library does.
  'hip-hop & rap': 'Hip-Hop',
  'r&b & soul': 'R&B',
  'jazz & blues': 'Jazz',
  'folk & singer-songwriter': 'Folk',
  'alternative rock': 'Alternative',
  // The umbrella SoundCloud files every four-to-the-floor upload under. EDM
  // over Dance because both are in the vocabulary and EDM is the one already
  // used as a tag.
  'dance & edm': 'EDM',
  // Not a Reggae variant however it reads — the library files it under Latin.
  'reggaeton': 'Latin',
  // Spellings the substring reading used to get right before it was taken out
  // for getting "Indie Pop" wrong. Named one by one, which is the difference:
  // each of these really is another way of writing a genre the library
  // already has, where "Glam Rock" is a genre of its own.
  'drum&bass': 'Drum & Bass',
  "jungle/drum'n'bass": 'Drum & Bass',
  'latin music': 'Latin',
  // Seen live on SoundCloud rows, where the genre is free text the uploader
  // typed. "Triphop", "chillbeats" and "TEXCORE" are left as typed on
  // purpose: a name nobody can map is better in the tag than a wrong guess.
  'lofi': 'Lo-Fi',
  'lo fi': 'Lo-Fi',
};

/**
 * Genre strings in the library's own spelling.
 *
 * Three readings, in order of how sure they are: the exact string a catalogue
 * is known to hand out (GENRE_NORMALIZE), the same genre under another
 * spelling (GENRE_VOCABULARY's alias, which is where "Hip Hop" -> "Hip-Hop"
 * is already written down), and failing both, the longest known genre sitting
 * inside a free-text one. That last one is only worth having because
 * SoundCloud's genre is a box the uploader types into: "Lofi Alernative Hip
 * Hop", typo included, is a real value this returned.
 *
 * What none of the three recognise is kept as typed rather than dropped.
 * SoundCloud is the only place a self-released track's genre exists at all,
 * and a rip filed under "Uptempo" beats a rip filed under nothing.
 */
function normalizeGenres(genres) {
  const out = [];
  for (const g of genres || []) {
    const raw = String(g).trim();
    if (!raw) continue;
    // An exact answer or the name as typed. A genre name is NOT read for the
    // longest known genre inside it here: "Indie Pop" is a genre in its own
    // right, not a way of writing Indie, and reading it that way rewrote
    // "R&B/Soul" to Soul, "Glam Rock" to Rock, "J-Pop" to Pop and "Baile
    // Funk" to Funk — filing a new rip BESIDE the tracks the library already
    // holds under those names, which is the failure the table exists to
    // prevent, in the other direction. Nothing tells "Glam Rock" from
    // "Modern Dancehall" by shape, so the collapsing ones are named in
    // GENRE_NORMALIZE by hand. Free text that really is a tag line is read
    // that way by genresFromTags, which is what it is for.
    const n = GENRE_NORMALIZE[raw.toLowerCase()] || GENRE_CANONICAL.get(genreFold(raw)) || raw;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// Genres nobody in the library has used yet, so a first neurofunk rip is not
// left genre-less waiting for a second one. Kept to real genre names — the
// library's own vocabulary supplies everything else.
// [what a tag may say, what the library calls it] — the second entry keeps a
// rip filed under the spelling already in use instead of a synonym beside it.
const GENRE_VOCABULARY = [
  ['Drum & Bass'], ['Drum and Bass', 'Drum & Bass'], ["Drum'n'Bass", 'Drum & Bass'],
  ['DnB', 'Drum & Bass'], ['D&B', 'Drum & Bass'], ['Neurofunk'], ['Jump Up'], ['Liquid DnB'],
  ['Jungle'], ['Breakbeat'], ['Dubstep'], ['Riddim'], ['Bass Music'], ['Future Bass'], ['Trap'],
  ['Garage'], ['UK Garage'], ['House'], ['Tech House'], ['Deep House'], ['Techno'], ['Trance'],
  ['Psytrance'], ['Hardstyle'], ['Hardcore'], ['Electro'], ['EDM'], ['Electronic'], ['Ambient'],
  ['Lo-Fi'], ['Synthwave'], ['Hip-Hop'], ['Hip Hop', 'Hip-Hop'], ['Rap', 'Hip-Hop'], ['R&B'],
  ['Soul'], ['Funk'], ['Disco'], ['Pop'], ['Rock'], ['Hard Rock'], ['Metal'], ['Punk'], ['Indie'],
  ['Alternative'], ['Jazz'], ['Blues'], ['Reggae'], ['Dancehall'], ['Ska'], ['Country'], ['Folk'],
  ['Classical'], ['Soundtrack'], ['Latin'], ['Afrobeats'], ['K-Pop'], ['Schlager'], ['Dansband'],
  ['Dance'],
];

// Genre names compared the way a listener reads them: case, punctuation and
// the ampersand in "Drum & Bass" are not what makes two spellings differ.
const genreFold = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Two views of the same table, built once because it is a constant and these
// are read per candidate row. GENRE_CANONICAL answers "what does the library
// call this?" for every name in the vocabulary; GENRE_ALIASES holds only the
// entries that RENAME something ("Hip Hop" -> "Hip-Hop"), which is what
// genresFromTags needs when it wants the library's own spelling to win.
const GENRE_CANONICAL = new Map();
const GENRE_ALIASES = new Map();
for (const [alias, label] of GENRE_VOCABULARY) {
  const key = genreFold(alias);
  if (!key) continue;
  if (!GENRE_CANONICAL.has(key)) GENRE_CANONICAL.set(key, label || alias);
  if (label && !GENRE_ALIASES.has(key)) GENRE_ALIASES.set(key, label);
}

/**
 * Genres read off the video's own tags.
 *
 * The last resort, and for a self-released track the only one: no catalogue
 * has it, but the uploader tagged it "jump up neurofunk", "drum and bass
 * 2026", "bass music". A tag counts only when a known genre sits inside it as
 * whole words, so "Giannotti Control" contributes nothing while
 * "electro bass music" gives Electro. The library's own spellings win, which
 * keeps a rip filed next to what is already there.
 */
function genresFromTags(tags) {
  if (!Array.isArray(tags) || !tags.length) return [];
  const fold = genreFold;
  const canonical = GENRE_ALIASES;
  const vocabulary = new Map();
  // The library's own genres first, so its spelling wins the key — except
  // where the library itself files a synonym ("dnb"), which resolves to the
  // full name or the same tag line yields both readings of one genre.
  for (const name of knownGenres().map((g) => g.name)) {
    const key = fold(name);
    if (key && !vocabulary.has(key)) vocabulary.set(key, canonical.get(key) || name);
  }
  for (const [alias, label] of GENRE_VOCABULARY) {
    const key = fold(alias);
    if (key && !vocabulary.has(key)) vocabulary.set(key, label || alias);
  }

  // One genre per tag — the longest reading of it, so "jump up neurofunk"
  // yields Neurofunk rather than both halves — kept in the order the uploader
  // wrote them, which is the only ranking the tags themselves carry.
  const out = [];
  for (const tag of tags) {
    const hay = ` ${fold(tag)} `;
    let best = null;
    for (const [key, name] of vocabulary) {
      // Whole words: "trap" must not be found inside "trapped".
      if (!hay.includes(` ${key} `)) continue;
      if (!best || key.length > best.key.length) best = { key, name };
    }
    if (!best) continue;
    // One reading of the same thing is enough: skip a genre already contained
    // in a broader one that was picked ("bass" under "Bass Music").
    if (out.some((g) => fold(g).includes(fold(best.name)) || fold(best.name).includes(fold(g)))) continue;
    out.push(best.name);
    if (out.length >= 3) break;
  }
  return out;
}

// Best-effort genre lookup for a track (used when neither the UI nor the
// source site provided one — which is the norm for YouTube, whose "genre" is
// a video category and deliberately dropped). Only a full artist+title match
// may set a genre; a title-only hit is a different song by someone else.
// Nothing in the databases falls back on the video's own tags.
async function lookupGenres(artist, title, tags) {
  const candidates = await musicMetaLookup({ artist, title });
  for (const c of candidates) {
    if ((c.match !== 'full' && c.match !== 'close') || !c.genres || !c.genres.length) continue;
    return normalizeGenres(c.genres).slice(0, 3);
  }
  return genresFromTags(tags);
}

// GET /api/playlists -> saved playlists (subscriptions for new-track checks).
app.get('/api/playlists', (_req, res) => res.json({ ok: true, playlists: playlistPayload(readPlaylists()) }));

// POST /api/playlists/save?url=...&name=... -> add (or rename) a saved playlist.
app.post('/api/playlists/save', (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const name = String(req.query.name || '').slice(0, 120) || url;
  // Which Navidrome library the watcher downloads this playlist into.
  const lib = parseNavLib(req.query.lib);
  const list = readPlaylists();
  const existing = list.find((p) => p.url === url);
  if (existing) {
    existing.name = name;
    if ('lib' in req.query) existing.lib = lib;
  } else list.push({ id: `${Date.now()}`, url, name, lib, addedAt: Date.now() });
  writePlaylists(list);
  res.json({ ok: true, playlists: playlistPayload(list) });
});

// ---------------------------------------------------------------------------
// Playlist watcher: saved playlists with watch=true are re-probed on an
// interval and any new tracks are queued to Navidrome automatically — the
// "Download new to Navidrome" button without having to open the playlist.
const WATCH_INTERVAL_MINUTES = Math.max(15, Number(process.env.WATCH_INTERVAL_MINUTES) || 360);
let watchCycleRunning = false;

// Queue one track as an audio job into Navidrome, same defaults as the UI's
// batch button (opus; the cover is embedded as album art by produceAudio).
function startNavidromeJob(url, navLib, watch = null) {
  const params = {
    url,
    dest: 'navidrome',
    navLib: parseNavLib(navLib),
    channel: 'main',
    device: false,
    web: false,
    quality: parseQuality(undefined),
    audio: true,
    afmt: 'opus',
    aq: parseAudioQuality(undefined),
    container: parseContainer(undefined),
    embedThumb: false,
    embedSubs: false,
    sponsorblock: null,
    sections: [],
    splitChapters: false,
    extraArgs: [],
    creatorOverride: null,
    titleOverride: null,
    tagsOverride: null,
    artists: null,
    album: null,
    release: 'album',
    date: null,
    genres: null,
  };
  const job = newJob({ dest: 'navidrome', channel: 'main', lib: params.navLib, device: false, watch });
  // Kept on the job so POST /api/jobs/:id/retry works for watcher jobs too.
  job.params = params;
  scheduleJob(job, params);
  return job;
}

function updatePlaylist(id, patch) {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === id);
  if (pl) {
    Object.assign(pl, patch);
    writePlaylists(list);
  }
}

// A watched track is only marked downloaded once it saves, so anything that
// fails looks new again on the next cycle and is re-queued — forever, for a
// video that has been deleted or is geo-blocked. Failures are counted per
// playlist and the track is dropped after MAX_WATCH_FAILURES attempts.
const MAX_WATCH_FAILURES = Math.max(1, Number(process.env.MAX_WATCH_FAILURES) || 3);

function watchFailureCount(pl, key) {
  return (pl && pl.failures && pl.failures[key]) || 0;
}

function recordWatchFailure(playlistId, key) {
  if (!playlistId || !key) return;
  const list = readPlaylists();
  const pl = list.find((p) => p.id === playlistId);
  if (!pl) return;
  const failures = { ...(pl.failures || {}) };
  failures[key] = (failures[key] || 0) + 1;
  pl.failures = failures;
  writePlaylists(list);
  if (failures[key] >= MAX_WATCH_FAILURES) {
    console.warn(`playlist watch: giving up on ${key} after ${failures[key]} failed attempt(s)`);
  }
}

// How many of this playlist's tracks the watcher has retired. Without it the
// cap is invisible: a track simply stops being offered, with nothing in the UI
// saying so or able to undo it.
function exhaustedCount(pl) {
  return Object.values((pl && pl.failures) || {}).filter((n) => n >= MAX_WATCH_FAILURES).length;
}

// Playlists as the API reports them: the stored row plus its derived counts.
function playlistPayload(list) {
  return list.map((p) => ({ ...p, exhausted: exhaustedCount(p) }));
}

// A track that eventually succeeds should not carry its earlier failures.
function clearWatchFailure(playlistId, key) {
  if (!playlistId || !key) return;
  const list = readPlaylists();
  const pl = list.find((p) => p.id === playlistId);
  if (!pl || !pl.failures || !(key in pl.failures)) return;
  const failures = { ...pl.failures };
  delete failures[key];
  pl.failures = failures;
  writePlaylists(list);
}

async function checkPlaylistForNew(pl) {
  const profile = await extractors.resolveProfile(pl.url);
  let exhausted = 0;
  const fresh = profile.items.filter((it) => {
    if (it.mediaType === 'image') return false;
    if (isDownloaded(it.sourceUrl || it.url, it.site, it.mediaId)) return false;
    if (watchFailureCount(pl, mediaKey(it.sourceUrl || it.url)) >= MAX_WATCH_FAILURES) {
      exhausted++;
      return false;
    }
    // The song may already be in the library from another upload. Only a
    // full artist+title match blocks it — a title-only hit is too weak to
    // silently skip a track the playlist asked for.
    const hit = libraryMatch(musicIdentity(it));
    if (hit && !hit.weak) {
      console.log(`playlist watch: "${it.title}" is already in the library (${hit.file}) — skipped`);
      return false;
    }
    return true;
  });
  for (const it of fresh) {
    const url = it.sourceUrl || it.url;
    startNavidromeJob(url, pl.lib, { playlistId: pl.id, key: mediaKey(url) });
  }
  return { total: profile.items.length, queued: fresh.length, exhausted };
}

async function runWatchCycle(reason) {
  if (watchCycleRunning) return;
  watchCycleRunning = true;
  try {
    const watched = readPlaylists().filter((p) => p.watch);
    if (!watched.length) return;
    console.log(`playlist watch (${reason}): checking ${watched.length} playlist(s)`);
    for (const pl of watched) {
      try {
        const r = await checkPlaylistForNew(pl);
        updatePlaylist(pl.id, { lastChecked: Date.now(), lastQueued: r.queued, lastError: null });
        if (r.queued) console.log(`playlist watch: "${pl.name}" queued ${r.queued} new track(s)`);
        // Never silent: a track dropped for repeated failures is still counted
        // out loud, so a shrinking playlist has a visible reason.
        if (r.exhausted) console.log(`playlist watch: "${pl.name}" skipped ${r.exhausted} track(s) that failed ${MAX_WATCH_FAILURES}x`);
      } catch (e) {
        updatePlaylist(pl.id, { lastChecked: Date.now(), lastError: String(e.message || e) });
        console.warn(`playlist watch: "${pl.name}" failed:`, String(e.message || e));
      }
    }
  } finally {
    watchCycleRunning = false;
  }
}

setInterval(() => runWatchCycle('interval'), WATCH_INTERVAL_MINUTES * 60 * 1000).unref();
// First pass shortly after boot, so a restart doesn't push checks a full
// interval into the future.
setTimeout(() => runWatchCycle('startup'), 3 * 60 * 1000).unref();

// POST /api/playlists/watch?id=...&on=1|0 -> toggle auto-download of new tracks.
app.post('/api/playlists/watch', (req, res) => {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === String(req.query.id));
  if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
  pl.watch = req.query.on === '1';
  writePlaylists(list);
  res.json({ ok: true, playlists: playlistPayload(list) });
});

// POST /api/playlists/lib?id=...&lib=main|kids -> switch which Navidrome
// library this playlist's tracks are downloaded into.
app.post('/api/playlists/lib', (req, res) => {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === String(req.query.id));
  if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
  pl.lib = parseNavLib(req.query.lib);
  writePlaylists(list);
  res.json({ ok: true, playlists: playlistPayload(list) });
});

// POST /api/playlists/check?id=... -> probe one playlist right now and queue
// whatever is new (manual trigger for the watcher).
app.post('/api/playlists/check', async (req, res) => {
  const pl = readPlaylists().find((p) => p.id === String(req.query.id));
  if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
  try {
    const r = await checkPlaylistForNew(pl);
    updatePlaylist(pl.id, { lastChecked: Date.now(), lastQueued: r.queued, lastError: null });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(422).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /api/downloaded/mark?url=... -> manually mark a source as downloaded:
// playlist views show it as done and "download new" skips it. Used for tracks
// that were obtained some other way (e.g. a Premium-only playlist entry
// grabbed from a different upload of the same song).
app.post('/api/downloaded/mark', (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  markDownloaded(url, null);
  res.json({ ok: true });
});

// POST /api/downloaded/unmark?url=... -> undo a mark (manual or automatic).
app.post('/api/downloaded/unmark', (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const map = readDownloaded();
  delete map[mediaKey(url)];
  try {
    writeJsonAtomic(DOWNLOADED_FILE, map);
  } catch (e) {
    console.warn('downloaded registry write failed:', e.message);
  }
  res.json({ ok: true });
});

// POST /api/playlists/failures/clear?id=... -> forget this playlist's failure
// counters, so tracks the watcher gave up on are queued again next cycle.
app.post('/api/playlists/failures/clear', (req, res) => {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === String(req.query.id));
  if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
  const cleared = exhaustedCount(pl);
  pl.failures = {};
  writePlaylists(list);
  res.json({ ok: true, cleared, playlists: playlistPayload(list) });
});

// POST /api/playlists/delete?id=...
app.post('/api/playlists/delete', (req, res) => {
  const list = readPlaylists().filter((p) => p.id !== String(req.query.id));
  writePlaylists(list);
  res.json({ ok: true, playlists: playlistPayload(list) });
});

// GET /api/history -> recent downloads, newest first.
app.get('/api/history', (req, res) => {
  const adultView = wantsAdultView(req);
  const store = adultView ? null : readProfileStoreQuietly();
  const items = adultView
    ? readHistory().slice(0, 100)
    : readHistory().filter((e) => passesAudience(entryClassification(e, store).audience, false)).slice(0, 100);
  res.json({ ok: true, items });
});

// GET /api/music?q=&lib=main|kids&limit=&offset= -> the music log (every track
// in a Navidrome library), newest first. Unlike /api/history this never rolls
// over, so it is the answer to "which songs were downloaded".
app.get('/api/music', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const lib = req.query.lib === 'main' || req.query.lib === 'kids' ? req.query.lib : null;
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  // Where a track stands in a tidy-up pass: done = ticked off (an edit ticks
  // it off too), todo = still to look at, edited = the tags were changed here.
  // missing = the row is in the log but the file is gone from the library --
  // the scan flags it, and this is how you get to see which ones.
  const status = ['done', 'todo', 'edited', 'missing'].includes(req.query.status) ? req.query.status : null;
  // sort=old flips the order here rather than in the browser: the response is a
  // window of `limit` rows, so reversing it client-side would only ever show
  // the oldest of the newest page, not the oldest in the library.
  const oldestFirst = req.query.sort === 'old';
  let items = readMusic();
  if (lib) items = items.filter((t) => t.lib === lib);
  if (q) {
    items = items.filter((t) =>
      [t.title, t.album, t.filename, ...(t.artists || []), ...(t.genres || [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }
  // Counted before the status filter, so the UI can say "N of M done".
  const done = items.filter((t) => t.done).length;
  const edited = items.filter((t) => t.editedAt).length;
  const missing = items.filter((t) => t.missing).length;
  if (status === 'done') items = items.filter((t) => t.done);
  else if (status === 'todo') items = items.filter((t) => !t.done);
  else if (status === 'edited') items = items.filter((t) => t.editedAt);
  else if (status === 'missing') items = items.filter((t) => t.missing);
  // The log is newest-first (recordMusic unshifts), so this is the whole flip.
  if (oldestFirst) items = items.slice().reverse();
  res.json({
    ok: true,
    total: items.length,
    done,
    edited,
    missing,
    scanning: musicScanRunning,
    lastScan: musicLastScan || null,
    items: items.slice(offset, offset + limit),
  });
});

// POST /api/music/done  { id, done } -> tick a track off (or un-tick it).
// Purely a review marker: nothing on disk changes.
app.post('/api/music/done', (req, res) => {
  const body = req.body || {};
  const tracks = readMusic();
  const row = tracks.find((t) => t.id === String(body.id || ''));
  if (!row) return res.status(404).json({ ok: false, error: 'Track not found in the music log' });
  const on = body.done !== false;
  row.done = on;
  row.doneAt = on ? Date.now() : null;
  writeMusic(tracks);
  res.json({ ok: true, track: row });
});

// GET /api/genres -> every genre Grabbit knows, most-used first, for the
// picker next to the genres field.
app.get('/api/genres', (_req, res) => res.json({ ok: true, genres: knownGenres() }));

// Cover art for a library track, as a small JPEG. The album art is embedded in
// the file itself, so it is extracted once (ffmpeg reads the attached picture
// of opus/m4a/mp3/flac alike) and cached on the data volume — a list of a
// thousand rows must not re-decode a thousand files.
const COVER_DIR = path.join(DATA_DIR, 'covers');
const COVER_SIZE = 200;

function coverCachePath(row) {
  // The id is Grabbit's own and safe as a name; the edit time busts the cache
  // when a track is retagged with new art.
  const stamp = row.editedAt || row.time || 0;
  return path.join(COVER_DIR, `${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${stamp}.jpg`);
}

// Extracting art is an ffmpeg run per file, and a freshly scrolled list asks
// for dozens at once — more than a Pi should start at the same time.
const COVER_MAX_PARALLEL = 3;
let coverRunning = 0;
const coverQueue = [];

function withCoverSlot(fn) {
  return new Promise((resolve) => {
    const run = () => {
      coverRunning++;
      Promise.resolve()
        .then(fn)
        .catch(() => false)
        .then((v) => {
          coverRunning--;
          const next = coverQueue.shift();
          if (next) next();
          resolve(v);
        });
    };
    if (coverRunning < COVER_MAX_PARALLEL) run();
    else coverQueue.push(run);
  });
}

function extractCover(src, out) {
  // Write to a unique temp and rename into place — two concurrent requests for
  // the same cover must not serve a half-written file.
  const tmp = `${out}.${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, [
      '-loglevel', 'error', '-y',
      '-i', src,
      // The embedded picture is a video stream; take the first one only.
      '-map', '0:v:0', '-frames:v', '1',
      '-vf', `scale=${COVER_SIZE}:${COVER_SIZE}:force_original_aspect_ratio=increase,crop=${COVER_SIZE}:${COVER_SIZE}`,
      '-f', 'mjpeg', tmp,
    ]);
    const done = (ok) => {
      if (ok) {
        try {
          fs.renameSync(tmp, out);
        } catch {
          ok = false;
        }
      }
      if (!ok) fs.rm(tmp, { force: true }, () => {});
      resolve(ok);
    };
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0));
  });
}

// GET /api/music/cover?id=...  -> square cover thumbnail, 404 when the file
// carries no art. Answers are immutable: the url carries the track's stamp.
app.get('/api/music/cover', async (req, res) => {
  const row = readMusic().find((t) => t.id === String(req.query.id || ''));
  if (!row) return res.status(404).end();
  const cached = coverCachePath(row);
  const send = () => {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('jpeg').sendFile(cached);
  };
  if (fs.existsSync(cached)) return send();
  const src = path.join(NAV_LIBS[row.lib === 'kids' ? 'kids' : 'main'], row.file);
  if (!fs.existsSync(src)) return res.status(404).end();
  try {
    fs.mkdirSync(COVER_DIR, { recursive: true });
  } catch {
    /* fall through — the extract will fail and answer 404 */
  }
  const ok = await withCoverSlot(() => extractCover(src, cached));
  if (!ok) {
    fs.rm(cached, { force: true }, () => {});
    return res.status(404).end();
  }
  send();
});

// Extract the covers the cache is still missing, in the background and a few
// at a time, so the list is instant instead of decoding a file per row on
// first sight. Runs after a scan; a request that beats it extracts its own.
let coverWarmRunning = false;
async function warmCovers() {
  if (coverWarmRunning) return;
  coverWarmRunning = true;
  try {
    let made = 0;
    for (const row of readMusic()) {
      if (row.missing) continue;
      const cached = coverCachePath(row);
      if (fs.existsSync(cached)) continue;
      const src = path.join(NAV_LIBS[row.lib === 'kids' ? 'kids' : 'main'], row.file);
      if (!fs.existsSync(src)) continue;
      try {
        fs.mkdirSync(COVER_DIR, { recursive: true });
      } catch {
        return;
      }
      if (await withCoverSlot(() => extractCover(src, cached))) made++;
      else fs.rm(cached, { force: true }, () => {});
    }
    if (made) console.log(`music covers: extracted ${made}`);
  } finally {
    coverWarmRunning = false;
  }
}

// A retagged track leaves its old cover behind (the file name carries the
// stamp the log has since changed), so a scan drops whatever no row claims.
function pruneCovers() {
  let live;
  let files;
  try {
    live = new Set(readMusic().map((t) => path.basename(coverCachePath(t))));
    files = fs.readdirSync(COVER_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!live.has(f)) fs.rm(path.join(COVER_DIR, f), { force: true }, () => {});
  }
}

// GET /api/music/description?id=... -> the description behind a library
// track, for the edit sheet: whatever the file itself carries, and otherwise
// the source page's own description (the real artist/title often hides there).
// The source lookup runs yt-dlp, so this is only fetched when asked for.
app.get('/api/music/description', async (req, res) => {
  const row = readMusic().find((t) => t.id === String(req.query.id || ''));
  if (!row) return res.status(404).json({ ok: false, error: 'Track not found in the music log' });
  const file = path.join(NAV_LIBS[row.lib === 'kids' ? 'kids' : 'main'], row.file);
  let text = '';
  let from = null;
  try {
    const embedded = fs.existsSync(file) ? await readFileDescription(file) : [];
    if (embedded.length) {
      text = embedded.join('\n\n');
      from = 'file';
    }
  } catch {
    /* fall through to the source lookup */
  }
  if (!text && row.sourceUrl) {
    try {
      const job = await extractors.resolve(row.sourceUrl);
      if (job && job.description && job.description.trim()) {
        text = job.description.trim();
        from = 'source';
      }
    } catch (e) {
      return res.json({ ok: true, description: '', from: null, sourceUrl: row.sourceUrl, error: String(e.message || e) });
    }
  }
  res.json({ ok: true, description: text.slice(0, 20000), from, sourceUrl: row.sourceUrl || null });
});

// POST /api/music/edit -> retag and re-file a track that is already in a
// library: the same fields the download sheet offers, applied to a file that
// is already on disk instead of to a fresh download. Body (JSON):
//   { id, title, artists, album, release, date, genres, lib }
// artists/genres are the raw field strings (same grammar as a download).
app.post('/api/music/edit', express.json(), async (req, res) => {
  const body = req.body || {};
  const tracks = readMusic();
  const row = tracks.find((t) => t.id === String(body.id || ''));
  if (!row) return res.status(404).json({ ok: false, error: 'Track not found in the music log' });

  const fromRoot = NAV_LIBS[row.lib === 'kids' ? 'kids' : 'main'];
  const oldPath = path.join(fromRoot, row.file);
  if (!fs.existsSync(oldPath)) {
    return res.status(410).json({ ok: false, error: 'The file is no longer in the library — run a scan.' });
  }

  const artists = body.artists ? splitList(String(body.artists)) : (row.artists || []);
  if (!artists.length) artists.push('Unknown Artist');
  const title = String(body.title || row.title || '').trim() || 'Unknown';
  const release = ['album', 'single', 'ep'].includes(body.release) ? body.release : 'album';
  // A single is filed as its own album, exactly as a fresh download would be.
  const album = (release === 'single' ? title : String(body.album || '').trim() || title).trim();
  const date = body.date ? String(body.date).slice(0, 10) : null;
  const yearNum = Number(String(date || '').slice(0, 4));
  const year = yearNum >= 1900 && yearNum <= new Date().getFullYear() + 1 ? String(yearNum) : null;
  const genres = body.genres != null ? splitGenres(String(body.genres)) : (row.genres || []);
  // Moving between the main and the kids library is a plain move of the file.
  const toLib = body.lib === 'kids' ? 'kids' : body.lib === 'main' ? 'main' : (row.lib === 'kids' ? 'kids' : 'main');
  const toRoot = NAV_LIBS[toLib];

  const ext = safeExt(path.extname(oldPath).slice(1), 'm4a');
  const target = musicLibraryTarget(toRoot, { artist: artists[0], album, year, title, ext });
  const newPath = path.join(target.dir, target.filename);
  // Never let a crafted field write outside the library root.
  if (path.relative(toRoot, newPath).startsWith('..')) {
    return res.status(400).json({ ok: false, error: 'Invalid target path' });
  }
  if (newPath !== oldPath && fs.existsSync(newPath)) {
    return res.status(409).json({ ok: false, error: 'Another track is already filed under that name.' });
  }

  // A track that stays put is retagged in place. A track that moves is built as
  // a fresh copy under its new name and the old one is unlinked last.
  //
  // The two music libraries are separate mounts, so renaming across them fails
  // with EXDEV — every single main<->kids move did. And because the file was
  // retagged first, the failure left the new tags on a file still sitting in the
  // old library, with a log row that described the old ones. Copying, then
  // tagging the copy, then renaming it into place means a failure at any step
  // leaves the original exactly as it was and only a .part file to remove.
  const moving = newPath !== oldPath;
  const workPath = moving ? path.join(target.dir, `.${target.filename}.part`) : oldPath;
  const dropWork = () => {
    if (!moving) return;
    try { fs.rmSync(workPath, { force: true }); } catch { /* nothing else to do */ }
    // The artist/album folders were created for a move that is not happening;
    // left behind they show up in the library as a phantom empty release.
    pruneEmptyDirs(target.dir, toRoot);
  };

  if (moving) {
    try {
      fs.mkdirSync(target.dir, { recursive: true });
      fs.copyFileSync(oldPath, workPath);
    } catch (e) {
      dropWork();
      return res.status(500).json({ ok: false, error: 'Could not move the file: ' + String(e.message || e) });
    }
  }

  try {
    await tagAudio(workPath, {
      title,
      artist: artists,
      albumartist: artists[0],
      album,
      date: year ? date : null,
      genre: genres,
      releasetype: release,
      // Same clean-up a download does: no leftover video description/links.
      synopsis: '',
      description: '',
      comment: '',
      purl: '',
    });
  } catch (e) {
    dropWork();
    return res.status(422).json({ ok: false, error: 'Tagging failed: ' + String(e.message || e) });
  }

  if (moving) {
    try {
      // Same directory, so this one is a rename in every case.
      fs.renameSync(workPath, newPath);
    } catch (e) {
      dropWork();
      return res.status(500).json({ ok: false, error: 'Could not move the file: ' + String(e.message || e) });
    }
    try {
      fs.unlinkSync(oldPath);
    } catch (e) {
      // The track is complete at its new path; the stale copy is the lesser
      // problem, and a scan will report it rather than it going unnoticed.
      console.warn('music edit: filed', newPath, 'but could not remove', oldPath + ':', e.message);
    }
    pruneEmptyDirs(path.dirname(oldPath), fromRoot);
    // The downloaded registry shows the file name it saved; keep it truthful
    // so a later scan can still tie this file back to its source url.
    const map = readDownloaded();
    let touched = false;
    for (const v of Object.values(map)) {
      if (v && v.filename === row.filename) {
        v.filename = target.filename;
        touched = true;
      }
    }
    if (touched) {
      try {
        writeJsonAtomic(DOWNLOADED_FILE, map);
      } catch (e) {
        console.warn('downloaded registry write failed:', e.message);
      }
    }
  }

  rememberGenres(genres);
  const staleCover = coverCachePath(row);
  Object.assign(row, {
    lib: toLib,
    file: path.relative(toRoot, newPath),
    filename: target.filename,
    artists,
    title,
    album,
    year,
    genres,
    release,
    missing: false,
    editedAt: Date.now(),
    // Editing a track IS reviewing it; untick by hand to look at it again.
    done: true,
    doneAt: Date.now(),
  });
  writeMusic(tracks);
  fs.rm(staleCover, { force: true }, () => {});
  console.log(`music edit: ${row.file}`);
  res.json({ ok: true, track: row, moved: moving });
});

// Drop the directories a moved track left behind, up to (but never including)
// the library root.
function pruneEmptyDirs(dir, root) {
  let cur = dir;
  while (cur.startsWith(root) && cur !== root) {
    try {
      if (fs.readdirSync(cur).length) return;
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

// POST /api/music/scan -> reconcile the log with the libraries on disk.
app.post('/api/music/scan', async (_req, res) => {
  try {
    const r = await scanMusicLibraries();
    if (r.skipped) return res.status(409).json({ ok: false, error: 'A scan is already running.' });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /api/history/delete?id=...  (omit id to clear all)
app.post('/api/history/delete', (req, res) => {
  try {
    const remaining = deleteHistory(req.query.id || null);
    res.json({ ok: true, remaining });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// GET /api/download?url=...&dest=elite|server&channel=main|18plus&device=1|0&web=1|0&quality=N&audio=1&afmt=
//   dest=elite (default) saves into the elite-v2 shorts _import; dest=server
//     saves into the plain server library (videos/mp3/adults). dest=navidrome
//     and dest=audiobooks are jobs-API only (tagging + library sorting live
//     there) and are rejected.
//   device=1 (default) streams the file to the browser; device=0 saves only.
//   web=1 saves a web-optimized .web.mp4 (lands ready; the transcoder skips it).
//   quality=720|1080|... caps the download resolution (yt-dlp sites only).
//   audio=1 extracts audio (afmt=m4a|mp3|opus); streamed (elite) or saved (server).
app.get('/api/download', async (req, res) => {
  const url = req.query.url;
  const dest = parseDest(req.query.dest);
  if (isAudioLibraryDest(dest)) {
    return res.status(400).json({ ok: false, error: `dest=${dest} is only supported via /api/jobs/start (it tags and sorts the file).` });
  }
  const channel = CHANNELS[req.query.channel] || 'main';
  const folder = req.query.folder; // server-library target folder (videos/adults/photos)
  const device = req.query.device !== '0'; // download to this device too
  const web = req.query.web === '1'; // transcode to a web-optimized .web.mp4
  const quality = parseQuality(req.query.quality); // resolution cap, or null
  const audio = req.query.audio === '1'; // audio-only extraction
  const afmt = AUDIO_FORMATS.includes(req.query.afmt) ? req.query.afmt : 'm4a';
  if (!validUrl(url)) return res.status(400).send('Invalid URL');

  let job;
  try {
    job = await extractors.resolve(url);
  } catch (e) {
    return res.status(422).send('Resolve failed: ' + String(e.message || e));
  }

  // Optional: save under a different profile name (e.g. merge into an existing one).
  if (req.query.creator) job.creator = String(req.query.creator);
  // Optional: override the title (renames the saved file).
  if (req.query.title) job.title = String(req.query.title);
  // Optional: override the caption text and the hashtags that go with it. Both
  // land in the .md sidecar via buildCaption, so a caller that lets a person
  // tidy the metadata before saving (elite-v2's Grab tool) gets its edits into
  // the library rather than the extractor's raw description. An explicitly
  // empty description means "no description", hence the != null test.
  if (req.query.description != null) job.description = String(req.query.description);
  if (req.query.tags != null) {
    job.tags = String(req.query.tags)
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
  }

  // Audio-only with dest=elite is streamed to the device, never filed into an
  // app, so the audience gate has nothing to guard there. An image is filed
  // whatever audio says (its branch runs first), so it is always checked.
  const refused = dest === 'elite' && !(audio && job.mediaType !== 'image') ? channelRefusal(channel, job) : null;
  if (refused) return res.status(422).json({ ok: false, error: refused });

  // Images don't fit the video pipeline: with dest=elite they are dropped into
  // the posts import, otherwise into the plain photos library.
  if (job.mediaType === 'image') {
    const unavailable = dest === 'elite' ? postsUnavailable() : null;
    if (unavailable) return res.status(400).json({ ok: false, error: unavailable });
    return downloadImage(res, job, url, device, dest, channel);
  }

  // Audio-only: for the elite destination it's streamed (audio doesn't fit the
  // shorts pipeline); for the server library it's saved into the mp3 folder,
  // for navidrome into the music library.
  if (audio) return downloadAudio(res, job, url, afmt, dest);

  // Server library: save the video into the chosen folder (videos/adults/photos).
  if (dest === 'server') return downloadServerVideo(res, job, url, { folder, quality, device });

  // Everything below writes into the shorts library, so it needs one.
  const noShorts = shortsUnavailable(channel);
  if (noShorts) return res.status(400).json({ ok: false, error: noShorts });

  // Long videos don't belong in the shorts library — reject so the caller routes
  // them to the server library instead.
  if (tooLongForShorts(job)) {
    return res.status(422).json({ ok: false, error: shortsTooLongError(job), tooLongForShorts: true });
  }

  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const { outName, sidecarName, sidecar } = dropFiles(channel, job, web);
  // Already in elite-v2 (or queued)? Then don't drop a duplicate into _import.
  const status = importedStatus(channel, job.creator, stem);
  const skipImport = status !== null;

  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}.src`);
  const destDir = channelDir(channel);
  // When importing we write straight into _import; for a device-only re-download
  // of an already-imported clip we remux to a throwaway temp file instead.
  const finalPath = skipImport
    ? path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}.out.mp4`)
    : path.join(destDir, outName);
  // Built under .<name>.part and renamed into place once the sidecar is
  // written, so the importer polling _import never reads a half-written clip.
  const buildPath = skipImport ? finalPath : dropPartPath(destDir, outName);
  // Either way this is the file that must not survive a failure; after a
  // successful import the rename has already moved it.
  const cleanup = [tmpPath, buildPath];

  try {
    // Nothing to do: already imported and the user doesn't want a local copy.
    if (skipImport && !device) {
      return res.json({
        ok: true,
        saved: false,
        alreadyImported: status === 'imported',
        channel,
        message:
          status === 'imported'
            ? `Already in ${channelLibrary(channel)} — not re-imported.`
            : 'Already queued in the import folder.',
      });
    }

    fs.mkdirSync(destDir, { recursive: true });

    // 1. Pull the raw media to a temp file.
    if (job.kind === 'direct') {
      await downloadDirect(job, tmpPath);
    } else {
      await downloadYtdlp(job, tmpPath, { quality });
    }

    // 2. Remux/transcode with embedded metadata (plain copy if ffmpeg fails).
    await embedMetadata(tmpPath, buildPath, job, web, 'mp4');

    // 3. Write the .md caption sidecar elite-v2 reads on import, then publish
    //    the clip itself with the rename.
    if (!skipImport) {
      commitDrop(channel, job, destDir, buildPath, finalPath, sidecarName, sidecar);
      // Register the save so playlist views and "download new" recognise the
      // clip as fetched — the jobs/batch paths do this via finishJob.
      markDownloaded(job.sourceUrl || url, outName, job.site, job.mediaId, channel, job);
      noteSourceMeta(job, outName, channel);
    }

    const histEntry = {
      creator: job.creator || null,
      title: job.title || null,
      channel,
      filename: outName,
      sourceUrl: job.sourceUrl || url,
      thumbnail: job.thumbnail || null,
      extractor: job.extractor || null,
      imported: !skipImport,
    };

    // 4a. Save-only: report the result as JSON.
    if (!device) {
      recordHistory({ ...histEntry, device: false });
      return res.json({ ok: true, saved: !skipImport, channel, filename: outName });
    }

    // 4b. Stream the finished file to the browser.
    res.setHeader('Content-Disposition', contentDisposition(outName));
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', fs.statSync(finalPath).size);
    recordHistory({ ...histEntry, device: true });
    await pipeline(fs.createReadStream(finalPath), res);
  } catch (e) {
    const error = String(e.message || e);
    console.error('download failed:', error);
    // Save-only failure whose file isn't published yet -> park it for retry.
    if (!device && job.mediaType !== 'image' && isRetryableError(e, error)) {
      enqueueRetry({
        url: job.sourceUrl || url, dest: parseImportDest(dest),
        channel, folder, web, quality, creator: req.query.creator ? String(req.query.creator) : job.creator,
        title: job.title, thumbnail: job.thumbnail, reason: error,
      });
    }
    if (!res.headersSent) res.status(422).send('Download failed: ' + error);
    else res.destroy();
  } finally {
    for (const f of cleanup) fs.rm(f, { force: true }, () => {});
  }
});

// GET /api/profile?url=... -> list every clip on a profile (for a preview).
app.get('/api/profile', async (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  // A custom extractor that claims this as a profile, OR (for any other URL) let
  // yt-dlp decide whether it's a playlist/channel/profile via its flat-playlist
  // probe — so whole-profile downloads work for all ~1700 yt-dlp sites too.
  const customProfile = extractors.isProfile(url);
  const tryGeneric = !customProfile && extractors.pick(url) === extractors.generic;
  if (!customProfile && !tryGeneric) return res.json({ ok: true, isProfile: false });
  try {
    const p = await extractors.resolveProfile(url);
    const items = p.items.map((job) => {
      const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
      const isImage = job.mediaType === 'image';
      return {
        id: job.id || stem,
        title: job.title || null,
        creator: job.creator || null,
        // Extractors that resolve full items up front (e.g. tikporn's apiv2
        // listing) carry these; flat listings leave them null and the item
        // sheet fetches them on open instead.
        description: job.description || null,
        tags: Array.isArray(job.tags) && job.tags.length ? job.tags : undefined,
        mediaType: isImage ? 'image' : 'video',
        filename: isImage ? `${stem}.${safeExt(job.ext, 'jpg')}` : `${stem}.mp4`,
        thumbnail: job.thumbnail || null,
        preview: job.preview || null,
        duration: durationKnown(job) ? Number(job.duration) : null,
        sourceUrl: job.sourceUrl || job.url || null,
        // Marked in playlist views; "download new" skips these. Check by the
        // clip's own id (job.site/mediaId), not just sourceUrl — for xxxfollow
        // sourceUrl is the shared profile url and would flag the whole creator.
        downloaded: isDownloaded(job.sourceUrl || job.url, job.site, job.mediaId),
        // Same song, different upload: matched against the music library by
        // artist + title. A flat playlist listing carries no music tags, so
        // this leans on the video title and the uploader.
        inLibrary: isImage ? null : libraryMatch(musicIdentity(job)),
        tooLongForShorts: !isImage && tooLongForShorts(job),
        imported: {
          main: isImage ? imageStatus(job.creator, stem) : importedStatus('main', job.creator, stem),
          '18plus': isImage ? null : importedStatus('18plus', job.creator, stem),
        },
      };
    });
    for (const it of items) {
      const token = it.thumbnail ? notePreviewThumb(req, it, it.sourceUrl) : null;
      if (token) it.thumbToken = token;
    }
    res.json({
      ok: true,
      isProfile: true,
      extractor: p.extractor,
      creator: p.creator,
      title: p.title || null,
      count: items.length,
      items,
      // Rule matched on the profile itself (no per-item duration/type checks).
      rule: publicRule(matchRule({ url, extractor: p.extractor, creator: p.creator, title: p.title })),
    });
  } catch (e) {
    // For the generic probe, "not a playlist" just means it's a single video.
    if (tryGeneric) return res.json({ ok: true, isProfile: false });
    res.status(422).json({ ok: false, error: String(e.message || e) });
  }
});

// Profile items resolve from a listing that carries no tags; pull them from the
// clip's own post page. This used to sit inside saveJobToImport, which meant it
// ran on the shorts batch path and nowhere else — a whole-profile save to the
// server library, the photo library or posts lost every tag. Call it once per
// clip that is actually being saved, so a skipped clip never pays for the extra
// page fetch, and use its return value: enrichJob may hand back a new object.
async function enrichProfileItem(job) {
  if (!job || !job.pageUrl) return job;
  if (Array.isArray(job.tags) && job.tags.length) return job;
  try {
    return (await extractors.enrichJob(job)) || job;
  } catch {
    return job; // best effort — tags stay empty
  }
}

// GET /api/download-all?url=...&channel=main|18plus
// Streams Server-Sent Events with per-clip progress while saving each clip into
// the channel's _import folder (skipping clips already in elite-v2).
app.get('/api/download-all', async (req, res) => {
  const url = req.query.url;
  const dest = parseImportDest(req.query.dest);
  const channel = CHANNELS[req.query.channel] || 'main';
  const folder = req.query.folder; // server-library target folder (videos/adults/photos)
  const web = req.query.web === '1'; // transcode each clip to a web-optimized .web.mp4
  const quality = parseQuality(req.query.quality); // resolution cap, or null
  if (!validUrl(url)) return res.status(400).end();
  const noShorts = dest === 'elite' ? shortsUnavailable(channel) : null;
  if (noShorts) return res.status(400).json({ ok: false, error: noShorts });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Optional: only download a chosen subset of clips (comma-separated ids).
  const idSet = req.query.ids
    ? new Set(String(req.query.ids).split(',').filter(Boolean))
    : null;

  const creatorOverride = req.query.creator ? String(req.query.creator) : null;

  let items;
  try {
    const p = await extractors.resolveProfile(url);
    items = idSet ? p.items.filter((j) => idSet.has(j.id)) : p.items;
    // Save every clip under the chosen profile name if one was given.
    if (creatorOverride) items.forEach((j) => (j.creator = creatorOverride));
    send({ type: 'start', total: items.length, creator: creatorOverride || p.creator, channel });
  } catch (e) {
    send({ type: 'error', error: String(e.message || e) });
    return res.end();
  }

  let saved = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    let job = items[i];
    const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
    const title = job.title || stem;
    const id = job.id || stem;
    try {
      const isImage = job.mediaType === 'image';
      const refused = dest === 'elite' ? channelRefusal(channel, job) : null;
      if (refused) {
        skipped++;
        send({ type: 'progress', index: i + 1, total: items.length, id, title, status: 'skipped', error: refused });
        continue;
      }
      const toPosts = isImage && dest === 'elite';
      const exists = isImage
        ? (toPosts ? postsPending(job.creator, stem) : photoHas(stem))
        : dest === 'server'
        ? serverHas(folder, job.creator, stem)
        : importedStatus(channel, job.creator, stem);
      if (exists) {
        skipped++;
        send({ type: 'progress', index: i + 1, total: items.length, id, title, status: 'skipped' });
        continue;
      }
      // Don't import a known-long clip into shorts (server library is fine).
      if (!isImage && dest !== 'server' && tooLongForShorts(job)) {
        skipped++;
        send({ type: 'progress', index: i + 1, total: items.length, id, title, status: 'skipped', error: 'too long for shorts' });
        continue;
      }
      // Past every skip: this clip is being saved, so it is worth the page
      // fetch. Above the branch, so all four destinations get the tags.
      job = await enrichProfileItem(job);
      if (isImage) {
        if (toPosts) await saveImageToPosts(job, channel);
        else await saveImageToLibrary(job);
      } else if (dest === 'server') await saveJobToServer(job, folder, quality);
      else await saveJobToImport(job, channel, web, quality);
      recordHistory({
        creator: job.creator || null,
        title: job.title || null,
        channel: isImage
          ? (toPosts ? 'elite/posts' : 'server/photos')
          : dest === 'server'
          ? `server/${serverShelf(folder, serverSaveDir(folder, job.creator))}`
          : channel,
        filename: isImage
          ? `${stem}.${safeExt(job.ext, 'jpg')}`
          : `${stem}${dest === 'elite' && web ? '.web.mp4' : '.mp4'}`,
        sourceUrl: job.sourceUrl || url,
        thumbnail: job.thumbnail || null,
        extractor: job.extractor || null,
        imported: dest === 'elite',
        device: false,
      });
      saved++;
      // The channel only means something for a shorts save (see finishJob) — a
      // server/photos save recorded under a channel makes a later shorts
      // download of the same clip look like a repeat and get skipped.
      markDownloaded(job.sourceUrl || job.url, null, job.site, job.mediaId, dest === 'elite' ? channel : null, job,
        dest === 'elite' ? channel : dest === 'server' && /^adults(\/|$)/.test(String(folder || '')) ? 'server/adults' : null);
      noteSourceMeta(job, null, dest === 'elite' ? channel : null);
      send({ type: 'progress', index: i + 1, total: items.length, id, title, status: 'saved' });
    } catch (e) {
      failed++;
      const error = String(e.message || e);
      // A clip whose file isn't published upstream yet (freshly-uploaded 404)
      // is parked in the retry queue so it downloads automatically once ready.
      let queued = false;
      if (job.mediaType !== 'image' && isRetryableError(e, error)) {
        queued = !!enqueueRetry({
          url: job.sourceUrl || job.url, dest, channel, folder, web, quality,
          creator: creatorOverride || job.creator, title, thumbnail: job.thumbnail, reason: error,
        });
      }
      // Persist the failure too — a batch scrolls past on screen, and nothing
      // was marked as downloaded, so the item stays retryable.
      recordHistory({
        creator: job.creator || null, title, channel: null, filename: null,
        sourceUrl: job.sourceUrl || job.url || null, thumbnail: job.thumbnail || null,
        extractor: job.extractor || null, imported: false, device: false, error,
      });
      send({ type: 'progress', index: i + 1, total: items.length, id, title, status: 'failed', error, queuedForRetry: queued });
    }
  }
  send({ type: 'done', saved, skipped, failed });
  res.end();
});

// ---------------------------------------------------------------------------
// Background download jobs. The public web UI runs single downloads as
// server-side jobs and watches progress over SSE, because a long download can't
// finish within the Cloudflare/Traefik gateway timeout (the response would only
// start after the whole file was fetched). elite-v2's internal integration keeps
// using the synchronous /api/download + /api/download-all over the docker
// network, which has no such limit.
const jobsMap = new Map();
const jobSubs = new Map(); // SSE response -> true for the 18+ view
let jobSeq = 0;
const JOB_KEEP_DONE = 60; // cap finished jobs retained in memory
const DELIVER_TTL_MS = 30 * 60 * 1000; // keep a throwaway device-delivery file this long

// The view sent to clients: drops server-only fields (absolute paths, the raw
// start params kept for retries).
function publicJob(j) {
  // `watch` is watcher bookkeeping (playlist id + registry key), like params:
  // internal, and nothing the UI renders.
  // `deliverKey` goes only to the request that started the job (B5).
  const { finalPath, deliverTemp, params, watch, fromSchedule, savedPaths, deliverKey, ...pub } = j;
  return pub;
}
// H97: the job feeds follow the H4 audience gate. On a general view a job
// whose item is 18+ or not classified general is sent without anything that
// names it (creator, title, picture, file name, source); status and progress
// stay, so the queue still counts it. The 18+ view (`audience=adult`) gets the
// full job. The audience is worked out again on every send, and every job is
// sent again when a classification changes (audienceChanged()).
function jobClassChannel(j) {
  if (j.dest === 'elite') return j.channel || null;
  const folder = (j.params && j.params.folder) || j.folder;
  if (j.dest === 'server' && typeof folder === 'string' && /^adults(\/|$)/.test(folder)) return 'server/adults';
  return null;
}
function jobAudience(j) {
  if (j.audience === 'adult') return 'adult';
  let store;
  try {
    ({ store } = readProfilesReadOnly());
  } catch {
    return 'unknown';
  }
  const base = {
    channel: jobClassChannel(j),
    sourceUrl: j.sourceUrl || j.url || null,
    site: j.site || null,
    extractor: j.extractor || null,
    filename: j.filename || null,
    itemKey: itemKeyOf(j),
  };
  let aud = entryClassification({ ...base, creator: j.creator }, store).audience;
  // A renamed creator never borrows another creator's general profile.
  if (aud === 'general' && j.sourceCreator !== undefined && j.sourceCreator !== j.creator) {
    aud = entryClassification({ ...base, creator: j.sourceCreator }, store).audience;
  }
  return aud;
}
const UNCLASSIFIED_REFUSAL_RE = / is a general app and the audience of .* is not classified/;
function reducedJob(pub) {
  const out = { ...pub };
  for (const k of ['creator', 'sourceCreator', 'title', 'description', 'thumbnail', 'filename', 'sourceUrl', 'url', 'mediaId',
    'dir', 'duplicate', 'message', 'route', 'savedTo']) {
    if (k in out) out[k] = null;
  }
  // The hub offers "classify and retry" on an unclassified refusal; the
  // sentence keeps that shape without the creator's name.
  if (out.error) {
    out.error = UNCLASSIFIED_REFUSAL_RE.test(out.error)
      ? 'The app is a general app and the audience of this item is not classified.'
      : 'The download failed.';
  }
  // `deliverable` stays, and names nothing: the file itself is handed only to
  // the 18+ view or to the tab that started the job, with its delivery key
  // (Codex phase-0 B5).
  out.audienceHidden = true;
  return out;
}
function viewOfJob(j, adultView) {
  const pub = publicJob(j);
  if (adultView || jobAudience(j) === 'general') return pub;
  return reducedJob(pub);
}
function snapshotJobs(adultView = false) {
  return [...jobsMap.values()].map((j) => viewOfJob(j, adultView)).sort((a, b) => b.createdAt - a.createdAt);
}
// A job's own picture is recorded once per change of what classifies it.
const jobThumbNoted = new WeakMap();
function noteJobThumb(j) {
  if (!j.thumbnail) return;
  const input = thumbIn(j, jobClassChannel(j));
  const sig = `${j.thumbnail}\0${JSON.stringify(input)}`;
  if (jobThumbNoted.get(j) === sig) return;
  jobThumbNoted.set(j, sig);
  noteThumb(j.thumbnail, { kind: 'job', ref: `j:${j.id}`, in: input });
}
function emitJob(j) {
  noteJobThumb(j);
  let full = null;
  let general = null;
  for (const [r, adultView] of jobSubs) {
    let line;
    if (adultView) line = full || (full = `data: ${JSON.stringify({ type: 'job', job: publicJob(j) })}\n\n`);
    else line = general || (general = `data: ${JSON.stringify({ type: 'job', job: viewOfJob(j, false) })}\n\n`);
    try {
      r.write(line);
    } catch {
      /* subscriber gone; dropped on its close handler */
    }
  }
}
// A classification changed (a profile or an item): every job is sent again
// in the form its audience now allows, and the hub hears that it should
// reload what it shows (H99).
function audienceChanged() {
  for (const j of jobsMap.values()) emitJob(j);
  for (const r of jobSubs.keys()) {
    try {
      r.write(`data: ${JSON.stringify({ type: 'audience' })}\n\n`);
    } catch {
      /* subscriber gone */
    }
  }
}
function setJob(j, patch) {
  const prev = j.status;
  Object.assign(j, patch);
  emitJob(j);
  if (j.status !== prev && (j.status === 'done' || j.status === 'error')) notifyJobFinished(j);
}
function newJob(fields) {
  const id = `${Date.now()}-${jobSeq++}`;
  const job = {
    id, status: 'queued', phase: null, percent: null, speed: '', eta: '',
    title: null, creator: null, thumbnail: null, mediaType: null, duration: null,
    filename: null, mime: null, dest: null, dir: null, channel: null,
    saved: false, deliverable: false, message: null, error: null, at: null,
    createdAt: Date.now(), doneAt: null, finalPath: null, deliverTemp: false,
    ...fields,
  };
  // Key on job.id, not the freshly generated id — restored scheduled jobs pass
  // their persisted id in `fields`, and a mismatched map key breaks
  // cancel/retry/file lookups and pruning for them.
  jobsMap.set(job.id, job);
  emitJob(job);
  return job;
}
function finishJob(job, patch) {
  setJob(job, { status: 'done', phase: null, percent: 100, doneAt: Date.now(), ...patch });
  // Anything saved into a library counts as downloaded (playlist dedup marks).
  // The channel only means something for a shorts save; recording it for a
  // server/Navidrome save would make a later shorts download look like a repeat.
  if (job.saved && job.sourceUrl) {
    // The registry row keeps the picture's provenance after the history row
    // has rolled over (H47).
    markDownloaded(job.sourceUrl, job.filename, job.site, job.mediaId, job.dest === 'elite' ? job.channel : null, job, jobClassChannel(job));
    noteSourceMeta(job, job.filename, job.dest === 'elite' ? job.channel : null, SOURCE_META.get(job) || null);
  }
  if (job.watch) clearWatchFailure(job.watch.playlistId, job.watch.key);
  // Duplicate Prevention (3.0.4): checked after the save, off the job's path.
  // A finding lands on the job (job.duplicate) and in the Duplicate Manager.
  if (job.saved && Array.isArray(job.savedPaths) && job.savedPaths.length && DUPE_SERVICE) {
    DUPE_SERVICE.checkSaved(job).catch((e) => console.warn(`dupes: prevention check failed for job ${job.id} (${e.message})`));
  }
  if (job.deliverTemp && job.finalPath) {
    const p = job.finalPath;
    const t = setTimeout(() => fs.rm(p, { force: true }, () => {}), DELIVER_TTL_MS);
    if (t.unref) t.unref();
  }
  if (job.fromSchedule) removeScheduled(job.id);
  pruneJobs();
}
const FINISHED = new Set(['done', 'error', 'cancelled']);
// Names the UI control that stores cookie files; doubles as the marker that says
// a message has already been through cookieHintFor().
const COOKIE_HINT_MARK = 'More → Cookies';
function pruneJobs() {
  const done = [...jobsMap.values()]
    .filter((j) => FINISHED.has(j.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  while (done.length > JOB_KEEP_DONE) {
    const j = done.shift();
    if (j.deliverTemp && j.finalPath) fs.rm(j.finalPath, { force: true }, () => {});
    jobsMap.delete(j.id);
  }
}

function recordJobHistory(meta, params, channelLabel, filename, imported) {
  recordHistory({
    creator: meta.creator || null,
    ...(meta.sourceCreator !== undefined && meta.sourceCreator !== meta.creator ? { sourceCreator: meta.sourceCreator } : {}),
    title: meta.title || null,
    channel: channelLabel,
    filename,
    sourceUrl: meta.sourceUrl || params.url,
    thumbnail: meta.thumbnail || null,
    extractor: meta.extractor || null,
    imported,
    device: !!params.device,
    ...(params.routeDecision ? { route: params.routeDecision } : {}),
  });
}

// yt-dlp answers a login wall with command-line advice ("Use --cookies ..."),
// which is dead text in a web UI — nobody here is going to run yt-dlp by hand.
// Point at the control that does the same job instead. Both the probe and the
// download already run with whatever file is stored (cookieArgs), so a login
// wall past an existing file means the export is stale, not missing.
//
// Safe to call twice: runJob appends its own "(queued for a later attempt)"
// after the hint, so it hints first and lets failJob pass the result through.
function cookieHintFor(job, error) {
  if (error.includes(COOKIE_HINT_MARK)) return error;
  // The word boundaries matter: without them "log in" matches inside "blog in"
  // and "sign in" inside "design in", which would staple a cookie hint onto
  // unrelated failures.
  if (!/--cookies|\blog ?in\b|\bsign[- ]?in\b|authentication/i.test(error)) return error;
  const url = job.sourceUrl || job.url || null;
  const stored = cookieFileFor(url);
  if (stored) {
    return `${error} — the stored "${path.basename(stored, '.txt')}" cookie file did not get past it; re-export it under ${COOKIE_HINT_MARK}`;
  }
  let host = '';
  try {
    host = new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    /* an unreadable URL just leaves the site name out of the sentence */
  }
  return `${error} — no cookie file stored${host ? ` for ${host}` : ''}; add one under ${COOKIE_HINT_MARK}`;
}

// Mark a job as failed AND write the failure to the persistent history, so the
// reason survives a restart — the job list itself is in-memory only. Failures
// are never marked as downloaded, so a playlist still offers them next time.
function failJob(job, message, err) {
  const error = cookieHintFor(job, String(message || 'Download failed'));
  setJob(job, { status: 'error', phase: null, error });
  // Watcher-queued tracks count their failures so a permanently broken one
  // stops coming back every cycle. Only a permanent failure counts: a track
  // that met a rate limiter on three cycles is not broken, and counting those
  // retires it from the playlist for good. Callers that hold the error object
  // pass it, because its `retryable` flag classifies better than the text.
  if (job.watch && !isTransientDownloadError(err === undefined ? error : err)) {
    recordWatchFailure(job.watch.playlistId, job.watch.key);
  }
  recordHistory({
    creator: job.creator || null,
    ...(job.sourceCreator !== undefined && job.sourceCreator !== job.creator ? { sourceCreator: job.sourceCreator } : {}),
    title: job.title || null,
    // The channel a success would have recorded where it decides the
    // audience (Codex phase-0 B4): a failed 18+ save stays 18+ in History.
    channel: job.dest === 'navidrome'
      ? `navidrome/${job.lib === 'kids' ? 'kids' : 'music'}`
      : job.dest === 'elite' ? job.channel || 'main'
      : jobClassChannel(job) || job.dest || null,
    ...(job.site ? { site: job.site } : {}),
    ...(job.audience === 'adult' ? { audience: 'adult' } : {}),
    filename: null,
    sourceUrl: job.sourceUrl || job.url || null,
    thumbnail: job.thumbnail || null,
    extractor: job.extractor || null,
    imported: false,
    device: false,
    error,
    ...(job.route ? { route: job.route } : {}),
  });
  if (job.fromSchedule) removeScheduled(job.id);
  // A run of failures grows jobsMap without bound otherwise: pruning only from
  // finishJob means the JOB_KEEP_DONE cap never applies to a failing workload.
  pruneJobs();
}
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 5000;

// A few seconds of in-job retries do not help a file the CDN has not encoded
// yet. Park those in the retry queue instead, the same one the synchronous save
// paths use. That queue re-runs a save into the shorts or server library, so
// only those two destinations qualify — an audio, cut or device job would come
// back as the wrong kind of download.
function queueJobRetry(job, params, err) {
  const error = String((err && err.message) || err);
  if (!isRetryableError(err, error)) return false;
  if (job.mediaType === 'image' || params.device || params.audio) return false;
  if ((params.sections && params.sections.length) || params.splitChapters) return false;
  if (params.dest !== 'elite' && params.dest !== 'server') return false;
  return !!enqueueRetry({
    url: job.sourceUrl || params.url,
    dest: params.dest,
    channel: params.channel,
    folder: params.folder,
    web: params.web,
    quality: params.quality,
    creator: job.creator,
    title: job.title,
    thumbnail: job.thumbnail,
    reason: error,
  });
}

// The smart route for one resolved video: the read-only audience verdicts feed
// smartRouting.decideRoute, the decision lands on the job and the routing log,
// and the caller switches params to it. The audience gate still runs at write
// time; this only chooses where to ask.
function smartRoute(job, meta, params) {
  const facts = { audience: 'unknown', mainRefusal: null, shortsMain: false, shorts18: false };
  try {
    facts.shortsMain = ELITE_ENABLED && !shortsUnavailable('main');
    const main = audienceVerdict('main', meta, { readOnly: true });
    facts.mainRefusal = main.why || null;
    facts.audience = main.c ? main.c.audience : 'unknown';
    if (ELITE_ENABLED && !shortsUnavailable('18plus')) {
      facts.shorts18 = !audienceVerdict('18plus', meta, { readOnly: true }).why;
    }
  } catch (e) {
    // Fail closed: an audience that cannot be judged is not general.
    facts.audience = 'unknown';
    facts.mainRefusal = `the audience check failed (${e.message})`;
  }
  const d = smartRouting.decideRoute(meta, facts);
  const decision = {
    route: d.route,
    orientation: d.orientation,
    source: d.source.id,
    sourceClass: d.source.class,
    audience: facts.audience,
    dest: d.dest,
    channel: d.channel,
    folder: d.folder,
    reasons: d.reasons,
  };
  params.routeDecision = decision;
  setJob(job, { dest: d.dest, channel: d.channel, route: decision });
  logRoutingDecision({
    jobId: job.id,
    sourceUrl: meta.sourceUrl || params.url,
    site: meta.site || null,
    mediaId: meta.mediaId || null,
    creator: meta.creator || null,
    width: Number.isFinite(meta.width) ? meta.width : null,
    height: Number.isFinite(meta.height) ? meta.height : null,
    ...decision,
  });
  console.log(`smart route: job ${job.id} -> ${d.route} (${d.reasons.join('; ')})`);
  return d;
}

// Resolve, enforce the shorts length cap, then dispatch to the right producer.
async function runJob(job, params) {
  setJob(job, { status: 'running', phase: 'resolving' });
  let meta;
  try {
    meta = await extractors.resolve(params.url);
  } catch (e) {
    return failJob(job, 'Resolve failed: ' + String(e.message || e), e);
  }
  // What the source said, before any override below; finishJob stores it.
  try {
    SOURCE_META.set(job, sourceMeta.fromJob(meta));
  } catch (e) {
    console.error('source metadata:', e.message);
  }
  if (params.creatorOverride) meta.creator = params.creatorOverride;
  if (params.titleOverride) meta.title = params.titleOverride;
  if (params.tagsOverride != null) {
    meta.tags = [...new Set(
      params.tagsOverride
        .split(/[\s,;]+/)
        .map((t) => t.replace(/^#+/, '').trim())
        .filter(Boolean)
        .map((t) => '#' + t.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ''))
    )];
  }
  const mediaType = meta.mediaType === 'image' ? 'image' : 'video';
  setJob(job, {
    title: meta.title || null, creator: meta.creator || null, thumbnail: meta.thumbnail || null,
    // The creator as the site named it, before an override (Codex phase-0 B4):
    // the first event that names the job is classified by both names, so a
    // rename never makes an 18+ creator's job general.
    ...(meta.sourceCreator !== undefined ? { sourceCreator: meta.sourceCreator } : {}),
    mediaType, duration: durationKnown(meta) ? Number(meta.duration) : null,
    sourceUrl: meta.sourceUrl || params.url,
    // Site-native id, so finishJob can register the clip under a key that
    // survives being shared as a different URL.
    site: meta.site || null, mediaId: meta.mediaId || null,
  });

  // Smart Video Routing picks the destination now that orientation, source
  // and creator are known. Images keep the destination they were sent to.
  if (params.route === 'smart' && mediaType === 'video' && !params.audio) {
    const decision = smartRoute(job, { ...meta, mediaType }, params);
    params.dest = decision.dest;
    params.channel = decision.channel;
    params.folder = decision.folder;
  }

  // Refuse a save into a library this deploy has not been given. Audio-only is
  // exempt: with dest=elite it is streamed, never filed. An image is not: its
  // branch runs before the audio one, so it is filed whatever audio says.
  if (params.dest === 'elite' && (!params.audio || mediaType === 'image')) {
    // The channel's own refusal first: an 18+ image must be refused as such,
    // not reported as a missing posts library.
    const refused = channelRefusal(params.channel, { ...meta, mediaType });
    if (refused) return failJob(job, refused);
    const unavailable =
      mediaType === 'image' ? postsUnavailable() : shortsUnavailable(params.channel);
    if (unavailable) return failJob(job, unavailable);
  }

  // A smart route sends portrait to Shorts whatever its length (spec 2026-11-21).
  if (params.dest === 'elite' && mediaType !== 'image' && !params.audio && !params.routeDecision && tooLongForShorts(meta)) {
    return failJob(job, shortsTooLongError(meta));
  }

  const onProgress = (p) =>
    setJob(job, {
      phase: 'downloading',
      percent: p.percent == null ? job.percent : Math.max(job.percent || 0, Math.round(p.percent)),
      speed: p.speed || job.speed,
      eta: p.eta || job.eta,
    });

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      if (mediaType === 'image') await produceImage(job, meta, params);
      else if ((params.sections && params.sections.length) || params.splitChapters) await produceCut(job, meta, params, onProgress);
      else if (params.audio) await produceAudio(job, meta, params, onProgress);
      else if (params.dest === 'server') await produceServerVideo(job, meta, params, onProgress);
      else await produceEliteVideo(job, meta, params, onProgress);
      return;
    } catch (e) {
      // Full stack to the server log — the job list only shows the message, and
      // an unexpected TypeError is undebuggable without it.
      console.error(`job ${job.id} attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed:`, e && e.stack ? e.stack : e);
      if (attempt === DOWNLOAD_ATTEMPTS || !isTransientDownloadError(e)) {
        const queued = queueJobRetry(job, params, e);
        const failure = cookieHintFor(job, String(e.message || e));
        return failJob(job, failure + (queued ? ' (queued for a later attempt)' : ''), e);
      }
      // Back off a little further each time — the rate limiter that answered
      // 403 is usually busy with the other jobs in the batch.
      setJob(job, {
        phase: 'retrying', percent: null, speed: '', eta: '',
        message: `Retrying (${attempt}/${DOWNLOAD_ATTEMPTS - 1}) after: ${String(e.message || e)}`,
      });
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
    }
  }
}

// A clip appearing under its final name in a drop folder is the signal the
// importer on the other side polls for, so it must not appear there before it
// is complete. Build it under this name instead and rename as the last step:
// `.part` is in no importer's video-extension set (import-shorts.mjs skips it
// on the extension test) and the leading dot keeps it out of listings, while a
// rename within one directory is atomic on NFS too.
const dropPartPath = (dir, name) => path.join(dir, `.${name}.part`);

async function produceEliteVideo(job, meta, params, onProgress) {
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const { outName, sidecarName, sidecar } = dropFiles(params.channel, meta, params.web);
  let status = importedStatus(params.channel, meta.creator, stem);
  // The filename check only matches an identical creator+title. The same clip
  // shared as a different link, or one whose caption now reads differently,
  // slips past it — the site-native id does not.
  if (status === null) {
    const prev = downloadedEntry(meta.sourceUrl || params.url, meta.site, meta.mediaId);
    if (prev && prev.channel === params.channel) status = 'imported';
  }
  const skipImport = status !== null;
  if (skipImport && !params.device) {
    return finishJob(job, {
      saved: false, channel: params.channel, filename: outName,
      message:
        status === 'imported'
          ? `Already in ${channelLibrary(params.channel)} — not re-imported.`
          : 'Already queued for import.',
    });
  }
  const destDir = channelDir(params.channel);
  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${job.id}.src`);
  // Real import writes into _import; a device-only copy of an already-imported
  // clip goes to a throwaway temp instead.
  const finalPath = skipImport
    ? path.join(os.tmpdir(), `grabbit-${process.pid}-${job.id}.out.mp4`)
    : path.join(destDir, outName);
  // A device-only remux lands in tmp, where nothing is watching it; a real
  // import is built beside its destination and renamed into place last.
  const buildPath = skipImport ? finalPath : dropPartPath(destDir, outName);
  try {
    if (!skipImport) fs.mkdirSync(destDir, { recursive: true });
    if (meta.kind === 'direct') await downloadDirect(meta, tmpPath, { onProgress });
    else await downloadYtdlp(meta, tmpPath, { quality: params.quality, onProgress, extraArgs: params.extraArgs });
    setJob(job, { phase: 'processing', percent: 100 });
    await embedMetadata(tmpPath, buildPath, meta, params.web, 'mp4');
    if (!skipImport) commitDrop(params.channel, meta, destDir, buildPath, finalPath, sidecarName, sidecar);
    recordJobHistory(meta, params, params.channel, outName, !skipImport);
    finishJob(job, {
      saved: !skipImport, channel: params.channel, dir: params.channel, filename: outName, mime: 'video/mp4',
      deliverable: !!params.device, finalPath: params.device ? finalPath : null, deliverTemp: skipImport,
      savedPaths: skipImport ? null : [finalPath],
      message: skipImport
        ? `Already in ${channelLibrary(params.channel)} — device copy only.`
        : 'Saved to ' + params.channel + ' — importing within ~5 min.',
    });
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
    // A no-op once the rename above moved it; what this clears is the leftover
    // of a download or remux that failed half way.
    if (buildPath !== finalPath) fs.rm(buildPath, { force: true }, () => {});
  }
}

async function produceServerVideo(job, meta, params, onProgress) {
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const dir = serverSaveDir(params.folder, meta.creator);
  const shelf = serverShelf(params.folder, dir);
  const container = parseContainer(params.container);
  // "Advanced" = a non-mp4 container or any embed/sponsorblock extra: let yt-dlp
  // mux + embed the final file and skip the mp4-only ffmpeg remux. Direct
  // extractors (no yt-dlp) can't do this, so they always take the mp4 path.
  const advanced =
    meta.kind === 'ytdlp' && (container !== 'mp4' || params.embedThumb || params.embedSubs || params.sponsorblock);
  const ext = advanced ? container : 'mp4';
  const outName = `${stem}.${ext}`;
  const libPath = path.join(dir, outName);
  const already = fs.existsSync(libPath);
  const mime = videoMime(ext);
  if (already && !params.device) {
    return finishJob(job, { saved: false, dest: 'server', dir: shelf, filename: outName, message: 'Already in the library.' });
  }
  if (already && params.device) {
    recordJobHistory(meta, params, `server/${shelf}`, outName, false);
    return finishJob(job, {
      saved: false, dest: 'server', dir: shelf, filename: outName, mime,
      deliverable: true, finalPath: libPath, deliverTemp: false, message: 'Already in the library.',
    });
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${job.id}.src`);
  try {
    if (advanced) {
      // yt-dlp does the muxing + embedding; the produced file lands at tmpPath.
      await downloadYtdlp(meta, tmpPath, {
        quality: params.quality, onProgress, container,
        embedThumb: params.embedThumb, embedSubs: params.embedSubs,
        sponsorblock: params.sponsorblock, embedMeta: true,
        extraArgs: params.extraArgs,
      });
      setJob(job, { phase: 'processing', percent: 100 });
      // copy (not rename) — tmp and the library mount may be different devices;
      // the finally block removes tmpPath.
      fs.copyFileSync(tmpPath, libPath);
    } else {
      if (meta.kind === 'direct') await downloadDirect(meta, tmpPath, { onProgress });
      else await downloadYtdlp(meta, tmpPath, { quality: params.quality, onProgress, extraArgs: params.extraArgs });
      setJob(job, { phase: 'processing', percent: 100 });
      await embedMetadata(tmpPath, libPath, meta, false);
    }
    // Cover art yt-dlp already embedded on the advanced path is left alone; the
    // sidecar picture and the history thumbnail still apply. Setting it on meta
    // is what puts a generated frame on the queue row and in the history for a
    // site that handed over no thumbnail of its own.
    const posterUrl = await attachPoster(meta, libPath, { embed: !(advanced && params.embedThumb), channel: `server/${shelf}` });
    if (posterUrl && !meta.thumbnail) meta.thumbnail = posterUrl;
    recordJobHistory(meta, params, `server/${shelf}`, outName, false);
    finishJob(job, {
      saved: true, dest: 'server', dir: shelf, filename: outName, mime,
      deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
      savedPaths: [libPath],
      message: 'Saved to library/' + shelf + '.',
    });
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
}

async function produceImage(job, meta, params) {
  const toPosts = params.dest === 'elite';
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const ext = safeExt(meta.ext, 'jpg');
  const outName = `${stem}.${ext}`;
  const dir = toPosts ? postsImportDir(meta.creator) : PHOTOS_DIR;
  let libPath = path.join(dir, outName);
  let fileName = outName;
  setJob(job, { phase: 'downloading' });
  if (!imageAlreadySaved(toPosts, dir, stem, libPath, meta)) {
    if (toPosts) {
      // The file actually published (an image under the same stem may be kept).
      const saved = await saveImageToPosts(meta, params.channel);
      libPath = saved.path;
      fileName = saved.name;
    } else {
      fs.mkdirSync(PHOTOS_DIR, { recursive: true });
      await downloadDirect(meta, libPath);
    }
  }
  recordJobHistory(meta, params, toPosts ? 'elite/posts' : 'server/photos', fileName, toPosts);
  finishJob(job, {
    saved: true,
    dest: toPosts ? 'elite' : 'server',
    dir: toPosts ? 'posts' : 'photos',
    filename: fileName,
    mime: imageMime(path.extname(fileName).slice(1)),
    deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
    savedPaths: [libPath],
    message: toPosts ? 'Saved to the posts import folder.' : 'Saved to photos.',
  });
}

async function produceAudio(job, meta, params, onProgress) {
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const afmt = params.afmt;
  const base = path.join(os.tmpdir(), `grabbit-${process.pid}-${job.id}`);
  const srcTmp = `${base}.src`;
  // 'best' keeps the source extension; downloadYtdlpAudio returns the real path.
  let outPath = afmt === 'best' ? null : `${base}.${afmt}`;
  setJob(job, { phase: 'downloading' });
  try {
    if (meta.kind === 'ytdlp') {
      // Library files always get the cover embedded — it's the album art.
      outPath = await downloadYtdlpAudio(meta, base, afmt, {
        aq: params.aq,
        embedThumb: params.embedThumb || isAudioLibraryDest(params.dest),
        sponsorblock: params.sponsorblock,
        extraArgs: params.extraArgs,
      });
    } else {
      // Direct sources can't be re-extracted to 'best' losslessly; fall back to m4a.
      const dfmt = afmt === 'best' ? 'm4a' : afmt;
      outPath = `${base}.${dfmt}`;
      await downloadDirect(meta, srcTmp, { onProgress });
      setJob(job, { phase: 'processing' });
      await extractAudio(srcTmp, outPath, dfmt, params.aq);
    }
    const realExt = safeExt(path.extname(outPath).slice(1), 'm4a');
    const mime = audioMime(realExt);
    const outName = `${stem}.${realExt}`;
    if (params.dest === 'audiobooks') {
      const book = audiobookMeta(meta, params);
      const libDir = audiobookDir(AUDIOBOOKS_DIR, book.author, book.book);
      // Reserve the part number and write inside the folder lock: a second job
      // adding to the same book must not claim the same number.
      const finalName = await withBookFolderLock(libDir, async () => {
        fs.mkdirSync(libDir, { recursive: true });
        const existing = audiobookPartCount(libDir);
        // First file in a fresh book folder stays unnumbered — a one-file story
        // is the common case and "Book.m4a" reads better than "01 - Book.m4a".
        const track = existing + 1;
        const name = audiobookFileName(book.part, realExt, existing ? track : null);
        try {
          await tagAudio(outPath, audiobookTags({ ...book, track }));
        } catch (e) {
          console.warn('audiobook tagging failed, saving untagged:', String(e.message || e));
        }
        fs.copyFileSync(outPath, path.join(libDir, name));
        return name;
      });
      await saveBookCover(meta, libDir);
      const libPath = path.join(libDir, finalName);
      recordJobHistory(meta, params, `audiobooks/${book.author}`, finalName, false);
      finishJob(job, {
        saved: true, dest: 'audiobooks', dir: book.book, filename: finalName, mime,
        deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
        savedPaths: [libPath],
        message: `Saved to audiobooks/${book.author}/${book.book}.`,
      });
    } else if (params.dest === 'server' || params.dest === 'navidrome') {
      const nav = params.dest === 'navidrome';
      // Main library or the separate kids one — different Navidrome instances.
      const navRoot = NAV_LIBS[parseNavLib(params.navLib)];
      let libDir = nav ? navRoot : AUDIO_DIR;
      let finalName = outName;
      let navTags = null;
      if (nav) {
        // Tags: UI-provided fields win; site metadata (yt-dlp) fills the gaps.
        const m = meta.music || {};
        const artists = params.artists ? splitList(params.artists) : splitArtists(m.artist, knownArtist);
        if (!artists.length) artists.push(meta.creator || 'Unknown Artist');
        const songTitle = (params.titleOverride || m.track || meta.title || 'Unknown').trim();
        // A single is filed as its own album (standard music-library layout);
        // an EP keeps its own album name like a regular album.
        const album = (params.release === 'single' ? songTitle : params.album || m.album || songTitle).trim();
        const date = params.date || (m.year ? String(m.year) : null);
        // Only a plausible year is written into the tag and the album folder —
        // sites hand out nonsense release years ("1674") often enough.
        const yearNum = Number(String(date || '').slice(0, 4));
        const year = yearNum >= 1900 && yearNum <= new Date().getFullYear() + 1 ? String(yearNum) : null;
        // Normalised whichever way it arrived — typed in the UI, picked from
        // a candidate row or read off the site — so this path and the
        // lookupGenres path below file the same track under the same name.
        // Only an exact table hit renames anything; free text is kept as
        // typed.
        let genres = normalizeGenres(params.genres ? splitGenres(params.genres) : m.genre ? [m.genre] : []);
        // No genre from the UI or the site: look one up (iTunes, Deezer,
        // SoundCloud) so the library doesn't end up genre-less — the norm for
        // YouTube rips.
        // The video's own tags are the last resort, and the only source for a
        // self-released track no catalogue carries.
        if (!genres.length) {
          genres = await lookupGenres(artists[0], songTitle, meta.tags).catch(() => []);
        }
        // Anything typed by hand joins the picker's list right away.
        if (params.genres) rememberGenres(normalizeGenres(splitGenres(params.genres)));
        try {
          await tagAudio(outPath, {
            title: songTitle,
            artist: artists,
            albumartist: artists[0],
            album,
            // Implausible dates are dropped entirely, not written half-wrong.
            date: year ? date : null,
            genre: genres,
            // Navidrome reads this as the release type (album/single/ep).
            // Best effort: formats whose easy-tag map lacks the key (mp3/m4a)
            // silently skip it in the tag script.
            releasetype: params.release,
            // Clear the video-site leftovers (description, watch links) that
            // yt-dlp's --embed-metadata writes — junk in a music library.
            synopsis: '',
            description: '',
            comment: '',
            purl: '',
          });
        } catch (e) {
          console.warn('audio tagging failed, saving untagged:', String(e.message || e));
        }
        // What ended up in the tags, for the music log written after the copy.
        navTags = { artists, title: songTitle, album, year, genres };
        const target = musicLibraryTarget(navRoot, { artist: artists[0], album, year, title: songTitle, ext: realExt });
        libDir = target.dir;
        finalName = target.filename;
      }
      fs.mkdirSync(libDir, { recursive: true });
      const libPath = path.join(libDir, finalName);
      fs.copyFileSync(outPath, libPath);
      const kids = nav && parseNavLib(params.navLib) === 'kids';
      recordJobHistory(meta, params, nav ? (kids ? 'navidrome/kids' : 'navidrome/music') : 'server/mp3', finalName, false);
      // Music gets its own uncapped log as well — the history rolls over.
      if (nav && navTags) {
        recordMusic({
          lib: kids ? 'kids' : 'main',
          file: path.relative(navRoot, libPath),
          filename: finalName,
          artists: navTags.artists,
          title: navTags.title,
          album: navTags.album || null,
          year: navTags.year || null,
          genres: navTags.genres || [],
          release: params.release,
          duration: durationKnown(meta) ? Math.round(Number(meta.duration)) : null,
          sourceUrl: meta.sourceUrl || params.url,
          source: 'grabbit',
        });
      }
      finishJob(job, {
        saved: true, dest: params.dest, dir: nav ? (kids ? 'kids' : 'music') : 'mp3', filename: finalName, mime,
        deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
        savedPaths: [libPath],
        message: nav ? (kids ? 'Saved to Navidrome (kids).' : 'Saved to Navidrome.') : 'Saved to library/mp3.',
      });
    } else {
      // Audio doesn't fit the shorts pipeline — it's delivered to the device only.
      recordJobHistory(meta, params, `audio/${afmt}`, outName, false);
      finishJob(job, {
        saved: false, filename: outName, mime,
        deliverable: true, finalPath: outPath, deliverTemp: true, message: 'Audio ready.',
      });
    }
  } finally {
    fs.rm(srcTmp, { force: true }, () => {});
    // The library copy owns the data now; drop the temp. (For elite audio the
    // temp IS the deliverable, so it's kept until served / TTL.) outPath is
    // still null when afmt=best and the download failed before assignment —
    // an unguarded rm here would throw and mask the real download error.
    if (outPath && params.dest !== 'elite') fs.rm(outPath, { force: true }, () => {});
  }
}

// The chapter files ytdlpCut produces are "<stem> - chNN <Chapter title>.ext";
// for an audiobook the chapter title is what belongs in the tag and file name.
function chapterPartTitle(filename, fallback) {
  const m = /- ch\d+\s+(.*)\.[^.]+$/.exec(filename);
  return (m && m[1].trim()) || fallback;
}

// Cut downloads: timestamp sections (--download-sections) and/or chapter
// splitting (--split-chapters) can produce SEVERAL files, so they bypass the
// single-file pipeline — yt-dlp writes into a temp dir and everything it
// produced is moved into the library. Server-library and audiobook dests only
// (a book folder is exactly the place a chapter split belongs).
async function produceCut(job, meta, params, onProgress) {
  if (meta.kind !== 'ytdlp') {
    throw new Error('Cutting needs a yt-dlp-handled site (this one uses a direct downloader).');
  }
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const audio = !!params.audio;
  const toBook = params.dest === 'audiobooks';
  const book = toBook ? audiobookMeta(meta, params) : null;
  const dir = toBook
    ? audiobookDir(AUDIOBOOKS_DIR, book.author, book.book)
    : audio
      ? AUDIO_DIR
      : serverSaveDir(params.folder, meta.creator);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-cut-'));
  try {
    await ytdlpCut(meta, tmpDir, stem, {
      audio,
      afmt: params.afmt,
      aq: params.aq,
      quality: params.quality,
      container: params.container,
      embedThumb: params.embedThumb,
      embedSubs: params.embedSubs,
      sponsorblock: params.sponsorblock,
      sections: params.sections,
      splitChapters: params.splitChapters,
      extraArgs: params.extraArgs,
      onProgress,
    });
    setJob(job, { phase: 'processing', percent: 100 });
    const isImage = (f) => /\.(webp|png|jpe?g)$/i.test(f);
    const isJunk = (f) => /\.(part|ytdl|temp|json)$/i.test(f) || isImage(f);
    let files = fs.readdirSync(tmpDir).filter((f) => !isJunk(f));
    // Chapter splitting also leaves the full-length source file behind; when
    // actual chapter files exist, only those are kept.
    if (params.splitChapters && files.length > 1) {
      const chapterFiles = files.filter((f) => f.includes(` - ch`));
      if (chapterFiles.length) files = chapterFiles;
    }
    if (!files.length) throw new Error('yt-dlp produced no output (no matching sections/chapters?)');
    files.sort();
    let savedNames;
    if (toBook) {
      // Every cut becomes a numbered part of the book, tagged individually and
      // continuing the numbering of whatever the folder already holds.
      savedNames = await withBookFolderLock(dir, async () => {
        fs.mkdirSync(dir, { recursive: true });
        const offset = audiobookPartCount(dir);
        const names = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const src = path.join(tmpDir, f);
          const track = offset + i + 1;
          const part = chapterPartTitle(f, `${book.book} ${track}`);
          try {
            await tagAudio(src, audiobookTags({ ...book, part, track }));
          } catch (e) {
            console.warn('audiobook tagging failed, saving untagged:', String(e.message || e));
          }
          const name = audiobookFileName(part, safeExt(path.extname(f).slice(1), 'm4a'), track);
          fs.copyFileSync(src, path.join(dir, name));
          names.push(name);
        }
        return names;
      });
      await saveBookCover(meta, dir);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      savedNames = [];
      for (const f of files) {
        fs.copyFileSync(path.join(tmpDir, f), path.join(dir, f));
        savedNames.push(f);
      }
    }
    recordJobHistory(
      meta, params,
      toBook ? `audiobooks/${book.author}` : `server/${serverShelf(params.folder, dir)}`,
      savedNames[0], false
    );
    const single = savedNames.length === 1 ? path.join(dir, savedNames[0]) : null;
    finishJob(job, {
      saved: true,
      dest: toBook ? 'audiobooks' : 'server',
      dir: toBook ? book.book : serverShelf(params.folder, dir),
      filename: savedNames[0],
      mime: single ? (audio ? audioMime(safeExt(path.extname(single).slice(1), 'm4a')) : videoMime(safeExt(path.extname(single).slice(1), 'mp4'))) : null,
      deliverable: !!params.device && !!single,
      finalPath: params.device && single ? single : null,
      deliverTemp: false,
      savedPaths: savedNames.map((n) => path.join(dir, n)),
      message: toBook
        ? `Saved ${savedNames.length} part(s) to audiobooks/${book.author}/${book.book}.`
        : `Saved ${savedNames.length} cut file(s) to library/${serverShelf(params.folder, dir)}.`,
    });
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

// yt-dlp run for produceCut: downloads into tmpDir using output templates that
// keep multiple section/chapter files apart. Resolves when yt-dlp exits 0.
function ytdlpCut(job, tmpDir, stem, opts = {}) {
  return new Promise((resolve, reject) => {
    const q = opts.quality;
    const fmt = q ? `bv*[height<=${q}]+ba/b[height<=${q}]/bv*+ba/b` : 'bv*+ba/b';
    const ck = cookieArgs(job.url);
    const wantProgress = typeof opts.onProgress === 'function';
    const hasSections = opts.sections && opts.sections.length;
    // Section files: "<stem> [start-end].<ext>". Chapter files: yt-dlp's
    // chapter template with a "chNN" marker produceCut can filter on.
    const mainTpl = hasSections
      ? path.join(tmpDir, `${stem} [%(section_start)d-%(section_end)d].%(ext)s`)
      : path.join(tmpDir, `${stem}.%(ext)s`);
    // A chapter file's name carries the site's own chapter title, which
    // nothing bounds — a full stem plus a long chapter name runs past the
    // filesystem's 255-byte limit and the download dies with ENAMETOOLONG.
    // The stem is shortened here and the chapter title capped so the worst
    // case still fits: 80 + " - chNN " + 40 characters (120 bytes at three
    // bytes per character) + extension, leaving room for the suffixes yt-dlp
    // appends while downloading (".part", ".f<format_id>"). The chapter file
    // is copied into the library under this name, and produceCut reads the
    // chapter title back out of it, so both stay readable.
    const chapterTpl = path.join(
      tmpDir,
      `${clampBytes(stem, 80) || 'video'} - ch%(section_number)02d %(section_title).40s.%(ext)s`,
    );
    const args = [
      '--no-warnings', '--no-playlist',
      ...ck.args,
      ...(opts.audio
        ? ['-f', 'ba/b', '-x', '--audio-format', opts.afmt || 'm4a', ...(opts.aq ? ['--audio-quality', opts.aq] : [])]
        : ['-f', fmt, '--merge-output-format', opts.container || 'mp4']),
      ...(opts.embedThumb ? ['--embed-thumbnail'] : []),
      ...(opts.embedSubs && !opts.audio ? ['--embed-subs'] : []),
      '--embed-metadata',
      ...sponsorArgs(opts.sponsorblock),
      ...(hasSections ? opts.sections.flatMap((s) => ['--download-sections', s]) : []),
      ...(hasSections ? ['--force-keyframes-at-cuts'] : []),
      ...(opts.splitChapters
        ? ['--split-chapters', '-o', `chapter:${chapterTpl}`]
        : []),
      ...(opts.extraArgs || []),
      ...(wantProgress
        ? ['--newline', '--no-color', '--progress-template', 'GRABBIT|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s']
        : []),
      '-o', mainTpl,
      '--', job.url,
    ];
    const p = spawn(YTDLP, args);
    const timedOut = guardChild(p, 'yt-dlp');
    let err = '';
    const onLine = (line) => {
      if (line.startsWith('GRABBIT|')) {
        const [, pct, spd, eta] = line.split('|');
        const percent = parseFloat(pct);
        opts.onProgress({ percent: Number.isFinite(percent) ? percent : null, speed: (spd || '').trim(), eta: (eta || '').trim() });
      } else if (line.trim()) {
        err += line + '\n';
      }
    };
    const feed = (d) => { if (wantProgress) String(d).split('\n').forEach(onLine); else err += d; };
    p.stderr.on('data', feed);
    if (wantProgress) p.stdout.on('data', (d) => String(d).split('\n').forEach(onLine));
    p.on('error', (e) => {
      ck.cleanup();
      reject(e);
    });
    p.on('close', (code) => {
      ck.cleanup();
      if (code === 0) return resolve();
      reject(new Error(timedOut() || err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
    });
  });
}

// GET /api/jobs/start?...same params as /api/download... -> { jobId }, instantly.
// Extras over /api/download: sponsor=remove|mark, sections=<cuts>, split=1
// (chapter splitting), xargs=<extra yt-dlp flags>, at=<epoch ms | ISO datetime>
// (scheduled start).
app.get('/api/jobs/start', (req, res) => {
  const out = startJobFromQuery(req.query, req.principal || gda.LEGACY_SHARED, 'legacy');
  if (out.gdaError) return res.status(out.gdaError.status).json({ ok: false, error: out.gdaError.message });
  res.status(out.status).json(out.body);
  if (out.run) out.run();
});

// The one place a job is created from request parameters, for both the legacy
// GET and POST /api/v1/jobs. Returns { status, body, run? } or { gdaError };
// `run` starts the download and is called after the response is sent, as
// before. The scope check runs on the parsed dest/channel/folder, before
// anything touches the filesystem.
function startJobFromQuery(query, who, via) {
  const req = { query };
  const url = req.query.url;
  if (!validUrl(url)) return { status: 400, body: { ok: false, error: 'Invalid URL' } };
  let dest = parseDest(req.query.dest);
  // GDA: the target this request means, possibly redirected by the client's
  // legacy_main_target (switching an app to another library is one registry
  // field, not an APK). The target's own dest/channel/folder then apply.
  let target = gda.targetForLegacy({ dest, channel: CHANNELS[req.query.channel] || 'main', folder: req.query.folder });
  const main = who.client && who.client.legacy_main_target;
  if (via === 'legacy' && target === 'legacy.tikshortis' && main && main !== target) {
    target = main;
    const l = gda.TARGETS[target].legacy;
    req.query = { ...req.query, dest: l.dest, channel: l.channel, folder: l.folder };
    dest = parseDest(req.query.dest);
  }
  try {
    gda.authorize(who, target, 'job');
  } catch (e) {
    console.log(`gda: client=${who.id} target=${target} via=${via} result=deny code=${e.code}`);
    return { gdaError: e };
  }
  // An app gets its target's own folder and none of the owner's power-user
  // parameters: a free-form folder could name a directory the target check did
  // not classify, and xargs reaches yt-dlp's argv.
  if (who.audience !== 'admin') {
    req.query = { ...req.query, folder: gda.TARGETS[target].legacy.folder, xargs: undefined };
  }
  console.log(`gda: client=${who.id} target=${target} via=${via} result=allow`);
  // The 18+ app is refused at the door when it is not there (unset, or
  // disabled at boot for sharing a tree with a general app), so a scheduled
  // job cannot sit in the queue looking accepted. 18+ images are refused
  // later too, so no media type can route around this.
  if (target === 'adshortis.inbox' && req.query.audio !== '1') {
    const unavailable = shortsUnavailable('18plus');
    if (unavailable) return { status: 422, body: { ok: false, error: unavailable } };
  }
  let params;
  try {
    params = {
      url,
      dest,
      channel: CHANNELS[req.query.channel] || 'main',
      folder: req.query.folder,
      device: req.query.device !== '0',
      web: req.query.web === '1',
      quality: parseQuality(req.query.quality),
      audio: req.query.audio === '1' || isAudioLibraryDest(dest),
      // Target Navidrome library (main | kids); ignored for other dests.
      navLib: parseNavLib(req.query.lib),
      // m4a for audiobooks: the container every audiobook player handles, and
      // it keeps chapter-length files seekable.
      afmt: AUDIO_FORMATS.includes(req.query.afmt) ? req.query.afmt : dest === 'navidrome' ? 'opus' : 'm4a',
      aq: parseAudioQuality(req.query.aq),
      container: parseContainer(req.query.container),
      embedThumb: req.query.thumb === '1',
      embedSubs: req.query.subs === '1',
      sponsorblock: parseSponsor(req.query.sponsor),
      sections: parseSections(req.query.sections),
      splitChapters: req.query.split === '1',
      extraArgs: parseExtraArgs(req.query.xargs),
      creatorOverride: req.query.creator ? String(req.query.creator) : null,
      titleOverride: req.query.title ? String(req.query.title) : null,
      // Edited hashtag list; '' clears the clip's tags entirely.
      tagsOverride: typeof req.query.tags === 'string' ? String(req.query.tags).slice(0, 500) : null,
      // Navidrome tag fields (all optional): artists is a ","- or ";"-separated
      // list, genres also take hashtags or plain spaces (see splitGenres),
      // date is YYYY or YYYY-MM-DD. release is album|single|ep
      // (single files the song as its own album); legacy single=1 still works.
      // dest=audiobooks reuses the same three: artists = author (first one
      // wins), album = book title, title = the part's title.
      artists: req.query.artists ? String(req.query.artists).slice(0, 300) : null,
      album: req.query.album ? String(req.query.album).slice(0, 200) : null,
      release: ['album', 'single', 'ep'].includes(req.query.release)
        ? req.query.release
        : req.query.single === '1' ? 'single' : 'album',
      date: req.query.date ? String(req.query.date).slice(0, 10) : null,
      genres: req.query.genres ? String(req.query.genres).slice(0, 200) : null,
      // Smart Video Routing: the server picks the video destination from the
      // orientation, the source and the audience once the URL is resolved.
      route: req.query.route === 'smart' ? 'smart' : null,
    };
  } catch (e) {
    return { status: 400, body: { ok: false, error: String(e.message || e) } };
  }
  if (params.route) {
    // The owner's web UI only: an app names its own target, and a smart route
    // can end in a target the app was never allowed.
    if (who.audience !== 'admin') return { status: 400, body: { ok: false, error: 'route=smart is only available to the owner.' } };
    if (params.audio || !['elite', 'server'].includes(params.dest)) {
      return { status: 400, body: { ok: false, error: 'route=smart only routes video saves to Shorts or the server library.' } };
    }
    if (params.sections.length || params.splitChapters) {
      return { status: 400, body: { ok: false, error: 'route=smart cannot be combined with cutting or splitting.' } };
    }
  }
  // Cut downloads produce several files at once: the server library takes them
  // as loose files, an audiobook takes them as numbered parts of one book. The
  // elite-v2 shorts import and Navidrome tagging are single-file only.
  if ((params.sections.length || params.splitChapters) && !['server', 'audiobooks'].includes(params.dest)) {
    return { status: 400, body: { ok: false, error: 'Cutting/splitting is only supported for the server and audiobook libraries.' } };
  }
  const at = parseAt(req.query.at);
  const job = newJob({ dest: params.dest, channel: params.channel, lib: params.navLib, device: params.device, clientId: who.id, target });
  job.params = params;
  // A device copy is handed out with this key, which only the starting
  // request learns (B5): another general tab sees the job reduced and cannot
  // fetch its file.
  if (params.device) job.deliverKey = crypto.randomBytes(16).toString('hex');
  if (at) {
    setJob(job, { status: 'scheduled', at });
    addScheduled({ id: job.id, at, params, dest: params.dest, channel: params.channel, device: params.device, clientId: who.id, target });
  }
  const body = { ok: true, jobId: job.id, scheduled: !!at };
  if (job.deliverKey) body.deliverKey = job.deliverKey;
  return { status: 200, body, job, run: at ? null : () => scheduleJob(job, params) };
}

// ---------------------------------------------------------------------------
// GDA v1 (gda.js). Envelope: { ok, data } or { ok:false, error:{ code, message,
// retryable } }. The server picks every path; a client names a target only.
function v1Send(res, status, data) {
  res.status(status).json({ ok: true, data });
}
function v1Fail(res, err) {
  const e = err instanceof gda.GdaError ? err : new gda.GdaError('invalid_request', String((err && err.message) || err));
  res.status(e.status).json(e.toJSON());
}
function v1Principal(req) {
  return req.principal || gda.LEGACY_SHARED;
}

app.get('/api/v1/whoami', (req, res) => {
  const who = v1Principal(req);
  v1Send(res, 200, {
    client_id: who.id,
    audience: who.audience,
    auth: who.kind,
    allowed_ops: who.client ? who.client.allowed_ops : gda.OPS,
    allowed_targets: gda.targetsFor(who).map((t) => t.id),
  });
});

app.get('/api/v1/targets', (req, res) => {
  v1Send(res, 200, { targets: gda.targetsFor(v1Principal(req)) });
});

app.post('/api/v1/jobs', (req, res) => {
  const who = v1Principal(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const url = typeof body.url === 'string' ? body.url : '';
  const target = typeof body.target === 'string' ? body.target : '';
  // Optional resolution cap (max height in px). yt-dlp then takes the best
  // format at or below it, and the best there is when nothing is that small.
  const hasQuality = body.quality !== undefined && body.quality !== null;
  const quality = hasQuality && Number.isInteger(body.quality) ? parseQuality(String(body.quality)) : null;
  try {
    if (!gda.TARGETS[target]) throw new gda.GdaError('unknown_target');
    gda.authorize(who, target, 'job');
    if (!validUrl(url)) throw new gda.GdaError('invalid_request', 'Invalid URL');
    if (hasQuality && !quality) throw new gda.GdaError('invalid_request', 'quality must be an integer height from 144 to 4320');
  } catch (e) {
    console.log(`gda: client=${who.id} target=${target || '-'} via=v1 result=deny code=${e.code || 'invalid'}`);
    return v1Fail(res, e);
  }
  const key = String(req.headers['idempotency-key'] || '').slice(0, 200);
  if (key) {
    const prior = gdaIdempotency.get(who.id, key);
    if (prior && jobsMap.has(prior)) {
      const j = jobsMap.get(prior);
      return v1Send(res, 200, { job_id: j.id, status: gda.v1Status(j), target: j.target, replayed: true });
    }
  }
  const l = gda.TARGETS[target].legacy;
  const query = { url, dest: l.dest, channel: l.channel, folder: l.folder, device: '0' };
  if (quality) query.quality = String(quality);
  const out = startJobFromQuery(query, who, 'v1');
  if (out.gdaError) return v1Fail(res, out.gdaError);
  if (!out.body.ok) return v1Fail(res, new gda.GdaError('invalid_request', out.body.error));
  if (key) gdaIdempotency.set(who.id, key, out.job.id);
  v1Send(res, 202, { job_id: out.job.id, status: gda.v1Status(out.job), target });
  if (out.run) out.run();
});

app.get('/api/v1/jobs/:id', (req, res) => {
  const who = v1Principal(req);
  const j = jobsMap.get(String(req.params.id));
  // Another client's job does not exist for this one.
  if (!j || (who.audience !== 'admin' && j.clientId !== who.id)) return v1Fail(res, new gda.GdaError('not_found'));
  try {
    if (who.client && !who.client.allowed_ops.includes('status')) throw new gda.GdaError('forbidden_op');
  } catch (e) {
    return v1Fail(res, e);
  }
  v1Send(res, 200, {
    job_id: j.id,
    status: gda.v1Status(j),
    target: j.target || null,
    title: j.title,
    error: j.status === 'error' ? j.error : null,
    created_at: new Date(j.createdAt).toISOString(),
    done_at: j.doneAt ? new Date(j.doneAt).toISOString() : null,
  });
});

app.use('/api/v1', (_req, res) => v1Fail(res, new gda.GdaError('not_found', 'No such endpoint.')));

// ---------------------------------------------------------------------------
// Scheduled downloads: jobs with a future start time wait in 'scheduled' until
// due, survive restarts via a DATA_DIR file, and can be cancelled.
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');
function readScheduled() {
  const list = readJsonState(SCHEDULED_FILE, []);
  return Array.isArray(list) ? list : [];
}
function writeScheduled(list) {
  try {
    writeJsonAtomic(SCHEDULED_FILE, list);
  } catch (e) {
    console.warn('scheduled write failed:', e.message);
  }
}
function addScheduled(entry) {
  writeScheduled([...readScheduled().filter((s) => s.id !== entry.id), entry]);
}
function removeScheduled(id) {
  writeScheduled(readScheduled().filter((s) => s.id !== id));
}

// Recreate 'scheduled' jobs from disk after a restart.
for (const s of readScheduled()) {
  if (!jobsMap.has(s.id)) {
    const job = newJob({ id: s.id, status: 'scheduled', at: s.at, dest: s.dest, channel: s.channel, device: s.device, clientId: s.clientId, target: s.target });
    job.params = s.params;
  }
}

// Fire due schedules. A coarse poll (not one timer per job) keeps restarts and
// clock jumps trivially correct.
setInterval(() => {
  const due = readScheduled().filter((s) => s.at <= Date.now());
  for (const s of due) {
    let job = jobsMap.get(s.id);
    if (job && job.status !== 'scheduled') continue; // cancelled or already run
    if (!job) {
      job = newJob({ id: s.id, dest: s.dest, channel: s.channel, device: s.device, clientId: s.clientId, target: s.target });
      job.params = s.params;
    }
    // The entry stays on disk until the job ends (finishJob/failJob/cancel).
    // Jobs live in memory only: dropping it here would lose the download
    // without a trace if the container restarted between firing and finishing.
    // Re-firing is guarded by the status check above, and by the boot loop
    // recreating the entry as 'scheduled'.
    job.fromSchedule = true;
    setJob(job, { status: 'queued', at: null });
    scheduleJob(job, s.params || job.params);
  }
}, 20 * 1000).unref();

// ---------------------------------------------------------------------------
// Retry queue: a clip whose media file isn't published upstream yet (a 404/403
// on the CDN of a freshly-uploaded post — the page + metadata render before the
// file is encoded) is parked here and re-attempted on a growing backoff until it
// succeeds or ages out. Survives restarts via a DATA_DIR file. Works for both
// the standalone UI and the elite-v2 Grab integration, since the retry runs
// server-side and saves straight into the _import folder / server library.
const RETRY_FILE = path.join(DATA_DIR, 'retry-queue.json');
const RETRY_MAX_ATTEMPTS = 12;
const RETRY_MAX_AGE_MS = 72 * 60 * 60 * 1000; // give a slow upstream up to 3 days

function readRetryQueue() {
  const list = readJsonState(RETRY_FILE, []);
  return Array.isArray(list) ? list : [];
}
function writeRetryQueue(list) {
  try { writeJsonAtomic(RETRY_FILE, list); }
  catch (e) { console.warn('retry-queue write failed:', e.message); }
}
const { retryKey, savedFilename, alreadyDownloaded } = require('./retry-queue');
function enqueueRetry(entry) {
  if (!validUrl(entry.url)) return null;
  const list = readRetryQueue();
  const key = retryKey(entry);
  if (list.some((e) => retryKey(e) === key)) return null; // already queued
  const rec = {
    id: `retry-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    url: entry.url,
    dest: parseImportDest(entry.dest),
    channel: entry.channel || 'main',
    folder: entry.folder || null,
    web: !!entry.web,
    quality: entry.quality || null,
    creator: entry.creator || null,
    title: entry.title || null,
    thumbnail: entry.thumbnail || null,
    attempts: 0,
    addedAt: Date.now(),
    nextAt: Date.now() + retryDelayMs(0),
    lastError: entry.reason || null,
  };
  writeRetryQueue([...list, rec]);
  return rec;
}

async function attemptRetry(entry) {
  let job = await extractors.resolve(entry.url);
  if (entry.creator) job.creator = entry.creator;
  job = await enrichProfileItem(job);
  // Already in the registry (downloaded by another path while this was parked):
  // drop the retry without fetching, writing a file or touching the registry.
  if (alreadyDownloaded(entry, job, downloadedEntry)) return { skipped: true };
  const savedPath = entry.dest === 'server'
    ? await saveJobToServer(job, entry.folder, entry.quality)
    : await saveJobToImport(job, entry.channel, entry.web, entry.quality);
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  recordHistory({
    creator: job.creator || null,
    title: job.title || null,
    channel: entry.dest === 'server'
      ? `server/${serverShelf(entry.folder, serverSaveDir(entry.folder, job.creator))}`
      : entry.channel,
    filename: savedFilename(savedPath, `${stem}${entry.dest === 'elite' && entry.web ? '.web.mp4' : '.mp4'}`),
    sourceUrl: job.sourceUrl || entry.url,
    thumbnail: job.thumbnail || null,
    extractor: job.extractor || null,
    imported: entry.dest === 'elite',
    device: false,
  });
  markDownloaded(job.sourceUrl || entry.url, null, job.site, job.mediaId, entry.dest === 'elite' ? entry.channel : null, job,
    entry.dest === 'elite' ? entry.channel : entry.dest === 'server' && /^adults(\/|$)/.test(String(entry.folder || '')) ? 'server/adults' : null);
  noteSourceMeta(job, null, entry.dest === 'elite' ? entry.channel : null);
  return { skipped: false };
}

let retryRunning = false;
async function runRetryCycle() {
  if (retryRunning) return;
  retryRunning = true;
  try {
    const now = Date.now();
    for (const e of readRetryQueue().filter((x) => x.nextAt <= now)) {
      try {
        const r = await attemptRetry(e);
        writeRetryQueue(readRetryQueue().filter((x) => x.id !== e.id));
        console.log(r && r.skipped ? `[retry] already downloaded, skipped ${e.url}` : `[retry] recovered ${e.url}`);
      } catch (err) {
        const msg = String((err && err.message) || err);
        const cur = readRetryQueue();
        const idx = cur.findIndex((x) => x.id === e.id);
        if (idx < 0) continue;
        cur[idx].attempts += 1;
        cur[idx].lastError = msg;
        const tooOld = now - cur[idx].addedAt > RETRY_MAX_AGE_MS;
        if (!isRetryableError(err, msg) || cur[idx].attempts >= RETRY_MAX_ATTEMPTS || tooOld) {
          cur.splice(idx, 1);
          console.log(`[retry] gave up on ${e.url}: ${msg}`);
        } else {
          cur[idx].nextAt = now + retryDelayMs(cur[idx].attempts);
        }
        writeRetryQueue(cur);
      }
    }
  } finally {
    retryRunning = false;
  }
}
setInterval(runRetryCycle, 5 * 60 * 1000).unref();
setTimeout(runRetryCycle, 60 * 1000).unref(); // first sweep a minute after boot

// GET /api/retry -> the pending retry queue (soonest first).
app.get('/api/retry', (req, res) => {
  res.json({ ok: true, items: readRetryQueue().sort((a, b) => a.nextAt - b.nextAt) });
});
// POST /api/retry/add -> manually schedule a clip that can't be downloaded yet.
app.post('/api/retry/add', (req, res) => {
  const url = req.query.url || (req.body && req.body.url);
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const rec = enqueueRetry({
    url,
    dest: parseImportDest(req.query.dest),
    channel: CHANNELS[req.query.channel] || 'main',
    folder: req.query.folder || null,
    web: req.query.web === '1',
    quality: parseQuality(req.query.quality),
    creator: req.query.creator ? String(req.query.creator) : null,
    reason: 'manual',
  });
  res.json({ ok: true, added: !!rec, item: rec || null });
});
// POST /api/retry/remove?id=... -> drop an entry. POST /api/retry/run -> sweep now.
app.post('/api/retry/remove', (req, res) => {
  writeRetryQueue(readRetryQueue().filter((e) => e.id !== req.query.id));
  res.json({ ok: true });
});
app.post('/api/retry/run', (req, res) => { runRetryCycle(); res.json({ ok: true }); });

// POST /api/jobs/:id/cancel -> cancel a scheduled or still-queued job.
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobsMap.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  if (job.status !== 'scheduled' && job.status !== 'queued') {
    return res.status(400).json({ ok: false, error: 'Only scheduled or queued jobs can be cancelled' });
  }
  removeScheduled(job.id);
  setJob(job, { status: 'cancelled', at: null, doneAt: Date.now(), message: 'Cancelled' });
  res.json({ ok: true });
});

// POST /api/jobs/:id/retry -> re-queue a failed/cancelled job with its params.
// POST /api/jobs/:id/classify-retry -> classify the item behind a job that a
// general app refused as unclassified, by hand, as general, then retry it.
// One item, one deliberate click: the same hand classification the Review page
// makes. An 18+ item is never made general, and nothing else is classified.
app.post('/api/jobs/:id/classify-retry', (req, res) => {
  const old = jobsMap.get(req.params.id);
  if (!old) return res.status(404).json({ ok: false, error: 'Job not found' });
  if (!old.params) return res.status(400).json({ ok: false, error: 'This job cannot be retried' });
  if (old.status !== 'error') return res.status(400).json({ ok: false, error: 'Only a refused job can be classified and retried' });
  if (!ITEM_STORE) return res.status(503).json({ ok: false, error: `The item store is unavailable (${ITEM_STORE_ERROR || 'not opened'}).` });
  const app = audience.DESTINATIONS[destinationOf(old.channel, old)];
  if (!app || app.audience !== 'general') return res.status(400).json({ ok: false, error: 'This job was not going to a general app' });
  const key = itemKeyOf(old);
  const item = key ? ITEM_STORE.get(key) : null;
  if (!item) return res.status(400).json({ ok: false, error: 'No item is recorded for this job; classify it on the Review page instead' });
  if (item.audience === 'adult') return res.status(409).json({ ok: false, error: 'This item is 18+ and is never sent to a general app' });
  try {
    const r = ITEM_STORE.classifyItems([item.id], 'general');
    if (r.changed.length) scheduleAudienceChanged();
    if (!r.changed.length && !(r.skipped[0] && /already general/.test(r.skipped[0].reason))) {
      return res.status(409).json({ ok: false, error: (r.skipped[0] && r.skipped[0].reason) || 'The item could not be classified' });
    }
    console.log(`review: item ${item.id} classified general by hand from job ${old.id} (${old.creator || 'no creator'}), retrying`);
  } catch (e) {
    console.error('classify-retry:', e.message);
    return res.status(500).json({ ok: false, error: 'The item store could not be changed. See the server log.' });
  }
  const job = newJob({ dest: old.dest, channel: old.channel, lib: old.lib, device: old.device });
  job.params = old.params;
  res.json({ ok: true, jobId: job.id, itemId: item.id });
  scheduleJob(job, old.params);
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const old = jobsMap.get(req.params.id);
  if (!old) return res.status(404).json({ ok: false, error: 'Job not found' });
  if (!old.params) return res.status(400).json({ ok: false, error: 'This job cannot be retried' });
  if (old.status !== 'error' && old.status !== 'cancelled') {
    return res.status(400).json({ ok: false, error: 'Only failed or cancelled jobs can be retried' });
  }
  const job = newJob({ dest: old.dest, channel: old.channel, lib: old.lib, device: old.device });
  job.params = old.params;
  res.json({ ok: true, jobId: job.id });
  scheduleJob(job, old.params);
});

// Cap concurrent job downloads — a playlist "download all" queues dozens of
// jobs at once, and the Pi can't run that many yt-dlp processes in parallel.
// Excess jobs wait in FIFO order with their 'queued' status showing in the UI.
const MAX_ACTIVE_JOBS = Math.max(1, Number(process.env.MAX_ACTIVE_JOBS) || 2);
let activeJobs = 0;
const pendingJobs = [];
function scheduleJob(job, params) {
  const run = () => {
    // Cancelled while waiting in the FIFO — skip it and let the next one in.
    if (job.status === 'cancelled') {
      const next = pendingJobs.shift();
      if (next) next();
      return;
    }
    activeJobs++;
    runJob(job, params)
      .catch((e) => failJob(job, String(e.message || e), e))
      .finally(() => {
        activeJobs--;
        const next = pendingJobs.shift();
        if (next) next();
      });
  };
  if (activeJobs < MAX_ACTIVE_JOBS) run();
  else pendingJobs.push(run);
}

// GET /api/jobs -> snapshot of current jobs (newest first).
app.get('/api/jobs', (req, res) => res.json({ ok: true, jobs: snapshotJobs(wantsAdultView(req)) }));
// ---------------------------------------------------------------------------
// Health: the one page that answers "is anything quietly broken?". Three of the
// destinations below are NFS mounts from ubu-desk (the libraries moved off the
// Pi on 2026-09-18), and a mount that is not there does not fail a download --
// it writes into an empty directory inside the container that nothing ever
// reads. That is the failure this panel exists to make visible.

// Versions of the external tools. Each costs a process spawn (python's startup
// is most of it), so they are probed at most once per TOOL_TTL_MS — a panel
// that is reopened all day must not pay for it every time.
const TOOL_TTL_MS = 10 * 60 * 1000;
let toolCache = { at: 0, tools: null };

function probeTool(cmd, args, parse) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let p;
    try {
      p = spawn(cmd, args);
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }, 8000);
    if (timer.unref) timer.unref();
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => finish(null));
    p.on('close', (code) => finish(code === 0 ? parse(out.trim()) || null : null));
  });
}

async function toolVersions() {
  if (toolCache.tools && Date.now() - toolCache.at < TOOL_TTL_MS) return toolCache.tools;
  const firstLine = (s) => s.split('\n')[0].trim();
  const [ytdlp, ffmpeg, ffprobe, gallerydl, mutagen] = await Promise.all([
    probeTool(YTDLP, ['--version'], firstLine),
    probeTool(FFMPEG, ['-version'], (s) => (firstLine(s).match(/ffmpeg version (\S+)/) || [])[1]),
    probeTool(FFPROBE, ['-version'], (s) => (firstLine(s).match(/ffprobe version (\S+)/) || [])[1]),
    probeTool(process.env.GALLERY_DL_BIN || 'gallery-dl', ['--version'], firstLine),
    probeTool(PYTHON, ['-c', 'import mutagen; print(mutagen.version_string)'], firstLine),
  ]);
  const tools = [
    { name: 'yt-dlp', version: ytdlp },
    { name: 'ffmpeg', version: ffmpeg },
    { name: 'ffprobe', version: ffprobe },
    { name: 'gallery-dl', version: gallerydl },
    { name: 'mutagen', version: mutagen },
    { name: 'node', version: process.version.replace(/^v/, '') },
  ];
  toolCache = { at: Date.now(), tools };
  return tools;
}

// Which filesystem is actually behind a destination. The question is not
// whether a mount happened — comparing st_dev against the container root only
// ever answered that — but whether it landed where compose asked. When a bind
// source is missing at container start, Docker CREATES it as an empty
// directory on its own root disk and mounts that instead, and to st_dev the
// stand-in is indistinguishable from the real thing: /mnt/4tb is an automount
// over a USB bridge that loses the race at boot often enough, and /mnt/apps
// comes over NFS from a host that may not be up yet. The clip then lands on
// the Pi's nvme, unread by anything, while the panel reports a healthy mount.
//
// So read the mount table instead, and judge the mount by its source.
function readMounts() {
  // mountinfo escapes space, tab, newline and backslash in octal.
  const unesc = (v) => String(v || '').replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  let raw;
  try {
    raw = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return []; // not Linux, or /proc not mounted: every verdict below stays null
  }
  const out = [];
  for (const line of raw.split('\n')) {
    // Optional fields sit between the mount point and a lone '-', so the
    // filesystem type and source have to be found from that separator.
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    out.push({ majmin: left[2], root: unesc(left[3]), point: unesc(left[4]), fstype: right[0] || '', source: unesc(right[1]) });
  }
  return out;
}

// The set of mounts cannot change under a running container, so read it once.
const MOUNTS = readMounts();

// The mount a path sits on: the longest mount point that is the path or a
// parent of it. A drop folder is a subdirectory INSIDE its mount (channelDir
// returns <root>/<channel>/_import), so an exact match would find nothing.
// Later lines win ties — a mount stacked on the same point shadows the earlier.
function mountFor(dir) {
  let best = null;
  for (const m of MOUNTS) {
    const under = dir === m.point || dir.startsWith(m.point === '/' ? '/' : m.point + '/');
    if (under && (!best || m.point.length >= best.point.length)) best = m;
  }
  return best;
}

// Docker bind-mounts /etc/hosts into every container from its own directory on
// the host's root filesystem — which makes that device the signature of the
// fallback directory Docker auto-creates there. A destination backed by the
// same device is on the Pi's root disk, not on the 4 TB disk or the NFS export
// it was supposed to reach. Outside Docker there is no such mount and this
// resolves to the root filesystem, which is the honest answer there too.
const HOST_ROOT_MAJMIN = (() => {
  const m = mountFor('/etc/hosts');
  return m ? m.majmin : null;
})();

// true = on the filesystem it was meant to be on, false = a mount that did not
// happen or fell back to the host's root disk, null = cannot tell.
function mountedVerdict(mnt) {
  if (!MOUNTS.length) return null;
  if (!mnt || mnt.point === '/') return false; // no mount of its own: a plain directory in the image
  if (HOST_ROOT_MAJMIN == null) return null;
  return mnt.majmin !== HOST_ROOT_MAJMIN;
}

// Everything here is async and on a timer on purpose: an NFS server that stops
// answering makes every call against its mount block until it comes back, and a
// sync one would take the whole event loop with it — opening this panel would
// freeze grabbit exactly when a mount is broken.
const DIR_PROBE_MS = 3000;
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.then((v) => { clearTimeout(timer); return v; }, (e) => { clearTimeout(timer); throw e; }),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('timeout')), ms);
      if (timer.unref) timer.unref();
    }),
  ]);
}

async function dirHealth(label, dir, external) {
  const row = {
    label, path: dir, exists: false, writable: false, mounted: null,
    fstype: null, mountPoint: null, source: null,
    free: null, size: null, entries: null, unreachable: false,
  };
  if (external) {
    // Reading the mount table is string work against /proc, so this answer
    // survives what the probe below cannot: a mount that is present but hung
    // still reports which filesystem it is, and a drop folder that does not
    // exist yet still reports what it would be written to.
    const mnt = mountFor(dir);
    row.mounted = mountedVerdict(mnt);
    if (mnt) {
      row.fstype = mnt.fstype;
      row.mountPoint = mnt.point;
      // The device or export, plus the path within it. Together these name the
      // fallback when one happened: a bind that should read
      // "/dev/sdb1 /downloads/grabbit" reads "/dev/nvme0n1p2
      // /mnt/4tb/downloads/grabbit" once the automount lost the boot race.
      row.source = [mnt.source, mnt.root !== '/' ? mnt.root : null].filter(Boolean).join(' ') || null;
    }
  }
  const probe = async () => {
    const st = await fs.promises.stat(dir);
    row.exists = st.isDirectory();
    await fs.promises.access(dir, fs.constants.W_OK).then(
      () => { row.writable = true; },
      () => { /* read-only or not ours */ }
    );
    await fs.promises.statfs(dir).then(
      (fsx) => {
        row.free = Number(fsx.bavail) * Number(fsx.bsize);
        row.size = Number(fsx.blocks) * Number(fsx.bsize);
      },
      () => { /* not every filesystem reports it */ }
    );
    await fs.promises.readdir(dir).then(
      (list) => { row.entries = list.length; },
      () => { /* unreadable: the flags above already say so */ }
    );
  };
  try {
    await withTimeout(probe(), DIR_PROBE_MS);
  } catch (e) {
    // ENOENT is the ordinary "not there" answer and row.exists already says so;
    // a timeout is the mount that is there but hung, which reads differently.
    if (String(e.message) === 'timeout') row.unreachable = true;
  }
  return row;
}

// Rows in a state file, for the ones whose shape we know. A number here is the
// quickest "did something reset it" check there is.
function stateRows(name, value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.tracks)) return value.tracks.length;
  if (Array.isArray(value.items)) return value.items.length;
  if (Array.isArray(value.clients)) return value.clients.length;
  return Object.keys(value).length;
}

function stateHealth() {
  return STATE_FILES.map((name) => {
    const file = path.join(DATA_DIR, name);
    const row = { name, bytes: null, rows: null, updatedAt: null, snapshot: null, corrupt: false };
    try {
      const st = fs.statSync(file);
      row.bytes = st.size;
      row.updatedAt = st.mtimeMs;
      try {
        row.rows = stateRows(name, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        // Readable but not parseable: readJsonState quarantines it on the next
        // read, and until then this is the only place that says so.
        row.corrupt = true;
      }
    } catch { /* never written yet */ }
    const snap = newestSnapshot(name);
    if (snap) row.snapshot = path.basename(path.dirname(snap));
    return row;
  });
}

// A Netscape cookies.txt carries the expiry as field 5 (epoch seconds); 0 means
// a session cookie. The earliest real expiry is what kills the file, so that is
// the one worth showing — an expired cookie file is a login wall tomorrow.
function cookieHealth() {
  return listCookieFiles().map((c) => {
    const row = { ...c, expiresAt: null, expired: false, cookies: 0 };
    try {
      const text = fs.readFileSync(path.join(COOKIES_DIR, `${c.name}.txt`), 'utf8');
      let earliest = null;
      for (const line of text.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const f = line.split('\t');
        if (f.length < 7) continue;
        row.cookies++;
        const exp = Number(f[4]);
        if (!Number.isFinite(exp) || exp <= 0) continue; // session cookie
        if (earliest == null || exp < earliest) earliest = exp;
      }
      if (earliest != null) {
        row.expiresAt = earliest * 1000;
        row.expired = row.expiresAt < Date.now();
      }
    } catch { /* unreadable: the list entry still shows it exists */ }
    return row;
  });
}

// GET /api/health -> tool versions, destination mounts, state files, cookies.
// GET /api/health/release -> { sha } only: no probes, no side effects, public.
app.get('/api/health/release', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ sha: releaseSha() });
});

app.get('/api/health', async (_req, res) => {
  const retries = readRetryQueue();
  const now = Date.now();
  res.json({
    sha: releaseSha(), // first key on purpose: must sit within the first 4 KiB
    ok: true,
    now,
    uptimeSec: Math.round(process.uptime()),
    startedAt: now - Math.round(process.uptime() * 1000),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    tools: await toolVersions(),
    dests: await Promise.all([
      // Skipped entirely when unconfigured — an absent destination is not an
      // unhealthy one, and a red row for a library this deploy does not have
      // would be noise in the one panel that must only show real problems.
      ...(CHANNEL_ROOTS.main ? [dirHealth('shorts main (tikshortis)', channelDir('main'), true)] : []),
      ...(CHANNEL_ROOTS['18plus'] ? [dirHealth('shorts 18+ (adshortis)', channelDir('18plus'), true)] : []),
      // Configured but refused at boot: a real problem, so it gets a row.
      ...(ADULT_BLOCKED ? [{ label: 'shorts 18+ (adshortis)', path: null, exists: false, writable: false, unreachable: false, blocked: ADULT_BLOCKED }] : []),
      ...(CHANNEL_ROOTS.platform ? [dirHealth('platform drop folder', channelDir('platform'), true)] : []),
      ...(POSTS_ENABLED ? [dirHealth('posts (elitogram)', POSTS_IMPORT_DIR, true)] : []),
      dirHealth('server videos', VIDEOS_DIR, true),
      dirHealth('server mp3', AUDIO_DIR, true),
      dirHealth('server adults', ADULTS_DIR, true),
      dirHealth('server photos', PHOTOS_DIR, true),
      dirHealth('navidrome music', NAVIDROME_DIR, true),
      dirHealth('navidrome kids', NAVIDROME_KIDS_DIR, true),
      dirHealth('audiobooks', AUDIOBOOKS_DIR, true),
      dirHealth('data', DATA_DIR, true),
    ]),
    state: stateHealth(),
    items: ITEM_STORE
      ? { ok: true, file: path.basename(ITEMS_DB_FILE), schema: ITEM_STORE.SCHEMA_VERSION, ...ITEM_STORE.counts() }
      : { ok: false, file: path.basename(ITEMS_DB_FILE), error: ITEM_STORE_ERROR },
    backups: {
      days: STATE_BACKUP_DAYS,
      dir: STATE_BACKUP_DIR,
      latest: (() => {
        try {
          return fs.readdirSync(STATE_BACKUP_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() || null;
        } catch {
          return null;
        }
      })(),
    },
    cookies: cookieHealth(),
    push: { enabled: pushEnabled, subscriptions: pushSubs.length },
    jobs: { active: activeJobs, waiting: pendingJobs.length, max: MAX_ACTIVE_JOBS, tracked: jobsMap.size },
    retry: { queued: retries.length, due: retries.filter((r) => r.nextAt <= now).length },
    music: { lastScan: musicLastScan || null, scanning: musicScanRunning },
    auth: { password: !!GRABBIT_PASSWORD, internalToken: !!INTERNAL_TOKEN },
    watchdog: { idleSec: Math.round(CHILD_IDLE_MS / 1000), maxSec: Math.round(CHILD_MAX_MS / 1000) },
  });
});


// GET /api/jobs/stream -> SSE feed of job updates (snapshot first, then deltas).
app.get('/api/jobs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.write('retry: 3000\n\n');
  const adultView = wantsAdultView(req);
  for (const j of snapshotJobs(adultView)) res.write(`data: ${JSON.stringify({ type: 'job', job: j })}\n\n`);
  jobSubs.set(res, adultView);
  const ka = setInterval(() => {
    try {
      res.write(': ka\n\n');
    } catch {
      /* closed */
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(ka);
    jobSubs.delete(res);
  });
});

// GET /api/jobs/:id/file -> stream a finished job's file to the device. The file
// is already on disk so bytes flow immediately (no gateway timeout).
// The file goes to the 18+ view, to the tab holding the job's delivery key,
// or to anyone when the item is classified general (Codex phase-0 B5). The
// file is opened before any header is sent, so a file that vanished answers
// 422, never a 5xx.
function deliverKeyOk(job, key) {
  const k = String(key || '');
  if (!job.deliverKey || !/^[0-9a-f]{32}$/.test(k)) return false;
  return crypto.timingSafeEqual(Buffer.from(job.deliverKey), Buffer.from(k));
}
app.get('/api/jobs/:id/file', async (req, res) => {
  const job = jobsMap.get(req.params.id);
  if (!job || job.status !== 'done' || !job.deliverable || !job.finalPath) {
    return res.status(404).send('Not available');
  }
  if (!wantsAdultView(req) && !deliverKeyOk(job, req.query.key) && jobAudience(job) !== 'general') {
    return res.status(404).send('Not available');
  }
  let fh;
  let size;
  try {
    fh = await fs.promises.open(job.finalPath, 'r');
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    return res.status(422).json({ ok: false, error: `The file is no longer available (${e.code || e.message}).` });
  }
  const name = job.filename || path.basename(job.finalPath);
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.setHeader('Content-Type', job.mime || 'application/octet-stream');
  res.setHeader('Content-Length', size);
  res.setHeader('Cache-Control', 'private, no-store');
  pipeline(fh.createReadStream(), res)
    .then(() => {
      if (job.deliverTemp) {
        fs.rm(job.finalPath, { force: true }, () => {});
        setJob(job, { deliverable: false });
      }
    })
    .catch(() => {
      if (!res.headersSent) res.status(422).end();
      else res.destroy();
    });
});

// POST /api/jobs/clear -> drop finished/failed jobs (and any throwaway files).
app.post('/api/jobs/clear', (_req, res) => {
  for (const [id, j] of jobsMap) {
    if (FINISHED.has(j.status)) {
      if (j.deliverTemp && j.finalPath) fs.rm(j.finalPath, { force: true }, () => {});
      jobsMap.delete(id);
    }
  }
  res.json({ ok: true });
});

// Download a job and write it (with metadata + .md sidecar) into the channel's
// _import folder. Shared by the batch profile downloader.
async function saveJobToImport(job, channel, web, quality) {
  const refused = channelRefusal(channel, job);
  if (refused) throw new Error(refused);
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const destDir = channelDir(channel);
  const { outName, sidecarName, sidecar } = dropFiles(channel, job, web);
  const finalPath = path.join(destDir, outName);
  const buildPath = dropPartPath(destDir, outName);
  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}-${stem.slice(0, 8)}.src`);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (job.kind === 'direct') await downloadDirect(job, tmpPath);
    else await downloadYtdlp(job, tmpPath, { quality });
    await embedMetadata(tmpPath, buildPath, job, web, 'mp4');
    commitDrop(channel, job, destDir, buildPath, finalPath, sidecarName, sidecar);
    return finalPath;
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
    fs.rm(buildPath, { force: true }, () => {});
  }
}

// Fetch a direct URL to disk, honouring the extractor's required headers.
// opts.onProgress({ percent, downloaded, total }) is called as bytes arrive.
async function downloadDirect(job, dest, opts = {}) {
  // Extractors may list lower-quality fallbackUrls for sites where the best
  // variant doesn't exist for every post (e.g. xxxfollow _fhd -> plain -> _sd).
  const urls = [job.downloadUrl, ...(job.fallbackUrls || [])];
  // Stall guard: a dead-but-open TCP connection would otherwise leave the job
  // hanging forever, permanently occupying one of the MAX_ACTIVE_JOBS slots.
  const ctrl = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(new Error('download stalled (no data for 120s)')), 120000);
    if (idleTimer.unref) idleTimer.unref();
  };
  armIdle();
  try {
  let upstream;
  for (const url of urls) {
    armIdle();
    // safeFetch re-checks every redirect hop: the media URL comes from the
    // page the extractor read, and a redirect is the way past a check that
    // only saw the address the user submitted.
    upstream = await safeFetch(url, { headers: job.headers || {}, signal: ctrl.signal });
    if (upstream.ok && upstream.body) break;
    // Drop the unconsumed body of a failed candidate so its socket is freed.
    if (upstream.body) upstream.body.cancel().catch(() => {});
  }
  if (!upstream.ok || !upstream.body) {
    // A 404/403 on the media URL usually means the file isn't published yet
    // (freshly-uploaded clips on sites like xfree render the page + metadata
    // before their CDN file is encoded). Flag these as retryable so the caller
    // can schedule a later attempt instead of treating it as a hard failure.
    const s = upstream.status;
    const err = new Error(
      s === 404 || s === 403
        ? `file not published yet (upstream HTTP ${s}) — will retry later`
        : `upstream HTTP ${s}`
    );
    err.status = s;
    err.retryable = [403, 404, 408, 425, 429, 500, 502, 503, 504].includes(s);
    throw err;
  }
  const total = Number(upstream.headers.get('content-length')) || 0;
  const src = Readable.fromWeb(upstream.body);
  src.on('data', armIdle);
  if (typeof opts.onProgress === 'function') {
    let downloaded = 0;
    let lastPct = -1;
    src.on('data', (chunk) => {
      downloaded += chunk.length;
      const percent = total ? Math.floor((downloaded / total) * 100) : null;
      if (percent !== lastPct) {
        lastPct = percent;
        opts.onProgress({ percent, downloaded, total });
      }
    });
  }
  await pipeline(src, fs.createWriteStream(dest));
  } finally {
    clearTimeout(idleTimer);
  }
}

// yt-dlp writes to the literal -o path for a single format, but when it has to
// MERGE separate video+audio it appends the merge extension (so `<dest>` becomes
// `<dest>.mp4`). Find whatever it actually produced for this dest.
function resolveYtdlpOutput(dest) {
  if (fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  try {
    // Never pick up yt-dlp's own in-progress/leftover files as the result.
    const match = fs
      .readdirSync(dir)
      .find((f) => f.startsWith(`${base}.`) && !/\.(part|ytdl|temp)$/i.test(f));
    if (match) return path.join(dir, match);
  } catch {
    /* ignore */
  }
  return null;
}

// Download an arbitrary site via yt-dlp into the temp file. opts.quality caps
// the picked resolution (e.g. 1080 -> only formats up to 1080p). opts.onProgress
// ({ percent, speed, eta }) is called as yt-dlp reports progress. Advanced opts
// (server-library only): opts.container (mp4|mkv|webm), opts.embedThumb,
// opts.embedSubs, opts.sponsorblock, opts.embedMeta let yt-dlp mux/embed the
// final file itself (the caller then skips the ffmpeg remux).
function downloadYtdlpRaw(job, dest, opts = {}) {
  return new Promise((resolve, reject) => {
    const q = opts.quality;
    const fmt = q
      ? `bv*[height<=${q}]+ba/b[height<=${q}]/bv*+ba/b`
      : 'bv*+ba/b';
    const wantProgress = typeof opts.onProgress === 'function';
    // TikTok's hevc (bytevc1) formats claim aac audio in metadata but the
    // actual streams are silent — prefer h264 there so downloads keep audio.
    const isTikTok = /(^|\.)tiktok\.com$/.test(
      (() => { try { return new URL(job.url).hostname; } catch { return ''; } })()
    );
    const ck = cookieArgs(job.url);
    const args = [
      '--no-warnings',
      '--no-playlist',
      ...ck.args,
      '-f',
      fmt,
      ...(isTikTok ? ['-S', 'vcodec:h264'] : []),
      '--merge-output-format',
      opts.container || 'mp4',
      ...(opts.embedThumb ? ['--embed-thumbnail'] : []),
      ...(opts.embedSubs ? ['--embed-subs'] : []),
      ...(opts.embedMeta ? ['--embed-metadata'] : []),
      ...sponsorArgs(opts.sponsorblock),
      ...(opts.extraArgs || []),
      ...(wantProgress
        ? ['--newline', '--no-color', '--progress-template', 'GRABBIT|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s']
        : []),
      '-o',
      dest,
      '--',
      job.url,
    ];
    const p = spawn(YTDLP, args);
    const timedOut = guardChild(p, 'yt-dlp');
    let err = '';
    // yt-dlp prints progress on stderr; pick out our templated lines and let the
    // rest accumulate as the error tail.
    const onLine = (line) => {
      if (line.startsWith('GRABBIT|')) {
        const [, pct, spd, eta] = line.split('|');
        const percent = parseFloat(pct);
        opts.onProgress({ percent: Number.isFinite(percent) ? percent : null, speed: (spd || '').trim(), eta: (eta || '').trim() });
      } else if (line.trim()) {
        err += line + '\n';
      }
    };
    const feed = (d) => { if (wantProgress) String(d).split('\n').forEach(onLine); else err += d; };
    p.stderr.on('data', feed);
    if (wantProgress) p.stdout.on('data', (d) => String(d).split('\n').forEach(onLine));
    p.on('error', (e) => {
      ck.cleanup();
      reject(e);
    });
    p.on('close', (code) => {
      ck.cleanup();
      // A non-zero exit means the download did not finish — a leftover partial
      // file must not be reported (and later imported) as a success.
      const out = code === 0 ? resolveYtdlpOutput(dest) : null;
      if (out) {
        // Normalize to the path the caller expects to read (embedMetadata etc.).
        if (out !== dest) {
          try {
            fs.renameSync(out, dest);
          } catch {
            /* fall through to the existsSync check below */
          }
        }
        if (fs.existsSync(dest)) return resolve();
      }
      reject(new Error(timedOut() || err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
    });
  });
}

// Extract audio-only from a yt-dlp site directly (bestaudio -> afmt). Writes to
// <destNoExt>.<afmt>; resolves with that path. opts.aq = yt-dlp --audio-quality
// ('0' best, or '<n>K'); opts.embedThumb embeds cover art.
function downloadYtdlpAudioRaw(job, destNoExt, afmt, opts = {}) {
  return new Promise((resolve, reject) => {
    // 'best' keeps the source codec, whose extension we can't predict — let
    // yt-dlp report it; for a known format the extension equals afmt.
    const ck = cookieArgs(job.url);
    const args = [
      '--no-warnings', '--no-playlist',
      ...ck.args,
      '-f', 'ba/b', '-x', '--audio-format', afmt,
      ...(opts.aq ? ['--audio-quality', opts.aq] : []),
      ...(opts.embedThumb ? ['--embed-thumbnail'] : []),
      ...sponsorArgs(opts.sponsorblock),
      ...(opts.extraArgs || []),
      '--embed-metadata',
      '-o', `${destNoExt}.%(ext)s`, '--', job.url,
    ];
    const p = spawn(YTDLP, args);
    const timedOut = guardChild(p, 'yt-dlp');
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      ck.cleanup();
      reject(e);
    });
    p.on('close', (code) => {
      ck.cleanup();
      const dir = path.dirname(destNoExt);
      const base = path.basename(destNoExt);
      // --embed-thumbnail leaves (converted) image files next to the audio;
      // they must never be picked as the result, nor left behind in tmp.
      const isImage = (f) => /\.(webp|png|jpe?g)$/i.test(f);
      let siblings = [];
      try {
        siblings = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`));
      } catch {
        /* fall through to the reject below */
      }
      for (const f of siblings.filter(isImage)) fs.rm(path.join(dir, f), { force: true }, () => {});
      // For a known format the file is <destNoExt>.<afmt>; for 'best' the codec
      // (and extension) is whatever the source was — find it.
      const known = `${destNoExt}.${afmt}`;
      if (code === 0) {
        if (afmt !== 'best' && fs.existsSync(known)) return resolve(known);
        const match = siblings.find((f) => !isImage(f) && !/\.(part|src|ytdl|temp)$/i.test(f));
        if (match) return resolve(path.join(dir, match));
      }
      reject(new Error(timedOut() || err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
    });
  });
}

// A premium/region-locked YouTube ID sometimes has a free counterpart (same
// recording, different video ID) — retry the download once against it before
// surfacing the error. See premium-fallback.js.
async function withYoutubeFallback(job, run) {
  try {
    return await run(job);
  } catch (e) {
    if (!isRecoverableYoutubeError(e && e.message)) throw e;
    // YouTube intermittently reports playable videos as unavailable — a plain
    // retry often clears it. Premium locks are deterministic, skip straight
    // to the counterpart lookup for those.
    if (!isMusicPremiumLock(e && e.message)) {
      try {
        await new Promise((r) => setTimeout(r, 2000));
        return await run(job);
      } catch {
        /* fall through to the counterpart lookup */
      }
    }
    const alt = await findFreeAlternate(job.url).catch(() => null);
    if (!alt) throw e;
    console.warn(`unavailable-video fallback (${alt.via}): ${job.url} -> ${alt.url}`);
    return run({ ...job, url: alt.url });
  }
}

function downloadYtdlp(job, dest, opts = {}) {
  return withYoutubeFallback(job, (j) => downloadYtdlpRaw(j, dest, opts));
}

function downloadYtdlpAudio(job, destNoExt, afmt, opts = {}) {
  return withYoutubeFallback(job, (j) => downloadYtdlpAudioRaw(j, destNoExt, afmt, opts));
}

// Strip the audio track out of an already-downloaded file (for 'direct' jobs
// where yt-dlp can't fetch audio-only). Re-encodes to the chosen format. aq is a
// bitrate like '192K' (applied to lossy codecs), or null for a sensible default.
function extractAudio(src, dest, afmt, aq) {
  return new Promise((resolve, reject) => {
    const br = aq && aq !== '0' ? aq : null; // lossy bitrate
    const codec =
      afmt === 'mp3' ? ['-c:a', 'libmp3lame', ...(br ? ['-b:a', br] : ['-q:a', '2'])]
      : afmt === 'opus' ? ['-c:a', 'libopus', '-b:a', br || '160k']
      : afmt === 'vorbis' ? ['-c:a', 'libvorbis', '-b:a', br || '192k']
      : afmt === 'flac' ? ['-c:a', 'flac']
      : afmt === 'wav' ? ['-c:a', 'pcm_s16le']
      : afmt === 'alac' ? ['-c:a', 'alac']
      : ['-c:a', 'aac', '-b:a', br || '192k']; // aac / m4a / aac / best fallback
    // -progress writes a keyframe block a second to stdout: nothing here parses
    // it, it is there so the watchdog can tell a slow transcode from a hung one.
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1',
      '-i', src, '-vn', ...codec, dest];
    const p = spawn(FFMPEG, args);
    const timedOut = guardChild(p, 'ffmpeg');
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return resolve();
      reject(new Error(timedOut() || err.trim().split('\n').pop() || 'audio extract failed'));
    });
  });
}

// Audio-only handler. For dest='server' the audio is saved into the library
// mp3 folder and reported as JSON; otherwise it's streamed to the browser (audio
// doesn't fit the shorts _import pipeline). quality is ignored for audio.
async function downloadAudio(res, job, url, afmt, dest) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const base = path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}`);
  const srcTmp = `${base}.src`;
  let outPath = `${base}.${afmt}`;
  const cleanup = [srcTmp, outPath];
  try {
    if (job.kind === 'ytdlp') {
      outPath = await downloadYtdlpAudio(job, base, afmt);
      // The real extension can differ from afmt (afmt=best, vorbis->ogg,
      // alac->m4a) — track the actual file or it leaks in tmp.
      if (!cleanup.includes(outPath)) cleanup.push(outPath);
    } else {
      await downloadDirect(job, srcTmp);
      await extractAudio(srcTmp, outPath, afmt);
    }

    if (dest === 'server') {
      const realExt = safeExt(path.extname(outPath).slice(1), afmt);
      const outName = `${stem}.${realExt}`;
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      const libPath = path.join(AUDIO_DIR, outName);
      fs.copyFileSync(outPath, libPath);
      recordHistory({
        creator: job.creator || null,
        title: job.title || null,
        channel: 'server/mp3',
        filename: outName,
        sourceUrl: job.sourceUrl || url,
        thumbnail: job.thumbnail || null,
        extractor: job.extractor || null,
        imported: false,
        device: false,
      });
      markDownloaded(job.sourceUrl || url, outName, job.site, job.mediaId, null, job);
      noteSourceMeta(job, outName, null);
      return res.json({ ok: true, saved: true, dest: 'server', dir: 'mp3', filename: outName });
    }

    // Name and type by what was actually produced, not the requested afmt
    // ('best' is not an extension, vorbis lands in .ogg, alac in .m4a).
    const streamExt = safeExt(path.extname(outPath).slice(1), afmt);
    const mime = audioMime(streamExt);
    res.setHeader('Content-Disposition', contentDisposition(`${stem}.${streamExt}`));
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', fs.statSync(outPath).size);
    recordHistory({
      creator: job.creator || null,
      title: job.title || null,
      channel: `audio/${afmt}`,
      filename: `${stem}.${afmt}`,
      sourceUrl: job.sourceUrl || url,
      thumbnail: job.thumbnail || null,
      extractor: job.extractor || null,
      imported: false,
      device: true,
    });
    await pipeline(fs.createReadStream(outPath), res);
  } catch (e) {
    console.error('audio download failed:', e);
    if (!res.headersSent) res.status(422).send('Audio download failed: ' + String(e.message || e));
    else res.destroy();
  } finally {
    for (const f of cleanup) fs.rm(f, { force: true }, () => {});
  }
}

// Server-library video handler: save a video into the chosen folder, with
// embedded metadata. Optionally also streams the file to the browser.
async function downloadServerVideo(res, job, url, { folder, quality, device }) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const dir = serverSaveDir(folder, job.creator);
  const shelf = serverShelf(folder, dir);
  const outName = `${stem}.mp4`;
  const libPath = path.join(dir, outName);
  const already = fs.existsSync(libPath);
  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}.src`);
  // Re-download of an existing library file (for a device copy) goes to a temp.
  const finalPath = already ? path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}.out.mp4`) : libPath;
  const cleanup = [tmpPath];
  if (already) cleanup.push(finalPath);
  try {
    if (already && !device) {
      return res.json({ ok: true, saved: false, dest: 'server', dir: shelf, message: 'Already in the library.' });
    }
    fs.mkdirSync(dir, { recursive: true });
    if (job.kind === 'direct') await downloadDirect(job, tmpPath);
    else await downloadYtdlp(job, tmpPath, { quality });
    await embedMetadata(tmpPath, finalPath, job, false);
    // Only a real library save gets a poster: with `already`, finalPath is a
    // throwaway temp for the device copy and the library file has one already.
    const histThumb = already ? job.thumbnail || null : await attachPoster(job, finalPath, { channel: `server/${shelf}` });

    const histEntry = {
      creator: job.creator || null,
      title: job.title || null,
      channel: `server/${shelf}`,
      filename: outName,
      sourceUrl: job.sourceUrl || url,
      thumbnail: histThumb,
      extractor: job.extractor || null,
      imported: false,
    };
    // Register a fresh library save (channel null: a server save must not make
    // a later shorts download look like a repeat) — matches finishJob.
    if (!already) markDownloaded(job.sourceUrl || url, outName, job.site, job.mediaId, null, job, `server/${shelf}`);
    if (!already) noteSourceMeta(job, outName, null);
    if (!device) {
      recordHistory({ ...histEntry, device: false });
      return res.json({ ok: true, saved: !already, dest: 'server', dir: shelf, filename: outName });
    }
    res.setHeader('Content-Disposition', contentDisposition(outName));
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', fs.statSync(finalPath).size);
    recordHistory({ ...histEntry, device: true });
    await pipeline(fs.createReadStream(finalPath), res);
  } catch (e) {
    console.error('server download failed:', e);
    if (!res.headersSent) res.status(422).send('Download failed: ' + String(e.message || e));
    else res.destroy();
  } finally {
    for (const f of cleanup) fs.rm(f, { force: true }, () => {});
  }
}

// Save a job's video into the server library (no streaming). Shared by the
// batch profile downloader for dest='server'.
async function saveJobToServer(job, folder, quality) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const dir = serverSaveDir(folder, job.creator);
  const finalPath = path.join(dir, `${stem}.mp4`);
  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}-${stem.slice(0, 8)}.src`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (job.kind === 'direct') await downloadDirect(job, tmpPath);
    else await downloadYtdlp(job, tmpPath, { quality });
    await embedMetadata(tmpPath, finalPath, job, false);
    return finalPath;
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
}

// Is this clip already in the chosen server-library folder?
function serverHas(folder, creator, stem) {
  try {
    return fs.existsSync(path.join(serverSaveDir(folder, creator), `${stem}.mp4`));
  } catch {
    return false;
  }
}

// --- Images ---------------------------------------------------------------
// Images don't belong in a video pipeline, so they get their own two targets:
// dest=elite drops them into the posts import (they become posts), any
// other destination saves them in the plain photos library (extension
// preserved). Used for mixed albums like erome, where the videos go to shorts
// and the pictures to posts.

// Already in the photos library (any extension)?
function photoHas(stem) {
  try {
    return fs.readdirSync(PHOTOS_DIR).some((f) => f.startsWith(`${stem}.`));
  } catch {
    return false;
  }
}

// Mirror creatorUsername() in elite-v2's scripts/import-posts.mjs: a drop
// subfolder's NAME is the creator there, so build it exactly the same way and
// the images file under the creator the importer would have resolved anyway.
function postsCreator(name) {
  return (
    String(name || 'unknown')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 30) || 'unknown'
  );
}

function postsImportDir(creator) {
  const unavailable = postsUnavailable();
  if (unavailable) throw new Error(unavailable);
  return path.join(POSTS_IMPORT_DIR, postsCreator(creator));
}

// Create a drop folder elite-v2 can write to as well. mkdir's mode is masked by
// the umask, which strips the group/other write bit — and on this ACL-carrying
// tree that also cuts the ACL mask down, leaving the importer unable to delete
// what it just imported (it then skips every file, forever). chmod is not
// masked, so set the mode explicitly afterwards.
function makeDropDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  try {
    fs.chmodSync(dir, 0o777);
  } catch {
    /* someone else's folder — its mode is already whatever it needs to be */
  }
}

// Is this image already waiting in the creator's posts drop folder?
function postsPending(creator, stem) {
  try {
    return fs.readdirSync(postsImportDir(creator)).some((f) => f.startsWith(`${stem}.`));
  } catch {
    return false;
  }
}

// Where an image goes for a given destination, and whether it is already there.
// 'imported' means the photos library has it (nothing consumes that folder);
// 'pending' means it is still queued for the posts importer.
function imageStatus(creator, stem) {
  if (postsPending(creator, stem)) return 'pending';
  return photoHas(stem) ? 'imported' : null;
}

// Download a direct image into the photos library; returns its path.
async function saveImageToLibrary(job) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const ext = safeExt(job.ext, 'jpg');
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const finalPath = path.join(PHOTOS_DIR, `${stem}.${ext}`);
  await downloadDirect(job, finalPath);
  return finalPath;
}

// Download an image into the posts import, under the creator's own drop
// folder, next to the JSON sidecar the posts importer reads: `description` is
// the caption (its #tags become the post's hashtags) and `post_shortcode`
// groups everything from one album into a single carousel post instead of one
// post per picture. The file itself is fetched under a dot-name (both importers
// skip dotfiles) and renamed last, so a run that starts mid-download never
// picks up half a picture — or a picture without its caption.
async function saveImageToPosts(job, channel) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const ext = safeExt(job.ext, 'jpg');
  const outName = `${stem}.${ext}`;
  const dir = postsImportDir(job.creator);
  // The audience gate, as the last step before the posts folder is touched.
  // An image saved under the 18+ channel meets Adshortis' videos-only rule
  // here, never the posts library's.
  assertDeliverable(destinationOf(channel, { ...job, mediaType: 'image' }), job);
  // Elitogram imports only real pictures; refuse anything else before fetching
  // it (publish() checks again inside the lock).
  const badExt = POSTS_TO_EGRAM ? postsPublish.egramExtRefusal(ext) : null;
  if (badExt) throw new Error(badExt);
  makeDropDir(dir);
  // Each attempt downloads into its own staged file, so two saves of the same
  // name never write to one path.
  const partPath = path.join(dir, `.${outName}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  let published;
  try {
    await downloadDirect(job, partPath);
    // Publishing (existence check, sidecar, image) is one step per name; see
    // posts-publish.js for the rules, including source identity.
    published = await postsPublish.publish({
      dir,
      stem,
      ext,
      partPath,
      egram: POSTS_TO_EGRAM,
      id: POSTS_TO_EGRAM ? postsPublish.sourceId(job) : null,
      lock: withPostsNameLock,
      sidecar: () => {
        // The creator may have been classified 18+ while the picture downloaded:
        // judge it again before anything becomes visible to an importer.
        const dest = destinationOf(channel, { ...job, mediaType: 'image' });
        assertDeliverable(dest, job);
        return POSTS_TO_EGRAM
          ? egramSidecar(job, classifyJob(dest, job).audience)
          : { description: buildCaption(job), post_shortcode: job.albumId || null };
      },
    });
  } finally {
    fs.rmSync(partPath, { force: true });
  }
  const publishedPath = path.join(dir, published);
  recordDrop('posts', job, published, publishedPath);
  return { path: publishedPath, name: published, creator: postsCreator(job.creator) };
}

// Is this image already saved under its exact name? For Elitogram the name is
// not proof of the source: another source with the same title and extension
// gets the same name, so the stem's sidecar must record this source. If it
// does not, publication runs and gives the new source a name of its own.
function imageAlreadySaved(toPosts, dir, stem, libPath, job) {
  if (!fs.existsSync(libPath)) return false;
  if (!toPosts || !POSTS_TO_EGRAM) return true;
  return postsPublish.sourceIdOf(path.join(dir, `${stem}.json`)) === postsPublish.sourceId(job);
}

// One publication at a time per posts drop name (see saveImageToPosts).
const withPostsNameLock = postsPublish.createNameLock();

// A drop sidecar, written whole or not at all: a dot-named temp file (both
// importers skip dotfiles), fsynced, then renamed into place. The temp name is
// unique per write, so two writers never share it.

// The sidecar Elitogram's importer reads next to <stem>.<ext>. `post_key`
// groups an album into one carousel and makes a re-delivery a no-op
// (Elitogram stores it as source_key grabbit:<post_key>); `audience` is the
// item's audience as Grabbit classified it (general only by hand, 18+ sets
// Elitogram's flag); `meta` is shown on the post.
function egramSidecar(job, aud) {
  const site = String(job.site || job.extractor || 'web').toLowerCase().replace(/[^a-z0-9.-]+/g, '').slice(0, 40) || 'web';
  const own = job.albumId || job.mediaId || null;
  const postKey = own ? `${site}:${String(own)}`.replace(/[^\w.:-]+/g, '_').slice(0, 200) : null;
  const postUrl = typeof job.sourceUrl === 'string' && /^https:\/\//.test(job.sourceUrl) ? job.sourceUrl : null;
  return {
    source: 'grabbit',
    caption: buildCaption(job),
    post_url: postUrl,
    post_key: postKey,
    audience: aud === 'general' || aud === 'adult' ? aud : 'unknown',
    meta: {
      platform: site,
      tags: Array.isArray(job.tags) ? job.tags.slice(0, 30).map((t) => String(t).slice(0, 60)) : [],
      downloaded_at: new Date().toISOString(),
      origin: 'grabbit',
    },
  };
}

// Single-image handler: save it (posts import or photos library, per dest) and
// optionally stream it to the device too.
async function downloadImage(res, job, url, device, dest, channel) {
  const toPosts = dest === 'elite';
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const ext = safeExt(job.ext, 'jpg');
  const outName = `${stem}.${ext}`;
  const dir = toPosts ? postsImportDir(job.creator) : PHOTOS_DIR;
  let libPath = path.join(dir, outName);
  let fileName = outName;
  const already = imageAlreadySaved(toPosts, dir, stem, libPath, job);
  try {
    if (!already) {
      if (toPosts) {
        // Publication may keep an image already there under the same stem with
        // another extension; report and stream the file that is actually there.
        const saved = await saveImageToPosts(job, channel);
        libPath = saved.path;
        fileName = saved.name;
      } else {
        fs.mkdirSync(PHOTOS_DIR, { recursive: true });
        await downloadDirect(job, libPath);
      }
    }
    recordHistory({
      creator: job.creator || null,
      title: job.title || null,
      channel: toPosts ? 'elite/posts' : 'server/photos',
      filename: fileName,
      sourceUrl: job.sourceUrl || url,
      thumbnail: job.thumbnail || null,
      extractor: job.extractor || null,
      imported: toPosts,
      device: !!device,
    });
    if (!device) {
      return res.json(
        toPosts
          ? { ok: true, saved: !already, dest: 'elite', dir: 'posts', creator: postsCreator(job.creator), filename: fileName }
          : { ok: true, saved: !already, dest: 'server', dir: 'photos', filename: fileName }
      );
    }
    res.setHeader('Content-Disposition', contentDisposition(fileName));
    res.setHeader('Content-Type', imageMime(path.extname(fileName).slice(1)));
    res.setHeader('Content-Length', fs.statSync(libPath).size);
    await pipeline(fs.createReadStream(libPath), res);
  } catch (e) {
    console.error('image download failed:', e);
    // 422, never 5xx: a proxy such as Cloudflare would replace a 5xx body with its own page.
    if (!res.headersSent) res.status(422).send('Image download failed: ' + String(e.message || e));
    else res.destroy();
  }
}

// Probe the source's video codec (lowercase), '' on failure.
// ---------------------------------------------------------------------------
// Video posters.
//
// Three things want a picture for a saved video: a <name>.jpg beside the file
// so a file browser (or Plex) shows a preview, cover art inside the mp4 for
// players that read it, and a thumbnail in grabbit's own download history for
// the sites that hand over none. All three want the same picture, so it is
// produced once: the site's own thumbnail when there is one, otherwise a frame
// from the file itself.

// A frame from the video as JPEG bytes, or null. Taken a fifth of the way in
// rather than at 0:00 — a clip routinely opens on a black fade-in, and a black
// poster is worse than no poster.
function frameFromVideo(src, duration) {
  const at = Number.isFinite(duration) && duration > 2 ? Math.min(duration * 0.2, 10) : 1;
  return ffmpegJpeg(['-ss', String(at), '-i', src]);
}

function frameFromImage(src) {
  return ffmpegJpeg(['-i', src]);
}

// One JPEG at most 640 wide from ffmpeg, or null. Killed after 30 s: a stuck
// read (a file on a hung NFS mount) must not hold a thumbnail slot forever.
function ffmpegJpeg(inputArgs) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...inputArgs, '-frames:v', '1',
      '-vf', "scale='min(640,iw)':-2", '-q:v', '4', '-f', 'mjpeg', 'pipe:1',
    ]);
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    // Unread stderr fills its pipe and deadlocks ffmpeg on a chatty input.
    p.stderr.resume();
    p.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    p.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      // A JPEG of a real frame is kilobytes; anything tiny is ffmpeg giving up
      // (a seek past the end, an unreadable stream).
      resolve(buf.length > 1000 ? buf : null);
    });
  });
}

// The picture for a saved video: the site's thumbnail (through the same cache
// the UI loads it from) or a frame from the file. { buf, ext } or null.
async function posterFor(job, videoPath) {
  if (job && job.thumbnail && /^https?:\/\//i.test(job.thumbnail)) {
    try {
      const key = thumbKey(job.thumbnail);
      const hit = cachedUrlThumb(key);
      if (hit) return { buf: fs.readFileSync(hit.file), ext: hit.ext };
      const got = await fetchThumb(job.thumbnail);
      // Keep it for the UI too — a card is about to ask for the same picture.
      try {
        writeThumbFile(urlCacheName(key), got.buf, got.ext);
      } catch {
        /* an unwritable cache costs nothing here */
      }
      return got;
    } catch {
      // The site's picture is gone or refused: fall through to the video.
    }
  }
  const buf = await frameFromVideo(videoPath, job && job.duration);
  return buf ? { buf, ext: 'jpg' } : null;
}

// Mux the poster into an .mp4 as cover art: a stream copy plus one attached
// picture, never a re-encode, so a failure costs nothing and the file is left
// exactly as it was.
function embedCoverArt(file, poster) {
  return new Promise((resolve) => {
    if (!/\.mp4$/i.test(file)) return resolve(false);
    const out = `${file}.cover.mp4`;
    const done = (ok) => {
      if (!ok) fs.rm(out, { force: true }, () => {});
      resolve(ok);
    };
    const p = spawn(FFMPEG, [
      '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', file, '-i', poster,
      '-map', '0', '-map', '1', '-c', 'copy',
      '-disposition:v:1', 'attached_pic', '-movflags', '+faststart', out,
    ]);
    p.stderr.resume();
    p.on('error', () => done(false));
    p.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) return done(false);
      try {
        fs.renameSync(out, file);
        resolve(true);
      } catch {
        done(false);
      }
    });
  });
}

// Give a finished library video its poster. Best effort throughout: a video is
// a successful download with or without a picture, so nothing here throws.
// Returns the thumbnail URL the history entry should carry — the site's own
// when it had one, otherwise a local id for the frame that was just taken.
async function attachPoster(job, libPath, opts = {}) {
  const fromSite = job && job.thumbnail ? job.thumbnail : null;
  try {
    const poster = await posterFor(job, libPath);
    if (!poster) return fromSite;
    const side = libPath.replace(/\.[^./]+$/, '') + '.' + poster.ext;
    try {
      fs.writeFileSync(side, poster.buf);
      if (opts.embed !== false) await embedCoverArt(libPath, side);
    } catch (e) {
      console.warn('poster sidecar failed:', e.message);
    }
    if (fromSite) return fromSite;
    // The frame belongs to this download's registry entry (H47); the history
    // row that names it records itself too.
    const src = job.sourceUrl || job.url;
    const ref = src ? `r:${mediaKey(src)}` : `j:${job.id || 'none'}`;
    const id = storeFrame(ref, thumbIn(job, opts.channel === undefined ? jobClassChannel(job) : opts.channel), poster.buf, poster.ext);
    return id ? `/api/thumb?id=${id}` : null;
  } catch (e) {
    console.warn('poster failed:', e.message);
    return fromSite;
  }
}

function videoCodec(src) {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src],
      { encoding: 'utf8' }
    );
    return out.trim().toLowerCase();
  } catch {
    return '';
  }
}

// Write the file into an mp4 with source URL + hashtags in its metadata. With
// web=true the output is a web-optimized .web.mp4 matching elite-v2's transcoder
// (transcode-shorts.mjs): an already-H.264 source just gets a faststart
// stream-copy, anything else is fully re-encoded to H.264/AAC capped at 1080p —
// so the clip lands "ready" and the transcoder skips it. On any ffmpeg failure,
// fall back to a plain file copy.
// `dest` may be a .part file being built in place, and ffmpeg picks its muxer
// from the output extension — an unknown one makes it refuse to start, and the
// fallback copy below would then quietly ship a clip with no metadata, no
// faststart and, for a web file, no transcode. So the container is stated
// outright whenever the name does not carry it.
function embedMetadata(src, dest, job, web, format) {
  return new Promise((resolve) => {
    const caption = buildCaption(job);
    const tags = (job.tags || []).map((t) => (t.startsWith('#') ? t : '#' + t)).join(' ');
    const meta = [
      '-metadata', `title=${job.title || ''}`,
      '-metadata', `artist=${job.creator || ''}`,
      '-metadata', `comment=${job.sourceUrl || ''}`,
      '-metadata', `description=${caption}`,
      '-metadata', `synopsis=${caption}`,
      '-metadata', `keywords=${tags}`,
    ];
    // Re-encode only when a web file is requested AND the source isn't already
    // H.264 (which only needs a faststart remux). Mirrors transcode-shorts.mjs.
    const reencode = web && videoCodec(src) !== 'h264';
    const codecArgs = reencode
      ? [
          '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-preset', 'veryfast',
          '-crf', '26', '-maxrate', '1800k', '-bufsize', '3600k',
          '-vf', "scale='min(1080,iw)':-2", '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
          '-movflags', '+faststart',
        ]
      : ['-map', '0', '-c', 'copy', '-movflags', '+faststart'];
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-i', src,
      ...codecArgs, ...meta, ...(format ? ['-f', format] : []), dest,
    ];
    const p = spawn(FFMPEG, args);
    const timedOut = guardChild(p, 'ffmpeg');
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => fallbackCopy());
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return resolve();
      console.warn('ffmpeg metadata failed, copying raw:', timedOut() || err.trim().split('\n').pop());
      fallbackCopy();
    });
    function fallbackCopy() {
      try {
        fs.copyFileSync(src, dest);
      } catch (e) {
        console.error('fallback copy failed:', e.message);
      }
      resolve();
    }
  });
}

// Make sure the server library folders exist up front (incl. the reserved
// photos folder for a later feature).
for (const dir of [VIDEOS_DIR, AUDIO_DIR, ADULTS_DIR, PHOTOS_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort; created on demand otherwise */
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `grabbit listening on :${PORT}, shorts roots main=${CHANNEL_ROOTS.main || '(unset)'} ` +
      `18plus=${CHANNEL_ROOTS['18plus'] || '(unset)'} platform=${CHANNEL_ROOTS.platform || '(unset)'} posts=${POSTS_IMPORT_DIR || '(unset)'}`
  );
  // Which mode the gate ended up in, so a wide-open service is visible in the
  // log rather than only in a request that should have been refused.
  console.log(
    GRABBIT_PASSWORD
      ? `auth: password gate ON, internal bypass ${INTERNAL_TOKEN ? 'requires X-Grabbit-Token' : 'OFF — set GRABBIT_INTERNAL_TOKEN to let co-hosted callers through'}`
      : 'auth: OFF (GRABBIT_AUTH_DISABLED=1) — every request is allowed'
  );
  countYtdlpExtractors();
});
