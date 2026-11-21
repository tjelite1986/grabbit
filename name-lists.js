'use strict';
// Artist and genre list splitters, moved verbatim out of server.js (Phase 2,
// slice 4); splitArtists' band handling and the entity join came later. Pure
// and stateless: no I/O, no requires, no module state. Callers in server.js:
// splitArtists (musicIdentity, itunesCandidate, soundcloudCandidate,
// candidateKey, produceAudio), addEntity/joinEntityRuns (musicMetaCandidates,
// musicMetaLookup), splitList (audiobookMeta, GET /api/music-meta tag query,
// POST /api/music/edit, produceAudio), splitGenres (audiobookMeta,
// POST /api/music/edit, produceAudio).

// "A & B feat. C" -> ['A', 'B', 'C']: the separators music databases use in
// their artist strings. Only for database/site strings — user-typed fields go
// through splitList, where '&' must survive ("Hootie & the Blowfish", "R&B").
//
// A band name looks exactly like a credit line ("Simon & Garfunkel" next to
// "Calvin Harris & Dua Lipa"), so three things keep a name whole:
//   - '&' only separates with whitespace on both sides ("R&B", "AC&DC").
//   - "& the ..." is a band, not a second artist ("Bob Marley & The Wailers").
//   - `known(name)` says the library already files it as one artist
//     ("Earth, Wind & Fire"). Optional; the caller supplies it, so this module
//     stays pure. Checked on each feat-part first, then on each comma part.
function splitArtists(s, known) {
  const isKnown = typeof known === 'function' ? known : () => false;
  const out = [];
  const add = (t) => {
    const v = t.trim();
    if (v) out.push(v);
  };
  for (const credit of String(s || '').split(/\s+(?:featuring|feat\.?|ft\.?)\s+/i)) {
    if (isKnown(credit.trim())) {
      add(credit);
      continue;
    }
    for (const part of credit.split(/\s*[,;]\s*/)) {
      if (isKnown(part.trim())) {
        add(part);
        continue;
      }
      part.split(/\s+&\s+(?!the\s)/i).forEach(add);
    }
  }
  return out;
}

// Deezer names an artist ENTITY, iTunes a credit line. When a Deezer row in the
// same lookup calls "Simon & Garfunkel" one artist, a row that split it into
// ["Simon", "Garfunkel"] is put back together: the first download of a band has
// no library entry for `known` to find yet. `fold` is the caller's comparison
// fold (foldName), passed in so this module stays free of requires.
//
// addEntity records a name only if splitArtists would split it, longest first
// so a three-part entity wins over a two-part one inside it.
function addEntity(entities, name, fold) {
  const parts = splitArtists(name).map(fold);
  if (parts.length < 2 || !parts.every(Boolean) || entities.some((e) => e.name === name)) return;
  entities.push({ name, parts });
  entities.sort((x, y) => y.parts.length - x.parts.length);
}

// Only an exact, in-order run of an entity's own parts is joined, so "Calvin
// Harris & Dua Lipa" (Deezer: "Calvin Harris") stays two artists.
function joinEntityRuns(artists, entities, fold) {
  if (!entities.length) return artists;
  const folded = artists.map(fold);
  const out = [];
  for (let i = 0; i < artists.length; ) {
    const hit = entities.find((e) => e.parts.every((p, j) => folded[i + j] === p));
    if (hit) {
      out.push(hit.name);
      i += hit.parts.length;
    } else {
      out.push(artists[i]);
      i++;
    }
  }
  return out;
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

module.exports = { splitArtists, splitList, splitGenres, addEntity, joinEntityRuns };
