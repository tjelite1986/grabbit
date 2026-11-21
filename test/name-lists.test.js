'use strict';
// Parity for the Phase 2 slice 4 move: name-lists.js must split exactly as the
// in-server originals did. Expected values were captured from the pre-move server.js.
const test = require('node:test');
const assert = require('node:assert');
const { splitArtists, splitList, splitGenres } = require('../name-lists');

function check(fn, cases) {
  for (const [input, expected] of cases) assert.deepStrictEqual(fn(input), expected, String(input));
}

test('splitArtists: database separators split, empty input is empty', () => {
  check(splitArtists, [
    ["A & B feat. C", ["A","B","C"]],
    ["A, B; C ft. D", ["A","B","C","D"]],
    ["Hootie & the Blowfish", ["Hootie","the Blowfish"]],
    ["R&B", ["R","B"]],
    ["", []],
    [null, []],
    [null, []],
    ["  ", []],
    ["X featuring Y", ["X","Y"]],
    ["X FEAT Y", ["X","Y"]],
    ["a ,, b", ["a","b"]],
    ["Simon & Garfunkel, Abba", ["Simon","Garfunkel","Abba"]],
    ["Daft Punk ft Pharrell", ["Daft Punk","Pharrell"]],
    ["Soft Cell;", ["Soft Cell"]],
  ]);
});

test('splitList: only comma and semicolon split, ampersand survives', () => {
  check(splitList, [
    ["A & B feat. C", ["A & B feat. C"]],
    ["A, B; C ft. D", ["A","B","C ft. D"]],
    ["Hootie & the Blowfish", ["Hootie & the Blowfish"]],
    ["R&B", ["R&B"]],
    ["", []],
    [null, []],
    [null, []],
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
