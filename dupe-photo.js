'use strict';
// AI Photo Engine: groups pictures that show the same image (near duplicates)
// or look alike (visually similar), across different files, formats,
// resolutions, compression, small crops, rotation and colour changes.
//
// Two stages, so nothing is compared with everything:
// 1. Candidates: pictures whose perceptual hashes share a band (pHash of the
//    picture and of its three rotations), plus, when DINOv2 embeddings exist,
//    pictures that share a random-hyperplane LSH bucket.
// 2. Verification of each candidate pair: Hamming distance of the pHashes and
//    the cosine of the embeddings decide the link and its kind.
//
// Identical bytes never reach this engine as two pictures: features are kept
// per sha256, and exact copies are the Identical tab's business.
//
// A similarity score is evidence, not proof. Nothing here removes anything,
// and AI matches are review-only.

const { hamming, bandPairs, MAX_PAIRS } = require('./dupe-phash');
const { lshPairsGen, dot, runSync, runAsync } = require('./dupe-ai');
const { cliques, pk } = require('./dupe-group');

// Per mode: the largest pHash distance that still counts as the same picture,
// and the cosine above which DINOv2 alone calls two pictures near duplicates.
const PHASH_NEAR = { strict: 4, balanced: 6, relaxed: 9 };
const COS_NEAR = 0.975;
// A pHash match is double-checked by the embeddings when they exist: two
// different pictures with similar layout can collide on pHash.
const COS_VETO = 0.88;

function phashList(f) {
  const rot = f.phash_rot ? f.phash_rot.split(',') : [];
  return [f.phash, ...rot].filter(Boolean);
}

// Smallest distance between a's upright hash and any orientation of b.
function phashDistance(a, b) {
  const hb = phashList(b);
  let best = 65;
  let turn = 0;
  hb.forEach((h, i) => {
    const d = hamming(a.phash, h);
    if (d < best) { best = d; turn = i; }
  });
  return { d: best, turn };
}

function explainPair(a, b, link) {
  const why = [];
  if (link.d != null && link.d <= 12) why.push(link.d === 0 ? 'Perceptual hashes are identical' : `Perceptual hashes differ in ${link.d} of 64 bits`);
  if (link.turn) why.push(`Matches after turning it ${link.turn * 90} degrees`);
  if (link.cos != null) why.push(`AI similarity ${(link.cos * 100).toFixed(1)}%`);
  if (a.width && b.width && (a.width !== b.width || a.height !== b.height)) why.push(`Different size (${a.width}x${a.height} and ${b.width}x${b.height})`);
  const ra = a.width && a.height ? a.width / a.height : null;
  const rb = b.width && b.height ? b.width / b.height : null;
  if (ra && rb && Math.abs(ra - rb) / Math.max(ra, rb) > 0.03 && !link.turn) why.push('Different shape: one may be cropped');
  if (a.vcodec && b.vcodec && a.vcodec !== b.vcodec) why.push(`Different format (${a.vcodec} and ${b.vcodec})`);
  return why;
}

// features: rows of dx.features (kind image). embeddings: Map sha -> Float32Array.
// opts: { mode, threshold (cosine for "similar"), decisions: Map "a|b" -> decision }
function groupPhotos(features, embeddings = new Map(), opts = {}) {
  return runSync(groupPhotosGen(features, embeddings, opts));
}

// The same, handing the event loop back while it works (the analyzer's path).
function groupPhotosAsync(features, embeddings = new Map(), opts = {}) {
  return runAsync(groupPhotosGen(features, embeddings, opts));
}

function* groupPhotosGen(features, embeddings = new Map(), opts = {}) {
  const mode = PHASH_NEAR[opts.mode] != null ? opts.mode : 'balanced';
  const near = opts.phashNear != null ? opts.phashNear : PHASH_NEAR[mode];
  const thr = opts.threshold != null ? opts.threshold : 0.955;
  const decisions = opts.decisions || new Map();
  const items = features.filter((f) => f.phash);

  const cand = bandPairs(items.map((f) => ({ hashes: phashList(f) })), { bands: 8, maxBucket: 400, maxPairs: MAX_PAIRS });
  let capped = cand.capped;
  const withVec = items.map((f, i) => [i, embeddings.get(f.sha256)]).filter(([, v]) => v);
  if (withVec.length > 1 && !capped) {
    const ai = yield* lshPairsGen(withVec.map(([, v]) => v), { maxPairs: MAX_PAIRS });
    if (ai.capped) capped = true;
    for (const p of ai) {
      // One bound for both candidate sources together.
      if (cand.size >= MAX_PAIRS) { capped = true; break; }
      const [x, y] = p.split('|').map(Number);
      cand.add(pk(withVec[x][0], withVec[y][0]));
    }
  }

  const links = new Map();
  let n = 0;
  for (const p of cand) {
    if (++n % 512 === 0) yield;
    const [i, j] = p.split('|').map(Number);
    const a = items[i];
    const b = items[j];
    const dk = a.sha256 < b.sha256 ? `${a.sha256}|${b.sha256}` : `${b.sha256}|${a.sha256}`;
    if (decisions.has(dk)) continue;
    const { d, turn } = phashDistance(a, b);
    const va = embeddings.get(a.sha256);
    const vb = embeddings.get(b.sha256);
    const cos = va && vb ? dot(va, vb) : null;
    let kind = null;
    // The veto does not apply to a match found by turning the picture: the
    // stored embedding is of the upright picture only.
    if (d <= near && (cos == null || turn > 0 || cos >= COS_VETO)) kind = 'near';
    else if (cos != null && cos >= COS_NEAR) kind = 'near';
    else if (cos != null && cos >= thr) kind = 'similar';
    if (!kind) continue;
    const score = cos != null ? cos : 1 - d / 64;
    links.set(p, { kind, score, d, turn, cos });
  }

  const groups = [];
  for (const g of cliques(items.length, links)) {
    let match = 'near';
    let score = 1;
    for (let x = 0; x < g.length; x++) {
      for (let y = x + 1; y < g.length; y++) {
        const l = links.get(pk(g[x], g[y]));
        if (l.kind !== 'near') match = 'similar';
        score = Math.min(score, l.score);
      }
    }
    const seed = items[g[0]];
    const members = g.map((i) => {
      const f = items[i];
      if (i === g[0]) return { sha256: f.sha256, score: 1, why: ['Reference picture of this group'] };
      const l = links.get(pk(g[0], i));
      return { sha256: f.sha256, score: Math.round(l.score * 10000) / 10000, distance: l.d, cosine: l.cos, rotated: Boolean(l.turn), why: explainPair(seed, f, l) };
    });
    groups.push({
      match,
      score: Math.round(score * 10000) / 10000,
      members,
      explain: {
        engine: embeddings.size ? 'phash+dinov2' : 'phash',
        mode,
        summary: match === 'near'
          ? 'The same picture in different files: resized, recompressed, converted, slightly cropped or turned.'
          : 'Pictures that look alike. They may be different originals from the same shoot: compare before removing anything.',
      },
    });
  }
  return { groups, candidates: cand.size, capped, links: links.size, compared: items.length };
}

module.exports = { groupPhotos, groupPhotosAsync, phashDistance, PHASH_NEAR, COS_NEAR, explainPair };
