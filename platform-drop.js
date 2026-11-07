'use strict';
// The `platform` shorts channel: a drop folder read by a social app's importer
// (drop-zone contract v1). Kept apart from server.js so the sidecar and the
// write order can be tested without a running server.
//
// Contract v1, as the importer reads it:
// - The media file is written first, then `<stem>.json` last. The sidecar's
//   presence is the signal that the item is complete.
// - Both appear by an atomic rename within the drop folder. Temp names start
//   with `.`: the importer ignores dotfiles, and moves any other file that no
//   sidecar names to failed/ after an hour.
// - The sidecar names its media file as a plain name in the same folder.
// - The importer takes video only, and keys duplicates on `source:sourceId`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONTRACT_VERSION = 1;

// Lowercase, [a-z0-9.-] only, at most 40 chars: the importer's `source` rule.
function platformSource(site) {
  const s = String(site || '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 40);
  return s || 'web';
}

// The site's own id when there is one. Without it, a hash of the source URL
// still keys the same link to the same post on a second save.
function platformSourceId(job) {
  const id = String(job.mediaId || '').trim();
  if (id) return id.slice(0, 200);
  return 'url-' + crypto.createHash('sha256').update(String(job.sourceUrl || job.url || '')).digest('hex').slice(0, 32);
}

const httpUrl = (u) => {
  try {
    const p = new URL(String(u));
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href.slice(0, 2000) : null;
  } catch {
    return null;
  }
};

// The creator the importer will file the post under, or null when the
// extractor found none. 'unknown' is the extractors' own fallback and would
// gather unrelated clips under one made-up profile.
function platformCreator(job) {
  const handle = String(job.creator || '').trim();
  if (!handle || handle.toLowerCase() === 'unknown') return null;
  return handle.slice(0, 100);
}

// Why this item cannot go to the platform drop folder, or null when it can.
function platformRefusal(job) {
  if (job.mediaType === 'image') return 'Platform takes videos only.';
  if (!platformCreator(job)) return 'Platform needs the clip\'s creator, and none was found.';
  return null;
}

// The sidecar for `fileName`, per contract v1.
function platformSidecar(job, fileName, cleanDescription = (d) => String(d || '').trim()) {
  const tags = [
    ...new Set(
      (Array.isArray(job.tags) ? job.tags : [])
        .map((t) => String(t).replace(/^#+/, '').trim())
        .filter(Boolean)
        .map((t) => t.slice(0, 100)),
    ),
  ].slice(0, 50);
  const caption = cleanDescription(job.description) || String(job.title || '').trim();
  return {
    version: CONTRACT_VERSION,
    file: fileName,
    source: platformSource(job.site),
    sourceId: platformSourceId(job),
    sourceUrl: httpUrl(job.sourceUrl),
    creator: {
      handle: platformCreator(job),
      name: null,
      profileUrl: httpUrl(job.creatorUrl),
    },
    caption: caption ? caption.slice(0, 2000) : null,
    tags,
  };
}

// Moves a finished media file into place, then writes the sidecar beside it
// under a dot-name and renames it in. The order is the contract: the importer
// treats the sidecar as "this item is complete".
function commitPlatformDrop(dir, buildPath, finalPath, sidecarName, sidecarText) {
  fs.renameSync(buildPath, finalPath);
  const tmp = path.join(dir, `.${sidecarName}.tmp-${process.pid}`);
  try {
    const fd = fs.openSync(tmp, 'w', 0o644);
    try {
      fs.writeSync(fd, sidecarText);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(dir, sidecarName));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    // Without its sidecar the clip would sit until the importer's orphan sweep
    // files it under failed/; take it back now so a retry starts clean.
    fs.rmSync(finalPath, { force: true });
    throw e;
  }
}

module.exports = {
  CONTRACT_VERSION,
  platformSource,
  platformSourceId,
  platformCreator,
  platformRefusal,
  platformSidecar,
  commitPlatformDrop,
};
