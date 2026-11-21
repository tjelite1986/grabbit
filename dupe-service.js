'use strict';
// Smart Duplicate Manager 2.0: the service behind /api/hub/dupes/v2/*.
//
// It joins the exact scan (file_hashes), the engines' groups (dupes.db), the
// item store (what a file is to Grabbit), the app adapters (what a file is to
// its app) and the trash, and it is the only place that decides what may
// happen to a copy:
//
// - Grabbit's own folders: a copy can go to Grabbit's trash, or two identical
//   copies can be merged into one stored file with two names.
// - An app's library (TikShortis): the app merges identical copies itself, so
//   both posts keep their own metadata, likes and comments.
// - Anything else is shown with the concrete reason it stays and what would
//   let it go.
//
// Destructive steps re-check the files' identity at the moment they run; a
// scan result alone never deletes anything. One destructive operation runs at
// a time.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { classify, audienceOf, relatedRenditions } = require('./dupe-classify');
const quality = require('./dupe-quality');
const { TrashError, replaceWith } = require('./dupe-trash');
const { AdapterError, noAdapterReason } = require('./dupe-adapters');
const { signatureOf } = require('./dupe-store');
const { hashFrame, hamming } = require('./dupe-phash');
const ai = require('./dupe-ai');
const { readCfg, sanitizeCfg, CFG_KEY, flags } = require('./dupe-analyzer');

function sizeText(n) {
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return i ? `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}` : `${n} bytes`;
}

class DupeError extends Error {
  constructor(message, status = 400, fix = null) {
    super(message);
    this.status = status;
    this.fix = fix;
  }
}

const TABS = ['identical', 'photos', 'videos', 'cache'];
const SORTS = ['space', 'similarity', 'size', 'newest', 'oldest', 'type'];
const MAX_BATCH_GROUPS = 2000;
// How long an app's audience answer for one of its copies holds.
const AUD_TTL_MS = 60 * 1000;
// How long an app's answer about which posts use a copy is trusted for the
// plan. A merge always asks again right before it runs (see applyMember).
const REFS_TTL_MS = 10 * 60 * 1000;

const sha256File = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
});

class DupeService {
  constructor(o) {
    this.store = o.store;
    this.db = o.store.raw;
    this.dx = o.dx;
    this.roots = o.roots;
    this.rootOf = o.rootOf;
    this.trash = o.trash;
    this.analyzer = o.analyzer || null;
    this.scanner = o.scanner || null;
    this.adapters = o.adapters || new Map(); // root path -> AppAdapter
    this.models = o.models || null;
    this.log = o.log || ((m) => console.log(`dupes: ${m}`));
    this.now = o.now || Date.now;
    this.cache = null;
    // What a mixed-audience app (egram) reported for its copies:
    // "root\0rel" -> { aud: 'general' | 'adult', ino, mtime, at }. An answer
    // holds for AUD_TTL_MS only: a post's audience can change in the app
    // without the media file changing, so it is asked again after that.
    this.appAud = new Map();
    this.audBusy = null;
    this.audRetryAt = new Map(); // root -> time before which a failed app is not asked again
    this.busy = null;
    this.lookupCache = new Map();
    // Which posts an app that can merge (TikShortis) reported for its copies:
    // "root\0rel" -> { used, ino, mtime, at }. used = how many posts use the
    // copy; 0 means none (an orphan candidate). Read by planExact.
    this.appRefs = new Map();
    this.refsBusy = null;
    this.refsRetryAt = new Map(); // root -> time before which a failed app is not asked again
  }

  cfg() { return readCfg(this.store); }

  setCfg(patch, by, { confirmRetention = false } = {}) {
    const before = this.cfg();
    const next = sanitizeCfg({ ...before, ...patch, prevention: { ...before.prevention, ...(patch.prevention || {}) } });
    // A shorter hold time applies at the next hourly purge, so it needs its
    // own confirmation, with the number of held copies it would delete.
    const shorter = next.trashRetentionDays && (!before.trashRetentionDays || next.trashRetentionDays < before.trashRetentionDays);
    if (shorter && !confirmRetention) {
      const cut = this.now() - next.trashRetentionDays * 86400000;
      const due = this.trashEntries().filter((t) => t.at < cut);
      const size = sizeText(due.reduce((n, t) => n + t.bytes, 0));
      throw new DupeError(`Keeping removed copies for ${next.trashRetentionDays} days deletes ${due.length} held ${due.length === 1 ? 'copy' : 'copies'} (${size}) within the hour. Confirm the shorter time to save it.`, 409);
    }
    this.store.setSetting(CFG_KEY, JSON.stringify(next), this.now());
    if (this.analyzer) {
      const engines = ['photo', 'ai', 'video', 'model'];
      if (engines.some((k) => before[k] !== next[k])) this.analyzer.resetQueue();
      if (['mode', 'sensitivity', 'model', 'ai', 'photo'].some((k) => before[k] !== next[k])) this.analyzer.markDirty('photo');
      if (before.video !== next.video) this.analyzer.markDirty('video');
    }
    if (this.scanner && next.scanMbps !== before.scanMbps) this.scanner.setRate(next.scanMbps);
    this.invalidate();
    this.log(`settings changed by ${by || 'owner'}`);
    return next;
  }

  invalidate() { this.cache = null; }

  // An app call that failed is closed in the journal. One the app stopped
  // answering half way stays pending: the app may have carried it out, so
  // the trash page lists it until the owner has checked it in the app.
  opFailed(opId, err) {
    if (err && err.appDone) return; // the app did it; recordAppDone kept it pending
    if (err && err.stalled) {
      if (err.appRef) {
        try { this.dx.opNote(opId, { appRef: err.appRef }); } catch {}
      }
      return;
    }
    this.dx.opEnd(opId, false, { error: err && err.message }, this.now());
  }

  // The app reported the change done; Grabbit's own record of it (`write`)
  // and the journal row that closes the operation go in one transaction. A
  // local failure there is not the app refusing: the operation stays
  // pending with the app's reference noted, so the owner can find it.
  recordAppDone(opId, ad, { ref = null, result = {} }, write) {
    try {
      const run = () => {
        const out = write();
        this.dx.opEnd(opId, true, { result }, this.now());
        return out;
      };
      return this.dx.tx ? this.dx.tx(run) : run();
    } catch (e) {
      try { this.dx.opNote(opId, { appRef: ref, appDone: true }); } catch {}
      this.log(`${ad.app} carried out operation ${opId}, but Grabbit could not record it: ${e.message}`);
      throw Object.assign(new DupeError(`${ad.app} carried this out, but Grabbit could not record it (${e.message})`, 424), {
        appDone: true, fix: `It is listed under unfinished operations${ref ? ` (${ad.app} entry ${ref})` : ''}; nothing needs to be done in ${ad.app}.`,
      });
    }
  }

  // Pending journal rows older than any running call (the adapter gives up
  // after its timeout), with what the owner should look at.
  unfinishedOps() {
    const cut = this.now() - 2 * 60 * 1000;
    const apps = new Map([...this.adapters.values()].map((a) => [a.id, a.app]));
    return this.dx.opsPending().filter((o) => o.at < cut).map((o) => {
      let p = {};
      try { p = JSON.parse(o.payload) || {}; } catch {}
      let res = {};
      try { res = JSON.parse(o.result) || {}; } catch {}
      if (o.adapter === 'grabbit' && o.op === 'trash') {
        const where = path.join(p.root || '', p.from || '');
        const check = res.keptCopy
          ? `The move was refused because a file changed meanwhile. ${where} was left alone, and an extra copy of the earlier file stays at ${res.keptCopy}; delete that copy by hand once you have compared them.`
          : `Grabbit stopped while moving ${where} to the trash. If the file is gone from its folder, it is in the trash folder as ${p.trashName}; move it back by hand. If it is still in its folder, nothing happened.`;
        return { id: o.id, app: 'Grabbit', op: o.op, what: `Move ${p.from} to the trash`, check, appRef: null, at: o.at };
      }
      const app = apps.get(o.adapter) || o.adapter;
      const what = o.op === 'link' ? `Share ${p.drop} with ${p.keep}`
        : o.op === 'restore' ? `Restore held copy ${p.ref}`
          : o.op === 'purge' ? `Delete held copy ${p.ref} for good`
            : `${o.op.replace('cache-', 'Cache ')}`;
      const check = o.op === 'link' ? `Open ${p.drop} in ${app}: if it now shows the kept file, the share went through and the copy is in ${app}'s trash.`
        : o.op === 'restore' ? `Check whether the item is back in ${app}; if not, restore it again.`
          : o.op === 'purge' ? `Check whether the copy is still in ${app}'s trash; if so, delete it again.`
            : `Check ${app}'s cache page.`;
      const note = res.appDone ? ` ${app} reported it done${res.appRef ? ` (held entry ${res.appRef})` : ''}, but Grabbit could not record it.`
        : res.appRef ? ` ${app} reported held entry ${res.appRef}.` : '';
      const ad = [...this.adapters.values()].find((a) => a.id === o.adapter);
      const canResolve = o.op === 'link' && !!p.opKey && !!ad && ad.caps.has('opstatus');
      return { id: o.id, app, op: o.op, what, check: check + note, appRef: res.appRef || null, at: o.at, canResolve };
    });
  }

