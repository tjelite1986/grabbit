'use strict';
// Publishing a downloaded image into a posts drop folder (Grabbit 3.0 phase 2).
//
// Used by server.js saveImageToPosts(). Kept apart so the rules can be tested
// without a server:
//   - the image is staged under a dot-name (importers skip dotfiles) and
//     renamed last, after its sidecar, so an importer never sees half a picture
//     or a picture without its caption;
//   - publishing one name (existence check, sidecar, rename) is one step,
//     serialized per name with withNameLock();
//   - in Elitogram mode the sidecar is keyed by stem (`<stem>.json`, which is
//     what Elitogram's importer reads for `<stem>.<any ext>`), so an image
//     already published under the stem with another extension is reused rather
//     than given a second, competing sidecar;
//   - a name is not proof of identity: the sidecar records the source id, and
//     an image under the stem is reused only when its sidecar names the same
//     source. Another source gets `<stem>_<id10>` instead.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Extensions a published posts image may have.
const POSTS_IMAGE_EXT = /^\.(jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?)$/i;

// The image already published under a stem in a drop folder, whatever its
// extension: a regular file whose name minus its final extension is exactly
// the stem (titles keep dots, so `shot.2.jpg` is not under `shot`) and whose
// extension is an image's. Sidecars, dotfiles and staged parts are not images.
function stemImage(dir, stem) {
  try {
    return (
      fs.readdirSync(dir).find((f) => {
        const dot = f.lastIndexOf('.');
        if (dot <= 0 || f.startsWith('.') || f.slice(0, dot) !== stem || !POSTS_IMAGE_EXT.test(f.slice(dot))) return false;
        try {
          return fs.lstatSync(path.join(dir, f)).isFile();
        } catch {
          return false;
        }
      }) || null
    );
  } catch {
    return null;
  }
}

// A stable id for the source of an image: the site's media id when the
// extractor gave one, else the direct address without its query (signed CDN
// tokens change between saves).
function sourceId(job) {
  const site = String(job.site || job.extractor || 'web').toLowerCase();
  let basis;
  if (job.mediaId) basis = `${site}:m:${job.mediaId}`;
  else {
    let u = String(job.url || job.sourceUrl || '');
    try {
      const x = new URL(u);
      u = `${x.origin}${x.pathname}`;
    } catch { /* keep as is */ }
    basis = `${site}:u:${u}`;
  }
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

// The source id a stem's sidecar records, or null.
function sourceIdOf(sidecarPath) {
  try {
    const j = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    return j && typeof j.source_id === 'string' ? j.source_id : null;
  } catch {
    return null;
  }
}

// The name a source gets when its usual name is held by another source.
const altStem = (stem, id) => `${stem}_${String(id).slice(0, 10)}`;

// A sidecar written whole or not at all: a dot-named temp file (both importers
// skip dotfiles), fsynced, then renamed over the target.
function writeSidecar(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// One holder at a time per name; the rest wait in order.
function createNameLock() {
  const locks = new Map();
  return async function withNameLock(name, fn) {
    const prev = locks.get(name) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    locks.set(name, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(name) === tail) locks.delete(name);
    }
  };
}

// Publishes the staged file `partPath` as `<stem>.<ext>` in `dir`.
//   egram     Elitogram mode: stem-keyed sidecar, source identity
//   id        the source id (Elitogram mode)
//   sidecar() builds the sidecar; called inside the lock, so it may re-check
//             the audience and throw to refuse
//   lock      withNameLock from createNameLock()
// -> the published file name (an existing one when it was reused). The staged
// file is left for the caller to remove.
async function publish({ dir, stem, ext, partPath, egram, id, sidecar, lock }) {
  const outName = `${stem}.${ext}`;
  const finalPath = path.join(dir, outName);
  const sidecarPath = egram ? path.join(dir, `${stem}.json`) : `${finalPath}.json`;
  return lock(egram ? sidecarPath : finalPath, () => {
    let pubStem = stem;
    let pubFinal = finalPath;
    let pubSidecar = sidecarPath;
    let existing = egram ? stemImage(dir, stem) : fs.existsSync(finalPath) ? outName : null;
    if (existing && egram && sourceIdOf(sidecarPath) !== id) {
      pubStem = altStem(stem, id);
      pubFinal = path.join(dir, `${pubStem}.${ext}`);
      pubSidecar = path.join(dir, `${pubStem}.json`);
      existing = stemImage(dir, pubStem);
      if (existing && sourceIdOf(pubSidecar) !== id) throw new Error(`The posts drop name ${pubStem} is held by another source`);
    }
    if (existing) return existing;
    const value = sidecar();
    writeSidecar(pubSidecar, egram ? { ...value, source_id: id } : value);
    try {
      fs.renameSync(partPath, pubFinal);
    } catch (e) {
      // This attempt wrote the sidecar and holds the lock, so it is ours to
      // remove, unless an image under the stem is there after all.
      if (!fs.existsSync(pubFinal) && !(egram && stemImage(dir, pubStem))) fs.rmSync(pubSidecar, { force: true });
      throw e;
    }
    return `${pubStem}.${ext}`;
  });
}

module.exports = { POSTS_IMAGE_EXT, stemImage, sourceId, sourceIdOf, altStem, writeSidecar, createNameLock, publish };
