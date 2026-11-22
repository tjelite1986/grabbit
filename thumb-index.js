'use strict';
// The thumbnail provenance index (Grabbit 3.0 phase 0: H34, H42, H47, H57,
// H69, H83, H94). /api/thumb serves a picture, or fetches a missing one, only
// for a cache key this index knows, and only to a view its strictest
// provenance allows. A key nobody recorded is never fetched and answers 404.
//
// A key is the cache name of one picture: sha1 of a site URL, or the id of a
// frame Grabbit took itself (`f-<40 hex>`). Each key holds a set of
// provenances, one per place Grabbit learned it from:
//   { kind, ref, in, aud, at }
//   kind  'entry'   a history row (ref `h:<id>`) or a downloaded registry row
//                   (ref `r:<key>`) or a library item (ref `i:<key>`)
//         'local'   a frame Grabbit took for an entry (ref as for 'entry')
//         'job'     a download job's own picture (ref `j:<id>`)
//         'preview' a resolve result handed to a view (no ref)
//   in    the classification inputs of the entry (creator, site, channel,
//         source URL, ...), classified again on every check, so a later
//         reclassification is followed at once (H42, H94)
//   aud   a fixed audience, for a preview: the view the resolve was made in
// The served audience is the strictest provenance: any 18+ or unknown one
// makes the key 18+ (H42). Insertion order does not matter.
//
// Pure data handling; the server supplies classification and "is this ref
// still referenced" through callbacks.

const crypto = require('crypto');

const VERSION = 1;
const KINDS = ['entry', 'local', 'job', 'preview'];
const AUDS = ['general', 'adult', 'unknown'];
// Unreferenced keys kept at most (H34); referenced keys are never evicted (H42).
const MAX_UNREFERENCED = 20000;
// Provenances per key; previews and jobs give way first.
const MAX_PROVS = 24;
const IN_FIELDS = ['creator', 'sourceCreator', 'site', 'extractor', 'sourceUrl', 'channel', 'filename', 'itemKey'];

const KEY_RE = /^(?:[0-9a-f]{40}|f-[0-9a-f]{40})$/;
const FRAME_ID_RE = /^f-[0-9a-f]{40}$/;
const LEGACY_LOCAL_RE = /^local-[0-9a-f]{40}$/;

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
const keyOfUrl = (url) => sha1(url);
// A frame's id names its entry and its bytes, so two entries never share one
// file (H47, H69), even when the frames are byte-identical.
function frameId(ref, buf) {
  return `f-${sha1(`${ref}\0${crypto.createHash('sha1').update(buf).digest('hex')}`)}`;
}
// The file name prefix of a picture regenerated for one entry (H47).
const refTag = (ref) => sha1(ref).slice(0, 16);

function cleanIn(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of IN_FIELDS) {
    const v = input[k];
    if (typeof v === 'string' && v) out[k] = v.slice(0, 2048);
  }
  return out;
}

function stricter(a, b) {
  if (a === 'adult' || b === 'adult') return 'adult';
  return a === 'general' && b === 'general' ? 'general' : 'unknown';
}

class ThumbIndex {
  // classify(in) -> 'general' | 'adult' | 'unknown'
  // referenced(ref) -> true while the entry still exists (history row,
  //   registry key, item, live job)
  constructor({ classify, referenced, now = Date.now } = {}) {
    this.classify = classify || (() => 'unknown');
    this.referenced = referenced || (() => false);
    this.now = now;
    this.keys = new Map();
    this.migratedAt = null;
    this.dirty = false;
  }

  load(raw) {
    this.keys.clear();
    if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return false;
    this.migratedAt = Number(raw.migratedAt) || null;
    for (const [key, row] of Object.entries(raw.keys || {})) {
      if (!KEY_RE.test(key) || !row || !Array.isArray(row.provs)) continue;
      const provs = row.provs.map((p) => this.normProv(p)).filter(Boolean);
      if (provs.length) this.keys.set(key, { provs, at: Number(row.at) || 0 });
    }
    return true;
  }

