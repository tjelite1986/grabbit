'use strict';
// Video Fingerprint Engine: finds the same video across files whose bytes
// differ (other codec, resolution, bitrate, container, a re-encode, changed
// audio, small visual changes), and clips cut from a longer video.
//
// A fingerprint is the video's keyframes over its whole length, each as a
// 64-bit perceptual hash with its time, plus what ffprobe reports. Matching:
// - Same length (within 3 % or 1.5 s): every sampled moment of one video must
//   find a close frame in the other at about the same time, across all four
//   quarters of the video. A shared intro is one quarter at most, so two
//   different videos with the same intro do not match.
// - Different length: the shorter one is tested as a clip of the longer by
//   voting on the time offset; most of the clip's frames must line up at one
//   offset. Partial matches are listed apart and are never removable copies.
//
// Flat frames (black, white, single-colour title cards) are dropped when the
// fingerprint is made: they say nothing about which video it is.

const { hashFrame, hamming, bandPairs, MAX_PAIRS } = require('./dupe-phash');
const { cliques, pk } = require('./dupe-group');

const FRAME_BYTES = 12; // float32 time + 8 bytes hash
const MIN_CONTRAST = 6;
const FRAME_MATCH = 10; // Hamming distance for "the same moment"

function packFrames(frames) {
  const kept = [];
  for (const f of frames) {
    const h = hashFrame(f.gray, { rotations: false });
    if (h.contrast < MIN_CONTRAST) continue;
    kept.push({ t: f.t, h: h.phash });
  }
  const buf = Buffer.alloc(kept.length * FRAME_BYTES);
  kept.forEach((k, i) => {
    buf.writeFloatLE(k.t, i * FRAME_BYTES);
    Buffer.from(k.h, 'hex').copy(buf, i * FRAME_BYTES + 4);
  });
  return { buf, count: kept.length, sharpness: frames.length ? hashFrame(frames[Math.floor(frames.length / 2)].gray, { rotations: false }).sharpness : null };
}

function unpackFrames(buf) {
  const out = [];
  if (!buf) return out;
  for (let o = 0; o + FRAME_BYTES <= buf.length; o += FRAME_BYTES) out.push({ t: buf.readFloatLE(o), h: buf.subarray(o + 4, o + 12).toString('hex') });
  return out;
}

const sameLength = (a, b) => {
  if (!a.duration || !b.duration) return false;
  return Math.abs(a.duration - b.duration) <= Math.max(1.5, 0.03 * Math.max(a.duration, b.duration));
};

// Fraction of A's frames with a close frame in B near time t + offset.
function coverage(A, B, offset, tol) {
  let hit = 0;
  const quarters = new Set();
  const dur = A.length ? Math.max(A[A.length - 1].t, 0.001) : 1;
  let j0 = 0;
  for (const fa of A) {
    const want = fa.t + offset;
    while (j0 < B.length && B[j0].t < want - tol) j0++;
    let ok = false;
    for (let j = j0; j < B.length && B[j].t <= want + tol; j++) {
      if (hamming(fa.h, B[j].h) <= FRAME_MATCH) { ok = true; break; }
    }
    if (ok) {
      hit++;
      quarters.add(Math.min(3, Math.floor((fa.t / dur) * 4)));
    }
  }
  return { ratio: A.length ? hit / A.length : 0, hit, quarters: quarters.size };
}

// Best time offset of short clip S inside long video L, by voting.
function bestOffset(S, L) {
  const votes = new Map();
  for (const s of S) {
    for (const l of L) {
      if (hamming(s.h, l.h) <= FRAME_MATCH - 2) {
        const o = Math.round(l.t - s.t);
        votes.set(o, (votes.get(o) || 0) + 1);
      }
    }
  }
  let best = null;
  let n = 0;
  for (const [o, c] of votes) {
    const near = c + (votes.get(o - 1) || 0) + (votes.get(o + 1) || 0);
    if (near > n) { n = near; best = o; }
  }
  return { offset: best, votes: n };
}

