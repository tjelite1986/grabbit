'use strict';
// Grabbit 2.0 item store: one row per downloaded item and one per delivery
// into an app, in SQLite (WAL). Profiles, rules and the downloaded registry
// stay in their JSON files; this store only reads the registry and never
// writes to any of them.
//
// Rules, each one a promise to the owner:
// - Migrations never lose rows. An existing database is copied (VACUUM INTO)
//   before its schema changes, and every migration runs in one transaction.
// - A database newer than this code is refused, not downgraded.
// - The audience of an item never drops from adult, and an item that is not
//   general can never get a "dropped" delivery into a general app. Both rules
//   are triggers, so they hold for any code path that reaches the database.
// - The registry import is additive and read-only: it inserts what is
//   missing and never changes an item it already has, except to tighten its
//   audience.

const fs = require('fs');
const path = require('path');

const GENERAL_DESTINATIONS = ['main', 'platform', 'posts'];
const ADULT_DESTINATIONS = ['18plus'];
const DELIVERY_STATUSES = ['dropped', 'taken', 'refused', 'failed'];

const q = (list) => list.map((v) => `'${v}'`).join(', ');

// Each entry moves the schema from version index to index + 1.
const MIGRATIONS = [
  `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    site TEXT,
    source_id TEXT,
    source_url TEXT,
    kind TEXT CHECK (kind IN ('video', 'image', 'audio') OR kind IS NULL),
    audience TEXT NOT NULL DEFAULT 'unknown' CHECK (audience IN ('general', 'adult', 'unknown')),
    audience_reasons TEXT,
    profile_id INTEGER,
    creator TEXT,
    title TEXT,
    filename TEXT,
    sha256 TEXT,
    bytes INTEGER,
    origin TEXT NOT NULL CHECK (origin IN ('registry', 'save')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX items_sha256 ON items (sha256) WHERE sha256 IS NOT NULL;
  CREATE INDEX items_filename ON items (filename) WHERE filename IS NOT NULL;

  CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items (id),
    destination TEXT NOT NULL CHECK (destination IN (${q([...GENERAL_DESTINATIONS, ...ADULT_DESTINATIONS])})),
    status TEXT NOT NULL CHECK (status IN (${q(DELIVERY_STATUSES)})),
    filename TEXT,
    detail TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX deliveries_item ON deliveries (item_id, destination);

  CREATE TRIGGER items_audience_never_lowered
  BEFORE UPDATE OF audience ON items
  WHEN OLD.audience = 'adult' AND NEW.audience <> 'adult'
  BEGIN
    SELECT RAISE(ABORT, 'the audience of an 18+ item cannot be lowered');
  END;

  CREATE TRIGGER deliveries_general_needs_general_item
  BEFORE INSERT ON deliveries
  WHEN NEW.status IN ('dropped', 'taken')
    AND NEW.destination IN (${q(GENERAL_DESTINATIONS)})
    AND (SELECT audience FROM items WHERE id = NEW.item_id) IS NOT 'general'
  BEGIN
    SELECT RAISE(ABORT, 'an item that is not classified general cannot be delivered to a general app');
  END;

  CREATE TRIGGER deliveries_adult_takes_no_images
  BEFORE INSERT ON deliveries
  WHEN NEW.status IN ('dropped', 'taken')
    AND NEW.destination IN (${q(ADULT_DESTINATIONS)})
    AND (SELECT kind FROM items WHERE id = NEW.item_id) = 'image'
  BEGIN
    SELECT RAISE(ABORT, 'the 18+ app takes videos only');
  END;
  `,
];
const SCHEMA_VERSION = MIGRATIONS.length;

class StoreError extends Error {}

// Opens (or creates) the store. `Database` is injectable for tests; the
// server passes nothing and gets better-sqlite3.
function open(file, opts = {}) {
  return openWith(MIGRATIONS, file, opts);
}

function openWith(migrations, file, { Database = require('better-sqlite3'), now = Date.now } = {}) {
  const existed = fs.existsSync(file);
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const backup = migrate(db, migrations, file, existed, now);
    return wrap(db, backup);
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
}

