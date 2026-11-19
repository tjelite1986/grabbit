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
  // The post viewer's creator and post links keep the lane like the post card's (2 of them),
  // and so do caption @mention links (1).
  assert.ok(asks >= 3 && asks <= 15, `lane: 'review' appears ${asks} times`);
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
  for (const route of ["r('GET', 'api/notifications')", "r('POST', 'api/notifications/read', { body: ['ids'], ids: true })", "r('PATCH', 'api/me', { body: ['display_name', 'bio'] })", "r('POST', 'api/me/password', { body: ['current', 'password'] })", "r('POST', 'api/posts', { upload: true })"]) {
    assert.ok(gw.includes(route), route);
  }
  assert.match(js, /call\('notifications'\)/);
  // Marks only the notifications it showed.
  assert.match(js, /call\('notifications\/read', \{ method: 'POST', body: \{ ids: unread \} \}\)/);
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
  assert.match(js, /const layer = \(\) => viewerEl \|\| postsEl \|\| document\.body;/);
  assert.match(js, /layer\(\)\.append\(sheetEl\)/);
  // A sheet open in the viewer gets Escape first.
  assert.match(js, /if \(sheetEl \|\| !viewerEl\) return;/);
  assert.match(css, /\.sg-vstage \{[^}]*touch-action: none/);
  // Leaving the page ends fullscreen and closes the viewer.
  assert.match(js, /if \(fsEl\(\) === viewerEl\) exitFs\(\);/);
});

