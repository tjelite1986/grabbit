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

// An import folder holds copies waiting for an app to take them in. It is
// marked `import` (and names its library in `importFor` when that is
// mounted); either marks it, so an unset destination still counts.
const isImport = (r) => Boolean(r && (r.import || r.importFor));

// rootOf(path) -> the scan root candidate ({ owner, importFor, ... }) or null.
function canRemoveFrom(member, members, rootOf) {
  const r = rootOf(member.root);
  if (!r) return { ok: false, why: 'Unknown folder' };
  if (r.owner === 'grabbit') return { ok: true };
  if (r.importFor && members.some((m) => m.id !== member.id && m.root === r.importFor)) return { ok: true };
  if (isImport(r)) return { ok: false, why: `Kept: ${r.app || 'the app'} has not imported it yet` };
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
  const anchors = fixed.filter((m) => !isImport(rootOf(m.root)));
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
  const lasting = members.filter((o) => o.id !== member.id && !isImport(rootOf(o.root)));
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

const rand = () => crypto.randomBytes(4).toString('hex');

// The first `max` BYTES of a name, cut on a code-point boundary: file systems
// limit a name to 255 bytes, and a CJK or emoji name is three to four bytes a
// character, so a cut by characters can still be too long.
function clampName(name, max) {
  if (Buffer.byteLength(name) <= max) return name;
  let out = '';
  let used = 0;
  for (const ch of name) {
    const n = Buffer.byteLength(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

// Copies `from` to a new file `to` without blocking the event loop: streamed
// to a .part beside the target, flushed, hashed on the way and compared with
// `sha256` (when given), then renamed into place. The source is not touched.
async function copyVerified(from, to, sha256 = null) {
  const part = path.join(path.dirname(to), `.${clampName(path.basename(to), 180)}.${rand()}.part`);
  try {
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part, { flags: 'wx' });
      const src = fs.createReadStream(from);
      src.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      src.on('data', (c) => h.update(c));
      out.on('finish', resolve);
      src.pipe(out);
    });
    const fd = fs.openSync(part, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const digest = h.digest('hex');
    if (sha256 && digest !== sha256) throw new TrashError('The copy does not match the original; nothing changed');
    // Publish without clobbering: a link fails on an existing name; rename
    // is the fallback only where the filesystem refuses hard links.
    try {
      fs.linkSync(part, to);
      fs.unlinkSync(part);
    } catch (e) {
      if (e.code === 'EEXIST') throw new TrashError('Target already exists');
      if (e.code !== 'EPERM' && e.code !== 'ENOTSUP' && e.code !== 'EXDEV') throw e;
      if (taken(to)) throw new TrashError('Target already exists');
      fs.renameSync(part, to);
    }
  } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    throw e;
  }
}

// Puts a second copy of `from` at the new path `to` and leaves `from` where
// it is: a hard link on the same disk, else a verified copy. Bind mounts make
// a link across folders fail with EXDEV even on one disk.
async function placeCopy(from, to, sha256 = null) {
  try {
    fs.linkSync(from, to);
    return;
  } catch (e) {
    if (e.code === 'EEXIST') throw new TrashError('Target already exists');
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
  }
  await copyVerified(from, to, sha256);
}

// Moves `from` to `to`: a rename where possible, else a verified copy and an
// unlink. The source goes last, so a failure at any step leaves it in place.
async function moveFile(from, to, sha256 = null) {
  if (taken(to)) throw new TrashError('Target already exists');
  // A hard link never replaces an existing name (EEXIST), unlike rename,
  // so a file or symlink that appears at `to` meanwhile is never clobbered.
  try {
    fs.linkSync(from, to);
    fs.unlinkSync(from);
    return;
  } catch (e) {
    if (e.code === 'EEXIST') throw new TrashError('Target already exists');
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
  }
  await copyVerified(from, to, sha256);
  fs.unlinkSync(from);
}

// True when the name exists in any form, a dangling symlink included
// (existsSync follows links and reports those as free).
function taken(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;

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

    return this.moveToTrash(row, doomed, { by, keepRow, reason });
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
    // A copy waiting in an import folder may still be moved, rejected or
    // deleted by its app, so it cannot be the copy that stays.
    const kr = this.rootOf(keepRow.root);
    if (!kr) throw new TrashError('The copy that stays is in an unknown folder');
    if (isImport(kr)) throw new TrashError(`The copy that stays is only waiting in ${kr.app || 'an app'}'s import folder; keep another copy`);
    const doomed = realFileOf(row);
    const kept = realFileOf(keepRow);
    if (doomed.stat.size !== row.bytes || kept.stat.size !== keepRow.bytes) throw new TrashError('A file changed since the scan; scan again first');
    const [a, b] = await Promise.all([sha256Of(doomed.abs), sha256Of(kept.abs)]);
    if (a !== row.sha256 || b !== keepRow.sha256) throw new TrashError('The bytes no longer match; scan again first');
    return this.moveToTrash(row, doomed, { by, keepRow, reason });
  }

  // Records a name whose inode changed but whose bytes are known (the
  // verified sha256): the row keeps its hash and its library link, instead
  // of dropping out of its group until the next hash pass.
  seenSame(row, rel, abs) {
    try {
      const seen = this.store.fileSeen(row.root, rel, fs.statSync(abs), this.now());
      if (seen && seen.hash && seen.row && row.sha256 && this.store.fileHashed) {
        this.store.fileHashed(seen.row.id, { sha256: row.sha256, link: row.link || 'none', itemId: row.item_id ?? null }, this.now());
      }
    } catch {}
  }

  trashNameFor(row) {
    fs.mkdirSync(this.dir, { recursive: true });
    return `${this.now()}-${row.id}-${rand()}-${clampName(path.basename(row.rel), 150)}`;
  }

  record(row, trashName, { by, keepRow, reason }) {
    const id = this.store.trashAdd({ file_id: row.id, root: row.root, rel: row.rel, sha256: row.sha256, bytes: row.bytes, trash_name: trashName, by }, this.now());
    if (this.onRemoved) {
      try { this.onRemoved(id, row, { keep: keepRow, reason }); } catch {}
    }
    return id;
  }

  async moveToTrash(row, doomed, { by, keepRow, reason }) {
    const trashName = this.trashNameFor(row);
    await moveFile(doomed.abs, path.join(this.dir, trashName), row.sha256);
    const id = this.record(row, trashName, { by, keepRow, reason });
    this.store.fileGoneNow(row.id, this.now());
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
    // The live name is never missing: a link to the kept file waits beside
    // it, the trash gets its own copy of the original (the original stays),
    // and one rename swaps the name over to the kept file.
    const tmp = path.join(path.dirname(doomed.abs), `.${clampName(path.basename(doomed.abs), 180)}.merge-${rand()}`);
    try {
      fs.linkSync(kept.abs, tmp);
    } catch (e) {
      throw new TrashError(`The files could not share one copy (${e.code || e.message}); nothing changed`);
    }
    const trashName = this.trashNameFor(row);
    const held = path.join(this.dir, trashName);
    try {
      await placeCopy(doomed.abs, held, row.sha256);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e instanceof TrashError ? e : new TrashError(`The original could not be kept in the trash (${e.code || e.message}); nothing changed`);
    }
    // Copying to another disk can take a while: if a writer replaced the
    // file meanwhile, the held copy is of the old bytes, so stop here.
    let now = null;
    try { now = fs.lstatSync(doomed.abs); } catch {}
    if (!now || !now.isFile() || !sameNode(now, doomed.stat) || now.size !== doomed.stat.size || now.mtimeMs !== doomed.stat.mtimeMs) {
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(held); } catch {}
      throw new TrashError('The file changed while it was being merged; nothing changed, scan again');
    }
    const id = this.record(row, trashName, { by, keepRow, reason: 'merged' });
    try {
      fs.renameSync(tmp, doomed.abs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(held); } catch {}
      this.store.trashPurged(id, this.now());
      throw new TrashError(`The files could not share one copy (${e.code || e.message}); nothing changed`);
    }
    this.seenSame(row, row.rel, doomed.abs);
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

  async restore(trashId) {
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
    // Every check comes before the first change: the folder must be inside
    // the root without a symlink on the way. A missing folder is checked at
    // its nearest existing parent, so no folder is made through a symlink.
    const realRoot = fs.realpathSync(root);
    const inside = (dir) => {
      try { return fs.realpathSync(dir) === path.join(realRoot, path.relative(root, dir)); } catch { return false; }
    };
    let probe = path.dirname(abs);
    while (probe !== root && !taken(probe)) probe = path.dirname(probe);
    if (!inside(probe)) throw new TrashError('Path runs through a symlink');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!inside(path.dirname(abs))) throw new TrashError('Path runs through a symlink');
    // A merged copy: its name now points at the kept file (a hard link). The
    // original replaces that link in one rename, so the name never goes
    // missing; it is staged beside it first (the trash may be on another disk).
    const meta = this.mergeOf ? this.mergeOf(t.id) : null;
    let replaceLink = false;
    let live = null;
    if (meta && meta.keep_root && meta.keep_rel) {
      try {
        live = fs.lstatSync(abs);
        const keep = fs.statSync(path.resolve(meta.keep_root, meta.keep_rel));
        replaceLink = live.isFile() && sameNode(live, keep);
      } catch {}
    }
    let target = abs;
    if (replaceLink) {
      // The trash keeps its copy until the original is back under its name:
      // a crash at any step leaves at worst one extra copy, never none.
      const stage = path.join(path.dirname(abs), `.${clampName(path.basename(abs), 180)}.restore-${rand()}`);
      await placeCopy(from, stage, t.sha256);
      // The staging may have taken a while: a file written to that name
      // meanwhile is newer than the link we checked and must not be replaced.
      let now = null;
      try { now = fs.lstatSync(abs); } catch {}
      if (!now || !sameNode(now, live)) {
        try { fs.unlinkSync(stage); } catch {}
        throw new TrashError('The file in its place changed while restoring; the trash still holds the original, try again');
      }
      try {
        fs.renameSync(stage, abs);
      } catch (e) {
        try { fs.unlinkSync(stage); } catch {}
        throw new TrashError(`The original could not be put back (${e.code || e.message}); the trash still holds it`);
      }
      // Recorded before the held copy goes, so a crash in between leaves an
      // extra copy in the trash folder rather than an active row with none.
      this.store.trashRestored(t.id, this.now());
      try {
        fs.unlinkSync(from);
      } catch (e) {
        console.error(`dupes: restored trash entry ${t.id}, but its trash copy stayed (${e.code || e.message})`);
      }
    } else {
      // A newer file in its place is never overwritten: the copy comes back
      // beside it as "name (restored).ext", "name (restored 2).ext", ...
      for (let n = 1; taken(target); n++) {
        if (n > 50) throw new TrashError('Too many files with that name are back in its place');
        const ext = path.extname(abs);
        target = path.join(path.dirname(abs), `${path.basename(abs, ext)} (restored${n > 1 ? ` ${n}` : ''})${ext}`);
      }
      await moveFile(from, target, t.sha256);
    }
    const restoredRel = path.relative(root, target);
    if (!replaceLink) this.store.trashRestored(t.id, this.now());
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

module.exports = { DupeTrash, TrashError, planGroup, checkRemoval, HOLD_MS, realFileOf, sha256Of, placeCopy, moveFile };