  // Asks the app what became of a merge whose answer was lost (by the op
  // key sent with it). Found: it is recorded in the trash like any merge, so
  // it can be restored or deleted from here. Not found: the app closed the
  // key and nothing changed. Still running or unclear: it stays pending.
  async resolveOp(id, by) {
    return this.exclusive('check an unfinished operation', async () => {
      const o = this.dx.opsPending().find((x) => x.id === Number(id));
      if (!o) throw new DupeError('That operation is not waiting for a check', 404);
      let p = {};
      try { p = JSON.parse(o.payload) || {}; } catch {}
      const ad = [...this.adapters.values()].find((a) => a.id === o.adapter);
      if (o.op !== 'link' || !p.opKey || !ad || !ad.caps.has('opstatus')) throw new DupeError('This operation cannot be checked automatically; check it in the app and mark it checked', 409);
      const st = await ad.opStatus(p.opKey);
      if (st.found && st.inProgress) throw new DupeError(`${ad.app} is still working on it; check again in a minute`, 409);
      if (!st.found || st.state === 'failed') {
        this.dx.opEnd(o.id, false, { error: `${ad.app} reports that nothing changed` }, this.now());
        this.log(`unfinished ${o.id}: ${ad.app} reports nothing changed`);
        return { id: o.id, outcome: 'nothing changed' };
      }
      // Only a merge the app has verified as finished ('linked': the held
      // original and the keeper in the clip's place) becomes a trash entry.
      // A merge that stopped part way stays here until the app can tell.
      if (st.state !== 'linked') {
        const why = st.stopped
          ? `${ad.app} stopped part way through this merge and cannot tell safely how far it got; check it in ${ad.app}, then mark it checked`
          : `${ad.app} reports this merge as ${String(st.state).slice(0, 40)}; check again later or check it in ${ad.app}`;
        throw new DupeError(why, 409);
      }
      const ref = `${st.id}:${st.uid}`;
      const tid = this.recordAppDone(o.id, ad, { ref, result: st }, () => this.dx.appTrashAdd({
        adapter: ad.id, ref, root: p.root, rel: p.drop, sha256: p.sha256, bytes: Number.isSafeInteger(p.bytes) ? p.bytes : st.bytes,
        keep_root: p.keep_root, keep_rel: p.keep, reason: 'Merged in the app (both posts kept)', kind: p.kind, audience: p.audience, app: ad.app, by: o.by || by,
      }, this.now()));
      this.log(`unfinished ${o.id}: ${ad.app} merged it (entry ${st.id}), now in the trash`);
      return { id: o.id, outcome: 'merged', trash: `a${tid}` };
    });
  }

  opChecked(id, by) {
    if (!this.dx.opChecked(id, by, this.now())) throw new DupeError('That operation is not waiting for a check', 404);
    this.log(`unfinished ${id} checked by ${by || 'owner'}`);
    return { checked: Number(id) };
  }

  // Background work (retention purge, duplicate prevention) takes the same
  // lock as the owner's actions, but waits for no one: when the lock is held
  // it returns `busyValue` and the caller tries again later or keeps the file.
  async whenFree(what, fn, busyValue) {
    if (this.busy) return busyValue;
    return this.exclusive(what, fn);
  }

  async exclusive(what, fn) {
    if (this.busy) throw new DupeError(`Another operation is running (${this.busy})`, 409);
    this.busy = what;
    try {
      return await fn();
    } finally {
      this.busy = null;
      this.invalidate();
    }
  }

  // --- reading the records ----------------------------------------------------
  rootInfo(p) {
    return this.rootOf(p) || { path: p, label: p, owner: null };
  }

  // A copy in a mixed-audience app library counts as 18+ until the app has
  // reported it (for this inode and mtime) as used only by general posts.
  // An app answer that is still current: for this inode and mtime, and
  // younger than AUD_TTL_MS. A stale one counts as no answer (18+).
  appAnswer(row) {
    const c = this.appAud.get(`${row.root}\0${row.rel}`);
    return c && c.ino === String(row.ino) && c.mtime === row.mtime_ms && this.now() - c.at < AUD_TTL_MS ? c : null;
  }

  audienceFor(r, row) {
    const base = audienceOf(r, row.item_audience);
    if (base === 'adult' || !r.mixedAudience) return base;
    const c = this.appAnswer(row);
    if (!c || c.aud !== 'general') return 'adult';
    // A list for a request counts only answers from the fresh run it waited for.
    if (this.audTrack && this.audTrack.run != null && c.run !== this.audTrack.run) return 'adult';
    // A list built on this answer holds only while the answer does.
    if (this.audTrack) this.audTrack.exp = Math.min(this.audTrack.exp, c.at + AUD_TTL_MS);
    return 'general';
  }

  audienceUnverified(r, row) {
    if (!r.mixedAudience) return false;
    return !this.appAnswer(row);
  }

  // Asks the mixed-audience apps about every copy of theirs in a group that
  // they have not reported on yet. Best effort: an app that does not answer
  // leaves its copies counted as 18+.
  //
  // fresh: the list a person is about to see. Every copy of theirs is asked
  // again, not only the unverified ones, and only answers given after this
  // call began count: a copy the app does not answer for now (the app is
  // down, in its retry pause, or leaves it out) loses its earlier answer and
  // counts as 18+. An earlier answer still serves a preview for up to
  // AUD_TTL_MS; the list itself never rests on one.
  async refreshAppAudience({ fresh = false } = {}) {
    // One run at a time. A fresh call never joins a run: a run may have sent
    // its lookups before this call began (clock ticks are too coarse to
    // tell), so it waits for the run in progress and starts its own.
    while (this.audBusy) {
      const cur = this.audBusy;
      if (!fresh) return cur.p;
      try { await cur.p; } catch {}
    }
    this.audSeq = (this.audSeq || 0) + 1;
    const run = { id: this.audSeq, fresh, startedAt: this.now(), p: null };
    this.audBusy = run;
    run.p = (async () => {
      // Expired answers go first; a cached list built on a 'general' one is
      // rebuilt, so the copy counts as 18+ until the app confirms it again.
      let expired = false;
      for (const [k, c] of this.appAud) {
        if (this.now() - c.at < AUD_TTL_MS) continue;
        this.appAud.delete(k);
        if (c.aud === 'general') expired = true;
      }
      if (expired) this.invalidate();
      const byRoot = new Map();
      let changed = false;
      // Drops an earlier answer: the copy counts as 18+ until asked again.
      const forget = (m) => {
        const k = `${m.root}\0${m.rel}`;
        const c = this.appAud.get(k);
        if (!c) return;
        this.appAud.delete(k);
        if (c.aud === 'general') changed = true;
      };
      for (const g of this.build().groups) {
        for (const m of g.members) {
          if (fresh ? !this.rootInfo(m.root).mixedAudience : !m.audienceUnverified) continue;
          const ad = this.adapters.get(m.root);
          if (!ad || !ad.caps.has('lookup')) { if (fresh) forget(m); continue; }
          if ((this.audRetryAt.get(m.root) || 0) > this.now()) { if (fresh) forget(m); continue; }
          if (!byRoot.has(m.root)) byRoot.set(m.root, { ad, members: new Map() });
          byRoot.get(m.root).members.set(m.rel, m);
        }
      }
      for (const [root, { ad, members }] of byRoot) {
        const list = [...members.values()];
        for (let i = 0; i < list.length; i += 200) {
          const part = list.slice(i, i + 200);
          let r;
          // An answer is as old as the question: it is stamped with the time
          // the lookup was sent, so a reply that arrives during a later
          // request never passes that request's cutoff (or a longer TTL).
          const askedAt = this.now();
          try {
            r = await ad.lookup(part.map((m) => m.rel));
          } catch {
            // Not asked again for a minute, so a down app does not slow every list.
            this.audRetryAt.set(root, this.now() + 60000);
            if (fresh) list.slice(i).forEach(forget);
            break;
          }
          for (const m of part) {
            const it = r.get(m.rel);
            if (!it) { if (fresh) forget(m); continue; }
            const refs = Array.isArray(it.refs) ? it.refs : [];
            const aud = refs.length && refs.every((x) => x && x.audience === 'general') ? 'general' : 'adult';
            const k = `${m.root}\0${m.rel}`;
            const was = this.appAud.get(k);
            this.appAud.set(k, { aud, ino: String(m.ino), mtime: m.mtime_ms, at: askedAt, run: run.id });
            if (!was || was.aud !== aud || was.ino !== String(m.ino) || was.mtime !== m.mtime_ms) changed = true;
          }
        }
      }
      if (changed) this.invalidate();
      return run.id;
    })().finally(() => { if (this.audBusy === run) this.audBusy = null; });
    return run.p;
  }

  // --- which posts use an app copy ---------------------------------------------
  // Only apps that can merge are asked: a merge keeps two posts, so it needs a
  // post on each side, and the copy to keep must be one a post uses.
  refsAdapter(root) {
    const ad = this.adapters.get(root);
    return ad && ad.caps.has('lookup') && ad.caps.has('link') ? ad : null;
  }

  // The app's answer for this copy, when it is still current (same inode and
  // mtime, younger than REFS_TTL_MS); null means "not known".
  appRefsFor(row) {
    const c = this.appRefs.get(`${row.root}\0${row.rel}`);
    return c && c.ino === String(row.ino) && c.mtime === row.mtime_ms && this.now() - c.at < REFS_TTL_MS ? c : null;
  }

  // Records a lookup answer for the given copies. A copy the app left out of
  // its answer is unknown, not unused: its earlier answer goes. Returns true
  // when anything the plan reads changed.
  noteRefs(members, answer, at) {
    let changed = false;
    for (const m of members) {
      const k = `${m.root}\0${m.rel}`;
      const it = answer.get(m.rel);
      const was = this.appRefs.get(k);
      if (!it || !Array.isArray(it.refs)) {
        if (was) { this.appRefs.delete(k); changed = true; }
        continue;
      }
      const next = { used: it.refs.length, ino: String(m.ino), mtime: m.mtime_ms, at };
      if (!was || was.used !== next.used || was.ino !== next.ino || was.mtime !== next.mtime) changed = true;
      this.appRefs.set(k, next);
    }
    return changed;
  }

