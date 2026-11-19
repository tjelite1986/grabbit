'use strict';
// Accuracy check of the photo and video engines on a fixture folder made by
// scripts/dupes-fixtures.sh. Usage:
//   node scripts/dupes-accuracy.js <fixtures dir> [path to dinov2_small.onnx]
// Prints the groups each engine forms and the time per file.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const media = require('../dupe-media');
const { hashFrame } = require('../dupe-phash');
const { groupPhotos } = require('../dupe-photo');
const { groupVideos, packFrames, packProbes, PROBE_AT } = require('../dupe-video');
const ai = require('../dupe-ai');

(async () => {
  const dir = process.argv[2];
  const model = process.argv[3];
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const names = new Map();
  const photos = [];
  const vecs = new Map();
  const emb = model && ai.runtime() ? new ai.Embedder({ modelId: 'light', file: model, threads: 2 }) : null;
  const t = { image: [], embed: [], video: [] };
  const seen = new Set();
  for (const n of fs.readdirSync(path.join(dir, 'photos')).sort()) {
    const f = path.join(dir, 'photos', n);
    const s = sha(f);
    names.set(s, (names.get(s) ? `${names.get(s)} = ` : '') + n);
    if (seen.has(s)) continue;
    seen.add(s);
    let t0 = Date.now();
    const meta = await media.probe(f);
    const img = await media.readImage(f, { rgb: Boolean(emb) });
    const h = hashFrame(img.gray);
    t.image.push(Date.now() - t0);
    photos.push({ sha256: s, kind: 'image', phash: h.phash, phash_rot: h.phashRot.join(','), dhash: h.dhash, width: meta.width, height: meta.height, vcodec: meta.vcodec, sharpness: h.sharpness });
    if (emb) { t0 = Date.now(); const [v] = await emb.embed(img.rgb); t.embed.push(Date.now() - t0); vecs.set(s, v); }
  }
  const show = (label, r) => {
    console.log(`\n${label}: ${r.groups.length} group(s)`);
    for (const g of r.groups) console.log(` - ${g.match} (${g.score}): ${g.members.map((m) => `${names.get(m.sha256)}${m.score < 1 ? ` [${m.score}${m.distance != null ? `, d=${m.distance}` : ''}]` : ''}`).join(' | ')}`);
  };
  for (const mode of ['strict', 'balanced', 'relaxed']) show(`Photos, pHash only, ${mode}`, groupPhotos(photos, new Map(), { mode }));
  if (emb) for (const mode of ['strict', 'balanced', 'relaxed']) show(`Photos, pHash + DINOv2 light, ${mode}`, groupPhotos(photos, vecs, { mode, threshold: ai.thresholdFor('light', ai.MODES[mode]) }));
  const vids = [];
  const vseen = new Set();
  for (const n of fs.readdirSync(path.join(dir, 'videos')).sort()) {
    const f = path.join(dir, 'videos', n);
    const s = sha(f);
    names.set(s, (names.get(s) ? `${names.get(s)} = ` : '') + n);
    if (vseen.has(s)) continue;
    vseen.add(s);
    const t0 = Date.now();
    const meta = await media.probe(f);
    const p = packFrames(await media.readVideoFrames(f));
    const probes = packProbes(await media.readFramesAt(f, meta.duration, PROBE_AT));
    t.video.push(Date.now() - t0);
    vids.push({ sha256: s, kind: 'video', ...meta, frames: p.buf, probes, sharpness: p.sharpness });
  }
  show('Videos', groupVideos(vids));
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  console.log(`\nms per picture (decode + hash): ${avg(t.image)}; ms per embedding: ${avg(t.embed)}; ms per video: ${avg(t.video)}`);
})().catch((e) => { console.error(e); process.exit(1); });
