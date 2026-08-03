// grabbit - plugin-based media grabber.
// Resolve a pasted URL, embed source + hashtags into the file metadata, name it
// for the elite-v2 shorts importer, save it into the chosen channel's _import
// folder (with a .md caption sidecar) and stream the result to the browser.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const extractors = require('./extractors');
const { cleanDescription } = require('./extractors/util');
const { cookieArgs, sanitizeCookieName, listCookieFiles, saveCookieFile, deleteCookieFile } = require('./cookies');
const { isRecoverableYoutubeError, isMusicPremiumLock, findFreeAlternate } = require('./premium-fallback');

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
// Root of the elite-v2 shorts store (a host folder bind-mounted here). Files
// land in <root>/<channel>/_import/ where the elite-v2 timer auto-imports them.
const ELITE_ROOT = process.env.ELITE_ROOT || '/elitev2-shorts';
const CHANNELS = { main: 'main', '18plus': '18plus' };
// Root of the elite-v2 posts store (a host folder bind-mounted here). Images
// saved with dest=elite land in <root>/_import/<creator>/ where elite-v2's posts
// importer turns each drop folder into that creator's posts.
const POSTS_ROOT = process.env.ELITE_POSTS_ROOT || '/elitev2-posts';
const POSTS_IMPORT_DIR = process.env.ELITE_POSTS_IMPORT_DIR || path.join(POSTS_ROOT, '_import');
// Audio extraction targets (yt-dlp --audio-format). 'best' keeps the source codec.
const AUDIO_FORMATS = ['best', 'm4a', 'mp3', 'opus', 'flac', 'wav', 'vorbis', 'aac', 'alac'];
// Output containers for a server-library video save (yt-dlp --merge-output-format).
const VIDEO_CONTAINERS = ['mp4', 'mkv', 'webm'];
const DATA_DIR = process.env.DATA_DIR || '/data';

// Plain server download library (alternative to the elite-v2 import). Files are
// auto-routed by type; PHOTOS_DIR takes the images that are not sent to posts.
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/downloads';
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
  return v === 'server' || v === 'navidrome' || v === 'audiobooks' ? v : 'elite';
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
  if (SERVER_VIDEO_FOLDERS[folder]) return SERVER_VIDEO_FOLDERS[folder];
  return path.join(DOWNLOAD_DIR, sanitizeFolder(folder));
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

// Shorts are short clips, so a long video must not be imported into the elite-v2
// shorts library — it belongs in the plain server library instead. The cap (in
// seconds) is configurable; 0 disables the guard.
const SHORTS_MAX_DURATION = (() => {
  const n = parseInt(process.env.SHORTS_MAX_DURATION, 10);
  return Number.isFinite(n) && n >= 0 ? n : 600;
})();
function durationKnown(job) {
  return Number.isFinite(Number(job && job.duration));
}
function tooLongForShorts(job) {
  return SHORTS_MAX_DURATION > 0 && durationKnown(job) && Number(job.duration) > SHORTS_MAX_DURATION;
}
function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
function shortsTooLongError(job) {
  return `This video is ${fmtClock(job.duration)} long — too long for shorts (max ${fmtClock(SHORTS_MAX_DURATION)}). Save it to the server library instead.`;
}
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = 200;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* ignore */
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
  try {
    const list = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    // Backfill ids for any legacy entries so every row is deletable.
    return list.map((e, i) => (e.id ? e : { ...e, id: `legacy-${e.time || 0}-${i}` }));
  } catch {
    return [];
  }
}