  // Asks the apps that can merge which posts use their copies in identical
  // groups. Best effort: a copy without a current answer is never merged.
  // members: only these copies, asked again even when an answer is current
  // (used right before a group action); otherwise every copy without one.
  async refreshAppRefs({ members = null } = {}) {
    if (!members && this.refsBusy) return this.refsBusy;
    const run = (async () => {
      const list = members || this.build().groups.filter((g) => g.match === 'exact').flatMap((g) => g.members)
        .filter((m) => !this.appRefsFor(m));
      const byRoot = new Map();
      for (const m of list) {
        const ad = this.refsAdapter(m.root);
        if (!ad || !ad.ready().ok) continue;
        if (!members && (this.refsRetryAt.get(m.root) || 0) > this.now()) continue;
        if (!byRoot.has(m.root)) byRoot.set(m.root, { ad, members: new Map() });
        byRoot.get(m.root).members.set(m.rel, m);
      }
      let changed = false;
      for (const [root, { ad, members: ms }] of byRoot) {
        const all = [...ms.values()];
        for (let i = 0; i < all.length; i += 200) {
          const part = all.slice(i, i + 200);
          const askedAt = this.now();
          let r;
          try {
            r = await ad.lookup(part.map((m) => m.rel));
          } catch {
            this.refsRetryAt.set(root, this.now() + 60000);
            break;
          }
          if (this.noteRefs(part, r, askedAt)) changed = true;
        }
      }
      if (changed) this.invalidate();
    })();
    if (members) return run;
    this.refsBusy = run.finally(() => { this.refsBusy = null; });
    return this.refsBusy;
  }

  // Every present file that has a twin with the same bytes, plus Grabbit's
  // view of it, in one query.
  exactRows() {
    return this.db.prepare(`SELECT f.id, f.root, f.rel, f.dev, f.ino, f.bytes, f.mtime_ms, f.sha256, f.link, f.item_id,
        i.site, i.audience AS item_audience, i.source_url, COALESCE(i.creator_edit, i.creator) AS creator,
        COALESCE(i.title_edit, i.title) AS title, i.created_at AS item_created
      FROM file_hashes f LEFT JOIN items i ON i.id = f.item_id
      WHERE f.gone_at IS NULL AND f.sha256 IN (
        SELECT sha256 FROM file_hashes WHERE sha256 IS NOT NULL AND gone_at IS NULL GROUP BY sha256 HAVING COUNT(*) > 1)
      ORDER BY f.sha256, f.mtime_ms, f.id`).all();
  }

  filesOfShas(shas) {
    if (!shas.length) return [];
    const out = [];
    for (let i = 0; i < shas.length; i += 500) {
      const part = shas.slice(i, i + 500);
      out.push(...this.db.prepare(`SELECT f.id, f.root, f.rel, f.dev, f.ino, f.bytes, f.mtime_ms, f.sha256, f.link, f.item_id,
          i.site, i.audience AS item_audience, i.source_url, COALESCE(i.creator_edit, i.creator) AS creator,
          COALESCE(i.title_edit, i.title) AS title
        FROM file_hashes f LEFT JOIN items i ON i.id = f.item_id
        WHERE f.gone_at IS NULL AND f.sha256 IN (${part.map(() => '?').join(',')})
        ORDER BY f.mtime_ms, f.id`).all(...part));
    }
    return out;
  }

  member(row) {
    const r = this.rootInfo(row.root);
    const c = classify(r, row.rel);
    const f = row.sha256 ? this.dx.feature(row.sha256) : null;
    const feat = f && !f.error ? f : null;
    return {
      id: row.id,
      sha256: row.sha256,
      root: row.root,
      rel: row.rel,
      name: path.basename(row.rel),
      rootLabel: r.label || row.root,
      app: r.app || (r.owner === 'grabbit' ? 'Grabbit' : null),
      owner: r.owner || null,
      bytes: row.bytes,
      mtime_ms: row.mtime_ms,
      dev: row.dev,
      ino: row.ino,
      kind: c.kind,
      cls: c.cls,
      what: c.what,
      webOptimized: c.webOptimized,
      derivative: c.cls !== 'media',
      audience: this.audienceFor(r, row),
      audienceUnverified: this.audienceUnverified(r, row),
      adultFolder: Boolean(r.adult),
      link: row.link,
      item_id: row.item_id,
      item: row.item_id ? { creator: row.creator, title: row.title, site: row.site, audience: row.item_audience } : null,
      referenced: row.link === 'filename' && row.item_id != null,
      original: Boolean(row.item_id && row.link === 'filename'),
      width: feat ? feat.width : null,
      height: feat ? feat.height : null,
      duration: feat ? feat.duration : null,
      fps: feat ? feat.fps : null,
      vcodec: feat ? feat.vcodec : null,
      acodec: feat ? feat.acodec : null,
      bitrate: feat ? feat.bitrate : null,
      sharpness: feat ? feat.sharpness : null,
      container: feat ? feat.container : null,
    };
  }

  // What may happen to each copy of an exact group, and which one to keep.
  planExact(members) {
    const units = new Map();
    for (const m of members) {
      const k = `${m.dev}:${m.ino}`;
      if (!units.has(k)) units.set(k, []);
      units.get(k).push(m.id);
    }
    const grabbitPlan = this.trash ? this.trash.plan(members.map((m) => ({ ...m }))) : null;
    const gp = new Map(grabbitPlan ? grabbitPlan.members.map((p) => [p.id, p]) : []);
    const rec = quality.choose(members, this.cfg().defaultRule === 'manual' ? 'recommended' : this.cfg().defaultRule);
    // The copy to keep: Grabbit's safe plan decides among its own folders and
    // app anchors; the quality pick breaks ties.
    const keepId = grabbitPlan && grabbitPlan.keepId != null ? grabbitPlan.keepId : rec.keepId;
    // used(m): true when the app reported a post using the copy, false when
    // it reported none, null when it has not answered (or cannot be asked).
    const used = (m) => {
      if (!this.refsAdapter(m.root)) return null;
      const a = this.appRefsFor(m);
      return a ? a.used > 0 : null;
    };
    let keep = members.find((m) => m.id === keepId) || members[0];
    // A copy no post uses is never the one to keep while a copy a post uses
    // is there: merging into it would leave that post on the extra copy.
    if (used(keep) === false) {
      const alt = members.filter((x) => used(x) === true)
        .sort((a, b) => (Number(b.root === keep.root) - Number(a.root === keep.root))
          || (rec.scores.get(b.id).score - rec.scores.get(a.id).score) || (a.mtime_ms - b.mtime_ms))[0];
      if (alt) keep = alt;
    }
    for (const m of members) {
      const sharing = units.get(`${m.dev}:${m.ino}`);
      m.recommended = m.id === keep.id;
      m.score = rec.scores.get(m.id).score;
      m.reasons = rec.scores.get(m.id).reasons;
      m.action = null;
      // merge | trash | protected | orphan: what the review screen shows.
      m.state = 'protected';
      const ad = this.refsAdapter(m.root);
      if (m.id === keep.id) {
        m.why = 'Recommended copy to keep';
        if (used(m) === false) {
          m.state = 'orphan';
          m.why = `Recommended copy to keep, but no ${ad.app} post uses it`;
          m.fix = `Check it in ${ad.app}. Grabbit never removes an app's files.`;
        }
        continue;
      }
      if (sharing.length > 1 && sharing.includes(keep.id)) {
        m.why = 'Already stored once: this name and the kept copy are the same file (hard link)';
        continue;
      }
      if (m.audience === 'adult' && keep.audience !== 'adult' && keep.owner === 'app') {
        m.why = 'Kept: the other copy sits in a general app; an 18+ copy is never merged into it';
        m.fix = 'Keep both, or remove it in that app.';
        continue;
      }
      const p = gp.get(m.id);
      if (m.owner === 'grabbit' && p && p.removable) {
        m.action = 'trash';
        m.state = 'trash';
        m.suggested = p.suggested;
        m.why = p.suggested ? 'Extra copy: can go to the trash' : p.why || 'Can go to the trash';
        continue;
      }
      if (m.owner === 'grabbit' && keep.owner === 'grabbit' && m.dev === keep.dev) {
        m.action = 'merge';
        m.state = 'merge';
        m.suggested = true;
        m.why = p && p.why ? `${p.why}. Merge stores it once and keeps every library entry working` : 'Can be merged with the kept copy';
        continue;
      }
      if (ad) {
        // Other names of these bytes in the same app (a hard link to this copy is the same file).
        const peers = members.filter((x) => x.root === m.root && x.id !== m.id && !(x.dev === m.dev && x.ino === m.ino));
        if (!peers.length) {
          m.why = `The other copy is outside ${ad.app}: each app keeps its own file`;
          m.fix = 'Keep both, or delete the post in the app that should not have it.';
          continue;
        }
        const ready = ad.ready();
        if (!ready.ok) {
          m.why = ready.why;
          m.fix = ready.fix;
          continue;
        }
        const mine = used(m);
        if (mine === false) {
          m.state = 'orphan';
          m.why = `No ${ad.app} post uses this copy, so there is nothing to merge`;
          m.fix = `Check it in ${ad.app}: it may be left over from an earlier import. Grabbit never removes an app's files.`;
          continue;
        }
        if (mine == null) {
          m.why = `${ad.app} has not said yet which posts use this copy`;
          m.fix = 'Open the list again in a moment. Nothing is merged until it has.';
          continue;
        }
        // The copy to keep wins when a post uses it; otherwise the best peer a post uses.
        const target = (peers.includes(keep) && used(keep) === true ? keep : null)
          || peers.filter((x) => used(x) === true).sort((a, b) => (b.score - a.score) || (a.mtime_ms - b.mtime_ms))[0];
        if (!target) {
          const unknown = peers.some((x) => used(x) == null);
          m.why = unknown ? `${ad.app} has not said yet which posts use the other copy` : `No ${ad.app} post uses the other copy, so there is nothing to merge into`;
          m.fix = unknown ? 'Open the list again in a moment. Nothing is merged until it has.' : 'Keep this copy.';
          continue;
        }
        m.action = 'link';
        m.state = 'merge';
        m.linkTo = target.id;
        m.suggested = true;
        m.why = `${ad.app} keeps both posts and stores the file once`;
        continue;
      }
      const na = noAdapterReason(this.rootOf(m.root)) || { why: (p && p.why) || 'Kept', fix: null };
      m.why = (p && p.why) || na.why;
      m.fix = na.fix;
    }
    const actionable = members.filter((m) => m.action);
    // Bytes come back once per inode: two hard-linked names free one copy.
    const freed = new Map();
    for (const m of actionable) {
      if (m.dev === keep.dev && m.ino === keep.ino) continue;
      freed.set(`${m.dev}:${m.ino}`, m.bytes);
    }
    const reclaim = [...freed.values()].reduce((n, b) => n + b, 0);
    return { keepId: keep.id, reclaim, units: units.size, recommendation: { rule: rec.rule, reasons: keep.reasons || [] } };
  }

