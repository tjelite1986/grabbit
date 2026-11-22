'use strict';
// modules.js: the TIKSHORTIS_MODE choice and the module list /api/config sends.
// The fallbacks are rollback path A: an image deployed without (or with broken)
// 3.0 settings must behave like 2.2, never half-work.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tikshortisMode, modulesFor, MODULES, AUDIENCES, TIK_MODES } = require('../modules');

const API = 'http://192.168.0.10:3001';
const EMBED = { origin: 'https://tik.example.com', url: 'https://tik.example.com/' };

test('unset mode keeps 2.2: embed when an embed URL is set, else off', () => {
  assert.deepEqual(tikshortisMode({}, { apiOrigin: null, embed: EMBED }), { mode: 'embed', warnings: [] });
  assert.deepEqual(tikshortisMode({}, { apiOrigin: null, embed: null }), { mode: 'off', warnings: [] });
  assert.deepEqual(tikshortisMode({ TIKSHORTIS_MODE: '  ' }, { apiOrigin: API, embed: null }), { mode: 'off', warnings: [] },
    'an API URL alone does not switch native on');
});

test('explicit modes with their settings present', () => {
  assert.deepEqual(tikshortisMode({ TIKSHORTIS_MODE: 'native' }, { apiOrigin: API, embed: null }), { mode: 'native', warnings: [] });
  assert.deepEqual(tikshortisMode({ TIKSHORTIS_MODE: ' Native ' }, { apiOrigin: API, embed: EMBED }), { mode: 'native', warnings: [] });
  assert.deepEqual(tikshortisMode({ TIKSHORTIS_MODE: 'embed' }, { apiOrigin: API, embed: EMBED }), { mode: 'embed', warnings: [] });
  assert.deepEqual(tikshortisMode({ TIKSHORTIS_MODE: 'off' }, { apiOrigin: API, embed: EMBED }), { mode: 'off', warnings: [] });
});

test('fallbacks: native -> embed -> off, each with a warning', () => {
  let r = tikshortisMode({ TIKSHORTIS_MODE: 'native' }, { apiOrigin: null, embed: EMBED });
  assert.equal(r.mode, 'embed');
  assert.match(r.warnings.join('\n'), /needs a valid TIKSHORTIS_API_URL; using embed/);

  r = tikshortisMode({ TIKSHORTIS_MODE: 'native' }, { apiOrigin: null, embed: null });
  assert.equal(r.mode, 'off');
  assert.match(r.warnings.join('\n'), /using off/);

  r = tikshortisMode({ TIKSHORTIS_MODE: 'embed' }, { apiOrigin: API, embed: null });
  assert.equal(r.mode, 'off', 'embed never falls "up" to native');
  assert.match(r.warnings.join('\n'), /needs a valid TIKSHORTIS_EMBED_URL/);

  r = tikshortisMode({ TIKSHORTIS_MODE: 'iframe' }, { apiOrigin: API, embed: EMBED });
  assert.equal(r.mode, 'embed', 'an unknown mode is treated like unset, never as native');
  assert.match(r.warnings.join('\n'), /not one of native, embed, off/);

  r = tikshortisMode({ TIKSHORTIS_MODE: 'iframe' }, { apiOrigin: API, embed: null });
  assert.equal(r.mode, 'off');
});

test('every result is a known mode', () => {
  for (const m of ['', 'native', 'embed', 'off', 'NATIVE', 'x', 'native,embed']) {
    for (const apiOrigin of [null, API]) {
      for (const embed of [null, EMBED]) {
        assert.ok(TIK_MODES.includes(tikshortisMode({ TIKSHORTIS_MODE: m }, { apiOrigin, embed }).mode));
      }
    }
  }
});

test('modulesFor: TikShortis follows the mode; planned modules stay dark', () => {
  for (const tikMode of TIK_MODES) {
    const list = modulesFor({ tikMode });
    assert.deepEqual(list.map((m) => m.id), MODULES.map((m) => m.id));
    const tik = list.find((m) => m.id === 'tikshortis');
    assert.equal(tik.mode, tikMode);
    assert.equal(tik.enabled, tikMode !== 'off');
    assert.equal(tik.audience, 'general');
    const social = list.find((m) => m.id === 'social');
    assert.deepEqual([social.enabled, social.mode], [false, 'off']);
    const ads = list.find((m) => m.id === 'adshortis');
    assert.deepEqual([ads.enabled, ads.mode], [false, 'off']);
    for (const m of list.filter((x) => !['tikshortis', 'social', 'adshortis'].includes(x.id))) {
      assert.equal(m.enabled, false, m.id);
      assert.equal(m.planned, true, m.id);
      assert.equal(m.mode, undefined, m.id);
    }
  }
});

test('modules: known audiences, adult modules grouped apart', () => {
  for (const m of MODULES) {
    assert.ok(AUDIENCES.includes(m.audience), m.id);
    assert.equal(m.audience === 'adult', m.group === 'adult', `${m.id}: adult modules and only those sit in the adult group`);
  }
  assert.equal(new Set(MODULES.map((m) => m.id)).size, MODULES.length);
});
