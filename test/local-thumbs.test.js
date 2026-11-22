'use strict';
// History pictures under the provenance index (H34, H42, H47, H57, H69, H83,
// H94, H96): a picture is served or fetched only for a key the index knows,
// only to a view its strictest provenance allows, and made again from an
// entry's own downloaded file when the site's signed link has expired.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const profiles = require('../profiles');
const ti = require('../thumb-index');

const SHARED = 'local-thumbs-test-password';
const NOW = 1_700_000_000_000;
// Port 9 refuses: these behave like expired CDN links.
const DEAD = (n) => `http://127.0.0.1:9/expired-${n}.jpg`;
const key = (url) => crypto.createHash('sha1').update(url).digest('hex');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(3000)]);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A picture server that counts every request it gets.
function pictureServer(t) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const body = Buffer.from(`picture ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    t.after(() => srv.close());
    resolve({ hits, url: (name) => `http://127.0.0.1:${srv.address().port}/${name}` });
  }));
}

// `general` names creators the owner classified general by hand; `adult`
// names 18+ ones. Everyone else is unclassified.
async function boot(t, { history = [], thumbs = {}, files = {}, general = ['someone'], adult = [], index = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabbit-local-thumbs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const tik = path.join(root, 'tik');
  const drop = path.join(tik, 'main', '_import');
  fs.mkdirSync(path.join(data, 'thumbs'), { recursive: true });
  fs.mkdirSync(drop, { recursive: true });
  fs.writeFileSync(path.join(data, 'history.json'), JSON.stringify(history));
  let store = profiles.emptyStore();
  for (const name of general) store = profiles.create(store, { name, audience: 'general' }, NOW).store;
  for (const name of adult) store = profiles.create(store, { name, audience: 'adult' }, NOW).store;
  fs.writeFileSync(path.join(data, 'profiles.json'), JSON.stringify(store));
  if (index) fs.writeFileSync(path.join(data, 'thumb-index.json'), JSON.stringify(index));
  for (const [name, buf] of Object.entries(thumbs)) fs.writeFileSync(path.join(data, 'thumbs', name), buf);
  for (const [name, buf] of Object.entries(files)) {
    // 'folder/name' files a clip in a creator folder under main/, else in _import.
    const file = name.includes('/') ? path.join(tik, 'main', name) : path.join(drop, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof buf === 'function') buf(file);
    else fs.writeFileSync(file, buf);
  }
  const port = await freePort();
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'fixtures', 'loopback-listen.js'), 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      PATH: process.env.PATH, TMPDIR: os.tmpdir(), PORT: String(port), DATA_DIR: data, DOWNLOAD_DIR: path.join(root, 'downloads'),
      GRABBIT_PASSWORD: SHARED, STATE_BACKUP_DAYS: '0', YTDLP_BIN: '/bin/false', GALLERY_DL_BIN: '/bin/false',
      FFPROBE_BIN: '/bin/false', DUPES_SCAN: 'off', TIKSHORTIS_ROOT: tik, ALLOW_PRIVATE_ADDRESSES: 'true',
      ...(HAS_FFMPEG ? {} : { FFMPEG_BIN: '/bin/false' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => (logs += d));
  proc.stderr.on('data', (d) => (logs += d));
  t.after(() => proc.kill());
  for (let i = 0; i < 100 && !logs.includes('grabbit listening'); i++) await new Promise((r) => setTimeout(r, 100));
  if (!logs.includes('grabbit listening')) throw new Error(`server did not start:\n${logs}`);
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(SHARED)}`,
    redirect: 'manual',
  });
  const cookie = login.headers.getSetCookie().map((v) => v.split(';')[0]).find((v) => v.startsWith('grabbit_auth='));
  const thumb = (url, q = '') => fetch(`${base}/api/thumb?url=${encodeURIComponent(url)}&v=2${q}`, { headers: { Cookie: cookie } });
  const byId = (id, q = '') => fetch(`${base}/api/thumb?id=${id}&v=2${q}`, { headers: { Cookie: cookie } });
  // A conditional GET as a browser sends it (fetch() would add Cache-Control).
  const raw = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get(`${base}${p}`, { headers: { Cookie: cookie, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const post = (p, body) => fetch(`${base}${p}`, {
    method: 'POST', headers: { Cookie: cookie, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const readHistory = () => JSON.parse(fs.readFileSync(path.join(data, 'history.json'), 'utf8'));
  return { thumb, byId, raw, post, history: readHistory, base, data, thumbsDir: path.join(data, 'thumbs'), logs: () => logs };
}

const entry = (n, filename, extra = {}) => ({
  id: `170000000000${n}-${n}`, time: NOW + n, title: `clip ${n}`, creator: 'someone',
  channel: 'main', dest: 'elite', filename, thumbnail: DEAD(n), ...extra,
});
const tagged = (thumbsDir) => fs.readdirSync(thumbsDir).filter((n) => n.startsWith('keep-'));

test('an expired link is made again from the poster beside the downloaded video, and kept for that entry', async (t) => {
  const poster = JPEG();
  const e = entry(1, 'clip1.mp4');
  const s = await boot(t, { history: [e], files: { 'clip1.mp4': Buffer.alloc(10), 'clip1.jpg': poster } });
  const r = await s.thumb(DEAD(1));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), poster);
  assert.deepEqual(tagged(s.thumbsDir), [`keep-${ti.refTag(`h:${e.id}`)}-${key(DEAD(1))}.jpg`]);
});

test('a frame is taken from the video when there is no poster', { skip: !HAS_FFMPEG && 'no ffmpeg' }, async (t) => {
  const make = (file) => {
    const out = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=3:s=320x240:r=10', '-pix_fmt', 'yuv420p', file]);
    assert.equal(out.status, 0, String(out.stderr));
  };
  const e = entry(2, 'clip2.mp4');
  const s = await boot(t, { history: [e], files: { 'clip2.mp4': make } });
  const r = await s.thumb(DEAD(2));
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual(tagged(s.thumbsDir), [`keep-${ti.refTag(`h:${e.id}`)}-${key(DEAD(2))}.jpg`]);
});

test('no link and no file: refused once, then not asked for again for a while', async (t) => {
  const s = await boot(t, { history: [entry(3, 'gone.mp4')] });
  assert.equal((await s.thumb(DEAD(3))).status, 502);
  const again = await s.thumb(DEAD(3));
  assert.equal(again.status, 404);
  assert.match((await again.json()).error, /tried recently/);
  assert.deepEqual(fs.readdirSync(s.thumbsDir).filter((n) => !n.startsWith('quarantine-')), []);
});

test('a creator folder the importer filed in lower case is found', async (t) => {
  const poster = JPEG();
  const e = { ...entry(5, 'SomeOne_-_Clip.mp4'), creator: 'SomeOne' };
  const s = await boot(t, {
    history: [e], general: ['SomeOne'],
    files: { 'someone/SomeOne_-_Clip.web.mp4': Buffer.alloc(10), 'someone/SomeOne_-_Clip.jpg': poster },
  });
  const r = await s.thumb(DEAD(5));
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), poster);
});

test('an unindexed URL is never fetched (H34)', async (t) => {
  const pics = await pictureServer(t);
  const s = await boot(t);
  const r = await s.thumb(pics.url('nobody-recorded-this.jpg'));
  assert.equal(r.status, 404);
  const r2 = await s.thumb(pics.url('nobody-recorded-this.jpg'), '&audience=adult');
  assert.equal(r2.status, 404);
  assert.deepEqual(pics.hits, []);
});

test('18+ and unclassified pictures need the 18+ view; 18+ ones are never stored (H4, H42)', async (t) => {
  const pics = await pictureServer(t);
  const history = [
    entry(11, 'g.mp4', { thumbnail: pics.url('g.jpg') }),
    entry(12, 'a.mp4', { thumbnail: pics.url('a.jpg'), channel: '18plus', creator: 'Ada' }),
    entry(13, 'u.mp4', { thumbnail: pics.url('u.jpg'), creator: 'Stranger' }),
  ];
  const s = await boot(t, { history, adult: ['Ada'] });
  const g = await s.thumb(pics.url('g.jpg'));
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('cache-control'), 'private, no-cache');
  assert.ok(g.headers.get('etag'));
  for (const name of ['a.jpg', 'u.jpg']) {
    const before = pics.hits.length;
    const no = await s.thumb(pics.url(name));
    assert.equal(no.status, 404, name);
    assert.equal(pics.hits.length, before, `${name}: no outbound request for a refused key`);
    const yes = await s.thumb(pics.url(name), '&audience=adult');
    assert.equal(yes.status, 200, name);
    assert.equal(yes.headers.get('cache-control'), 'private, no-store');
    // A cache hit is gated the same way.
    assert.equal((await s.thumb(pics.url(name))).status, 404, `${name} cached`);
  }
});

test('a shared picture takes its strictest entry, in either order (H42)', async (t) => {
  for (const order of [['general', 'adult'], ['adult', 'general']]) {
    const pics = await pictureServer(t);
    const url = pics.url('shared.jpg');
    const rows = {
      general: entry(21, 'g.mp4', { thumbnail: url }),
      adult: entry(22, 'a.mp4', { thumbnail: url, channel: '18plus', creator: 'Ada' }),
    };
    const s = await boot(t, { history: order.map((k) => rows[k]), adult: ['Ada'] });
    assert.equal((await s.thumb(url)).status, 404, order.join(','));
    assert.equal((await s.thumb(url, '&audience=adult')).status, 200, order.join(','));
  }
});

test('a general picture reclassified 18+ stops at the next request, cached or not (H42, H60)', async (t) => {
  const pics = await pictureServer(t);
  const e = entry(31, 'g.mp4', { thumbnail: pics.url('g.jpg'), sourceUrl: 'https://www.tiktok.com/@someone/video/31' });
  const lazy = entry(32, 'h.mp4', { thumbnail: pics.url('h.jpg'), sourceUrl: 'https://www.tiktok.com/@someone/video/32' });
  const s = await boot(t, { history: [e, lazy] });
  const first = await s.raw(`/api/thumb?url=${encodeURIComponent(pics.url('g.jpg'))}&v=2`);
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.equal((await s.raw(`/api/thumb?url=${encodeURIComponent(pics.url('g.jpg'))}&v=2`, { 'If-None-Match': etag })).status, 304);
  // A profile's audience cannot be changed, so the owner reclassifies through
  // the items: both are marked 18+ by hand.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(s.data, 'items.db'));
  const now = Date.now();
  for (const url of [e.sourceUrl, lazy.sourceUrl]) {
    const k = url.replace(/^https:\/\/www\./, '');
    db.prepare("INSERT OR IGNORE INTO items (key, source_url, audience, origin, created_at, updated_at) VALUES (?, ?, 'unknown', 'save', ?, ?)").run(k, url, now, now);
  }
  const ids = [e.sourceUrl, lazy.sourceUrl].map((url) => db.prepare('SELECT id FROM items WHERE key = ?').pluck().get(url.replace(/^https:\/\/www\./, '')));
  db.close();
  const r = await s.post('/api/hub/review/items', { audience: 'adult', ids });
  assert.equal(r.status, 200, await r.text());
  const after = await s.raw(`/api/thumb?url=${encodeURIComponent(pics.url('g.jpg'))}&v=2`, { 'If-None-Match': etag });
  assert.equal(after.status, 404, 'the warm picture is refused');
  assert.equal(after.body.includes('picture'), false);
  // A tile that had not loaded yet gets no bytes either.
  const hitsBefore = pics.hits.length;
  assert.equal((await s.thumb(pics.url('h.jpg'))).status, 404);
  assert.equal(pics.hits.length, hitsBefore);
});

test('an 18+ entry that left the history still holds its picture back (H47)', async (t) => {
  // The Codex case: an 18+ download's picture was made again from its file
  // and kept; the 18+ history row has rolled over, but its registry
  // provenance remains. A general entry on the same URL gets no bytes.
  const pics = await pictureServer(t);
  const url = pics.url('codex.jpg');
  const k = key(url);
  const adultRef = 'r:example.com/adult/1';
  const general = entry(41, 'g.mp4', { thumbnail: url });
  const index = {
    version: 1, migratedAt: NOW,
    keys: { [k]: { at: NOW, provs: [{ kind: 'entry', ref: adultRef, at: NOW, in: { creator: 'Ada', channel: '18plus' } }] } },
  };
  const secret = JPEG();
  const s = await boot(t, { history: [general], adult: ['Ada'], index, thumbs: { [`keep-${ti.refTag(adultRef)}-${k}.jpg`]: secret } });
  const r = await s.thumb(url);
  assert.equal(r.status, 404);
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(body.includes(secret.subarray(3, 40)), false);
  assert.deepEqual(pics.hits, []);
});

test('the upgrade sets every earlier picture aside and makes legacy frames again per entry (H26, H47, H57, H83, H96)', async (t) => {
  const pic = JPEG();
  const legacy = `local-${'a'.repeat(40)}`;
  const shared = `local-${'b'.repeat(40)}`;
  const poster = JPEG();
  const history = [
    // A framed general clip whose library file and sidecar are still there.
    entry(51, 'framed.mp4', { thumbnail: `/api/thumb?id=${legacy}` }),
    // A legacy frame shared with an 18+ row, whose file is gone.
    entry(52, 'gone.mp4', { thumbnail: `/api/thumb?id=${shared}` }),
    entry(53, 'gone18.mp4', { thumbnail: `/api/thumb?id=${shared}`, channel: '18plus', creator: 'Ada' }),
    entry(54, 'site.mp4'),
  ];
  const s = await boot(t, {
    history, adult: ['Ada'],
    files: { 'framed.mp4': Buffer.alloc(10), 'framed.jpg': poster },
    thumbs: {
      [`${key(DEAD(54))}.jpg`]: pic,
      [`keep-${key(DEAD(54))}.jpg`]: pic,
      [`${legacy}.jpg`]: pic,
      [`${shared}.jpg`]: pic,
    },
  });
  for (let i = 0; i < 50 && !/legacy frames made again/.test(s.logs()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(s.logs(), /4 earlier picture files set aside in quarantine, 1 legacy frame ids were shared/);
  assert.match(s.logs(), /1 legacy frames made again from their entries' files, 2 entries keep the placeholder/);
  const names = fs.readdirSync(s.thumbsDir);
  const q = names.find((n) => n.startsWith('quarantine-'));
  assert.ok(q);
  assert.deepEqual(fs.readdirSync(path.join(s.thumbsDir, q)).sort(), [`${key(DEAD(54))}.jpg`, `keep-${key(DEAD(54))}.jpg`, `${legacy}.jpg`, `${shared}.jpg`].sort());
  // A legacy id is never served, on any surface.
  for (const id of [legacy, shared]) {
    assert.equal((await s.byId(id)).status, 404);
    assert.equal((await s.byId(id, '&audience=adult')).status, 404);
  }
  // The surviving general row points at a new per-entry frame from its own file.
  const row = s.history().find((e) => e.id === history[0].id);
  const m = /^\/api\/thumb\?id=(f-[0-9a-f]{40})$/.exec(row.thumbnail);
  assert.ok(m, row.thumbnail);
  const r = await s.byId(m[1]);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), poster);
  // Rows without a file keep the legacy id and so the placeholder.
  assert.equal(s.history().find((e) => e.id === history[1].id).thumbnail, `/api/thumb?id=${shared}`);
  // The site picture's old cache copy is not served from quarantine: the
  // link is dead and there is no file, so no bytes.
  assert.notEqual((await s.thumb(DEAD(54))).status, 200);
});

test('a frame of an 18+ or unclassified entry is refused on a general view (H57, H94)', async (t) => {
  const frameOf = (ref) => ti.frameId(ref, Buffer.from(ref));
  const general = frameOf('h:g');
  const adult = frameOf('h:a');
  const unknown = frameOf('h:u');
  const index = {
    version: 1, migratedAt: NOW,
    keys: {
      [general]: { at: NOW, provs: [{ kind: 'local', ref: 'h:g', at: NOW, in: { creator: 'someone', channel: 'main' } }] },
      // An 18+ item record in a general channel (H94): the entry's audience counts.
      [adult]: { at: NOW, provs: [{ kind: 'local', ref: 'h:a', at: NOW, in: { creator: 'Ada', channel: 'main' } }] },
      [unknown]: { at: NOW, provs: [{ kind: 'local', ref: 'h:u', at: NOW, in: { creator: 'Stranger', channel: 'main' } }] },
    },
  };
  const s = await boot(t, {
    adult: ['Ada'], index,
    thumbs: { [`${general}.jpg`]: JPEG(), [`${adult}.jpg`]: JPEG(), [`${unknown}.jpg`]: JPEG() },
  });
  assert.equal((await s.byId(general)).status, 200);
  for (const id of [adult, unknown]) {
    assert.equal((await s.byId(id)).status, 404);
    const r = await s.byId(id, '&audience=adult');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
  }
  // Nothing outside the index is served, whatever its name.
  const stray = frameOf('h:stray');
  fs.writeFileSync(path.join(s.thumbsDir, `${stray}.jpg`), JPEG());
  assert.equal((await s.byId(stray, '&audience=adult')).status, 404);
});