  planSimilar(members, match) {
    // One picture or video per content; several files of one content are
    // identical copies (the Identical tab handles those).
    const rec = quality.choose(members, this.cfg().defaultRule === 'manual' ? 'recommended' : this.cfg().defaultRule);
    const keep = members.find((m) => m.id === rec.keepId) || members[0];
    for (const m of members) {
      m.recommended = m.id === keep.id;
      m.score = rec.scores.get(m.id).score;
      m.reasons = rec.scores.get(m.id).reasons;
      m.action = null;
      if (m.id === keep.id) { m.why = 'Recommended to keep'; continue; }
      if (m.sha256 === keep.sha256) { m.why = 'Identical to the kept copy (see the Identical tab)'; continue; }
      if (match === 'partial') { m.why = 'A clip and its source are different videos: nothing to remove'; continue; }
      if (relatedRenditions({ ...m, rootInfo: this.rootOf(m.root) }, { ...keep, rootInfo: this.rootOf(keep.root) })) {
        m.why = 'An original and its web-optimised rendition: related versions, both stay';
        m.related = true;
        continue;
      }
      if (m.audience === 'adult' && keep.audience !== 'adult') { m.why = 'Kept: never matched across 18+ and general'; continue; }
      if (m.owner !== 'grabbit') {
        const r = this.rootOf(m.root) || {};
        m.why = `${r.app || 'An app'} owns this file`;
        m.fix = `Delete the post in ${r.app || 'the app'} if it is not wanted.`;
        continue;
      }
      if (m.referenced) {
        m.why = 'A library item uses this file';
        m.fix = 'Keep it, or remove the item in Library first.';
        continue;
      }
      m.action = 'trash';
      m.suggested = false; // never chosen for the owner: a near match is not proof
      m.why = 'Can go to the trash if you decide it is not needed';
    }
    const reclaim = members.filter((m) => m.action && !m.recommended).reduce((n, m) => n + m.bytes, 0);
    return { keepId: keep.id, reclaim, recommendation: { rule: rec.rule, reasons: keep.reasons || [] } };
  }

  // All groups, built once and cached for a short while.
  // run: count only app answers from this refresh run (the fresh run a list
  // request waited for: refreshAppAudience({ fresh: true }) resolves to its
  // id); a copy without an answer from that run counts as 18+. Without a
  // run, every current answer counts.
  build({ run = null } = {}) {
    // A cached list holds for 15 s, never past the first 'general' app
    // answer it rests on (after that the copy counts as 18+ again), and for
    // a request only when it was built for that same run.
    const c = this.cache;
    if (c && this.now() - c.at < 15000 && this.now() < c.audExp && (run == null || c.run === run)) return c;
    const t0 = this.now();
    this.audTrack = { exp: Infinity, run };
    try {
      return this.buildFresh(t0);
    } finally {
      this.audTrack = null;
    }
  }