  toJSON() {
    return { version: VERSION, migratedAt: this.migratedAt, keys: Object.fromEntries(this.keys) };
  }

  normProv(p) {
    if (!p || !KINDS.includes(p.kind)) return null;
    const out = { kind: p.kind, at: Number(p.at) || this.now() };
    if (typeof p.ref === 'string' && p.ref) out.ref = p.ref.slice(0, 2100);
    if (p.in) out.in = cleanIn(p.in);
    if (AUDS.includes(p.aud)) out.aud = p.aud;
    if (!out.in && !out.aud) out.aud = 'unknown';
    return out;
  }

  // Records one provenance for a key. The same kind and ref (or, for a
  // preview, the same audience) replaces the earlier one.
  add(key, prov) {
    if (!KEY_RE.test(String(key))) return false;
    const p = this.normProv(prov);
    if (!p) return false;
    let row = this.keys.get(key);
    if (!row) this.keys.set(key, (row = { provs: [], at: 0 }));
    const same = (q) => q.kind === p.kind && (p.ref ? q.ref === p.ref : !q.ref && q.aud === p.aud);
    const i = row.provs.findIndex(same);
    if (i >= 0) {
      const old = row.provs[i];
      if (JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...p, at: 0 }) && p.at - old.at < 3600 * 1000) {
        row.at = Math.max(row.at, p.at);
        return true;
      }
      row.provs[i] = p;
    } else {
      row.provs.push(p);
      if (row.provs.length > MAX_PROVS) {
        // Drop the oldest preview or job first; entry provenances stay.
        const order = row.provs
          .map((q, idx) => ({ q, idx }))
          .sort((a, b) => (a.q.kind === 'preview' || a.q.kind === 'job' ? 0 : 1) - (b.q.kind === 'preview' || b.q.kind === 'job' ? 0 : 1) || a.q.at - b.q.at);
        row.provs.splice(order[0].idx, 1);
      }
    }
    row.at = Math.max(row.at, p.at);
    this.dirty = true;
    return true;
  }

  has(key) {
    return this.keys.has(key);
  }

  provsOf(key) {
    const row = this.keys.get(key);
    return row ? row.provs : [];
  }

  audienceOfProv(p) {
    let a = p.aud || null;
    if (p.in) {
      let c;
      try {
        c = this.classify(p.in);
      } catch {
        c = 'unknown';
      }
      a = a ? stricter(a, c) : AUDS.includes(c) ? c : 'unknown';
    }
    return a || 'unknown';
  }

  // The strictest audience of a key, or null when the key is not indexed.
  audienceOf(key) {
    const row = this.keys.get(key);
    if (!row || !row.provs.length) return null;
    let out = 'general';
    for (const p of row.provs) {
      out = stricter(out, this.audienceOfProv(p));
      if (out === 'adult') break;
    }
    return out;
  }

  // The refs (entries) this key may regenerate from, newest first.
  refsOf(key) {
    return this.provsOf(key)
      .filter((p) => p.ref && (p.kind === 'entry' || p.kind === 'local'))
      .sort((a, b) => b.at - a.at)
      .map((p) => p.ref);
  }

  isReferenced(key) {
    return this.provsOf(key).some((p) => p.ref && p.kind !== 'preview' && this.referenced(p.ref));
  }

  // Drops the oldest unreferenced keys beyond the cap. Returns the dropped keys.
  prune(max = MAX_UNREFERENCED) {
    const loose = [];
    for (const [key, row] of this.keys) if (!this.isReferenced(key)) loose.push({ key, at: row.at });
    if (loose.length <= max) return [];
    loose.sort((a, b) => a.at - b.at);
    const drop = loose.slice(0, loose.length - max).map((x) => x.key);
    for (const k of drop) this.keys.delete(k);
    if (drop.length) this.dirty = true;
    return drop;
  }
}

module.exports = {
  ThumbIndex,
  VERSION,
  MAX_UNREFERENCED,
  KEY_RE,
  FRAME_ID_RE,
  LEGACY_LOCAL_RE,
  keyOfUrl,
  frameId,
  refTag,
  stricter,
  cleanIn,
};
