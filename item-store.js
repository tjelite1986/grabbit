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
// - Only the owner's hand makes an item general on its own: classifyItems()
//   sets classified_by_hand, and the gate reads a general item as evidence only
//   with that mark. An 18+ item is never classified general (the trigger).
// - The registry import is additive and read-only: it inserts what is
//   missing and never changes an item it already has, except to tighten its
//   audience.

const fs = require('fs');
const path = require('path');
const itemMeta = require('./item-meta');

const GENERAL_DESTINATIONS = ['main', 'platform', 'posts', 'egram'];
const ADULT_DESTINATIONS = ['18plus'];
// The lists as schema v1 knew them. Migrations are history: they must create
// the same schema on every run, whatever the constants above say today.
const V1_GENERAL = ['main', 'platform', 'posts'];
const V1_ADULT = ['18plus'];
const V3_DESTINATIONS = ['main', 'platform', 'posts', 'egram', '18plus'];
const V3_GENERAL = ['main', 'platform', 'posts', 'egram'];
const INBOX_STATES = ['held', 'ready', 'delivered', 'duplicate'];
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
    destination TEXT NOT NULL CHECK (destination IN (${q([...V1_GENERAL, ...V1_ADULT])})),
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
    AND NEW.destination IN (${q(V1_GENERAL)})
    AND (SELECT audience FROM items WHERE id = NEW.item_id) IS NOT 'general'
  BEGIN
    SELECT RAISE(ABORT, 'an item that is not classified general cannot be delivered to a general app');
  END;

  CREATE TRIGGER deliveries_adult_takes_no_images
  BEFORE INSERT ON deliveries
  WHEN NEW.status IN ('dropped', 'taken')
    AND NEW.destination IN (${q(V1_ADULT)})
    AND (SELECT kind FROM items WHERE id = NEW.item_id) = 'image'
  BEGIN
    SELECT RAISE(ABORT, 'the 18+ app takes videos only');
  END;
  `,
  // v2: the owner's hand classification of a single item (review queue).
  `
  ALTER TABLE items ADD COLUMN classified_by_hand INTEGER NOT NULL DEFAULT 0 CHECK (classified_by_hand IN (0, 1));
  CREATE INDEX items_audience ON items (audience, updated_at);
  CREATE INDEX deliveries_refused ON deliveries (item_id, at) WHERE status = 'refused';
  `,
  // v3: egram as a general destination (the destination list is a CHECK, so
  // the table is rebuilt with every row kept), and the Instagram inbox.
  `
  CREATE TABLE deliveries_v3 (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items (id),
    destination TEXT NOT NULL CHECK (destination IN (${q(V3_DESTINATIONS)})),
    status TEXT NOT NULL CHECK (status IN (${q(DELIVERY_STATUSES)})),
    filename TEXT,
    detail TEXT,
    at INTEGER NOT NULL
  );
  INSERT INTO deliveries_v3 (id, item_id, destination, status, filename, detail, at)
    SELECT id, item_id, destination, status, filename, detail, at FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_v3 RENAME TO deliveries;
  CREATE INDEX deliveries_item ON deliveries (item_id, destination);
  CREATE INDEX deliveries_refused ON deliveries (item_id, at) WHERE status = 'refused';

  CREATE TRIGGER deliveries_general_needs_general_item
  BEFORE INSERT ON deliveries
  WHEN NEW.status IN ('dropped', 'taken')
    AND NEW.destination IN (${q(V3_GENERAL)})
    AND (SELECT audience FROM items WHERE id = NEW.item_id) IS NOT 'general'
  BEGIN
    SELECT RAISE(ABORT, 'an item that is not classified general cannot be delivered to a general app');
  END;

  CREATE TRIGGER deliveries_adult_takes_no_images
  BEFORE INSERT ON deliveries
  WHEN NEW.status IN ('dropped', 'taken')
    AND NEW.destination IN (${q(V1_ADULT)})
    AND (SELECT kind FROM items WHERE id = NEW.item_id) = 'image'
  BEGIN
    SELECT RAISE(ABORT, 'the 18+ app takes videos only');
  END;

  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    entry TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('media', 'profile')),
    item_id INTEGER REFERENCES items (id),
    username TEXT NOT NULL,
    group_key TEXT,
    group_size INTEGER,
    media_file TEXT,
    sidecar_file TEXT,
    state TEXT NOT NULL CHECK (state IN (${q(INBOX_STATES)})),
    reason TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settled_at INTEGER,
    purged_at INTEGER,
    CHECK (kind = 'profile' OR item_id IS NOT NULL)
  );
  CREATE INDEX inbox_state ON inbox (state, received_at);
  CREATE INDEX inbox_user ON inbox (username);
  CREATE INDEX inbox_item ON inbox (item_id) WHERE item_id IS NOT NULL;
  `,
  // v4: metadata and duplicates.
  // - The owner's title and creator live beside the source's, never over them:
  //   a later save refreshes items.title/creator from the source and leaves the
  //   edits alone. The audience gate never reads either column.
  // - Source metadata (caption, raw record) one row per item; tags one row per
  //   (item, origin, kind, norm), so a tag is stored once per origin.
  // - Source and caption tags cannot be deleted or rewritten: triggers.
  // - meta_rev counts the owner's metadata edits; meta_sync is where a later
  //   connector to the apps will record which revision it has sent.
  // - file_hashes: what the duplicate scan read, one row per file, keyed on
  //   (root, rel). It only describes files; nothing here deletes one.
  `
  ALTER TABLE items ADD COLUMN title_edit TEXT;
  ALTER TABLE items ADD COLUMN creator_edit TEXT;
  ALTER TABLE items ADD COLUMN meta_rev INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE item_source_meta (
    item_id INTEGER PRIMARY KEY REFERENCES items (id),
    extractor TEXT,
    description TEXT,
    raw TEXT,
    captured_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE item_tags (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items (id),
    origin TEXT NOT NULL CHECK (origin IN ('site', 'caption', 'user')),
    kind TEXT NOT NULL DEFAULT 'tag' CHECK (kind IN ('tag', 'category')),
    label TEXT NOT NULL,
    norm TEXT NOT NULL CHECK (length(norm) > 0),
    created_at INTEGER NOT NULL,
    UNIQUE (item_id, origin, kind, norm)
  );
  CREATE INDEX item_tags_norm ON item_tags (norm, origin);
  CREATE INDEX item_tags_item ON item_tags (item_id);

  CREATE TRIGGER item_tags_source_kept
  BEFORE DELETE ON item_tags
  WHEN OLD.origin <> 'user'
  BEGIN
    SELECT RAISE(ABORT, 'a tag from the source cannot be removed');
  END;

  CREATE TRIGGER item_tags_never_rewritten
  BEFORE UPDATE ON item_tags
  BEGIN
    SELECT RAISE(ABORT, 'a tag is added or removed, never rewritten');
  END;

  CREATE TABLE item_edits (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items (id),
    field TEXT NOT NULL CHECK (field IN ('title', 'creator', 'tag_add', 'tag_remove')),
    old_value TEXT,
    new_value TEXT,
    batch TEXT,
    by TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX item_edits_item ON item_edits (item_id, id);

  CREATE TABLE meta_sync (
    item_id INTEGER NOT NULL REFERENCES items (id),
    target TEXT NOT NULL,
    synced_rev INTEGER NOT NULL,
    synced_at INTEGER NOT NULL,
    detail TEXT,
    PRIMARY KEY (item_id, target)
  );

  CREATE TABLE file_hashes (
    id INTEGER PRIMARY KEY,
    root TEXT NOT NULL,
    rel TEXT NOT NULL,
    dev INTEGER,
    ino INTEGER,
    bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    sha256 TEXT,
    item_id INTEGER REFERENCES items (id),
    link TEXT NOT NULL DEFAULT 'none' CHECK (link IN ('filename', 'ambiguous', 'none')),
    error TEXT,
    seen_at INTEGER NOT NULL,
    hashed_at INTEGER,
    gone_at INTEGER,
    UNIQUE (root, rel)
  );
  CREATE INDEX file_hashes_sha ON file_hashes (sha256) WHERE sha256 IS NOT NULL AND gone_at IS NULL;
  CREATE INDEX deliveries_filename ON deliveries (filename) WHERE filename IS NOT NULL;

  CREATE TABLE dupe_acks (
    sha256 TEXT PRIMARY KEY,
    members TEXT NOT NULL,
    note TEXT,
    by TEXT,
    at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    name TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
];
const CLASSIFY_MAX = 5000;
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
    byFilename: db.prepare('SELECT * FROM items WHERE filename = ? ORDER BY id DESC LIMIT 1'),
    // A site-id key is the item's real identity; a URL key is what a failed
    // resolve leaves behind, so it only answers when there is no id-keyed row.
    bySourceUrl: db.prepare(`SELECT * FROM items WHERE source_url = ?
      ORDER BY (key LIKE 'id:%') DESC, id DESC LIMIT 1`),
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
        (SELECT COUNT(*) FROM deliveries WHERE status = 'refused') AS refused,
        (SELECT COUNT(DISTINCT item_id) FROM deliveries WHERE status = 'refused'
           AND item_id IN (SELECT id FROM items WHERE audience = 'unknown')) AS refusedUnknown`),
    inboxById: db.prepare('SELECT * FROM inbox WHERE id = ?'),
    inboxByEntry: db.prepare('SELECT * FROM inbox WHERE entry = ?'),
    inboxInsert: db.prepare(`
      INSERT INTO inbox (source, entry, kind, item_id, username, group_key, group_size, media_file, sidecar_file,
                         state, reason, received_at, updated_at)
      VALUES (@source, @entry, @kind, @item_id, @username, @group_key, @group_size, @media_file, @sidecar_file,
              @state, @reason, @at, @at)`),
    inboxState: db.prepare(`
      UPDATE inbox SET state = @state, reason = @reason, updated_at = @at,
        settled_at = CASE WHEN @settled IS NULL THEN NULL ELSE COALESCE(settled_at, @settled) END
      WHERE id = @id`),
    inboxOpen: db.prepare("SELECT * FROM inbox WHERE state IN ('held', 'ready') ORDER BY received_at, id"),
    inboxGroup: db.prepare('SELECT * FROM inbox WHERE username = ? AND group_key = ? ORDER BY id'),
    inboxPurgeDue: db.prepare(`SELECT * FROM inbox WHERE state IN ('delivered', 'duplicate')
      AND purged_at IS NULL AND settled_at IS NOT NULL AND settled_at < ? ORDER BY id`),
    inboxPurged: db.prepare('UPDATE inbox SET purged_at = ?, updated_at = ? WHERE id = ?'),
    inboxCounts: db.prepare('SELECT state, COUNT(*) AS n FROM inbox GROUP BY state'),
    deliveredTo: db.prepare(`SELECT 1 FROM deliveries WHERE item_id = ? AND destination = ?
      AND status IN ('dropped', 'taken') LIMIT 1`),
    everDelivered: db.prepare("SELECT 1 FROM deliveries WHERE item_id = ? AND status IN ('dropped', 'taken') LIMIT 1"),
    classify: db.prepare(`
      UPDATE items SET audience = @audience, classified_by_hand = 1,
        audience_reasons = @reasons, updated_at = @at
      WHERE id = @id`),
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
    getById: (id) => st.byId.get(Number(id)) || null,
    // The newest row saved under this file name (the media viewer's lookup).
    getByFilename: (name) => st.byFilename.get(String(name)) || null,
    // The newest row saved from this source URL (a no-file history entry's lookup).
    getBySourceUrl: (url) => st.bySourceUrl.get(String(url)) || null,
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
    // The owner's decision for many items at once. 18+ items are never made
    // general (skipped with a reason; the trigger would refuse it anyway).
    classifyItems(ids, audience, now = Date.now()) {
      if (audience !== 'general' && audience !== 'adult') throw new StoreError('audience must be general or adult');
      if (!Array.isArray(ids) || !ids.length) throw new StoreError('choose at least one item');
      if (ids.length > CLASSIFY_MAX) throw new StoreError(`at most ${CLASSIFY_MAX} items at a time`);
      const changed = [];
      const skipped = [];
      db.transaction(() => {
        for (const id of [...new Set(ids.map(Number))]) {
          const row = Number.isInteger(id) ? st.byId.get(id) : null;
          if (!row) { skipped.push({ id, reason: 'no such item' }); continue; }
          if (audience === 'general' && row.audience === 'adult') {
            skipped.push({ id, reason: 'an 18+ item is never classified general' });
            continue;
          }
          if (row.audience === audience && row.classified_by_hand) {
            skipped.push({ id, reason: `already ${audience}` });
            continue;
          }
          st.classify.run({ id, audience, reasons: JSON.stringify([`classified ${audience} by hand`]), at: now });
          changed.push(id);
        }
      })();
      return { changed, skipped };
    },
    // The review queue: items of one audience, the ones a general app refused
    // first (latest refusal first), then the most recently touched.
    listItems({ audience = 'unknown', refused = false, q = '', limit = 100, offset = 0 } = {}) {
      const aud = ['general', 'adult', 'unknown'].includes(audience) ? audience : 'unknown';
      const where = ['i.audience = @aud'];
      const args = {
        aud,
        limit: Math.max(1, Math.min(1000, Number(limit) || 100)),
        offset: Math.max(0, Number(offset) || 0),
      };
      if (refused) where.push("EXISTS (SELECT 1 FROM deliveries d WHERE d.item_id = i.id AND d.status = 'refused')");
      const needle = String(q || '').trim();
      if (needle) {
        args.q = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push("(i.creator LIKE @q ESCAPE '\\' OR i.filename LIKE @q ESCAPE '\\' OR i.title LIKE @q ESCAPE '\\' OR i.key LIKE @q ESCAPE '\\')");
      }
      const w = where.join(' AND ');
      const total = db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${w}`).get(args).n;
      const rows = db.prepare(`
        SELECT i.*, r.refusals, r.last_refused_at,
          (SELECT detail FROM deliveries d WHERE d.item_id = i.id AND d.status = 'refused' ORDER BY d.id DESC LIMIT 1) AS last_refusal
        FROM items i
        LEFT JOIN (SELECT item_id, COUNT(*) AS refusals, MAX(at) AS last_refused_at
                   FROM deliveries WHERE status = 'refused' GROUP BY item_id) r ON r.item_id = i.id
        WHERE ${w}
        ORDER BY r.last_refused_at IS NULL, r.last_refused_at DESC, i.updated_at DESC, i.id DESC
        LIMIT @limit OFFSET @offset`).all(args);
      return { total, offset: args.offset, items: rows };
    },
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
    // --- Instagram inbox ------------------------------------------------------
    // One row per staged drop (a media file with its sidecar, or a profile
    // sidecar). A row is added once and keeps its entry name for good, so a
    // file that is dropped again under the same name is recognised.
    inboxGet: (id) => st.inboxById.get(Number(id)) || null,
    inboxByEntry: (entry) => st.inboxByEntry.get(String(entry)) || null,
    inboxAdd(fields, now = Date.now()) {
      const row = {
        source: String(fields.source || 'instagram'),
        entry: String(fields.entry),
        kind: fields.kind === 'profile' ? 'profile' : 'media',
        item_id: Number.isInteger(fields.itemId) ? fields.itemId : null,
        username: String(fields.username),
        group_key: fields.groupKey || null,
        group_size: Number.isInteger(fields.groupSize) && fields.groupSize > 0 ? fields.groupSize : null,
        media_file: fields.mediaFile || null,
        sidecar_file: fields.sidecarFile || null,
        state: INBOX_STATES.includes(fields.state) ? fields.state : 'held',
        reason: fields.reason || null,
        at: now,
      };
      st.inboxInsert.run(row);
      return st.inboxByEntry.get(row.entry);
    },
    inboxSetState(id, state, reason, now = Date.now()) {
      if (!INBOX_STATES.includes(state)) throw new StoreError(`unknown inbox state "${state}"`);
      const settled = state === 'delivered' || state === 'duplicate' ? now : null;
      st.inboxState.run({ id: Number(id), state, reason: reason || null, settled, at: now });
      return st.inboxById.get(Number(id));
    },
    // Rows still waiting for a decision or a delivery, oldest first.
    inboxOpen: () => st.inboxOpen.all(),
    inboxGroup: (username, groupKey) => st.inboxGroup.all(String(username), String(groupKey)),
    // Settled rows whose staged files are older than the cut-off and not yet removed.
    inboxPurgeDue: (before) => st.inboxPurgeDue.all(Number(before)),
    inboxMarkPurged: (id, now = Date.now()) => st.inboxPurged.run(now, now, Number(id)),
    inboxCounts: () => st.inboxCounts.all().reduce((o, r) => ({ ...o, [r.state]: r.n }), {}),
    inboxList({ state = '', q = '', limit = 200, offset = 0 } = {}) {
      const where = [];
      const args = {
        limit: Math.max(1, Math.min(1000, Number(limit) || 200)),
        offset: Math.max(0, Number(offset) || 0),
      };
      if (INBOX_STATES.includes(state)) { where.push('x.state = @state'); args.state = state; }
      const needle = String(q || '').trim();
      if (needle) {
        args.q = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push("(x.username LIKE @q ESCAPE '\\' OR x.entry LIKE @q ESCAPE '\\')");
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM inbox x ${w}`).get(args).n;
      const rows = db.prepare(`
        SELECT x.*, i.key AS item_key, i.kind AS item_kind, i.audience, i.audience_reasons, i.source_url, i.title
        FROM inbox x LEFT JOIN items i ON i.id = x.item_id
        ${w}
        ORDER BY x.received_at DESC, x.id DESC
        LIMIT @limit OFFSET @offset`).all(args);
      return { total, offset: args.offset, items: rows };
    },
    // Whether this item already reached this app (dropped or taken).
    deliveredTo: (itemId, destination) => Boolean(st.deliveredTo.get(itemId, destination)),
    // Any successful delivery of the item, to any app.
    everDelivered: (itemId) => Boolean(st.everDelivered.get(itemId)),
    // A consistent copy of the database, for the daily state snapshot.
    snapshotTo(file) {
      const part = `${file}.part`;
      fs.rmSync(part, { force: true });
      db.prepare('VACUUM INTO ?').run(part);
      fs.renameSync(part, file);
    },
    close: () => db.close(),
    // Metadata, tags and duplicate records (schema v4): item-meta.js.
    // Only on a v4 database (the migration tests open older schemas).
    ...(db.pragma('user_version', { simple: true }) >= 4 ? itemMeta.attach(db) : {}),
  };
}

module.exports = {
  SCHEMA_VERSION,
  CLASSIFY_MAX,
  GENERAL_DESTINATIONS,
  ADULT_DESTINATIONS,
  INBOX_STATES,
  StoreError,
  open,
  registryItems,
  audienceOfRegistryChannel,
  // For the migration tests only: the same store with another migration list.
  __MIGRATIONS: MIGRATIONS,
  __withMigrations: (migrations) => ({ open: (file, opts) => openWith(migrations, file, opts) }),
};
