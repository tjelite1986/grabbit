'use strict';
// What a source said about an item, kept apart from what the owner says.
//
// Three tag origins, never mixed:
// - 'site':    tags or categories the source hands out as such (yt-dlp `tags`
//              and `categories`, redgifs/tikporn/xfree/xxxfollow/erome tag
//              lists). Extractors put them on the job as `sourceTags` /
//              `categories`.
// - 'caption': hashtags written in the caption (`#word`), read here from the
//              job's description. A site tag that is also a hashtag is kept
//              under both origins: each is true on its own.
// - 'user':    the owner's own tags (item-store, not here).
// A source without tags gives no tags. Nothing is inferred from titles, file
// names or creators.

const TAG_MAX_CHARS = 100;
const TAGS_PER_ORIGIN_MAX = 100;
const DESCRIPTION_MAX_CHARS = 20000;
const RAW_MAX_BYTES = 64 * 1024;
const HASHTAG_RE = /#([\p{L}\p{N}_]{1,100})/gu;

// The text a tag is shown with: trimmed, no leading '#', whitespace collapsed,
// no control characters, at most TAG_MAX_CHARS code points. '' when nothing is
// left.
function tagLabel(value) {
  if (value == null || typeof value === 'object') return '';
  const s = String(value)
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/^[\s#]+/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...s].slice(0, TAG_MAX_CHARS).join('').trim();
}

// The key two tags are compared on: the label, NFKC-folded and lower-cased.
// "#Beach", "beach" and "BEACH" are one tag; "big dick" and "bigdick" are not
// (that would be guessing).
function tagNorm(value) {
  return tagLabel(value).normalize('NFKC').toLocaleLowerCase('und');
}

// Unique tags by norm, first spelling wins, capped.
function uniqueTags(list, max = TAGS_PER_ORIGIN_MAX) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    const label = tagLabel(v);
    const norm = tagNorm(label);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ label, norm });
    if (out.length >= max) break;
  }
  return out;
}

// Hashtags written in a caption, in order of appearance.
function captionHashtags(text) {
  const found = [];
  for (const m of String(text || '').matchAll(HASHTAG_RE)) found.push(m[1]);
  return uniqueTags(found);
}

// Cuts a JSON-able value down to RAW_MAX_BYTES by dropping the largest
// top-level keys first; returns a JSON string or null.
function capRaw(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let json;
  try {
    json = JSON.stringify(obj);
  } catch {
    return null;
  }
  if (Buffer.byteLength(json) <= RAW_MAX_BYTES) return json;
  const entries = Object.entries(obj)
    .map(([k, v]) => [k, v, Buffer.byteLength(JSON.stringify(v) || '')])
    .sort((a, b) => a[2] - b[2]);
  const kept = {};
  let size = 2;
  const dropped = [];
  for (const [k, v, n] of entries) {
    if (size + n + k.length + 4 > RAW_MAX_BYTES - 200) dropped.push(k);
    else {
      kept[k] = v;
      size += n + k.length + 4;
    }
  }
  if (dropped.length) kept._dropped = dropped.slice(0, 50);
  return JSON.stringify(kept);
}

// The fields of a yt-dlp info dict worth keeping. The full dict carries every
// format and fragment URL (often megabytes, and the URLs expire), so only the
// descriptive part is kept.
const YTDLP_FIELDS = [
  'id', 'extractor', 'extractor_key', 'webpage_url', 'title', 'fulltitle', 'description',
  'uploader', 'uploader_id', 'uploader_url', 'channel', 'channel_id', 'channel_url',
  'creator', 'creators', 'timestamp', 'upload_date', 'release_date', 'release_year', 'duration',
  'tags', 'categories', 'genre', 'genres', 'age_limit', 'like_count', 'view_count', 'comment_count',
  'repost_count', 'track', 'artist', 'artists', 'album', 'album_artist', 'location',
  'playlist_id', 'playlist_title', 'series', 'season_number', 'episode_number', 'language',
];
function ytdlpRaw(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {};
  for (const k of YTDLP_FIELDS) {
    if (info[k] !== undefined && info[k] !== null && info[k] !== '') out[k] = info[k];
  }
  return Object.keys(out).length ? out : null;
}

// The source metadata of a resolved job, ready for the item store.
// `job.sourceMeta` is the extractor's raw record (a yt-dlp info subset, an API
// object, a sidecar); without one the job's own descriptive fields stand in,
// marked as such.
function fromJob(job) {
  if (!job || typeof job !== 'object') return null;
  const description = typeof job.description === 'string' && job.description.trim()
    ? job.description.slice(0, DESCRIPTION_MAX_CHARS)
    : null;
  const siteTags = uniqueTags(job.sourceTags);
  const categories = uniqueTags(job.categories);
  const captionTags = captionHashtags(description);
  let raw = null;
  if (job.sourceMeta && typeof job.sourceMeta === 'object') raw = capRaw({ from: 'extractor', ...job.sourceMeta });
  else {
    const fields = {};
    for (const k of ['site', 'mediaId', 'sourceUrl', 'creator', 'creatorUrl', 'title', 'duration', 'albumId']) {
      if (job[k] !== undefined && job[k] !== null && job[k] !== '') fields[k] = job[k];
    }
    raw = Object.keys(fields).length ? capRaw({ from: 'job', ...fields }) : null;
  }
  if (!description && !siteTags.length && !categories.length && !raw) return null;
  return {
    extractor: job.extractor || job.site || null,
    description,
    raw,
    tags: [
      ...siteTags.map((t) => ({ ...t, origin: 'site', kind: 'tag' })),
      ...categories.map((t) => ({ ...t, origin: 'site', kind: 'category' })),
      ...captionTags.map((t) => ({ ...t, origin: 'caption', kind: 'tag' })),
    ],
  };
}

module.exports = {
  TAG_MAX_CHARS,
  TAGS_PER_ORIGIN_MAX,
  DESCRIPTION_MAX_CHARS,
  RAW_MAX_BYTES,
  tagLabel,
  tagNorm,
  uniqueTags,
  captionHashtags,
  capRaw,
  ytdlpRaw,
  fromJob,
};
