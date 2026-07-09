// Shared helpers for extractors.

// Turn a raw, messy description into a concise human title:
// drop hashtags and markdown noise, collapse whitespace, cap the length.
function cleanTitle(text, max = 90) {
  const out = String(text || '')
    .replace(/#[\p{L}\p{N}_]+/gu, '') // hashtags
    .replace(/https?:\/\/\S+/g, '') // stray links
    .replace(/[#*_`~>|]+/g, ' ') // markdown punctuation
    .replace(/\s+/g, ' ') // collapse newlines/spaces
    .trim()
    .slice(0, max)
    .trim();
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

module.exports = { cleanTitle, cleanDescription, titleFrom };
