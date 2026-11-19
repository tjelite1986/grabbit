'use strict';
// Removing exact duplicate copies. Nothing is deleted outright: a removed copy
// moves into Grabbit's trash folder, can be restored from there, and is
// purged only after the hold time.
//
// Which copies may go is decided here and nowhere else:
// - only copies in a folder Grabbit owns, or in an app's import folder when
//   the same bytes already sit in that app's library (the import is spent);
// - never the last copy of a group;
// - never the only copy linked to a Grabbit item (its library entry would
//   point at nothing).
// Before a copy moves, its bytes and the bytes of a copy that stays are read
// again: the copy goes only if both still hash to the group's sha256.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOLD_MS = 30 * 24 * 60 * 60 * 1000;

class TrashError extends Error {}

// rootOf(path) -> the scan root candidate ({ owner, importFor, ... }) or null.
function canRemoveFrom(member, members, rootOf) {
  const r = rootOf(member.root);
  if (!r) return { ok: false, why: 'Unknown folder' };
  if (r.owner === 'grabbit') return { ok: true };
  if (r.importFor && members.some((m) => m.id !== member.id && m.root === r.importFor)) return { ok: true };
  if (r.importFor) return { ok: false, why: `Kept: ${r.app || 'the app'} has not imported it yet` };
  return { ok: false, why: `Kept: ${r.app || 'an app'} reads this folder` };
}

// Best copy to keep among removable copies: linked to an item, then the
// oldest, then the shortest path.
function rank(a, b) {
  const la = a.link === 'filename' ? 0 : 1;
  const lb = b.link === 'filename' ? 0 : 1;
  if (la !== lb) return la - lb;
  if (a.mtime_ms !== b.mtime_ms) return a.mtime_ms - b.mtime_ms;
  if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
  return a.id - b.id;
}

// Plans a group: which copy stays and which may go. A copy outside Grabbit's
// reach stays anyway, so with one of those present every removable copy can
// go, except a copy that is the only one linked to its item.
function planGroup(members, rootOf) {
  const view = members.map((m) => ({ ...m, ...canRemoveFrom(m, members, rootOf) }));
  const fixed = view.filter((m) => !m.ok);
  const removable = view.filter((m) => m.ok).sort(rank);
  const keep = new Set(fixed.map((m) => m.id));
  // A copy waiting in an import folder is not an anchor: the app may still
  // move, reject or delete it. One copy Grabbit controls stays as well.
  const anchors = fixed.filter((m) => !(rootOf(m.root) || {}).importFor);
  if (!anchors.length && removable.length) keep.add(removable[0].id);
  // An item keeps at least one linked copy.
  for (const m of removable) {
    if (keep.has(m.id) || m.link !== 'filename' || m.item_id == null) continue;
    const linkedKept = view.some((o) => keep.has(o.id) && o.link === 'filename' && o.item_id === m.item_id);
    if (!linkedKept) keep.add(m.id);
  }
  const keepId = anchors.length ? anchors[0].id : removable.length ? removable[0].id : fixed.length ? fixed[0].id : null;
  return {
    keepId,
    members: view.map((m) => {
      let blocked = m.ok ? null : m.why;
      if (!blocked) {
        try { checkRemoval(m, members, rootOf); } catch (e) { blocked = e.message; }
      }
      return {
        id: m.id,
        removable: !blocked,
        suggested: !blocked && !keep.has(m.id),
        keep: m.id === keepId,
        why: blocked || (m.id === keepId ? 'Best copy to keep' : keep.has(m.id) ? 'Kept: the only copy linked to its item' : null),
      };
    }),
  };
}

// May this one copy go now, given the group as it is? Same rules as the plan,
// applied to a single owner choice.
function checkRemoval(member, members, rootOf) {
  if (members.length < 2) throw new TrashError('This is the last copy');
  const c = canRemoveFrom(member, members, rootOf);
  if (!c.ok) throw new TrashError(c.why);
  const lasting = members.filter((o) => o.id !== member.id && !(rootOf(o.root) || {}).importFor);
  if (!lasting.length) throw new TrashError('Kept: the other copies are only waiting in an import folder');
  if (member.link === 'filename' && member.item_id != null) {
    const other = members.some((o) => o.id !== member.id && o.link === 'filename' && o.item_id === member.item_id);
    if (!other) throw new TrashError('Kept: the only copy linked to its item');
  }
}