function migrate(db, migrations, file, existed, now) {
  const target = migrations.length;
  const version = db.pragma('user_version', { simple: true });
  if (version > target) {
    throw new StoreError(
      `${path.basename(file)} has schema version ${version}, newer than this Grabbit (${target}). ` +
      'Refusing to open it; run the newer version or restore a backup.'
    );
  }
  if (version === target) return null;
  let backup = null;
  if (existed && version > 0) {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    backup = `${file}.pre-v${target}-${stamp}`;
    db.prepare('VACUUM INTO ?').run(backup);
  }
  db.transaction(() => {
    for (let v = version; v < target; v++) db.exec(migrations[v]);
    db.pragma(`user_version = ${target}`);
  })();
  return backup;
}

// The registry's audience for a channel. Only the 18+ channel says anything:
// a save into a general app is a delivery, not a classification, so every
// other channel (and the plain server library) leaves the item unknown.
function audienceOfRegistryChannel(channel) {
  return channel === '18plus' ? 'adult' : 'unknown';
}

// The item key for a registry key: the site-native id key when there is one
// (`id:<site>:<id>`, `yt:<id>`), else the URL key.
function siteOfKey(key) {
  if (key.startsWith('id:')) return key.split(':')[1] || null;
  if (key.startsWith('yt:')) return 'youtube';
  return null;
}
function sourceIdOfKey(key) {
  if (key.startsWith('id:')) return key.split(':').slice(2).join(':') || null;
  if (key.startsWith('yt:')) return key.slice(3) || null;
  return null;
}

// Groups the registry's keys into items. A save writes the same entry under
// its URL key and its id key, so a URL key whose (filename, at) matches an id
// key is the same item.
function registryItems(registry) {
  const byEntry = new Map();
  const items = [];
  const ident = (e) => `${e.filename || ''}\u0000${Number(e.at) || 0}`;
  const keys = Object.keys(registry || {});
  const isId = (k) => k.startsWith('id:') || k.startsWith('yt:');
  for (const k of keys.filter(isId).concat(keys.filter((k) => !isId(k)))) {
    const e = registry[k];
    if (!e || typeof e !== 'object') continue;
    const id = ident(e);
    if (!isId(k) && e.filename && byEntry.has(id)) continue;
    if (e.filename) byEntry.set(id, k);
    items.push({ key: k, entry: e });
  }
  return items;
}

