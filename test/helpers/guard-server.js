'use strict';
// Shared harness for the guard and contract tests (phase 1). It boots a real
// server.js process in a throw-away directory, the same way test/contract.test.js
// and test/audience-gate.test.js do, so a test exercises the real routes and
// middleware without importing server.js (which is not a module).
//
// Isolation rules, enforced here so each test cannot forget them:
//  - every path the server writes (DATA_DIR, DOWNLOAD_DIR, the app roots,
//    TMPDIR and HOME) is under one mkdtemp directory, removed after the test
//    once the server process has exited;
//  - the environment is built from scratch: PATH from the parent, plus the
//    variables set in boot() below and the test's own `env` overrides.
//    Nothing else from the developer's shell or a real install leaks in;
//  - the server listens on 127.0.0.1 only, on a port the OS picks
//    (test/fixtures/loopback-listen.js, preloaded), so it is never reachable
//    from the LAN;
//  - yt-dlp, gallery-dl, ffmpeg, ffprobe and python3 are /bin/false or a
//    local fake, so nothing is ever downloaded and no installed tool runs;
//  - with `media: true` downloads are served by a loopback server in this
//    process (the fake extractors in test/fixtures/fake-extractors.js point at
//    it), so no external network is used.
//
// This file has no side effects when it is loaded on its own (node --test
// also loads every .js file under test/).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..', '..');
const PASSWORD = 'guard-test-password';
const INTERNAL_TOKEN = 'guard-internal-test-value';
const REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_PRELOAD = path.join(REPO, 'test', 'fixtures', 'loopback-listen.js');

// A loopback media server. `mode` changes how /media/* answers:
//   'ok'   - 200 with unique bytes (default)
//   404    - (or any number) that status with no body
//   'hold' - the request waits until release() or releaseOne() answers it
// `paths` lists every request path in arrival order; with the fake extractors
// a path is /media/<item id>/clip.mp4, so it names the job.
function mediaServer() {
  let served = 0;
  const held = [];
  const state = { mode: 'ok', requests: 0, paths: [] };
  const answer = (req, res) => {
    served++;
    const body = Buffer.from(`fixture ${req.url} ${served} ${Math.random()}`);
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'Content-Length': body.length });
    res.end(body);
  };
  const srv = http.createServer((req, res) => {
    state.requests++;
    state.paths.push(req.url);
    if (state.mode === 'hold') return held.push({ path: req.url, go: () => answer(req, res) });
    if (typeof state.mode === 'number') {
      res.writeHead(state.mode);
      return res.end();
    }
    answer(req, res);
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        base: `http://127.0.0.1:${srv.address().port}`,
        heldCount: () => held.length,
        heldPaths: () => held.map((h) => h.path),
        // Answer the held request for `path` (or the oldest one).
        releaseOne(path) {
          const i = path ? held.findIndex((h) => h.path === path) : 0;
          if (i < 0) throw new Error(`no held request for ${path}; held: ${held.map((h) => h.path).join(', ')}`);
          held.splice(i, 1)[0].go();
        },
        release() {
          while (held.length) held.shift().go();
        },
        close() {
          this.release();
          srv.closeAllConnections && srv.closeAllConnections();
          return new Promise((r) => srv.close(() => r()));
        },
      });
    });
  });
}

