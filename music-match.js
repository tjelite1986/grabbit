'use strict';
// Music title and artist normalisers for "do we already have this song?",
// moved verbatim out of server.js (Phase 2, slice 5). Pure and stateless: no
// I/O, no requires, no module state. Callers in server.js: buildMusicIndex
// (titleCandidates, artistParts) and libraryMatch (all four).

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

// Does `name` appear as whole words inside `text`? Both are already normalised
// to lowercase words, so padding makes this a word-boundary test.
function namedIn(name, text) {
  return name.length >= 3 && ` ${text} `.includes(` ${name} `);
}

module.exports = { musicNorm, artistParts, titleCandidates, namedIn };
