// Generic fallback: hand the URL to yt-dlp.
//
// yt-dlp supports a huge list of sites out of the box, so any URL that no
// dedicated extractor claims is downloaded with it. The server runs yt-dlp
// (see runYtdlp in server.js); here we only probe metadata for a nice filename.

const { spawn } = require('child_process');
const { cleanTitle } = require('./util');

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';

function match() {
  // Never auto-selected by the registry; used only as the explicit fallback.
  return false;
}

function probe(url) {
  // `yt-dlp -j` prints a single JSON line with metadata without downloading.
  return new Promise((resolve) => {
    const args = ['-j', '--no-warnings', '--no-playlist', '--', url];
    const p = spawn(YTDLP, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(out.trim().split('\n')[0]));
      } catch {
        resolve(null);
      }
    });
    p.on('error', () => resolve(null));
  });
}

// `yt-dlp --flat-playlist -J <url>` -> parsed playlist JSON, or null. Lists a
// playlist/channel/profile's entries without resolving each (fast).
function flatPlaylist(url) {
  return new Promise((resolve) => {
    const args = ['--flat-playlist', '-J', '--no-warnings', '--', url];
    const p = spawn(YTDLP, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    p.on('error', () => resolve(null));
  });
}

function entryThumb(e) {
  if (e.thumbnail) return e.thumbnail;
  if (Array.isArray(e.thumbnails) && e.thumbnails.length) {
    return e.thumbnails[e.thumbnails.length - 1].url || null;
  }
  return null;
}

// Whole-profile/playlist/channel support for ANY yt-dlp site. Throws when the
// URL is a single video (no multi-entry playlist) so the caller treats it as
// a single download instead.
async function resolveProfile(url) {
  const data = await flatPlaylist(url);
  const entries = data && Array.isArray(data.entries) ? data.entries.filter(Boolean) : null;
  if (!entries || entries.length < 2) throw new Error('Not a playlist/profile');
  const creator = data.uploader || data.channel || data.title || 'unknown';
  const items = entries.map((e) => {
    const vid = e.url || e.webpage_url || e.id;
    return {
      kind: 'ytdlp',
      id: String(e.id || vid),
      url: vid,
      title: cleanTitle(e.title) || String(e.id || ''),
      creator: e.uploader || e.channel || creator,
      thumbnail: entryThumb(e),
      duration: Number.isFinite(e.duration) ? e.duration : null,
      sourceUrl: e.webpage_url || vid,
    };
  });
  return { creator, items };
}

async function resolve(url) {
  const info = await probe(url);
  let filename = 'download.mp4';
  let creator = 'unknown';
  let title;
  let description = '';
  let tags = [];
  let thumbnail;
  let duration = null;
  let music = null;
  if (info) {
    creator = info.uploader || info.channel || info.extractor || 'unknown';
    title = cleanTitle(info.title) || info.id;
    description = info.description || '';
    tags = Array.isArray(info.tags) ? info.tags : [];
    thumbnail = info.thumbnail;
    duration = Number.isFinite(info.duration) ? info.duration : null;
    const ext = info.ext || 'mp4';
    const base = (info.uploader ? info.uploader + '-' : '') + (info.id || info.title || 'video');
    filename = `${base}.${ext}`;
    // Music metadata when the site provides it (e.g. YouTube music videos):
    // used to pre-fill the Navidrome tag fields.
    if (info.track || info.artist || info.album) {
      music = {
        artist: info.artist || info.creator || null,
        track: info.track || null,
        album: info.album || null,
        year: info.release_year || (info.release_date ? String(info.release_date).slice(0, 4) : null) || null,
        genre: info.genre || null,
      };
    }
  }
  return { kind: 'ytdlp', url, creator, title, description, tags, thumbnail, duration, filename, sourceUrl: url, music };
}

module.exports = { name: 'generic (yt-dlp)', match, resolve, resolveProfile };
