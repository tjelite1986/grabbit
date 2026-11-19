'use strict';
// Cross-app duplicate management: the apps own their files.
//
// Grabbit reads the apps' libraries (read-only mounts) but never writes to
// them. When the owner asks for a copy in an app's library to go, Grabbit asks
// that app to do it, through the app's own authenticated "dedupe v1" routes,
// and the app checks its own database before it touches a file.
//
// Contract (each app implements what applies to it):
//   POST /api/dedupe/v1/lookup  { paths: [appPath] }
//     -> { items: [{ path, role, refs: [{ type, id, label, audience, ... }], nlink, ino }] }
//   POST /api/dedupe/v1/link    { keep: appPath, drop: appPath, sha256 }
//     The app checks both files are its media with those bytes, moves `drop`
//     into its own dedupe trash and puts a hard link to `keep` in its place.
//     Every post keeps its own record, metadata, likes and comments; the
//     bytes are stored once. -> { id, bytes }
//   POST /api/dedupe/v1/restore { id }  -> puts the original file back.
//   POST /api/dedupe/v1/purge   { id }  -> deletes the held original for good.
//   GET  /api/dedupe/v1/cache            -> generated files the app can rebuild.
//   POST /api/dedupe/v1/cache/clean { dryRun } -> removes unused ones.
// Auth: header X-Grabbit-Dedupe-Token, a secret shared by Grabbit and the app
// (GRABBIT_DEDUPE_TOKEN_FILE on both sides). Unset means the routes refuse.
//
// An app path is the file's path relative to the library root the app and
// Grabbit both mount (Grabbit: the scan root; the app: its media root).

const fs = require('fs');

class AdapterError extends Error {
  constructor(message, { status = 409, fix = null } = {}) {
    super(message);
    this.status = status;
    this.fix = fix;
  }
}

function readToken(file) {
  if (!file) return null;
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}

class AppAdapter {
  // id: 'tikshortis' | 'egram'; app: label; root: Grabbit's scan root path;
  // prefix: what to strip from a Grabbit rel to get the app path ('' for none);
  // url: the app's origin; token: shared secret; caps: which operations exist.
  constructor({ id, app, root, prefix = '', url, token, caps, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
    Object.assign(this, { id, app, root, prefix, url, token, caps: new Set(caps || []), fetch: fetchImpl, timeoutMs });
  }

  ready() {
    if (!this.url) return { ok: false, why: `${this.app} is not connected to Grabbit (no API address configured)`, fix: `Set ${this.id === 'tikshortis' ? 'TIKSHORTIS_API_URL' : 'EGRAM_API_URL'} in Grabbit's compose file.` };
    if (!this.token) return { ok: false, why: `${this.app} and Grabbit share no dedupe key yet`, fix: 'Mount the same GRABBIT_DEDUPE_TOKEN_FILE into both containers (see the installation plan).' };
    return { ok: true };
  }

  appPath(rel) {
    const r = String(rel);
    // On Linux a backslash is part of a file name. Translating it would point
    // the app at a different file, so such names are refused instead.
    if (r.includes('\\')) throw new AdapterError(`${this.app} cannot be asked about a file name with a backslash`);
    if (!this.prefix) return r;
    if (!r.startsWith(`${this.prefix}/`)) throw new AdapterError(`Not a ${this.app} library file`);
    return r.slice(this.prefix.length + 1);
  }

  async call(method, route, body) {
    const ready = this.ready();
    if (!ready.ok) throw new AdapterError(ready.why, { fix: ready.fix });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.url}/api/dedupe/v1/${route}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-grabbit-dedupe-token': this.token },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        redirect: 'error',
      });
    } catch (e) {
      clearTimeout(timer);
      throw new AdapterError(`${this.app} is not reachable right now`, { status: 424, fix: `Check that ${this.app} is running; nothing was changed.` });
    }
    // The timeout covers the body too: an app that sends headers and then
    // stalls must not hang the request.
    let j = null;
    let stalled = false;
    try {
      j = await new Promise((resolve, reject) => {
        if (ctrl.signal.aborted) return reject(Object.assign(new Error('timeout'), { stalled: true }));
        ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { stalled: true })), { once: true });
        Promise.resolve().then(() => res.json()).then(resolve, reject);
      });
    } catch (e) {
      stalled = Boolean(e && e.stalled);
      j = null;
    } finally {
      clearTimeout(timer);
    }
    if (stalled) {
      throw new AdapterError(`${this.app} stopped answering half way`, { status: 424, fix: `The request may have been carried out; check the item in ${this.app} before trying again.` });
    }
    if (res.status === 404 && (!j || !j.error)) {
      throw new AdapterError(`${this.app} does not have the dedupe operations yet`, { status: 424, fix: `Install the ${this.app} version that ships the Grabbit dedupe v1 routes.` });
    }
    if (!res.ok || !j || j.ok === false) {
      throw new AdapterError((j && j.error) || `${this.app} refused (HTTP ${res.status})`, { status: res.status >= 500 ? 424 : 409, fix: j && j.fix ? j.fix : null });
    }
    return j;
  }

  async lookup(rels) {
    if (!this.caps.has('lookup')) return new Map();
    const paths = rels.map((r) => this.appPath(r));
    const j = await this.call('POST', 'lookup', { paths });
    const out = new Map();
    for (const it of j.items || []) {
      const rel = this.prefix ? `${this.prefix}/${it.path}` : it.path;
      out.set(rel, it);
    }
    return out;
  }

  async link(keepRel, dropRel, sha256) {
    if (!this.caps.has('link')) throw new AdapterError(`${this.app} cannot share one file between posts`);
    return this.call('POST', 'link', { keep: this.appPath(keepRel), drop: this.appPath(dropRel), sha256 });
  }

  restore(id) { return this.call('POST', 'restore', { id: Number(id) }); }
  purge(id) { return this.call('POST', 'purge', { id: Number(id) }); }

  async cache() {
    if (!this.caps.has('cache')) return null;
    return this.call('GET', 'cache');
  }

  cacheClean(dryRun) {
    if (!this.caps.has('cache')) throw new AdapterError(`${this.app} has no cache cleanup`);
    return this.call('POST', 'cache/clean', { dryRun: Boolean(dryRun) });
  }
}

// Why a copy in a library no app adapter covers cannot go, in words the owner
// can act on.
function noAdapterReason(root) {
  if (!root) return { why: 'Unknown folder', fix: null };
  if (root.owner === 'grabbit') return null;
  if (root.importFor) return { why: `Waiting in ${root.app}'s import folder`, fix: `${root.app} imports it, then the copy here can go.` };
  return {
    why: `${root.app || 'This app'} owns this file and has no dedupe operation in Grabbit yet`,
    fix: `Remove it in ${root.app || 'the app'} itself, or mark the group known/OK.`,
  };
}

module.exports = { AppAdapter, AdapterError, readToken, noAdapterReason };
