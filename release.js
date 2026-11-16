'use strict';
// Release identity: the git commit this image was built from. Reported by
// /api/health and /api/health/release so a deployer can prove which release
// answers. Only a 40-char lowercase hex string is ever reported; anything else
// (unset, "unknown", garbage) becomes null and is never echoed back.
const fs = require('fs');

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA_FILE = process.env.RELEASE_SHA_FILE || '/app/RELEASE_SHA';

function validSha(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return SHA_RE.test(s) ? s : null;
}

// The file written at build time wins over the env var: an env override in
// compose must not be able to change what the image claims to be.
function releaseSha(env = process.env, file = SHA_FILE) {
  let fromFile = null;
  try {
    fromFile = validSha(fs.readFileSync(file, 'utf8'));
  } catch { /* no file: not a release build */ }
  return fromFile || validSha(env.RELEASE_SHA);
}

module.exports = { releaseSha, validSha, SHA_RE };
