'use strict';
// Metadata, tags and duplicate records on top of items.db (schema v4).
// item-store.js opens the database and runs the migrations; this module adds
// the statements and methods for the Metadata & tags and Duplicates pages.
//
// Promises kept here (the triggers keep the hardest two):
// - The source's title, creator, caption and tags are never overwritten by the
//   owner. Edits go to title_edit / creator_edit and to 'user' tags.
// - Nothing here touches audience, classified_by_hand or profile_id, and the
//   audience gate never reads an edited field.
// - Every edit is logged in item_edits and bumps the item's meta_rev.
// - The duplicate records describe files; nothing here deletes one.

const crypto = require('crypto');
const sourceMeta = require('./source-meta');

const TITLE_MAX = 300;
const CREATOR_MAX = 200;
const BULK_MAX = 5000;
const TAG_ORIGINS = ['site', 'caption', 'user'];
const TAG_FILTER_ORIGINS = ['any', 'source', 'site', 'caption', 'user'];

class MetaError extends Error {}

// Owner text for a title or creator: control characters out, whitespace
// collapsed, capped. '' and null both mean "no edit" (back to the source).
function editText(value, max) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new MetaError('text expected');
  const s = value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!s) return null;
  if ([...s].length > max) throw new MetaError(`at most ${max} characters`);
  return s;
}

const likeArg = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const newBatch = (now) => `${now}-${crypto.randomBytes(4).toString('hex')}`;