// The probes: frames at the same relative positions (5 % ... 95 %) of both
// videos. Packed like keyframes; a flat probe has an empty hash.
const PROBE_AT = [0.05, 0.17, 0.29, 0.41, 0.53, 0.65, 0.77, 0.89];
function packProbes(frames) {
  const buf = Buffer.alloc(frames.length * FRAME_BYTES);
  frames.forEach((f, i) => {
    buf.writeFloatLE(f.t, i * FRAME_BYTES);
    if (!f.gray) return buf.fill(0xff, i * FRAME_BYTES + 4, i * FRAME_BYTES + 12);
    const h = hashFrame(f.gray, { rotations: false });
    if (h.contrast < MIN_CONTRAST) return buf.fill(0xff, i * FRAME_BYTES + 4, i * FRAME_BYTES + 12);
    Buffer.from(h.phash, 'hex').copy(buf, i * FRAME_BYTES + 4);
    return null;
  });
  return buf;
}
const FLAT = 'ffffffffffffffff';

// Same-time evidence: probe i of A against probe i of B, plus keyframes that
// happen to sit at the same time (within 0.12 s) in both.
function alignedEvidence(a, b) {
  let compared = 0;
  let hit = 0;
  const quarters = new Set();
  const pa = a.probesList || [];
  const pb = b.probesList || [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i].h === FLAT || pb[i].h === FLAT) continue;
    compared++;
    if (hamming(pa[i].h, pb[i].h) <= FRAME_MATCH) { hit++; quarters.add(Math.min(3, Math.floor(PROBE_AT[i] * 4))); }
  }
  const dur = Math.max(a.duration, 0.001);
  let j0 = 0;
  for (const fa of a.framesList) {
    while (j0 < b.framesList.length && b.framesList[j0].t < fa.t - 0.12) j0++;
    const fb = b.framesList[j0];
    if (!fb || Math.abs(fb.t - fa.t) > 0.12) continue;
    compared++;
    if (hamming(fa.h, fb.h) <= FRAME_MATCH) { hit++; quarters.add(Math.min(3, Math.floor((fa.t / dur) * 4))); }
  }
  return { compared, hit, ratio: compared ? hit / compared : 0, quarters: quarters.size };
}

// Compares two fingerprints. Returns null or { match, score, ... }.
function compareVideos(a, b) {
  const A = a.framesList;
  const B = b.framesList;
  if (A.length < 3 || B.length < 3) return null;
  if (sameLength(a, b)) {
    const e = alignedEvidence(a, b);
    if (e.compared < 4) return null;
    if (e.ratio >= 0.8 && e.quarters >= 3) return { match: 'reencoded', score: e.ratio, quarters: e.quarters };
    if (e.ratio >= 0.55 && e.quarters >= 3) return { match: 'similar', score: e.ratio, quarters: e.quarters };
    return null;
  }
  const [S, L, s, l] = a.duration <= b.duration ? [A, B, a, b] : [B, A, b, a];
  if (!s.duration || !l.duration || s.duration > l.duration * 0.97) return null;
  const { offset, votes } = bestOffset(S, L);
  if (offset == null || votes < 4) return null;
  const c = coverage(S, L, offset, 2);
  if (c.ratio >= 0.6 && c.hit >= 4 && c.quarters >= 3) {
    return { match: 'partial', score: c.ratio, offset, clip: s.sha256, source: l.sha256, quarters: c.quarters };
  }
  return null;
}

