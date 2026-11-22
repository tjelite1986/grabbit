'use strict';
// Grabbit 3.0 native Adshortis, phase 1: the per-login id and the sealed link
// (plan part 3, H2; owner decision D11).
//
// What Grabbit keeps for Adshortis, and nothing more (S15):
//   ads-seal-key.json  one random 32-byte key that seals the upstream session
//                      token into the __Host-grabbit_ads cookie. Never derived
//                      from GRABBIT_SECRET or the password. Snapshotted daily
//                      (STATE_FILES): losing it only unlinks everyone.
//   ads-logins.json    per login id (stored as sha256 only): its expiry and the
//                      sha256 of its current seal. NOT snapshotted: restoring
//                      an old copy would bring revoked links back. A missing or
//                      corrupt file means "no links"; it is never rebuilt.
//   ads-mode.json      { mode, gen, auth }: the effective Adshortis mode, the
//                      cache generation (bumped on every mode change, H62) and
//                      a salted scrypt fingerprint of the Grabbit password and
//                      secret. A different mode or fingerprint at boot drops
//                      every login record.
//
// A seal is valid only when the login id it was made for (the AES-GCM AAD)
// matches the request's login id AND its hash is the one stored for that login
// id. Deleting the record therefore revokes the link at once, even when the
// upstream logout does not get through.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOGIN_DAYS = 30;
const LOGIN_MS = LOGIN_DAYS * 86400000;
const MAX_LOGINS = 1000;
const KEY_FILE = 'ads-seal-key.json';
const LOGINS_FILE = 'ads-logins.json';
const MODE_FILE = 'ads-mode.json';
const AAD_PREFIX = 'grabbit-ads-v1|';
const ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// A state file this module owns. Missing -> null. Present but unreadable ->
// moved aside as .corrupt-<stamp> and null (never restored from a snapshot).
function readOwn(file, log) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(file, kept); } catch { /* leave it; reported again next read */ }
    log.error(`[ads] ${path.basename(file)} did not parse; kept as ${path.basename(kept)}, starting without it`);
    return null;
  }
}