function wrap(db, migrationBackup) {
  const st = {
    get: db.prepare('SELECT * FROM items WHERE key = ?'),
    byId: db.prepare('SELECT * FROM items WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO items (key, site, source_id, source_url, kind, audience, audience_reasons, profile_id,
                         creator, title, filename, origin, created_at, updated_at)
      VALUES (@key, @site, @source_id, @source_url, @kind, @audience, @audience_reasons, @profile_id,
              @creator, @title, @filename, @origin, @at, @at)`),
    update: db.prepare(`
      UPDATE items SET audience = @audience, audience_reasons = @audience_reasons,
        profile_id = COALESCE(@profile_id, profile_id), kind = COALESCE(@kind, kind),
        creator = COALESCE(@creator, creator), title = COALESCE(@title, title),
        filename = COALESCE(@filename, filename), source_url = COALESCE(@source_url, source_url),
        updated_at = @at
      WHERE id = @id`),
    hash: db.prepare('UPDATE items SET sha256 = ?, bytes = ?, updated_at = ? WHERE id = ?'),
    sameHash: db.prepare('SELECT * FROM items WHERE sha256 = ? AND id <> ? ORDER BY id LIMIT 1'),
    deliver: db.prepare(`
      INSERT INTO deliveries (item_id, destination, status, filename, detail, at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    deliveries: db.prepare('SELECT * FROM deliveries WHERE item_id = ? ORDER BY id'),
    counts: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM items WHERE audience = 'general') AS general,
        (SELECT COUNT(*) FROM items WHERE audience = 'adult') AS adult,
        (SELECT COUNT(*) FROM items WHERE audience = 'unknown') AS unknown,
        (SELECT COUNT(*) FROM deliveries) AS deliveries,
        (SELECT COUNT(*) FROM deliveries WHERE status = 'refused') AS refused`),
  };

  const tighter = (prior, next) => {
    if (prior === 'adult' || next === 'adult') return 'adult';
    if (prior === 'general' || next === 'general') return 'general';
    return 'unknown';
  };

  // Inserts or updates an item. The audience only ever moves toward adult;
  // a general item is never made unknown again by a later, weaker look.
  function upsert(fields, now = Date.now()) {
    if (!fields || !fields.key) throw new StoreError('an item needs a key');
    const row = {
      key: String(fields.key),
      site: fields.site || null,
      source_id: fields.sourceId != null ? String(fields.sourceId) : null,
      source_url: fields.sourceUrl || null,
      kind: ['video', 'image', 'audio'].includes(fields.kind) ? fields.kind : null,
      audience: ['general', 'adult', 'unknown'].includes(fields.audience) ? fields.audience : 'unknown',
      audience_reasons: fields.reasons ? JSON.stringify(fields.reasons) : null,
      profile_id: Number.isInteger(fields.profileId) ? fields.profileId : null,
      creator: fields.creator || null,
      title: fields.title || null,
      filename: fields.filename || null,
      origin: fields.origin === 'registry' ? 'registry' : 'save',
      at: now,
    };
    const prior = st.get.get(row.key);
    if (!prior) {
      st.insert.run(row);
      return st.get.get(row.key);
    }
    const audience = tighter(prior.audience, row.audience);
    st.update.run({
      ...row,
      id: prior.id,
      audience,
      audience_reasons: audience === prior.audience && audience !== row.audience ? prior.audience_reasons : row.audience_reasons,
    });
    return st.byId.get(prior.id);
  }

  return {
    SCHEMA_VERSION,
    migrationBackup,
    db,
    get: (key) => st.get.get(String(key)) || null,
    upsert,
    // One delivery row. Throws (from the trigger) when the item may not go
    // to that destination: the caller treats that as a refusal.
    recordDelivery(itemId, destination, status, { filename = null, detail = null, at = Date.now() } = {}) {
      st.deliver.run(itemId, destination, status, filename, detail, at);
    },
    deliveries: (itemId) => st.deliveries.all(itemId),
    // Stores the content hash and returns the oldest other item with the same
    // bytes, or null. Report-only: nothing is refused on a match yet.
    recordHash(itemId, sha256, bytes, now = Date.now()) {
      st.hash.run(sha256, bytes, now, itemId);
      return st.sameHash.get(sha256, itemId) || null;
    },
    counts: () => st.counts.get(),
    // Phase A: every registry item that has no row yet gets one. Read-only on
    // the registry. Returns how many registry items there are and how many
    // rows were added, so the caller can compare them.
    importRegistry(registry, now = Date.now()) {
      const list = registryItems(registry);
      let added = 0;
      let tightened = 0;
      db.transaction(() => {
        for (const { key, entry } of list) {
          const prior = st.get.get(key);
          const audience = audienceOfRegistryChannel(entry.channel);
          if (prior && tighter(prior.audience, audience) === prior.audience) continue;
          upsert({
            key,
            site: siteOfKey(key),
            sourceId: sourceIdOfKey(key),
            filename: entry.filename || null,
            audience,
            reasons: [`registry channel ${entry.channel || 'none'}`],
            origin: 'registry',
          }, Number(entry.at) || now);
          if (prior) tightened++;
          else added++;
        }
      })();
      return { registryItems: list.length, added, tightened };
    },
    // A consistent copy of the database, for the daily state snapshot.
    snapshotTo(file) {
      const part = `${file}.part`;
      fs.rmSync(part, { force: true });
      db.prepare('VACUUM INTO ?').run(part);
      fs.renameSync(part, file);
    },
    close: () => db.close(),
  };
}

module.exports = {
  SCHEMA_VERSION,
  GENERAL_DESTINATIONS,
  ADULT_DESTINATIONS,
  StoreError,
  open,
  registryItems,
  audienceOfRegistryChannel,
  // For the migration tests only: the same store with another migration list.
  __MIGRATIONS: MIGRATIONS,
  __withMigrations: (migrations) => ({ open: (file, opts) => openWith(migrations, file, opts) }),
};
