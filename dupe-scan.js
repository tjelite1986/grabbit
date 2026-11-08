'use strict';
// The duplicate scan: walks Grabbit's own folders and the apps' media folders,
// reads every media file once and records its SHA-256 in items.db
// (file_hashes). Exact duplicates are then a GROUP BY.
//
// Read-only, by construction:
// - The only file system calls are opendir, lstat, realpath, open(O_RDONLY),
//   fstat, read and close. Nothing is created, renamed, chmod-ed or removed in
//   a scanned folder, and the scanner owns no folder of its own.
// - Symlinks are never followed (files or directories), and a file is opened
//   with O_NOFOLLOW and checked by inode, so a swapped path is not read.
// - O_NOATIME where the kernel allows it, so a read does not even touch atime.
//
// Gentle: one file at a time, reads throttled to `mbPerSec`, a pause between
// files, and the walk yields to the event loop. Pause stops within one chunk;
// the state ('running' / 'paused' / 'stopped') is stored in items.db, so a
// restart resumes where the owner left it. A file whose size, mtime or inode
// is unchanged since it was hashed is not read again.

const fs = require('fs');
const path = require('path');

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'vob', '3gp'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'm4b', 'wma', 'alac', 'aiff'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff'];
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]);
const VIDEO_SET = new Set(VIDEO_EXT);
const IMAGE_SET = new Set(IMAGE_EXT);
const CHUNK = 1024 * 1024;
const STATE_KEY = 'dupes.scan.state';
const LAST_PASS_KEY = 'dupes.scan.lastPassAt';
const O_NOATIME = fs.constants.O_NOATIME || 0;

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};
const stemOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
};

// Which names in one directory are media worth hashing: media extensions only,
// no hidden or half-written files, and no poster image beside a video of the
// same stem (an app's generated thumbnail is not a second copy of anything).
function mediaNames(names) {
  const videoStems = new Set(names.filter((n) => VIDEO_SET.has(extOf(n))).map(stemOf));
  return names.filter((n) => {
    if (n.startsWith('.') || /\.(part|tmp|crdownload)$/i.test(n) || /\.part-/i.test(n)) return false;
    const ext = extOf(n);
    if (!MEDIA_EXT.has(ext)) return false;
    if (IMAGE_SET.has(ext) && videoStems.has(stemOf(n))) return false;
    return true;
  });
}