// The real path of a scanned file, refusing anything that climbs out of its
// root or runs through a symlink.
function realFileOf(row) {
  const root = path.resolve(row.root);
  const abs = path.resolve(root, row.rel);
  if (!abs.startsWith(root + path.sep)) throw new TrashError('Path outside its folder');
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new TrashError('Not a regular file');
  const realRoot = fs.realpathSync(root);
  const realAbs = fs.realpathSync(abs);
  if (realAbs !== path.join(realRoot, path.relative(root, abs))) throw new TrashError('Path runs through a symlink');
  return { abs: realAbs, stat: st };
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

// Moves `from` to `to`: a rename where possible, else a copy (flushed and
// size-checked) and an unlink. Bind mounts make a rename across folders fail
// with EXDEV even on one disk.
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  // Copy to a .part beside the target, flush, check, rename; the source goes
  // last, so a failure at any step leaves it where it was.
  if (fs.existsSync(to)) throw new TrashError('Target already exists');
  const size = fs.statSync(from).size;
  const part = path.join(path.dirname(to), `.${path.basename(to)}.part`);
  try {
    fs.copyFileSync(from, part);
    const fd = fs.openSync(part, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.statSync(part).size !== size) throw new TrashError('The copy came out short');
    fs.renameSync(part, to);
  } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    throw e;
  }
  fs.unlinkSync(from);
}

class DupeTrash {
  // holdMs: a number, or a function returning one (the retention setting);
  // 0 means manual cleanup only, nothing is purged automatically.
  // onRemoved(trashId, row, info): lets the caller record 3.0.4 metadata.
  constructor({ store, trashDir, rootOf, now = Date.now, holdMs = HOLD_MS, onRemoved = null, mergeOf = null }) {
    this.store = store;
    this.dir = trashDir;
    this.rootOf = rootOf;
    this.now = now;
    this.holdFn = typeof holdMs === 'function' ? holdMs : () => holdMs;
    this.onRemoved = onRemoved;
    // mergeOf(trashId) -> { keep_root, keep_rel } for a merged copy, else null.
    this.mergeOf = mergeOf;
    this.busy = false;
  }

  get holdMs() {
    const v = Number(this.holdFn());
    return Number.isFinite(v) && v >= 0 ? v : HOLD_MS;
  }

  plan(members) {
    return planGroup(members, this.rootOf);
  }

  // Removes one copy. Returns the trash entry id.
  async remove(fileId, { by = null, plannedKeep = null, reason = null } = {}) {
    const row = this.store.dupeFile(fileId);
    if (!row || !row.sha256) throw new TrashError('No such file in a duplicate group');
    const members = this.store.dupeMembers(row.sha256);
    const member = members.find((m) => m.id === row.id);
    if (!member) throw new TrashError('No such file in a duplicate group');
    checkRemoval(member, members, this.rootOf);
    // A copy that stays must still be there with the same bytes.
    const others = members.filter((m) => m.id !== row.id);
    const keeper = others.find((m) => m.id === plannedKeep) || others[0];
    const keepRow = this.store.dupeFile(keeper.id);
    if (!keepRow) throw new TrashError('The copy that stays is gone');
    const kept = realFileOf(keepRow);
    const doomed = realFileOf(row);
    if (doomed.stat.size !== row.bytes || kept.stat.size !== keepRow.bytes) throw new TrashError('A file changed since the scan; scan again first');
    const [a, b] = await Promise.all([sha256Of(doomed.abs), sha256Of(kept.abs)]);
    if (a !== row.sha256 || b !== row.sha256) throw new TrashError('The bytes no longer match; scan again first');

    fs.mkdirSync(this.dir, { recursive: true });
    const trashName = `${this.now()}-${row.id}-${path.basename(row.rel).slice(0, 150)}`;
    const to = path.join(this.dir, trashName);
    moveFile(doomed.abs, to);
    const id = this.store.trashAdd({ file_id: row.id, root: row.root, rel: row.rel, sha256: row.sha256, bytes: row.bytes, trash_name: trashName, by }, this.now());
    this.store.fileGoneNow(row.id, this.now());
    if (this.onRemoved) {
      try { this.onRemoved(id, row, { keep: keepRow, reason }); } catch {}
    }
    return id;
  }

  // Removes one copy of a picture or video whose bytes differ from the copy
  // that stays (a near duplicate the owner chose). Same safety as remove():
  // only Grabbit's own folders, never a copy linked to a library item, and
  // both files are read again and must still have the bytes the scan saw.
  async removeSimilar(fileId, keepId, { by = null, reason = null } = {}) {
    const row = this.store.dupeFile(fileId);
    const keepRow = this.store.dupeFile(keepId);
    if (!row || !row.sha256) throw new TrashError('That copy is no longer there; scan again');
    if (!keepRow || !keepRow.sha256) throw new TrashError('The copy that stays is gone; scan again');
    if (row.id === keepRow.id) throw new TrashError('Choose another copy to keep');
    const r = this.rootOf(row.root);
    if (!r || r.owner !== 'grabbit') throw new TrashError(r && r.app ? `${r.app} owns this file` : 'Unknown folder');
    if (row.link === 'filename' && row.item_id != null) throw new TrashError('Kept: a library item uses this file');
    const doomed = realFileOf(row);
    const kept = realFileOf(keepRow);
    if (doomed.stat.size !== row.bytes || kept.stat.size !== keepRow.bytes) throw new TrashError('A file changed since the scan; scan again first');
    const [a, b] = await Promise.all([sha256Of(doomed.abs), sha256Of(kept.abs)]);
    if (a !== row.sha256 || b !== keepRow.sha256) throw new TrashError('The bytes no longer match; scan again first');
    return this.moveToTrash(row, doomed, { by, keepRow, reason });
  }

