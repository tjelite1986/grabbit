'use strict';
// Music-name folding and fuzzy title matching, moved verbatim out of server.js
// (Phase 2, slice 3). Pure and stateless: no I/O, no requires, no clock. The
// lookalike table is built once at load and never mutated. Callers in
// server.js: foldName (artistCatalogue, soundcloudCandidate, mergeMatchNames,
// candidateMatch), plainName (soundcloudCandidate), titleClose (candidateMatch).

/**
 * Decorative letterforms, flattened onto the ASCII letter they are drawn as.
 *
 * SoundCloud display names are full of these: "ɢɪᴀɴɴᴏᴛᴛɪ ᴍᴜꜱɪᴄ" is
 * U+0262 U+026A U+1D00 … , not a single ASCII letter in it. Every one of them
 * is \p{L}, so foldName keeps them, and the artist gate in candidateMatch()
 * then compares "ɢɪᴀɴɴᴏᴛᴛɪ" against "giannotti" and says no — the SoundCloud
 * arm would be dead weight for precisely the artists it was added for.
 *
 * NFKD is not enough, which is why this table exists: the mathematical,
 * fullwidth, circled and superscript alphabets DO carry a compatibility
 * decomposition and fold for free, but the small-capital and phonetic
 * extension blocks carry none at all — U+0262 normalises to U+0262 under both
 * NFKD and NFKC. Checked codepoint by codepoint, not from memory.
 *
 * Two of these are real letters somewhere else: ǫ (o with ogonek) and ı
 * (dotless i). A fancy-text generator uses them for Q and I because Unicode
 * has no small-capital of either, and that is how they turn up in an uploader
 * name. Folding them the other way costs nothing here: foldName runs on BOTH
 * sides of every comparison, so a genuine ǫ still equals itself.
 */
const NAME_LOOKALIKES = {
  '\u1D00': 'a', '\u0299': 'b', '\u1D04': 'c', '\u1D05': 'd', '\u1D07': 'e',
  '\uA730': 'f', '\u0262': 'g', '\u029C': 'h', '\u026A': 'i', '\uA7AE': 'i',
  '\u0131': 'i', '\u1D0A': 'j', '\u1D0B': 'k', '\u029F': 'l', '\u1D0D': 'm',
  '\u026F': 'm', '\u0274': 'n', '\u1D0E': 'n', '\u1D0F': 'o', '\u1D18': 'p',
  '\uA7AF': 'q', '\u01EB': 'q', '\u0280': 'r', '\uA731': 's', '\u1D1B': 't',
  '\u1D1C': 'u', '\u1D20': 'v', '\u1D21': 'w', '\u028F': 'y', '\u1D22': 'z',
};
const NAME_LOOKALIKE_RE = new RegExp(`[${Object.keys(NAME_LOOKALIKES).join('')}]`, 'g');

