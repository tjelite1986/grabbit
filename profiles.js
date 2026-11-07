'use strict';
// Grabbit 2.0 profile store: one creator profile holds many platform accounts
// (TikTok, Instagram, Facebook, ...) and the creator names that appear in
// downloaded file names (aliases). Pure functions over a plain object; the
// server reads and writes it as profiles.json. Nothing here touches files on
// disk or the downloaded registry.
//
// Rules, each one a promise to the owner:
// - A file name's creator is never lost. Every alias seen in the registry
//   belongs to exactly one profile. Aliases are only ever moved (merge, split),
//   never removed, so the link filename -> creator -> profile always resolves.
// - General and adult never mix. An alias is keyed by audience + name, the
//   audience coming from the registry channel (`18plus` is adult, everything
//   else general). The same name in both channels makes two profiles, and a
//   merge across audiences is refused. A manually created profile must name its
//   audience; there is no default, because the default would be a permission.
// - Source info is kept. Each account records where it came from (`manual`,
//   or the importer that will add it later) and when; a merge keeps every
//   account, and each profile remembers the ids merged into it.

const hub = require('./hub');

const VERSION = 1;
const AUDIENCES = ['general', 'adult'];
const LOG_MAX = 1000;
const LIMITS = { name: 100, note: 1000, handle: 100, url: 2000, platform: 30, accounts: 50 };
// Platforms the UI offers. Any lowercase slug is accepted so a new site needs no code change.
const PLATFORMS = ['tiktok', 'instagram', 'facebook', 'youtube', 'x', 'reddit', 'snapchat', 'twitch', 'other'];

class ProfileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new ProfileError(400, msg);

function emptyStore() {
  return { version: VERSION, nextId: 1, profiles: [], log: [] };
}

const audienceOfChannel = (channel) => (channel === '18plus' ? 'adult' : 'general');
const aliasKey = (audience, name) => `${audience}:${String(name).toLowerCase()}`;
const accountKey = (a) => `${a.platform}:${a.handle.toLowerCase()}`;

