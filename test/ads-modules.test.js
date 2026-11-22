'use strict';
// Grabbit 3.0 native Adshortis, phase 1: ADSHORTIS_MODE (modules.js
// adshortisMode) and how modulesFor() reports the module.
const test = require('node:test');
const assert = require('node:assert/strict');
const { adshortisMode, modulesFor, ADS_MODES } = require('../modules');

const ALL = { apiOrigin: 'http://adshortis:3000', appOrigin: 'https://ads.example.com', publicOrigin: 'https://grabbit.example.com', embed: 'https://ads.example.com', authOn: true };
const mode = (raw, over = {}) => adshortisMode({ ADSHORTIS_MODE: raw }, { ...ALL, ...over });

test('unset, off and unknown modes are off', () => {
  for (const raw of [undefined, '', 'off', 'OFF', 'iframe', 'nativ']) assert.equal(mode(raw).mode, 'off', String(raw));
  assert.equal(mode('iframe').warnings.length, 1);
  assert.deepEqual(mode('').warnings, []);
});

test('native needs every setting and auth on; otherwise it falls back to embed, then off', () => {
  assert.deepEqual(mode('native'), { mode: 'native', warnings: [] });
  assert.equal(mode(' Native ').mode, 'native');
  for (const k of ['apiOrigin', 'appOrigin', 'publicOrigin']) {
    const r = mode('native', { [k]: null });
    assert.equal(r.mode, 'embed', k);
    assert.equal(r.warnings.length, 1, k);
    assert.equal(mode('native', { [k]: null, embed: null }).mode, 'off', k);
  }
  const noAuth = mode('native', { authOn: false });
  assert.equal(noAuth.mode, 'embed');
  assert.match(noAuth.warnings[0], /sign-in/);
});

test('embed needs a valid embed url', () => {
  assert.equal(mode('embed').mode, 'embed');
  const r = mode('embed', { embed: null });
  assert.equal(r.mode, 'off');
  assert.equal(r.warnings.length, 1);
});

test('every result is a known mode, and never safer-to-riskier', () => {
  const order = { off: 0, embed: 1, native: 2 };
  for (const raw of ['native', 'embed', 'off', 'x', '']) {
    for (const embed of [null, ALL.embed]) {
      for (const authOn of [true, false]) {
        const r = mode(raw, { embed, authOn });
        assert.ok(ADS_MODES.includes(r.mode));
        if (ADS_MODES.includes(raw)) assert.ok(order[r.mode] <= order[raw], `${raw} -> ${r.mode}`);
      }
    }
  }
});

test('modulesFor: adshortis follows its mode, adult audience, never planned', () => {
  for (const adsMode of ADS_MODES) {
    const m = modulesFor({ tikMode: 'off', adsMode }).find((x) => x.id === 'adshortis');
    assert.deepEqual(
      { enabled: m.enabled, mode: m.mode, audience: m.audience, group: m.group, planned: m.planned },
      { enabled: adsMode !== 'off', mode: adsMode, audience: 'adult', group: 'adult', planned: undefined }
    );
  }
  assert.equal(modulesFor({ tikMode: 'off' }).find((x) => x.id === 'adshortis').mode, 'off');
});
