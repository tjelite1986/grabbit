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

function refBody(ref) {
  const [id, uid] = String(ref).split(':');
  return uid ? { id: Number(id), uid } : { id: Number(id) };
}

// Transport errors that mean the request never reached the app.
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL']);

class AdapterError extends Error {
  constructor(message, { status = 409, fix = null, stalled = false, appRef = null } = {}) {
    super(message);
    this.status = status;
    this.fix = fix;
    // The app may or may not have carried the request out.
    this.stalled = stalled;
    // The held entry the app says it may have made ("<id>:<uid>").
    this.appRef = appRef;
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
    const mutation = method !== 'GET' && route !== 'lookup';
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
      // A timeout before the answer's headers is no proof that nothing
      // happened: the app may have done the change and been slow to reply.
      // Changes are then treated like an answer that stopped half way, so
      // the operation stays pending for the owner to check.
      if (ctrl.signal.aborted && mutation) {
        throw new AdapterError(`${this.app} did not answer in time`, { status: 424, fix: `The request may have been carried out; check the item in ${this.app} before trying again.`, stalled: true });
      }
      // Only a connection that never opened proves nothing happened. A reset
      // or hang-up after the request went out may follow a committed change.
      const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
      if (mutation && !NEVER_SENT.has(code)) {
        throw new AdapterError(`${this.app} dropped the connection before answering`, { status: 424, fix: `The request may have been carried out; check the item in ${this.app} before trying again.`, stalled: true });
      }
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
    // A success status without a readable answer (a proxy page, a cut body)
    // says the app may have acted; a change then stays pending too.
    if (!stalled && mutation && res.ok && (!j || typeof j !== 'object')) stalled = true;
    if (stalled) {
      throw new AdapterError(`${this.app} stopped answering half way`, { status: 424, fix: `The request may have been carried out; check the item in ${this.app} before trying again.`, stalled: true });
    }
    // A change closes as "nothing happened" only on a 4xx whose body is a
    // fully read JSON error from the app without `mayHaveChanged`. A 5xx
    // (a proxy's 502/504 included), a body that could not be read (a cut
    // 422 may have lost its `mayHaveChanged`), a success status that says
    // ok: false, and a marked answer all leave the operation pending.
    const isObj = j && typeof j === 'object' && !Array.isArray(j);
    const definiteRefusal = res.status >= 400 && res.status < 500 && isObj && typeof j.error === 'string' && j.mayHaveChanged !== true;
    if (mutation && (!res.ok || j.ok === false) && !definiteRefusal) {
      const ref = isObj && Number.isSafeInteger(j.id) && j.id > 0 ? (j.uid != null && /^[A-Za-z0-9_-]{1,64}$/.test(String(j.uid)) ? `${j.id}:${j.uid}` : String(j.id)) : null;
      throw new AdapterError((isObj && typeof j.error === 'string' && j.error) || `${this.app} failed while carrying out the request (HTTP ${res.status})`, {
        status: 424, stalled: true, appRef: ref,
        fix: `The request may have been carried out${ref ? ` (${this.app} held entry ${ref})` : ''}; check the item in ${this.app} before trying again.`,
      });
    }
    if (res.status === 404 && (!j || !j.error)) {
      throw new AdapterError(`${this.app} does not have the dedupe operations yet`, { status: 424, fix: `Install the ${this.app} version that ships the Grabbit dedupe v1 routes.` });
    }
    if (!res.ok || !j || j.ok === false) {
      // Here a mutation's answer is a definite refusal (see above): nothing changed.
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

  // A held entry is named by the app's id plus the random uid its link
  // answer carried ("<id>:<uid>"), so an id the app reuses after a database
  // restore never points at another merge. The app refuses a missing uid.
  restore(ref) { return this.call('POST', 'restore', refBody(ref)); }
  purge(ref) { return this.call('POST', 'purge', refBody(ref)); }

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
