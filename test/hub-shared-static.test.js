'use strict';
// Adshortis phase 2: static checks on the helpers the hub's native modules
// share (public/hub/shared/). The shared code serves TikShortis (general) and
// Adshortis (18+), so it must never know a product's API or storage: data and
// key names reach it only from the module that uses it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');
const SHARED = fs.readdirSync(path.join(PUB, 'hub/shared')).filter((f) => f.endsWith('.js')).map((f) => `hub/shared/${f}`);
// Comments may name a product; the code may not. These files use line
// comments only (a block-comment strip would eat strings such as '*/*').
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '');

test('the shared files exist and are loaded before the modules', () => {
  assert.ok(SHARED.includes('hub/shared/sheets.js'));
  assert.ok(SHARED.includes('hub/shared/links.js'));
  const html = read('hub/index.html');
  const tikAt = html.indexOf('<script src="/hub/tik/tik.js">');
  assert.ok(tikAt > 0);
  for (const f of SHARED) {
    const at = html.indexOf(`<script src="/${f}">`);
    assert.ok(at > 0 && at < tikAt, `${f} loads before tik.js`);
  }
});

test('the shared files are in the service worker shell and revalidated', () => {
  const sw = read('sw.js');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const reval = server.slice(server.indexOf('const REVALIDATE = new Set(['), server.indexOf(']);', server.indexOf('const REVALIDATE')));
  for (const f of SHARED) {
    assert.match(sw, new RegExp(`'/${f.replace(/[./]/g, '\\$&')}'`), `${f} in SHELL`);
    assert.match(reval, new RegExp(`'${path.basename(f).replace('.', '\\.')}'`), `${f} in REVALIDATE`);
  }
});

test('shared code calls no API and names no product storage key', () => {
  for (const f of SHARED) {
    const src = code(read(f));
    assert.doesNotMatch(src, /\/api\//, `${f}: no API path`);
    assert.doesNotMatch(src, /grabbit\.(tik|ads)\.|adshortis:/, `${f}: no product storage key`);
    assert.doesNotMatch(src, /localStorage|sessionStorage/, `${f}: no own storage`);
  }
});

test('tik.js uses the shared sheet stack and safeHref instead of its own copies', () => {
  const js = code(read('hub/tik/tik.js'));
  assert.match(js, /window\.GrabbitShared\.sheets\(/);
  assert.match(js, /const \{ safeHref \} = window\.GrabbitShared;/);
  assert.doesNotMatch(js, /function (openSheet|closeSheet|confirmSheet|safeHref|syncKeyboard)\(/);
  assert.doesNotMatch(js, /history\.pushState/, 'only the shared stack pushes the sheet entry');
});

test('Escape on an open sheet closes only that sheet (stopImmediatePropagation)', () => {
  const src = code(read('hub/shared/sheets.js'));
  assert.match(src, /e\.key === 'Escape' && stack\.length\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\);/);
});
