'use strict';
// Grabbit 3.0 native Adshortis (ADSHORTIS_MODE=native), drawn by the hub.
//
// Every request goes to Grabbit's gateway at /api/ads/*, which forwards an
// allowlisted set of Adshortis routes with the viewer's linked Adshortis
// session. This file never talks to Adshortis directly. Every clip here is
// 18+: nothing from this module reaches a general page, the hub search, the
// dashboard or Media (test/ads-isolation.test.js).
//
// Loaded before hub.js. It registers itself in window.GrabbitModules; hub.js
// calls create() once with its helpers. The hub draws #/adshortis/* through
// view() only when the effective mode is native (plan H36); otherwise the
// legacy branches in hub.js run and this module stays idle.
//
// Navigation inside the module (plan H51, H59, H78): hub.js hands every
// hashchange from one #/adshortis/* address to another to onHash(). A clip
// change or a closed player is handled in place; any other change tears the
// old view down (leave) and redraws the module's subtree. Swipes and filter
// changes use hub.replaceHash, which fires no hashchange. Entering or leaving
// the page id goes through the hub's render().
(() => {
  const registry = (window.GrabbitModules = window.GrabbitModules || []);
  registry.push({ id: 'adshortis', create });

  function create(hub) {
    const { h } = hub;
    // replaceChildren() prints null as "null": drop gaps the way h() does.
    const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    const enc = encodeURIComponent;
    const BASE = '#/adshortis';
    const API = '/api/ads';

    // --- Addresses -----------------------------------------------------------
    function link(path, query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query || {})) if (v !== null && v !== undefined && v !== '' && v !== false) q.set(k, String(v));
      const qs = q.toString();
      return `${BASE}${path ? `/${path}` : ''}${qs ? `?${qs}` : ''}`;
    }
    const numId = (v) => (/^[0-9]{1,15}$/.test(String(v || '')) ? String(v) : null);
    // A hash (from a full URL or a bare '#/...') split into the view and its
    // parameters. The view key leaves out `clip`: two addresses with the same
    // key show the same view, maybe with another clip open.
    function parse(url) {
      const s = String(url || '');
      const i = s.indexOf('#');
      const [path, query] = (i >= 0 ? s.slice(i) : '').replace(/^#\/?/, '').split('?');
      const segs = path.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return ''; } });
      const params = new URLSearchParams(query || '');
      const clip = params.get('clip');
      params.delete('clip');
      params.sort();
      return { page: segs[0] || '', sub: segs.slice(1), clip, key: `${segs.slice(1).join('/')}?${params}` };
    }

    // --- Requests ------------------------------------------------------------
    class AdsError extends Error {
      constructor(message, status, body, retryAfter) {
        super(message);
        this.status = status;
        this.reason = body && typeof body.reason === 'string' ? body.reason : null;
        this.retryAfter = retryAfter;
      }
    }
    // Every request of the view on show shares one AbortController; leave()
    // aborts it, so nothing the old view asked for lands in the new one.
    let ctl = new AbortController();
    async function call(path, { method = 'GET', body, signal } = {}) {
      const opts = { method, credentials: 'same-origin', headers: { accept: 'application/json' }, signal: signal || ctl.signal };
      if (body !== undefined) {
        opts.headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      let r;
      try { r = await fetch(`${API}/${path}`, opts); } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new AdsError('No connection to Grabbit', 0);
      }
      let d = null;
      try { d = await r.json(); } catch { /* not JSON */ }
      const retry = Number(r.headers.get('retry-after')) || null;
      if (r.status === 401 && path !== 'session') {
        lostLink();
        throw new AdsError('Signed out of Adshortis', 401, d);
      }
      if (!r.ok || (d && d.ok === false)) throw new AdsError((d && d.error) || `Adshortis answered ${r.status}`, r.status, d, retry);
      return d || {};
    }
    const aborted = (e) => e && e.name === 'AbortError';

    // --- Module state ----------------------------------------------------------
    const S = {
      session: undefined, // { linked, user, reason? } once loaded
      sessionError: null,
      loading: null,
      userId: null, // the linked Adshortis user (plan H17)
    };
    const me = () => (S.session && S.session.linked && S.session.user) || null;

    // The kept browse state (plan H38, UX 9.5 and 10.2): search words, the
    // lists a view loaded and their scroll positions. It lives in this closure
    // only: never in the hash, localStorage or sessionStorage, so a reload
    // drops it. It survives view changes inside the module and is cleared on
    // leaving the page id, unlinking, signing out and an account change.
    const store = {
      words: '', // clip search (explore)
      profileWords: '', // profile directory search
      lists: new Map(), // view key -> { items, cursor, scroll }
    };
    function clearStore() {
      store.words = '';
      store.profileWords = '';
      store.lists.clear();
    }
    const storeEmpty = () => !store.words && !store.profileWords && store.lists.size === 0;

    // Open player and sheets, counted for idle() (the build check, H75).
    const open = { player: null, sheets: 0 };

    let cleanups = [];
    const onLeave = (fn) => { cleanups.push(fn); };
    let generation = 0;
    const live = (gen) => gen === generation;
    // The one teardown (plan H31, H59): stop the player, abort every request,
    // run the view's cleanups. The store stays.
    function leave() {
      generation++;
      ctl.abort();
      ctl = new AbortController();
      const list = cleanups;
      cleanups = [];
      for (const fn of list.reverse()) {
        try { fn(); } catch (e) { console.warn('ads: cleanup failed', e); }
      }
      if (open.player) {
        try { open.player.stop(); } catch (e) { console.warn('ads: player stop failed', e); }
        open.player = null;
      }
      open.sheets = 0;
    }
    // Leaving the page id (hub render to another page), unlink, sign-out.
    function reset() {
      leave();
      clearStore();
    }

    // --- Session (S1-S3) -----------------------------------------------------
    function loadSession(force) {
      if (S.loading && !force) return S.loading;
      // Its own signal: a view change does not cancel the session read the
      // next view waits for too.
      S.loading = call('session', { signal: new AbortController().signal })
        .then((d) => {
          S.session = { linked: !!d.linked, user: d.user || null, reason: d.reason || null, expired: !!d.expired };
          S.sessionError = null;
          const id = me() ? me().id : null;
          // Another Adshortis account: nothing kept from the last one (H17).
          if (S.userId !== null && id !== null && id !== S.userId) clearStore();
          if (id !== null) S.userId = id;
        })
        .catch((e) => {
          // Grabbit's own sign-in is gone: the hub's login, as api() does.
          if (e.status === 401) { location.href = '/login'; return; }
          S.sessionError = e.message || 'Adshortis is not reachable right now.';
        })
        .finally(() => {
          S.loading = null;
          redraw();
          hub.updateNav();
        });
      return S.loading;
    }
    // A member call answered 401: the link ended upstream (or Grabbit's own
    // sign-in is gone). The session route tells them apart.
    let relinking = false;
    function lostLink() {
      if (relinking) return;
      relinking = true;
      fetch(`${API}/session`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((r) => {
          if (r.status === 401) { location.href = '/login'; return; }
          leave();
          S.session = undefined;
          return loadSession(true);
        })
        .catch(() => {})
        .finally(() => { relinking = false; });
    }

    // --- Shared pieces -------------------------------------------------------
    const pageHead = (title, ...extra) => h('div', { class: 'ads-head' }, h('h1', null, title, ' ', h('span', { class: 'chip adult' }, '18+')), ...extra);
    const empty = (text, action) => h('div', { class: 'ads-empty' }, h('p', null, text), action || null);
    function retryBanner(text, again) {
      return h('div', { class: 'ads-banner', role: 'status' }, h('span', null, text), h('button', { type: 'button', class: 'btn ghost', onclick: again }, 'Retry'));
    }

    // --- Link form (UX 5.1) ----------------------------------------------------
    function viewLink() {
      if (S.session && S.session.reason === 'login_id_missing') {
        // H2/H30: this browser holds a Grabbit session without the per-login id.
        return [
          pageHead('Adshortis'),
          empty('Sign in to Grabbit again to use 18+.',
            h('form', { method: 'post', action: '/logout' }, h('button', { class: 'btn', type: 'submit' }, 'Sign out of Grabbit and sign in again'))),
        ];
      }
      const user = h('input', { class: 'field', name: 'username', autocomplete: 'username', required: true, 'aria-label': 'Username', placeholder: 'Username' });
      const pass = h('input', { class: 'field', name: 'password', type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Password', placeholder: 'Password' });
      const msg = h('p', { class: 'ads-form-msg', role: 'alert', hidden: true });
      const btn = h('button', { class: 'btn', type: 'submit' }, 'Sign in');
      const say = (text) => { msg.textContent = text; msg.hidden = !text; };
      const gen = generation;
      const form = h('form', {
        class: 'ads-link',
        onsubmit: (e) => {
          e.preventDefault();
          btn.disabled = true;
          say('');
          call('session', { method: 'POST', body: { username: user.value, password: pass.value } })
            .then((d) => {
              const id = d.user ? d.user.id : null;
              if (S.userId !== null && id !== S.userId) clearStore();
              S.userId = id;
              S.session = { linked: true, user: d.user || null };
              if (live(gen)) redraw();
              hub.updateNav();
            })
            .catch((err) => {
              if (aborted(err)) return;
              btn.disabled = false;
              pass.value = '';
              if (err.status === 401) say('Wrong username or password.');
              else if (err.status === 429) say(`Too many attempts. Try again in ${Math.max(1, Math.ceil((err.retryAfter || 60) / 60))} minutes.`);
              else if (err.status === 403) say('This Adshortis account cannot sign in. Ask the admin.');
              else if (err.reason === 'login_id_missing') { S.session = { linked: false, reason: 'login_id_missing' }; redraw(); }
              else say('Adshortis is not reachable right now.');
            });
        },
      },
      h('h2', null, 'Sign in to Adshortis'),
      h('p', { class: 'muted' }, 'Adshortis has its own accounts. Your sign-in stays in this browser.'),
      user, pass, msg, btn);
      return [pageHead('Adshortis'), form];
    }

    // --- Views ---------------------------------------------------------------
    // Sections in the sidebar (UX 2). Admin is phase 4.
    const SECTIONS = [
      ['feed', 'Feed'],
      ['explore', 'Explore'],
      ['profiles', 'Profiles'],
      ['tags', 'Tags'],
      ['playlists', 'Playlists'],
      ['liked', 'Liked'],
      ['mine', 'Mine'],
      ['upload', 'Upload'],
      ['settings', 'Settings'],
    ];
    // A detail view lights up the section it belongs to.
    const SECTION_OF = { creator: 'profiles', person: 'profiles', tag: 'tags', playlist: 'playlists', hidden: 'settings' };
    // Every route of UX 3. `id` is the second path segment's check: views
    // with an id answer a bad one with "does not exist" before any request.
    // A view without `draw` is not built yet (phase 3 slices C-E): it shows a
    // placeholder and never calls the gateway.
    const VIEWS = {
      feed: { title: 'Feed' },
      explore: { title: 'Explore' },
      profiles: { title: 'Profiles' },
      creator: { title: 'Creator', id: numId },
      person: { title: 'Person', id: numId },
      tags: { title: 'Tags' },
      tag: { title: 'Tag', id: (v) => (v && v.length <= 100 ? v : null) },
      playlists: { title: 'Playlists' },
      playlist: { title: 'Playlist', id: numId },
      liked: { title: 'Liked' },
      mine: { title: 'Mine' },
      hidden: { title: 'Hidden' },
      upload: { title: 'Upload' },
      settings: { title: 'Settings', draw: viewSettings },
    };
    const hasView = (name) => Object.hasOwn(VIEWS, name);

    function viewSettings() {
      const u = me();
      return [
        pageHead('Settings'),
        h('section', { class: 'ads-panel' },
          h('h2', null, 'Adshortis account'),
          h('p', null, 'Signed in as ', h('strong', null, (u && (u.username || u.name)) || 'unknown')),
          h('button', { type: 'button', class: 'btn ghost', onclick: unlink }, 'Sign out of Adshortis')),
      ];
    }
    function unlink() {
      call('session', { method: 'DELETE' })
        .catch(() => {})
        .finally(() => {
          reset();
          S.session = { linked: false, user: null };
          S.userId = null;
          hub.replaceHash(BASE);
          redraw();
          hub.updateNav();
        });
    }

    // Legacy folder-page links (UX 9.1, plan H28, H35, H36), read once and
    // replaced before anything is requested. Only reached in native mode.
    function mapLegacy(r) {
      const p = r.params;
      const creator = p.get('creator');
      if (creator) {
        // H35: the name leaves the address before the request and goes only
        // into the POST body.
        hub.replaceHash(link('profiles'));
        lookupCreator(creator.slice(0, 200));
        return [pageHead('Profiles'), h('p', { class: 'muted' }, 'Looking up the profile ...')];
      }
      const q = p.get('q');
      if (q) {
        store.words = q.slice(0, 200);
        hub.replaceHash(link('explore'));
        return drawView(parse(link('explore')));
      }
      // ?open= and ?seed= name folder ids that do not exist natively.
      hub.replaceHash(link('feed'));
      return drawView(parse(link('feed')));
    }
    function lookupCreator(name) {
      const gen = generation;
      call('creators/lookup', { method: 'POST', body: { name } })
        .then((d) => {
          if (!live(gen)) return;
          const hit = (d.items || []).find((c) => numId(c.id));
          if (hit) hub.replaceHash(link(`creator/${hit.id}`));
          else store.profileWords = name;
          redraw();
          hub.updateNav();
        })
        .catch((e) => {
          if (aborted(e) || !live(gen)) return;
          store.profileWords = name;
          redraw();
          hub.updateNav();
        });
    }

    function drawView(pr) {
      const name = pr.sub[0] || '';
      const v = VIEWS[name];
      if (!v) return [pageHead('Adshortis'), empty('This page does not exist.', h('a', { class: 'btn', href: link('feed') }, 'Go to the feed'))];
      if (v.id && !v.id(pr.sub[1])) return [pageHead(v.title), empty('This page does not exist.', h('a', { class: 'btn', href: link('feed') }, 'Go to the feed'))];
      if (pr.sub.length > (v.id ? 2 : 1)) return [pageHead(v.title), empty('This page does not exist.', h('a', { class: 'btn', href: link('feed') }, 'Go to the feed'))];
      if (!v.draw) return [pageHead(v.title), empty('This section is not built yet.')];
      return v.draw(pr, { onLeave, live: ((g) => () => live(g))(generation), call, store, open });
    }

    function body(r) {
      if (S.session === undefined) {
        if (S.sessionError) {
          return [pageHead('Adshortis'), retryBanner('Adshortis is not reachable right now.', () => { S.sessionError = null; loadSession(true); redraw(); })];
        }
        loadSession();
        return [pageHead('Adshortis'), h('p', { class: 'muted' }, 'Loading ...')];
      }
      if (!S.session.linked) return viewLink();
      // #/adshortis with or without legacy parameters.
      if (!r.sub.length) return mapLegacy(r);
      return drawView(parse(location.hash));
    }

    let root = null;
    function view(r) {
      root = h('div', { class: 'ads-root' }, body(r));
      return root;
    }
    // Redraw the module's subtree in place (plan H38): never the hub's render().
    function redraw() {
      if (!root || !root.isConnected) return;
      fill(root, body(hub.route()));
    }

    // H51/H59: one address inside the module to another.
    function onHash(oldURL, newURL) {
      const a = parse(oldURL);
      const b = parse(newURL);
      if (a.key === b.key && S.session && S.session.linked) {
        // Clip only: the player moves to that clip (a no-op if it is playing).
        if (a.clip && b.clip) {
          if (open.player) open.player.setClip(b.clip);
          hub.updateNav();
          return;
        }
        // Close: the player stops and the grid shows from the store.
        if (a.clip && !b.clip && open.player) {
          const p = open.player;
          open.player = null;
          p.stop();
          hub.updateNav();
          return;
        }
      }
      // View change: one teardown, redraw, then the hub's own steps (H59, H78).
      leave();
      redraw();
      hub.viewChanged();
    }

    function subnav(r) {
      if (!me()) return null;
      const first = r.sub[0] || 'feed';
      const cur = SECTION_OF[first] || first;
      return SECTIONS.map(([id, label]) => ({ href: link(id), label, current: cur === id }));
    }

    // The build check may reload only an idle page (plan H63, H75, H88).
    const idle = () => !open.player && open.sheets === 0 && storeEmpty();

    return { view, leave, reset, subnav, onHash, idle, hasView, link };
  }
})();
