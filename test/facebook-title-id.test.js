'use strict';
// Facebook pages reuse captions, and the file name is the dedup key: two clips
// both titled "Cmon Barbie" once shared a name, and the second was skipped by
// the importer as a repeat. The title must end in the site's video id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-fb-title-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const infoFile = path.join(dir, 'info.json');
const bin = path.join(dir, 'yt-dlp');
fs.writeFileSync(bin, `#!/bin/sh\ncat "${infoFile}"\n`, { mode: 0o755 });
process.env.YTDLP_BIN = bin;
const generic = require('../extractors/generic');

async function titleOf(info) {
  fs.writeFileSync(infoFile, JSON.stringify(info));
  return (await generic.resolve('https://video.example.com/watch/1')).title;
}

test('two Facebook clips with the same caption get different titles', async () => {
  const a = await titleOf({ id: '2021806755186726', extractor_key: 'Facebook', extractor: 'facebook', title: 'Cmon Barbie', uploader: 'Page' });
  const b = await titleOf({ id: '1052241147806409', extractor_key: 'Facebook', extractor: 'facebook', title: 'Cmon Barbie', uploader: 'Page' });
  assert.equal(a, 'Cmon Barbie 2021806755186726');
  assert.notEqual(a, b);
});

test('a reel with a placeholder title keeps its caption and gets the id once', async () => {
  const t = await titleOf({ id: '99', extractor_key: 'FacebookReel', extractor: 'facebook:reel', title: 'Video', description: 'Silly goose' });
  assert.equal(t, 'Silly goose 99');
  const bare = await titleOf({ id: '77', extractor_key: 'Facebook', extractor: 'facebook', title: '', upload_date: '20250102' });
  assert.ok(bare.endsWith(' 77') && !bare.endsWith('77 77'), bare);
});

test('a long caption is shortened so the id survives the name cap', async () => {
  const t = await titleOf({ id: '1848041713209739', extractor_key: 'Facebook', extractor: 'facebook', title: 'Å'.repeat(200) });
  assert.ok(t.endsWith(' 1848041713209739'));
  assert.ok(Buffer.byteLength(t) <= 100, String(Buffer.byteLength(t)));
});

test('other sites keep their title as it was', async () => {
  assert.equal(await titleOf({ id: 'abc', extractor_key: 'Youtube', extractor: 'youtube', title: 'Song' }), 'Song');
});
