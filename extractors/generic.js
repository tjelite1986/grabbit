// Generic fallback: hand the URL to yt-dlp.
//
// yt-dlp supports a huge list of sites out of the box, so any URL that no
// dedicated extractor claims is downloaded with it. The server runs yt-dlp
// (see runYtdlp in server.js); here we only probe metadata for a nice filename.

const { spawn } = require('child_process');
const { cleanTitle, titleFrom } = require('./util');
const { cookieArgs } = require('../cookies');
const { isRecoverableYoutubeError, isMusicPremiumLock, findFreeAlternate } = require('../premium-fallback');

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';

function match() {
  // Never auto-selected by the registry; used only as the explicit fallback.
  return false;
}

function probe(url) {
  // `yt-dlp -j` prints a single JSON line with metadata without downloading.
  // Resolves { info, error } — error holds yt-dlp's last stderr line so the
  // caller can react to specific failures (e.g. premium-locked videos).
  return new Promise((resolve) => {
    const ck = cookieArgs(url);
    const args = ['-j', '--no-warnings', '--no-playlist', ...ck.args, '--', url];
    const p = spawn(YTDLP, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      ck.cleanup();
      if (code !== 0) return resolve({ info: null, error: err.trim().split('\n').pop() || `yt-dlp exited ${code}` });
      try {
        resolve({ info: JSON.parse(out.trim().split('\n')[0]), error: null });
      } catch {
        resolve({ info: null, error: 'metadata parse failed' });
      }
    });
    p.on('error', (e) => {
      ck.cleanup();
      resolve({ info: null, error: e.message });
    });
  });
}

// `yt-dlp --flat-playlist -J <url>` -> parsed playlist JSON, or null. Lists a
// playlist/channel/profile's entries without resolving each (fast).
function flatPlaylist(url) {
  return new Promise((resolve) => {
    const ck = cookieArgs(url);
    const args = ['--flat-playlist', '-J', '--no-warnings', ...ck.args, '--', url];
    const p = spawn(YTDLP, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => {
      ck.cleanup();
      if (code !== 0) return resolve(null);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    p.on('error', () => {
      ck.cleanup();
      resolve(null);
    });
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
  // title: playlist/channel display name (e.g. the playlist's own name).
  return { creator, title: data.title || null, items };
}

// A release year only counts when it looks like one: leading 4 digits inside a
// sane range. Accepts both "2019" and a "20190826" date string.
function plausibleYear(v) {
  const y = Number(String(v == null ? '' : v).trim().slice(0, 4));
  const max = new Date().getFullYear() + 1;
  return y >= 1900 && y <= max ? String(y) : null;
}

// Sites that keep hashtags in the caption instead of a tags array (Facebook,
// Instagram, ...) — pull them out so clips still get keywords.
function hashtagsFrom(...texts) {
  const seen = new Set();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(/#([\p{L}\p{N}_]{2,50})/gu)) {
      const tag = m[1].toLowerCase();
      if (!seen.has(tag)) seen.add(tag);
      if (seen.size >= 30) break;
    }
  }
  return [...seen];
}

// Some sites hand out a placeholder where the title should be — a logged-in
// Facebook reel is literally titled "Video", with the real caption in the
// description. Treat those as no title at all.
const PLACEHOLDER_TITLE = /^(video|reel|reels|watch|photo|post|facebook|untitled)$/i;

// Facebook titles arrive as "<n> reactions · <n> comments | <caption> | <page>".
// Keep the caption; the engagement counts and the page name are noise (the page
// is already the creator).
function stripSocialTitleNoise(title, uploader) {
  const parts = String(title || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return title;
  const kept = parts.filter(
    (p, i) =>
      !/^[\d.,km]+\s*(reactions?|comments?|shares?|views?|likes?)\b/i.test(p) &&
      !(i === parts.length - 1 && uploader && p.toLowerCase() === String(uploader).toLowerCase())
  );
  return kept.length ? kept.join(' ') : title;
}

async function resolve(url) {
  const sourceUrl = url;
  let { info, error } = await probe(url);
  // YouTube intermittently reports playable videos as unavailable — re-probe
  // once before hunting for a counterpart ID (premium locks are deterministic).
  if (!info && isRecoverableYoutubeError(error) && !isMusicPremiumLock(error)) {
    await new Promise((r) => setTimeout(r, 2000));
    ({ info, error } = await probe(url));
  }
  // Premium/region-locked YouTube ID: swap in the free counterpart (when one
  // exists) so the rest of the pipeline downloads a playable video.
  if (!info && isRecoverableYoutubeError(error)) {
    const alt = await findFreeAlternate(url).catch(() => null);
    if (alt) {
      const retry = await probe(alt.url);
      if (retry.info) {
        console.warn(`unavailable-video fallback (${alt.via}): ${url} -> ${alt.url}`);
        info = retry.info;
        url = alt.url;
        // The counterpart is often a regular video upload with no music
        // metadata — carry over the locked original's clean artist/track so
        // tagging (and the genre lookup) get proper values instead of the
        // channel name and raw video title.
        if (alt.origin && !info.track && !info.artist) {
          info.track = alt.origin.title;
          info.artist = alt.origin.artist;
        }
      }
    }
  }
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
    description = info.description || '';
    tags = Array.isArray(info.tags) && info.tags.length ? info.tags : hashtagsFrom(info.description, info.title);
    title = cleanTitle(stripSocialTitleNoise(info.title, info.uploader));
    // A placeholder title (or none) means the caption is the real title.
    if (!title || PLACEHOLDER_TITLE.test(title)) title = titleFrom(description, tags, info.id);
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
        // release_date first: YouTube Music's release_year is sometimes junk
        // (a "1674" next to a 2019-08-26 release date). Anything outside a
        // plausible range is dropped rather than written into a tag.
        year: plausibleYear(info.release_date) || plausibleYear(info.release_year) || plausibleYear(info.upload_date) || null,
        // YouTube's "genre" is the video category ("Music", "Film & Animation"),
        // not a music genre — worthless as a tag, so only pass it through for
        // other sites.
        genre: /youtube/i.test(info.extractor || '') ? null : info.genre || null,
      };
    }
  }
  // sourceUrl stays the pasted URL so the downloaded-registry dedupe keys off
  // what the user actually entered, even when a premium fallback swapped url.
  // Probing can fail while the download itself still works, so a failure is not
  // fatal here — but it leaves every field at its "unknown" default, which on
  // its own looks like a broken link rather than a broken extractor. Pass the
  // reason along so the UI can say what actually went wrong.
  const probeError = info ? null : error || 'Could not read metadata for this link.';
  // The site's own id for this video, plus which site it came from. Stable
  // across the different share URLs one clip can have (a Facebook reel is
  // reachable as /share/r/<code>, /share/v/<code> and /reel/<id>), so the
  // downloaded-registry can recognise a repeat even from a brand new link.
  const mediaId = info && info.id ? String(info.id) : null;
  const site = info ? String(info.extractor_key || info.extractor || '').toLowerCase() || null : null;
  return { kind: 'ytdlp', url, creator, title, description, tags, thumbnail, duration, filename, sourceUrl, music, probeError, mediaId, site };
}

module.exports = { name: 'generic (yt-dlp)', match, resolve, resolveProfile };
