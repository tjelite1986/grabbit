'use strict';
// The platform drop folder's sidecar and write order (drop-zone contract v1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pd = require('../platform-drop');

const clip = {
  site: 'TikTok',
  mediaId: '7301234567890',
  sourceUrl: 'https://www.tiktok.com/@someone/video/7301234567890',
  creator: 'someone',
  creatorUrl: 'https://www.tiktok.com/@someone',
  title: 'A title',
  description: '  Hello there #fun  ',
  tags: ['#fun', 'cats', 'cats', ''],
  mediaType: 'video',
};

test('sidecar carries what the importer requires', () => {
  const s = pd.platformSidecar(clip, 'someone_-_A_title.mp4');
  assert.deepEqual(s, {
    version: 1,
    file: 'someone_-_A_title.mp4',
    source: 'tiktok',
    sourceId: '7301234567890',
    sourceUrl: 'https://www.tiktok.com/@someone/video/7301234567890',
    creator: { handle: 'someone', name: null, profileUrl: 'https://www.tiktok.com/@someone' },
    caption: 'Hello there #fun',
    tags: ['fun', 'cats'],
  });
});

test('source is reduced to the importer charset; no site id falls back to a URL hash', () => {
  assert.equal(pd.platformSource('Music.YouTube.com'), 'music.youtube.com');
  assert.equal(pd.platformSource('Face Book!'), 'face-book');
  assert.equal(pd.platformSource(''), 'web');
  const a = pd.platformSourceId({ sourceUrl: 'https://example.com/v/1' });
  assert.match(a, /^url-[0-9a-f]{32}$/);
  assert.equal(a, pd.platformSourceId({ sourceUrl: 'https://example.com/v/1' }));
  assert.notEqual(a, pd.platformSourceId({ sourceUrl: 'https://example.com/v/2' }));
});

test('non-http URLs are dropped, and the title stands in for a missing caption', () => {
  const s = pd.platformSidecar({ ...clip, creatorUrl: 'javascript:alert(1)', sourceUrl: null, description: '' }, 'x.mp4');
  assert.equal(s.creator.profileUrl, null);
  assert.equal(s.sourceUrl, null);
  assert.equal(s.caption, 'A title');
});

test('images and clips without a creator are refused', () => {
  assert.equal(pd.platformRefusal(clip), null);
  assert.match(pd.platformRefusal({ ...clip, mediaType: 'image' }), /videos only/);
  assert.match(pd.platformRefusal({ ...clip, creator: 'unknown' }), /creator/);
  assert.match(pd.platformRefusal({ ...clip, creator: '  ' }), /creator/);
});

test('commit puts the media in place before the sidecar, leaving no temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-platform-'));
  try {
    const build = path.join(dir, '.x.mp4.part');
    fs.writeFileSync(build, 'video');
    const seen = [];
    const watcher = fs.watch(dir, (_e, name) => seen.push(name));
    pd.commitPlatformDrop(dir, build, path.join(dir, 'x.mp4'), 'x.json', '{"version":1}');
    watcher.close();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['x.json', 'x.mp4']);
    assert.equal(fs.readFileSync(path.join(dir, 'x.json'), 'utf8'), '{"version":1}');
    // The sidecar's final name must not show up before the media's.
    const firstJson = seen.indexOf('x.json');
    const firstMp4 = seen.indexOf('x.mp4');
    if (firstJson !== -1 && firstMp4 !== -1) assert.ok(firstMp4 < firstJson, seen.join(','));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed sidecar write takes the media back out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-platform-'));
  try {
    const build = path.join(dir, '.y.mp4.part');
    fs.writeFileSync(build, 'video');
    // A directory under the sidecar's name makes the final rename fail.
    fs.mkdirSync(path.join(dir, 'y.json'));
    fs.writeFileSync(path.join(dir, 'y.json', 'keep'), '');
    assert.throws(() => pd.commitPlatformDrop(dir, build, path.join(dir, 'y.mp4'), 'y.json', '{}'));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['y.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
