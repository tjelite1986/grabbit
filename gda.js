'use strict';
// Grabbit Download API (GDA) v1: the client registry, the targets a client may
// save to, and the checks that keep each app inside its own scope.
//
// Before GDA every app logged in with the one shared password and could save
// anywhere, 18+ included, and nothing recorded which app had sent what. Now each
// app can get a password (or a bearer token) of its own. That credential names a
// client in the registry, the client names its audience and its targets, and
// every job is checked against them before anything touches the filesystem.
//
// The shared password keeps working exactly as before, as the `legacy-shared`
// client with full access, so an app nobody has reconfigured keeps working.
// Moving an app is a settings change on the device, never a rebuild.
//
// Nothing here takes a path from the client: a target is a name, and the server
// owns the mapping from that name to Grabbit's existing dest/channel/folder.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The audiences a client or a target belongs to. `admin` is the owner's web UI
// and the shared password; it is never a target audience.
const AUDIENCES = ['general', 'adult', 'admin'];
const OPS = ['job', 'status'];

// Each target is what Grabbit already does for one dest/channel/folder choice.
// The mapping changes no behaviour: a v1 job and a legacy job for the same
// target end up as the same internal job. Side routes that exist today stay
// part of their target: a `legacy.tikshortis` save of a photo post still lands
// in Elitogram's drop folder, and a clip over SHORTS_MAX_DURATION still goes to
// the server library, exactly as a legacy `dest=elite&channel=main` job would.
const TARGETS = {
  'legacy.tikshortis': {
    audience: 'general',
    label: 'Tikshortis (main shorts)',
    legacy: { dest: 'elite', channel: 'main' },
  },
  'adshortis.inbox': {
    audience: 'adult',
    label: 'Adshortis (18+ shorts)',
    legacy: { dest: 'elite', channel: '18plus' },
  },
  'server.downloads': {
    audience: 'general',
    label: 'Server download library',
    legacy: { dest: 'server' },
  },
  'library.adults': {
    audience: 'adult',
    label: '18+ film library',
    legacy: { dest: 'server', folder: 'adults' },
  },
  'library.music': {
    audience: 'general',
    label: 'Music library (Navidrome)',
    legacy: { dest: 'navidrome' },
  },
  'library.audiobooks': {
    audience: 'general',
    label: 'Audiobook library',
    legacy: { dest: 'audiobooks' },
  },
};

// The target a legacy request resolves to, from the dest/channel/folder that
// server.js has already parsed. The server's own folder name is compared after
// the same sanitizing server.js applies, so `folder=Adults` and `folder=adults!`
// cannot slip past as something other than the 18+ library.
function targetForLegacy({ dest, channel, folder }) {
  if (dest === 'elite') return channel === '18plus' ? 'adshortis.inbox' : 'legacy.tikshortis';
  if (dest === 'navidrome') return 'library.music';
  if (dest === 'audiobooks') return 'library.audiobooks';
  const f = String(folder || '')
    .replace(/[^a-zA-Z0-9 _-]+/g, '')
    .replace(/^[ ._-]+|[ ._-]+$/g, '')
    .toLowerCase();
  return f === 'adults' ? 'library.adults' : 'server.downloads';
}

// ---------------------------------------------------------------------------
// Errors in the v1 envelope: { ok:false, error:{ code, message, retryable } }.
const ERRORS = {
  unauthorized: [401, 'Sign in first.', false],
  token_revoked: [401, 'This token has been revoked.', false],
  forbidden_target: [403, 'This app may not save to that target.', false],
  forbidden_op: [403, 'This app may not do that.', false],
  unknown_target: [422, 'No such target.', false],
  invalid_request: [400, 'The request is not valid.', false],
  not_found: [404, 'No such job.', false],
  rate_limited: [429, 'Too many attempts. Try again later.', true],
};