// Control characters and surrounding space out; length capped.
function cleanText(v, max, field, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !s) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is longer than ${max} characters`);
  return s;
}

function cleanAccount(raw, now) {
  if (!raw || typeof raw !== 'object') throw bad('an account must be an object');
  const platform = cleanText(raw.platform, LIMITS.platform, 'platform', { required: true }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(platform)) throw bad('platform must be a lowercase name such as tiktok');
  const handle = cleanText(raw.handle, LIMITS.handle, 'handle', { required: true }).replace(/^@+/, '');
  if (!handle) throw bad('handle is required');
  let url = cleanText(raw.url, LIMITS.url, 'url') || null;
  if (url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw bad('url is not a valid address');
    }
    // Only web links, so an edited profile cannot carry a javascript: link.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('url must start with https://');
    url = u.href;
  }
  const source = raw.source === undefined ? 'manual' : cleanText(raw.source, 40, 'source', { required: true });
  const addedAt = Number.isFinite(raw.addedAt) ? raw.addedAt : now;
  return { platform, handle, url, source, addedAt };
}

// A stored file read back in. Anything malformed is a bug or hand-editing,
// and refusing to start beats silently dropping a profile.
function normalizeStore(raw) {
  if (raw === null || raw === undefined) return emptyStore();
  if (typeof raw !== 'object' || !Array.isArray(raw.profiles)) throw new Error('profiles.json: not a profile store');
  const store = {
    version: VERSION,
    nextId: Number.isInteger(raw.nextId) && raw.nextId > 0 ? raw.nextId : 1,
    profiles: raw.profiles.map((p) => ({
      id: p.id,
      name: String(p.name || ''),
      audience: p.audience,
      note: String(p.note || ''),
      accounts: Array.isArray(p.accounts) ? p.accounts : [],
      aliases: Array.isArray(p.aliases) ? p.aliases : [],
      mergedFrom: Array.isArray(p.mergedFrom) ? p.mergedFrom : [],
      origin: p.origin || 'manual',
      createdAt: Number(p.createdAt) || 0,
      updatedAt: Number(p.updatedAt) || 0,
    })),
    log: Array.isArray(raw.log) ? raw.log.slice(-LOG_MAX) : [],
  };
  for (const p of store.profiles) if (Number.isInteger(p.id) && p.id >= store.nextId) store.nextId = p.id + 1;
  const problems = check(store);
  if (problems.length) throw new Error(`profiles.json: ${problems.join('; ')}`);
  return store;
}

// The invariants. Returns a list of problems; empty means sound.
function check(store) {
  const problems = [];
  const ids = new Set();
  const aliases = new Map();
  const accounts = new Map();
  for (const p of store.profiles) {
    if (!Number.isInteger(p.id) || p.id < 1) problems.push(`bad id ${p.id}`);
    if (ids.has(p.id)) problems.push(`duplicate id ${p.id}`);
    ids.add(p.id);
    if (!AUDIENCES.includes(p.audience)) problems.push(`profile ${p.id} has no audience`);
    if (!p.name) problems.push(`profile ${p.id} has no name`);
    for (const a of p.aliases) {
      const k = aliasKey(p.audience, a.name);
      if (aliases.has(k)) problems.push(`alias ${k} is in profiles ${aliases.get(k)} and ${p.id}`);
      aliases.set(k, p.id);
    }
    for (const a of p.accounts) {
      const k = accountKey(a);
      if (accounts.has(k)) problems.push(`account ${k} is in profiles ${accounts.get(k)} and ${p.id}`);
      accounts.set(k, p.id);
    }
  }
  return problems;
}

// What the registry knows per alias: { 'general:name' -> { audience, name, files, sites, lastAt } }.
// Files are counted once by filename, as in hub.summarize.
function aliasStats(registry) {
  const out = new Map();
  const seen = new Set();
  for (const [key, entry] of Object.entries(registry || {})) {
    const filename = entry && entry.filename;
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    const name = hub.creatorOf(filename);
    if (!name) continue;
    const audience = audienceOfChannel(entry.channel);
    const k = aliasKey(audience, name);
    let s = out.get(k);
    if (!s) out.set(k, (s = { audience, name, files: 0, sites: new Set(), lastAt: 0 }));
    s.files++;
    s.sites.add(hub.siteOf(key));
    s.lastAt = Math.max(s.lastAt, Number(entry.at) || 0);
  }
  return out;
}

function logEntry(store, now, action, detail) {
  store.log.push({ at: now, action, ...detail });
  if (store.log.length > LOG_MAX) store.log.splice(0, store.log.length - LOG_MAX);
}

const clone = (store) => JSON.parse(JSON.stringify(store));

function indexAliases(store) {
  const m = new Map();
  for (const p of store.profiles) for (const a of p.aliases) m.set(aliasKey(p.audience, a.name), p.id);
  return m;
}

// Gives every alias the registry knows and no profile holds a profile of its
// own. Existing profiles are never changed. Returns the same store object when
// nothing was added, so the caller can skip the write.
function sync(store, stats, now) {
  const have = indexAliases(store);
  const missing = [...stats.entries()].filter(([k]) => !have.has(k));
  if (!missing.length) return { store, added: 0 };
  const next = clone(store);
  // Oldest activity first, so ids follow the order creators first appeared.
  missing.sort((a, b) => a[1].lastAt - b[1].lastAt || a[0].localeCompare(b[0]));
  for (const [, s] of missing) {
    next.profiles.push({
      id: next.nextId++,
      name: s.name,
      audience: s.audience,
      note: '',
      accounts: [],
      aliases: [{ name: s.name, addedAt: now }],
      mergedFrom: [],
      origin: 'registry',
      createdAt: now,
      updatedAt: now,
    });
  }
  logEntry(next, now, 'sync', { added: missing.length });
  return { store: next, added: missing.length };
}

function findProfile(store, id) {
  const n = Number(id);
  const p = Number.isInteger(n) ? store.profiles.find((x) => x.id === n) : null;
  if (!p) throw new ProfileError(404, 'No such profile');
  return p;
}

// Accounts for one profile, checked against every other profile.
function cleanAccounts(store, list, ownerId, now) {
  if (!Array.isArray(list)) throw bad('accounts must be a list');
  if (list.length > LIMITS.accounts) throw bad(`at most ${LIMITS.accounts} accounts per profile`);
  const taken = new Map();
  for (const p of store.profiles) if (p.id !== ownerId) for (const a of p.accounts) taken.set(accountKey(a), p);
  const out = [];
  const mine = new Set();
  for (const raw of list) {
    const a = cleanAccount(raw, now);
    const k = accountKey(a);
    if (mine.has(k)) throw bad(`${a.platform} @${a.handle} is listed twice`);
    const other = taken.get(k);
    if (other) throw new ProfileError(409, `${a.platform} @${a.handle} already belongs to profile "${other.name}" (#${other.id}); merge the two instead`);
    mine.add(k);
    out.push(a);
  }
  return out;
}

