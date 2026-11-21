'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../smart-routing');

test('orientationOf: portrait, landscape, square within tolerance, unknown', () => {
  assert.equal(R.orientationOf(1080, 1920), 'portrait');
  assert.equal(R.orientationOf(1920, 1080), 'landscape');
  assert.equal(R.orientationOf(1080, 1080), 'square');
  assert.equal(R.orientationOf(1080, 1078), 'square');
  assert.equal(R.orientationOf(1080, 1200), 'portrait');
  for (const [w, h] of [[null, 1080], [0, 0], [-1, 5], ['x', 3], [undefined, undefined], [Infinity, 2]]) {
    assert.equal(R.orientationOf(w, h), 'unknown', `${w}x${h}`);
  }
});

test('classifySource: the approved table, by slug, host or extractor key', () => {
  const cls = (input) => R.classifySource(input).class;
  assert.equal(cls({ site: 'tiktok' }), 'general');
  assert.equal(cls({ site: 'TikTok' }), 'general');
  assert.equal(cls({ sourceUrl: 'https://www.instagram.com/reel/x/' }), 'general');
  assert.equal(cls({ sourceUrl: 'https://fb.watch/abc/' }), 'general');
  assert.equal(cls({ site: 'youtube' }), 'general');
  assert.equal(cls({ site: 'fikfap.com' }), 'review');
  assert.equal(cls({ site: 'x' }), 'review');
  assert.equal(cls({ site: 'reddit' }), 'review');
  assert.equal(cls({ site: 'brandnew.example' }), 'review');
  assert.equal(cls({}), 'review');
  // An 18+ site outranks the table, RedGIFs included.
  assert.equal(cls({ site: 'redgifs' }), 'adult');
  assert.equal(cls({ site: 'tiktok', sourceUrl: 'https://erome.com/a/1' }), 'adult');
  // A host that only contains a known name is not that source.
  assert.equal(cls({ sourceUrl: 'https://tiktok.com.attacker.example/v' }), 'review');
});

test('suggestionForSites: only when every site is a General source', () => {
  assert.equal(R.suggestionForSites(['tiktok']).audience, 'general');
  assert.match(R.suggestionForSites(['tiktok', 'youtube']).reason, /TikTok, YouTube/);
  assert.equal(R.suggestionForSites(['tiktok', 'fikfap']), null);
  assert.equal(R.suggestionForSites(['tiktok', 'redgifs']), null);
  assert.equal(R.suggestionForSites([]), null);
  assert.equal(R.suggestionForSites(['unknown']), null);
  assert.equal(R.suggestionForSites(null), null);
});

test('sourceOverview: the table always, plus newly detected sources as Review', () => {
  const o = R.sourceOverview(['tiktok', 'vimeo', 'erome']);
  assert.deepEqual(o.slice(0, 6).map((x) => x.id), ['tiktok', 'facebook', 'instagram', 'youtube', 'redgifs', 'fikfap']);
  assert.equal(o.find((x) => x.id === 'tiktok').seen, true);
  // The table says Review for RedGIFs; it is an 18+ site, and 18+ wins.
  const red = o.find((x) => x.id === 'redgifs');
  assert.equal(red.specClass, 'review');
  assert.equal(red.class, 'adult');
  const vimeo = o.find((x) => x.id === 'vimeo');
  assert.equal(vimeo.class, 'review');
  assert.equal(vimeo.detected, true);
  assert.equal(o.find((x) => x.id === 'erome').class, 'adult');
});

test('decideRoute: the full table', () => {
  const P = { width: 1080, height: 1920 };
  const L = { width: 1920, height: 1080 };
  const S = { width: 720, height: 720 };
  const general = { audience: 'general', mainRefusal: null, shortsMain: true, shorts18: true };
  const unknown = { audience: 'unknown', mainRefusal: 'not classified', shortsMain: true, shorts18: true };
  const adult = { audience: 'adult', mainRefusal: '18+', shortsMain: true, shorts18: true };
  const r = (input, facts) => R.decideRoute(input, facts);

  assert.deepEqual(pick(r({ ...P, site: 'tiktok' }, general)), ['elite', 'main', null, 'shorts']);
  assert.deepEqual(pick(r({ ...L, site: 'tiktok' }, general)), ['server', 'main', 'videos', 'long-videos']);
  assert.deepEqual(pick(r({ ...S, site: 'tiktok' }, general)), ['server', 'main', 'review', 'review']);
  assert.deepEqual(pick(r({ site: 'tiktok' }, general)), ['server', 'main', 'review', 'review']);
  // General source, creator not classified: Review, never Shorts.
  assert.equal(r({ ...P, site: 'tiktok' }, unknown).route, 'review');
  // Landscape from a General source goes to Long Videos whatever the creator.
  assert.equal(r({ ...L, site: 'youtube' }, unknown).route, 'long-videos');
  // No Shorts library: Review.
  assert.equal(r({ ...P, site: 'tiktok' }, { ...general, shortsMain: false }).route, 'review');
  // Review sources.
  assert.equal(r({ ...P, site: 'fikfap' }, general).route, 'review');
  assert.equal(r({ ...L, site: 'newsite' }, general).route, 'review');
  // 18+ wins over everything.
  assert.equal(r({ ...P, site: 'tiktok' }, adult).route, 'shorts-18');
  assert.equal(r({ ...P, site: 'redgifs' }, general).route, 'shorts-18');
  assert.equal(r({ ...P, site: 'redgifs' }, { ...general, shorts18: false }).route, 'adults');
  assert.equal(r({ ...L, site: 'tiktok' }, adult).route, 'adults');
  assert.equal(r({ ...S, site: 'tiktok' }, adult).route, 'adults');
  // Every decision says why.
  assert.ok(r({ ...P, site: 'tiktok' }, general).reasons.length >= 2);
});

function pick(d) {
  return [d.dest, d.channel, d.folder, d.route];
}