class GdaError extends Error {
  constructor(code, message) {
    const [status, fallback, retryable] = ERRORS[code] || [500, 'Internal error', true];
    super(message || fallback);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
  toJSON() {
    return { ok: false, error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

// ---------------------------------------------------------------------------
// Passwords: scrypt with a per-client salt, stored as "scrypt$<salt>$<hash>".
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifySecret(secret, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(secret), Buffer.from(parts[1], 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Generated secrets avoid characters that are hard to type on a phone keyboard.
function generatePassword() {
  return crypto.randomBytes(9).toString('hex').match(/.{6}/g).join('-');
}

// ---------------------------------------------------------------------------
// Registry validation. A client that breaks the audience rule is refused at load
// time, not only at request time, so a hand-edited file cannot quietly grant a
// general app an 18+ target.
const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const RESERVED_IDS = new Set(['legacy-shared', 'internal', 'admin']);

function validateClient(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (!CLIENT_ID_RE.test(String(c.client_id || ''))) problems.push('client_id must be 2-40 of [a-z0-9-]');
  if (RESERVED_IDS.has(c.client_id)) problems.push(`client_id ${c.client_id} is reserved`);
  if (!['general', 'adult'].includes(c.audience)) problems.push('audience must be general or adult');
  if (!Array.isArray(c.allowed_targets) || !c.allowed_targets.length) problems.push('allowed_targets is empty');
  for (const t of c.allowed_targets || []) {
    if (!TARGETS[t]) problems.push(`unknown target ${t}`);
    else if (TARGETS[t].audience !== c.audience) problems.push(`target ${t} is ${TARGETS[t].audience}, client is ${c.audience}`);
  }
  if (!Array.isArray(c.allowed_ops) || c.allowed_ops.some((o) => !OPS.includes(o))) problems.push('allowed_ops invalid');
  if (c.legacy_main_target != null && !(c.allowed_targets || []).includes(c.legacy_main_target)) {
    problems.push('legacy_main_target is not one of allowed_targets');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The registry lives in DATA_DIR (Pi-local disk, never NFS) as one JSON file
// written atomically. It is small and read on every login, so it is cached and
// re-read when the file changes on disk (the admin CLI writes it from another
// process).
function createRegistry({ file, sessionSecret, log = console }) {
  let cache = null;
  let cacheMtime = -1;
  const lastSeen = new Map(); // in memory only: one write per request would wear the disk

  function load() {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      cache = [];
      cacheMtime = -1;
      return cache;
    }
    if (cache && st.mtimeMs === cacheMtime) return cache;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // A broken file must not open anything up: no client loads, the shared
      // password still works, and the log says why.
      log.error(`gda: registry ${file} unreadable (${e.message}); no app clients loaded`);
      cache = [];
      cacheMtime = st.mtimeMs;
      return cache;
    }
    const list = Array.isArray(raw && raw.clients) ? raw.clients : [];
    cache = [];
    for (const c of list) {
      const problems = validateClient(c);
      if (problems.length) {
        log.error(`gda: client ${c && c.client_id} refused: ${problems.join('; ')}`);
        continue;
      }
      cache.push(c);
    }
    cacheMtime = st.mtimeMs;
    return cache;
  }

  function readRaw() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(raw && raw.clients) ? raw : { clients: [] };
    } catch (e) {
      if (e.code === 'ENOENT') return { clients: [] };
      throw e;
    }
  }

  function save(raw) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Same rule as writeJsonAtomic in server.js (temp in the same dir, fsync,
    // rename), with a temp name of its own: the admin CLI writes from another
    // process while the server may be running.
    const tmp = `${file}.tmp-gda-${process.pid}-${Date.now()}`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(raw, null, 2) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw e;
    }
    cache = null;
  }

  const active = (c) => c && !c.revoked_at;
  const byId = (id) => load().find((c) => c.client_id === id && active(c)) || null;

  // A legacy login: the password picks the client. Every active client with a
  // password is tried, so the time taken does not say which one matched.
  function clientForPassword(password) {
    let found = null;
    for (const c of load()) {
      if (!active(c) || !c.secret_hash) continue;
      if (verifySecret(password, c.secret_hash) && !found) found = c;
    }
    return found;
  }

  // The session cookie of an app client: "gda1.<clientId>.<mac>". The MAC covers
  // the client's current password hash, so setting a new password ends every
  // session made with the old one, and revoking the client ends them all.
  function sessionValue(c) {
    const mac = crypto
      .createHmac('sha256', sessionSecret)
      .update(`gda-session-v1|${c.client_id}|${c.secret_hash}`)
      .digest('hex');
    return `gda1.${c.client_id}.${mac}`;
  }

  function clientForSession(value) {
    const m = /^gda1\.([a-z0-9-]{2,40})\.([0-9a-f]{64})$/.exec(String(value || ''));
    if (!m) return null;
    const c = byId(m[1]);
    if (!c || !c.secret_hash) return null;
    return safeEqualHex(sessionValue(c), value) ? c : null;
  }

  // Bearer token "gda_<clientId>_<random>". Stored as SHA-256 only.
  // Returns { client } or { revoked:true } or null.
  function clientForToken(token) {
    const m = /^gda_([a-z0-9-]{2,40})_([A-Za-z0-9_-]{32,})$/.exec(String(token || ''));
    if (!m) return null;
    const c = load().find((x) => x.client_id === m[1]);
    if (!c) return null;
    const h = sha256(token);
    const rec = (c.tokens || []).find((t) => safeEqualHex(t.sha256, h));
    if (!rec) return null;
    if (rec.revoked_at || c.revoked_at) return { revoked: true };
    return { client: c, tokenId: rec.id };
  }

  function touch(clientId) {
    lastSeen.set(clientId, new Date().toISOString());
  }

  // --- admin operations (CLI) ---------------------------------------------
  function upsertClient(fields) {
    const raw = readRaw();
    const now = new Date().toISOString();
    const idx = raw.clients.findIndex((c) => c.client_id === fields.client_id);
    const prev = idx >= 0 ? raw.clients[idx] : { created_at: now, tokens: [], secret_hash: null, revoked_at: null };
    const next = { ...prev, ...fields };
    const problems = validateClient(next);
    if (problems.length) throw new Error(problems.join('; '));
    if (idx >= 0) raw.clients[idx] = next;
    else raw.clients.push(next);
    save(raw);
    return next;
  }

  function mutate(clientId, fn) {
    const raw = readRaw();
    const c = raw.clients.find((x) => x.client_id === clientId);
    if (!c) throw new Error(`no client ${clientId}`);
    const out = fn(c);
    save(raw);
    return out;
  }

  function setPassword(clientId, password = generatePassword()) {
    mutate(clientId, (c) => {
      c.secret_hash = hashSecret(password);
      c.password_set_at = new Date().toISOString();
    });
    return password;
  }

  function issueToken(clientId) {
    const token = `gda_${clientId}_${crypto.randomBytes(24).toString('base64url')}`;
    const id = crypto.randomBytes(4).toString('hex');
    mutate(clientId, (c) => {
      c.tokens = c.tokens || [];
      c.tokens.push({ id, sha256: sha256(token), created_at: new Date().toISOString(), revoked_at: null });
    });
    return { id, token };
  }

  function revokeToken(clientId, tokenId) {
    mutate(clientId, (c) => {
      const t = (c.tokens || []).find((x) => x.id === tokenId);
      if (!t) throw new Error(`no token ${tokenId}`);
      t.revoked_at = new Date().toISOString();
    });
  }

  function revokeClient(clientId) {
    mutate(clientId, (c) => {
      c.revoked_at = new Date().toISOString();
    });
  }

  function list() {
    return readRaw().clients.map((c) => ({
      client_id: c.client_id,
      display_name: c.display_name,
      audience: c.audience,
      allowed_targets: c.allowed_targets,
      allowed_ops: c.allowed_ops,
      legacy_main_target: c.legacy_main_target ?? null,
      has_password: !!c.secret_hash,
      tokens: (c.tokens || []).map((t) => ({ id: t.id, created_at: t.created_at, revoked_at: t.revoked_at })),
      revoked_at: c.revoked_at || null,
      last_seen_at: lastSeen.get(c.client_id) || null,
      problems: validateClient(c),
    }));
  }

  return {
    load,
    byId,
    clientForPassword,
    sessionValue,
    clientForSession,
    clientForToken,
    touch,
    lastSeen: (id) => lastSeen.get(id) || null,
    upsertClient,
    setPassword,
    issueToken,
    revokeToken,
    revokeClient,
    list,
  };
}

// ---------------------------------------------------------------------------
// Callers. `principal` is what a request is acting as:
//   { id:'legacy-shared', audience:'admin' }   shared password (web UI, old app settings)
//   { id:'internal', audience:'admin' }        co-hosted service with X-Grabbit-Token
//   { id:'<client>', audience, client }        an app with its own password or token
const LEGACY_SHARED = Object.freeze({ id: 'legacy-shared', audience: 'admin', kind: 'shared' });
const INTERNAL = Object.freeze({ id: 'internal', audience: 'admin', kind: 'internal' });

function principalFor(client, kind) {
  return { id: client.client_id, audience: client.audience, kind, client };
}

// The scope check. Audience first, in code, independent of the list: a general
// client never reaches an adult target even if the registry says it may.
function authorize(principal, targetId, op) {
  const t = TARGETS[targetId];
  if (!t) throw new GdaError('unknown_target');
  if (!principal) throw new GdaError('unauthorized');
  if (principal.audience === 'admin') return t;
  if (principal.audience !== t.audience) throw new GdaError('forbidden_target');
  const c = principal.client;
  if (!c.allowed_ops.includes(op)) throw new GdaError('forbidden_op');
  if (!c.allowed_targets.includes(targetId)) throw new GdaError('forbidden_target');
  return t;
}

// Targets a principal may use, for /api/v1/targets and /whoami.
function targetsFor(principal) {
  return Object.entries(TARGETS)
    .filter(([id, t]) =>
      principal.audience === 'admin'
        ? true
        : t.audience === principal.audience && principal.client.allowed_targets.includes(id),
    )
    .map(([id, t]) => ({ id, audience: t.audience, label: t.label }));
}

// Grabbit job status -> GDA status.
function v1Status(job) {
  switch (job.status) {
    case 'scheduled':
    case 'queued':
      return 'queued';
    case 'running':
      return 'fetching';
    case 'done':
      return job.saved ? 'stored' : 'delivered';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

// Idempotency-Key memory: (client, key) -> jobId, for 24 h. Kept in memory like
// the jobs themselves; a restart forgets both together.
function createIdempotency({ ttlMs = 24 * 3600 * 1000, max = 5000 } = {}) {
  const map = new Map();
  return {
    get(clientId, key) {
      const k = `${clientId}\u0000${key}`;
      const rec = map.get(k);
      if (!rec) return null;
      if (Date.now() - rec.at > ttlMs) {
        map.delete(k);
        return null;
      }
      return rec.jobId;
    },
    set(clientId, key, jobId) {
      map.set(`${clientId}\u0000${key}`, { jobId, at: Date.now() });
      while (map.size > max) map.delete(map.keys().next().value);
    },
  };
}

module.exports = {
  AUDIENCES,
  OPS,
  TARGETS,
  ERRORS,
  GdaError,
  LEGACY_SHARED,
  INTERNAL,
  targetForLegacy,
  validateClient,
  hashSecret,
  verifySecret,
  generatePassword,
  createRegistry,
  principalFor,
  authorize,
  targetsFor,
  v1Status,
  createIdempotency,
};