// A fake yt-dlp that appends its argv (one JSON array per line) to argvLog.
// `-j` probes print the JSON in infoFile; anything else fails like a refused
// download, so a job that reaches the download step ends as failed.
function recordingYtdlp(dir) {
  const bin = path.join(dir, 'fake-yt-dlp');
  const argvLog = path.join(dir, 'yt-dlp-argv.jsonl');
  const infoFile = path.join(dir, 'yt-dlp-info.json');
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
if (args.includes('-j')) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(infoFile)}, 'utf8') + '\\n');
  process.exit(0);
}
process.stderr.write('ERROR: fake yt-dlp never downloads\\n');
process.exit(1);
`,
    { mode: 0o755 }
  );
  return {
    bin,
    argvLog,
    setInfo: (info) => fs.writeFileSync(infoFile, JSON.stringify(info)),
    calls: () => {
      try {
        return fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

// Every file under dir, relative, dotfiles included.
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

// Boot options:
//   seed(dataDir, root)  write state files before the server starts
//   env                  extra or overriding environment variables
//   internalToken        GRABBIT_INTERNAL_TOKEN (default INTERNAL_TOKEN; null = unset,
//                        and then the returned `internal` headers are null)
//   media                start the loopback media server and preload the fake
//                        extractors; also sets ALLOW_PRIVATE_ADDRESSES=true so
//                        the server may fetch from 127.0.0.1. The URL guard is
//                        OFF in a media boot: security tests never use media.
//   ytdlp                'false' (default) or 'record' (see recordingYtdlp)
//   apps                 configure the Shorts/platform app roots (default true)
async function boot(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-guard-'));
  // One cleanup hook, in a fixed order: stop the server and wait for it to
  // exit, close the media server, then remove the directory it was writing to.
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'data');
  const downloads = path.join(root, 'downloads');
  const tmp = path.join(root, 'tmp');
  const home = path.join(root, 'home');
  const apps = { tik: path.join(root, 'tik'), ads: path.join(root, 'ads'), plat: path.join(root, 'plat') };
  for (const d of [dataDir, downloads, tmp, home, ...Object.values(apps)]) fs.mkdirSync(d, { recursive: true });
  if (opts.seed) opts.seed(dataDir, root);

  let media = null;
  if (opts.media) {
    media = await mediaServer();
    cleanup.push(() => media.close());
  }
  const yt = opts.ytdlp === 'record' ? recordingYtdlp(root) : null;

  const env = {
    PATH: process.env.PATH,
    TMPDIR: tmp,
    HOME: home,
    PORT: '0',
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: downloads,
    GRABBIT_PASSWORD: PASSWORD,
    STATE_BACKUP_DAYS: '0',
    YTDLP_BIN: yt ? yt.bin : '/bin/false',
    GALLERY_DL_BIN: '/bin/false',
    FFMPEG_BIN: '/bin/false',
    FFPROBE_BIN: '/bin/false',
    PYTHON_BIN: '/bin/false',
    ...(opts.apps === false ? {} : { ELITE_ROOT: apps.ads, TIKSHORTIS_ROOT: apps.tik, PLATFORM_IMPORT_ROOT: apps.plat }),
    ...(media ? { FAKE_MEDIA_BASE: media.base, ALLOW_PRIVATE_ADDRESSES: 'true' } : {}),
    ...(opts.internalToken === null ? {} : { GRABBIT_INTERNAL_TOKEN: opts.internalToken || INTERNAL_TOKEN }),
    ...(opts.env || {}),
  };
  const preload = ['-r', LOOPBACK_PRELOAD, ...(media ? ['-r', path.join(REPO, 'test', 'fixtures', 'fake-extractors.js')] : [])];
  const proc = spawn(process.execPath, [...preload, 'server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  let spawnError = null;
  const exited = new Promise((resolve) => proc.once('close', resolve));
  proc.once('error', (e) => (spawnError = e));
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  cleanup.push(async () => {
    if (proc.exitCode !== null || proc.signalCode !== null || spawnError) return;
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  });
  const listening = () => /GUARD_LISTENING 127\.0\.0\.1 (\d+)/.exec(logs);
  for (let i = 0; i < 150; i++) {
    if (spawnError || proc.exitCode !== null) break;
    if (logs.includes('grabbit listening') && listening()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (spawnError) throw new Error(`server could not be spawned: ${spawnError.message}`);
  if (!logs.includes('grabbit listening') || !listening()) {
    throw new Error(`server did not start (exit ${proc.exitCode}, signal ${proc.signalCode}):\n${logs}`);
  }
  const base = `http://127.0.0.1:${listening()[1]}`;

  async function login(password = PASSWORD) {
    const r = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `password=${encodeURIComponent(password)}`,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const setCookie = r.headers.getSetCookie();
    const cookie = setCookie.map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth=') && v.length > 13) || null;
    return { status: r.status, cookie, setCookie, location: r.headers.get('location') };
  }
  const owner = await login();
  if (owner.status !== 302 || !owner.cookie) {
    throw new Error(`owner login failed (status ${owner.status}, Set-Cookie ${JSON.stringify(owner.setCookie)}):\n${logs}`);
  }
  const headers = { Cookie: owner.cookie, Accept: 'application/json' };
  // Only when a token is configured: a header object built from an unset
  // token would send the literal string "undefined".
  const internal = env.GRABBIT_INTERNAL_TOKEN ? { 'X-Grabbit-Token': env.GRABBIT_INTERNAL_TOKEN } : null;

  // fetch relative to the server, returning { status, body, text, headers }.
  async function call(p, { method = 'GET', headers: h = headers, body } = {}) {
    if (h === null) throw new Error(`call(${p}): headers are null; s.internal is null when boot() ran without an internal token`);
    const r = await fetch(`${base}${p}`, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: json, text, headers: r.headers };
  }

  // Start a background job and wait until it leaves the queue.
  async function runJob(query, h = headers) {
    const q = new URLSearchParams({ dest: 'elite', channel: 'main', device: '0', ...query });
    const started = await call(`/api/jobs/start?${q}`, { headers: h });
    if (started.status !== 200) return { started };
    const id = started.body.jobId;
    for (let i = 0; i < 150; i++) {
      const { body } = await call('/api/jobs');
      const j = body.jobs.find((x) => x.id === id);
      if (j && ['done', 'error', 'failed', 'cancelled'].includes(j.status)) return { started, job: j };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`job ${id} did not finish:\n${logs}`);
  }

  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  const fakeUrl = (kind, site, creator, id, extra = '') =>
    `http://fake.test/${kind}/${encodeURIComponent(site)}/${encodeURIComponent(creator)}/${encodeURIComponent(id)}${extra}`;

  return {
    base, root, dataDir, downloads, apps, media, yt, env, proc,
    logs: () => logs,
    login, headers, internal, call, runJob, readJson, fakeUrl,
  };
}

module.exports = { boot, filesUnder, PASSWORD, INTERNAL_TOKEN, FUTURE: () => Date.now() + 365 * 24 * 3600 * 1000 };
