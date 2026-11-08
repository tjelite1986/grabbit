'use strict';
// Copying files between trees that other parties can write to (the phone's
// drop folder, an app's import folder) without being steered out of them by a
// symlink or a swapped folder. Linux only: the descriptor pin reads
// /proc/self/fd.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// When Grabbit runs as root (the container does), a folder or file it creates
// in another app's import tree would be root-owned, and that app could not
// move it on. Both take the owner of `ownerRef` (the app's import root). The
// change goes through a descriptor (files) or lchown (folders), never a path a
// user of that tree could swap for a symlink in between.
function ownerOf(ownerRef) {
  if (!ownerRef || typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const { uid, gid } = fs.statSync(ownerRef);
  return { uid, gid };
}

// Refuses unless `dir` is a real directory at the place its name says, below
// `root`: no component under the root may be a symlink, and the resolved path
// must equal the root's resolved path plus the same relative part. The root
// itself may be a symlink or a mount; what lies below it is someone else's tree
// (the phone's drop folder, an app's import folder) and is not trusted.
function assertRealDirUnder(root, dir) {
  const rel = path.relative(root, dir);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${dir} is not below ${root}`);
  }
  let p = root;
  for (const part of rel.split(path.sep)) {
    p = path.join(p, part);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${p} is a symlink; refused`);
    if (!st.isDirectory()) throw new Error(`${p} is not a directory; refused`);
  }
  if (fs.realpathSync(dir) !== path.join(fs.realpathSync(root), rel)) {
    throw new Error(`${dir} does not resolve below ${root}; refused`);
  }
}

// Where an open descriptor really points, as the kernel sees it now. The path
// checks above run on names, and a folder can be swapped between a check and
// the open; this reads the answer off the descriptor itself, so it cannot be
// raced. Node has no openat(), so this is the pin.
function fdRealPath(fd) {
  const p = fs.readlinkSync(`/proc/self/fd/${fd}`);
  if (p.endsWith(' (deleted)')) throw new Error('descriptor points at a deleted file; refused');
  return p;
}

// Refuses unless the open descriptor `fd` is the file `base` directly inside
// the real folder `realDir`.
function assertFdAt(fd, realDir, base) {
  const at = fdRealPath(fd);
  if (at !== path.join(realDir, base)) throw new Error(`opened file is at ${at}, not in ${realDir}; refused`);
}

// Copies a file into `dir` under `name`: a dot-named temp first (every importer
// ignores dotfiles), created exclusively and never through a symlink, fsync,
// then an atomic rename. Works across mounts.
// `root` is the tree `dir` must stay in, `srcRoot` the tree `src` must come
// from; both are checked right before use. The source is opened without
// following a symlink and must be a regular file (a FIFO or a device would
// otherwise hang or stream forever).
// Each check by name is followed by a check on the descriptor that was opened
// (where it really is, and that it is the same inode the name pointed at), so a
// folder swapped for a symlink between check and open is caught, not followed.
// `_hooks` is a test seam only: named callbacks run between a check and the
// operation it guards, so a test can swap a folder in exactly that window.
function copyInto(src, dir, name, { root, srcRoot, mtime = null, ownerRef = null, mode = 0o644, _hooks = {} } = {}) {
  if (!root || !srcRoot) throw new Error('copyInto needs root and srcRoot');
  const owner = ownerOf(ownerRef);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
    if (owner) fs.lchownSync(dir, owner.uid, owner.gid);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const tmp = path.join(dir, `.${name}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const final = path.join(dir, name);
  const C = fs.constants;
  let fd = null;
  let inFd = null;
  let created = false;
  try {
    const srcDirRel = path.relative(srcRoot, path.dirname(src));
    const dirRel = path.relative(root, dir);
    assertRealDirUnder(srcRoot, path.dirname(src));
    const srcSt = fs.lstatSync(src);
    if (_hooks.beforeSrcOpen) _hooks.beforeSrcOpen();
    inFd = fs.openSync(src, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const inSt = fs.fstatSync(inFd);
    if (!inSt.isFile()) throw new Error(`${src} is not a regular file; refused`);
    if (inSt.dev !== srcSt.dev || inSt.ino !== srcSt.ino) throw new Error(`${src} changed while it was opened; refused`);
    assertFdAt(inFd, path.join(fs.realpathSync(srcRoot), srcDirRel), path.basename(src));
    assertRealDirUnder(root, dir);
    if (_hooks.beforeTmpOpen) _hooks.beforeTmpOpen();
    fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
    created = true;
    if (_hooks.afterTmpOpen) _hooks.afterTmpOpen();
    // If the folder was swapped between the check and the open, the empty temp
    // was created elsewhere: refuse before a byte is written, and remove it
    // there only while it still carries our random temp name. The tree's owner
    // can rename the file and swap folders again, so never unlink a name the
    // descriptor reports otherwise: a file with this name can only be ours.
    const realDir = path.join(fs.realpathSync(root), dirRel);
    try {
      assertFdAt(fd, realDir, path.basename(tmp));
    } catch (e) {
      try {
        const at = fdRealPath(fd);
        if (path.basename(at) === path.basename(tmp)) fs.unlinkSync(at);
      } catch { /* best effort */ }
      throw e;
    }
    fs.fchmodSync(fd, mode);
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(inFd, buf, 0, buf.length, null)) > 0) fs.writeSync(fd, buf, 0, n);
    fs.closeSync(inFd);
    inFd = null;
    fs.fsyncSync(fd);
    if (mtime) fs.futimesSync(fd, mtime, mtime);
    if (owner) fs.fchownSync(fd, owner.uid, owner.gid);
    // The folder could have been swapped while the bytes went over. No check
    // after the rename: the app's importer may already have moved the file on.
    // A swap between this check and the rename makes the rename miss (the temp
    // name is random and exists only in the real folder), not land elsewhere.
    assertRealDirUnder(root, dir);
    assertFdAt(fd, realDir, path.basename(tmp));
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, final);
    created = false;
  } catch (e) {
    if (inFd !== null) try { fs.closeSync(inFd); } catch { /* already closed */ }
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
    if (created) fs.rmSync(tmp, { force: true });
    throw e;
  }
  return final;
}

module.exports = { copyInto, assertRealDirUnder, fdRealPath };