function attach(db) {
  const st = {
    item: db.prepare('SELECT * FROM items WHERE id = ?'),
    srcGet: db.prepare('SELECT * FROM item_source_meta WHERE item_id = ?'),
    // The first caption and raw record a source gave are kept; a later save
    // only fills what is still missing.
    srcUpsert: db.prepare(`
      INSERT INTO item_source_meta (item_id, extractor, description, raw, captured_at, updated_at)
      VALUES (@item_id, @extractor, @description, @raw, @at, @at)
      ON CONFLICT (item_id) DO UPDATE SET
        extractor = COALESCE(extractor, excluded.extractor),
        description = COALESCE(description, excluded.description),
        raw = COALESCE(raw, excluded.raw),
        updated_at = CASE WHEN (description IS NULL AND excluded.description IS NOT NULL)
                            OR (raw IS NULL AND excluded.raw IS NOT NULL)
                          THEN excluded.updated_at ELSE updated_at END`),
    tagInsert: db.prepare(`
      INSERT OR IGNORE INTO item_tags (item_id, origin, kind, label, norm, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    tagDeleteUser: db.prepare("DELETE FROM item_tags WHERE item_id = ? AND origin = 'user' AND norm = ?"),
    userTag: db.prepare("SELECT label FROM item_tags WHERE item_id = ? AND origin = 'user' AND norm = ? LIMIT 1"),
    tagsOf: db.prepare('SELECT origin, kind, label, norm FROM item_tags WHERE item_id = ? ORDER BY origin, kind, id'),
    hasTag: db.prepare('SELECT origin FROM item_tags WHERE item_id = ? AND norm = ? AND kind = ? ORDER BY origin'),
    setTitle: db.prepare('UPDATE items SET title_edit = ?, meta_rev = meta_rev + 1, updated_at = ? WHERE id = ?'),
    setCreator: db.prepare('UPDATE items SET creator_edit = ?, meta_rev = meta_rev + 1, updated_at = ? WHERE id = ?'),
    bumpRev: db.prepare('UPDATE items SET meta_rev = meta_rev + 1, updated_at = ? WHERE id = ?'),
    log: db.prepare(`
      INSERT INTO item_edits (item_id, field, old_value, new_value, batch, by, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    edits: db.prepare('SELECT * FROM item_edits WHERE item_id = ? ORDER BY id DESC LIMIT 100'),
    byEffectiveCreator: db.prepare(`
      SELECT * FROM items WHERE COALESCE(creator_edit, creator) = ? ORDER BY id LIMIT ${BULK_MAX + 1}`),
    syncOf: db.prepare('SELECT target, synced_rev, synced_at, detail FROM meta_sync WHERE item_id = ?'),
    // --- duplicates
    fileGet: db.prepare('SELECT * FROM file_hashes WHERE root = ? AND rel = ?'),
    fileInsert: db.prepare(`
      INSERT INTO file_hashes (root, rel, dev, ino, bytes, mtime_ms, seen_at)
      VALUES (@root, @rel, @dev, @ino, @bytes, @mtime_ms, @at)`),
    fileSeen: db.prepare('UPDATE file_hashes SET seen_at = ?, gone_at = NULL WHERE id = ?'),
    fileChanged: db.prepare(`
      UPDATE file_hashes SET dev = @dev, ino = @ino, bytes = @bytes, mtime_ms = @mtime_ms, sha256 = NULL,
        item_id = NULL, link = 'none', error = NULL, hashed_at = NULL, seen_at = @at, gone_at = NULL
      WHERE id = @id`),
    fileHashed: db.prepare(`
      UPDATE file_hashes SET sha256 = @sha256, item_id = @item_id, link = @link, error = @error, hashed_at = @at
      WHERE id = @id`),
    fileGone: db.prepare('UPDATE file_hashes SET gone_at = ? WHERE root = ? AND seen_at < ? AND gone_at IS NULL'),
    fileTodo: db.prepare(`SELECT * FROM file_hashes WHERE gone_at IS NULL AND sha256 IS NULL AND error IS NULL
      ORDER BY id LIMIT ?`),
    // A file belongs to an item only when exactly one item was saved or
    // delivered under that exact file name. Two candidates is "ambiguous", and
    // the file then belongs to none.
    linkCandidates: db.prepare(`
      SELECT id FROM items WHERE filename = @name
      UNION
      SELECT item_id AS id FROM deliveries WHERE filename = @name
      LIMIT 2`),
    scanCounts: db.prepare(`
      SELECT root,
        COUNT(*) AS files,
        SUM(CASE WHEN sha256 IS NOT NULL THEN 1 ELSE 0 END) AS hashed,
        SUM(CASE WHEN sha256 IS NULL AND error IS NULL THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
        SUM(bytes) AS bytes,
        SUM(CASE WHEN sha256 IS NOT NULL THEN bytes ELSE 0 END) AS hashed_bytes,
        SUM(CASE WHEN link = 'filename' THEN 1 ELSE 0 END) AS linked,
        SUM(CASE WHEN link = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous
      FROM file_hashes WHERE gone_at IS NULL GROUP BY root ORDER BY root`),
    groupMembers: db.prepare(`
      SELECT f.id, f.root, f.rel, f.bytes, f.mtime_ms, f.link, f.item_id,
        i.site, i.audience, i.source_url, i.kind,
        COALESCE(i.creator_edit, i.creator) AS creator, COALESCE(i.title_edit, i.title) AS title
      FROM file_hashes f LEFT JOIN items i ON i.id = f.item_id
      WHERE f.sha256 = ? AND f.gone_at IS NULL ORDER BY f.mtime_ms, f.id`),
    ackGet: db.prepare('SELECT * FROM dupe_acks WHERE sha256 = ?'),
    ackSet: db.prepare(`INSERT INTO dupe_acks (sha256, members, note, by, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (sha256) DO UPDATE SET members = excluded.members, note = excluded.note, by = excluded.by, at = excluded.at`),
    ackDelete: db.prepare('DELETE FROM dupe_acks WHERE sha256 = ?'),
    settingGet: db.prepare('SELECT value FROM settings WHERE name = ?'),
    settingSet: db.prepare(`INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
  };

  const mustItem = (id) => {
    const row = Number.isInteger(Number(id)) ? st.item.get(Number(id)) : null;
    if (!row) throw new MetaError('no such item');
    return row;
  };

  // Tags of one item, grouped by origin, plus the combined list: one entry per
  // norm with every origin that has it.
  function tagView(rows) {
    const out = { site: [], categories: [], caption: [], user: [], all: [] };
    const all = new Map();
    for (const r of rows) {
      if (r.origin === 'site' && r.kind === 'category') out.categories.push(r.label);
      else out[r.origin].push(r.label);
      const k = `${r.kind}\u0000${r.norm}`;
      if (!all.has(k)) all.set(k, { label: r.label, norm: r.norm, kind: r.kind, origins: [] });
      const e = all.get(k);
      if (!e.origins.includes(r.origin)) e.origins.push(r.origin);
    }
    out.all = [...all.values()];
    return out;
  }

  function tagsFor(ids) {
    const map = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return map;
    const rows = db.prepare(`SELECT item_id, origin, kind, label, norm FROM item_tags
      WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id, origin, kind, id`).all(JSON.stringify(ids));
    for (const r of rows) map.get(r.item_id).push(r);
    return map;
  }

  const publicItem = (row, tags) => ({
    id: row.id,
    key: row.key,
    site: row.site,
    kind: row.kind,
    audience: row.audience,
    sourceUrl: row.source_url,
    filename: row.filename,
    title: row.title_edit != null ? row.title_edit : row.title,
    creator: row.creator_edit != null ? row.creator_edit : row.creator,
    source: { title: row.title, creator: row.creator },
    edited: { title: row.title_edit != null, creator: row.creator_edit != null },
    hasDescription: Boolean(row.has_description),
    metaRev: row.meta_rev,
    updatedAt: row.updated_at,
    tags: tagView(tags || []),
  });

  function changeUserTags(ids, labels, add, by, now) {
    if (!Array.isArray(ids) || !ids.length) throw new MetaError('choose at least one item');
    if (ids.length > BULK_MAX) throw new MetaError(`at most ${BULK_MAX} items at a time`);
    const tags = sourceMeta.uniqueTags(labels, 50);
    if (!tags.length) throw new MetaError('give at least one tag');
    const batch = newBatch(now);
    const changed = new Set();
    const skipped = [];
    db.transaction(() => {
      for (const id of [...new Set(ids.map(Number))]) {
        const row = Number.isInteger(id) ? st.item.get(id) : null;
        if (!row) { skipped.push({ id, reason: 'no such item' }); continue; }
        for (const t of tags) {
          if (add) {
            const have = st.hasTag.all(id, t.norm, 'tag').map((r) => r.origin);
            if (have.includes('user')) continue;
            if (have.length) { skipped.push({ id, tag: t.label, reason: `already a ${have[0]} tag` }); continue; }
            st.tagInsert.run(id, 'user', 'tag', t.label, t.norm, now);
            st.log.run(id, 'tag_add', null, t.label, batch, by, now);
          } else {
            const stored = st.userTag.get(id, t.norm);
            if (!stored || !st.tagDeleteUser.run(id, t.norm).changes) continue;
            st.log.run(id, 'tag_remove', stored.label, null, batch, by, now);
          }
          changed.add(id);
        }
        if (changed.has(id)) st.bumpRev.run(now, id);
      }
    })();
    return { changed: [...changed], skipped, batch };
  }

  return {
    // --- source metadata -----------------------------------------------------
    // Stores what the source said (see source-meta.fromJob). Additive: tags
    // already there stay, the first caption and raw record stay.
    recordSourceMeta(itemId, meta, now = Date.now()) {
      if (!meta) return 0;
      let added = 0;
      db.transaction(() => {
        mustItem(itemId);
        st.srcUpsert.run({
          item_id: Number(itemId),
          extractor: meta.extractor || null,
          description: meta.description || null,
          raw: meta.raw || null,
          at: now,
        });
        for (const t of meta.tags || []) {
          if (!['site', 'caption'].includes(t.origin) || !t.norm) continue;
          added += st.tagInsert.run(Number(itemId), t.origin, t.kind === 'category' ? 'category' : 'tag', t.label, t.norm, now).changes;
        }
      })();
      return added;
    },

    // One item for the editor: effective and source fields, caption, raw
    // record, tags by origin, edit log and sync state.
    getMeta(itemId) {
      const row = mustItem(itemId);
      const src = st.srcGet.get(row.id);
      let raw = null;
      try { raw = src && src.raw ? JSON.parse(src.raw) : null; } catch { raw = null; }
      return {
        ...publicItem({ ...row, has_description: src && src.description }, st.tagsOf.all(row.id)),
        description: src ? src.description : null,
        extractor: src ? src.extractor : null,
        raw,
        capturedAt: src ? src.captured_at : null,
        edits: st.edits.all(row.id),
        sync: st.syncOf.all(row.id),
      };
    },

    // Title and creator edits. A field left out is untouched; '' or null
    // removes the edit (the source value shows again).
    editItem(itemId, fields, by = null, now = Date.now()) {
      const f = fields || {};
      const out = { changed: [] };
      db.transaction(() => {
        const row = mustItem(itemId);
        const batch = newBatch(now);
        if (Object.prototype.hasOwnProperty.call(f, 'title')) {
          let v = editText(f.title, TITLE_MAX);
          if (v != null && v === row.title) v = null;
          if (v !== row.title_edit) {
            st.setTitle.run(v, now, row.id);
            st.log.run(row.id, 'title', row.title_edit != null ? row.title_edit : row.title, v != null ? v : row.title, batch, by, now);
            out.changed.push('title');
          }
        }
        if (Object.prototype.hasOwnProperty.call(f, 'creator')) {
          let v = editText(f.creator, CREATOR_MAX);
          if (v != null && v === row.creator) v = null;
          if (v !== row.creator_edit) {
            st.setCreator.run(v, now, row.id);
            st.log.run(row.id, 'creator', row.creator_edit != null ? row.creator_edit : row.creator, v != null ? v : row.creator, batch, by, now);
            out.changed.push('creator');
          }
        }
      })();
      return out;
    },

    // Every item whose shown creator is exactly `from` gets `to`. Items whose
    // source creator already is `to` lose their edit instead.
    renameCreator(from, to, by = null, now = Date.now()) {
      const src = editText(from, CREATOR_MAX);
      const dst = editText(to, CREATOR_MAX);
      if (!src || !dst) throw new MetaError('give both the current and the new creator');
      if (src === dst) throw new MetaError('the new creator is the same');
      const rows = st.byEffectiveCreator.all(src);
      if (rows.length > BULK_MAX) throw new MetaError(`more than ${BULK_MAX} items; narrow it down first`);
      const batch = newBatch(now);
      db.transaction(() => {
        for (const row of rows) {
          const v = row.creator === dst ? null : dst;
          st.setCreator.run(v, now, row.id);
          st.log.run(row.id, 'creator', src, dst, batch, by, now);
        }
      })();
      return { changed: rows.length, batch };
    },

    addUserTags: (ids, labels, by = null, now = Date.now()) => changeUserTags(ids, labels, true, by, now),
    removeUserTags: (ids, labels, by = null, now = Date.now()) => changeUserTags(ids, labels, false, by, now),

    // The Metadata page's list. Filters: q (title, creator, file name, caption,
    // key), tag (a norm) with origin any|source|site|caption|user, creator
    // (exact, as shown), tagged any|none|source|user, edited, audience.
    listMeta({ q = '', tag = '', origin = 'any', creator = '', tagged = '', edited = false, audience = '', limit = 50, offset = 0 } = {}) {
      const where = [];
      const args = {
        limit: Math.max(1, Math.min(500, Number(limit) || 50)),
        offset: Math.max(0, Number(offset) || 0),
      };
      const needle = String(q || '').trim();
      if (needle) {
        args.q = likeArg(needle);
        where.push(`(COALESCE(i.title_edit, i.title) LIKE @q ESCAPE '\\' OR COALESCE(i.creator_edit, i.creator) LIKE @q ESCAPE '\\'
          OR i.filename LIKE @q ESCAPE '\\' OR i.key LIKE @q ESCAPE '\\' OR m.description LIKE @q ESCAPE '\\')`);
      }
      const tagNorm = sourceMeta.tagNorm(tag);
      if (tagNorm) {
        args.tag = tagNorm;
        const o = TAG_FILTER_ORIGINS.includes(origin) ? origin : 'any';
        const originSql = o === 'any' ? '' : o === 'source' ? "AND t.origin IN ('site', 'caption')" : `AND t.origin = '${o}'`;
        where.push(`EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.norm = @tag ${originSql})`);
      }
      const who = String(creator || '').trim();
      if (who) { args.creator = who; where.push('COALESCE(i.creator_edit, i.creator) = @creator'); }
      if (tagged === 'none') where.push('NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)');
      else if (tagged === 'any') where.push('EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id)');
      else if (tagged === 'source') where.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.origin IN ('site', 'caption'))");
      else if (tagged === 'user') where.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = i.id AND t.origin = 'user')");
      if (edited) where.push('(i.meta_rev > 0)');
      if (['general', 'adult', 'unknown'].includes(audience)) { args.audience = audience; where.push('i.audience = @audience'); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const from = 'FROM items i LEFT JOIN item_source_meta m ON m.item_id = i.id';
      const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${w}`).get(args).n;
      const rows = db.prepare(`SELECT i.*, m.description IS NOT NULL AS has_description ${from} ${w}
        ORDER BY i.updated_at DESC, i.id DESC LIMIT @limit OFFSET @offset`).all(args);
      const tags = tagsFor(rows.map((r) => r.id));
      return { total, offset: args.offset, items: rows.map((r) => publicItem(r, tags.get(r.id))) };
    },

    // The most used tags, one row per norm, with the origins it has.
    tagCounts({ origin = 'any', q = '', limit = 100 } = {}) {
      const o = TAG_FILTER_ORIGINS.includes(origin) ? origin : 'any';
      const where = [];
      const args = { limit: Math.max(1, Math.min(1000, Number(limit) || 100)) };
      if (o === 'source') where.push("origin IN ('site', 'caption')");
      else if (o !== 'any') where.push(`origin = '${o}'`);
      const needle = sourceMeta.tagNorm(q);
      if (needle) { args.q = likeArg(needle); where.push("norm LIKE @q ESCAPE '\\'"); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`SELECT norm, MIN(label) AS label, COUNT(DISTINCT item_id) AS items,
          GROUP_CONCAT(DISTINCT origin) AS origins
        FROM item_tags ${w} GROUP BY norm ORDER BY items DESC, norm LIMIT @limit`).all(args)
        .map((r) => ({ ...r, origins: String(r.origins || '').split(',').filter(Boolean) }));
    },

    // Creators as shown, with item counts, for the bulk rename picker.
    creatorCounts({ q = '', limit = 50 } = {}) {
      const args = { limit: Math.max(1, Math.min(500, Number(limit) || 50)) };
      let w = 'WHERE COALESCE(creator_edit, creator) IS NOT NULL';
      if (String(q || '').trim()) { args.q = likeArg(String(q).trim()); w += " AND COALESCE(creator_edit, creator) LIKE @q ESCAPE '\\'"; }
      return db.prepare(`SELECT COALESCE(creator_edit, creator) AS creator, COUNT(*) AS items,
          SUM(CASE WHEN creator_edit IS NOT NULL THEN 1 ELSE 0 END) AS edited
        FROM items ${w} GROUP BY 1 ORDER BY items DESC, 1 LIMIT @limit`).all(args);
    },

    metaCounts() {
      return db.prepare(`SELECT
          (SELECT COUNT(*) FROM items) AS items,
          (SELECT COUNT(*) FROM item_source_meta) AS withSourceMeta,
          (SELECT COUNT(*) FROM item_source_meta WHERE description IS NOT NULL) AS withCaption,
          (SELECT COUNT(DISTINCT item_id) FROM item_tags WHERE origin = 'site') AS withSiteTags,
          (SELECT COUNT(DISTINCT item_id) FROM item_tags WHERE origin = 'caption') AS withCaptionTags,
          (SELECT COUNT(DISTINCT item_id) FROM item_tags WHERE origin = 'user') AS withUserTags,
          (SELECT COUNT(*) FROM items WHERE meta_rev > 0) AS edited`).get();
    },

    // --- duplicate scan records ----------------------------------------------
    // Records a file the walk saw. Returns the row and whether its bytes must
    // be (re)hashed: new, or size, mtime or inode changed since the last read.
    fileSeen(root, rel, stat, now = Date.now()) {
      const f = { root, rel, dev: Number(stat.dev), ino: Number(stat.ino), bytes: Number(stat.size), mtime_ms: Math.floor(Number(stat.mtimeMs)), at: now };
      const prior = st.fileGet.get(root, rel);
      if (!prior) {
        st.fileInsert.run(f);
        return { row: st.fileGet.get(root, rel), hash: true };
      }
      if (prior.bytes !== f.bytes || prior.mtime_ms !== f.mtime_ms || prior.ino !== f.ino || prior.dev !== f.dev) {
        st.fileChanged.run({ ...f, id: prior.id });
        return { row: st.fileGet.get(root, rel), hash: true };
      }
      st.fileSeen.run(now, prior.id);
      return { row: prior, hash: prior.sha256 == null && prior.error == null };
    },
    // The walk of `root` that started at `walkStartedAt` is complete: every file
    // it did not see is gone.
    filesGoneBefore(root, walkStartedAt, now = Date.now()) {
      return st.fileGone.run(now, root, walkStartedAt).changes;
    },
    filesToHash: (limit = 100) => st.fileTodo.all(limit),
    fileLink(name) {
      const c = st.linkCandidates.all({ name: String(name) });
      if (c.length === 1) return { link: 'filename', itemId: c[0].id };
      return { link: c.length ? 'ambiguous' : 'none', itemId: null };
    },
    fileHashed(id, { sha256 = null, link = 'none', itemId = null, error = null } = {}, now = Date.now()) {
      st.fileHashed.run({ id, sha256, link, item_id: itemId, error: error ? String(error).slice(0, 300) : null, at: now });
    },
    scanCounts: () => st.scanCounts.all(),

    // Exact duplicate groups: two or more present files with the same bytes.
    // state: open (not acknowledged, or a member changed since), acked, all.
    dupeGroups({ state = 'open', limit = 50, offset = 0 } = {}) {
      const groups = db.prepare(`SELECT sha256, COUNT(*) AS n, MAX(bytes) AS bytes
        FROM file_hashes WHERE sha256 IS NOT NULL AND gone_at IS NULL
        GROUP BY sha256 HAVING COUNT(*) > 1 ORDER BY MAX(bytes) * (COUNT(*) - 1) DESC, sha256`).all();
      const out = [];
      let wasted = 0;
      for (const g of groups) {
        const members = st.groupMembers.all(g.sha256);
        const signature = members.map((m) => m.id).sort((a, b) => a - b).join(',');
        const ack = st.ackGet.get(g.sha256);
        const acked = Boolean(ack && ack.members === signature);
        const view = { sha256: g.sha256, files: g.n, bytes: g.bytes, members, ack: ack ? { ...ack, current: acked } : null };
        if (!acked) wasted += g.bytes * (g.n - 1);
        if (state === 'all' || (state === 'acked') === acked) out.push(view);
      }
      const lim = Math.max(1, Math.min(500, Number(limit) || 50));
      const off = Math.max(0, Number(offset) || 0);
      return {
        total: out.length,
        groups: groups.length,
        openBytes: wasted,
        offset: off,
        items: out.slice(off, off + lim),
      };
    },
    // Marks a group known/OK for exactly its present members. A new copy later
    // reopens it.
    ackGroup(sha256, { note = null, by = null } = {}, now = Date.now()) {
      const members = st.groupMembers.all(String(sha256));
      if (members.length < 2) throw new MetaError('no duplicate group with that hash');
      const signature = members.map((m) => m.id).sort((a, b) => a - b).join(',');
      st.ackSet.run(String(sha256), signature, note ? editText(note, 500) : null, by, now);
      return { sha256: String(sha256), members: members.length };
    },
    unackGroup: (sha256) => st.ackDelete.run(String(sha256)).changes,

    setting(name) {
      const r = st.settingGet.get(String(name));
      return r ? r.value : null;
    },
    setSetting: (name, value, now = Date.now()) => st.settingSet.run(String(name), value == null ? null : String(value), now),
  };
}

module.exports = { attach, MetaError, editText, TITLE_MAX, CREATOR_MAX, BULK_MAX, TAG_ORIGINS };
