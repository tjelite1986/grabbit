'use strict';
// Parity for the Phase 2 slice 5 move (expected values captured from the
// pre-move server.js). A behaviour change belongs in its own commit with its
// own test update.
const test = require('node:test');
const assert = require('node:assert');
const { musicNorm, artistParts, titleCandidates, namedIn } = require('../music-match');

test('musicNorm strips site noise and keeps every script', () => {
  const cases = [
    ['STARSET - Brave New World (Official Music Video)', 'starset brave new world'],
    ['Rocco, Pulsedriver & Ninkid', 'rocco pulsedriver ninkid'],
    ['Artist - Topic', 'artist'],
    ['Café del Mar HD', 'cafe del mar'],
    ['日本語 タイトル', '日本語 タイトル'],
    ['Song (Live at Wembley)', 'song live at wembley'],
    [null, ''],
    [undefined, ''],
    [0, '0'],
  ];
  for (const [input, expected] of cases) assert.strictEqual(musicNorm(input), expected, String(input));
});

test('artistParts indexes the whole line and each credited artist', () => {
  assert.deepStrictEqual(artistParts(['Rocco, Pulsedriver & Ninkid']), ['rocco pulsedriver ninkid', 'rocco', 'pulsedriver', 'ninkid']);
  assert.deepStrictEqual(artistParts(['A feat. B', 'B']), ['a feat b', 'a', 'b']);
  assert.deepStrictEqual(artistParts(null), []);
});

test('titleCandidates drops an artist prefix but keeps a live suffix', () => {
  assert.deepStrictEqual(
    titleCandidates('STARSET - Brave New World (Official Music Video)', ['STARSET']),
    ['starset brave new world', 'brave new world'],
  );
  assert.deepStrictEqual(titleCandidates('Song (Live at Wembley)', []), ['song live at wembley']);
  assert.deepStrictEqual(titleCandidates('', ['x']), []);
});

test('namedIn is a whole-word test with a three-character floor', () => {
  assert.strictEqual(namedIn('starset', 'starset brave new world'), true);
  assert.strictEqual(namedIn('star', 'starset brave new world'), false);
  assert.strictEqual(namedIn('ab', 'ab cd'), false);
});
