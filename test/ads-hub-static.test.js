'use strict';
// Grabbit 3.0 native Adshortis, phase 3 slice B: static checks of the hub
// shell (requirements 1.3: NAV-18, HASH, LEAVE, REDRAW, BANNER, RENAME, SHELL;
// 1.6 STORE). The behaviour rows (H36, H53, H59, H78) are browser checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const hubJs = read('public/hub/hub.js');
const hubCss = read('public/hub/hub.css');
const adsJs = read('public/hub/ads/ads.js');
const adsCss = read('public/hub/ads/ads.css');
// Class names a stylesheet defines: the first class of every selector. A
// selector may start with a body state class the shared player sets
// (tik-feed, tik-immersive); the class after it is the one defined.
const STATE = new Set(['tik-feed', 'tik-immersive']);
const classesOf = (css) => {
  const out = new Set();
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/(^|[},])\s*([^{}@]+)\{/g)) {
    for (const sel of m[2].split(',')) {
      const c = [...sel.trim().matchAll(/\.([a-zA-Z][\w-]*)/g)].map((x) => x[1]).find((x) => !STATE.has(x));
      if (c) out.add(c);
    }
  }
  return out;
};

test('SHELL: ads.js and ads.css load after the shared files and before hub.js', () => {
  const html = read('public/hub/index.html');
  const at = (s) => html.indexOf(s);
  assert.ok(at('<script src="/hub/ads/ads.js">') > at('<script src="/hub/shared/feed-player.js">'));
  assert.ok(at('<script src="/hub/ads/ads.js">') < at('<script src="/hub/hub.js">'));
  assert.ok(at('<link rel="stylesheet" href="/hub/ads/ads.css" />') > at('<link rel="stylesheet" href="/hub/shared/feed-player.css" />'));
});

test('SHELL: the service worker caches the module and the server revalidates it', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /const CACHE = 'grabbit-v20';/);
  assert.match(sw, /'\/hub\/ads\/ads\.js'/);
  assert.match(sw, /'\/hub\/ads\/ads\.css'/);
  // The worker still leaves the API and the login alone.
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\) \|\| url\.pathname === '\/login'\) return;/);
  const server = read('server.js');
  const reval = server.slice(server.indexOf('const REVALIDATE = new Set(['), server.indexOf(']);', server.indexOf('const REVALIDATE')));
  assert.match(reval, /'ads\.js'/);
  assert.match(reval, /'ads\.css'/);
});

test('RENAME: the folder page uses adsf-, and ads- belongs to the native module only', () => {
  assert.doesNotMatch(hubCss, /\.ads-/, 'hub.css defines no ads- class');
  for (const c of ['adsf-grid', 'adsf-tile', 'adsf-search']) assert.match(hubCss, new RegExp(`\\.${c}\\b`));
  // hub.js names one ads- class: the module root it checks for in the hash branch.
  assert.deepEqual([...new Set(hubJs.match(/(?<![\w-])ads-[a-z-]+/g))], ['ads-root']);
  const own = classesOf(adsCss);
  assert.ok(own.size >= 5);
  for (const c of own) assert.match(c, /^ads-/, `${c} in ads.css`);
  const hubOwn = classesOf(hubCss);
  for (const c of own) assert.ok(!hubOwn.has(c), `${c} is a hub.css name`);
});