function explainVideo(a, b, r) {
  const why = [];
  if (r.match === 'partial') {
    const [s, l] = a.sha256 === r.clip ? [a, b] : [b, a];
    why.push(`A ${Math.round(s.duration)} s clip that lines up with ${Math.max(0, r.offset)} s into a ${Math.round(l.duration)} s video`);
  } else {
    why.push(`${Math.round(r.score * 100)}% of the sampled moments match, in ${r.quarters} of 4 quarters`);
  }
  if (a.vcodec !== b.vcodec) why.push(`Different codec (${a.vcodec || '?'} and ${b.vcodec || '?'})`);
  if (a.width !== b.width || a.height !== b.height) why.push(`Different resolution (${a.width}x${a.height} and ${b.width}x${b.height})`);
  if (a.bitrate && b.bitrate && Math.abs(a.bitrate - b.bitrate) / Math.max(a.bitrate, b.bitrate) > 0.1) why.push('Different bitrate');
  if (a.container !== b.container) why.push(`Different container (${a.container || '?'} and ${b.container || '?'})`);
  if ((a.acodec || null) !== (b.acodec || null)) why.push(a.acodec && b.acodec ? 'Different audio codec' : 'One has no audio');
  return why;
}

// features: dx.features rows of kind video. Returns { groups, partials }.
function groupVideos(features, opts = {}) {
  const decisions = opts.decisions || new Map();
  const items = features
    .map((f) => ({ ...f, framesList: unpackFrames(f.frames), probesList: unpackFrames(f.probes) }))
    .filter((f) => f.framesList.length >= 3 && f.duration);
  // Candidates: videos sharing frame-hash bands (keyframes and probes).
  // Common frames (logos, black with a watermark) overflow their bucket and
  // are ignored.
  const cand = bandPairs(items.map((f) => ({ hashes: f.framesList.concat(f.probesList).map((x) => x.h).filter((h) => h !== FLAT) })), { bands: 8, maxBucket: 60, maxPairs: MAX_PAIRS });
  const links = new Map();
  const partials = [];
  for (const p of cand) {
    const [i, j] = p.split('|').map(Number);
    const a = items[i];
    const b = items[j];
    const dk = a.sha256 < b.sha256 ? `${a.sha256}|${b.sha256}` : `${b.sha256}|${a.sha256}`;
    if (decisions.has(dk)) continue;
    const r = compareVideos(a, b);
    if (!r) continue;
    if (r.match === 'partial') {
      const [clip, src] = r.clip === a.sha256 ? [a, b] : [b, a];
      partials.push({
        match: 'partial',
        score: Math.round(r.score * 10000) / 10000,
        members: [
          { sha256: src.sha256, score: 1, role: 'source', why: ['The longer video'] },
          { sha256: clip.sha256, score: Math.round(r.score * 10000) / 10000, role: 'clip', offset: r.offset, why: explainVideo(a, b, r) },
        ],
        explain: { engine: 'keyframes', summary: 'One video appears inside the other. A clip is its own video: nothing here is a removable copy.' },
      });
      continue;
    }
    links.set(p, { ...r, score: r.score });
  }
  const groups = [];
  for (const g of cliques(items.length, links)) {
    let match = 'reencoded';
    let score = 1;
    for (let x = 0; x < g.length; x++) {
      for (let y = x + 1; y < g.length; y++) {
        const l = links.get(pk(g[x], g[y]));
        if (l.match !== 'reencoded') match = 'similar';
        score = Math.min(score, l.score);
      }
    }
    const seed = items[g[0]];
    groups.push({
      match,
      score: Math.round(score * 10000) / 10000,
      members: g.map((i) => {
        const f = items[i];
        if (i === g[0]) return { sha256: f.sha256, score: 1, why: ['Reference video of this group'] };
        const l = links.get(pk(g[0], i));
        return { sha256: f.sha256, score: Math.round(l.score * 10000) / 10000, why: explainVideo(seed, f, l) };
      }),
      explain: {
        engine: 'keyframes',
        summary: match === 'reencoded'
          ? 'The same video in different files: another codec, resolution, bitrate or container.'
          : 'Videos that share most of their picture. Compare them before removing anything.',
      },
    });
  }
  return { groups: groups.concat(partials), compared: items.length, candidates: cand.size, capped: !!cand.capped };
}

module.exports = { packFrames, packProbes, unpackFrames, compareVideos, groupVideos, coverage, bestOffset, alignedEvidence, FRAME_MATCH, PROBE_AT };