const realOrNull = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// The roots to scan, from the configured folders: missing ones dropped, the
// same folder under two names kept once, and a folder inside another kept only
// as part of the outer one. `exclude` folders (the data dir, the inbox drop)
// are never entered.
function planRoots(candidates, exclude = []) {
  const ex = exclude.map(realOrNull).filter(Boolean);
  const list = [];
  for (const c of candidates) {
    if (!c || !c.path) continue;
    const real = realOrNull(c.path);
    if (!real) continue;
    if (ex.some((e) => inside(real, e))) continue;
    if (list.some((x) => x.real === real)) continue;
    list.push({ ...c, real });
  }
  return list.filter((r) => !list.some((o) => o !== r && inside(r.real, o.real) && o.real !== r.real))
    .map((r) => ({ ...r, excluded: ex.filter((e) => inside(e, r.real)) }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DupeScanner {
  // opts: store (item store), roots (from planRoots, or a function returning
  // them: planned again at every pass, so a folder mounted later is picked
  // up), mbPerSec, pauseMs, rescanMs, log
  constructor(opts) {
    this.store = opts.store;
    this.rootsFn = typeof opts.roots === 'function' ? opts.roots : () => opts.roots || [];
    this.roots = this.rootsFn();
    this.mbPerSec = Math.max(1, Number(opts.mbPerSec) || 20);
    this.pauseMs = Math.max(0, Number(opts.pauseMs != null ? opts.pauseMs : 25));
    this.rescanMs = Math.max(60_000, Number(opts.rescanMs) || 6 * 3600_000);
    this.log = opts.log || ((m) => console.log(`dupes: ${m}`));
    this.now = opts.now || Date.now;
    this.loop = null;
    this.current = null;
    this.phase = null;
    this.lastError = null;
    this.readBytes = 0;
  }

  get state() {
    return this.store.setting(STATE_KEY) || 'stopped';
  }

  // Resumes after a restart when the owner left it running.
  boot() {
    if (this.state === 'running') this.start();
  }

  start() {
    this.store.setSetting(STATE_KEY, 'running');
    if (!this.loop) {
      this.loop = this.run()
        .catch((e) => {
          this.lastError = e.message;
          this.log(`stopped on an error: ${e.message}`);
        })
        .finally(() => {
          this.loop = null;
          this.phase = null;
          this.current = null;
        });
    }
    return this.status();
  }

  pause() {
    this.store.setSetting(STATE_KEY, 'paused');
    return this.status();
  }

  running() {
    return this.state === 'running';
  }

  async run() {
    while (this.running()) {
      const last = Number(this.store.setting(LAST_PASS_KEY)) || 0;
      const todo = this.store.filesToHash(1).length;
      if (last && !todo && this.now() - last < this.rescanMs) {
        await this.idle(Math.min(60_000, this.rescanMs - (this.now() - last)));
        continue;
      }
      const complete = await this.pass();
      if (complete) this.store.setSetting(LAST_PASS_KEY, this.now());
    }
  }

  async idle(ms) {
    this.phase = 'waiting';
    const until = this.now() + ms;
    while (this.running() && this.now() < until) await sleep(Math.min(1000, ms));
  }

  // One walk of every root, then hash what is new or changed. Returns false
  // when paused part-way.
  async pass() {
    this.roots = this.rootsFn();
    for (const r of this.roots) {
      if (!this.running()) return false;
      await this.walkRoot(r);
    }
    this.phase = 'hashing';
    for (;;) {
      if (!this.running()) return false;
      const batch = this.store.filesToHash(20);
      if (!batch.length) break;
      for (const row of batch) {
        if (!this.running()) return false;
        await this.hashRow(row);
        if (this.pauseMs) await sleep(this.pauseMs);
      }
    }
    this.phase = null;
    this.current = null;
    return true;
  }

  // Records every media file under one root. Only a walk that finished marks
  // unseen files gone, and a root that is not there marks nothing: an
  // unmounted disk must not read as "every file deleted".
  async walkRoot(r) {
    this.phase = 'walking';
    this.current = { root: r.path, rel: null };
    const started = this.now();
    let st;
    try {
      st = fs.lstatSync(r.path);
    } catch {
      this.log(`${r.path} is not there; skipped this pass`);
      return;
    }
    if (!st.isDirectory()) return;
    const stack = [''];
    let n = 0;
    while (stack.length) {
      if (!this.running()) return;
      const relDir = stack.pop();
      const abs = path.join(r.path, relDir);
      let dir;
      try {
        dir = await fs.promises.opendir(abs);
      } catch (e) {
        this.log(`cannot list ${abs}: ${e.code || e.message}`);
        if (relDir === '') return;
        // A folder that cannot be read: its files are not "gone", so this
        // pass may not mark anything in this root.
        r._incomplete = true;
        continue;
      }
      const files = [];
      for await (const d of dir) {
        if (++n % 200 === 0) await new Promise((res) => setImmediate(res));
        if (d.isDirectory()) {
          const child = path.join(abs, d.name);
          if (r.excluded && r.excluded.some((e) => inside(child, e) || inside(realOrNull(child) || child, e))) continue;
          stack.push(path.join(relDir, d.name));
        } else if (d.isFile()) files.push(d.name);
        // Symlinks, sockets, FIFOs and devices are never read.
      }
      for (const name of mediaNames(files)) {
        const rel = path.join(relDir, name);
        let fst;
        try {
          fst = fs.lstatSync(path.join(r.path, rel));
        } catch {
          continue;
        }
        if (!fst.isFile()) continue;
        this.store.fileSeen(r.path, rel, fst, this.now());
      }
    }
    if (r._incomplete) {
      r._incomplete = false;
      return;
    }
    const gone = this.store.filesGoneBefore(r.path, started, this.now());
    if (gone) this.log(`${gone} file(s) no longer in ${r.path}`);
  }

  // Reads one file and records its hash. A file that changed since the walk
  // is recorded again instead (and hashed in a later batch).
  async hashRow(row) {
    const file = path.join(row.root, row.rel);
    this.current = { root: row.root, rel: row.rel };
    let fh;
    try {
      const lst = fs.lstatSync(file);
      if (!lst.isFile()) return this.store.fileHashed(row.id, { error: 'not a regular file' });
      if (lst.size !== row.bytes || Math.floor(lst.mtimeMs) !== row.mtime_ms || lst.ino !== row.ino) {
        this.store.fileSeen(row.root, row.rel, lst, this.now());
        return null;
      }
      fh = await openReadOnly(file);
      const fst = await fh.stat();
      if (fst.ino !== lst.ino || fst.dev !== lst.dev || !fst.isFile()) {
        return this.store.fileHashed(row.id, { error: 'the file changed while it was opened' });
      }
      const sha = await this.digest(fh);
      if (sha === null) return null; // paused mid-file
      const after = await fh.stat();
      if (after.size !== fst.size || after.mtimeMs !== fst.mtimeMs) {
        this.store.fileSeen(row.root, row.rel, after, this.now());
        return null;
      }
      const link = this.store.fileLink(path.basename(row.rel));
      return this.store.fileHashed(row.id, { sha256: sha, link: link.link, itemId: link.itemId }, this.now());
    } catch (e) {
      if (e.code === 'ENOENT') return null; // gone; the next walk records it
      return this.store.fileHashed(row.id, { error: e.code || e.message }, this.now());
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  async digest(fh) {
    const hash = require('crypto').createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    const bytesPerMs = (this.mbPerSec * 1024 * 1024) / 1000;
    let pos = 0;
    const t0 = this.now();
    for (;;) {
      if (!this.running()) return null;
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
      this.readBytes += bytesRead;
      const ahead = pos / bytesPerMs - (this.now() - t0);
      if (ahead > 5) await sleep(ahead);
    }
    return hash.digest('hex');
  }

  status() {
    const counts = this.store.scanCounts();
    const sum = (k) => counts.reduce((a, c) => a + (Number(c[k]) || 0), 0);
    return {
      state: this.state,
      active: Boolean(this.loop),
      phase: this.phase,
      current: this.current,
      lastPassAt: Number(this.store.setting(LAST_PASS_KEY)) || null,
      lastError: this.lastError,
      mbPerSec: this.mbPerSec,
      roots: this.roots.map((r) => {
        const c = counts.find((x) => x.root === r.path) || {};
        return {
          path: r.path,
          label: r.label,
          app: r.app || null,
          owner: r.owner,
          files: c.files || 0,
          hashed: c.hashed || 0,
          todo: c.todo || 0,
          errors: c.errors || 0,
          bytes: c.bytes || 0,
          hashedBytes: c.hashed_bytes || 0,
          linked: c.linked || 0,
          ambiguous: c.ambiguous || 0,
        };
      }),
      totals: {
        files: sum('files'),
        hashed: sum('hashed'),
        todo: sum('todo'),
        errors: sum('errors'),
        bytes: sum('bytes'),
        hashedBytes: sum('hashed_bytes'),
      },
    };
  }
}

async function openReadOnly(file) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  if (O_NOATIME) {
    try {
      return await fs.promises.open(file, flags | O_NOATIME);
    } catch (e) {
      if (e.code !== 'EPERM') throw e;
    }
  }
  return fs.promises.open(file, flags);
}

module.exports = { DupeScanner, planRoots, mediaNames, STATE_KEY, LAST_PASS_KEY };