function create(store, input, now) {
  input = input || {};
  const name = cleanText(input.name, LIMITS.name, 'name', { required: true });
  if (!AUDIENCES.includes(input.audience)) throw bad('audience must be general or adult');
  const next = clone(store);
  const p = {
    id: next.nextId++,
    name,
    audience: input.audience,
    note: cleanText(input.note, LIMITS.note, 'note'),
    accounts: [],
    aliases: [],
    mergedFrom: [],
    origin: 'manual',
    createdAt: now,
    updatedAt: now,
  };
  p.accounts = cleanAccounts(next, input.accounts || [], p.id, now);
  next.profiles.push(p);
  logEntry(next, now, 'create', { id: p.id });
  return { store: next, profile: p };
}

// Edits name, note and accounts. Aliases and audience are not editable here:
// an alias moves only by merge or split, and the audience is fixed.
function update(store, id, input, now) {
  input = input || {};
  if ('audience' in input) throw bad('the audience of a profile cannot be changed');
  if ('aliases' in input) throw bad('aliases move only by merge or split');
  const next = clone(store);
  const p = findProfile(next, id);
  if ('name' in input) p.name = cleanText(input.name, LIMITS.name, 'name', { required: true });
  if ('note' in input) p.note = cleanText(input.note, LIMITS.note, 'note');
  if ('accounts' in input) {
    // An account that is kept keeps its original source and date.
    const before = new Map(p.accounts.map((a) => [accountKey(a), a]));
    p.accounts = cleanAccounts(next, input.accounts, p.id, now).map((a) => {
      const old = before.get(accountKey(a));
      return old ? { ...a, source: old.source, addedAt: old.addedAt } : a;
    });
  }
  p.updatedAt = now;
  logEntry(next, now, 'update', { id: p.id });
  return { store: next, profile: p };
}

// Moves every alias and account of `sourceIds` into `targetId` and removes the
// emptied source profiles. The target keeps its own name.
function merge(store, targetId, sourceIds, now) {
  if (!Array.isArray(sourceIds) || !sourceIds.length) throw bad('choose at least one profile to merge in');
  const next = clone(store);
  const target = findProfile(next, targetId);
  const sources = [...new Set(sourceIds.map(Number))].map((id) => findProfile(next, id));
  if (sources.some((s) => s.id === target.id)) throw bad('a profile cannot be merged into itself');
  for (const s of sources) {
    if (s.audience !== target.audience) {
      throw new ProfileError(409, `"${s.name}" is ${s.audience} and "${target.name}" is ${target.audience}; general and adult profiles are never merged`);
    }
  }
  if (target.accounts.length + sources.reduce((n, s) => n + s.accounts.length, 0) > LIMITS.accounts) {
    throw bad(`the merged profile would have more than ${LIMITS.accounts} accounts`);
  }
  for (const s of sources) {
    target.aliases.push(...s.aliases);
    target.accounts.push(...s.accounts);
    target.mergedFrom.push(s.id, ...s.mergedFrom);
    if (s.note && !target.note.includes(s.note)) target.note = `${target.note}\n${s.note}`.trim().slice(0, LIMITS.note);
  }
  const gone = new Set(sources.map((s) => s.id));
  next.profiles = next.profiles.filter((p) => !gone.has(p.id));
  target.updatedAt = now;
  logEntry(next, now, 'merge', { id: target.id, merged: [...gone] });
  const problems = check(next);
  if (problems.length) throw new Error(`merge broke the store: ${problems.join('; ')}`);
  return { store: next, profile: target };
}

