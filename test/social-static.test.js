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

// --- Phase 2 final completion: comments, share, upload, notifications,
// settings and the full-screen viewer.

test('sheets ride on top of the on-screen keyboard (visualViewport)', () => {
  assert.match(js, /const vvp = window\.visualViewport;/);
  assert.match(js, /root\.setProperty\('--sg-kb', `\$\{kb\}px`\)/);
  assert.match(js, /root\.setProperty\('--sg-vvh', `\$\{Math\.round\(vvp\.height\)\}px`\)/);
  assert.match(js, /vvp\.addEventListener\('resize', syncKeyboard\)/);
  assert.match(css, /\.sg-sheet \{[^}]*bottom: var\(--sg-kb, 0px\)/);
  assert.match(css, /\.sg-sheet-panel \{[^}]*max-height: min\(80vh, calc\(var\(--sg-vvh, 100dvh\) - 16px\)\)/);
  assert.match(css, /\.sg-sheet-panel\.sg-sheet-comments \{[^}]*height: min\(70vh, calc\(var\(--sg-vvh, 100dvh\) - 16px\)\)/);
  // 16 px text, so iOS does not zoom the page when the comment field gets focus.
  assert.match(css, /\.sg-comment-form textarea \{[^}]*font-size: 16px/);
});

test('comments: list, post and delete go through the post (gateway parent check)', () => {
  assert.match(js, /call\(`posts\/\$\{pid\}\/comments`, \{ lane \}\)/);
  assert.match(js, /call\(`posts\/\$\{pid\}\/comments`, \{ method: 'POST', body: \{ body \}, lane \}\)/);
  assert.match(js, /call\(`posts\/\$\{pid\}\/comments\/\$\{cid\}`, \{ method: 'DELETE', lane \}\)/);
  // Delete is offered only where Elitogram says so, and the comment id is an integer.
  assert.match(js, /c\.can_delete \?/);
  assert.match(js, /const cid = intOf\(c\.id\);/);
  assert.doesNotMatch(js, /call\(`comments\//);
});

test('share: system share sheet, clipboard otherwise, the post page in Grabbit as the address', () => {
  assert.match(js, /const postAddress = \(id, lane\) => `\$\{location\.origin\}\/\$\{link\(`post\/\$\{Number\(id\)\}`/);
  assert.match(js, /if \(navigator\.share\)/);
  assert.match(js, /navigator\.clipboard\.writeText\(url\)/);
  // Never a media address: a shared link must pass Grabbit's login and the audience checks.
  assert.doesNotMatch(js, /share\(\{ url: mediaUrl/);
});

test('upload: multipart XHR to the gateway, files in order, classification choices', () => {
  assert.match(js, /xhr\.open\('POST', '\/api\/egram\/api\/posts'\)/);
  assert.match(js, /xhr\.upload\.onprogress = /);
  assert.match(js, /for \(const p of picked\) fd\.append\('files', p\.file, p\.file\.name\)/);
  assert.match(js, /if \(audience\.value\) fd\.append\('audience', audience\.value\)/);
  // Unclassified is the default; general only for an account that may classify.
  assert.match(js, /h\('option', \{ value: '' \}, 'Unclassified: goes to the Review lane'\)/);
  assert.match(js, /canClassify\(\) \? h\('option', \{ value: 'general' \}/);
  // Where it landed is asked per lane through the normal checks.
  assert.match(js, /try \{ await call\(`posts\/\$\{id\}`\); return 'general'; \}/);
  assert.match(js, /try \{ await call\(`posts\/\$\{id\}`, \{ lane: 'review' \}\); return 'review'; \}/);
  // Previews are object URLs and are released.
  assert.match(js, /URL\.createObjectURL\(f\)/);
  assert.match(js, /onLeave\(\(\) => \{ for \(const p of picked\) URL\.revokeObjectURL\(p\.preview\); \}\)/);
});

test('notifications, settings and post editing use only allowlisted gateway routes', () => {
  const gw = fs.readFileSync(path.join(__dirname, '..', 'egram-gateway.js'), 'utf8');
  for (const route of ["r('GET', 'api/notifications')", "r('POST', 'api/notifications/read')", "r('PATCH', 'api/me', { body: ['display_name', 'bio'] })", "r('POST', 'api/me/password', { body: ['current', 'password'] })", "r('POST', 'api/posts', { upload: true })"]) {
    assert.ok(gw.includes(route), route);
  }
  assert.match(js, /call\('notifications'\)/);
  assert.match(js, /call\('notifications\/read', \{ method: 'POST' \}\)/);
  assert.match(js, /call\('me', \{ method: 'PATCH', body: \{ display_name: name\.value\.trim\(\), bio: bio\.value \} \}\)/);
  assert.match(js, /call\('me\/password', \{ method: 'POST', body: \{ current: cur\.value, password: next\.value \} \}\)/);
  assert.match(js, /single && p\.can_edit \? ownerBar\(p, lane, caption\)/);
  assert.match(js, /call\(`posts\/\$\{id\}`, \{ method: 'PATCH', body: \{ caption: text\.value \}, lane \}\)/);
  // The standalone-only list is on the settings page.
  assert.match(js, /'Only in standalone Elitogram'/);
  assert.match(js, /\['upload', 'Upload'\],\n\s+\['notifications', 'Notifications'\],\n\s+\['settings', 'Settings'\],/);
});

test('viewer: fullscreen, pinch/wheel/double-tap zoom, pan, swipe, original file, menus inside', () => {
  assert.match(js, /viewerEl\.requestFullscreen \|\| viewerEl\.webkitRequestFullscreen/);
  assert.match(js, /stage\.addEventListener\('pointerdown'/);
  assert.match(js, /gesture = \{ kind: 'pinch', d0: dist\(a, b\), s0: s/);
  assert.match(js, /stage\.addEventListener\('wheel', [\s\S]{0,200}\{ passive: false \}\)/);
  assert.match(js, /stage\.addEventListener\('dblclick'/);
  assert.match(js, /zoomTo\(s > 1 \? 1 : 2\.5, e\.clientX, e\.clientY\)/);
  // The original file, not a thumbnail, once loaded.
  assert.match(js, /full\.src = mediaUrl\(it\.media_id, lane\);/);
  // Sheets and toasts are drawn inside the viewer, so menus work in fullscreen.
  assert.match(js, /const layer = \(\) => viewerEl \|\| document\.body;/);
  assert.match(js, /layer\(\)\.append\(sheetEl\)/);
  // A sheet open in the viewer gets Escape first.
  assert.match(js, /if \(sheetEl \|\| !viewerEl\) return;/);
  assert.match(css, /\.sg-vstage \{[^}]*touch-action: none/);
  // Leaving the page ends fullscreen and closes the viewer.
  assert.match(js, /if \(fsEl\(\) === viewerEl\) exitFs\(\);/);
});