  moveToTrash(row, doomed, { by, keepRow, reason }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const trashName = `${this.now()}-${row.id}-${path.basename(row.rel).slice(0, 150)}`;
    const to = path.join(this.dir, trashName);
    moveFile(doomed.abs, to);
    const id = this.store.trashAdd({ file_id: row.id, root: row.root, rel: row.rel, sha256: row.sha256, bytes: row.bytes, trash_name: trashName, by }, this.now());
    this.store.fileGoneNow(row.id, this.now());
    if (this.onRemoved) {
      try { this.onRemoved(id, row, { keep: keepRow, reason }); } catch {}
    }
    return id;
  }

  // Merge references inside Grabbit's own folders: two identical files become
  // one stored file with two names (a hard link), so every library entry that
  // uses either name keeps working. The extra copy's original goes to the
  // trash (restorable); the space comes back when the trash is emptied.
  async mergeLocal(dropId, keepId, { by = null } = {}) {
    const row = this.store.dupeFile(dropId);
    const keepRow = this.store.dupeFile(keepId);
    if (!row || !keepRow || !row.sha256 || row.sha256 !== keepRow.sha256) throw new TrashError('These copies are not identical any more; scan again');
    for (const x of [row, keepRow]) {
      const r = this.rootOf(x.root);
      if (!r || r.owner !== 'grabbit') throw new TrashError(r && r.app ? `${r.app} owns ${path.basename(x.rel)}` : 'Unknown folder');
    }
    const doomed = realFileOf(row);
    const kept = realFileOf(keepRow);
    if (doomed.stat.dev !== kept.stat.dev) throw new TrashError('The copies are on different disks, so they cannot share one file');
    if (doomed.stat.ino === kept.stat.ino) throw new TrashError('Already stored once');
    const [a, b] = await Promise.all([sha256Of(doomed.abs), sha256Of(kept.abs)]);
    if (a !== row.sha256 || b !== row.sha256) throw new TrashError('The bytes no longer match; scan again first');
    const id = this.moveToTrash(row, doomed, { by, keepRow, reason: 'merged' });
    try {
      fs.linkSync(kept.abs, doomed.abs);
    } catch (e) {
      // Put the original back; the merge did not happen.
      try { this.restore(id); } catch {}
      throw new TrashError(`The files could not share one copy (${e.code || e.message}); nothing changed`);
    }
    try { this.store.fileSeen(row.root, row.rel, fs.statSync(doomed.abs), this.now()); } catch {}
    return id;
  }

  // Removes the suggested extra copies of the given groups (all open groups
  // when none are named). One file at a time; a failure skips that copy only.
  async removeAll({ by = null, dryRun = false, sha256s = null, reason = null } = {}) {
    const groups = sha256s
      ? sha256s.map((s) => ({ sha256: s, members: this.store.dupeMembers(s) })).filter((g) => g.members.length > 1)
      : this.store.openDupeGroups();
    const out = { groups: 0, files: 0, bytes: 0, failed: [] };
    for (const g of groups) {
      const p = planGroup(g.members, this.rootOf);
      const go = p.members.filter((m) => m.suggested);
      if (!go.length) continue;
      out.groups++;
      for (const m of go) {
        const row = g.members.find((x) => x.id === m.id);
        if (dryRun) {
          out.files++;
          out.bytes += row.bytes;
          continue;
        }
        try {
          await this.remove(m.id, { by, plannedKeep: p.keepId, reason });
          out.files++;
          out.bytes += row.bytes;
        } catch (e) {
          out.failed.push({ id: m.id, rel: row.rel, error: e.message });
        }
      }
    }
    return out;
  }

  held() {
    const hold = this.holdMs;
    return this.store.trashHeld().map((t) => ({ ...t, purgeAt: hold ? t.at + hold : null }));
  }

