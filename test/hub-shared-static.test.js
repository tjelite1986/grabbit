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
const SHARED_CSS = fs.readdirSync(path.join(PUB, 'hub/shared')).filter((f) => f.endsWith('.css')).map((f) => `hub/shared/${f}`);
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
  for (const f of [...SHARED, ...SHARED_CSS]) {
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

// Adshortis phase 2, slice B: the feed player moved to shared/feed-player.js.
const player = () => code(read('hub/shared/feed-player.js'));

test('tik.js runs its feed on the shared player and keeps no copy of the core', () => {
  const js = code(read('hub/tik/tik.js'));
  assert.match(js, /window\.GrabbitShared\.feedPlayer\(\{/);
  assert.doesNotMatch(js, /function (setImmersive|toggleFullscreen|attachGestures|attachTimeline|setActive|onKey)\b/);
  assert.doesNotMatch(js, /const onKey\b/);
  // The unguarded dialog test (tik.js:1625 before) is gone, not copied.
  assert.doesNotMatch(js, /\[role=dialog\]\[aria-modal=true\]/);
});

test('the key guard (m4): sheets of every module and foreign dialogs, never the player root', () => {
  const src = player();
  assert.match(src, /const ROOT_ATTR = 'data-feed-player';/);
  assert.match(src, /const SHEET_MARKERS = '\.tik-sheet, \.sg-sheet-panel, \.dm-overlay';/);
  assert.match(src, /querySelectorAll\('\[role=dialog\]\[aria-modal=true\]'\)/);
  assert.match(src, /!d\.closest\(`\[\$\{ROOT_ATTR\}\]`\)/);
  assert.doesNotMatch(src, /\.viewer\b/, 'hub viewers carry .viewer, so it is not the exclusion');
  // The root carries the marker, and onKey goes through the one guard.
  assert.match(src, /\[ROOT_ATTR\]: ''/);
  assert.match(src, /if \(keyBlocked\(e, SH\.count\(\)\)\) return;/);
  // Escape: an open selector first, then the immersive view, never after a sheet took it.
  assert.match(src, /if \(F\.fullscreen && !e\.defaultPrevented && !SH\.count\(\)/);
});

test('the core owns the immersive view under the class the hub reads', () => {
  const src = player();
  assert.match(src, /function setImmersive\(on\)/);
  assert.match(src, /document\.body\.classList\.toggle\('tik-immersive', on\);/);
  assert.match(src, /if \(on\) opts\.closeMenu\(\);/);
  assert.match(src, /window\.dispatchEvent\(new Event\('grabbit:side'\)\);/);
  assert.match(read('hub/hub.js'), /tik-immersive/, 'hub.js still reads the class');
});

test('leave() tears the player down: every listener the core adds is removed', () => {
  const src = player();
  const adds = [...src.matchAll(/(document|window)\.addEventListener\('([\w:-]+)', (\w+)(, true)?\)/g)].map((m) => m.slice(1, 5).join('|'));
  assert.ok(adds.length >= 8, `found ${adds.length} listeners`);
  for (const a of adds) {
    const [target, type, fn, capture] = a.split('|');
    const removal = `${target}.removeEventListener('${type}', ${fn}${capture || ''})`;
    assert.ok(src.includes(removal), `missing ${removal}`);
  }
  for (const o of ['activeObserver', 'edgeObserver', 'resizeObserver']) assert.match(src, new RegExp(`${o}\\.disconnect\\(\\)`));
  assert.match(src, /SH\.whenClosed\.delete\(onSheetsClosed\)/);
  assert.match(src, /document\.body\.classList\.remove\('tik-feed', 'tik-immersive'\)/);
});

test('history (m6): only a player that pushed its own entry goes back; no a.tile hook', () => {
  const src = player();
  assert.doesNotMatch(src, /a\.tile/);
  assert.match(src, /if \(opts\.ownHistory\) \{\s*history\.pushState\(/);
  assert.match(src, /if \(pushed\) history\.back\(\);/);
});

// Adshortis phase 2, slice C: the feed and sheet CSS moved to shared/feed-player.css.
test('the player and sheet CSS is shared, loaded before tik.css, and gone from tik.css', () => {
  assert.ok(SHARED_CSS.includes('hub/shared/feed-player.css'));
  const html = read('hub/index.html');
  const shared = html.indexOf('<link rel="stylesheet" href="/hub/shared/feed-player.css" />');
  const tik = html.indexOf('<link rel="stylesheet" href="/hub/tik/tik.css" />');
  assert.ok(shared > 0 && shared < tik, 'feed-player.css loads before tik.css');
  const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const tikCss = noComments(read('hub/tik/tik.css'));
  const selectors = [...tikCss.matchAll(/([^{}]+)\{/g)].map((m) => m[1]);
  for (const s of selectors) {
    assert.doesNotMatch(s, /\.(tf(?![\w-])|tf-[\w-]+|tik-sheet[\w-]*|tik-scrim|tik-x)/, `tik.css still styles ${s.trim()}`);
  }
  const sharedCss = noComments(read('hub/shared/feed-player.css'));
  // The variables the shared rules read are defined there too.
  assert.match(sharedCss, /--like:/);
  assert.match(sharedCss, /--tik-left:/);
  assert.doesNotMatch(sharedCss, /url\(/, 'no product asset paths');
});