test('the pager says "Loading ..." only while a page is on its way', () => {
  const start = js.indexOf('function pager(');
  const body = js.slice(start, js.indexOf('// --- Tiles', start));
  // The sentinel starts empty; a page on its way puts the text in and marks it busy.
  assert.match(body, /const more = h\('div', \{ class: 'sg-more' \}\);/);
  assert.match(body, /more\.setAttribute\('aria-busy', 'true'\);\s*fill\(more, h\('span', \{ class: 'muted' \}, 'Loading \.\.\.'\)\);/);
  // After a page the sentinel is emptied again (or shows the empty text), and the busy mark goes.
  assert.match(body, /fill\(more, src\.done && !count \? h\('p', \{ class: 'muted' \}, emptyText\) : null\);/);
  assert.match(body, /finally \{\s*more\.removeAttribute\('aria-busy'\);/);
  // One page at a time: a second call while one is running gets the same promise.
  assert.match(body, /if \(running\) return running;/);
});

test('the pager keeps loading on scroll and shares its list with the post viewer', () => {
  const start = js.indexOf('function pager(');
  const body = js.slice(start, js.indexOf('// --- Tiles', start));
  assert.match(body, /const src = \{ items: \[\], els: \[\], done: false, failed: false, more: \(\) => next\(\), listeners: new Set\(\) \};/);
  assert.match(body, /const el = draw\(it, \{ src, index \}\);/);
  assert.match(body, /for \(const fn of src\.listeners\) fn\(\);/);
  // A scroll check besides the observer, removed when the page is left.
  assert.match(body, /window\.addEventListener\('scroll', onScroll, \{ passive: true \}\);/);
  assert.match(body, /window\.removeEventListener\('scroll', onScroll\)/);
});

test('grid tiles open the full-screen post viewer; a modifier click still opens the post page', () => {
  const start = js.indexOf('function tile(');
  const body = js.slice(start, js.indexOf('const tileGrid', start));
  assert.match(body, /if \(e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;/);
  assert.match(body, /openPosts\(ctx\.src, ctx\.src\.els\.indexOf\(e\.currentTarget\), lane\)/);
  assert.match(body, /href: link\(`post\/\$\{id\}`/);
  // Every pager grid passes its context; Explore is one of them.
  assert.match(js, /pager\(grid, \(cur\) => call\(`explore\?\$\{qs\(cur\)\}`\), \(t, c\) => tile\(t, null, null, c\)/);
  assert.equal((js.match(/\(t, c\) => tile\(/g) || []).length, 8);
});

test('carousel: a horizontal scroll-snap track, one item at a time, only the item on show plays', () => {
  assert.match(css, /\.sg-track \{[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory/);
  assert.match(css, /\.sg-slide \{[^}]*flex: 0 0 100%;[^}]*grid-template: minmax\(0, 1fr\) \/ minmax\(0, 1fr\);[^}]*scroll-snap-align: center;[^}]*scroll-snap-stop: always/);
  const start = js.indexOf('function carousel(');
  const body = js.slice(start, js.indexOf('// --- One post', start));
  assert.match(body, /Math\.round\(track\.scrollLeft \/ w\)/);
  assert.match(body, /if \(v\.closest\('\.sg-slide'\) !== track\.children\[at\]\) v\.pause\(\);/);
  assert.match(body, /track\.scrollTo\(\{ left: to \* track\.clientWidth/);
  // The post card uses it; the old one-item stage with its own swipe is gone.
  assert.match(js, /const car = media\.length \? carousel\(media, lane, \{/);
  assert.doesNotMatch(js, /stage\.addEventListener\('touchstart'/);
});

test('feed: one post per scroll step, and a post fits one screen', () => {
  assert.match(js, /root\.classList\.add\('sg-snap'\);/);
  assert.match(js, /onLeave\(\(\) => \{ root\.classList\.remove\('sg-snap'\);/);
  assert.match(css, /html\.sg-snap \{ scroll-snap-type: y mandatory; scroll-padding-top: var\(--sg-snap-top, 0px\); \}/);
  assert.match(css, /html\.sg-snap \.sg-feed > \.sg-post \{ scroll-snap-align: start; scroll-snap-stop: always; \}/);
  assert.match(css, /html\.sg-snap \.sg-feed \.sg-carousel \{ max-height: calc\(100vh - var\(--sg-snap-top, 0px\) - 210px\);/);
  // An image in the feed opens the post viewer on that post.
  assert.match(js, /postCard\(p, \{ onOpen: \(\) => openPosts\(c\.src, c\.src\.items\.indexOf\(p\)\) \}\)/);
});

test('post viewer: vertical snap between posts, more loaded near the end, Back closes it', () => {
  const start = js.indexOf('function openPosts(');
  const body = js.slice(start, js.indexOf('// --- Pages', start));
  assert.match(css, /\.sg-reels-scroll \{[^}]*overflow-y: auto;[^}]*scroll-snap-type: y mandatory;[^}]*overscroll-behavior: contain/);
  assert.match(css, /\.sg-reel \{[^}]*height: 100%;[^}]*scroll-snap-align: start;[^}]*scroll-snap-stop: always/);
  // Only a window of posts is drawn; the rest are empty frames.
  assert.match(body, /Math\.abs\(r\.index - active\) <= WINDOW \? draw\(r\) : undraw\(r\)/);
  assert.match(body, /if \(!src\.done && active >= src\.items\.length - 4\) src\.more\(\);/);
  assert.match(body, /src\.listeners\.add\(addReels\);/);
  // Every button of a post, on the post.
  for (const label of ['Like', 'Comments', 'Share', 'Favorite', 'Save to a collection', 'Download this file', 'Zoom', 'Open the post']) {
    assert.ok(body.includes(`'aria-label': '${label}'`), label);
  }
  // Back closes the viewer; Close steps back past its history entry; links replace it.
  assert.match(body, /history\.pushState\(\{ \.\.\.\(history\.state \|\| \{\}\), sgPosts: true \}, ''\);/);
  assert.match(body, /window\.addEventListener\('popstate', onPop\);/);
  assert.match(body, /history\.back\(\);/);
  assert.match(body, /location\.replace\(to\);/);
  // Keys: up/down between posts, left/right inside one, L likes, Escape closes; not while a sheet or the photo viewer is open.
  assert.match(body, /if \(viewerEl \|\| sheetEl \|\| !postsEl\) return;/);
  assert.match(body, /k === 'ArrowDown' \|\| k === 'j' \|\| k === 'PageDown'/);
  // The double tap likes, never unlikes.
  assert.match(body, /onDoubleTap: \(\) => like\(true\)/);
  // Leaving the page closes it; the photo viewer opened from it is drawn inside it.
  assert.match(js, /closeViewer\(\);\s*closePosts\('replace'\);\s*\}/);
  assert.match(js, /\(postsEl \|\| document\.body\)\.append\(viewerEl\);/);
  assert.match(js, /data-media-bg': '1', class: 'sg-reel-wait'|class: 'sg-reel-wait', alt: '', src: thumbUrl\(mid, lane, 1080\), 'data-media-bg': '1'/);
});

test('Review: "Choose all shown" and "Choose whole lane", and big choices go out in parts of 200', () => {
  assert.match(js, /'aria-label': 'Choose all creators shown'/);
  assert.match(js, /h\('label', \{ class: 'sg-review-all small' \}, all, 'Choose all shown'\)/);
  assert.match(js, /all\.indeterminate = on > 0 && on < ps\.length;/);
  // "Choose whole lane" lists every Review creator without samples and chooses them, loaded or not.
  assert.match(js, /'Choose whole lane'/);
  assert.match(js, /call\(`creators\$\{cur \? `\?offset=\$\{enc\(cur\)\}` : ''\}`, \{ lane: 'review' \}\)/);
  assert.match(js, /pick\.checked = selected\.has\(c\.handle\);/);
  // A large choice shows its progress on the button.
  assert.match(js, /btn\.textContent = `Sending \$\{Math\.min\(i \+ 200, handles\.length\)\} of \$\{handles\.length\} \.\.\.`;/);
  // The server takes at most 200 handles per request.
  assert.match(js, /for \(let i = 0; i < handles\.length; i \+= 200\)/);
  assert.match(js, /handles: handles\.slice\(i, i \+ 200\)/);
  // More than one creator marked general asks first, like 18+ always does.
  assert.match(js, /aud === 'general' && handles\.length > 1 && !confirm\(/);
  assert.match(css, /\.sg-review-all \{/);
});

test('3.0.3: the feed is as wide as the screen allows, like Elitogram', () => {
  // No fixed 560px column, and the 1100px page cap is lifted on the feed.
  assert.doesNotMatch(css, /\.sg-feed \{[^}]*max-width: 560px;/);
  assert.match(css, /\.sg-root:has\(\.sg-feed\) \{ max-width: none; \}/);
  // The only cap is a 1.91:1 image at the tallest media height.
  assert.match(css, /max-width: max\(560px, calc\(\(100dvh - var\(--sg-snap-top, 0px\) - 210px\) \* 1\.91\)\);/);
  // Media are never cropped: contain, and tall images keep down to 9:16.
  assert.match(css, /\.sg-slide img, \.sg-slide video \{[^}]*object-fit: contain;/);
  assert.match(js, /Math\.max\(0\.5625, Math\.min\(1\.91, ratio\)\)/);
});

test('3.0.3: @mentions link only to the creators the post names, and a creator has Published / Mentioned in', () => {
  // The caption links an @name only through the post's own `mentions`.
  assert.match(js, /function captionNodes\(text, mentions, lane = null\)/);
  assert.match(js, /const handle = byName\.get\(name\.toLowerCase\(\)\);\s*if \(!handle\) continue;/);
  assert.match(js, /h\('a', \{ class: 'sg-mention', href: link\(`creator\/\$\{enc\(handle\)\}`, lane === 'review' \? \{ lane: 'review' \} : null\) \}, `@\$\{name\}`\)/);
  // Every post caption passes them: the card, a saved edit and the full-screen viewer.
  assert.match(js, /captionNodes\(single \? p\.caption : String\(p\.caption \|\| ''\)\.slice\(0, 400\), p\.mentions, lane\)\)/);
  assert.match(js, /fill\(captionEl, captionNodes\(p\.caption, p\.mentions, lane\)\)/);
  assert.match(js, /captionNodes\(caption, p\.mentions, lane\)/);
  // Comments carry no mentions and stay plain.
  assert.match(js, /captionNodes\(c\.body\)/);
  // The creator page: two tabs, the list from posts or mentioned. The mention
  // count is Elitogram's (it may include posts Grabbit hides), so it is no label.
  assert.match(js, /\['posts', `Published · \$\{num\(posts\)\}`\], \['mentioned', 'Mentioned in'\]/);
  assert.doesNotMatch(js, /plural\(mentioned,/);
  // A saved edit without a mentions list links no @names.
  assert.match(js, /p\.mentions = d && Array\.isArray\(d\.mentions\) \? d\.mentions : \[\];/);
  assert.match(js, /call\(`creators\/\$\{enc\(handle\)\}\/\$\{tab\}\$\{cur \?/);
  // A limited profile offers no Follow (Elitogram refuses it).
  assert.match(js, /const follow = c\.limited \? null :/);
});

test('3.0.3: every row of the Creators list has a copy-username button beside its link', () => {
  assert.match(js, /copy: 'M9 9h11v11H9zM5 15H4V4h11v1'/);
  // The button is a sibling of the row's link (a button inside a link would also open the profile).
  assert.match(js, /h\('div', \{ class: 'sg-creator-item' \},\s*h\('a', \{ class: 'sg-creator'/);
  assert.match(js, /copyHandleButton\(c\.handle\)\), \{ emptyText: 'No general creators yet\.' \}/);
  // The bare handle is copied, without @.
  assert.match(js, /await navigator\.clipboard\.writeText\(handle\);/);
  assert.match(css, /\.sg-creator-copy \{/);
});
