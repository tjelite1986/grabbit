// Shared helpers for extractors.

// Turn a raw, messy description into a concise human title:
// drop hashtags and markdown noise, collapse whitespace, cap the length.
function cleanTitle(text, max = 90) {
  const cleaned = String(text || '')
    .replace(/#[\p{L}\p{N}_]+/gu, '') // hashtags
    .replace(/https?:\/\/\S+/g, '') // stray links
    .replace(/[#*_`~>|]+/g, ' ') // markdown punctuation
    .replace(/\s+/g, ' ') // collapse newlines/spaces
    .trim();
  // Cap by code points — a plain .slice() can cut an emoji's surrogate pair in
  // half at the boundary and leave a lone surrogate in filenames/captions.
  const out = [...cleaned].slice(0, max).join('').trim();
  // If nothing meaningful is left (e.g. a hashtags-only caption), report empty
  // so callers fall back to the video id.
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

// Clean a caption/description for display: strip line-leading markdown markers
// (`# `, `## `) and marker-only lines, but keep real hashtags like #word.
function cleanDescription(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*#+\s+/, '').trim()) // drop "# " / "## " prefixes
    .filter((l) => l && !/^#+$/.test(l)) // drop marker-only lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Pick the best human title: the real caption, else the hashtags (more readable
// than a cryptic id), else the id as a last resort.
function titleFrom(desc, tags, id) {
  const t = cleanTitle(desc);
  if (t) return t; // real caption (assumed unique per clip)
  // No caption: use the hashtags, but keep the id so clips that share the same
  // tags still get unique filenames (elite-v2 dedups on the name).
  if (Array.isArray(tags) && tags.length) {
    return tags.map((x) => String(x).replace(/^#/, '')).join(' ') + ' ' + id;
  }
  return id;
}

// Words a music upload hangs off its title that are not part of the song name.
const TITLE_NOISE =
  /\b(official\s*(music\s*)?(video|audio|visuali[sz]er)?|music\s*video|lyrics?\s*video|lyrics?|visuali[sz]er|free\s*(dl|download)|out\s*now|premiere|full\s*stream|hd|hq|4k)\b/gi;

// A parenthetical that names a VERSION of the song is part of its title
// ("(Radio Edit)", "(feat. X)", "(Live)") — everything else in brackets is
// upload noise ("(Official Video)", "[NCS Release]", "(Jump Up 2026)").
const VERSION_PAREN =
  /\b(remix|rmx|mix|edit|version|instrumental|acoustic|live|remaster(ed)?|bootleg|vip|dub|cover|extended|radio|feat\.?|ft\.?|featuring|with)\b/i;

function stripNoiseBrackets(text) {
  return String(text || '').replace(/[([{]([^)\]}]*)[)\]}]/g, (whole, inner) =>
    VERSION_PAREN.test(inner) ? whole : ' '
  );
}

// A channel is not always an artist name, but the two YouTube conventions
// that mark it as one are worth undoing.
function artistFromChannel(channel) {
  return String(channel || '')
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/\s*VEVO\s*$/i, '')
    .trim();
}

/**
 * Read "Artist – Track" out of a plain upload title.
 *
 * yt-dlp only reports artist/track for YouTube Music and topic channels; a
 * label or artist channel uploading the same song hands over nothing but the
 * title, so the title IS the metadata. Returns null when the title carries no
 * separator and the channel gives nothing to fall back on — a guess worse than
 * that belongs in the user's hands, not in a tag.
 */
function parseTrackTitle(rawTitle, channel) {
  const cleaned = stripNoiseBrackets(rawTitle)
    .replace(TITLE_NOISE, ' ')
    .replace(/\s*[|·•]\s*/g, ' ') // leftover separators around the noise
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '')
    .trim();
  if (!cleaned) return null;

  const artistChannel = artistFromChannel(channel);
  // Only a SPACED dash splits: "Jay-Z" and "Blink-182" must survive intact.
  const parts = cleaned.split(/\s+[–—-]\s+/);
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const track = parts.slice(1).join(' - ').trim();
    // A long left-hand side reads as a sentence, not a credit line.
    if (artist && track && artist.length <= 45) return { artist, track };
  }

  if (!artistChannel) return null;
  // No separator: the channel is the artist, and the title is the song — minus
  // the channel name when the uploader prefixed it ("GIANNOTTI MUSIC Control").
  const track = cleaned
    .replace(new RegExp(`^${artistChannel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\-–—]?\\s*`, 'i'), '')
    .trim();
  return track ? { artist: artistChannel, track } : null;
}

module.exports = { cleanTitle, cleanDescription, titleFrom, parseTrackTitle, artistFromChannel };