  // The trashed file of an entry, checked: the stored name must be a plain
  // file name, and its real path must sit directly in the trash folder. A
  // database row can never point this at another path.
  trashedFile(t) {
    const name = String(t.trash_name || '');
    if (!name || name !== path.basename(name) || name === '.' || name === '..' || name.includes('\0')) {
      throw new TrashError('Not a trash entry');
    }
    const abs = path.join(this.dir, name);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    if (!st.isFile()) throw new TrashError('Not a regular file in the trash');
    const realDir = fs.realpathSync(this.dir);
    if (path.dirname(fs.realpathSync(abs)) !== realDir) throw new TrashError('Outside the trash folder');
    return { abs, stat: st };
  }

  // Deletes one held entry for good. Only a file inside the trash folder,
  // recorded in the trash table, not restored and not purged, can go. A file
  // whose bytes are back in service under its original path is refused: the
  // restore did not get recorded, and deleting it could take a live copy.
  deletePermanently(trashId) {
    const t = this.store.trashGet(trashId);
    if (!t || t.restored_at || t.purged_at) throw new TrashError('Not in the trash');
    return this.deleteRow(t);
  }

  deleteRow(t) {
    const f = this.trashedFile(t);
    if (f) {
      if (t.root && t.rel) {
        try {
          const live = fs.statSync(path.resolve(t.root, t.rel));
          if (live.ino === f.stat.ino && live.dev === f.stat.dev) throw new TrashError('This file is in use at its original place');
        } catch (e) {
          if (e instanceof TrashError) throw e;
        }
      }
      fs.unlinkSync(f.abs);
    }
    this.store.trashPurged(t.id, this.now());
    return { id: t.id, bytes: f ? f.stat.size : 0 };
  }

  // Empties the whole trash. `expect` ({ files, bytes }) is what the owner
  // confirmed; if the trash changed since, nothing is deleted.
  emptyAll(expect) {
    const held = this.store.trashHeld();
    const bytes = held.reduce((n, t) => n + t.bytes, 0);
    if (!expect || Number(expect.files) !== held.length || Number(expect.bytes) !== bytes) {
      throw new TrashError('The trash changed since you opened it; check it again');
    }
    const out = { files: 0, bytes: 0, failed: [] };
    for (const t of held) {
      try {
        const r = this.deletePermanently(t.id);
        out.files++;
        out.bytes += r.bytes;
      } catch (e) {
        out.failed.push({ id: t.id, error: e.message });
      }
    }
    return out;
  }

  restore(trashId) {
    const t = this.store.trashGet(trashId);
    if (!t || t.restored_at || t.purged_at) throw new TrashError('Not in the trash');
    const r = this.rootOf(t.root);
    if (!r) throw new TrashError('Its folder is no longer scanned');
    const root = path.resolve(t.root);
    const abs = path.resolve(root, t.rel);
    if (!abs.startsWith(root + path.sep)) throw new TrashError('Path outside its folder');
    const f = this.trashedFile(t);
    if (!f) throw new TrashError('The trashed file is missing');
    const from = f.abs;
    // A merged copy: its name now points at the kept file (a hard link). The
    // link goes, and the original comes back under its own name.
    const meta = this.mergeOf ? this.mergeOf(t.id) : null;
    if (meta && meta.keep_root && meta.keep_rel) {
      try {
        const live = fs.lstatSync(abs);
        const keep = fs.statSync(path.resolve(meta.keep_root, meta.keep_rel));
        if (live.isFile() && live.ino === keep.ino && live.dev === keep.dev) fs.unlinkSync(abs);
      } catch {}
    }
    // A newer file in its place is never overwritten: the copy comes back
    // beside it as "name (restored).ext", "name (restored 2).ext", ...
    let target = abs;
    for (let n = 1; fs.existsSync(target); n++) {
      if (n > 50) throw new TrashError('Too many files with that name are back in its place');
      const ext = path.extname(abs);
      target = path.join(path.dirname(abs), `${path.basename(abs, ext)} (restored${n > 1 ? ` ${n}` : ''})${ext}`);
    }
    const restoredRel = path.relative(root, target);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const realRoot = fs.realpathSync(root);
    if (fs.realpathSync(path.dirname(abs)) !== path.join(realRoot, path.relative(root, path.dirname(abs)))) {
      throw new TrashError('Path runs through a symlink');
    }
    moveFile(from, target);
    this.store.trashRestored(t.id, this.now());
    try { this.store.fileSeen(t.root, restoredRel, fs.statSync(target), this.now()); } catch {}
    return { ...t, restoredRel, renamed: target !== abs };
  }

  // Deletes trashed files past the hold time. Returns how many.
  purge() {
    const hold = this.holdMs;
    if (!hold) return 0; // manual cleanup only
    let n = 0;
    for (const t of this.store.trashDue(this.now() - hold)) {
      try {
        this.deleteRow(t);
        n++;
      } catch {
        // Left for the owner to look at.
      }
    }
    return n;
  }
}

module.exports = { DupeTrash, TrashError, planGroup, checkRemoval, HOLD_MS, realFileOf, sha256Of };
