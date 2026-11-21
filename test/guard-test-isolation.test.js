'use strict';
// A guard for the test suite itself: every test that boots server.js must
// give it its own DATA_DIR and DOWNLOAD_DIR and fake downloader binaries, and
// must build the child environment from scratch. A test that spread
// process.env, or left DATA_DIR unset, would write into the repo's ./data and
// ./downloads (the server's defaults) or into whatever a developer's shell
// points at, which can be a real library.
//
// This is a TEXT check of the test sources: it proves the words are there,
// not that the values point into a temp directory. The real isolation lives in
// test/helpers/guard-server.js, which builds the environment itself; this
// guard catches a new test that forgets to, or that spreads process.env.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

function sourcesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourcesUnder(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every test that boots server.js isolates its storage and downloaders', () => {
  const spawners = sourcesUnder(TEST_DIR).filter((f) => /['"]server\.js['"]/.test(fs.readFileSync(f, 'utf8')) && /spawn\(/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(spawners.length >= 10, `expected the server-level tests, found ${spawners.length}`);
  for (const f of spawners) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(TEST_DIR, f);
    assert.match(src, /DATA_DIR\s*:/, `${rel}: no DATA_DIR for the server`);
    assert.match(src, /DOWNLOAD_DIR\s*:/, `${rel}: no DOWNLOAD_DIR for the server`);
    assert.match(src, /YTDLP_BIN\s*:/, `${rel}: the real yt-dlp could run`);
    assert.match(src, /loopback-listen/, `${rel}: preload test/fixtures/loopback-listen.js, or the server listens on every interface`);
    assert.doesNotMatch(src, /\.\.\.process\.env\b/, `${rel}: inherits the whole parent environment`);
    assert.doesNotMatch(src, /env\s*:\s*process\.env\b/, `${rel}: inherits the whole parent environment`);
  }
});

test('in-process tests never point the server defaults at the repo', () => {
  // Tests that require modules directly must not set DATA_DIR/DOWNLOAD_DIR to
  // a path inside the repository.
  for (const f of sourcesUnder(TEST_DIR)) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /process\.env\.(DATA_DIR|DOWNLOAD_DIR)\s*=\s*['"`](\.|\/app|\/data)/, path.relative(TEST_DIR, f));
  }
});