// Compare names the way a listener would: case, punctuation and the version
// suffix a video title carries are not what makes two songs the same.
function foldName(s) {
  return String(s || '')
    // Lowercase FIRST, so the table sees the uppercase forms too. It did not,
    // and three entries were one-way: Ǫ (U+01EA) skipped the table, NFKD
    // decomposed it to o + ogonek and it folded to a plausible, wrong "o"
    // while ǫ folded to "q"; Ɯ and Ʀ survived as non-ASCII letters. Every
    // value in the table is an ASCII lowercase letter, so lowercasing first
    // costs the table nothing.
    .toLowerCase()
    // Still before NFKD: ǫ decomposes to o + combining ogonek, and the table
    // means it as a Q.
    .replace(NAME_LOOKALIKE_RE, (c) => NAME_LOOKALIKES[c])
    .normalize('NFKD')
    // NFKD splits é into e + U+0301, and the letters/digits rule below turns
    // a leftover combining mark into a SPACE — "café" would fold to "caf e"
    // and stop matching "cafe". Dropping the marks is also the accent fold.
    //
    // Only U+0300–U+036F, the Latin diacriticals this fold is for. Dropping
    // every \p{M} also dropped the kana voicing mark NFKD exposes (U+3099),
    // and "ガラ" and "カラ" folded to the same string — a 'full' verdict on a
    // different song. Vietnamese tone marks live in this block beside the
    // accents and do still fold away ("Mà" and "Mã" both give "ma"): they
    // cannot be told from a French accent without knowing the language, and
    // the accent fold is what makes Björk's "Jóga" match at all.
    .replace(/[\u0300-\u036F]+/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring|with)\b.*$/i, ' ')
    // An apostrophe closes up rather than splitting: typed without one,
    // "Monsters" must still fold to the same thing as "Monster's".
    .replace(/['’´`]/g, '')
    // \p{M} is kept here so a mark NFKD left in place stays glued to its
    // letter instead of becoming a space: "ガラ" is one word, not two.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A decorative name rewritten as the letters it is drawn as.
 *
 * foldName answers "are these two the same act?" and its output is never
 * written anywhere. This answers "what do we write down?", and it exists
 * because a SoundCloud row whose title carries no " - " has nothing but the
 * uploader to credit: "ɢɪᴀɴɴᴏᴛᴛɪ ᴍᴜꜱɪᴄ" reached artists[] on those rows, and
 * from there the artist tag, the albumartist and the library folder.
 *
 * Only decoration is touched, and one small class of it is held to a higher
 * bar. A compatibility form is never anything but decoration — nobody spells
 * a name with a fullwidth Ｇ by accident — and neither is a small capital or
 * a phonetic-extension letter, so those are always rewritten, even where a
 * single one sits in an otherwise ordinary word. Exactly two entries in the
 * lookalike table are real letters somewhere else: ǫ is Old Norse and ı is
 * Turkish. Those two only win a word whose letters are MOSTLY decorative, so
 * "Hǫsvaldr" and "Kılıç" survive unchanged while "ǫᴜᴇᴇɴ" does not. Ordinary
 * accents are never stripped — Björk stays Björk, because a letter with a
 * combining mark is not a compatibility form.
 *
 * The gate is unaffected either way — foldName flattens both spellings to the
 * same string, so a row credited to the plain reading still matches the
 * decorative one and vice versa.
 */
// The lookalike entries that are also real letters in a real orthography:
// ǫ (o with ogonek, Old Norse) and ı (dotless i, Turkish). A fancy-text
// generator reaches for them because Unicode has no small-capital Q or I.
const NAME_AMBIGUOUS = new Set(['\u01EB', '\u0131']);

function plainName(s) {
  const src = String(s || '');
  if (!src) return src;
  let touched = false;
  const out = src.split(/(\s+)/).map((word) => {
    if (!word || /^\s+$/.test(word)) return word;
    let letters = 0;
    let drawn = 0;
    let sure = 0;
    let built = '';
    for (const ch of word) {
      if (/\p{L}/u.test(ch)) letters += 1;
      const lower = ch.toLowerCase();
      if (NAME_LOOKALIKES[lower]) {
        built += NAME_LOOKALIKES[lower];
        drawn += 1;
        if (!NAME_AMBIGUOUS.has(lower)) sure += 1;
        continue;
      }
      // A compatibility form whose decomposition is plain ASCII: fullwidth
      // Ｇ, mathematical 𝐆, the ﬁ ligature. An accented letter decomposes to
      // a letter PLUS a combining mark and fails this test, which is the
      // point.
      const nfkd = ch.normalize('NFKD');
      if (nfkd !== ch && /^[\x20-\x7E]+$/.test(nfkd)) {
        built += nfkd;
        sure += 1;
        continue;
      }
      built += ch;
    }
    // A letter that can only be decoration settles it on its own. The two
    // that can be a real letter need the rest of the word behind them, which
    // is what keeps "Hǫsvaldr" spelled the way his mother spells it.
    const drawnWins = drawn * 2 > letters;
    if (!sure && !drawnWins) return word;
    touched = true;
    // A word drawn in small capitals carries no case of its own — they are
    // drawn as capitals whatever letter they stand for — so it is written the
    // way a name is written rather than shouted. A ligature or a fullwidth
    // letter does carry case, and keeps it.
    if (drawnWins && built === built.toLowerCase()) built = built.replace(/^(\p{L})/u, (c) => c.toUpperCase());
    return built;
  });
  return touched ? out.join('').replace(/\s+/g, ' ').trim() : src;
}

// Levenshtein distance, abandoned as soon as it cannot come in under `max` —
// the strings are song titles, so the table is tiny either way.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Two spellings of the same song title.
 *
 * Only ever consulted once the artist has already matched, because on its own
 * a typo's worth of distance is not evidence of anything: within one artist's
 * catalogue "Eyes Dem Open" and "EYES THEM OPEN" are the same track, while
 * across the whole of iTunes they would be a coin flip. Word count must agree
 * so a missing word ("Zero Control" vs "Control") never passes, and short
 * titles get no slack at all — "NWO" and "NWA" are one edit apart.
 */
function titleClose(a, b) {
  if (!a || !b || a === b) return Boolean(a && a === b);
  if (a.split(' ').length !== b.split(' ').length) return false;
  const len = Math.max(a.length, b.length);
  // One edit per 7 characters, and none at all below eight: "Eyes Them Open"
  // against "Eyes Dem Open" is two edits, while "NWO" and "NWA" are one.
  if (len < 8) return false;
  const budget = Math.min(3, Math.max(1, Math.floor(len / 7)));
  return editDistance(a, b, budget) <= budget;
}

module.exports = { foldName, plainName, editDistance, titleClose };
