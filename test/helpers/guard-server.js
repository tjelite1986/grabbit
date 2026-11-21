'use strict';
// Shared harness for the guard and contract tests (phase 1). It boots a real
// server.js process in a throw-away directory, the same way test/contract.test.js
// and test/audience-gate.test.js do, so a test exercises the real routes and
// middleware without importing server.js (which is not a module).
//
// Isolation rules, enforced here so each test cannot forget them:
//  - every path the server writes (DATA_DIR, DOWNLOAD_DIR and the app roots)
//    is under one mkdtemp directory that t.after() removes;
//  - the environment is built from scratch (PATH only), so nothing from the
//    developer's shell or a real install leaks in;
//  - yt-dlp, gallery-dl, ffmpeg and ffprobe are /bin/false or a local fake, so
//    nothing is ever downloaded;
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
const net = require('net');

const REPO = path.join(__dirname, '..', '..');
const PASSWORD = 'guard-test-password';
const INTERNAL_TOKEN = 'guard-internal-test-value';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A loopback media server. `mode` changes how /media/* answers:
//   'ok'   - 200 with unique bytes (default)
//   404    - (or any number) that status with no body
//   'hold' - the request waits until release() is called, then answers 200
function mediaServer() {
  let served = 0;
  const held = [];
  const state = { mode: 'ok', requests: 0 };
  const answer = (req, res) => {
    served++;
    const body = Buffer.from(`fixture ${req.url} ${served} ${Math.random()}`);
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4', 'Content-Length': body.length });
    res.end(body);
  };
  const srv = http.createServer((req, res) => {
    state.requests++;
    if (state.mode === 'hold') return held.push(() => answer(req, res));
    if (typeof state.mode === 'number') {
      res.writeHead(state.mode);
      return res.end();
    }
    answer(req, res);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        base: `http://127.0.0.1:${srv.address().port}`,
        heldCount: () => held.length,
        release() {
          while (held.length) held.shift()();
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
//   internalToken        GRABBIT_INTERNAL_TOKEN (default INTERNAL_TOKEN; null = unset)
//   media                start the loopback media server and preload the fake extractors
//   ytdlp                'false' (default) or 'record' (see recordingYtdlp)
//   apps                 configure the Shorts/platform app roots (default true)
async function boot(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const downloads = path.join(root, 'downloads');
  const apps = { tik: path.join(root, 'tik'), ads: path.join(root, 'ads'), plat: path.join(root, 'plat') };
  for (const d of [dataDir, downloads, ...Object.values(apps)]) fs.mkdirSync(d, { recursive: true });
  if (opts.seed) opts.seed(dataDir, root);

  let media = null;
  if (opts.media) {
    media = await mediaServer();
    t.after(() => media.close());
  }
  const yt = opts.ytdlp === 'record' ? recordingYtdlp(root) : null;

  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    TMPDIR: os.tmpdir(),
    PORT: String(port),
    DATA_DIR: dataDir,
    DOWNLOAD_DIR: downloads,
    GRABBIT_PASSWORD: PASSWORD,
    STATE_BACKUP_DAYS: '0',
    YTDLP_BIN: yt ? yt.bin : '/bin/false',
    GALLERY_DL_BIN: '/bin/false',
    FFMPEG_BIN: '/bin/false',
    FFPROBE_BIN: '/bin/false',
    ...(opts.apps === false ? {} : { ELITE_ROOT: apps.ads, TIKSHORTIS_ROOT: apps.tik, PLATFORM_IMPORT_ROOT: apps.plat }),
    ...(media ? { FAKE_MEDIA_BASE: media.base, ALLOW_PRIVATE_ADDRESSES: 'true' } : {}),
    ...(opts.internalToken === null ? {} : { GRABBIT_INTERNAL_TOKEN: opts.internalToken || INTERNAL_TOKEN }),
    ...(opts.env || {}),
  };
  const argv = media ? ['-r', path.join(REPO, 'test', 'fixtures', 'fake-extractors.js'), 'server.js'] : ['server.js'];
  const proc = spawn(process.execPath, argv, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  t.after(() => proc.kill());
  for (let i = 0; i < 150 && !logs.includes('grabbit listening'); i++) await new Promise((r) => setTimeout(r, 100));
  if (!logs.includes('grabbit listening')) throw new Error(`server did not start:\n${logs}`);
  const base = `http://127.0.0.1:${port}`;

  async function login(password = PASSWORD) {
    const r = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `password=${encodeURIComponent(password)}`,
      redirect: 'manual',
    });
    const setCookie = r.headers.getSetCookie();
    const cookie = setCookie.map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth=') && v.length > 13) || null;
    return { status: r.status, cookie, setCookie };
  }
  const owner = await login();
  const headers = { Cookie: owner.cookie, Accept: 'application/json' };
  const internal = { 'X-Grabbit-Token': env.GRABBIT_INTERNAL_TOKEN };

  // fetch relative to the server, returning { status, body, text, headers }.
  async function call(p, { method = 'GET', headers: h = headers, body } = {}) {
    const r = await fetch(`${base}${p}`, { method, headers: h, body, redirect: 'manual' });
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