// Prepend an entry and keep the log bounded.
function recordHistory(entry) {
  try {
    const list = readHistory();
    const id = `${Date.now()}-${historySeq++}`;
    list.unshift({ id, time: Date.now(), ...entry });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch (e) {
    console.warn('history write failed:', e.message);
  }
}

// Remove one entry by id, or all when id is omitted. Returns the new count.
function deleteHistory(id) {
  const list = id ? readHistory().filter((e) => e.id !== id) : [];
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list));
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
    try {
      downloadedCache = JSON.parse(fs.readFileSync(DOWNLOADED_FILE, 'utf8'));
    } catch {
      // First run: seed from the history log so earlier downloads count too.
      downloadedCache = {};
      for (const e of readHistory()) {
        if (e.sourceUrl) downloadedCache[mediaKey(e.sourceUrl)] = { filename: e.filename || null, at: e.time || Date.now() };
      }
      try {
        fs.writeFileSync(DOWNLOADED_FILE, JSON.stringify(downloadedCache));
      } catch {
        /* best effort */
      }
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

function markDownloaded(sourceUrl, filename, site, mediaId, channel) {
  if (!sourceUrl) return;
  const map = readDownloaded();
  const entry = { filename: filename || null, at: Date.now(), channel: channel || null };
  map[mediaKey(sourceUrl)] = entry;
  const key = idKey(site, mediaId);
  if (key) map[key] = entry;
  try {
    fs.writeFileSync(DOWNLOADED_FILE, JSON.stringify(map));
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
    try {
      const data = JSON.parse(fs.readFileSync(MUSIC_FILE, 'utf8'));
      musicCache = Array.isArray(data.tracks) ? data.tracks : [];
      musicLastScan = Number(data.lastScan) || 0;
    } catch {
      musicCache = [];
    }
  }
  return musicCache;
}

function writeMusic(tracks) {
  musicCache = tracks;
  // Invalidates the artist/title index built for library lookups.
  musicVersion++;
  try {
    fs.writeFileSync(MUSIC_FILE, JSON.stringify({ lastScan: musicLastScan, tracks }));
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
function musicNorm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFKD')
    // Noise the sites add to a title but a music library never keeps.
    .replace(/\((?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visualizer|hd|hq)\)/g, ' ')
    .replace(/\[(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|visualizer|hd|hq)\]/g, ' ')
    // "Artist - Topic" is YouTube's auto-generated channel for a real artist.
    .replace(/\s*-\s*topic\s*$/, ' ')
    .replace(/[\u0300-\u036f]/g, '')
    // Keep letters from every script — a CJK or Cyrillic title is still a
    // title, and dropping it would make those tracks unmatchable.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    // Upload-quality noise that survived the bracket forms above ("\u2026 HD",
    // "\u2026 official video", "\u2026 4k remaster"). Only ever trailing words \u2014 the
    // same words inside a title are part of it.
    .replace(/(?:\s+(?:official|music|video|audio|lyrics?|visualizer|remastered?|hd|hq|4k|mv))+$/, '')
    .trim();
}

// One credit line can name several artists ("Rocco, Pulsedriver & Ninkid"),
// and the two sides of a comparison rarely split them the same way. Every
// component is indexed alongside the whole line so either spelling matches.
function artistParts(artists) {
  const out = [];
  for (const a of artists || []) {
    const whole = musicNorm(a);
    if (whole) out.push(whole);
    for (const piece of String(a).split(/\s*(?:,|&|\/|\+|\bfeat\.?\b|\bft\.?\b|\bvs\.?\b|\bx\b|\bwith\b)\s*/i)) {
      const n = musicNorm(piece);
      if (n && n !== whole) out.push(n);
    }
  }
  return [...new Set(out)];
}

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

// What a video title might mean as a song title. Video titles are written as
// "Artist - Song" far more often than a tagged library is, so the artist
// prefix has to come off before the two can be compared. A suffix like
// "(Live ...)" is deliberately kept — that is a different recording.
function titleCandidates(title, artists) {
  const base = musicNorm(title);
  if (!base) return [];
  const out = [base];
  const dash = String(title).split(/\s+[-–—]\s+/);
  if (dash.length > 1) {
    const tail = musicNorm(dash.slice(1).join(' - '));
    if (tail) out.push(tail);
  }
  for (const a of (artists || []).filter(Boolean)) {
    const na = musicNorm(a);
    if (!na) continue;
    for (const c of [...out]) {
      if (c.startsWith(na + ' ')) out.push(c.slice(na.length + 1));
    }
  }
  return [...new Set(out)].filter(Boolean);
}

// A track already in a Navidrome library, or null. `weak` means only the title
// matched (the artist read differently on the two sides) — enough to warn about
// but never enough to skip a download on its own.
// Does `name` appear as whole words inside `text`? Both are already normalised
// to lowercase words, so padding makes this a word-boundary test.
function namedIn(name, text) {
  return name.length >= 3 && ` ${text} `.includes(` ${name} `);
}

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
    const p = spawn('python3', ['-c', READ_DESC_SCRIPT, file]);
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
    const p = spawn('python3', ['-c', READ_TAGS_SCRIPT]);
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
      const missing = !seen.has(musicKey(t.lib, t.file));
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
  try {
    return JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writePlaylists(list) {
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(list));
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
const GRABBIT_PASSWORD = process.env.GRABBIT_PASSWORD || '';
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
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isInternal = (req) =>
  !req.headers['x-forwarded-host'] &&
  (!INTERNAL_TOKEN || req.headers['x-grabbit-token'] === INTERNAL_TOKEN);
const isAuthed = (req) => parseCookies(req.headers.cookie)[AUTH_COOKIE] === AUTH_TOKEN;

function loginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grabbit — sign in</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
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
  <img src="/logo.svg" alt="" width="72" height="72" style="display:block;margin:0 auto 10px">
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

app.post('/login', (req, res) => {
  if (!GRABBIT_PASSWORD) return res.redirect('/');
  const ok =
    typeof req.body.password === 'string' &&
    req.body.password.length === GRABBIT_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(req.body.password), Buffer.from(GRABBIT_PASSWORD));
  if (!ok) return res.status(401).type('html').send(loginPage('Wrong password.'));
  res.cookie(AUTH_COOKIE, AUTH_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 30 * 24 * 3600 * 1000,
  });
  res.redirect('/');
});

app.post('/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.redirect('/login');
});

// Icons are needed by the login page and browser tabs before auth. The PWA
// manifest and service worker must also stay reachable without a session,
// otherwise install and SW updates break when the auth cookie expires.
const PUBLIC_ASSETS = new Set([
  '/favicon.svg',
  '/logo.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
  '/sw.js',
]);

