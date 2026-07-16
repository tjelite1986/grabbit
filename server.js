// grabbit - plugin-based media grabber.
// Resolve a pasted URL, embed source + hashtags into the file metadata, name it
// for the elite-v2 shorts importer, save it into the chosen channel's _import
// folder (with a .md caption sidecar) and stream the result to the browser.

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const extractors = require('./extractors');
const { cleanDescription } = require('./extractors/util');

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
// Root of the elite-v2 shorts store (a host folder bind-mounted here). Files
// land in <root>/<channel>/_import/ where the elite-v2 timer auto-imports them.
const ELITE_ROOT = process.env.ELITE_ROOT || '/elitev2-shorts';
const CHANNELS = { main: 'main', '18plus': '18plus' };
// Audio extraction targets (yt-dlp --audio-format). 'best' keeps the source codec.
const AUDIO_FORMATS = ['best', 'm4a', 'mp3', 'opus', 'flac', 'wav', 'vorbis', 'aac', 'alac'];
// Output containers for a server-library video save (yt-dlp --merge-output-format).
const VIDEO_CONTAINERS = ['mp4', 'mkv', 'webm'];
const DATA_DIR = process.env.DATA_DIR || '/data';

// Plain server download library (alternative to the elite-v2 import). Files are
// auto-routed by type. PHOTOS_DIR is reserved for a later photo feature.
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/downloads';
const VIDEOS_DIR = process.env.VIDEOS_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'videos');
const AUDIO_DIR = process.env.AUDIO_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'mp3');
const ADULTS_DIR = process.env.ADULTS_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'adults');
const PHOTOS_DIR = process.env.PHOTOS_DOWNLOAD_DIR || path.join(DOWNLOAD_DIR, 'photos');
// Navidrome music library (host mount). dest=navidrome saves extracted audio
// here; Navidrome's scanner picks it up.
const NAVIDROME_DIR = process.env.NAVIDROME_MUSIC_DIR || path.join(DOWNLOAD_DIR, 'navidrome');

