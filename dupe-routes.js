'use strict';
// /api/hub/dupes/v2/*: the Smart Duplicate Manager's API (Grabbit 3.0.4).
// Mounted behind the same gate as every /api/hub route: the owner's session
// (admin audience) only, never an app password, and cross-site requests are
// refused before they get here. The 3.0.3 routes (/api/hub/dupes, .../remove,
// .../trash) stay as they were.
//
// Nothing here takes a file path from the client. Files are named by scan row
// id, groups by key, trash entries by "g<id>" / "a<id>".

const express = require('express');
const path = require('path');
const fs = require('fs');
const { DupeError } = require('./dupe-service');
const { TrashError } = require('./dupe-trash');
const { AdapterError } = require('./dupe-adapters');

const KEY_RE = /^(exact:[0-9a-f]{64}|photo:[1-9][0-9]{0,12}|video:[1-9][0-9]{0,12})$/;
const TRASH_ID_RE = /^[ga][1-9][0-9]{0,15}$/;
const GROUP_ACTIONS = ['keep', 'keep_both', 'keep_selected', 'trash_extras', 'mark_known', 'ignore', 'reopen', 'merge'];

function createRouter({ service, scanner, analyzer, models, trash, actorOf, kindOfName, thumbDir, media }) {
  const r = express.Router();
  const who = (req) => (actorOf ? actorOf(req) : null) || 'owner';

  const fail = (res, e) => {
    if (e instanceof DupeError || e instanceof AdapterError) {
      return res.status(e.status && e.status < 500 ? e.status : 424).json({ ok: false, error: e.message, fix: e.fix || null });
    }
    if (e instanceof TrashError) return res.status(409).json({ ok: false, error: e.message });
    console.error(`dupes: ${e.stack || e.message}`);
    return res.status(422).json({ ok: false, error: 'That did not work. See the server log.' });
  };
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json({ ok: true, ...out });
    } catch (e) {
      if (!res.headersSent) fail(res, e);
    }
  };
  const idList = (v, re, max = 2000) => {
    if (!Array.isArray(v) || !v.length || v.length > max) throw new DupeError(`Give between 1 and ${max} ids`);
    const out = v.map(String);
    if (!out.every((x) => re.test(x))) throw new DupeError('Not a valid id');
    return [...new Set(out)];
  };
  const listQuery = (q) => {
    const pick = {};
    for (const k of ['tab', 'adult', 'status', 'app', 'type', 'match', 'deletable', 'protected', 'minBytes', 'minSimilarity', 'sort', 'limit', 'offset']) {
      if (q[k] != null && q[k] !== '') pick[k] = String(q[k]).slice(0, 80);
    }
    return pick;
  };

  r.get('/overview', wrap(() => service.overview()));
  r.get('/library', wrap(() => ({ roots: service.libraryStatus() })));
  r.get('/groups', wrap((req) => service.list(listQuery(req.query))));
  r.get('/groups/:key/references', wrap(async (req) => {
    if (!KEY_RE.test(req.params.key)) throw new DupeError('Not a group key');
    return { references: await service.references(req.params.key) };
  }));
  r.post('/groups/action', wrap(async (req) => {
    const b = req.body || {};
    if (!KEY_RE.test(String(b.key))) throw new DupeError('Not a group key');
    if (!GROUP_ACTIONS.includes(b.action)) throw new DupeError('Unknown action');
    const keep = b.keep == null ? [] : idList(b.keep, /^[1-9][0-9]{0,15}$/, 500).map(Number);
    const note = b.note == null ? null : String(b.note).slice(0, 500);
    return service.act(b.key, b.action, { keep, by: who(req), note });
  }));
  r.post('/batch', wrap(async (req) => {
    const b = req.body || {};
    const keys = b.filter ? [] : idList(b.keys, KEY_RE);
    const filter = b.filter && typeof b.filter === 'object' ? listQuery(b.filter) : null;
    const expect = b.expect && typeof b.expect === 'object' ? { files: Number(b.expect.files) } : null;
    return service.batch({ keys, filter, action: String(b.action), dryRun: b.dryRun !== false, by: who(req), expect });
  }));

  // --- trash
  r.get('/trash', wrap((req) => service.trashList({
    q: req.query.q, app: req.query.app, type: req.query.type, adult: req.query.adult, limit: req.query.limit, offset: req.query.offset,
  })));
  r.post('/trash/restore', wrap(async (req) => {
    const b = req.body || {};
    const ids = b.all === true ? service.trashEntries().map((t) => t.id) : idList(b.ids, TRASH_ID_RE);
    return service.trashRestore(ids, who(req));
  }));
  r.post('/trash/delete', wrap(async (req) => service.trashDelete(idList((req.body || {}).ids, TRASH_ID_RE), who(req))));
  r.post('/trash/empty', wrap(async (req) => {
    const e = (req.body || {}).expect;
    if (!e || typeof e !== 'object') throw new DupeError('Confirm how many files and bytes you are deleting');
    return service.trashEmpty({ files: Number(e.files), bytes: Number(e.bytes) }, who(req));
  }));
  // A held copy in Grabbit's own trash, for the preview. The file is found
  // from the trash row (never from the request), inside the trash folder.
  r.get('/trash/:id/file', (req, res) => {
    const notFound = () => res.status(404).json({ ok: false, error: 'Not available' });
    try {
      if (!/^g[1-9][0-9]{0,15}$/.test(req.params.id) || !trash) return notFound();
      const t = trash.store.trashGet(Number(req.params.id.slice(1)));
      if (!t || t.restored_at || t.purged_at) return notFound();
      const f = trash.trashedFile(t);
      if (!f || !['video', 'image', 'audio'].includes(kindOfName(t.rel))) return notFound();
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type(path.extname(t.rel));
      return res.sendFile(f.abs, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'private, max-age=600' } }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    } catch {
      if (!res.headersSent) notFound();
    }
  });

  // A small JPEG of a scanned file (a frame for a video), made once per
  // content and kept in Grabbit's data folder, so result lists never load
  // full pictures or video players. The file is found by scan row id.
  const thumbBusy = new Map();
  r.get('/thumb/:id', async (req, res) => {
    const notFound = () => { if (!res.headersSent) res.status(404).json({ ok: false, error: 'Not available' }); };
    try {
      if (!/^[1-9][0-9]{0,15}$/.test(req.params.id) || !thumbDir) return notFound();
      const row = service.store.dupeFile(Number(req.params.id));
      if (!row || !row.sha256) return notFound();
      const kind = kindOfName(row.rel);
      if (!['video', 'image'].includes(kind)) return notFound();
      const out = path.join(thumbDir, row.sha256.slice(0, 2), `${row.sha256}.jpg`);
      if (!fs.existsSync(out)) {
        const { safePath } = require('./dupe-analyzer');
        const src = safePath(row.root, row.rel);
        if (!src) return notFound();
        if (!thumbBusy.has(out)) {
          thumbBusy.set(out, (async () => {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const tmp = `${out}.${process.pid}.tmp`;
            let seek = [];
            if (kind === 'video') {
              const p = await media.probe(src).catch(() => ({}));
              seek = ['-ss', String(Math.min(3, Math.max(0, (p.duration || 2) * 0.1)).toFixed(2))];
            }
            await media.run('ffmpeg', ['-nostdin', '-v', 'error', ...seek, '-i', src, '-frames:v', '1',
              '-vf', 'scale=360:360:force_original_aspect_ratio=decrease', '-q:v', '5', '-f', 'mjpeg', '-y', tmp], { timeoutMs: 60000 });
            fs.renameSync(tmp, out);
          })().finally(() => thumbBusy.delete(out)));
        }
        await thumbBusy.get(out);
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.sendFile(out, { headers: { 'Cache-Control': 'private, max-age=86400', 'Content-Type': 'image/jpeg' } }, (err) => {
        if (err) notFound();
      });
    } catch {
      return notFound();
    }
  });

  // --- cache & thumbnails
  r.get('/cache', wrap(() => service.cacheReport()));
  r.post('/cache/:app/:action', wrap(async (req) => {
    if (!/^[a-z]{2,20}$/.test(req.params.app)) throw new DupeError('Unknown app');
    return { result: await service.cacheAction(req.params.app, req.params.action, (req.body || {}).dryRun !== false, who(req)) };
  }));

  // --- engines
  r.post('/scan', wrap((req) => {
    if (!scanner) throw new DupeError('The duplicate scan is switched off on this server (DUPES_SCAN=off).', 409);
    const a = (req.body || {}).action;
    const map = { start: 'start', resume: 'start', pause: 'pause', stop: 'stop', rescan: 'rescan' };
    if (!map[a]) throw new DupeError('action must be start, pause, resume, stop or rescan');
    console.log(`dupes: scan ${a} by ${who(req)}`);
    return { scan: scanner[map[a]]() };
  }));
  r.post('/analysis', wrap((req) => {
    if (!analyzer) throw new DupeError('The analysis is not available on this server', 409);
    const a = (req.body || {}).action;
    if (a === 'regroup') {
      return { photo: analyzer.regroup('photo'), video: analyzer.regroup('video') };
    }
    const map = { start: 'start', resume: 'start', pause: 'pause', stop: 'stop' };
    if (!map[a]) throw new DupeError('action must be start, pause, resume, stop or regroup');
    console.log(`dupes: analysis ${a} by ${who(req)}`);
    service.invalidate();
    return { analysis: analyzer[map[a]]() };
  }));
  r.get('/settings', wrap(() => ({ settings: service.cfg(), models: service.modelStatus() })));
  r.post('/settings', wrap((req) => {
    const b = req.body && typeof req.body.settings === 'object' ? req.body.settings : null;
    if (!b) throw new DupeError('settings must be an object');
    return { settings: service.setCfg(b, who(req)) };
  }));
  r.post('/models/:id/download', wrap(async (req) => {
    if (!models) throw new DupeError('Models are not available', 409);
    if (!/^(light|medium|heavy)$/.test(req.params.id)) throw new DupeError('Unknown model');
    // Runs in the background; progress shows in /settings.
    models.download(req.params.id).catch((e) => console.warn(`dupes: model download failed (${e.message})`));
    return { started: true };
  }));
  r.get('/prevention', wrap((req) => ({ items: service.dx.preventionRecent(req.query.limit) })));
  r.get('/history', wrap(() => ({ history: service.dx.history(50), ops: service.dx.opsRecent(50) })));

  r.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
  return r;
}

module.exports = { createRouter, KEY_RE, TRASH_ID_RE };
