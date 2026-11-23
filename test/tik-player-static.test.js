'use strict';
// Grabbit 3.0.1: static checks on the native TikShortis player (public/hub/tik/)
// and the hub hooks it relies on. The player is a browser module with no DOM
// test harness here, so these guard the decisions that broke or were made on
// purpose, by reading the shipped sources.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');
// Adshortis phase 2: the feed and sheet rules moved to public/hub/shared/
// feed-player.css (loaded before tik.css); the checks read both, shared first.
const css = read('hub/shared/feed-player.css') + read('hub/tik/tik.css');
const js = read('hub/tik/tik.js');
// Adshortis phase 2: the sheet stack moved to public/hub/shared/.
const sheetsJs = read('hub/shared/sheets.js');
const hubJs = read('hub/hub.js');

// Strip comments so a rule mentioned in prose does not count as a rule.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

// The body of the first @media block whose prelude matches.
function mediaBlock(src, prelude) {
  const at = src.indexOf(`@media ${prelude}`);
  assert.ok(at >= 0, `@media ${prelude} exists`);
  let i = src.indexOf('{', at) + 1;
  const start = i;
  for (let depth = 1; depth; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(start, i - 1);
}

// Every selector list (before a "{") together with its declarations.
function rules(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] });
  return out;
}

test('no rules for the old 9:16 player box', () => {
  assert.doesNotMatch(cssCode, /\.tf-player\b/, 'the feed is full-bleed; the 9:16 box is gone');
  assert.doesNotMatch(js, /['"`\s]tf-player\b/);
});

test('feed CSS: .tf-side is absolute and no pointer:coarse rule resets it', () => {
  // A touch rule once set every .tf-cbtn to position: relative, which put
  // .tf-side in the flow under the feed; a tap scrolled the feed 47 px up.
  const base = rules(cssCode).find((r) => r.selectors.includes('.tf-side'));
  assert.ok(base, '.tf-side has its own rule');
  assert.match(base.body, /position:\s*absolute/);
  for (const r of rules(mediaBlock(cssCode, '(pointer: coarse)'))) {
    if (!/position:\s*(relative|static)/.test(r.body)) continue;
    for (const s of r.selectors) {
      assert.notEqual(s, '.tf-cbtn', 'a bare .tf-cbtn here also matches .tf-side');
      assert.doesNotMatch(s, /\.tf-side(?![\w-])(?!::)/, `${s} must not reset .tf-side`);
    }
  }
});

test('feed CSS: the .tf-video rule uses object-fit: contain', () => {
  const video = rules(cssCode).find((r) => r.selectors.includes('.tf-video'));
  assert.ok(video, '.tf-video has a rule');
  assert.match(video.body, /object-fit:\s*contain/);
});

test('tabBar() source: TikShortis tabs in order, plus a Menu tab', () => {
  const at = js.indexOf('function tabBar(');
  assert.ok(at >= 0);
  const body = js.slice(at, js.indexOf('function openMenuSheet(', at));
  const labels = [...body.matchAll(/^\s*\['[\w-]*',\s*'([^']+)',/gm)].map((m) => m[1]);
  assert.deepEqual(labels, ['Videos', 'Explore', 'Profiles', 'Playlists']);
  assert.match(body, /'Menu'/);
});

test('railBtn() calls for Like and Comments pass a fixed aria name', () => {
  for (const [icon, aria] of [['heart', 'Like'], ['messageCircle', 'Comments']]) {
    const re = new RegExp(`railBtn\\('${icon}',[^\\n]*\\{ aria: '${aria}' \\}\\)`);
    assert.match(js, re, `${aria} button passes an aria name`);
  }
});

test('hub.js passes the menu hooks to the module and tik.js calls them', () => {
  const at = hubJs.indexOf('tikDef.create({');
  assert.ok(at >= 0, 'hub.js creates the TikShortis module');
  const call = hubJs.slice(at, hubJs.indexOf('});', at));
  for (const hook of ['openMenu', 'closeMenu', 'toggleSide', 'sideOpen', 'replaceHash', 'rerender', 'route']) {
    assert.match(call, new RegExp(`\\b${hook}\\b`), `create() gets ${hook}`);
  }
  for (const hook of ['toggleSide', 'sideOpen', 'closeMenu']) {
    assert.match(js, new RegExp(`hub\\.${hook}\\(`), `tik.js uses hub.${hook}`);
  }
});

test('version labels and the service worker cache name moved to 3.0.4', () => {
  assert.match(read('hub/index.html'), /<span id="version">v3\.0\.4<\/span>/);
  // 3.0.4 added the duplicate manager's files to the shell, and Adshortis
  // phase 2 the shared helpers, so the cache moved on.
  assert.match(read('sw.js'), /const CACHE = 'grabbit-v17';/);
});

test('3.0.2: sheets ride on top of the on-screen keyboard (visualViewport)', () => {
  assert.match(sheetsJs, /window\.innerHeight - vvp\.height - vvp\.offsetTop/);
  assert.match(sheetsJs, /vvp\.addEventListener\('resize', syncKeyboard\)/);
  assert.match(sheetsJs, /vvp\.addEventListener\('scroll', syncKeyboard\)/);
  assert.match(cssCode, /\.tik-sheet \{[^}]*bottom: var\(--tik-kb, 0px\)/);
  assert.match(cssCode, /\.tik-sheet\.tf-sheet-comments[^{]*\{[^}]*max-height: min\(70dvh, calc\(var\(--tik-vvh, 100dvh\) - 16px\)\)/);
});

test('3.0.2: For You and Random continue the saved shuffle instead of reshuffling', () => {
  assert.match(js, /function savedShuffle\(sort, length, focus\)/);
  assert.match(js, /const restore = mainFeed && SEEDED\.has\(sort\) \? savedShuffle\(sort, length, focus\) : null;/);
  // Only a focus that is not the saved clip falls back to New.
  assert.match(js, /if \(focus && SEEDED\.has\(sort\) && !restore\) sort = 'new';/);
  assert.match(js, /let seed = restore \? restore\.seed :/);
  assert.match(js, /cursor: restore \? restore\.cursor :/);
  // The saved place carries the seed and the page offset of the clip.
  assert.match(js, /Object\.assign\(saved, \{ sort, length, seed, cursor: c\.pageAt \}\)/);
  // A reshuffle resets in place even though the order did not change.
  assert.match(js, /if \(!reshuffle && nextSort === sort && nextLength === length\) return;/);
});

test('confirmSheet() puts the focus on Cancel, not on the destructive button', () => {
  const at = sheetsJs.indexOf('function confirmSheet(');
  assert.ok(at >= 0);
  const body = sheetsJs.slice(at, sheetsJs.indexOf('\n    }\n', at));
  assert.match(body, /querySelector\('\.tf-sheet-btns \.tf-sbtn:not\(\.danger\)'\)/);
  assert.match(body, /cancel\.focus\(/);
});
