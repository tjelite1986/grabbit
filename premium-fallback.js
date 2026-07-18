// YouTube Music premium-locked videos: some auto-generated ("Topic") video IDs
// are gated as "only available to Music Premium members" (or show up as
// unavailable) in a given region, while the exact same recording exists under
// a different, free video ID — typically after the artist switched music
// distributors. music.youtube.com knows the mapping and embeds the redirect
// target in its watch page; when it does not, a plain search for the track
// usually surfaces a free counterpart. See yt-dlp/yt-dlp#14066.

const { spawn } = require('child_process');

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
// A browser UA is required for music.youtube.com to serve the real watch page.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';

// Deterministic lock — a plain retry can never clear it (unlike YouTube's
// intermittent "Video unavailable" flakes, which often succeed on retry).
function isMusicPremiumLock(msg) {
  return /only available to Music Premium members/i.test(String(msg || ''));
}

// Errors worth attempting the free-counterpart lookup for. "Video
// unavailable" also covers genuinely deleted videos — the lookup then finds
// nothing and the original error stands. findFreeAlternate() only acts on
// YouTube URLs, so the broad match cannot misfire on other sites.
function isRecoverableYoutubeError(msg) {
  const s = String(msg || '');
  return (
    /only available to Music Premium members/i.test(s) ||
    /Video unavailable/i.test(s) ||
    /not available in your country/i.test(s)
  );
}

function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host !== 'youtube.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'en' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// The music.youtube.com watch page for a locked ID carries the free
// counterpart's ID in its initial player payload (the first videoId in the
// page differs from the requested one only when such a redirect exists).
async function ytmRedirectId(id) {
  const html = await fetchText(`https://music.youtube.com/watch?v=${id}`);
  const ids = [];
  // The payload occurs JSON-escaped (inside INITIAL_ENDPOINT) and plain.
  for (const re of [/\\"videoId\\":\\"([\w-]{11})\\"/g, /"videoId":"([\w-]{11})"/g]) {
    for (const m of html.matchAll(re)) ids.push(m[1]);
  }
  return ids.find((v) => v !== id) || null;
}

// oEmbed still serves title + channel for premium-locked videos.
async function oembed(id) {
  const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
  const j = JSON.parse(await fetchText(`https://www.youtube.com/oembed?url=${watch}&format=json`));
  return { title: j.title || '', author: j.author_name || '' };
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Words that mark a different rendition; penalized only when the original
// title does not carry them itself.
const VARIANT = /\b(remix|nightcore|live|cover|acoustic|karaoke|instrumental|sped.?up|slowed|8d|reverb|lyrics?|edit)\b/i;

function flatSearch(query, n = 8) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP, ['--flat-playlist', '-J', '--no-warnings', '--', `ytsearch${n}:${query}`]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        const data = JSON.parse(out);
        resolve(Array.isArray(data.entries) ? data.entries.filter(Boolean) : []);
      } catch {
        resolve([]);
      }
    });
    p.on('error', () => resolve([]));
  });
}

// Search for a free upload of the same track and pick the closest match: the
// artist's auto-generated "Topic" upload first, then the artist's own channel.
// The track title must actually appear in the result title.
async function searchFreeCopy(id, title, author) {
  const artist = author.replace(/\s*-\s*Topic$/i, '').trim();
  const entries = await flatSearch(`${artist} ${title}`);
  const nTitle = norm(title);
  const nArtist = norm(artist);
  let best = null;
  for (const e of entries) {
    if (!e.id || e.id === id) continue;
    const eTitle = norm(e.title);
    const eChannel = norm(e.channel || e.uploader || '');
    if (!eTitle.includes(nTitle) && !nTitle.includes(eTitle)) continue;
    if (VARIANT.test(e.title || '') && !VARIANT.test(title)) continue;
    let score = 0;
    if (eChannel === `${nArtist} topic`) score += 3;
    else if (nArtist && eChannel.includes(nArtist)) score += 2;
    if (eTitle === nTitle) score += 1;
    if (!best || score > best.score) best = { id: e.id, score };
  }
  return best && best.score > 0 ? best.id : null;
}

// null when no free counterpart could be found; otherwise
// { url, via: 'ytmusic-redirect' | 'search' }.
async function findFreeAlternate(url) {
  const id = youtubeVideoId(url);
  if (!id) return null;
  const redirect = await ytmRedirectId(id).catch(() => null);
  if (redirect) return { url: `https://www.youtube.com/watch?v=${redirect}`, via: 'ytmusic-redirect' };
  const meta = await oembed(id).catch(() => null);
  if (!meta || !meta.title) return null;
  const found = await searchFreeCopy(id, meta.title, meta.author).catch(() => null);
  return found ? { url: `https://www.youtube.com/watch?v=${found}`, via: 'search' } : null;
}

module.exports = { isRecoverableYoutubeError, isMusicPremiumLock, findFreeAlternate, youtubeVideoId };
