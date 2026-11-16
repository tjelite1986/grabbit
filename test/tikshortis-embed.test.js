'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEmbedUrl, framePath } = require('../tikshortis-embed');

test('embed URL: unset or anything but a plain origin is off', () => {
  for (const v of [undefined, null, '', ' ', 'http://tik.example.com', 'https://tik.example.com/app', 'https://u:p@tik.example.com',
    'javascript:alert(1)', 'https://*.example.com', 'https://tik.example.com?x=1', 'ftp://tik.example.com']) {
    assert.equal(parseEmbedUrl(v), null, String(v));
  }
});

test('embed URL: https origins and local test addresses', () => {
  assert.deepEqual(parseEmbedUrl('https://Tik.Example.com/'), { origin: 'https://tik.example.com', url: 'https://tik.example.com/' });
  assert.deepEqual(parseEmbedUrl('https://tik.example.com:8443'), { origin: 'https://tik.example.com:8443', url: 'https://tik.example.com:8443/' });
  assert.deepEqual(parseEmbedUrl('http://127.0.0.1:3091'), { origin: 'http://127.0.0.1:3091', url: 'http://127.0.0.1:3091/' });
});

test('frame path stays inside the embedded app', () => {
  assert.equal(framePath('/explore'), '/explore');
  assert.equal(framePath('/tag/cats?sort=new'), '/tag/cats?sort=new');
  for (const bad of [undefined, '', 'explore', '//evil.example.com/x', 'https://evil.example.com', '/\\evil.example.com', 'javascript:alert(1)', '/a\nb']) {
    assert.equal(framePath(bad), '/', String(bad));
  }
});
