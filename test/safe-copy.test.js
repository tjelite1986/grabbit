'use strict';
// copyInto() against a folder swapped for a symlink in the window between a
// path check and the open it guards. The _hooks seam runs the swap exactly
// there, so these are deterministic rather than timing races.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyInto } = require('../safe-copy');

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-safe-copy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const d = {
    src: path.join(base, 'src'),
    dst: path.join(base, 'dst'),
    outside: path.join(base, 'outside'),
    parked: path.join(base, 'parked'),
  };
  for (const p of Object.values(d)) fs.mkdirSync(p);
  fs.mkdirSync(path.join(d.src, 'user'));
  fs.writeFileSync(path.join(d.src, 'user', 'a.jpg'), 'real bytes');
  fs.mkdirSync(path.join(d.dst, 'user'));
  return d;
}

const listAll = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

test('copies a file into place', (t) => {
  const d = setup(t);
  const out = copyInto(path.join(d.src, 'user', 'a.jpg'), path.join(d.dst, 'user'), 'a.jpg', { root: d.dst, srcRoot: d.src, mode: 0o600 });
  assert.equal(out, path.join(d.dst, 'user', 'a.jpg'));
  assert.equal(fs.readFileSync(out, 'utf8'), 'real bytes');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(listAll(path.join(d.dst, 'user')), ['a.jpg'], 'no temp left behind');
});

test('a target folder swapped for a symlink after the check is caught, nothing lands outside', (t) => {
  const d = setup(t);
  const user = path.join(d.dst, 'user');
  assert.throws(
    () => copyInto(path.join(d.src, 'user', 'a.jpg'), user, 'a.jpg', {
      root: d.dst,
      srcRoot: d.src,
      _hooks: {
        beforeTmpOpen() {
          fs.renameSync(user, path.join(d.parked, 'user'));
          fs.symlinkSync(d.outside, user);
        },
      },
    }),
    /refused/,
  );
  assert.deepEqual(listAll(d.outside), [], 'the empty temp created through the link was removed');
  assert.deepEqual(listAll(path.join(d.parked, 'user')), []);
});

test('a source folder swapped for a symlink after the check is caught, no outside bytes are copied', (t) => {
  const d = setup(t);
  fs.writeFileSync(path.join(d.outside, 'a.jpg'), 'secret bytes');
  const srcUser = path.join(d.src, 'user');
  assert.throws(
    () => copyInto(path.join(srcUser, 'a.jpg'), path.join(d.dst, 'user'), 'a.jpg', {
      root: d.dst,
      srcRoot: d.src,
      _hooks: {
        beforeSrcOpen() {
          fs.renameSync(srcUser, path.join(d.parked, 'user'));
          fs.symlinkSync(d.outside, srcUser);
        },
      },
    }),
    /refused/,
  );
  assert.deepEqual(listAll(path.join(d.dst, 'user')), []);
  assert.equal(fs.readFileSync(path.join(d.outside, 'a.jpg'), 'utf8'), 'secret bytes');
});

test('a source file replaced between the check and the open is refused', (t) => {
  const d = setup(t);
  const src = path.join(d.src, 'user', 'a.jpg');
  assert.throws(
    () => copyInto(src, path.join(d.dst, 'user'), 'a.jpg', {
      root: d.dst,
      srcRoot: d.src,
      _hooks: {
        beforeSrcOpen() {
          // Write the replacement first so it cannot reuse the old inode.
          fs.writeFileSync(`${src}.new`, 'other bytes');
          fs.renameSync(`${src}.new`, src);
        },
      },
    }),
    /changed while it was opened/,
  );
  assert.deepEqual(listAll(path.join(d.dst, 'user')), []);
});
