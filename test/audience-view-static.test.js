'use strict';
// H4: only the hub's 18+ view asks the server for entries that are not
// classified general. The request parameter `audience=adult` is built in one
// place in the hub, and only while the Media page shows its 18+ or
// Unclassified view; no other page in public/ sends it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'vendor') out.push(...sources(p));
    } else if (/\.(js|html|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('audience=adult is built only by the hub\'s 18+ view helper', () => {
  const hits = [];
  for (const file of sources(PUBLIC)) {
    const text = fs.readFileSync(file, 'utf8');
    let i = -1;
    while ((i = text.indexOf('audience=adult', i + 1)) !== -1) hits.push({ file: path.relative(PUBLIC, file), at: i, text });
  }
  assert.equal(hits.length, 1, `expected one sender, found: ${hits.map((h) => h.file).join(', ')}`);
  const [hit] = hits;
  assert.equal(hit.file, path.join('hub', 'hub.js'));
  const line = hit.text.slice(hit.text.lastIndexOf('\n', hit.at) + 1, hit.text.indexOf('\n', hit.at));
  assert.match(line, /const adultParam = \(url\) => \(inAdultView\(\) \?/);
});

test('the 18+ view is the Media page with the 18+ or Unclassified filter, or the Library\'s opened 18+ scope', () => {
  const text = fs.readFileSync(path.join(PUBLIC, 'hub', 'hub.js'), 'utf8');
  assert.match(text, /const ADULT_AUDS = \['adult', 'unknown'\];/);
  const body = /const inAdultView = \(\) => \{\n([\s\S]*?)\n {2}\};/.exec(text);
  assert.ok(body, 'inAdultView is defined');
  assert.deepEqual(body[1].split('\n').map((l) => l.trim()), [
    'const r = route();',
    "if (r.id === 'library') return r.params.get('scope') === 'adult' && libUi.adultOk;",
    "return r.id === 'media' && ADULT_AUDS.includes(r.params.get('aud') || '');",
  ]);
  // The classic page never asks for the 18+ view.
  assert.equal(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').includes('audience=adult'), false);
});

test('hub media file URLs carry the H98 cache generation', () => {
  const text = fs.readFileSync(path.join(PUBLIC, 'hub', 'hub.js'), 'utf8');
  assert.match(text, /const fileUrl = \(id, v, download\) => adultParam\(`\/api\/hub\/media\/\$\{encodeURIComponent\(id\)\}\/file\?v=\$\{v\}&gen=2/);
});

test('a reduced job is drawn as hidden, not as a link still resolving (H97)', () => {
  const hub = fs.readFileSync(path.join(PUBLIC, 'hub', 'hub.js'), 'utf8');
  assert.match(hub, /j\.audienceHidden \? '18\+ or unclassified item'/);
  const classic = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(classic, /j\.audienceHidden \? '18\+ or unclassified item'/);
});

test('every thumbnail URL the hub and the classic page build carries v=2 (H34)', () => {
  const hub = fs.readFileSync(path.join(PUBLIC, 'hub', 'hub.js'), 'utf8');
  assert.match(hub, /adultParam\('\/api\/thumb\?url=' \+ encodeURIComponent\(s\) \+ '&v=2'\)/);
  assert.match(hub, /adultParam\(`\$\{s\}&v=2`\)/);
  assert.equal(/thumb\?id=local-/.test(hub), false, 'the hub never builds a legacy frame URL');
  const classic = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(classic, /'\/api\/thumb\?url=' \+ encodeURIComponent\(s\) \+ '&v=2'/);
});

test('the hub reloads and redraws its tile pages when a classification changes (H99)', () => {
  const hub = fs.readFileSync(path.join(PUBLIC, 'hub', 'hub.js'), 'utf8');
  assert.match(hub, /if \(d\.type === 'audience'\) \{\n\s+load\(\['summary', 'history', 'media', 'mediaAdult'\]\)\.then\(\(\) => \{ if \(AUDIENCE_PAGES\.includes\(route\(\)\.id\)\) render\(false\); \}\);/);
  assert.match(hub, /const AUDIENCE_PAGES = \['', 'queue', 'media', 'profiles'\];/);
});
