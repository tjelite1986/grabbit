'use strict';
// The yt-dlp path hands the item store the site's own tags and categories,
// kept apart from hashtags read out of the caption. A fake yt-dlp prints the
// info dict, so no network is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-fake-ytdlp-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const infoFile = path.join(dir, 'info.json');
const bin = path.join(dir, 'yt-dlp');
fs.writeFileSync(bin, `#!/bin/sh\ncat "${infoFile}"\n`, { mode: 0o755 });
process.env.YTDLP_BIN = bin;
const generic = require('../extractors/generic');
const sourceMeta = require('../source-meta');

async function resolveWith(info) {
  fs.writeFileSync(infoFile, JSON.stringify(info));
  return generic.resolve('https://video.example.com/watch/1');
}

test('site tags and categories ride along; the formats do not', async () => {
  const job = await resolveWith({
    id: 'v1', extractor: 'example', extractor_key: 'Example', title: 'Clip', uploader: 'ann',
    description: 'Lovely day #sun', tags: ['Beach Day', 'travel'], categories: ['Travel & Events'],
    formats: [{ url: 'https://cdn.example.com/expiring' }], http_headers: { Cookie: 'x' },
  });
  assert.deepEqual(job.sourceTags, ['Beach Day', 'travel']);
  assert.deepEqual(job.categories, ['Travel & Events']);
  assert.equal(job.sourceMeta.id, 'v1');
  assert.equal(job.sourceMeta.formats, undefined);
  assert.equal(job.sourceMeta.http_headers, undefined);
  const m = sourceMeta.fromJob(job);
  const of = (o, k = 'tag') => m.tags.filter((t) => t.origin === o && t.kind === k).map((t) => t.label);
  assert.deepEqual(of('site'), ['Beach Day', 'travel']);
  assert.deepEqual(of('site', 'category'), ['Travel & Events']);
  assert.deepEqual(of('caption'), ['sun']);
});

test('a site without a tag list gives caption hashtags only, never site tags', async () => {
  const job = await resolveWith({ id: 'v2', extractor: 'instagram', title: 'Post', uploader: 'bob', description: 'Hi #one #two' });
  // The caption's hashtags still feed the old job.tags (captions in the apps)...
  assert.deepEqual(job.tags, ['one', 'two']);
  // ...but they are not the site's tags.
  assert.deepEqual(job.sourceTags, []);
  const m = sourceMeta.fromJob(job);
  assert.deepEqual(m.tags.filter((t) => t.origin === 'site'), []);
  assert.deepEqual(m.tags.map((t) => t.label), ['one', 'two']);
});

test('no tags and no caption: the item gets no tags at all', async () => {
  const job = await resolveWith({ id: 'v3', extractor: 'example', title: 'Plain', uploader: 'cy' });
  const m = sourceMeta.fromJob(job);
  assert.deepEqual(m.tags, []);
  assert.equal(m.description, null);
});
