'use strict';
// Started as parity for the Phase 2 slice 4 move (expected values captured from
// the pre-move server.js). splitArtists has since changed on purpose: band names
// ("Hootie & the Blowfish", "R&B", library-known "Simon & Garfunkel") stay whole.
// The other cases still pin the old behaviour, odd parts included ("lo  fi hip hop"
// becomes four genres): a behaviour change belongs in its own commit with its own
// test update.
const test = require('node:test');
const assert = require('node:assert');
const { splitArtists, splitList, splitGenres, addEntity, joinEntityRuns } = require('../name-lists');

function check(fn, cases) {
  for (const [input, expected] of cases) assert.deepStrictEqual(fn(input), expected, String(input));
}

test('splitArtists: database separators split, empty input is empty', () => {
  check(splitArtists, [
    ["A & B feat. C", ["A","B","C"]],
    ["A, B; C ft. D", ["A","B","C","D"]],
    ["Hootie & the Blowfish", ["Hootie & the Blowfish"]],
    ["R&B", ["R&B"]],
    ["", []],
    [null, []],
    [undefined, []],
    ["  ", []],
    ["X featuring Y", ["X","Y"]],
    ["X FEAT Y", ["X","Y"]],
    ["a ,, b", ["a","b"]],
    ["Simon & Garfunkel, Abba", ["Simon","Garfunkel","Abba"]],
    ["Daft Punk ft Pharrell", ["Daft Punk","Pharrell"]],
    ["Soft Cell;", ["Soft Cell"]],
  ]);
});

test('splitArtists: band names stay whole', () => {
  check(splitArtists, [
    ["Bob Marley & The Wailers", ["Bob Marley & The Wailers"]],
    ["Echo & the Bunnymen feat. X", ["Echo & the Bunnymen","X"]],
    ["AC&DC", ["AC&DC"]],
    ["A &B", ["A &B"]],
    ["Calvin Harris & Dua Lipa", ["Calvin Harris","Dua Lipa"]],
    ["Tom & Theo", ["Tom","Theo"]],
  ]);
});

test('splitArtists: a name the library knows is kept whole', () => {
  const lib = new Set(['simon & garfunkel', 'earth, wind & fire']);
  const known = (n) => lib.has(n.toLowerCase());
  const cases = [
    ["Simon & Garfunkel", ["Simon & Garfunkel"]],
    ["Simon & Garfunkel, Abba", ["Simon & Garfunkel","Abba"]],
    ["Earth, Wind & Fire", ["Earth, Wind & Fire"]],
    ["Earth, Wind & Fire feat. Simon & Garfunkel", ["Earth, Wind & Fire","Simon & Garfunkel"]],
    ["A & B feat. C", ["A","B","C"]],
    ["Simon & Garfunkel & Abba", ["Simon","Garfunkel","Abba"]],
  ];
  for (const [input, expected] of cases) assert.deepStrictEqual(splitArtists(input, known), expected, input);
  // Without a predicate (or with a non-function) nothing is known.
  assert.deepStrictEqual(splitArtists('Simon & Garfunkel'), ['Simon', 'Garfunkel']);
  assert.deepStrictEqual(splitArtists('Simon & Garfunkel', 'x'), ['Simon', 'Garfunkel']);
});

test('joinEntityRuns: a Deezer entity rejoins an in-order run of its parts only', () => {
  const fold = (n) => String(n).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const entities = [];
  addEntity(entities, 'Simon & Garfunkel', fold);
  addEntity(entities, 'Simon & Garfunkel', fold); // no duplicate
  addEntity(entities, 'Calvin Harris', fold); // one part: not an entity
  addEntity(entities, 'Earth, Wind & Fire', fold);
  addEntity(entities, 'Prince & The Revolution', fold); // already whole: not an entity
  assert.deepStrictEqual(entities.map((e) => e.name), ['Earth, Wind & Fire', 'Simon & Garfunkel']);
  const cases = [
    [['Simon', 'Garfunkel'], ['Simon & Garfunkel']],
    [['SIMON', 'garfunkel', 'Abba'], ['Simon & Garfunkel', 'Abba']],
    [['Abba', 'Simon', 'Garfunkel'], ['Abba', 'Simon & Garfunkel']],
    [['Garfunkel', 'Simon'], ['Garfunkel', 'Simon']],
    [['Simon'], ['Simon']],
    [['Simon', 'X', 'Garfunkel'], ['Simon', 'X', 'Garfunkel']],
    [['Justin Timberlake', 'Earth', 'Wind', 'Fire'], ['Justin Timberlake', 'Earth, Wind & Fire']],
    [['Calvin Harris', 'Dua Lipa'], ['Calvin Harris', 'Dua Lipa']],
    [[], []],
  ];
  for (const [input, expected] of cases) assert.deepStrictEqual(joinEntityRuns(input, entities, fold), expected, input.join('|'));
  const same = ['A', 'B'];
  assert.strictEqual(joinEntityRuns(same, [], fold), same);
});

test('splitList: only comma and semicolon split, ampersand survives', () => {
  check(splitList, [
    ["A & B feat. C", ["A & B feat. C"]],
    ["A, B; C ft. D", ["A","B","C ft. D"]],
    ["Hootie & the Blowfish", ["Hootie & the Blowfish"]],
    ["R&B", ["R&B"]],
    ["", []],
    [null, []],
    [undefined, []],
    ["  ", []],
    ["X featuring Y", ["X featuring Y"]],
    ["X FEAT Y", ["X FEAT Y"]],
    ["a ,, b", ["a","b"]],
    ["Simon & Garfunkel, Abba", ["Simon & Garfunkel","Abba"]],
    ["Daft Punk ft Pharrell", ["Daft Punk ft Pharrell"]],
    ["Soft Cell;", ["Soft Cell"]],
  ]);
});

test('splitGenres: separator is chosen from the text, connectors keep a name whole', () => {
  check(splitGenres, [
    ["#neurofunk #darkdnb", ["neurofunk","darkdnb"]],
    ["Drum & Bass, Techno", ["Drum & Bass","Techno"]],
    ["neurofunk darkdnb dnb", ["neurofunk","darkdnb","dnb"]],
    ["Rhythm and Blues", ["Rhythm and Blues"]],
    ["drum & bass", ["drum & bass"]],
    ["  ", []],
    ["", []],
    [null, []],
    ["Techno,techno; TECHNO", ["Techno"]],
    ["#a  b #A", ["a b","A"]],
    ["lo  fi hip hop", ["lo","fi","hip","hop"]],
    ["a;b,c", ["a","b","c"]],
    ["Rock n Roll", ["Rock n Roll"]],
    ["the cure", ["the cure"]],
  ]);
});