// Moves the chosen aliases and accounts of one profile into a new profile of
// the same audience. Both halves must hold something afterwards, so a split
// can never leave an alias without a profile or make an empty copy.
function split(store, id, input, now) {
  input = input || {};
  const name = cleanText(input.name, LIMITS.name, 'name', { required: true });
  const pickAliases = new Set((Array.isArray(input.aliases) ? input.aliases : []).map((a) => String(a).toLowerCase()));
  const pickAccounts = new Set((Array.isArray(input.accounts) ? input.accounts : []).map((a) => String(a).toLowerCase()));
  if (!pickAliases.size && !pickAccounts.size) throw bad('choose the aliases or accounts to move');
  const next = clone(store);
  const from = findProfile(next, id);
  const moveAliases = from.aliases.filter((a) => pickAliases.has(a.name.toLowerCase()));
  const moveAccounts = from.accounts.filter((a) => pickAccounts.has(accountKey(a)));
  if (moveAliases.length !== pickAliases.size || moveAccounts.length !== pickAccounts.size) {
    throw bad('some of the chosen aliases or accounts are not in this profile');
  }
  const keepAliases = from.aliases.filter((a) => !moveAliases.includes(a));
  const keepAccounts = from.accounts.filter((a) => !moveAccounts.includes(a));
  if (!keepAliases.length && !keepAccounts.length) throw bad('a split must leave something in the original profile; rename it instead');
  const p = {
    id: next.nextId++,
    name,
    audience: from.audience,
    note: '',
    accounts: moveAccounts,
    aliases: moveAliases,
    mergedFrom: [],
    origin: `split:${from.id}`,
    createdAt: now,
    updatedAt: now,
  };
  from.aliases = keepAliases;
  from.accounts = keepAccounts;
  from.updatedAt = now;
  next.profiles.push(p);
  logEntry(next, now, 'split', { id: from.id, into: p.id, aliases: moveAliases.length, accounts: moveAccounts.length });
  const problems = check(next);
  if (problems.length) throw new Error(`split broke the store: ${problems.join('; ')}`);
  return { store: next, profile: p, from };
}

// A profile with what the registry says about its aliases.
function view(p, stats) {
  let files = 0;
  let lastAt = 0;
  const sites = new Set();
  const aliases = p.aliases.map((a) => {
    const s = stats.get(aliasKey(p.audience, a.name));
    if (s) {
      files += s.files;
      lastAt = Math.max(lastAt, s.lastAt);
      s.sites.forEach((x) => sites.add(x));
    }
    return { name: a.name, files: s ? s.files : 0, lastAt: (s && s.lastAt) || null };
  });
  return {
    id: p.id,
    name: p.name,
    audience: p.audience,
    note: p.note,
    origin: p.origin,
    accounts: p.accounts,
    aliases,
    mergedFrom: p.mergedFrom,
    files,
    sites: [...sites].sort(),
    lastAt: lastAt || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function list(store, stats, { q = '', audience = '', limit = 200 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const all = store.profiles
    .filter((p) => !audience || p.audience === audience)
    .filter((p) => !needle
      || p.name.toLowerCase().includes(needle)
      || p.aliases.some((a) => a.name.toLowerCase().includes(needle))
      || p.accounts.some((a) => a.handle.toLowerCase().includes(needle)))
    .map((p) => view(p, stats))
    .sort((a, b) => b.files - a.files || (b.lastAt || 0) - (a.lastAt || 0) || a.id - b.id);
  return {
    total: all.length,
    counts: {
      general: store.profiles.filter((p) => p.audience === 'general').length,
      adult: store.profiles.filter((p) => p.audience === 'adult').length,
      linked: store.profiles.filter((p) => p.accounts.length).length,
    },
    items: all.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200))),
  };
}

module.exports = {
  VERSION, AUDIENCES, PLATFORMS, LIMITS, ProfileError,
  emptyStore, normalizeStore, check, aliasStats, audienceOfChannel, aliasKey, accountKey,
  sync, create, update, merge, split, view, list, findProfile,
};