function createLinkStore({ dir, writeJsonAtomic, log = console, now = () => Date.now() }) {
  if (!dir || typeof writeJsonAtomic !== 'function') throw new Error('createLinkStore needs dir and writeJsonAtomic');
  const keyFile = path.join(dir, KEY_FILE);
  const loginsFile = path.join(dir, LOGINS_FILE);
  const modeFile = path.join(dir, MODE_FILE);
  fs.mkdirSync(dir, { recursive: true });

  // --- The sealing key --------------------------------------------------------
  let key = null;
  function sealKey() {
    if (key) return key;
    const d = readOwn(keyFile, log);
    const hex = d && typeof d.key === 'string' && /^[0-9a-f]{64}$/.test(d.key) ? d.key : null;
    if (hex) {
      // A key file restored or copied with a wider mode is narrowed again.
      try { fs.chmodSync(keyFile, 0o600); } catch { /* best effort on odd filesystems */ }
      key = Buffer.from(hex, 'hex');
      return key;
    }
    if (d) log.error(`[ads] ${KEY_FILE} holds no valid key; generating a new one (every link ends)`);
    const fresh = crypto.randomBytes(32);
    writeJsonAtomic(keyFile, { v: 1, key: fresh.toString('hex') }, 0o600);
    try { fs.chmodSync(keyFile, 0o600); } catch { /* best effort on odd filesystems */ }
    key = fresh;
    return key;
  }

  // --- Login records ------------------------------------------------------------
  let logins = null; // Map sha256(loginId) -> { exp, seal, rev }
  // rev counts link changes of a login id in this process (not stored). A link
  // that started before an unlink or another link commits only if rev is still
  // the one it read, so a slow upstream answer cannot undo a later change.
  function load() {
    if (logins) return logins;
    logins = new Map();
    const d = readOwn(loginsFile, log);
    const rows = d && d.logins && typeof d.logins === 'object' ? d.logins : {};
    for (const [h, r] of Object.entries(rows)) {
      if (!/^[0-9a-f]{64}$/.test(h) || !r || typeof r.exp !== 'number') continue;
      logins.set(h, { exp: r.exp, seal: typeof r.seal === 'string' && /^[0-9a-f]{64}$/.test(r.seal) ? r.seal : null, rev: 0 });
    }
    return logins;
  }
  function save() {
    const t = now();
    for (const [h, r] of logins) if (r.exp <= t) logins.delete(h);
    while (logins.size > MAX_LOGINS) logins.delete(logins.keys().next().value);
    const rows = {};
    for (const [h, r] of logins) rows[h] = { exp: r.exp, seal: r.seal };
    writeJsonAtomic(loginsFile, { v: 1, logins: rows }, 0o600);
  }
  // Change the records and write them, or change nothing: when the write
  // fails the memory goes back to what is on disk and the error is thrown, so
  // a revocation never answers success while the file still holds the record.
  function commit(mutate) {
    load();
    const before = new Map([...logins].map(([h, r]) => [h, { ...r }]));
    const out = mutate();
    try {
      save();
    } catch (e) {
      logins = before;
      throw e;
    }
    return out;
  }
  function recordOf(loginId) {
    if (typeof loginId !== 'string' || !ID_RE.test(loginId)) return null;
    const r = load().get(sha256(loginId));
    if (!r) return null;
    if (r.exp <= now()) return null;
    return r;
  }

  // A fresh login id for a password sign-in. Returns the id (the cookie value).
  function issueLogin() {
    const id = crypto.randomBytes(32).toString('base64url');
    commit(() => logins.set(sha256(id), { exp: now() + LOGIN_MS, seal: null, rev: 0 }));
    return id;
  }
  const loginValid = (loginId) => !!recordOf(loginId);
  function dropLogin(loginId) {
    if (typeof loginId !== 'string' || !ID_RE.test(loginId)) return false;
    if (!load().has(sha256(loginId))) return false;
    return commit(() => logins.delete(sha256(loginId)));
  }
  // The link revision of a login id, or null when it has no valid record.
  const revOf = (loginId) => {
    const r = recordOf(loginId);
    return r ? r.rev || 0 : null;
  };

  // --- Seals ----------------------------------------------------------------------
  // data: { t: upstream session token, u: upstream user id }. Replaces any
  // earlier seal of this login id (re-link). Returns the cookie value, null
  // when the login id is not valid, or false when expectRev is given and the
  // link changed since it was read (revOf).
  function seal(loginId, data, expectRev) {
    const r = recordOf(loginId);
    if (!r) return null;
    if (expectRev !== undefined && (r.rev || 0) !== expectRev) return false;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
    c.setAAD(Buffer.from(AAD_PREFIX + loginId, 'utf8'));
    const body = Buffer.concat([c.update(JSON.stringify({ t: String(data.t), u: data.u ?? null }), 'utf8'), c.final()]);
    const sealed = Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
    const h = sha256(loginId);
    commit(() => {
      const cur = logins.get(h);
      cur.seal = sha256(sealed);
      cur.rev = (cur.rev || 0) + 1;
    });
    return sealed;
  }
  // -> { t, u } or null. Null for: no or expired login record, a seal that is
  // not the one stored for this login id, a seal made for another login id
  // (AAD), any tampering.
  function open(loginId, sealed) {
    const r = recordOf(loginId);
    if (!r || !r.seal || typeof sealed !== 'string' || !sealed) return null;
    if (sha256(sealed) !== r.seal) return null;
    try {
      const raw = Buffer.from(sealed, 'base64url');
      if (raw.length < 29) return null;
      const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), raw.subarray(0, 12));
      d.setAAD(Buffer.from(AAD_PREFIX + loginId, 'utf8'));
      d.setAuthTag(raw.subarray(12, 28));
      const out = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
      return out && typeof out.t === 'string' && out.t ? out : null;
    } catch {
      return null;
    }
  }
  // Ends the link of a login id. With `expect` (the seal the caller saw) it
  // ends only that link: 'changed' when a newer link replaced it, which is
  // left alone. -> 'cleared' | 'none' (no link or no record) | 'changed'.
  // Every call without a newer link bumps rev, so a link still in flight from
  // before an unlink cannot commit afterwards.
  function clearSeal(loginId, expect) {
    const r = recordOf(loginId);
    if (!r) return 'none';
    if (expect !== undefined && r.seal && r.seal !== sha256(String(expect || ''))) return 'changed';
    r.rev = (r.rev || 0) + 1;
    if (!r.seal) return 'none';
    const h = sha256(loginId);
    commit(() => { logins.get(h).seal = null; });
    return 'cleared';
  }

  // --- Boot check -------------------------------------------------------------------
  // Compare the effective mode and the auth fingerprint with what was stored.
  // A different mode bumps the cache generation; either change drops every
  // login record. Returns { gen, dropped, reason }.
  function bootCheck({ mode, password, secret }) {
    const prev = readOwn(modeFile, log) || {};
    const fpOk = (() => {
      const a = prev.auth;
      // Hex of the lengths written below, so a damaged file cannot make the
      // compare throw at boot.
      if (!a || typeof a.salt !== 'string' || !/^[0-9a-f]{32}$/.test(a.salt) || typeof a.hash !== 'string' || !/^[0-9a-f]{64}$/.test(a.hash)) return false;
      const h = crypto.scryptSync(`${password || ''}\u0000${secret || ''}`, Buffer.from(a.salt, 'hex'), 32).toString('hex');
      return h.length === a.hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(a.hash));
    })();
    const prevGen = Number.isInteger(prev.gen) && prev.gen > 0 ? prev.gen : 0;
    const modeChanged = prev.mode !== mode;
    const gen = modeChanged || !prevGen ? prevGen + 1 : prevGen;
    const reasons = [];
    if (modeChanged) reasons.push(prev.mode ? `mode ${prev.mode} -> ${mode}` : 'no stored mode');
    if (!fpOk) reasons.push('Grabbit password or secret changed');
    let dropped = 0;
    if (reasons.length) {
      dropped = load().size;
      commit(() => logins.clear());
    }
    let auth = prev.auth;
    if (!fpOk) {
      const salt = crypto.randomBytes(16);
      auth = { salt: salt.toString('hex'), hash: crypto.scryptSync(`${password || ''}\u0000${secret || ''}`, salt, 32).toString('hex') };
    }
    if (modeChanged || !fpOk || gen !== prevGen) writeJsonAtomic(modeFile, { v: 1, mode, gen, auth }, 0o600);
    return { gen, dropped, reason: reasons.join('; ') || null };
  }

  return { issueLogin, loginValid, dropLogin, revOf, seal, open, clearSeal, bootCheck, sealKey, files: { keyFile, loginsFile, modeFile } };
}

module.exports = { createLinkStore, LOGIN_DAYS, KEY_FILE, LOGINS_FILE, MODE_FILE, sha256 };
