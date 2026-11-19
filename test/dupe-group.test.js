'use strict';
// Pairwise matches into clique groups.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cliques, pk, MAX_COMPONENT } = require('../dupe-group');

const links = (list) => new Map(list.map(([a, b, score]) => [pk(a, b), { score }]));
const norm = (groups) => groups.map((g) => [...g].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0] || a.length - b.length);

test('pk orders the pair', () => {
  assert.equal(pk(3, 1), '1|3');
  assert.equal(pk(1, 3), '1|3');
});

test('no links gives no groups', () => {
  assert.deepEqual(cliques(5, new Map()), []);
});

test('a triangle is one group', () => {
  assert.deepEqual(norm(cliques(3, links([[0, 1, 0.9], [1, 2, 0.9], [0, 2, 0.9]]))), [[0, 1, 2]]);
});

test('separate pairs stay separate', () => {
  assert.deepEqual(norm(cliques(4, links([[0, 1, 0.9], [2, 3, 0.8]]))), [[0, 1], [2, 3]]);
});

test('a chain does not group its ends together', () => {
  const g = cliques(3, links([[0, 1, 0.9], [1, 2, 0.5]]));
  assert.ok(!g.some((x) => x.includes(0) && x.includes(2)));
  // The middle groups with its strongest match first.
  assert.deepEqual([...g[0]].sort(), [0, 1]);
});

test('a member that fits no clique pairs with its strongest match', () => {
  const g = cliques(3, links([[0, 1, 0.9], [1, 2, 0.5]]));
  assert.deepEqual(norm(g), [[0, 1], [1, 2]]);
});

test('every group is a clique', () => {
  // Two triangles sharing one node, plus a tail.
  const l = links([[0, 1, 0.9], [1, 2, 0.9], [0, 2, 0.9], [2, 3, 0.7], [3, 4, 0.7], [2, 4, 0.7], [4, 5, 0.6]]);
  const g = cliques(6, l);
  for (const grp of g) {
    for (let i = 0; i < grp.length; i++) for (let j = i + 1; j < grp.length; j++) assert.ok(l.has(pk(grp[i], grp[j])), `${grp} is not a clique`);
  }
  const seen = new Set(g.flat());
  for (let i = 0; i < 6; i++) assert.ok(seen.has(i), `member ${i} dropped`);
});

test('candidates join the seed strongest first', () => {
  // Seed 0 links to 1, 2, 3; only 1-3 are linked to each other. 0-3 is the
  // strongest, so 3 joins, then 1 (linked to 3), and 2 is left out.
  const g = cliques(4, links([[0, 1, 0.6], [0, 2, 0.7], [0, 3, 0.9], [1, 3, 0.8]]));
  assert.deepEqual([...g[0]].sort(), [0, 1, 3]);
  assert.deepEqual(norm(g.slice(1)), [[0, 2]]);
});

test('a component above MAX_COMPONENT keeps the best-connected part', () => {
  const n = MAX_COMPONENT + 1;
  const list = [];
  for (let i = 0; i < MAX_COMPONENT; i++) for (let j = i + 1; j < MAX_COMPONENT; j++) list.push([i, j, 0.9]);
  list.push([0, MAX_COMPONENT, 0.5]);
  const g = cliques(n, links(list));
  const big = g.find((x) => x.length === MAX_COMPONENT);
  assert.ok(big, 'the clique survives');
});

test('members beyond MAX_COMPONENT form their own groups', () => {
  const X = MAX_COMPONENT;
  const Y = MAX_COMPONENT + 1;
  const list = [];
  for (let i = 0; i < MAX_COMPONENT; i++) for (let j = i + 1; j < MAX_COMPONENT; j++) list.push([i, j, 0.9]);
  list.push([X, Y, 0.95], [0, X, 0.4]);
  const g = cliques(MAX_COMPONENT + 2, links(list));
  assert.ok(g.some((x) => x.includes(X) && x.includes(Y)));
});
