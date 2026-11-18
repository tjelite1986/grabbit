'use strict';
// Grabbit 3.0 phase 2: static checks on the Social & Photos module
// (public/hub/social/) and the hub hooks it relies on. Like the TikShortis
// static tests, these read the shipped sources: the module is a browser file
// with no DOM harness here. A real-browser pass is part of the release check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');
const js = read('hub/social/social.js');
const css = read('hub/social/social.css').replace(/\/\*[\s\S]*?\*\//g, '');
const hubJs = read('hub/hub.js');
const hubCss = read('hub/hub.css').replace(/\/\*[\s\S]*?\*\//g, '');

const classesIn = (text) => new Set([...text.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

test('registers itself as the social module and is loaded before hub.js', () => {
  assert.match(js, /registry\.push\(\{ id: 'social', create \}\)/);
  const html = read('hub/index.html');
  const s = html.indexOf('/hub/social/social.js');
  const hubAt = html.indexOf('/hub/hub.js');
  assert.ok(s > 0 && s < hubAt, 'social.js before hub.js');
  assert.match(html, /\/hub\/social\/social\.css/);
});

test('every module class starts with sg- and none is defined by hub.css', () => {
  const own = [...classesIn(css)].filter((c) => !['btn', 'muted', 'on', 'prev', 'next', 'close', 'small', 'ghost', 'danger', 'chip', 'single'].includes(c));
  for (const c of own) assert.ok(c.startsWith('sg-'), `.${c} in social.css`);
  const hub = classesIn(hubCss);
  for (const c of own) assert.ok(!hub.has(c), `.${c} is also a hub.css class`);
});

test('talks to Grabbit only: every request goes to /api/egram', () => {
  for (const m of js.matchAll(/fetch\(\s*([`'])([^`']*)/g)) assert.match(m[2], /^\/api\/egram\//, m[0]);
  assert.match(js, /const url = `\/api\/egram\/api\/\$\{path\}/);
  assert.doesNotMatch(js, /eg_session|eg_adult|adult\/unlock/);
});

test('media addresses come from numeric ids, never from upstream strings', () => {
  assert.match(js, /const mediaUrl = \(id, lane, extra\) => `\/api\/egram\/m\/\$\{Number\(id\)\}/);
  assert.match(js, /const thumbUrl = \(id, lane, w\) => `\/api\/egram\/m\/\$\{Number\(id\)\}\/t/);
  // Avatars: only /m/ca/<n> or /m/ua/<n> from Elitogram is rebuilt; anything else is dropped.
  assert.match(js, /\/\^\\\/m\\\/\(ca\|ua\)\\\/\(\\d\{1,12\}\)\$\//);
  // No src or href is taken straight from an Elitogram field.
  assert.doesNotMatch(js, /src: (p|t|c|it|m)\.(url|thumb|avatar)\b/);
  assert.doesNotMatch(js, /href: (p|t|c|it)\.source_url/);
  assert.match(js, /x\.protocol === 'https:'/);
});

test('the Review lane is labelled, opt-in per request, and the only unclassified view', () => {
  assert.match(js, /Review lane: unclassified\. /);
  assert.match(js, /lane === 'review' \? `\$\{sep\}lane=review`/);
  // Only the review pages and links they build ask for the review lane.
  const asks = [...js.matchAll(/lane: 'review'/g)].length;
  assert.ok(asks >= 3 && asks <= 12, `lane: 'review' appears ${asks} times`);
  assert.doesNotMatch(js, /lane=adult|audience: 'unknown'/);
});

test('thumbnails and media carry data-media-bg for the privacy blur', () => {
  const imgs = [...js.matchAll(/h\('(img|video)', \{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 6);
  for (const i of imgs) assert.match(i, /'data-media-bg': '1'/, i);
});

test('hub hooks: page, leave on render, search, sign-out, settle', () => {
  assert.match(hubJs, /\{ id: 'social', label: 'Social & Photos', icon: 'social', ownData: true, show: \(\) => socialOn\(\)/);
  assert.match(hubJs, /if \(socialNative\) socialNative\.leave\(\);/);
  assert.match(hubJs, /socialNative\.searchHash\(q\)/);
  assert.match(hubJs, /fetch\('\/api\/egram\/session', \{ method: 'DELETE'/);
  assert.match(hubJs, /route\(\)\.id === 'social' && !document\.querySelector\('\.sg-root'\)/);
  assert.match(hubJs, /m\.enabled && m\.mode === 'native'/);
});

test('the service worker caches the module and never touches /api/', () => {
  const sw = read('sw.js');
  assert.match(sw, /'\/hub\/social\/social\.js'/);
  assert.match(sw, /'\/hub\/social\/social\.css'/);
  assert.match(sw, /if \(url\.pathname\.startsWith\('\/api\/'\) \|\| url\.pathname === '\/login'\) return;/);
});
