'use strict';
// Turning pairwise matches into groups, for both engines.
//
// A group must be a clique: every member matches every other member. Linking
// A~B and B~C is not enough to group A with C (two different photos from one
// shoot can each look like a third). Connected components are found first,
// then split greedily like photo-duplicate-finder-ai's _split_complete():
// seed with the best-connected member, add members that match everyone already
// in the group, strongest first, and repeat on what is left.
//
// The owner's pair decisions ("different", "related") remove a link before
// grouping, so Keep both is remembered across runs and model changes.

const MAX_COMPONENT = 400;

// links: Map "i|j" (i < j) -> { score, ... }. Returns arrays of indices.
function cliques(n, links) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const adj = new Map();
  for (const [k, v] of links) {
    const [a, b] = k.split('|').map(Number);
    parent[find(a)] = find(b);
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(a).set(b, v.score);
    adj.get(b).set(a, v.score);
  }
  const comps = new Map();
  for (const i of adj.keys()) {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(i);
  }
  const out = [];
  for (let comp of comps.values()) {
    if (comp.length < 2) continue;
    // A huge component is almost always a chain of loosely similar pictures;
    // keep the best-connected part and let the rest form their own groups.
    if (comp.length > MAX_COMPONENT) comp = comp.sort((a, b) => adj.get(b).size - adj.get(a).size).slice(0, MAX_COMPONENT);
    const left = new Set(comp);
    while (left.size > 1) {
      let seed = null;
      let best = -1;
      for (const i of left) {
        let c = 0;
        for (const j of adj.get(i).keys()) if (left.has(j)) c++;
        if (c > best) { best = c; seed = i; }
      }
      if (best <= 0) break;
      const group = [seed];
      const cands = [...adj.get(seed).entries()].filter(([j]) => left.has(j)).sort((a, b) => b[1] - a[1]);
      for (const [c] of cands) if (group.every((g) => adj.get(c).has(g))) group.push(c);
      for (const g of group) left.delete(g);
      if (group.length > 1) out.push(group);
    }
    // A member that matched someone but fits no clique (a rotated copy that
    // only the upright original matches) is not dropped: it forms a pair with
    // its strongest match, even if that one is in another group already.
    const placed = new Set(out.flat());
    for (const i of comp) {
      if (placed.has(i)) continue;
      const best = [...adj.get(i).entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) out.push([best[0], i]);
    }
  }
  return out;
}

const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

module.exports = { cliques, pk, MAX_COMPONENT };
