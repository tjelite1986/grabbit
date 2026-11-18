'use strict';
// Publishing an image into a posts drop folder (posts-publish.js): exact stem
// matching, stem-keyed sidecars in Elitogram mode, source identity, staged
// files and serialized publication. Every test works in its own temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pp = require('../posts-publish');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-posts-'));
}
function stage(dir, bytes = 'IMG') {
  const p = path.join(dir, `.staged-${Math.random().toString(16).slice(2)}.part`);
  fs.writeFileSync(p, bytes);
  return p;
}
const lock = pp.createNameLock();
const list = (dir) => fs.readdirSync(dir).sort();
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('exact stem match: dots in titles, sidecars, dotfiles, folders and non-images do not count', () => {
  const dir = tmpDir();
  try {
    for (const f of ['shot.2.jpg', 'shot.json', '.shot.jpg.part-1', 'shot.txt', 'shotgun.jpg', 'other_shot.jpg']) fs.writeFileSync(path.join(dir, f), 'x');
    fs.mkdirSync(path.join(dir, 'shot.png'));
    assert.equal(pp.stemImage(dir, 'shot'), null);
    assert.equal(pp.stemImage(dir, 'shot.2'), 'shot.2.jpg');
    fs.writeFileSync(path.join(dir, 'shot.WEBP'), 'x');
    assert.equal(pp.stemImage(dir, 'shot'), 'shot.WEBP');
    assert.equal(pp.stemImage(path.join(dir, 'missing'), 'shot'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink under the stem is not an image', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'target.bin'), 'x');
    fs.symlinkSync(path.join(dir, 'target.bin'), path.join(dir, 'shot.jpg'));
    assert.equal(pp.stemImage(dir, 'shot'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('source id: media id first, else the address without its query', () => {
  const a = pp.sourceId({ site: 'instagram', mediaId: '123', url: 'https://cdn.example.com/a.jpg?sig=1' });
  assert.equal(a, pp.sourceId({ site: 'instagram', mediaId: '123', url: 'https://cdn.example.com/b.jpg' }));
  assert.notEqual(a, pp.sourceId({ site: 'instagram', mediaId: '124' }));
  assert.notEqual(a, pp.sourceId({ site: 'reddit', mediaId: '123' }));
  const u1 = pp.sourceId({ site: 'web', url: 'https://cdn.example.com/x.jpg?token=a' });
  assert.equal(u1, pp.sourceId({ site: 'web', url: 'https://cdn.example.com/x.jpg?token=b' }));
  assert.notEqual(u1, pp.sourceId({ site: 'web', url: 'https://cdn.example.com/y.jpg' }));
  assert.match(u1, /^[0-9a-f]{16}$/);
});

test('Elitogram mode: publishes the image with a stem-keyed sidecar naming its source', async () => {
  const dir = tmpDir();
  try {
    const part = stage(dir, 'ONE');
    const name = await pp.publish({ dir, stem: 'ann_-_beach 42', ext: 'jpg', partPath: part, egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => ({ caption: 'c', audience: 'unknown' }), lock });
    assert.equal(name, 'ann_-_beach 42.jpg');
    assert.deepEqual(list(dir), ['ann_-_beach 42.jpg', 'ann_-_beach 42.json']);
    assert.deepEqual(readJson(path.join(dir, 'ann_-_beach 42.json')), { caption: 'c', audience: 'unknown', source_id: 'aaaaaaaaaaaaaaaa' });
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'ONE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same source saved again (other extension) reuses the published image and keeps its sidecar', async () => {
  const dir = tmpDir();
  try {
    await pp.publish({ dir, stem: 's', ext: 'jpg', partPath: stage(dir), egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => ({ caption: 'first' }), lock });
    let asked = false;
    const part = stage(dir, 'WEBP');
    const name = await pp.publish({ dir, stem: 's', ext: 'webp', partPath: part, egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => { asked = true; return { caption: 'second' }; }, lock });
    assert.equal(name, 's.jpg');
    assert.equal(asked, false, 'a reused image does not write a sidecar');
    assert.equal(readJson(path.join(dir, 's.json')).caption, 'first');
    assert.ok(fs.existsSync(part), 'the staged file is left for the caller to remove');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('another source under the same stem gets its own name, never the other image', async () => {
  const dir = tmpDir();
  try {
    await pp.publish({ dir, stem: 's', ext: 'jpg', partPath: stage(dir, 'JPEG'), egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => ({ caption: 'a' }), lock });
    const name = await pp.publish({ dir, stem: 's', ext: 'webp', partPath: stage(dir, 'WEBP'), egram: true, id: 'bbbbbbbbbbbbbbbb', sidecar: () => ({ caption: 'b' }), lock });
    assert.equal(name, 's_bbbbbbbbbb.webp');
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'WEBP');
    assert.equal(readJson(path.join(dir, 's_bbbbbbbbbb.json')).source_id, 'bbbbbbbbbbbbbbbb');
    assert.equal(readJson(path.join(dir, 's.json')).caption, 'a');
    // That source saved again finds its own image.
    const again = await pp.publish({ dir, stem: 's', ext: 'jpg', partPath: stage(dir), egram: true, id: 'bbbbbbbbbbbbbbbb', sidecar: () => ({}), lock });
    assert.equal(again, 's_bbbbbbbbbb.webp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an image published before source ids (no source_id) is not taken for this source', async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 's.jpg'), 'OLD');
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ caption: 'old' }));
    const name = await pp.publish({ dir, stem: 's', ext: 'jpg', partPath: stage(dir, 'NEW'), egram: true, id: 'cccccccccccccccc', sidecar: () => ({ caption: 'new' }), lock });
    assert.equal(name, 's_cccccccccc.jpg');
    assert.equal(fs.readFileSync(path.join(dir, 's.jpg'), 'utf8'), 'OLD');
    assert.equal(readJson(path.join(dir, 's.json')).caption, 'old');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused re-check inside the lock publishes nothing', async () => {
  const dir = tmpDir();
  try {
    const part = stage(dir);
    await assert.rejects(pp.publish({ dir, stem: 's', ext: 'jpg', partPath: part, egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => { throw new Error('creator is 18+ now'); }, lock }), /18\+ now/);
    assert.deepEqual(list(dir), [path.basename(part)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed rename removes the sidecar this attempt wrote', async () => {
  const dir = tmpDir();
  try {
    const missing = path.join(dir, '.gone.part');
    await assert.rejects(pp.publish({ dir, stem: 's', ext: 'jpg', partPath: missing, egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => ({}), lock }));
    assert.deepEqual(list(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent saves of one source publish one image and one sidecar', async () => {
  const dir = tmpDir();
  try {
    const runs = ['jpg', 'webp', 'png', 'jpg'].map((ext) => pp.publish({ dir, stem: 's', ext, partPath: stage(dir), egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => ({ ext }), lock }));
    const names = await Promise.all(runs);
    assert.deepEqual([...new Set(names)], ['s.jpg']);
    assert.deepEqual(list(dir).filter((f) => !f.startsWith('.')), ['s.jpg', 's.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy mode (flag off): per-file sidecar <name>.json and exact-name reuse only', async () => {
  const dir = tmpDir();
  try {
    const a = await pp.publish({ dir, stem: 's', ext: 'jpg', partPath: stage(dir), egram: false, id: null, sidecar: () => ({ description: 'd' }), lock });
    assert.equal(a, 's.jpg');
    assert.deepEqual(list(dir), ['s.jpg', 's.jpg.json']);
    assert.equal(readJson(path.join(dir, 's.jpg.json')).source_id, undefined);
    const b = await pp.publish({ dir, stem: 's', ext: 'webp', partPath: stage(dir), egram: false, id: null, sidecar: () => ({ description: 'w' }), lock });
    assert.equal(b, 's.webp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Elitogram mode refuses what its importer cannot take (an .m3u8 playlist labelled an image)', async () => {
  for (const ok of ['jpg', 'JPEG', 'png', 'gif', 'webp', 'avif']) assert.equal(pp.egramExtRefusal(ok), null, ok);
  for (const bad of ['m3u8', 'mp4', 'heic', 'bmp', 'tiff', '', null]) assert.match(pp.egramExtRefusal(bad), /not a picture Elitogram can import/, String(bad));
  const dir = tmpDir();
  try {
    const part = stage(dir, '#EXTM3U');
    let asked = false;
    await assert.rejects(
      pp.publish({ dir, stem: 'kit_-_dogs 1x', ext: 'm3u8', partPath: part, egram: true, id: 'aaaaaaaaaaaaaaaa', sidecar: () => { asked = true; return {}; }, lock }),
      /not a picture Elitogram can import \(\.m3u8\)/,
    );
    assert.equal(asked, false, 'no sidecar is built for a refused item');
    assert.deepEqual(list(dir), [path.basename(part)], 'nothing is published next to the staged file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy mode (flag off) keeps publishing any extension, as in 3.0.2', async () => {
  const dir = tmpDir();
  try {
    const name = await pp.publish({ dir, stem: 's', ext: 'm3u8', partPath: stage(dir), egram: false, id: null, sidecar: () => ({ description: 'd' }), lock });
    assert.equal(name, 's.m3u8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