test('NAV-18: Adshortis and Adflix form the 18+ group with its heading', () => {
  assert.match(hubJs, /\{ id: 'adshortis', label: 'Adshortis 18\+', icon: 'video', group: '18',/);
  assert.match(hubJs, /\{ id: 'adflix', label: 'Adflix 18\+', icon: 'media', group: '18',/);
  assert.match(hubJs, /h\('div', \{ class: 'nav-group', 'data-group': p\.group, role: 'presentation' \}, `\$\{p\.group\}\+`\)/);
  // The heading hides when nothing in the group is listed.
  assert.match(hubJs, /g\.hidden = !\[\.\.\.document\.querySelectorAll\(`#nav > a\[data-group="\$\{g\.dataset\.group\}"\]`\)\]\.some\(\(a\) => !a\.hidden\);/);
  // The module's sections show under the entry only in native mode.
  assert.match(hubJs, /subnav: \(\) => \(adsIsNative\(\) \? adsNative\.subnav\(route\(\)\) : null\)/);
  // B3: the first install lists only the working sections; Liked is the
  // feed's Liked order. The unbuilt views keep their routes, off the menu.
  const sections = adsJs.slice(adsJs.indexOf('const SECTIONS = ['), adsJs.indexOf('];', adsJs.indexOf('const SECTIONS = [')));
  assert.deepEqual([...sections.matchAll(/\['[a-z]+', '([A-Za-z]+)'/g)].map((m) => m[1]), ['Feed', 'Explore', 'Liked', 'Settings']);
  assert.match(sections, /\['liked', 'Liked', LIKED\]/);
  for (const v of ['profiles', 'tags', 'playlists', 'mine', 'upload']) assert.match(adsJs, new RegExp(`\\n      ${v}: \\{ title: '`), v);
  assert.doesNotMatch(adsJs, /'Admin'/, 'admin is phase 4');
});

test('H36: the native module runs only in the effective native mode', () => {
  assert.match(hubJs, /const adsIsNative = \(\) => !!\(adsNative && adsMode\(\) === 'native'\);/);
  const page = hubJs.slice(hubJs.indexOf('function viewAdshortisPage('), hubJs.indexOf('let adsLoading'));
  assert.ok(page.indexOf('adsIsNative()') < page.indexOf('adsFolderPage()'), 'native is decided before the folder page');
  assert.match(page, /if \(adsIsNative\(\)\) return adsNative\.view\(r\);/);
});

test('HASH: the ads branch is the first statement of the hashchange handler', () => {
  const handler = hubJs.slice(hubJs.indexOf("window.addEventListener('hashchange', (e) => {"));
  const body = handler.slice(handler.indexOf('{') + 1).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
  assert.match(body[0], /^if \(adsIsNative\(\) && pageIdOf\(e\.oldURL\) === 'adshortis' && route\(\)\.id === 'adshortis'/);
  assert.equal(body[1], 'return adsNative.onHash(e.oldURL, e.newURL);');
  // The build check never runs on a hashchange (H63).
  const hc = handler.slice(0, handler.indexOf('\n  });'));
  assert.doesNotMatch(hc, /checkBuild/);
});

test('H59/H78: a native view change runs the hub steps of render() in order', () => {
  const vc = hubJs.slice(hubJs.indexOf('viewChanged: () => {'), hubJs.indexOf('},', hubJs.indexOf('viewChanged: () => {')));
  const order = ['renderedKey = pageKey();', 'updateNav();', "$('#view').focus({ preventScroll: true });", 'closeMenu();'].map((s) => vc.indexOf(s));
  assert.ok(order.every((n) => n > 0), vc);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // onHash: one teardown, then the subtree, then the hub.
  const on = adsJs.slice(adsJs.indexOf('function onHash('), adsJs.indexOf('function subnav('));
  assert.match(on, /leave\(\);\n\s+redraw\(\);\n\s+hub\.viewChanged\(\);/);
});

test('LEAVE/REDRAW: render() tears the module down; the module never calls the hub render', () => {
  const r = hubJs.slice(hubJs.indexOf('function render(focus = true) {'), hubJs.indexOf('renderedKey = pageKey();', hubJs.indexOf('function render(focus = true) {')));
  assert.match(r, /if \(route\(\)\.id === 'adshortis'\) adsNative\.leave\(\);\n\s+else adsNative\.reset\(\);/);
  assert.doesNotMatch(adsJs.replace(/^\s*\/\/.*$/gm, ''), /\brerender\b|\brender\(/);
  const lv = adsJs.slice(adsJs.indexOf('function leave() {'), adsJs.indexOf('function reset() {'));
  assert.match(lv, /ctl\.abort\(\);/);
  assert.match(lv, /open\.player\.stop\(\)/);
});

test('STORE/SEARCH: only the six grabbit.ads.* keys, through one store; no history entry by itself', () => {
  const code = adsJs.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /sessionStorage|indexedDB|document\.cookie/);
  // UX 6: localStorage only inside adsStore, whose key list is exactly these.
  assert.match(code, /const STORE_KEYS = \['grabbit\.ads\.sound', 'grabbit\.ads\.autoplay', 'grabbit\.ads\.autoscroll', 'grabbit\.ads\.clean', 'grabbit\.ads\.cols', 'grabbit\.ads\.lastFeed'\];/);
  const store = code.slice(code.indexOf('const adsStore = {'), code.indexOf('const prefs = {'));
  assert.equal((code.match(/localStorage/g) || []).length, (store.match(/localStorage/g) || []).length, 'localStorage outside adsStore');
  assert.equal((store.match(/if \(!STORE_KEYS\.includes\(k\)\) return/g) || []).length, 2, 'get and set check the key');
  const keys = new Set(code.match(/grabbit\.ads\.[A-Za-z]+/g));
  for (const k of keys) assert.match(k, /^grabbit\.ads\.(sound|autoplay|autoscroll|clean|cols|lastFeed)$/, k);
  // No resume position is stored (it stays with Adshortis' prefs).
  assert.match(code, /resume: null \}/);
  assert.doesNotMatch(code, /resumeEntry/);
  assert.doesNotMatch(code, /adshortis:/);
  assert.doesNotMatch(code, /history\.pushState/);
  // Legacy ?creator= leaves the address before the lookup, and the name goes in the POST body (H35).
  const map = adsJs.slice(adsJs.indexOf('function mapLegacy('), adsJs.indexOf('function drawView('));
  assert.ok(map.indexOf("hub.replaceHash(link('profiles'))") < map.indexOf('lookupCreator('));
  assert.match(map, /call\('creators\/lookup', \{ method: 'POST', body: \{ name \} \}\)/);
});

test('BANNER: role=status, checked on boot and visibilitychange, null build disables it', () => {
  assert.match(hubJs, /h\('div', \{ class: 'build-banner', role: 'status', 'aria-live': 'polite' \},/);
  assert.match(hubJs, /h\('span', null, 'Grabbit was updated\.'\)/);
  assert.match(hubJs, /if \(!PAGE_BUILD \|\| !srv \|\| srv === PAGE_BUILD\) return;/);
  assert.match(hubJs, /document\.addEventListener\('visibilitychange', \(\) => \{/);
  assert.match(hubJs, /if \(state\.config\) checkBuild\(state\.config\.build\);/);
  // Idle needs the module's empty store (H75).
  assert.match(hubJs, /if \(adsNative && !adsNative\.idle\(\)\) return false;/);
  assert.match(adsJs, /const idle = \(\) => !open\.player && open\.sheets === 0 && SH\.count\(\) === 0 && storeEmpty\(\);/);
  assert.match(hubCss, /\.build-banner \{[\s\S]*?top: calc\(100px \+ env\(safe-area-inset-top\)\);/);
});

test('EXPLORE/SEARCH: words only in the M2 POST body; search-as-you-type limits; modal player markers', () => {
  const code = adsJs.replace(/^\s*\/\/.*$/gm, '');
  const ex = code.slice(code.indexOf('function viewExplore() {'), code.indexOf('function viewLink() {'));
  assert.ok(ex.length > 1000, 'viewExplore exists');
  assert.match(code, /explore: \{ title: 'Explore', draw: viewExplore \}/);
  // UX 9.5: 300 ms, two characters, at most 60 per page (H64).
  assert.match(code, /const SEARCH_MIN = 2;/);
  assert.match(code, /const SEARCH_DELAY = 300;/);
  assert.match(code, /const GRID_PAGE = 60;/);
  // H6: the words go to POST search in the body; never into a query or an address.
  assert.match(ex, /const body = \{ q: words, limit: GRID_PAGE \};/);
  assert.match(ex, /return call\('search', \{ method: 'POST', body, signal \}\);/);
  assert.doesNotMatch(code, /\.set\('q'|[?&]q=/);
  assert.doesNotMatch(code, /link\([^)]*words/i);
  assert.doesNotMatch(ex, /replaceHash\([^)]*words/i);
  // The box keeps nothing in the browser's form history.
  assert.match(ex, /type: 'search', class: 'field ads-search-in'/);
  assert.match(ex, /autocomplete: 'off'/);
  assert.doesNotMatch(ex.slice(ex.indexOf("const input = h('input'"), ex.indexOf('input.value = store.words')), /\bname:/);
  // UX 10.1/10.3: the player over the grid is a modal the key guard knows, with its own entry.
  assert.match(ex, /class: 'viewer ads-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Clip player', 'data-feed-player': ''/);
  assert.match(ex, /ownHistory: how === 'tap'/);
  // Share from a grid uses the explore route (H70).
  assert.match(ex, /route: 'explore'/);
});
