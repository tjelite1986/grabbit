'use strict';
// Artist and genre list splitters, moved verbatim out of server.js (Phase 2,
// slice 4). Pure and stateless: no I/O, no requires, no module state. Callers
// in server.js: splitArtists (musicIdentity, itunesCandidate, soundcloudCandidate,
// the Deezer branch of musicMetaCandidates, produceAudio), splitList
// (audiobookMeta, GET /api/music-meta tag query, POST /api/music/edit,
// produceAudio), splitGenres (audiobookMeta, POST /api/music/edit, produceAudio).

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

module.exports = { splitArtists, splitList, splitGenres };
