'use strict';
// The hub plays the 18+ app's library straight from its folder. The folder
// also holds the app's own files (a cookie jar in _private, temp files), so
// the listing and the file route must only ever reach clips and posters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../adshortis-library');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-ads-lib-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-ads-out-'));
process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function put(rel, body = 'x', mtime) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

put('Alice/Hello_there_h_tag_f_Alice_id_1a2b_.web.mp4', 'v1', 2000000);
put('Alice/Hello_there_h_tag_f_Alice_id_1a2b_.jpg');
put('Bob/Bob_-_Second_clip.web.mp4', 'v2', 3000000);
put('_unsorted/1700000000001.web.mp4', 'v3', 1000000);
put('_unsorted/1700000000001.jpg');
put('_private/cookies.txt', 'secret');
put('_private/leak.web.mp4', 'secret');
put('_tmp/half.web.mp4', 'tmp');
put('.hidden/x.web.mp4', 'hidden');
put('Alice/notes.txt', 'not media');
put('Alice/page.html', '<script>');
fs.writeFileSync(path.join(outside, 'escape.mp4'), 'outside');
fs.symlinkSync(path.join(outside, 'escape.mp4'), path.join(root, 'Alice', 'escape.mp4'));

test('titles drop the app suffixes and the creator prefix', () => {
  assert.equal(lib.titleOf('Hello_there_h_tag_f_Alice_id_1a2b_'), 'Hello there');
  assert.equal(lib.titleOf('It_s_late_h_night_f_Some_one_id_00b79cb6_'), 'It s late');
  assert.equal(lib.titleOf('that_s_a_lot_f_someone_id_4206_'), 'that s a lot');
  assert.equal(lib.titleOf('Bob_-_Second_clip'), 'Second clip');
  assert.equal(lib.titleOf('Plain_caption'), 'Plain caption');
  assert.equal(lib.titleOf('1700000000001'), '1700000000001');
});

test('the listing holds clips only, newest first, without the app folders', () => {
  const items = lib.scanLibrary(root);
  assert.deepEqual(items.map((i) => i.id), [
    'Bob/Bob_-_Second_clip.web.mp4',
    'Alice/Hello_there_h_tag_f_Alice_id_1a2b_.web.mp4',
    '_unsorted/1700000000001.web.mp4',
  ]);
  assert.ok(!items.some((i) => /_private|_tmp|\.hidden|\.txt|\.html/.test(i.id)));
  const alice = items.find((i) => i.id.startsWith('Alice/Hello'));
  assert.equal(alice.creator, 'Alice');
  assert.equal(alice.title, 'Hello there');
  assert.equal(alice.poster, 'Hello_there_h_tag_f_Alice_id_1a2b_.jpg');
  assert.equal(items.find((i) => i.folder === '_unsorted').creator, null);
});

test('resolve serves a listed clip and its poster', () => {
  const v = lib.resolveClip(root, 'Alice/Hello_there_h_tag_f_Alice_id_1a2b_.web.mp4', 'video');
  assert.equal(v, fs.realpathSync(path.join(root, 'Alice/Hello_there_h_tag_f_Alice_id_1a2b_.web.mp4')));
  const p = lib.resolveClip(root, 'Alice/Hello_there_h_tag_f_Alice_id_1a2b_.web.mp4', 'poster');
  assert.equal(p, fs.realpathSync(path.join(root, 'Alice/Hello_there_h_tag_f_Alice_id_1a2b_.jpg')));
  assert.equal(lib.resolveClip(root, 'Bob/Bob_-_Second_clip.web.mp4', 'poster'), null);
});

test('resolve refuses everything that is not a clip inside the root', () => {
  const refused = [
    '_private/cookies.txt',
    '_private/leak.web.mp4',
    '_tmp/half.web.mp4',
    '.hidden/x.web.mp4',
    'Alice/notes.txt',
    'Alice/page.html',
    'Alice/escape.mp4',
    '../etc/passwd',
    'Alice/../_private/leak.web.mp4',
    'Alice/Hello_there_h_tag_f_Alice_id_1a2b_.jpg',
    'Alice',
    '',
    '/etc/passwd',
  ];
  for (const id of refused) {
    assert.equal(lib.resolveClip(root, id, 'video'), null, id);
    assert.equal(lib.resolveClip(root, id, 'poster'), null, id);
  }
  assert.equal(lib.resolveClip(root, 'Bob/Bob_-_Second_clip.web.mp4', 'original'), null);
  assert.equal(lib.resolveClip(null, 'Bob/Bob_-_Second_clip.web.mp4', 'video'), null);
});

test('the library caches its scan for the ttl', () => {
  let t = 0;
  let scans = 0;
  const l = lib.createLibrary(root, { ttlMs: 1000, now: () => t, scan: () => { scans++; return []; } });
  l.list();
  l.list();
  t = 999;
  l.list();
  assert.equal(scans, 1);
  t = 1001;
  l.list();
  assert.equal(scans, 2);
  l.list({ fresh: true });
  assert.equal(scans, 3);
});