  buildFresh(t0) {
    const groups = [];
    // Exact.
    const rows = this.exactRows();
    const acks = new Map(this.db.prepare('SELECT * FROM dupe_acks').all().map((a) => [a.sha256, a]));
    const reviews = this.dx.reviewsFor('exact');
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j < rows.length && rows[j].sha256 === rows[i].sha256) j++;
      const members = rows.slice(i, j).map((r) => this.member(r));
      i = j;
      if (members.length < 2) continue;
      const sha = members[0].sha256;
      const plan = this.planExact(members);
      const ack = acks.get(sha);
      const sig = members.map((m) => m.id).sort((a, b) => a - b).join(',');
      const acked = Boolean(ack && ack.members === sig);
      const rv = reviews.get(signatureOf('exact', [sha]));
      groups.push(this.groupView({
        key: `exact:${sha}`, tab: members.every((m) => m.derivative) ? 'cache' : 'identical', match: 'exact', score: 1,
        members, plan, ack: ack ? { at: ack.at, note: ack.note, current: acked } : null,
        status: acked ? 'known' : rv ? rv.decision : 'open',
      }));
    }
    // Similar photos and videos.
    for (const [kind, tab] of [['photo', 'photos'], ['video', 'videos']]) {
      const sims = this.dx.simGroups(kind);
      const files = this.filesOfShas([...new Set(sims.flatMap((g) => g.members.map((m) => m.sha256)))]);
      const bySha = new Map();
      for (const f of files) {
        if (!bySha.has(f.sha256)) bySha.set(f.sha256, []);
        bySha.get(f.sha256).push(f);
      }
      const revs = new Map([...this.dx.reviewsFor(kind), ...this.dx.reviewsFor(`${kind}-partial`)]);
      for (const g of sims) {
        const members = [];
        for (const sm of g.members) {
          // One file per content: the best-placed copy (Grabbit's own first).
          const fs2 = (bySha.get(sm.sha256) || []).map((r) => this.member(r)).filter((m) => !m.derivative);
          if (!fs2.length) continue;
          fs2.sort((a, b) => (a.owner === 'grabbit' ? 0 : 1) - (b.owner === 'grabbit' ? 0 : 1) || a.id - b.id);
          const m = fs2[0];
          m.similarity = sm.score;
          m.distance = sm.distance;
          m.cosine = sm.cosine;
          m.rotated = sm.rotated;
          m.role = sm.role || null;
          m.offset = sm.offset;
          m.matchWhy = sm.why || [];
          m.copies = fs2.length;
          members.push(m);
        }
        if (members.length < 2) continue;
        const plan = this.planSimilar(members, g.match);
        const sig = signatureOf(g.match === 'partial' ? `${kind}-partial` : kind, members.map((m) => m.sha256));
        const rv = revs.get(sig);
        groups.push(this.groupView({
          key: `${kind}:${g.id}`, tab, match: g.match, score: g.score, members, plan, explain: g.explain,
          status: rv ? rv.decision : 'open', signature: sig,
        }));
      }
    }
    this.cache = { at: this.now(), groups, ms: this.now() - t0, audExp: this.audTrack.exp, run: this.audTrack.run };
    return this.cache;
  }

  groupView(g) {
    const members = g.members;
    const kinds = new Set(members.map((m) => m.kind));
    const auds = new Set(members.map((m) => m.audience));
    const apps = [...new Set(members.map((m) => m.app || m.rootLabel))];
    const size = members.reduce((n, m) => n + m.bytes, 0);
    const units = new Set(members.map((m) => `${m.dev}:${m.ino}`)).size;
    return {
      key: g.key,
      tab: g.tab,
      match: g.match,
      score: g.score,
      mediaType: kinds.size === 1 ? [...kinds][0] : 'mixed',
      files: members.length,
      bytes: Math.max(...members.map((m) => m.bytes)),
      size,
      stored: g.match === 'exact' ? members[0].bytes * units : size,
      reclaim: g.plan.reclaim,
      apps,
      audience: auds.has('adult') ? (auds.size > 1 ? 'mixed' : 'adult') : auds.has('general') && auds.size === 1 ? 'general' : 'unknown',
      adult: members.some((m) => m.audience === 'adult'),
      crossesAudience: members.some((m) => m.audience === 'adult') && members.some((m) => m.audience !== 'adult'),
      deletable: members.some((m) => m.action),
      protected: members.some((m) => !m.action && !m.recommended),
      newest: Math.max(...members.map((m) => m.mtime_ms || 0)),
      oldest: Math.min(...members.map((m) => m.mtime_ms || 0)),
      status: g.status,
      ack: g.ack || null,
      keepId: g.plan.keepId,
      recommendation: g.plan.recommendation,
      explain: g.explain || null,
      signature: g.signature || null,
      members,
    };
  }

  // --- listing ------------------------------------------------------------------
  // audRun: see build().
  list(q = {}, { audRun = null } = {}) {
    const tab = TABS.includes(q.tab) ? q.tab : 'identical';
    const adult = ['hide', 'show', 'only'].includes(q.adult) ? q.adult : 'hide';
    const built = this.build({ run: audRun });
    let gs = built.groups.filter((g) => g.tab === tab);
    const hiddenAdult = adult === 'hide' ? gs.filter((g) => g.adult).length : 0;
    if (adult === 'hide') gs = gs.filter((g) => !g.adult);
    if (adult === 'only') gs = gs.filter((g) => g.adult);
    const status = ['open', 'reviewed', 'ignored', 'known', 'keep_all', 'all'].includes(q.status) ? q.status : 'open';
    if (status !== 'all') gs = gs.filter((g) => (status === 'reviewed' ? ['reviewed', 'keep_all', 'known'].includes(g.status) : g.status === status));
    if (q.app) gs = gs.filter((g) => g.apps.includes(String(q.app)));
    if (q.type) gs = gs.filter((g) => g.mediaType === q.type);
    if (q.match) gs = gs.filter((g) => g.match === q.match);
    if (q.deletable === '1') gs = gs.filter((g) => g.deletable);
    if (q.protected === '1') gs = gs.filter((g) => g.protected);
    const minBytes = Number(q.minBytes) || 0;
    if (minBytes) gs = gs.filter((g) => g.bytes >= minBytes);
    const minScore = Number(q.minSimilarity) || 0;
    if (minScore) gs = gs.filter((g) => g.score >= minScore);
    const sort = SORTS.includes(q.sort) ? q.sort : 'space';
    const cmp = {
      space: (a, b) => b.reclaim - a.reclaim || b.size - a.size,
      similarity: (a, b) => b.score - a.score,
      size: (a, b) => b.files - a.files || b.size - a.size,
      newest: (a, b) => b.newest - a.newest,
      oldest: (a, b) => a.oldest - b.oldest,
      type: (a, b) => a.mediaType.localeCompare(b.mediaType) || b.reclaim - a.reclaim,
    }[sort];
    gs = [...gs].sort((a, b) => cmp(a, b) || a.key.localeCompare(b.key));
    const total = gs.length;
    const limit = Math.max(1, Math.min(200, Number(q.limit) || 24));
    const offset = Math.max(0, Number(q.offset) || 0);
    const apps = [...new Set(built.groups.filter((g) => g.tab === tab).flatMap((g) => g.apps))].sort();
    return {
      tab, total, offset, limit, sort, status, hiddenAdult, apps,
      reclaim: gs.reduce((n, g) => n + g.reclaim, 0),
      items: gs.slice(offset, offset + limit).map((g) => this.publicGroup(g, adult)),
    };
  }

  // The keys of every group matching a filter (Select all matching filter).
  matchingKeys(q) {
    const all = this.list({ ...q, limit: 200, offset: 0 });
    // Never a silent cut: the owner would act on part of what they selected.
    if (all.total > MAX_BATCH_GROUPS) throw new DupeError(`${all.total} groups match; narrow the filter to at most ${MAX_BATCH_GROUPS}`);
    const keys = [];
    for (let off = 0; off < all.total && keys.length < MAX_BATCH_GROUPS; off += 200) {
      keys.push(...this.list({ ...q, limit: 200, offset: off }).items.map((g) => g.key));
    }
    return keys;
  }

  publicGroup(g, adult = 'hide') {
    return {
      ...g,
      members: g.members.map((m) => ({
        id: m.id, sha256: m.sha256, name: m.name, rel: m.rel, rootLabel: m.rootLabel, app: m.app, owner: m.owner,
        bytes: m.bytes, mtime_ms: m.mtime_ms, kind: m.kind, what: m.what, derivative: m.derivative, webOptimized: m.webOptimized,
        audience: m.audience, adultFolder: m.adultFolder,
        // A preview of an 18+ file is offered only when the owner chose to see 18+.
        preview: m.audience === 'adult' && adult === 'hide' ? false : ['image', 'video', 'audio'].includes(m.kind),
        item: m.audience === 'adult' && adult === 'hide' ? null : m.item,
        width: m.width, height: m.height, duration: m.duration, fps: m.fps, vcodec: m.vcodec, acodec: m.acodec,
        bitrate: m.bitrate, container: m.container,
        recommended: m.recommended, score: m.score, reasons: m.reasons, action: m.action, suggested: Boolean(m.suggested),
        state: m.state || (m.action === 'trash' ? 'trash' : m.action ? 'merge' : 'protected'),
        linkTo: m.linkTo || null, why: m.why || null, fix: m.fix || null, related: Boolean(m.related),
        similarity: m.similarity, distance: m.distance, cosine: m.cosine, rotated: m.rotated, role: m.role, offset: m.offset,
        matchWhy: m.matchWhy || null, copies: m.copies || 1,
      })),
    };
  }

  findGroup(key) {
    const g = this.build().groups.find((x) => x.key === String(key));
    if (!g) throw new DupeError('That group is no longer there; refresh the list', 404);
    return g;
  }

  // --- overview -----------------------------------------------------------------
  overview() {
    const b = this.build();
    const scan = this.scanner ? this.scanner.status() : null;
    const totals = this.db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM file_hashes WHERE gone_at IS NULL').get();
    const by = (tab) => b.groups.filter((g) => g.tab === tab);
    const open = (gs) => gs.filter((g) => g.status === 'open');
    const identical = by('identical');
    const sum = (gs, k) => gs.reduce((n, g) => n + g[k], 0);
    const trash = this.trashSummary();
    const derivs = this.db.prepare(`SELECT root, rel, bytes FROM file_hashes WHERE gone_at IS NULL`).iterate();
    let cacheFiles = 0;
    let cacheBytes = 0;
    for (const r of derivs) {
      const c = classify(this.rootInfo(r.root), r.rel);
      if (c.cls === 'derivative') { cacheFiles++; cacheBytes += r.bytes; }
    }
    const extra = (gs) => gs.reduce((n, g) => n + (g.match === 'exact' ? g.stored - g.bytes : 0), 0);
    return {
      totals: { files: totals.files, bytes: totals.bytes },
      identical: {
        groups: identical.length,
        open: open(identical).length,
        adultGroups: identical.filter((g) => g.adult).length,
        duplicateBytes: extra(identical),
        reclaimable: sum(open(identical), 'reclaim'),
      },
      photos: { groups: by('photos').length, open: open(by('photos')).length, reclaimable: sum(open(by('photos')), 'reclaim') },
      videos: {
        groups: by('videos').filter((g) => g.match !== 'partial').length,
        partial: by('videos').filter((g) => g.match === 'partial').length,
        open: open(by('videos')).length,
      },
      cache: { files: cacheFiles, bytes: cacheBytes, duplicateGroups: by('cache').length, duplicateBytes: extra(by('cache')) },
      trash,
      scan,
      analysis: this.analyzer ? this.analyzer.status() : null,
      history: this.dx.history(10),
      busy: this.busy,
      builtMs: b.ms,
    };
  }

  libraryStatus() {
    const scan = this.scanner ? this.scanner.status() : { roots: [] };
    return scan.roots.map((r) => {
      const ad = this.adapters.get(r.path);
      const info = this.rootOf(r.path) || {};
      return {
        ...r,
        access: info.owner === 'grabbit' ? 'Grabbit' : ad ? (ad.ready().ok ? `${ad.app} (app-owned operations)` : `${ad.app} (not connected: ${ad.ready().why})`) : `${info.app || 'App'} (read only)`,
        adult: Boolean(info.adult),
      };
    });
  }

  // --- actions on one group -----------------------------------------------------
  // action: keep | keep_both | keep_selected | trash_extras | mark_known |
  //         ignore | reopen | merge
  async act(key, action, { keep = [], by = null, note = null } = {}) {
    const g = this.findGroup(key);
    const kind = g.key.split(':')[0];
    const sig = g.match === 'exact' ? signatureOf('exact', [g.members[0].sha256]) : g.signature;
    switch (action) {
      case 'keep':
      case 'reviewed':
        this.dx.setReview(sig, kind, 'reviewed', { keep: keep.length ? keep : [g.keepId], by, note });
        this.invalidate();
        return { ok: true, status: 'reviewed' };
      case 'keep_both':
        if (g.match !== 'exact') this.dx.decidePairs(g.members.map((m) => m.sha256), 'different', by, this.now());
        else this.store.ackGroup(g.members[0].sha256, { note: note || 'Keep all copies', by });
        this.dx.setReview(sig, kind, 'keep_all', { by, note });
        this.invalidate();
        if (this.analyzer && g.match !== 'exact') this.analyzer.markDirty(kind);
        return { ok: true, status: 'keep_all' };
      case 'mark_known':
        if (g.match === 'exact') this.store.ackGroup(g.members[0].sha256, { note, by });
        this.dx.setReview(sig, kind, 'reviewed', { by, note: note || 'Known/OK' });
        this.invalidate();
        return { ok: true, status: 'known' };
      case 'ignore':
        this.dx.setReview(sig, kind, 'ignored', { by, note });
        this.invalidate();
        return { ok: true, status: 'ignored' };
      case 'reopen':
        this.dx.dropReview(sig);
        if (g.match === 'exact') this.store.unackGroup(g.members[0].sha256);
        else this.dx.undecidePairs(g.members.map((m) => m.sha256));
        this.invalidate();
        return { ok: true, status: 'open' };
      case 'keep_selected':
      case 'merge': {
        // The plan must rest on what the app says now about these copies.
        await this.refreshAppRefs({ members: g.members.filter((m) => this.refsAdapter(m.root)) });
        const fresh = this.findGroup(key);
        return this.exclusive(`${action} ${fresh.key}`, () => this.applyGroup(fresh, action, { keep, by }));
      }
      case 'trash_extras':
        return this.exclusive(`${action} ${g.key}`, () => this.applyGroup(g, action, { keep, by }));
      default:
        throw new DupeError('Unknown action');
    }
  }

  // Which members go, for a removing action. keep_selected: everything not in
  // `keep` that has an action; trash_extras/merge: the suggested ones.
  selectionOf(g, action, keep) {
    const keepSet = new Set((keep || []).map(Number));
    if (action === 'keep_selected') {
      if (!keepSet.size) throw new DupeError('Choose at least one copy to keep');
      if (![...keepSet].every((id) => g.members.some((m) => m.id === id))) throw new DupeError('A chosen copy is not in this group');
      return g.members.filter((m) => !keepSet.has(m.id));
    }
    if (g.match !== 'exact') throw new DupeError('Choose the copies to keep yourself: a similarity match is never removed for you');
    // trash_extras moves copies to the trash and nothing else: a merge or an
    // app link is its own confirmed action, never a side effect of this one.
    const kinds = action === 'merge' ? ['merge', 'link'] : ['trash'];
    return g.members.filter((m) => m.suggested && kinds.includes(m.action));
  }

  async applyGroup(g, action, { keep, by }) {
    const go = this.selectionOf(g, action, keep);
    const keepSet = new Set((keep || []).map(Number));
    const keepId = action === 'keep_selected'
      ? (g.members.find((m) => keepSet.has(m.id) && m.recommended) || g.members.find((m) => keepSet.has(m.id))).id
      : g.keepId;
    const out = { done: [], refused: [], bytes: 0 };
    for (const m of go) {
      if (!m.action) {
        out.refused.push({ id: m.id, name: m.name, error: m.why || 'Kept', fix: m.fix || null });
        continue;
      }
      try {
        const r = await this.applyMember(g, m, keepId, by);
        out.done.push({ id: m.id, name: m.name, ...r });
        out.bytes += m.bytes;
      } catch (e) {
        out.refused.push({ id: m.id, name: m.name, error: e.message, fix: e.fix || null });
      }
    }
    if (out.done.length) this.dx.setReview(g.match === 'exact' ? signatureOf('exact', [g.members[0].sha256]) : g.signature, g.key.split(':')[0], 'reviewed', { keep: [keepId], by });
    this.log(`${action} on ${g.key} by ${by || 'owner'}: ${out.done.length} done, ${out.refused.length} refused`);
    return out;
  }

  async applyMember(g, m, keepId, by) {
    const reason = g.match === 'exact' ? 'Identical copy' : g.tab === 'photos' ? `Similar photo (${g.match})` : `Similar video (${g.match})`;
    if (m.action === 'trash') {
      if (g.match === 'exact') {
        const id = await this.trash.remove(m.id, { by, plannedKeep: keepId, reason, expectSha: m.sha256 || null });
        return { trash: `g${id}` };
      }
      const id = await this.trash.removeSimilar(m.id, keepId, { by, reason });
      return { trash: `g${id}` };
    }
    if (m.action === 'merge') {
      const keepM = g.members.find((x) => x.id === keepId);
      if (!keepM || keepM.owner !== 'grabbit') throw new DupeError('The kept copy is not in a Grabbit folder; choose another to keep');
      const id = await this.trash.mergeLocal(m.id, keepId, { by });
      return { trash: `g${id}`, merged: true };
    }
    if (m.action === 'link') {
      const ad = this.adapters.get(m.root);
      // The copy the owner keeps wins when it is in the same app; the
      // suggested target is only used when it is not.
      const target = g.members.find((x) => x.id === keepId && x.root === m.root) || g.members.find((x) => x.id === m.linkTo && x.root === m.root);
      if (!ad || !target) throw new DupeError('No copy in the same app to share with');
      await this.confirmPosts(ad, target, m);
      // Everything needed to record the merge later, should the answer be
      // lost: the op key lets the app say what became of it (resolveOp).
      const opKey = crypto.randomBytes(16).toString('hex');
      const opId = this.dx.opBegin(ad.id, 'link', {
        keep: target.rel, drop: m.rel, sha256: m.sha256, opKey,
        root: m.root, bytes: m.bytes, keep_root: target.root, kind: m.kind, audience: m.audience,
      }, by, this.now());
      try {
        const r = await ad.link(target.rel, m.rel, m.sha256, opKey);
        // The answer names the held entry. Without a usable id there is
        // nothing to restore or purge later, yet the app may have merged:
        // the operation stays pending for the owner to check.
        // TikShortis always answers with a 32-hex uid; the other apps may omit it.
        const badUid = ad.id === 'tikshortis' ? !/^[0-9a-f]{32}$/i.test(String(r && r.uid)) : (r && r.uid != null && !/^[A-Za-z0-9_-]{1,64}$/.test(String(r.uid)));
        if (!r || !Number.isSafeInteger(r.id) || r.id < 1 || badUid) {
          throw new AdapterError(`${ad.app} answered the merge without a valid entry id`, { status: 424, stalled: true, fix: `Check the item in ${ad.app}; it may have been merged.` });
        }
        const ref = r.uid ? `${r.id}:${r.uid}` : String(r.id);
        const tid = this.recordAppDone(opId, ad, { ref, result: r }, () => this.dx.appTrashAdd({
          adapter: ad.id, ref, root: m.root, rel: m.rel, sha256: m.sha256, bytes: m.bytes,
          keep_root: target.root, keep_rel: target.rel, reason: 'Merged in the app (both posts kept)', kind: m.kind, audience: m.audience, app: ad.app, by,
        }, this.now()));
        // The app merged but could not confirm its folder reached the disk.
        if (r.durable === false) this.log(`${ad.app} merged ${m.rel} (entry ${r.id}) without confirming it on disk`);
        return { trash: `a${tid}`, merged: true };
      } catch (e) {
        this.opFailed(opId, e);
        throw e;
      }
    }
    throw new DupeError('Nothing to do for this copy');
  }

  // --- batch ----------------------------------------------------------------------
  // action: trash_extras | mark_reviewed | ignore | keep_both
  async batch({ keys = [], filter = null, action, dryRun = true, by = null, expect = null }) {
    if (!['trash_extras', 'mark_reviewed', 'ignore', 'keep_both'].includes(action)) throw new DupeError('Unknown batch action');
    // Copies move to the trash only from groups the owner picked one by one
    // and only after confirming the count the summary showed: a filter can
    // select groups (its dry run returns their keys) but never trash them.
    if (action === 'trash_extras' && !dryRun) {
      if (filter) throw new DupeError('Select the groups first: a filter cannot move copies to the trash');
      if (!expect || !Number.isFinite(Number(expect.files))) throw new DupeError('Confirm how many copies move to the trash');
    }
    let list = filter ? this.matchingKeys(filter) : [...new Set(keys.map(String))];
    if (list.length > MAX_BATCH_GROUPS) throw new DupeError(`At most ${MAX_BATCH_GROUPS} groups at once`);
    const all = new Map(this.build().groups.map((g) => [g.key, g]));
    const groups = list.map((k) => all.get(k)).filter(Boolean);
    const summary = { groups: groups.length, files: 0, bytes: 0, apps: new Set(), blocked: [], similarSkipped: 0, otherActions: 0 };
    for (const g of groups) {
      if (action !== 'trash_extras') { summary.files += g.files; continue; }
      if (g.match !== 'exact') { summary.similarSkipped++; continue; }
      const kept = g.members.find((x) => x.id === g.keepId);
      const counted = new Set(kept ? [`${kept.dev}:${kept.ino}`] : []);
      for (const m of g.members) {
        if (m.recommended) continue;
        // Only copies this action moves are counted: a suggested merge or
        // app link is its own confirmed action and is listed apart.
        if (m.suggested && m.action && m.action !== 'trash') {
          summary.otherActions++;
        } else if (m.suggested && m.action) {
          summary.files++;
          const unit = `${m.dev}:${m.ino}`;
          if (!counted.has(unit)) {
            counted.add(unit);
            summary.bytes += m.bytes;
          }
          summary.apps.add(m.app || m.rootLabel);
        } else if (!m.action && !(m.why || '').startsWith('Already stored once')) {
          summary.blocked.push({ group: g.key, name: m.name, why: m.why, fix: m.fix || null });
        }
      }
    }
    const pub = { ...summary, apps: [...summary.apps], blocked: summary.blocked.slice(0, 50), blockedTotal: summary.blocked.length };
    if (dryRun) return { dryRun: true, ...pub, ...(filter ? { keys: groups.map((g) => g.key) } : {}) };
    if (action === 'trash_extras' && Number(expect.files) !== pub.files) {
      throw new DupeError('The selection changed since the summary; review it again', 409);
    }
    if (action !== 'trash_extras') {
      const map = { mark_reviewed: 'reviewed', ignore: 'ignore', keep_both: 'keep_both' };
      for (const g of groups) await this.act(g.key, map[action], { by });
      return { dryRun: false, ...pub, done: groups.length };
    }
    return this.exclusive(`batch ${action}`, async () => {
      const out = { dryRun: false, ...pub, done: 0, doneBytes: 0, refused: [] };
      for (const g of groups) {
        if (g.match !== 'exact') continue;
        const r = await this.applyGroup(g, 'trash_extras', { by });
        out.done += r.done.length;
        out.doneBytes += r.bytes;
        out.refused.push(...r.refused.map((x) => ({ group: g.key, ...x })));
      }
      out.refused = out.refused.slice(0, 100);
      return out;
    });
  }

  // --- trash --------------------------------------------------------------------
  trashEntries() {
    const meta = this.dx.allTrashMeta();
    const own = this.trash ? this.trash.held().map((t) => {
      const m = meta.get(t.id) || {};
      const r = this.rootInfo(t.root);
      const c = classify(r, t.rel);
      return {
        id: `g${t.id}`, source: 'grabbit', app: m.app || r.app || 'Grabbit', name: path.basename(t.rel), rel: t.rel, rootLabel: r.label || t.root,
        bytes: t.bytes, at: t.at, by: t.by, expiresAt: t.purgeAt, reason: m.reason || 'Identical copy (before 3.0.4)', kind: m.kind || c.kind,
        audience: m.audience || audienceOf(r, null), merged: m.reason === 'merged', preview: true,
      };
    }) : [];
    const days = this.cfg().trashRetentionDays;
    const apps = this.dx.appTrashHeld().map((t) => {
      const r = this.rootInfo(t.root);
      return {
        id: `a${t.id}`, source: 'app', app: t.app || r.app, name: path.basename(t.rel), rel: t.rel, rootLabel: r.label || t.root,
        bytes: t.bytes, at: t.at, by: t.by, expiresAt: days ? t.at + days * 86400000 : null, reason: t.reason, kind: t.kind,
        audience: t.audience || audienceOf(r, null), merged: true, preview: false,
      };
    });
    return own.concat(apps).sort((a, b) => b.at - a.at);
  }

  trashSummary() {
    const all = this.trashEntries();
    // The exact set of entries, so "empty" deletes only what the owner saw:
    // another set with the same count and size gives another fingerprint.
    const fingerprint = crypto.createHash('sha256').update(all.map((t) => t.id).sort().join(',')).digest('hex').slice(0, 32);
    return { files: all.length, bytes: all.reduce((n, t) => n + t.bytes, 0), fingerprint, retentionDays: this.cfg().trashRetentionDays };
  }

  trashList(q = {}) {
    const adult = ['hide', 'show', 'only'].includes(q.adult) ? q.adult : 'hide';
    let all = this.trashEntries();
    const hiddenAdult = adult === 'hide' ? all.filter((t) => t.audience === 'adult').length : 0;
    if (adult === 'hide') all = all.filter((t) => t.audience !== 'adult');
    if (adult === 'only') all = all.filter((t) => t.audience === 'adult');
    if (q.app) all = all.filter((t) => t.app === q.app);
    if (q.type) all = all.filter((t) => t.kind === q.type);
    if (q.q) {
      const s = String(q.q).toLowerCase().slice(0, 200);
      all = all.filter((t) => t.rel.toLowerCase().includes(s) || (t.reason || '').toLowerCase().includes(s));
    }
    const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    return {
      total: all.length,
      bytes: all.reduce((n, t) => n + t.bytes, 0),
      hiddenAdult,
      apps: [...new Set(this.trashEntries().map((t) => t.app))].sort(),
      summary: this.trashSummary(),
      unfinished: this.unfinishedOps(),
      offset,
      limit,
      items: all.slice(offset, offset + limit).map((t) => ({ ...t, preview: t.preview && !(t.audience === 'adult' && adult === 'hide') })),
    };
  }

  parseTrashId(id) {
    const m = /^([ga])([1-9][0-9]{0,15})$/.exec(String(id));
    if (!m) throw new DupeError('Not a trash entry');
    return { source: m[1] === 'g' ? 'grabbit' : 'app', id: Number(m[2]) };
  }

  async trashRestore(ids, by) {
    return this.exclusive('restore', async () => {
      const out = { done: [], refused: [] };
      for (const raw of ids) {
        try {
          const t = this.parseTrashId(raw);
          if (t.source === 'grabbit') {
            const r = await this.trash.restore(t.id);
            out.done.push({ id: raw, rel: r.restoredRel, renamed: r.renamed });
          } else {
            const e = this.dx.appTrashGet(t.id);
            if (!e || e.restored_at || e.purged_at) throw new DupeError('Not in the trash');
            const ad = [...this.adapters.values()].find((a) => a.id === e.adapter);
            if (!ad) throw new DupeError(`${e.app} is not connected`);
            const opId = this.dx.opBegin(ad.id, 'restore', { ref: e.ref }, by, this.now());
            try {
              const r = await ad.restore(e.ref);
              this.recordAppDone(opId, ad, { ref: e.ref, result: r }, () => this.dx.appTrashDone(t.id, 'restored_at', this.now()));
            } catch (err) {
              this.opFailed(opId, err);
              throw err;
            }
            out.done.push({ id: raw, rel: e.rel });
          }
        } catch (e) {
          out.refused.push({ id: raw, error: e.message, fix: e.fix || null });
        }
      }
      this.log(`trash restore by ${by || 'owner'}: ${out.done.length} restored, ${out.refused.length} refused`);
      return out;
    });
  }

  async trashDelete(ids, by) {
    return this.exclusive('delete', async () => {
      const out = { done: 0, bytes: 0, refused: [] };
      for (const raw of ids) {
        try {
          const r = await this.deleteOne(raw, by);
          out.done++;
          out.bytes += r.bytes;
        } catch (e) {
          out.refused.push({ id: raw, error: e.message, fix: e.fix || null });
        }
      }
      this.log(`trash delete by ${by || 'owner'}: ${out.done} deleted (${out.bytes} bytes), ${out.refused.length} refused`);
      return out;
    });
  }

  async deleteOne(raw, by) {
    const t = this.parseTrashId(raw);
    if (t.source === 'grabbit') return this.trash.deletePermanently(t.id);
    const e = this.dx.appTrashGet(t.id);
    if (!e || e.restored_at || e.purged_at) throw new DupeError('Not in the trash');
    const ad = [...this.adapters.values()].find((a) => a.id === e.adapter);
    if (!ad) throw new DupeError(`${e.app} is not connected`);
    const opId = this.dx.opBegin(ad.id, 'purge', { ref: e.ref }, by, this.now());
    try {
      const r = await ad.purge(e.ref);
      this.recordAppDone(opId, ad, { ref: e.ref, result: r }, () => this.dx.appTrashDone(t.id, 'purged_at', this.now()));
      return { bytes: e.bytes };
    } catch (err) {
      this.opFailed(opId, err);
      throw err;
    }
  }

  // Empties the whole trash, if it still holds what the owner confirmed.
  async trashEmpty(expect, by) {
    const s = this.trashSummary();
    if (!expect || Number(expect.files) !== s.files || Number(expect.bytes) !== s.bytes || expect.fingerprint !== s.fingerprint) {
      throw new DupeError('The trash changed since you opened it; check it again', 409);
    }
    const ids = this.trashEntries().map((t) => t.id);
    const r = await this.trashDelete(ids, by);
    this.log(`trash emptied by ${by || 'owner'}: ${r.done} files, ${r.bytes} bytes`);
    return r;
  }

  // App entries past the retention time are purged by the app (best effort;
  // an unreachable app is tried again next hour). Runs under the lock that
  // restore and delete use, so an entry is never purged while it is restored;
  // when that lock is held, the purge waits for the next hour.
  async purgeAppTrash() {
    const days = this.cfg().trashRetentionDays;
    if (!days) return 0;
    return this.whenFree('retention purge', async () => {
      let n = 0;
      for (const e of this.dx.appTrashHeld()) {
        // Re-read each time: switching to manual cleanup during a slow purge
        // stops the remaining requests.
        const d = this.cfg().trashRetentionDays;
        if (!d) break;
        if (e.at + d * 86400000 > this.now()) continue;
        try {
          await this.deleteOne(`a${e.id}`, 'retention');
          n++;
        } catch {
          // retried next time
        }
      }
      return n;
    }, 0);
  }

  // Grabbit's own held copies past the hold time, under the same lock.
  async purgeGrabbitTrash() {
    if (!this.trash) return 0;
    return this.whenFree('retention purge', async () => this.trash.purge(), 0);
  }

  // --- cache & thumbnails ---------------------------------------------------------
  async cacheReport() {
    const per = new Map();
    for (const r of this.db.prepare('SELECT root, rel, bytes, sha256 FROM file_hashes WHERE gone_at IS NULL').iterate()) {
      const info = this.rootInfo(r.root);
      const c = classify(info, r.rel);
      if (c.cls !== 'derivative') continue;
      const k = `${info.app || info.label}|${c.what}`;
      if (!per.has(k)) per.set(k, { app: info.app || info.label, what: c.what, files: 0, bytes: 0, regenerable: c.regenerable });
      const e = per.get(k);
      e.files++;
      e.bytes += r.bytes;
    }
    const dupGroups = this.build().groups.filter((g) => g.tab === 'cache');
    const apps = [];
    for (const ad of new Set(this.adapters.values())) {
      if (!ad.caps.has('cache')) continue;
      try {
        const r = await ad.cache();
        apps.push({ app: ad.app, id: ad.id, ok: true, ...r });
      } catch (e) {
        apps.push({ app: ad.app, id: ad.id, ok: false, error: e.message, fix: e.fix || null });
      }
    }
    return {
      kinds: [...per.values()].sort((a, b) => b.bytes - a.bytes),
      files: [...per.values()].reduce((n, e) => n + e.files, 0),
      bytes: [...per.values()].reduce((n, e) => n + e.bytes, 0),
      duplicateGroups: dupGroups.length,
      duplicateFiles: dupGroups.reduce((n, g) => n + g.files - 1, 0),
      duplicateBytes: dupGroups.reduce((n, g) => n + g.stored - g.bytes, 0),
      apps,
    };
  }

  // retryFailed (rebuild only): egram retries the thumbnails that failed in
  // the last 30 minutes instead of skipping them. cursor (rebuild only):
  // egram's own resume point from its previous answer, passed back verbatim.
  async cacheAction(appId, action, dryRun, by, { retryFailed = false, cursor = null } = {}) {
    const ad = [...new Set(this.adapters.values())].find((a) => a.id === appId);
    if (!ad) throw new DupeError('Unknown app', 404);
    if (!['clean', 'rebuild'].includes(action)) throw new DupeError('Unknown cache action');
    // A resume point that is not (or no longer) valid is the one error that
    // tells the page to forget it: code 'bad_cursor'. Any other failure
    // (a timeout, an outage, a busy app) keeps the saved place.
    const badCursor = () => Object.assign(new DupeError('The saved rebuild position is no longer valid; start the rebuild again', 400), { code: 'bad_cursor' });
    if (cursor != null && !(typeof cursor === 'string' ? /^[A-Za-z0-9_:.-]{1,200}$/.test(cursor) : Number.isSafeInteger(cursor) && cursor >= 0)) {
      throw badCursor();
    }
    const body = { dryRun: Boolean(dryRun), retryFailed: Boolean(retryFailed), ...(cursor != null ? { cursor } : {}) };
    const run = () => (action === 'clean' ? ad.cacheClean(dryRun) : ad.cacheRebuild(body).catch((e) => {
      // egram answers a cursor it did not hand out with 400 "Invalid cursor".
      if (cursor != null && e instanceof AdapterError && !e.stalled && /^Invalid cursor$/i.test(e.message)) throw badCursor();
      throw e;
    }));
    if (dryRun) return run();
    return this.exclusive(`cache ${action}`, async () => {
      const opId = this.dx.opBegin(ad.id, `cache-${action}`, {}, by, this.now());
      try {
        const r = await run();
        this.recordAppDone(opId, ad, { result: r }, () => null);
        this.log(`cache ${action} in ${ad.app} by ${by || 'owner'}: ${JSON.stringify(r).slice(0, 200)}`);
        return r;
      } catch (e) {
        this.opFailed(opId, e);
        throw e;
      }
    });
  }

  // Right before a merge: the app is asked again which posts use the two
  // copies. A merge keeps two posts, so each copy needs one; otherwise the
  // app would refuse anyway, and Grabbit says why without asking it to.
  async confirmPosts(ad, target, m) {
    if (!ad.caps.has('lookup')) throw new DupeError(`${ad.app} cannot say which posts use these copies, so Grabbit does not merge them`, 409);
    const askedAt = this.now();
    let r;
    try {
      r = await ad.lookup([target.rel, m.rel]);
    } catch (e) {
      throw new DupeError(`${ad.app} could not say which posts use these copies (${e.message}); nothing changed`, 409);
    }
    if (this.noteRefs([target, m], r, askedAt)) this.invalidate();
    const count = (x) => {
      const it = r.get(x.rel);
      return it && Array.isArray(it.refs) ? it.refs.length : null;
    };
    const drop = count(m);
    const kept = count(target);
    if (drop == null || kept == null) throw new DupeError(`${ad.app} did not report on these copies; nothing changed`, 409);
    if (drop === 0) {
      throw new DupeError(`No ${ad.app} post uses ${m.name}, so there is nothing to merge`, 409, `Check it in ${ad.app}: it may be left over from an earlier import.`);
    }
    if (kept === 0) {
      throw new DupeError(`No ${ad.app} post uses the copy to keep (${target.name})`, 409, 'Keep a copy that a post uses.');
    }
  }

  // --- app references ----------------------------------------------------------------
  // What the apps say about the copies of one group (posts, likes, comments).
  async references(key) {
    const g = this.findGroup(key);
    const out = {};
    const byRoot = new Map();
    for (const m of g.members) {
      const ad = this.adapters.get(m.root);
      if (!ad || !ad.caps.has('lookup')) continue;
      if (!byRoot.has(m.root)) byRoot.set(m.root, { ad, members: [] });
      byRoot.get(m.root).members.push(m);
    }
    for (const { ad, members } of byRoot.values()) {
      try {
        const askedAt = this.now();
        const r = await ad.lookup(members.map((m) => m.rel));
        if (this.refsAdapter(members[0].root) && this.noteRefs(members, r, askedAt)) this.invalidate();
        // A copy the app left out of its answer is unknown, not unused.
        for (const m of members) out[m.id] = { app: ad.app, ...(r.get(m.rel) || { error: `${ad.app} did not report on this copy` }) };
      } catch (e) {
        for (const m of members) out[m.id] = { app: ad.app, error: e.message };
      }
    }
    return out;
  }

  // --- duplicate prevention --------------------------------------------------------------
  // After a job saved a file: is it already somewhere? Exact bytes first, then
  // (pictures) a perceptual match. Never blocks the job; the finding lands on
  // the job and in the prevention log.
  async checkSaved(job) {
    const cfg = this.cfg();
    if (!cfg.prevention.enabled) return null;
    const findings = [];
    for (const abs of job.savedPaths.slice(0, 20)) {
      const hit = await this.checkFile(abs, job, cfg);
      if (hit) findings.push(hit);
    }
    if (findings.length && this.onJobDuplicate) this.onJobDuplicate(job, findings[0], findings);
    return findings;
  }

  rootForAbs(abs) {
    const real = (() => { try { return fs.realpathSync(abs); } catch { return null; } })();
    if (!real) return null;
    for (const r of this.roots) {
      if (!r.path) continue;
      let rr;
      try { rr = fs.realpathSync(r.path); } catch { continue; }
      if (real.startsWith(rr + path.sep)) return { root: r, rel: path.relative(rr, real), real };
    }
    return null;
  }

  async checkFile(abs, job, cfg) {
    const where = this.rootForAbs(abs);
    let st;
    try { st = fs.lstatSync(abs); } catch { return null; }
    if (!st.isFile()) return null;
    const sha = await sha256File(abs);
    const others = this.db.prepare('SELECT id, root, rel, bytes, dev, ino FROM file_hashes WHERE sha256 = ? AND gone_at IS NULL').all(sha)
      .filter((o) => !(where && o.root === where.root.path && o.rel === where.rel) && !(o.dev === st.dev && o.ino === st.ino));
    const app = where ? where.root.app || 'Grabbit' : 'Grabbit';
    const kindRule = cfg.prevention.perApp[app] || cfg.prevention;
    if (others.length) {
      const o = others[0];
      const oInfo = this.rootInfo(o.root);
      let action = kindRule.exact || 'review';
      let detail = null;
      // Exact physical dedup never destroys a new post: in an app folder the
      // copy stays (the app imports it as its own post), and only a copy in
      // Grabbit's own library is skipped or linked.
      if ((action === 'skip' || action === 'link') && !(where && where.root.owner === 'grabbit' && oInfo.owner === 'grabbit')) {
        detail = 'Kept: the new file is a post of its own in an app';
        action = 'review';
      }
      // Linking or skipping changes files, so it takes the lock the owner's
      // actions use; while one of those runs, the new copy simply stays.
      if ((action === 'link' || action === 'skip') && where) {
        const done = await this.whenFree(`prevention ${job.id}`, async () => {
          if (action === 'link' && where) {
            try {
              const keepAbs = path.join(o.root, o.rel);
              // The copy linked in must be a plain file inside its own folder:
              // never a symlink, and never reached through one.
              const ks = fs.lstatSync(keepAbs);
              if (!ks.isFile()) throw new Error('the existing copy is not a plain file');
              const realRoot = fs.realpathSync(o.root);
              if (fs.realpathSync(keepAbs) !== path.join(realRoot, path.relative(o.root, keepAbs))) throw new Error('the existing copy is reached through a symlink');
              if (ks.dev !== st.dev) throw new Error('different disks');
              const tmp = `${abs}.dedupe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
              fs.linkSync(keepAbs, tmp);
              // The stage is the existing copy's inode; it is removed again
              // only while it still is that inode.
              const ss = fs.lstatSync(tmp);
              const drop = () => { try { const n = fs.lstatSync(tmp); if (n.dev === ss.dev && n.ino === ss.ino) fs.unlinkSync(tmp); } catch {} };
              if (ss.dev !== ks.dev || ss.ino !== ks.ino) { drop(); throw new Error('the existing copy changed'); }
              let hashed;
              try { hashed = await sha256File(tmp); } catch (e) { drop(); throw e; }
              if (hashed !== sha) { drop(); throw new Error('the existing copy changed'); }
              // The hash was slow: right before the rename the stage must
              // still be the inode that was hashed (unchanged), and the
              // download still the file that was hashed. A newer file in
              // either place is never renamed or overwritten.
              let stage = null;
              let now = null;
              try { stage = fs.lstatSync(tmp); } catch {}
              try { now = fs.lstatSync(abs); } catch {}
              if (!stage || !stage.isFile() || stage.dev !== ss.dev || stage.ino !== ss.ino || stage.size !== ss.size || stage.mtimeMs !== ss.mtimeMs) {
                drop();
                throw new Error('the existing copy changed while it was checked');
              }
              if (!now || !now.isFile() || now.dev !== st.dev || now.ino !== st.ino || now.size !== st.size || now.mtimeMs !== st.mtimeMs) {
                drop();
                throw new Error('the new file changed while it was checked');
              }
              // The download is taken aside first: a file a writer put at its
              // name after the look above goes back instead of being replaced.
              let swapped = false;
              try {
                swapped = replaceWith(abs, (n) => n.dev === st.dev && n.ino === st.ino && n.size === st.size && n.mtimeMs === st.mtimeMs, tmp);
              } catch (e) { drop(); throw e; }
              if (!swapped) { drop(); throw new Error('the new file changed while it was checked'); }
              detail = `Now stored once with ${oInfo.label}/${o.rel}`;
            } catch (e) {
              action = 'review';
              detail = `Could not link (${e.message}); kept`;
            }
          }
          if (action === 'skip' && where && this.trash) {
            try {
              // The new copy goes to the trash (restorable), the library keeps the
              // existing one. The scan has not seen the new file yet: record it.
              this.store.fileSeen(where.root.path, where.rel, st, this.now());
              const row = this.db.prepare('SELECT * FROM file_hashes WHERE root = ? AND rel = ?').get(where.root.path, where.rel);
              this.store.fileHashed(row.id, { sha256: sha, ...this.store.fileLink(path.basename(where.rel)) }, this.now());
              const fresh = this.store.dupeFile(row.id);
              await this.trash.remove(fresh.id, { by: 'prevention', plannedKeep: o.id, reason: 'Duplicate prevention: already in the library' });
              detail = `Moved to the trash: identical to ${oInfo.label}/${o.rel}`;
            } catch (e) {
              action = 'review';
              detail = `Kept (${e.message})`;
            }
          }
          return { action, detail };
        }, null);
        if (done) ({ action, detail } = done);
        else { action = 'review'; detail = 'Kept: another duplicate operation was running'; }
      }
      const p = { job_id: job.id, root: where ? where.root.path : null, rel: where ? where.rel : path.basename(abs), sha256: sha, match: 'exact', other_root: o.root, other_rel: o.rel, action, detail };
      this.dx.preventionAdd(p, this.now());
      this.invalidate();
      return { match: 'exact', action, other: `${oInfo.label}/${o.rel}`, detail };
    }
    // Pictures: perceptual match against the analysed library (review only).
    if (where && classify(where.root, where.rel).kind === 'image' && flags().photo && cfg.photo) {
      try {
        const media = require('./dupe-media');
        const img = await media.readImage(abs);
        const h = hashFrame(img.gray, { rotations: true });
        const near = this.findNearPicture(h);
        if (near && cfg.prevention.perceptual !== 'keep') {
          const files = this.filesOfShas([near.sha256]);
          const o = files[0];
          if (o) {
            const oInfo = this.rootInfo(o.root);
            this.dx.preventionAdd({ job_id: job.id, root: where.root.path, rel: where.rel, sha256: sha, match: 'photo', other_root: o.root, other_rel: o.rel, action: 'review', detail: `Perceptual hash within ${near.d} bits` }, this.now());
            if (this.analyzer) this.analyzer.markDirty('photo');
            return { match: 'photo', action: 'review', other: `${oInfo.label}/${o.rel}`, detail: 'Looks like a picture already in the library; sent to review' };
          }
        }
      } catch {
        // A picture that cannot be read is simply not checked.
      }
    }
    return null;
  }

  findNearPicture(h) {
    const now = this.now();
    if (!this.phIndex || now - this.phIndex.at > 10 * 60 * 1000) {
      this.phIndex = { at: now, rows: this.dx.featureRows('image').filter((f) => f.phash).map((f) => ({ sha256: f.sha256, hs: [f.phash, ...(f.phash_rot ? f.phash_rot.split(',') : [])] })) };
    }
    let best = null;
    for (const r of this.phIndex.rows) {
      for (const x of r.hs) {
        const d = hamming(h.phash, x);
        if (d <= 5 && (!best || d < best.d)) best = { sha256: r.sha256, d };
      }
    }
    return best;
  }

  // --- AI model --------------------------------------------------------------------------
  modelStatus() {
    return {
      runtime: Boolean(ai.runtime()),
      flags: flags(),
      models: this.models ? this.models.status() : [],
      thresholds: Object.fromEntries(Object.keys(ai.MODELS).map((k) => [k, ai.thresholdFor(k, this.cfg().sensitivity)])),
    };
  }
}

module.exports = { DupeService, DupeError, TABS, SORTS, AdapterError, TrashError };
