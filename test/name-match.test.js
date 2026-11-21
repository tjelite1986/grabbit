'use strict';
// Parity for the Phase 2 slice 3 move: name-match.js must fold, rewrite and
// compare exactly as the in-server originals did. Expected values were captured
// from the pre-move server.js.
const test = require('node:test');
const assert = require('node:assert');
const { foldName, plainName, editDistance, titleClose } = require('../name-match');

test('foldName: case, accents, version suffixes, lookalikes', () => {
  const cases = [
    ['Café', 'cafe'],
    ['Björk', 'bjork'],
    ["Monster's", 'monsters'],
    ['Song (Remix) [Live]', 'song'],
    ['Artist feat. Other', 'artist'],
    ['ɢɪᴀɴɴᴏᴛᴛɪ ᴍᴜꜱɪᴄ', 'giannotti music'],
    ['ガラ', 'ガラ'.normalize('NFKD')],
    [null, ''],
    [undefined, ''],
  ];
  for (const [i, o] of cases) assert.strictEqual(foldName(i), o);
  assert.notStrictEqual(foldName('ガラ'), foldName('カラ'));
});

test('plainName: only decoration is rewritten', () => {
  assert.strictEqual(plainName('Björk'), 'Björk');
  assert.strictEqual(plainName('Hǫsvaldr'), 'Hǫsvaldr');
  assert.strictEqual(plainName('Kılıç'), 'Kılıç');
  assert.strictEqual(plainName('ɢɪᴀɴɴᴏᴛᴛɪ ᴍᴜꜱɪᴄ'), 'Giannotti Music');
  assert.strictEqual(plainName(''), '');
  assert.strictEqual(plainName(null), '');
});

test('editDistance / titleClose thresholds', () => {
  assert.strictEqual(editDistance('kitten', 'sitting', 5), 3);
  assert.strictEqual(editDistance('abcdef', 'uvwxyz', 2), 3);
  assert.strictEqual(titleClose('eyes dem open', 'eyes them open'), true);
  assert.strictEqual(titleClose('nwo', 'nwa'), false);
  assert.strictEqual(titleClose('zero control', 'control'), false);
  assert.strictEqual(titleClose('same', 'same'), true);
  assert.strictEqual(titleClose('', ''), false);
});