// Download destination: elite (shorts import), server (plain library) or
// navidrome (music library; audio-only, forces audio extraction).
function parseDest(v) {
  return v === 'server' || v === 'navidrome' ? v : 'elite';
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

function markDownloaded(sourceUrl, filename) {
  if (!sourceUrl) return;
  const map = readDownloaded();
  map[mediaKey(sourceUrl)] = { filename: filename || null, at: Date.now() };
  try {
    fs.writeFileSync(DOWNLOADED_FILE, JSON.stringify(map));
  } catch (e) {
    console.warn('downloaded registry write failed:', e.message);
  }
}

function isDownloaded(sourceUrl) {
  return !!(sourceUrl && readDownloaded()[mediaKey(sourceUrl)]);
}

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
<title>grabbit — sign in</title>
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
  <h1 style="text-align:center">grabbit</h1>
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

// Icons are needed by the login page and browser tabs before auth.
const PUBLIC_ASSETS = new Set([
  '/favicon.svg',
  '/logo.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
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
  return (
    String(title || 'video')
      .replace(/[^\p{L}\p{N} ._()-]+/gu, ' ')
      .replace(/_-_| - /g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'video'
  );
}

// A single path segment of the Navidrome library tree ([Artist]/[Album (Year)]/
// [Title].ext). Unlike safeTitle, hyphens are kept (band/song names use them);
// only filesystem-unsafe characters go, and leading/trailing dots (hidden files
// / Windows quirks) are trimmed.
function safeMusicPart(name, fallback) {
  return (
    String(name || '')
      .replace(/[<>:"\/\\|?*\u0000-\u001f]+/gu, " ")
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 80)
      .trim() || fallback
  );
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
      // Already saved once (any destination) per the downloaded registry.
      downloaded: isDownloaded(job.sourceUrl || url),
      // Too long to belong in the shorts library (UI forces the server library).
      tooLongForShorts: !isImage && tooLongForShorts(job),
      filename: isImage ? `${stem}.${safeExt(job.ext, 'jpg')}` : `${stem}.mp4`,
      kind: job.kind,
      // Whether this clip is already in elite-v2, per channel (for a UI warning).
      imported: {
        main: isImage ? (photoHas(stem) ? 'imported' : null) : importedStatus('main', job.creator, stem),
        '18plus': isImage ? null : importedStatus('18plus', job.creator, stem),
      },
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

// GET /api/music-meta?q=... -> song metadata candidates from public music
// databases (iTunes Search + Deezer, both keyless), for the UI to auto-fill
// the Navidrome tag fields. Candidates: {source, title, artists[], album,
// date, genres[], cover}.
app.get('/api/music-meta', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
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
    const r = await fetch(u, { headers: { 'user-agent': 'grabbit/1.0' }, signal: AbortSignal.timeout(8000) });
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
  res.json({ ok: true, candidates: out.slice(0, 10) });
});

// GET /api/playlists -> saved playlists (subscriptions for new-track checks).
app.get('/api/playlists', (_req, res) => res.json({ ok: true, playlists: readPlaylists() }));

// POST /api/playlists/save?url=...&name=... -> add (or rename) a saved playlist.
app.post('/api/playlists/save', (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const name = String(req.query.name || '').slice(0, 120) || url;
  const list = readPlaylists();
  const existing = list.find((p) => p.url === url);
  if (existing) existing.name = name;
  else list.push({ id: `${Date.now()}`, url, name, addedAt: Date.now() });
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
function startNavidromeJob(url) {
  const params = {
    url,
    dest: 'navidrome',
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
    sponsorblock: false,
    creatorOverride: null,
    titleOverride: null,
    artists: null,
    album: null,
    single: false,
    date: null,
    genres: null,
  };
  const job = newJob({ dest: 'navidrome', channel: 'main', device: false });
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
  const fresh = profile.items.filter(
    (it) => it.mediaType !== 'image' && !isDownloaded(it.sourceUrl || it.url)
  );
  for (const it of fresh) startNavidromeJob(it.sourceUrl || it.url);
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
//     is jobs-API only (tagging + library sorting live there) and is rejected.
//   device=1 (default) streams the file to the browser; device=0 saves only.
//   web=1 saves a web-optimized .web.mp4 (lands ready; the transcoder skips it).
//   quality=720|1080|... caps the download resolution (yt-dlp sites only).
//   audio=1 extracts audio (afmt=m4a|mp3|opus); streamed (elite) or saved (server).
app.get('/api/download', async (req, res) => {
  const url = req.query.url;
  const dest = parseDest(req.query.dest);
  if (dest === 'navidrome') {
    return res.status(400).json({ ok: false, error: 'dest=navidrome is only supported via /api/jobs/start (it tags and sorts the file).' });
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

  // Images always go to the photos library (they don't fit a video pipeline).
  if (job.mediaType === 'image') return downloadImage(res, job, url, device);

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
    console.error('download failed:', e);
    if (!res.headersSent) res.status(502).send('Download failed: ' + String(e.message || e));
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
        mediaType: isImage ? 'image' : 'video',
        filename: isImage ? `${stem}.${safeExt(job.ext, 'jpg')}` : `${stem}.mp4`,
        thumbnail: job.thumbnail || null,
        duration: durationKnown(job) ? Number(job.duration) : null,
        sourceUrl: job.sourceUrl || job.url || null,
        // Marked in playlist views; "download new" skips these.
        downloaded: isDownloaded(job.sourceUrl || job.url),
        tooLongForShorts: !isImage && tooLongForShorts(job),
        imported: {
          main: isImage ? (photoHas(stem) ? 'imported' : null) : importedStatus('main', job.creator, stem),
          '18plus': isImage ? null : importedStatus('18plus', job.creator, stem),
        },
      };
    });
    res.json({ ok: true, isProfile: true, extractor: p.extractor, creator: p.creator, title: p.title || null, count: items.length, items });
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
      const exists = isImage
        ? photoHas(stem)
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
      if (isImage) await saveImageToLibrary(job);
      else if (dest === 'server') await saveJobToServer(job, folder, quality);
      else await saveJobToImport(job, channel, web, quality);
      recordHistory({
        creator: job.creator || null,
        title: job.title || null,
        channel: isImage
          ? 'server/photos'
          : dest === 'server'
          ? `server/${path.basename(serverVideoDir(folder))}`
          : channel,
        filename: isImage
          ? `${stem}.${safeExt(job.ext, 'jpg')}`
          : `${stem}${dest === 'elite' && web ? '.web.mp4' : '.mp4'}`,
        sourceUrl: job.sourceUrl || url,
        thumbnail: job.thumbnail || null,
        extractor: job.extractor || null,
        imported: !isImage && dest === 'elite',
        device: false,
      });
      saved++;
      markDownloaded(job.sourceUrl || job.url, null);
      send({ type: 'progress', index: i + 1, total: items.length, id, title, status: 'saved' });
    } catch (e) {
      failed++;
      send({ type: 'progress', index: i + 1, total: items.length, id, title, status: 'failed', error: String(e.message || e) });
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

// The view sent to clients: drops server-only fields (absolute paths).
function publicJob(j) {
  const { finalPath, deliverTemp, ...pub } = j;
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
  Object.assign(j, patch);
  emitJob(j);
}
function newJob(fields) {
  const id = `${Date.now()}-${jobSeq++}`;
  const job = {
    id, status: 'queued', phase: null, percent: null, speed: '', eta: '',
    title: null, creator: null, thumbnail: null, mediaType: null, duration: null,
    filename: null, mime: null, dest: null, dir: null, channel: null,
    saved: false, deliverable: false, message: null, error: null,
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
  if (job.saved && job.sourceUrl) markDownloaded(job.sourceUrl, job.filename);
  if (job.deliverTemp && job.finalPath) {
    const p = job.finalPath;
    const t = setTimeout(() => fs.rm(p, { force: true }, () => {}), DELIVER_TTL_MS);
    if (t.unref) t.unref();
  }
  pruneJobs();
}
function pruneJobs() {
  const done = [...jobsMap.values()]
    .filter((j) => j.status === 'done' || j.status === 'error')
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

// Resolve, enforce the shorts length cap, then dispatch to the right producer.
async function runJob(job, params) {
  setJob(job, { status: 'running', phase: 'resolving' });
  let meta;
  try {
    meta = await extractors.resolve(params.url);
  } catch (e) {
    return setJob(job, { status: 'error', phase: null, error: 'Resolve failed: ' + String(e.message || e) });
  }
  if (params.creatorOverride) meta.creator = params.creatorOverride;
  if (params.titleOverride) meta.title = params.titleOverride;
  const mediaType = meta.mediaType === 'image' ? 'image' : 'video';
  setJob(job, {
    title: meta.title || null, creator: meta.creator || null, thumbnail: meta.thumbnail || null,
    mediaType, duration: durationKnown(meta) ? Number(meta.duration) : null,
    sourceUrl: meta.sourceUrl || params.url,
  });

  if (params.dest === 'elite' && mediaType !== 'image' && !params.audio && tooLongForShorts(meta)) {
    return setJob(job, { status: 'error', phase: null, error: shortsTooLongError(meta) });
  }

  const onProgress = (p) =>
    setJob(job, {
      phase: 'downloading',
      percent: p.percent == null ? job.percent : Math.max(job.percent || 0, Math.round(p.percent)),
      speed: p.speed || job.speed,
      eta: p.eta || job.eta,
    });

  try {
    if (mediaType === 'image') await produceImage(job, meta, params);
    else if (params.audio) await produceAudio(job, meta, params, onProgress);
    else if (params.dest === 'server') await produceServerVideo(job, meta, params, onProgress);
    else await produceEliteVideo(job, meta, params, onProgress);
  } catch (e) {
    // Full stack to the server log — the job list only shows the message, and
    // an unexpected TypeError is undebuggable without it.
    console.error(`job ${job.id} failed:`, e && e.stack ? e.stack : e);
    setJob(job, { status: 'error', phase: null, error: String(e.message || e) });
  }
}

async function produceEliteVideo(job, meta, params, onProgress) {
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const outName = `${stem}${params.web ? '.web.mp4' : '.mp4'}`;
  const status = importedStatus(params.channel, meta.creator, stem);
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
    else await downloadYtdlp(meta, tmpPath, { quality: params.quality, onProgress });
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
      });
      setJob(job, { phase: 'processing', percent: 100 });
      // copy (not rename) — tmp and the library mount may be different devices;
      // the finally block removes tmpPath.
      fs.copyFileSync(tmpPath, libPath);
    } else {
      if (meta.kind === 'direct') await downloadDirect(meta, tmpPath, { onProgress });
      else await downloadYtdlp(meta, tmpPath, { quality: params.quality, onProgress });
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
  const stem = `${safeCreator(meta.creator)}_-_${safeTitle(meta.title)}`;
  const ext = safeExt(meta.ext, 'jpg');
  const outName = `${stem}.${ext}`;
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const libPath = path.join(PHOTOS_DIR, outName);
  setJob(job, { phase: 'downloading' });
  if (!fs.existsSync(libPath)) await downloadDirect(meta, libPath);
  recordJobHistory(meta, params, 'server/photos', outName, false);
  finishJob(job, {
    saved: true, dest: 'server', dir: 'photos', filename: outName, mime: imageMime(ext),
    deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
    message: 'Saved to photos.',
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
      // Navidrome files always get the cover embedded — it's the album art.
      outPath = await downloadYtdlpAudio(meta, base, afmt, {
        aq: params.aq,
        embedThumb: params.embedThumb || params.dest === 'navidrome',
        sponsorblock: params.sponsorblock,
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
    if (params.dest === 'server' || params.dest === 'navidrome') {
      const nav = params.dest === 'navidrome';
      let libDir = nav ? NAVIDROME_DIR : AUDIO_DIR;
      let finalName = outName;
      if (nav) {
        // Tags: UI-provided fields win; site metadata (yt-dlp) fills the gaps.
        const m = meta.music || {};
        const artists = params.artists ? splitList(params.artists) : splitArtists(m.artist);
        if (!artists.length) artists.push(meta.creator || 'Unknown Artist');
        const songTitle = (params.titleOverride || m.track || meta.title || 'Unknown').trim();
        // A single is filed as its own album (standard music-library layout).
        const album = (params.single ? songTitle : params.album || m.album || songTitle).trim();
        const date = params.date || (m.year ? String(m.year) : null);
        const year = date ? String(date).slice(0, 4) : null;
        const genres = params.genres ? splitList(params.genres) : m.genre ? [m.genre] : [];
        try {
          await tagAudio(outPath, {
            title: songTitle,
            artist: artists,
            albumartist: artists[0],
            album,
            date,
            genre: genres,
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
        // Library layout: [Artist]/[Album(Year)]/[Artist] - [Album(Year)] - [Title].ext
        // Artist + album repeat in the file name on purpose: the file stays
        // traceable even when it ends up outside its folder.
        const artistDir = safeMusicPart(artists[0], 'Unknown Artist');
        const albumDir = safeMusicPart(album, 'Unknown Album') + (year ? `(${year})` : '');
        libDir = path.join(NAVIDROME_DIR, artistDir, albumDir);
        finalName = `${artistDir} - ${albumDir} - ${safeMusicPart(songTitle, 'Unknown')}.${realExt}`;
      }
      fs.mkdirSync(libDir, { recursive: true });
      const libPath = path.join(libDir, finalName);
      fs.copyFileSync(outPath, libPath);
      recordJobHistory(meta, params, nav ? 'navidrome/music' : 'server/mp3', finalName, false);
      finishJob(job, {
        saved: true, dest: params.dest, dir: nav ? 'music' : 'mp3', filename: finalName, mime,
        deliverable: !!params.device, finalPath: params.device ? libPath : null, deliverTemp: false,
        message: nav ? 'Saved to Navidrome.' : 'Saved to library/mp3.',
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

// GET /api/jobs/start?...same params as /api/download... -> { jobId }, instantly.
app.get('/api/jobs/start', (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ ok: false, error: 'Invalid URL' });
  const dest = parseDest(req.query.dest);
  const params = {
    url,
    dest,
    channel: CHANNELS[req.query.channel] || 'main',
    folder: req.query.folder,
    device: req.query.device !== '0',
    web: req.query.web === '1',
    quality: parseQuality(req.query.quality),
    audio: req.query.audio === '1' || dest === 'navidrome',
    afmt: AUDIO_FORMATS.includes(req.query.afmt) ? req.query.afmt : dest === 'navidrome' ? 'opus' : 'm4a',
    aq: parseAudioQuality(req.query.aq),
    container: parseContainer(req.query.container),
    embedThumb: req.query.thumb === '1',
    embedSubs: req.query.subs === '1',
    sponsorblock: req.query.sponsor === '1',
    creatorOverride: req.query.creator ? String(req.query.creator) : null,
    titleOverride: req.query.title ? String(req.query.title) : null,
    // Navidrome tag fields (all optional): artists/genres are ","- or ";"-
    // separated lists, date is YYYY or YYYY-MM-DD, single files the song as
    // its own album.
    artists: req.query.artists ? String(req.query.artists).slice(0, 300) : null,
    album: req.query.album ? String(req.query.album).slice(0, 200) : null,
    single: req.query.single === '1',
    date: req.query.date ? String(req.query.date).slice(0, 10) : null,
    genres: req.query.genres ? String(req.query.genres).slice(0, 200) : null,
  };
  const job = newJob({ dest: params.dest, channel: params.channel, device: params.device });
  res.json({ ok: true, jobId: job.id });
  scheduleJob(job, params);
});

// Cap concurrent job downloads — a playlist "download all" queues dozens of
// jobs at once, and the Pi can't run that many yt-dlp processes in parallel.
// Excess jobs wait in FIFO order with their 'queued' status showing in the UI.
const MAX_ACTIVE_JOBS = Math.max(1, Number(process.env.MAX_ACTIVE_JOBS) || 2);
let activeJobs = 0;
const pendingJobs = [];
function scheduleJob(job, params) {
  const run = () => {
    activeJobs++;
    runJob(job, params)
      .catch((e) => setJob(job, { status: 'error', phase: null, error: String(e.message || e) }))
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
    if (j.status === 'done' || j.status === 'error') {
      if (j.deliverTemp && j.finalPath) fs.rm(j.finalPath, { force: true }, () => {});
      jobsMap.delete(id);
    }
  }
  res.json({ ok: true });
});

// Download a job and write it (with metadata + .md sidecar) into the channel's
// _import folder. Shared by the batch profile downloader.
async function saveJobToImport(job, channel, web, quality) {
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
  if (!upstream.ok || !upstream.body) throw new Error(`upstream HTTP ${upstream.status}`);
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
function downloadYtdlp(job, dest, opts = {}) {
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
    const args = [
      '--no-warnings',
      '--no-playlist',
      '-f',
      fmt,
      ...(isTikTok ? ['-S', 'vcodec:h264'] : []),
      '--merge-output-format',
      opts.container || 'mp4',
      ...(opts.embedThumb ? ['--embed-thumbnail'] : []),
      ...(opts.embedSubs ? ['--embed-subs'] : []),
      ...(opts.embedMeta ? ['--embed-metadata'] : []),
      ...(opts.sponsorblock ? ['--sponsorblock-remove', 'all'] : []),
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
    p.on('error', reject);
    p.on('close', (code) => {
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
function downloadYtdlpAudio(job, destNoExt, afmt, opts = {}) {
  return new Promise((resolve, reject) => {
    // 'best' keeps the source codec, whose extension we can't predict — let
    // yt-dlp report it; for a known format the extension equals afmt.
    const args = [
      '--no-warnings', '--no-playlist',
      '-f', 'ba/b', '-x', '--audio-format', afmt,
      ...(opts.aq ? ['--audio-quality', opts.aq] : []),
      ...(opts.embedThumb ? ['--embed-thumbnail'] : []),
      ...(opts.sponsorblock ? ['--sponsorblock-remove', 'all'] : []),
      '--embed-metadata',
      '-o', `${destNoExt}.%(ext)s`, '--', job.url,
    ];
    const p = spawn(YTDLP, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
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
// Images don't belong in a video pipeline, so they always land in the photos
// library (any extension preserved). Used for mixed albums like erome.

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

// Download a direct image into the photos library; returns its path.
async function saveImageToLibrary(job) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const ext = safeExt(job.ext, 'jpg');
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const finalPath = path.join(PHOTOS_DIR, `${stem}.${ext}`);
  await downloadDirect(job, finalPath);
  return finalPath;
}

// Single-image handler: save into the photos library and optionally stream it.
async function downloadImage(res, job, url, device) {
  const stem = `${safeCreator(job.creator)}_-_${safeTitle(job.title)}`;
  const ext = safeExt(job.ext, 'jpg');
  const outName = `${stem}.${ext}`;
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const libPath = path.join(PHOTOS_DIR, outName);
  const already = fs.existsSync(libPath);
  try {
    if (!already) await downloadDirect(job, libPath);
    recordHistory({
      creator: job.creator || null,
      title: job.title || null,
      channel: 'server/photos',
      filename: outName,
      sourceUrl: job.sourceUrl || url,
      thumbnail: job.thumbnail || null,
      extractor: job.extractor || null,
      imported: false,
      device: !!device,
    });
    if (!device) {
      return res.json({ ok: true, saved: !already, dest: 'server', dir: 'photos', filename: outName });
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