// Gate everything below for external, unauthenticated requests. API calls get a
// 401 JSON; page/asset requests are redirected to the login form.
app.use((req, res, next) => {
  if (PUBLIC_ASSETS.has(req.path)) return next();
  if (!GRABBIT_PASSWORD || isInternal(req) || isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

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
  try {
    const list = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function savePushSubs() {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubs));
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

function notifyJobFinished(j) {
  const name = j.title || j.filename || j.sourceUrl || 'download';
  sendPush(
    j.status === 'done'
      ? { title: 'Download complete', body: name, tag: 'job-' + j.id, url: '/?tab=queue' }
      : { title: 'Download failed', body: name + (j.error ? ' — ' + j.error : ''), tag: 'job-' + j.id, url: '/?tab=queue' }
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
  try {
    const list = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function cleanRuleStr(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// A pattern is a case-insensitive substring, or /…/ for a regex.
function validRulePattern(p) {
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
    try {
      new RegExp(p.slice(1, -1), 'i');
    } catch {
      return false;
    }
  }
  return true;
}

function ruleTextMatch(pattern, value) {
  const v = String(value || '');
  const p = String(pattern);
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
    try {
      return new RegExp(p.slice(1, -1), 'i').test(v);
    } catch {
      return false;
    }
  }
  return v.toLowerCase().includes(p.toLowerCase());
}

// Whitelist every field: rules come from the (authed) UI but are stored and
// replayed into download params, so enum-validate like any other request input.
function sanitizeRules(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const r of input.slice(0, 100)) {
    if (!r || typeof r !== 'object') continue;
    const match = r.match && typeof r.match === 'object' ? r.match : {};
    const apply = r.apply && typeof r.apply === 'object' ? r.apply : {};
    const m = {};
    for (const k of ['site', 'creator', 'title']) {
      const v = cleanRuleStr(match[k], 200);
      if (v && validRulePattern(v)) m[k] = v;
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
  return out;
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
  const rules = sanitizeRules(req.body && req.body.rules);
  if (!rules) return res.status(400).json({ ok: false, error: 'Invalid rules payload' });
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules));
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

function channelDir(channel) {
  const ch = CHANNELS[channel] || 'main';
  return path.join(ELITE_ROOT, ch, '_import');
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
function importedStatus(channel, creator, stem) {
  const ch = CHANNELS[channel] || 'main';
  const root = path.join(ELITE_ROOT, ch);
  try {
    const profDir = path.join(root, profileSlug(safeCreator(creator)));
    if (fs.existsSync(profDir)) {
      const files = fs.readdirSync(profDir);
      if (files.includes(`${stem}.mp4`) || files.includes(`${stem}.web.mp4`)) return 'imported';
    }
  } catch {
    /* ignore */
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
function tagAudio(src, tags) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-c', TAG_SCRIPT, src, JSON.stringify(tags)]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(err.trim().split('\n').pop() || 'tagging failed'));
    });
  });
}

// Content-Disposition value safe for non-ASCII names (RFC 6266): an ASCII
// fallback plus a UTF-8 filename* so ÅÄÖ etc. survive the download.
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

// GET /api/resolve?url=... -> metadata preview.
app.get('/api/resolve', async (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  try {
    const job = await extractors.resolve(url);
    const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
    const isImage = job.mediaType === 'image';
    res.json({
      ok: true,
      extractor: job.extractor,
      creator: job.creator || null,
      title: job.title || null,
      tags: job.tags || [],
      thumbnail: job.thumbnail || null,
      duration: durationKnown(job) ? Number(job.duration) : null,
      mediaType: isImage ? 'image' : 'video',
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
      // Whether this clip is already in elite-v2, per channel (for a UI warning).
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
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch {
    return [];
  }
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
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(list));
  res.json({ ok: true, templates: list });
});

// POST /api/templates/delete?id=...
app.post('/api/templates/delete', (req, res) => {
  const list = readTemplates().filter((t) => t.id !== String(req.query.id));
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(list));
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
      res.json({ ok: true, results });
    } catch {
      fail(err.trim().split('\n').pop() || 'Search failed');
    }
  });
});

// "A & B feat. C" -> ['A', 'B', 'C']: the separators music databases use in
// their artist strings. Only for database/site strings — user-typed fields go
// through splitList, where '&' must survive ("Hootie & the Blowfish", "R&B").
function splitArtists(s) {
  return String(s || '')
    .split(/\s*[,&;]\s*|\s+(?:featuring|feat\.?|ft\.?)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

// User-typed comma/semicolon-separated lists (the artists/genres fields).
function splitList(s) {
  return String(s || '')
    .split(/\s*[,;]\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// The genres field takes whichever separator was at hand: hashtags copied off
// a track page ("#neurofunk #darkdnb"), a comma list ("Drum & Bass, Techno") or
// plain words ("neurofunk darkdnb dnb"). The separator is picked from what the
// text actually contains, so a multi-word genre survives as long as it is
// written with the separator its neighbours use — spaces only split a line
// that has neither hashtags nor commas.
function splitGenres(s) {
  const text = String(s || '').trim();
  if (!text) return [];
  // "Drum & Bass" or "Rhythm and Blues" is one genre, not three words: a
  // connector means the spaces belong to the name, so it is left whole.
  const glued = /(?:^|\s)(?:&|and|n|of|the|y)(?:\s|$)/i.test(text);
  const parts = text.includes('#')
    ? text.split('#')
    : /[,;]/.test(text)
      ? text.split(/[,;]/)
      : glued
        ? [text]
        : text.split(/\s+/);
  const out = [];
  for (const p of parts) {
    // Hashtag style is written without spaces; a stray one is not a separator.
    const g = p.trim().replace(/\s+/g, ' ');
    if (g && !out.some((x) => x.toLowerCase() === g.toLowerCase())) out.push(g);
  }
  return out;
}

// Genres the user has typed at least once. The library's own genres (read off
// the music log) already make a decent vocabulary, but a genre only becomes
// visible there once a track carrying it has been saved — this file remembers
// the moment it was entered, so the picker can offer it right away.
const GENRES_FILE = path.join(DATA_DIR, 'genres.json');
let typedGenresCache = null;

function readTypedGenres() {
  if (!typedGenresCache) {
    try {
      const list = JSON.parse(fs.readFileSync(GENRES_FILE, 'utf8'));
      typedGenresCache = Array.isArray(list) ? list.filter((g) => typeof g === 'string') : [];
    } catch {
      typedGenresCache = [];
    }
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
    fs.writeFileSync(GENRES_FILE, JSON.stringify(list));
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

// Song metadata candidates from public music databases (iTunes Search +
// Deezer, both keyless). Candidates: {source, title, artists[], album, date,
// genres[], cover}. Used by the /api/music-meta endpoint (UI auto-fill) and
// by the download-time genre auto-fill.
async function musicMetaCandidates(q) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const key = (c.artists.join(',') + '|' + c.title).toLowerCase();
    if (c.title && c.artists.length && !seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  };
  const jfetch = async (u) => {
    // accept-language pins Deezer's localized genre names to English.
    const r = await fetch(u, { headers: { 'user-agent': 'grabbit/1.0', 'accept-language': 'en' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return r.json();
  };
  // Both lookups run in parallel; either one failing alone is fine.
  const [itunes, deezer] = await Promise.allSettled([
    jfetch(`https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(q)}`),
    jfetch(`https://api.deezer.com/search?limit=4&q=${encodeURIComponent(q)}`),
  ]);
  if (itunes.status === 'fulfilled') {
    for (const r of itunes.value.results || []) {
      push({
        source: 'itunes',
        title: r.trackName || null,
        artists: splitArtists(r.artistName),
        album: r.collectionName || null,
        date: r.releaseDate ? String(r.releaseDate).slice(0, 10) : null,
        genres: r.primaryGenreName ? [r.primaryGenreName] : [],
        cover: r.artworkUrl100 || null,
      });
    }
  }
  if (deezer.status === 'fulfilled') {
    const rows = deezer.value.data || [];
    // Deezer's search rows lack date/genres; the album lookup has both.
    const albums = await Promise.allSettled(
      rows.map((r) => (r.album && r.album.id ? jfetch(`https://api.deezer.com/album/${r.album.id}`) : Promise.reject(new Error('no album'))))
    );
    rows.forEach((r, i) => {
      const alb = albums[i].status === 'fulfilled' ? albums[i].value : null;
      push({
        source: 'deezer',
        title: r.title || null,
        artists: splitArtists(r.artist && r.artist.name),
        album: (r.album && r.album.title) || null,
        date: (alb && alb.release_date) || null,
        genres: alb && alb.genres && Array.isArray(alb.genres.data) ? alb.genres.data.map((g) => g.name).filter(Boolean) : [],
        cover: (r.album && r.album.cover_medium) || null,
      });
    });
  }
  return out.slice(0, 10);
}

app.get('/api/music-meta', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
  res.json({ ok: true, candidates: await musicMetaCandidates(q) });
});

// The music library keeps every genre in English with one spelling: iTunes
// and Deezer disagree on names ("Hip-Hop/Rap" vs "Rap/Hip Hop") and Deezer
// sometimes localizes them (Swedish seen in the wild).
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
  'hiphop': 'Hip-Hop',
  'rap': 'Hip-Hop',
  'indie rock': 'Indie Rock',
  'indie rock/rock pop': 'Indie Rock',
  'electronica': 'Electronic',
};

function normalizeGenres(genres) {
  const out = [];
  for (const g of genres || []) {
    const n = GENRE_NORMALIZE[String(g).trim().toLowerCase()] || String(g).trim();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// Best-effort genre lookup for a track (used when neither the UI nor the
// source site provided one — which is the norm for YouTube, whose "genre" is
// a video category and deliberately dropped). Picks the first candidate that
// plausibly matches artist + title.
async function lookupGenres(artist, title) {
  const fold = (s) => String(s || '').toLowerCase().trim();
  const nArtist = fold(artist);
  const nTitle = fold(title);
  const candidates = await musicMetaCandidates(`${artist} ${title}`.trim().slice(0, 200));
  for (const c of candidates) {
    if (!c.genres || !c.genres.length) continue;
    const cArtists = fold((c.artists || []).join(' '));
    const cTitle = fold(c.title);
    const artistOk = !nArtist || cArtists.includes(nArtist) || nArtist.includes(fold((c.artists || [])[0]));
    const titleOk = !nTitle || cTitle.includes(nTitle) || nTitle.includes(cTitle);
    if (artistOk && titleOk) return normalizeGenres(c.genres).slice(0, 3);
  }
  return [];
}

// GET /api/playlists -> saved playlists (subscriptions for new-track checks).
app.get('/api/playlists', (_req, res) => res.json({ ok: true, playlists: readPlaylists() }));

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
  res.json({ ok: true, playlists: list });
});

// ---------------------------------------------------------------------------
// Playlist watcher: saved playlists with watch=true are re-probed on an
// interval and any new tracks are queued to Navidrome automatically — the
// "Download new to Navidrome" button without having to open the playlist.
const WATCH_INTERVAL_MINUTES = Math.max(15, Number(process.env.WATCH_INTERVAL_MINUTES) || 360);
let watchCycleRunning = false;

// Queue one track as an audio job into Navidrome, same defaults as the UI's
// batch button (opus; the cover is embedded as album art by produceAudio).
function startNavidromeJob(url, navLib) {
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
  const job = newJob({ dest: 'navidrome', channel: 'main', lib: params.navLib, device: false });
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

async function checkPlaylistForNew(pl) {
  const profile = await extractors.resolveProfile(pl.url);
  const fresh = profile.items.filter((it) => {
    if (it.mediaType === 'image') return false;
    if (isDownloaded(it.sourceUrl || it.url, it.site, it.mediaId)) return false;
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
  for (const it of fresh) startNavidromeJob(it.sourceUrl || it.url, pl.lib);
  return { total: profile.items.length, queued: fresh.length };
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
  res.json({ ok: true, playlists: list });
});

// POST /api/playlists/lib?id=...&lib=main|kids -> switch which Navidrome
// library this playlist's tracks are downloaded into.
app.post('/api/playlists/lib', (req, res) => {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === String(req.query.id));
  if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
  pl.lib = parseNavLib(req.query.lib);
  writePlaylists(list);
  res.json({ ok: true, playlists: list });
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
    fs.writeFileSync(DOWNLOADED_FILE, JSON.stringify(map));
  } catch (e) {
    console.warn('downloaded registry write failed:', e.message);
  }
  res.json({ ok: true });
});

// POST /api/playlists/delete?id=...
app.post('/api/playlists/delete', (req, res) => {
  const list = readPlaylists().filter((p) => p.id !== String(req.query.id));
  writePlaylists(list);
  res.json({ ok: true, playlists: list });
});

// GET /api/history -> recent downloads, newest first.
app.get('/api/history', (_req, res) => {
  res.json({ ok: true, items: readHistory().slice(0, 100) });
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
  const status = ['done', 'todo', 'edited'].includes(req.query.status) ? req.query.status : null;
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
  if (status === 'done') items = items.filter((t) => t.done);
  else if (status === 'todo') items = items.filter((t) => !t.done);
  else if (status === 'edited') items = items.filter((t) => t.editedAt);
  res.json({
    ok: true,
    total: items.length,
    done,
    edited,
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
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, [
      '-loglevel', 'error', '-y',
      '-i', src,
      // The embedded picture is a video stream; take the first one only.
      '-map', '0:v:0', '-frames:v', '1',
      '-vf', `scale=${COVER_SIZE}:${COVER_SIZE}:force_original_aspect_ratio=increase,crop=${COVER_SIZE}:${COVER_SIZE}`,
      '-f', 'mjpeg', out,
    ]);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0));
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

  try {
    await tagAudio(oldPath, {
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
    return res.status(422).json({ ok: false, error: 'Tagging failed: ' + String(e.message || e) });
  }

  if (newPath !== oldPath) {
    try {
      fs.mkdirSync(target.dir, { recursive: true });
      fs.renameSync(oldPath, newPath);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not move the file: ' + String(e.message || e) });
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
        fs.writeFileSync(DOWNLOADED_FILE, JSON.stringify(map));
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
  res.json({ ok: true, track: row, moved: newPath !== oldPath });
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

  // Images don't fit the video pipeline: with dest=elite they are dropped into
  // elite-v2's posts import, otherwise into the plain photos library.
  if (job.mediaType === 'image') return downloadImage(res, job, url, device, dest);

  // Audio-only: for the elite destination it's streamed (audio doesn't fit the
  // shorts pipeline); for the server library it's saved into the mp3 folder,
  // for navidrome into the music library.
  if (audio) return downloadAudio(res, job, url, afmt, dest);

  // Server library: save the video into the chosen folder (videos/adults/photos).
  if (dest === 'server') return downloadServerVideo(res, job, url, { folder, quality, device });

  // Long videos don't belong in the shorts library — reject so the caller routes
  // them to the server library instead.
  if (tooLongForShorts(job)) {
    return res.status(422).json({ ok: false, error: shortsTooLongError(job), tooLongForShorts: true });
  }

  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const outName = `${stem}${web ? '.web.mp4' : '.mp4'}`;
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
  const cleanup = [tmpPath];
  if (skipImport) cleanup.push(finalPath);

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
            ? 'Already in elite-v2 — not re-imported.'
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
    await embedMetadata(tmpPath, finalPath, job, web);

    // 3. Write the .md caption sidecar elite-v2 reads on import.
    if (!skipImport) {
      fs.writeFileSync(path.join(destDir, `${stem}.md`), buildCaption(job));
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
        url: job.sourceUrl || url, dest: dest === 'server' ? 'server' : 'elite',
        channel, folder, web, quality, creator: req.query.creator ? String(req.query.creator) : job.creator,
        title: job.title, thumbnail: job.thumbnail, reason: error,
      });
    }
    if (!res.headersSent) res.status(502).send('Download failed: ' + error);
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

// GET /api/download-all?url=...&channel=main|18plus
// Streams Server-Sent Events with per-clip progress while saving each clip into
// the channel's _import folder (skipping clips already in elite-v2).
app.get('/api/download-all', async (req, res) => {
  const url = req.query.url;
  const dest = req.query.dest === 'server' ? 'server' : 'elite';
  const channel = CHANNELS[req.query.channel] || 'main';
  const folder = req.query.folder; // server-library target folder (videos/adults/photos)
  const web = req.query.web === '1'; // transcode each clip to a web-optimized .web.mp4
  const quality = parseQuality(req.query.quality); // resolution cap, or null
  if (!validUrl(url)) return res.status(400).end();

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
    const job = items[i];
    const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
    const title = job.title || stem;
    const id = job.id || stem;
    try {
      const isImage = job.mediaType === 'image';
      const toPosts = isImage && dest === 'elite';
      const exists = isImage
        ? (toPosts ? postsPending(job.creator, stem) : photoHas(stem))
        : dest === 'server'
        ? serverHas(folder, stem)
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
      if (isImage) {
        if (toPosts) await saveImageToPosts(job);
        else await saveImageToLibrary(job);
      } else if (dest === 'server') await saveJobToServer(job, folder, quality);
      else await saveJobToImport(job, channel, web, quality);
      recordHistory({
        creator: job.creator || null,
        title: job.title || null,
        channel: isImage
          ? (toPosts ? 'elite/posts' : 'server/photos')
          : dest === 'server'
          ? `server/${path.basename(serverVideoDir(folder))}`
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
      markDownloaded(job.sourceUrl || job.url, null, job.site, job.mediaId, channel);
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
const jobSubs = new Set();
let jobSeq = 0;
const JOB_KEEP_DONE = 60; // cap finished jobs retained in memory
const DELIVER_TTL_MS = 30 * 60 * 1000; // keep a throwaway device-delivery file this long

// The view sent to clients: drops server-only fields (absolute paths, the raw
// start params kept for retries).
function publicJob(j) {
  const { finalPath, deliverTemp, params, ...pub } = j;
  return pub;
}
function snapshotJobs() {
  return [...jobsMap.values()].map(publicJob).sort((a, b) => b.createdAt - a.createdAt);
}
function emitJob(j) {
  const line = `data: ${JSON.stringify({ type: 'job', job: publicJob(j) })}\n\n`;
  for (const r of jobSubs) {
    try {
      r.write(line);
    } catch {
      /* subscriber gone; dropped on its close handler */
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
  jobsMap.set(id, job);
  emitJob(job);
  return job;
}
function finishJob(job, patch) {
  setJob(job, { status: 'done', phase: null, percent: 100, doneAt: Date.now(), ...patch });
  // Anything saved into a library counts as downloaded (playlist dedup marks).
  // The channel only means something for a shorts save; recording it for a
  // server/Navidrome save would make a later shorts download look like a repeat.
  if (job.saved && job.sourceUrl) {
    markDownloaded(job.sourceUrl, job.filename, job.site, job.mediaId, job.dest === 'elite' ? job.channel : null);
  }
  if (job.deliverTemp && job.finalPath) {
    const p = job.finalPath;
    const t = setTimeout(() => fs.rm(p, { force: true }, () => {}), DELIVER_TTL_MS);
    if (t.unref) t.unref();
  }
  pruneJobs();
}
const FINISHED = new Set(['done', 'error', 'cancelled']);
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
    title: meta.title || null,
    channel: channelLabel,
    filename,
    sourceUrl: meta.sourceUrl || params.url,
    thumbnail: meta.thumbnail || null,
    extractor: meta.extractor || null,
    imported,
    device: !!params.device,
  });
}

// Mark a job as failed AND write the failure to the persistent history, so the
// reason survives a restart — the job list itself is in-memory only. Failures
// are never marked as downloaded, so a playlist still offers them next time.
function failJob(job, message) {
  const error = String(message || 'Download failed');
  setJob(job, { status: 'error', phase: null, error });
  recordHistory({
    creator: job.creator || null,
    title: job.title || null,
    channel: job.dest === 'navidrome' ? `navidrome/${job.lib === 'kids' ? 'kids' : 'music'}` : job.dest || null,
    filename: null,
    sourceUrl: job.sourceUrl || job.url || null,
    thumbnail: job.thumbnail || null,
    extractor: job.extractor || null,
    imported: false,
    device: false,
    error,
  });
}

// Some failures are the server saying "not right now" rather than "no":
// YouTube's signed media URLs are short-lived and its rate limiter answers 403
// (and 429) when several jobs run at once. Those deserve another attempt; a
// deleted video or an unsupported site does not.
function isTransientDownloadError(e) {
  return /HTTP Error (403|408|429|5\d\d)|Forbidden|Too Many Requests|timed? ?out|Connection reset|Temporary failure|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(
    String((e && e.message) || e || '')
  );
}
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_BASE_MS = 5000;

// Resolve, enforce the shorts length cap, then dispatch to the right producer.
async function runJob(job, params) {
  setJob(job, { status: 'running', phase: 'resolving' });
  let meta;
  try {
    meta = await extractors.resolve(params.url);
  } catch (e) {
    return failJob(job, 'Resolve failed: ' + String(e.message || e));
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
    mediaType, duration: durationKnown(meta) ? Number(meta.duration) : null,
    sourceUrl: meta.sourceUrl || params.url,
    // Site-native id, so finishJob can register the clip under a key that
    // survives being shared as a different URL.
    site: meta.site || null, mediaId: meta.mediaId || null,
  });

  if (params.dest === 'elite' && mediaType !== 'image' && !params.audio && tooLongForShorts(meta)) {
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
        return failJob(job, String(e.message || e));
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

async function produceEliteVideo(job, meta, params, onProgress) {
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const outName = `${stem}${params.web ? '.web.mp4' : '.mp4'}`;
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
      message: status === 'imported' ? 'Already in elite-v2 — not re-imported.' : 'Already queued for import.',
    });
  }
  const destDir = channelDir(params.channel);
  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${job.id}.src`);
  // Real import writes into _import; a device-only copy of an already-imported
  // clip goes to a throwaway temp instead.
  const finalPath = skipImport
    ? path.join(os.tmpdir(), `grabbit-${process.pid}-${job.id}.out.mp4`)
    : path.join(destDir, outName);
  try {
    if (!skipImport) fs.mkdirSync(destDir, { recursive: true });
    if (meta.kind === 'direct') await downloadDirect(meta, tmpPath, { onProgress });
    else await downloadYtdlp(meta, tmpPath, { quality: params.quality, onProgress, extraArgs: params.extraArgs });
    setJob(job, { phase: 'processing', percent: 100 });
    await embedMetadata(tmpPath, finalPath, meta, params.web);
    if (!skipImport) fs.writeFileSync(path.join(destDir, `${stem}.md`), buildCaption(meta));
    recordJobHistory(meta, params, params.channel, outName, !skipImport);
    finishJob(job, {
      saved: !skipImport, channel: params.channel, dir: params.channel, filename: outName, mime: 'video/mp4',
      deliverable: !!params.device, finalPath: params.device ? finalPath : null, deliverTemp: skipImport,
      message: skipImport ? 'Already in elite-v2 — device copy only.' : 'Saved to ' + params.channel + ' — importing within ~5 min.',
    });
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
}

async function produceServerVideo(job, meta, params, onProgress) {
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const dir = serverVideoDir(params.folder);
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
    return finishJob(job, { saved: false, dest: 'server', dir: path.basename(dir), filename: outName, message: 'Already in the library.' });
  }
  if (already && params.device) {
    recordJobHistory(meta, params, `server/${path.basename(dir)}`, outName, false);
    return finishJob(job, {
      saved: false, dest: 'server', dir: path.basename(dir), filename: outName, mime,
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
    recordJobHistory(meta, params, `server/${path.basename(dir)}`, outName, false);
    finishJob(job, {
      saved: true, dest: 'server', dir: path.basename(dir), filename: outName, mime,
      deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
      message: 'Saved to library/' + path.basename(dir) + '.',
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
  const libPath = path.join(dir, outName);
  setJob(job, { phase: 'downloading' });
  if (!fs.existsSync(libPath)) {
    if (toPosts) await saveImageToPosts(meta);
    else {
      fs.mkdirSync(PHOTOS_DIR, { recursive: true });
      await downloadDirect(meta, libPath);
    }
  }
  recordJobHistory(meta, params, toPosts ? 'elite/posts' : 'server/photos', outName, toPosts);
  finishJob(job, {
    saved: true,
    dest: toPosts ? 'elite' : 'server',
    dir: toPosts ? 'posts' : 'photos',
    filename: outName,
    mime: imageMime(ext),
    deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
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
        const artists = params.artists ? splitList(params.artists) : splitArtists(m.artist);
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
        let genres = params.genres ? splitGenres(params.genres) : m.genre ? [m.genre] : [];
        // No genre from the UI or the site: look one up (iTunes/Deezer) so
        // the library doesn't end up genre-less — the norm for YouTube rips.
        if (!genres.length) genres = await lookupGenres(artists[0], songTitle).catch(() => []);
        // Anything typed by hand joins the picker's list right away.
        if (params.genres) rememberGenres(splitGenres(params.genres));
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
      : serverVideoDir(params.folder);
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
      toBook ? `audiobooks/${book.author}` : `server/${path.basename(dir)}`,
      savedNames[0], false
    );
    const single = savedNames.length === 1 ? path.join(dir, savedNames[0]) : null;
    finishJob(job, {
      saved: true,
      dest: toBook ? 'audiobooks' : 'server',
      dir: toBook ? book.book : path.basename(dir),
      filename: savedNames[0],
      mime: single ? (audio ? audioMime(safeExt(path.extname(single).slice(1), 'm4a')) : videoMime(safeExt(path.extname(single).slice(1), 'mp4'))) : null,
      deliverable: !!params.device && !!single,
      finalPath: params.device && single ? single : null,
      deliverTemp: false,
      message: toBook
        ? `Saved ${savedNames.length} part(s) to audiobooks/${book.author}/${book.book}.`
        : `Saved ${savedNames.length} cut file(s) to library/${path.basename(dir)}.`,
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
        ? ['--split-chapters', '-o', `chapter:${path.join(tmpDir, `${stem} - ch%(section_number)02d %(section_title)s.%(ext)s`)}`]
        : []),
      ...(opts.extraArgs || []),
      ...(wantProgress
        ? ['--newline', '--no-color', '--progress-template', 'GRABBIT|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s']
        : []),
      '-o', mainTpl,
      '--', job.url,
    ];
    const p = spawn(YTDLP, args);
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
      reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
    });
  });
}

// GET /api/jobs/start?...same params as /api/download... -> { jobId }, instantly.
// Extras over /api/download: sponsor=remove|mark, sections=<cuts>, split=1
// (chapter splitting), xargs=<extra yt-dlp flags>, at=<epoch ms | ISO datetime>
// (scheduled start).
app.get('/api/jobs/start', (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const dest = parseDest(req.query.dest);
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
    };
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
  // Cut downloads produce several files at once: the server library takes them
  // as loose files, an audiobook takes them as numbered parts of one book. The
  // elite-v2 shorts import and Navidrome tagging are single-file only.
  if ((params.sections.length || params.splitChapters) && !['server', 'audiobooks'].includes(params.dest)) {
    return res.status(400).json({ ok: false, error: 'Cutting/splitting is only supported for the server and audiobook libraries.' });
  }
  const at = parseAt(req.query.at);
  const job = newJob({ dest: params.dest, channel: params.channel, lib: params.navLib, device: params.device });
  job.params = params;
  if (at) {
    setJob(job, { status: 'scheduled', at });
    addScheduled({ id: job.id, at, params, dest: params.dest, channel: params.channel, device: params.device });
  }
  res.json({ ok: true, jobId: job.id, scheduled: !!at });
  if (!at) scheduleJob(job, params);
});

// ---------------------------------------------------------------------------
// Scheduled downloads: jobs with a future start time wait in 'scheduled' until
// due, survive restarts via a DATA_DIR file, and can be cancelled.
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');
function readScheduled() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeScheduled(list) {
  try {
    fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(list));
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
    const job = newJob({ id: s.id, status: 'scheduled', at: s.at, dest: s.dest, channel: s.channel, device: s.device });
    job.params = s.params;
  }
}

// Fire due schedules. A coarse poll (not one timer per job) keeps restarts and
// clock jumps trivially correct.
setInterval(() => {
  const due = readScheduled().filter((s) => s.at <= Date.now());
  for (const s of due) {
    removeScheduled(s.id);
    let job = jobsMap.get(s.id);
    if (job && job.status !== 'scheduled') continue; // cancelled or already run
    if (!job) {
      job = newJob({ id: s.id, dest: s.dest, channel: s.channel, device: s.device });
      job.params = s.params;
    }
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
const RETRY_BACKOFF_MIN = [20, 40, 60, 120, 180, 240, 360]; // minutes; last repeats

function readRetryQueue() {
  try { return JSON.parse(fs.readFileSync(RETRY_FILE, 'utf8')); } catch { return []; }
}
function writeRetryQueue(list) {
  try { fs.writeFileSync(RETRY_FILE, JSON.stringify(list)); }
  catch (e) { console.warn('retry-queue write failed:', e.message); }
}
// Dedup on the exact URL (not mediaKey, which drops the query string — xfree
// distinguishes clips only by ?id=, so mediaKey would collapse them all to one).
function retryKey(e) { return `${e.dest || 'elite'}:${e.channel || ''}:${e.folder || ''}:${e.url}`; }
function retryDelayMs(attempts) {
  return RETRY_BACKOFF_MIN[Math.min(attempts, RETRY_BACKOFF_MIN.length - 1)] * 60 * 1000;
}
function isRetryableError(err, msg) {
  if (err && err.retryable === true) return true;
  if (err && err.retryable === false) return false;
  return /HTTP (403|404|408|425|429|5\d\d)|not published|timeout|timed out|ECONNRESET|network|EAI_AGAIN/i.test(String(msg || ''));
}
function enqueueRetry(entry) {
  if (!validUrl(entry.url)) return null;
  const list = readRetryQueue();
  const key = retryKey(entry);
  if (list.some((e) => retryKey(e) === key)) return null; // already queued
  const rec = {
    id: `retry-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    url: entry.url,
    dest: entry.dest === 'server' ? 'server' : 'elite',
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
  const job = await extractors.resolve(entry.url);
  if (entry.creator) job.creator = entry.creator;
  if (entry.dest === 'server') await saveJobToServer(job, entry.folder, entry.quality);
  else await saveJobToImport(job, entry.channel, entry.web, entry.quality);
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  recordHistory({
    creator: job.creator || null,
    title: job.title || null,
    channel: entry.dest === 'server'
      ? `server/${path.basename(serverVideoDir(entry.folder))}`
      : entry.channel,
    filename: `${stem}${entry.dest === 'elite' && entry.web ? '.web.mp4' : '.mp4'}`,
    sourceUrl: job.sourceUrl || entry.url,
    thumbnail: job.thumbnail || null,
    extractor: job.extractor || null,
    imported: entry.dest === 'elite',
    device: false,
  });
  markDownloaded(job.sourceUrl || entry.url, null, job.site, job.mediaId, entry.dest === 'elite' ? entry.channel : null);
}

let retryRunning = false;
async function runRetryCycle() {
  if (retryRunning) return;
  retryRunning = true;
  try {
    const now = Date.now();
    for (const e of readRetryQueue().filter((x) => x.nextAt <= now)) {
      try {
        await attemptRetry(e);
        writeRetryQueue(readRetryQueue().filter((x) => x.id !== e.id));
        console.log(`[retry] recovered ${e.url}`);
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
    dest: req.query.dest === 'server' ? 'server' : 'elite',
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
      .catch((e) => failJob(job, String(e.message || e)))
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
app.get('/api/jobs', (_req, res) => res.json({ ok: true, jobs: snapshotJobs() }));

// GET /api/jobs/stream -> SSE feed of job updates (snapshot first, then deltas).
app.get('/api/jobs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.write('retry: 3000\n\n');
  for (const j of snapshotJobs()) res.write(`data: ${JSON.stringify({ type: 'job', job: j })}\n\n`);
  jobSubs.add(res);
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
app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobsMap.get(req.params.id);
  if (!job || job.status !== 'done' || !job.deliverable || !job.finalPath || !fs.existsSync(job.finalPath)) {
    return res.status(404).send('Not available');
  }
  const name = job.filename || path.basename(job.finalPath);
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.setHeader('Content-Type', job.mime || 'application/octet-stream');
  res.setHeader('Content-Length', fs.statSync(job.finalPath).size);
  pipeline(fs.createReadStream(job.finalPath), res)
    .then(() => {
      if (job.deliverTemp) {
        fs.rm(job.finalPath, { force: true }, () => {});
        setJob(job, { deliverable: false });
      }
    })
    .catch(() => {
      if (!res.headersSent) res.status(500).end();
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
  // Profile items resolve from a listing that carries no tags; pull them from
  // the clip's own post page now, only for the clips actually being saved.
  if (job.pageUrl && (!Array.isArray(job.tags) || !job.tags.length)) {
    try { await extractors.enrichJob(job); } catch { /* best effort */ }
  }
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const destDir = channelDir(channel);
  const finalPath = path.join(destDir, `${stem}${web ? '.web.mp4' : '.mp4'}`);
  const tmpPath = path.join(os.tmpdir(), `grabbit-${process.pid}-${Date.now()}-${stem.slice(0, 8)}.src`);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (job.kind === 'direct') await downloadDirect(job, tmpPath);
    else await downloadYtdlp(job, tmpPath, { quality });
    await embedMetadata(tmpPath, finalPath, job, web);
    fs.writeFileSync(path.join(destDir, `${stem}.md`), buildCaption(job));
    return finalPath;
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }
}

// Fetch a direct URL to disk, honouring the extractor's required headers.
// opts.onProgress({ percent, downloaded, total }) is called as bytes arrive.
async function downloadDirect(job, dest, opts = {}) {
  // Extractors may list lower-quality fallbackUrls for sites where the best
  // variant doesn't exist for every post (e.g. xxxfollow _fhd -> plain -> _sd).
  const urls = [job.downloadUrl, ...(job.fallbackUrls || [])];
  let upstream;
  for (const url of urls) {
    upstream = await fetch(url, { headers: job.headers || {} });
    if (upstream.ok && upstream.body) break;
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
}

// yt-dlp writes to the literal -o path for a single format, but when it has to
// MERGE separate video+audio it appends the merge extension (so `<dest>` becomes
// `<dest>.mp4`). Find whatever it actually produced for this dest.
function resolveYtdlpOutput(dest) {
  if (fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  try {
    const match = fs.readdirSync(dir).find((f) => f.startsWith(`${base}.`));
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
      const out = resolveYtdlpOutput(dest);
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
      reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
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
      if (afmt !== 'best' && fs.existsSync(known)) return resolve(known);
      const match = siblings.find((f) => !isImage(f) && !/\.(part|src)$/i.test(f));
      if (match) return resolve(path.join(dir, match));
      reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
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
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', src, '-vn', ...codec, dest];
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return resolve();
      reject(new Error(err.trim().split('\n').pop() || 'audio extract failed'));
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
      return res.json({ ok: true, saved: true, dest: 'server', dir: 'mp3', filename: outName });
    }

    const mime = audioMime(afmt);
    res.setHeader('Content-Disposition', contentDisposition(`${stem}.${afmt}`));
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
    if (!res.headersSent) res.status(502).send('Audio download failed: ' + String(e.message || e));
    else res.destroy();
  } finally {
    for (const f of cleanup) fs.rm(f, { force: true }, () => {});
  }
}

// Server-library video handler: save a video into the chosen folder, with
// embedded metadata. Optionally also streams the file to the browser.
async function downloadServerVideo(res, job, url, { folder, quality, device }) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const dir = serverVideoDir(folder);
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
      return res.json({ ok: true, saved: false, dest: 'server', dir: path.basename(dir), message: 'Already in the library.' });
    }
    fs.mkdirSync(dir, { recursive: true });
    if (job.kind === 'direct') await downloadDirect(job, tmpPath);
    else await downloadYtdlp(job, tmpPath, { quality });
    await embedMetadata(tmpPath, finalPath, job, false);

    const histEntry = {
      creator: job.creator || null,
      title: job.title || null,
      channel: `server/${path.basename(dir)}`,
      filename: outName,
      sourceUrl: job.sourceUrl || url,
      thumbnail: job.thumbnail || null,
      extractor: job.extractor || null,
      imported: false,
    };
    if (!device) {
      recordHistory({ ...histEntry, device: false });
      return res.json({ ok: true, saved: !already, dest: 'server', dir: path.basename(dir), filename: outName });
    }
    res.setHeader('Content-Disposition', contentDisposition(outName));
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', fs.statSync(finalPath).size);
    recordHistory({ ...histEntry, device: true });
    await pipeline(fs.createReadStream(finalPath), res);
  } catch (e) {
    console.error('server download failed:', e);
    if (!res.headersSent) res.status(502).send('Download failed: ' + String(e.message || e));
    else res.destroy();
  } finally {
    for (const f of cleanup) fs.rm(f, { force: true }, () => {});
  }
}

// Save a job's video into the server library (no streaming). Shared by the
// batch profile downloader for dest='server'.
async function saveJobToServer(job, folder, quality) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const dir = serverVideoDir(folder);
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
function serverHas(folder, stem) {
  try {
    return fs.existsSync(path.join(serverVideoDir(folder), `${stem}.mp4`));
  } catch {
    return false;
  }
}

// --- Images ---------------------------------------------------------------
// Images don't belong in a video pipeline, so they get their own two targets:
// dest=elite drops them into elite-v2's posts import (they become posts), any
// other destination saves them in the plain photos library (extension
// preserved). Used for mixed albums like erome, where the videos go to shorts
// and the pictures to posts.

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
// 'pending' means it is still queued for elite-v2's posts importer.
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

// Download an image into elite-v2's posts import, under the creator's own drop
// folder, next to the JSON sidecar the posts importer reads: `description` is
// the caption (its #tags become the post's hashtags) and `post_shortcode`
// groups everything from one album into a single carousel post instead of one
// post per picture. The file itself is fetched under a dot-name (both importers
// skip dotfiles) and renamed last, so a run that starts mid-download never
// picks up half a picture — or a picture without its caption.
async function saveImageToPosts(job) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const ext = safeExt(job.ext, 'jpg');
  const outName = `${stem}.${ext}`;
  const dir = postsImportDir(job.creator);
  makeDropDir(dir);
  const finalPath = path.join(dir, outName);
  const partPath = path.join(dir, `.${outName}.part`);
  try {
    await downloadDirect(job, partPath);
    fs.writeFileSync(
      `${finalPath}.json`,
      JSON.stringify({ description: buildCaption(job), post_shortcode: job.albumId || null })
    );
    fs.renameSync(partPath, finalPath);
  } catch (e) {
    fs.rm(partPath, { force: true }, () => {});
    throw e;
  }
  return { path: finalPath, name: outName, creator: postsCreator(job.creator) };
}

// Single-image handler: save it (posts import or photos library, per dest) and
// optionally stream it to the device too.
async function downloadImage(res, job, url, device, dest) {
  const toPosts = dest === 'elite';
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const ext = safeExt(job.ext, 'jpg');
  const outName = `${stem}.${ext}`;
  const dir = toPosts ? postsImportDir(job.creator) : PHOTOS_DIR;
  const libPath = path.join(dir, outName);
  const already = fs.existsSync(libPath);
  try {
    if (!already) {
      if (toPosts) await saveImageToPosts(job);
      else {
        fs.mkdirSync(PHOTOS_DIR, { recursive: true });
        await downloadDirect(job, libPath);
      }
    }
    recordHistory({
      creator: job.creator || null,
      title: job.title || null,
      channel: toPosts ? 'elite/posts' : 'server/photos',
      filename: outName,
      sourceUrl: job.sourceUrl || url,
      thumbnail: job.thumbnail || null,
      extractor: job.extractor || null,
      imported: toPosts,
      device: !!device,
    });
    if (!device) {
      return res.json(
        toPosts
          ? { ok: true, saved: !already, dest: 'elite', dir: 'posts', creator: postsCreator(job.creator), filename: outName }
          : { ok: true, saved: !already, dest: 'server', dir: 'photos', filename: outName }
      );
    }
    res.setHeader('Content-Disposition', contentDisposition(outName));
    res.setHeader('Content-Type', imageMime(ext));
    res.setHeader('Content-Length', fs.statSync(libPath).size);
    await pipeline(fs.createReadStream(libPath), res);
  } catch (e) {
    console.error('image download failed:', e);
    if (!res.headersSent) res.status(502).send('Image download failed: ' + String(e.message || e));
    else res.destroy();
  }
}

// Probe the source's video codec (lowercase), '' on failure.
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
function embedMetadata(src, dest, job, web) {
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
      '-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', src,
      ...codecArgs, ...meta, dest,
    ];
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => fallbackCopy());
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return resolve();
      console.warn('ffmpeg metadata failed, copying raw:', err.trim().split('\n').pop());
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
  console.log(`grabbit listening on :${PORT}, elite-v2 root ${ELITE_ROOT}`);
  countYtdlpExtractors();
});
