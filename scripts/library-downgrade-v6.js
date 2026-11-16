#!/usr/bin/env node
'use strict';
// Rollback helper for Grabbit 2.1: turns a schema v6 items.db back into v5 so
// the previous Grabbit image (which refuses a newer database) can open it,
// WITHOUT losing the items, deliveries, tags or edits written after the
// upgrade.
//
// What v6 added is saved first, then removed:
//   - categories, item_categories, library_log -> <db>.v6-library-<stamp>.json
//   - items.format_override                       -> same JSON (id + value)
// A full copy of the v6 database is written beside it (VACUUM INTO) before
// anything changes. Re-running the 2.1 image later migrates v5 -> v6 again;
// the JSON can be read back with --restore.
//
// Usage (Grabbit must be STOPPED: the server holds the database open):
//   node scripts/library-downgrade-v6.js /data/items.db            dry run
//   node scripts/library-downgrade-v6.js /data/items.db --apply     downgrade
//   node scripts/library-downgrade-v6.js /data/items.db --restore <json>
//                                                       (on a v6 database)

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function stamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function inspect(db) {
  const version = db.pragma('user_version', { simple: true });
  const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
  return {
    version,
    categories: has('categories') ? db.prepare('SELECT COUNT(*) AS n FROM categories').get().n : 0,
    memberships: has('item_categories') ? db.prepare('SELECT COUNT(*) AS n FROM item_categories').get().n : 0,
    logRows: has('library_log') ? db.prepare('SELECT COUNT(*) AS n FROM library_log').get().n : 0,
    formatOverrides: version >= 6 ? db.prepare('SELECT COUNT(*) AS n FROM items WHERE format_override IS NOT NULL').get().n : 0,
    items: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
  };
}

function downgrade(file, { apply = false, now = Date.now() } = {}) {
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    const before = inspect(db);
    if (before.version !== 6) throw new Error(`${path.basename(file)} is schema v${before.version}; only v6 can be downgraded`);
    if (!apply) return { dryRun: true, before };
    const s = stamp(now);
    const copy = `${file}.pre-downgrade-v6-${s}`;
    db.prepare('VACUUM INTO ?').run(copy);
    const saved = {
      from: 6,
      to: 5,
      at: new Date(now).toISOString(),
      categories: db.prepare('SELECT * FROM categories ORDER BY id').all(),
      item_categories: db.prepare('SELECT * FROM item_categories ORDER BY item_id, category_id').all(),
      library_log: db.prepare('SELECT * FROM library_log ORDER BY id').all(),
      format_override: db.prepare('SELECT id, format_override FROM items WHERE format_override IS NOT NULL ORDER BY id').all(),
    };
    const json = `${file}.v6-library-${s}.json`;
    fs.writeFileSync(`${json}.part`, JSON.stringify(saved, null, 1));
    fs.renameSync(`${json}.part`, json);
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS item_categories_audience_match;
        DROP TABLE IF EXISTS item_categories;
        DROP TABLE IF EXISTS library_log;
        DROP TABLE IF EXISTS categories;
        ALTER TABLE items DROP COLUMN format_override;
      `);
      db.pragma('user_version = 5');
    })();
    const after = inspect(db);
    if (after.items !== before.items) throw new Error(`item count changed: ${before.items} -> ${after.items}`);
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity_check: ${check}`);
    return { dryRun: false, before, after, copy, json };
  } finally {
    db.close();
  }
}

// Puts saved categories, memberships, log and overrides back into a v6
// database (after the 2.1 image migrated it again). Rows whose item is gone
// are skipped and counted.
function restore(file, jsonFile) {
  const saved = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const db = new Database(file);
  try {
    if (db.pragma('user_version', { simple: true }) !== 6) throw new Error('restore needs a v6 database (start Grabbit 2.1 once first)');
    if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n) throw new Error('the database already has categories; refusing to mix');
    const out = { categories: 0, memberships: 0, skipped: 0, log: 0, overrides: 0 };
    db.transaction(() => {
      const cat = db.prepare('INSERT INTO categories (id, parent_id, name, norm, adult, created_at, updated_at) VALUES (@id, @parent_id, @name, @norm, @adult, @created_at, @updated_at)');
      // Parents before children: insert in id order with the parent link
      // deferred to a second pass.
      for (const c of saved.categories) { cat.run({ ...c, parent_id: null }); out.categories++; }
      const par = db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?');
      for (const c of saved.categories) if (c.parent_id) par.run(c.parent_id, c.id);
      const has = db.prepare('SELECT audience FROM items WHERE id = ?');
      const link = db.prepare('INSERT OR IGNORE INTO item_categories (item_id, category_id, at, by) VALUES (@item_id, @category_id, @at, @by)');
      const adultOf = new Map(saved.categories.map((c) => [c.id, c.adult]));
      for (const m of saved.item_categories) {
        const it = has.get(m.item_id);
        // The audience may have tightened since; the trigger would refuse it.
        if (!it || (adultOf.get(m.category_id) === 1) !== (it.audience === 'adult') || it.audience === 'unknown') { out.skipped++; continue; }
        link.run(m);
        out.memberships++;
      }
      const log = db.prepare('INSERT INTO library_log (id, action, detail, by, at) VALUES (@id, @action, @detail, @by, @at)');
      for (const l of saved.library_log) { log.run(l); out.log++; }
      const fo = db.prepare('UPDATE items SET format_override = ? WHERE id = ?');
      for (const o of saved.format_override) out.overrides += fo.run(o.format_override, o.id).changes;
    })();
    return out;
  } finally {
    db.close();
  }
}

module.exports = { downgrade, restore, inspect };

if (require.main === module) {
  const [file, flag, arg] = process.argv.slice(2);
  if (!file) {
    console.error('usage: library-downgrade-v6.js <items.db> [--apply | --restore <json>]');
    process.exit(2);
  }
  try {
    const r = flag === '--restore' ? restore(file, arg) : downgrade(file, { apply: flag === '--apply' });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(`library-downgrade-v6: ${e.message}`);
    process.exit(1);
  }
}
