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
    const shared = window.GrabbitShared;
    const lu = shared.lucide;
    // The hub's one sheet stack (public/hub/shared/sheets.js).
    const SH = shared.sheets({ h, closeIcon: () => lu('x', 20), onError: (e) => hub.toast((e && e.message) || 'Something went wrong.') });
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
    // `grid` is the explore view's opener for a clip link onto its own grid.
    const open = { player: null, sheets: 0, grid: null };

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
      open.grid = null;
      // A sheet of the old view (comments, share, re-link) never outlives it.
      SH.closeAll();
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
    // A member call answered 401, or the clip on screen failed to load: the
    // link may have ended upstream (or Grabbit's own sign-in is gone). The
    // session route tells them apart. Plan H17 / UX 9.2: with a player on
    // screen only its media is unloaded; the clip, the list and the cursor
    // stay, and a re-link sheet opens. Linking again as the same Adshortis
    // user plays on; another user starts over at the top of the feed.
    let relinking = false;
    function lostLink() {
      if (relinking) return;
      relinking = true;
      const gen = generation;
      fetch(`${API}/session`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(async (r) => {
          if (r.status === 401) { location.href = '/login'; return; }
          let d = null;
          try { d = await r.json(); } catch { /* not JSON */ }
          // Still linked as the same account: the failure was something else
          // (a dead clip). Linked as another account (another tab re-linked,
          // 3a review C-B2): nothing of the old account stays on screen.
          if (r.ok && d && d.linked && d.user && d.user.id === S.userId) return;
          if (!live(gen)) return;
          if (r.ok && d && d.linked) { adoptSession(d); return; }
          const p = open.player;
          if (p && p.suspend && r.ok) { relinkSheet(p); return; }
          leave();
          S.session = undefined;
          return loadSession(true);
        })
        .catch(() => {})
        .finally(() => { relinking = false; });
    }
    // This tab now talks as another account, or as none: drop the view, the
    // player and the store, then draw for the session given (H17).
    function adoptSession(d) {
      reset();
      S.session = { linked: !!d.linked, user: d.user || null, reason: d.reason || null, expired: !!d.expired };
      S.userId = d.linked && d.user ? d.user.id : null;
      redraw();
      hub.updateNav();
    }
    // The link cookie is shared by every tab of this browser. A tab that links,
    // re-links or signs out tells the others (3a review C-B2); they re-read the
    // session and keep nothing from another account. Same account: no change.
    const linkChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('grabbit-ads-link') : null;
    function announceLink() {
      try { if (linkChannel) linkChannel.postMessage('changed'); } catch { /* best effort */ }
    }
    // Probes overlap when links change fast; only the newest answer counts,
    // and it is compared with the account on screen when it lands (Codex
    // re-check NEW-B1). A failed probe fails closed: nothing of the old
    // account stays, the page says Adshortis is not reachable (C-B2).
    let probeSeq = 0;
    if (linkChannel) {
      linkChannel.onmessage = () => {
        const seq = ++probeSeq;
        call('session', { signal: new AbortController().signal })
          .then((d) => {
            if (seq !== probeSeq) return;
            const was = me() ? S.userId : null;
            const id = d && d.linked && d.user ? d.user.id : null;
            if (id !== null && id === was) return;
            adoptSession(d || {});
          })
          .catch((e) => {
            if (seq !== probeSeq) return;
            if (e.status === 401) { location.href = '/login'; return; }
            reset();
            S.session = undefined;
            S.sessionError = 'Adshortis is not reachable right now.';
            redraw();
            hub.updateNav();
          });
      };
    }
    function relinkSheet(p) {
      const was = S.userId;
      p.suspend();
      let linked = false;
      const sheet = SH.open('Signed out of Adshortis', linkForm((d) => {
        linked = true;
        const id = d.user ? d.user.id : null;
        S.session = { linked: true, user: d.user || null };
        sheet.close();
        hub.updateNav();
        if (id !== null && id === was) { p.resume(); return; }
        // Another account: nothing kept from the last one (H17).
        S.userId = id;
        reset();
        hub.replaceHash(link('feed'));
        redraw();
        hub.viewChanged();
      }, 'Sign in again to keep watching. Your place in the list is kept.'), {
        cls: 'ads-sheet',
        // Closed without signing in: the module's own link page.
        onClose: () => {
          if (linked) return;
          setTimeout(() => {
            if (linked) return;
            leave();
            S.session = { linked: false, user: null };
            redraw();
            hub.updateNav();
          }, 0);
        },
      });
    }

    // --- Shared pieces -------------------------------------------------------
    const pageHead = (title, ...extra) => h('div', { class: 'ads-head' }, h('h1', null, title, ' ', h('span', { class: 'chip adult' }, '18+')), ...extra);
    const empty = (text, action) => h('div', { class: 'ads-empty' }, h('p', null, text), action || null);
    function retryBanner(text, again) {
      return h('div', { class: 'ads-banner', role: 'status' }, h('span', null, text), h('button', { type: 'button', class: 'btn ghost', onclick: again }, 'Retry'));
    }

    // --- Feed: the vertical player (plan H64, H65, H79, H87; UX 4) ----------
    // The shared core (public/hub/shared/feed-player.js) plays the clips; this
    // is Adshortis' part: the query and the address, the chip row and the
    // filters, the card's rail and caption, and every sheet behind them.
    const FEEDS = [['foryou', 'For You'], ['new', 'New'], ['random', 'Random'], ['following', 'Following'], ['liked', 'Liked']];
    const GENRES = [['straight', 'Straight'], ['gay', 'Gay'], ['lesbian', 'Lesbian'], ['trans', 'Trans'], ['solo', 'Solo'], ['short', 'Short'], ['other', 'Other'], ['uncategorized', 'Uncategorized']];
    const LENGTHS = [['short', 'Under 1 min'], ['long', 'Over 1 min']];
    const REASONS = [['no_play', 'Does not play'], ['wrong_meta', 'Wrong creator or title'], ['duplicate', 'Duplicate'], ['inappropriate', 'Inappropriate'], ['other', 'Other']];
    const SPEEDS = [0.5, 1, 1.5, 2];
    const PAGE = 20; // H64: at most 60
    const TAG_RE = /^[\p{L}\p{N}_]{1,60}$/u;
    const labelOf = (list, v) => (list.find(([k]) => k === v) || [null, v])[1];
    const isFeed = (v) => FEEDS.some(([k]) => k === v);
    const newSeed = () => 1 + Math.floor(Math.random() * 2147483645);
    // Random keeps one shuffle for the visit (as the standalone app); picking
    // it again reshuffles.
    let randomSeed = newSeed();

    // Per-device viewing settings (UX 6): the grabbit.ads.* keys below and no
    // other. No clip id, title or search words; resume positions stay with
    // Adshortis' own prefs.
    const STORE_KEYS = ['grabbit.ads.sound', 'grabbit.ads.autoplay', 'grabbit.ads.autoscroll', 'grabbit.ads.clean', 'grabbit.ads.cols', 'grabbit.ads.lastFeed'];
    const adsStore = {
      get(k) {
        if (!STORE_KEYS.includes(k)) return null;
        try { return window.localStorage.getItem(k); } catch { return null; }
      },
      set(k, v) {
        if (!STORE_KEYS.includes(k)) return;
        try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch { /* private mode */ }
      },
    };
    // The core's live settings object, shared by every feed instance.
    const prefs = {
      muted: adsStore.get('grabbit.ads.sound') !== 'on',
      speed: 1,
      autoScroll: adsStore.get('grabbit.ads.autoscroll') === '1',
      chromeHidden: adsStore.get('grabbit.ads.clean') === '1',
    };

    // The feed's filters from the address; with none, the last feed picked.
    function feedFilters(params) {
      const out = { feed: 'foryou', genre: [], length: null, sound: false };
      let src = params;
      if (!['feed', 'genre', 'length', 'sound'].some((k) => params.has(k))) {
        try {
          const last = JSON.parse(adsStore.get('grabbit.ads.lastFeed') || 'null');
          if (last && typeof last === 'object') src = new URLSearchParams(Object.entries(last).filter(([, v]) => typeof v === 'string'));
        } catch { /* ignore */ }
      }
      // Liked has its own menu entry (B3): a bare Feed link never reopens it.
      if (isFeed(src.get('feed')) && (src === params || src.get('feed') !== 'liked')) out.feed = src.get('feed');
      out.genre = String(src.get('genre') || '').split(',').filter((g) => GENRES.some(([k]) => k === g));
      if (['short', 'long'].includes(src.get('length'))) out.length = src.get('length');
      out.sound = src.get('sound') === '1';
      return out;
    }
    const filterQuery = (f) => ({ feed: f.feed, genre: f.genre.join(','), length: f.length, sound: f.sound ? '1' : null });
    const filtered = (f) => !!(f.genre.length || f.length || f.sound);

    // Every error a member call can end in, in the words of UX 5.2 / H87.
    function errorWords(e, more) {
      if (e && e.status === 429) return 'Too many requests. Wait a moment.';
      if (e && e.status === 0) return more ? 'Could not load more. Check your connection.' : 'No connection to Grabbit. Check your connection.';
      if (e && e.status === 424) return 'Adshortis is not reachable right now.';
      if (e && e.status === 401) return 'Signed out of Adshortis.';
      return more ? 'Could not load more.' : 'Could not load the clips.';
    }
    const say = (e) => hub.toast(e && e.status ? errorWords(e, false) : (e && e.message) || 'Something went wrong.');

    // H70/H82: the hub link of a clip. `route` is the list it belongs to;
    // personal lists (playlist, liked, mine, hidden) share as explore.
    function shareLink(route, id) {
      const r = ['playlist', 'liked', 'mine', 'hidden'].includes(String(route).split('/')[0]) ? 'explore' : route;
      return `${location.origin}${location.pathname}${link(r, { clip: id })}`;
    }
    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
      } catch { /* fall back */ }
      const ta = h('textarea', { class: 'ads-copy', readonly: true, 'aria-hidden': 'true' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }

    // One button of the right rail: icon over a small label.
    function railBtn(name, label, onclick, extra = {}) {
      const iconBox = h('span', { class: 'tf-rb-ic' }, lu(name, 22));
      const text = h('span', { class: 'tf-rb-l' }, label);
      const el = h('button', { type: 'button', class: 'tf-rb', 'aria-label': extra.aria || label, onclick, 'data-sound-toggle': extra.sound ? '1' : null }, iconBox, text);
      return { el, iconBox, text };
    }
    // One row of a sheet menu: an icon on a small disc, the label, and an
    // optional control at the right edge.
    function menuRow(name, label, onclick, extra = {}) {
      return h('button', { type: 'button', class: `tf-row${extra.danger ? ' danger' : ''}`, onclick, 'aria-pressed': extra.pressed === undefined ? null : String(extra.pressed) },
        h('span', { class: 'tf-row-ic' }, lu(name, 18)), h('span', { class: 'tf-row-l' }, label), extra.trailing ? h('span', { class: 'tf-row-t' }, extra.trailing) : null);
    }
    const switchEl = (on) => h('span', { class: `tf-switch${on ? ' on' : ''}`, 'aria-hidden': 'true' }, h('span'));
    const initials = (name) => (String(name || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?').toUpperCase();
    // A picture from the gateway; its 1x1 placeholder (no picture upstream)
    // leaves the initials under it showing.
    function avatarDisc(name, src, size) {
      const box = h('span', { class: 'tf-av', style: `width:${size}px;height:${size}px` }, initials(name));
      if (src) {
        box.append(h('img', {
          alt: '', src, loading: 'lazy', 'data-media-bg': '1',
          onload: (e) => { if (e.currentTarget.naturalWidth <= 1) e.currentTarget.remove(); },
          onerror: (e) => e.currentTarget.remove(),
        }));
      }
      return box;
    }

    // A cold clip link (H64, H73, H80): the clip when it may play, else
    // null after the "not available" toast. A lost link still throws (H17).
    async function coldClip(id) {
      try {
        const d = await call(`clips/${id}`);
        if (d && d.id && d.status === 'ready' && d.deleted === false) return d;
      } catch (e) {
        if (aborted(e) || e.status === 401) throw e;
      }
      hub.toast('This clip is not available.');
      return null;
    }

    // The vertical player with Adshortis' card, rail and sheets, for the
    // feed page and for a player opened over a grid (plan H52). cfg:
    //   route        the list's route, for the share link (H70, H82)
    //   load, back, empty, end, onActive, start   passed to the core
    //   ownHistory, onClose, onLeave              a modal player's own
    //                history entry and teardown (the feed has none, H65)
    //   onHidden(id) a clip was hidden: the product drops it from its list
    function clipPlayer(cfg) {
      const gen = generation;
      const P = window.GrabbitShared.feedPlayer({
        h,
        icon: lu,
        sheets: SH,
        store: adsStore,
        storeKeys: { soundLast: 'grabbit.ads.sound', autoScroll: 'grabbit.ads.autoscroll', chrome: 'grabbit.ads.clean', resume: null },
        prefs,
        side: { toggle: () => hub.toggleSide(), isOpen: () => hub.sideOpen() },
        closeMenu: () => hub.closeMenu(),
        onLeave: cfg.onLeave || onLeave,
        start: cfg.start || {},
        ahead: 5,
        load: cfg.load,
        errorText: errorWords,
        retryDelay: (e) => (e && e.status === 429 && e.retryAfter ? e.retryAfter * 1000 : null),
        end: cfg.end,
        back: cfg.back,
        empty: cfg.empty,
        card: cardBody,
        paintSound,
        videoSrc: (c) => (c.status === 'ready' && c.deleted !== true && c.video ? c.video : null),
        poster: (c) => c.poster || '',
        onDoubleTap: (c) => toggleLike(c, true),
        onLongPress: (c) => openMore(c),
        onActive: cfg.onActive,
        onVideoError: () => lostLink(),
        keys: { l: (c) => toggleLike(c, false), s: (c) => openSave(c) },
        ownHistory: !!cfg.ownHistory,
        onClose: cfg.onClose,
        // H-M3: "Clip N of M" for screen readers; no earlier pages here.
        liveCount: true,
      });

      // ---- The card: rail, caption ----
      function cardBody(c) {
        const s = c.s;
        const cr = s.creator;
        const ready = s.status === 'ready' && s.deleted !== true;
        // Right rail.
        const items = [];
        if (cr) {
          c.followBtn = h('button', { type: 'button', class: 'ads-follow', onclick: () => toggleFollow(c) });
          items.push(h('div', { class: 'ads-who' },
            h('a', { class: 'ads-who-av', href: link(`creator/${cr.id}`), 'aria-label': `Profile: ${cr.name}` }, avatarDisc(cr.name, cr.avatar, 44)),
            c.followBtn));
        }
        c.likeBtn = railBtn('heart', '0', () => toggleLike(c, false), { aria: 'Like' });
        c.commentBtn = railBtn('messageCircle', '0', () => openComments(c), { aria: 'Comments' });
        c.saveBtn = railBtn('bookmark', 'Save', () => openSave(c), { aria: 'Save to playlist' });
        const shareBtn = railBtn('share2', 'Share', () => openShare(c));
        c.soundBtn = railBtn(prefs.muted ? 'volumeX' : 'volume2', prefs.muted ? 'Muted' : 'Sound', () => P.setMuted(!prefs.muted), { sound: true });
        const moreBtn = railBtn('moreVertical', 'More', () => openMore(c));
        items.push(c.likeBtn.el, c.commentBtn.el, c.saveBtn.el, shareBtn.el, c.soundBtn.el, moreBtn.el);
        const rail = h('div', { class: 'tf-rail' }, items);

        // Bottom left: who, the title with its tags, the genre.
        const who = cr ? h('a', { class: 'tf-who', href: link(`creator/${cr.id}`) }, h('span', { class: 'tf-name' }, `@${cr.name}`)) : null;
        let titleEl = null;
        const tagLinks = (s.tags || []).filter((t) => TAG_RE.test(t)).map((t) => [' ', h('a', { class: 'tf-mention', href: link(`tag/${enc(t)}`) }, `#${t}`)]);
        if (s.title || tagLinks.length) {
          const long = (s.title || '').length > 40 || tagLinks.length > 2;
          const more = long ? h('button', { type: 'button', class: 'tf-title-more', 'aria-expanded': 'false' }, 'more') : null;
          titleEl = h('p', { class: `tf-title${long ? ' long' : ''}` }, s.title || '', tagLinks, more);
          if (long) titleEl.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            const isOpen = titleEl.classList.toggle('open');
            more.textContent = isOpen ? 'less' : 'more';
            more.setAttribute('aria-expanded', String(isOpen));
          });
        }
        const pills = h('div', { class: 'ads-pills' },
          s.genre ? h('span', { class: 'ads-pill' }, labelOf(GENRES, s.genre)) : null,
          s.visibility === 'private' ? h('span', { class: 'ads-pill' }, lu('lock', 12), 'Private') : null,
          s.has_audio === false ? h('span', { class: 'ads-pill' }, 'No sound') : null);
        const info = h('div', { class: 'tf-info' }, who, titleEl, pills);
        // Owner and admin rows of a clip that cannot play (FS r11 MINOR 3):
        // no reason text from upstream.
        const note = ready ? null : h('div', { class: 'ads-note', role: 'status' }, s.status === 'failed' ? 'This clip could not be processed.' : s.status === 'pending' || s.status === 'processing' ? 'This clip is still processing.' : 'This clip is not available.');
        paintCounts(c);
        return { label: s.title || 'Clip', top: [note], bottom: [rail, info] };
      }
      function paintCounts(c) {
        const s = c.s;
        c.likeBtn.el.classList.toggle('liked', !!s.liked);
        c.likeBtn.el.setAttribute('aria-pressed', String(!!s.liked));
        c.likeBtn.el.setAttribute('aria-label', `${s.liked ? 'Unlike' : 'Like'} (${s.like_count || 0})`);
        c.likeBtn.text.textContent = String(s.like_count || 0);
        c.commentBtn.text.textContent = String(s.comment_count || 0);
        c.commentBtn.el.setAttribute('aria-label', `Comments (${s.comment_count || 0})`);
        if (c.followBtn && s.creator) {
          const on = !!s.creator.following;
          fill(c.followBtn, lu(on ? 'check' : 'plus', 14, 3));
          c.followBtn.classList.toggle('on', on);
          c.followBtn.setAttribute('aria-pressed', String(on));
          c.followBtn.setAttribute('aria-label', on ? `Unfollow ${s.creator.name}` : `Follow ${s.creator.name}`);
        }
      }
      function paintSound(c) {
        fill(c.soundBtn.iconBox, lu(prefs.muted ? 'volumeX' : 'volume2', 22));
        c.soundBtn.text.textContent = prefs.muted ? 'Muted' : 'Sound';
        c.soundBtn.el.setAttribute('aria-label', prefs.muted ? 'Turn sound on' : 'Mute');
      }

      // ---- Like, follow ----
      async function toggleLike(c, onlyLike) {
        const s = c.s;
        if (onlyLike && s.liked) { P.burst(c); return; }
        const was = { liked: s.liked, count: s.like_count };
        s.liked = !was.liked;
        s.like_count = Math.max(0, (was.count || 0) + (s.liked ? 1 : -1));
        if (s.liked) P.burst(c);
        paintCounts(c);
        try {
          const d = await call(`clips/${s.id}/like`, { method: was.liked ? 'DELETE' : 'POST' });
          s.liked = !!d.liked;
          if (Number.isInteger(d.like_count)) s.like_count = d.like_count;
        } catch (e) {
          if (aborted(e)) return;
          Object.assign(s, { liked: was.liked, like_count: was.count });
          say(e);
        }
        if (live(gen)) paintCounts(c);
      }
      async function toggleFollow(c) {
        const cr = c.s.creator;
        if (!cr) return;
        const was = !!cr.following;
        // Every card of this creator shows the same state.
        const mark = (v) => { for (const x of P.cards) if (x.s.creator && x.s.creator.id === cr.id) { x.s.creator.following = v; paintCounts(x); } };
        mark(!was);
        try {
          const d = await call(`creators/${cr.id}/follow`, { method: was ? 'DELETE' : 'POST' });
          if (live(gen)) { mark(!!d.following); hub.toast(d.following ? `Following ${cr.name}` : `Unfollowed ${cr.name}`); }
        } catch (e) {
          if (aborted(e)) return;
          if (live(gen)) mark(was);
          say(e);
        }
      }

      // ---- Comments (M5, M6, M7): initials, no avatar (owner Q4) ----
      function openComments(c) {
        const s = c.s;
        let list = [];
        const listEl = h('div', { class: 'tf-cm-list', 'aria-live': 'polite' }, h('p', { class: 'tf-dim' }, 'Loading ...'));
        const errEl = h('p', { class: 'tf-cm-err', role: 'alert', hidden: true });
        const input = h('input', { type: 'text', maxlength: '2000', placeholder: 'Add a comment ...', 'aria-label': 'Comment' });
        const send = h('button', { type: 'submit', class: 'tf-round-btn', 'aria-label': 'Post comment' }, lu('send', 18));
        const row = (m) => h('div', { class: 'tf-cm ads-cm' },
          h('span', { class: 'ads-cm-av', 'aria-hidden': 'true' }, initials(m.display_name)),
          h('div', { class: 'ads-cm-t' }, h('b', null, m.display_name || 'Unknown'), ' ', h('span', null, m.body)),
          m.can_delete ? h('button', { type: 'button', class: 'tik-x small', 'aria-label': 'Delete comment', onclick: () => delComment(m) }, lu('trash2', 14)) : null);
        const paint = () => {
          fill(listEl, list.length ? list.map(row) : h('p', { class: 'tf-dim' }, 'Be the first to comment.'));
          const t = sheet.panel.querySelector('.tik-sheet-head h3');
          if (t) t.textContent = `${list.length} comment${list.length === 1 ? '' : 's'}`;
        };
        // Reads end with the view (leave() aborts its signal, 3a review C-M1);
        // a comment already sent still completes.
        const viewSig = ctl.signal;
        const reload = () => call(`clips/${s.id}/comments`, { signal: viewSig }).then((d) => {
          list = d.items || [];
          s.comment_count = list.length;
          paintCounts(c);
          paint();
        });
        async function delComment(m) {
          try {
            await call(`comments/${m.id}`, { method: 'DELETE', signal: new AbortController().signal });
            await reload();
          } catch (e) { say(e); }
        }
        const form = h('form', { class: 'tf-cm-form', onsubmit: async (e) => {
          e.preventDefault();
          const body = input.value.trim();
          if (!body || send.disabled) return;
          send.disabled = true;
          errEl.hidden = true;
          try {
            await call(`clips/${s.id}/comments`, { method: 'POST', body: { body }, signal: new AbortController().signal });
            input.value = '';
            await reload();
            listEl.scrollTop = listEl.scrollHeight;
          } catch (err) {
            // The text stays in the field on failure.
            errEl.textContent = err.status === 401 ? 'Signed out of Adshortis.' : 'Could not post.';
            errEl.hidden = false;
          } finally { send.disabled = false; }
        } }, input, send);
        const sheet = SH.open(`${s.comment_count || 0} comments`, h('div', { class: 'tf-cm-box' }, listEl, errEl, form), { clear: true, cls: 'tf-sheet-comments' });
        reload().catch((e) => { if (!aborted(e)) fill(listEl, h('p', { class: 'tf-cm-err' }, e.status === 404 ? 'This clip is not available.' : errorWords(e, false))); });
      }

      // ---- Save to a playlist (M18, M24, M22, M23, M20) ----
      function openSave(c) {
        const s = c.s;
        let pls = [];
        let inIds = new Set();
        const sig = () => ({ signal: new AbortController().signal });
        // The lists end with the view (leave() aborts it, 3a review C-M1).
        const viewSig = ctl.signal;
        const listEl = h('div', { class: 'tf-pl-list' }, h('p', { class: 'tf-dim' }, 'Loading ...'));
        const name = h('input', { type: 'text', maxlength: '100', placeholder: 'New playlist ...', 'aria-label': 'New playlist name' });
        const paint = () => fill(listEl, pls.length ? pls.map(row) : h('p', { class: 'tf-dim' }, 'No playlists yet. Create one above.'));
        function row(pl) {
          const on = inIds.has(pl.id);
          return h('button', { type: 'button', class: 'tf-pl', 'aria-pressed': String(on), onclick: async () => {
            const was = on;
            if (was) inIds.delete(pl.id); else inIds.add(pl.id);
            pl.count = Math.max(0, (pl.count || 0) + (was ? -1 : 1));
            paint();
            try {
              if (was) await call(`playlists/${pl.id}/items/${s.id}`, { method: 'DELETE', ...sig() });
              else await call(`playlists/${pl.id}/items`, { method: 'POST', body: { clip_id: s.id }, ...sig() });
            } catch (e) {
              if (was) inIds.add(pl.id); else inIds.delete(pl.id);
              pl.count = Math.max(0, (pl.count || 0) + (was ? 1 : -1));
              paint();
              say(e);
            }
          } },
          h('span', { class: 'tf-pl-t' }, h('b', null, pl.name), h('small', null, `${pl.count || 0} clips`)),
          lu('bookmark', 20, 2, on ? 'on' : null));
        }
        function reload() {
          Promise.all([call('playlists?all=1', { signal: viewSig }), call(`clips/${s.id}/playlists`, { signal: viewSig })]).then(([a, b]) => {
            pls = a.items || [];
            inIds = new Set(b.items || []);
            paint();
          }).catch((e) => { if (!aborted(e)) fill(listEl, h('p', { class: 'tf-cm-err' }, errorWords(e, false))); });
        }
        const form = h('form', { class: 'tf-pl-form', onsubmit: async (e) => {
          e.preventDefault();
          const n = name.value.trim();
          if (!n) return;
          name.value = '';
          try {
            await call('playlists', { method: 'POST', body: { name: n, clip_id: s.id }, ...sig() });
            reload();
          } catch (err) { say(err); }
        } }, name, h('button', { type: 'submit', class: 'tf-round-btn', 'aria-label': 'Create playlist' }, lu('plus', 18)));
        SH.open('Save to playlist', h('div', { class: 'tf-cm-box' }, form, listEl), { clear: true, cls: 'tf-sheet-save' });
        reload();
      }

      // ---- Share (H70, H82, UX 5.4): copy the hub link, never navigator.share ----
      function openShare(c) {
        const s = c.s;
        if (!numId(s.id)) { hub.toast('This clip cannot be shared.'); return; }
        const ready = s.status === 'ready' && s.deleted !== true;
        const copy = h('button', { type: 'button', class: 'tf-row tf-share-row', disabled: !ready, onclick: async () => {
          const ok = await copyText(shareLink(cfg.route, s.id));
          sheet.close();
          hub.toast(ok ? 'Link copied.' : 'Could not copy the link.');
        } }, h('span', { class: 'tf-row-ic' }, lu('link2', 18)), h('span', { class: 'tf-row-l' }, 'Copy link'));
        const sheet = SH.open('Share', h('div', { class: 'ads-share' },
          copy,
          h('p', { class: 'tf-sheet-note' }, ready ? 'Opens in Grabbit. The recipient needs an Adshortis account.' : 'This clip is not ready to share yet.')), { clear: true, cls: 'tf-sheet-share' });
      }

      // ---- More: hide, report, speed, display ----
      function openMore(c) {
        const speeds = h('span', { class: 'tf-speeds', role: 'group', 'aria-label': 'Speed' },
          SPEEDS.map((r) => h('button', { type: 'button', class: `tf-speed${prefs.speed === r ? ' on' : ''}`, 'aria-pressed': String(prefs.speed === r), onclick: (e) => {
            P.setSpeed(r);
            for (const b of e.currentTarget.parentNode.children) { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
          } }, `${r}x`)));
        const sheet = SH.open('Clip', h('div', { class: 'tf-more' },
          menuRow('eyeOff', 'Hide from my feed', () => { sheet.close(); hideClip(c); }),
          menuRow('flag', 'Report', () => { sheet.close(); openReport(c); }),
          h('div', { class: 'tf-sep' }),
          h('div', { class: 'tf-row tf-row-static' }, h('span', { class: 'tf-row-ic' }, lu('gauge', 18)), h('span', { class: 'tf-row-l' }, 'Speed'), speeds),
          menuRow('eye', 'Clear display', () => { P.toggleChrome(); sheet.close(); }, { pressed: prefs.chromeHidden, trailing: switchEl(prefs.chromeHidden) }),
          menuRow('chevronsDown', 'Auto-scroll', () => { P.toggleAutoScroll(); sheet.close(); }, { pressed: prefs.autoScroll, trailing: switchEl(prefs.autoScroll) }),
          menuRow(P.fullscreen ? 'minimize' : 'maximize', P.fullscreen ? 'Exit fullscreen' : 'Fullscreen', () => { sheet.close(); P.toggleFullscreen(); })),
        { size: 'narrow', bare: true, cls: 'tf-sheet-menu' });
      }
      async function hideClip(c) {
        try {
          await call(`clips/${c.s.id}/hide`, { method: 'POST' });
          if (!live(gen)) return;
          P.removeCard(c);
          if (cfg.onHidden) cfg.onHidden(c.s.id);
          hub.toast('Hidden. You can bring it back under Settings, Hidden.');
        } catch (e) { if (!aborted(e)) say(e); }
      }
      function openReport(c) {
        let reason = null;
        const note = h('textarea', { rows: '3', maxlength: '1000', placeholder: 'Anything to add (optional)', 'aria-label': 'Note' });
        const send = h('button', { type: 'button', class: 'tf-sbtn danger', disabled: true, onclick: async () => {
          send.disabled = true;
          try {
            await call(`clips/${c.s.id}/report`, { method: 'POST', body: { reason, note: note.value.trim() || null }, signal: new AbortController().signal });
            sheet.close();
            hub.toast('Thanks. The report was sent.');
          } catch (e) { send.disabled = false; say(e); }
        } }, 'Send report');
        const reasons = h('div', { class: 'tf-reasons', role: 'radiogroup', 'aria-label': 'Reason' },
          REASONS.map(([k, label]) => h('button', { type: 'button', class: 'tf-reason', role: 'radio', 'aria-checked': 'false', onclick: (e) => {
            reason = k;
            for (const b of reasons.children) { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
            send.disabled = false;
          } }, h('span', { class: 'tf-dot' }), label)));
        const sheet = SH.open('Report', [h('p', { class: 'tf-sheet-title' }, 'Report this clip'), reasons, note,
          h('div', { class: 'tf-sheet-btns' }, send, h('button', { type: 'button', class: 'tf-sbtn', onclick: () => sheet.close() }, 'Cancel'))], { size: 'narrow', bare: true });
      }

      return P;
    }

    function viewFeed() {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      const f = feedFilters(params);
      // Cold link (H64, H73, H80): this clip first, then the list without it.
      let cold = numId(params.get('clip'));
      let seed = f.feed === 'random' ? randomSeed : null;

      const address = (clip) => link('feed', { ...filterQuery(f), clip });
      function remember() {
        const q = filterQuery(f);
        adsStore.set('grabbit.ads.lastFeed', JSON.stringify(Object.fromEntries(Object.entries(q).filter(([, v]) => v))));
      }
      function pageQuery(cursor) {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(filterQuery(f))) if (v) q.set(k, v);
        if (seed) q.set('seed', String(seed));
        q.set('limit', String(PAGE));
        if (cursor !== null && cursor !== undefined) q.set('next', String(cursor));
        return `clips?${q}`;
      }
      async function load({ cursor }) {
        const first = cursor === null || cursor === undefined;
        let head = null;
        if (first && cold) {
          const want = cold;
          cold = null;
          head = await coldClip(want);
        }
        const d = await call(pageQuery(cursor));
        const items = (d.items || []).filter((c) => !head || c.id !== head.id);
        return { items: head ? [head, ...items] : items, nextCursor: d.next ?? null };
      }
      // A new order or filter, in place: no navigation, the address replaced.
      function switchFeed(next) {
        P.reload(() => {
          Object.assign(f, next);
          if (next.feed === 'random' || (next.reshuffle && f.feed === 'random')) randomSeed = newSeed();
          seed = f.feed === 'random' ? randomSeed : null;
          cold = null;
          remember();
          hub.replaceHash(address(null));
          paintBar();
        });
      }

      // Top centre: the feed chips and the filter button (UX 2: a chip row).
      const bar = h('div', { class: 'ads-feedbar', role: 'group', 'aria-label': 'Feed' });
      function paintBar() {
        fill(bar,
          FEEDS.map(([k, label]) => h('button', {
            type: 'button', class: 'ads-chip', 'aria-pressed': String(k === f.feed),
            onclick: () => (k === f.feed && k !== 'random' ? null : switchFeed({ feed: k, reshuffle: k === 'random' })),
          }, label)),
          h('button', { type: 'button', class: `ads-chip ads-filter${filtered(f) ? ' on' : ''}`, 'aria-haspopup': 'dialog', 'aria-label': filtered(f) ? 'Filter clips (on)' : 'Filter clips', onclick: openFilter }, 'Filter'));
      }
      paintBar();

      function emptyNodes() {
        if (filtered(f)) return [h('p', null, 'No clips match these filters.'), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => switchFeed({ genre: [], length: null, sound: false }) }, 'Clear filters')];
        if (f.feed === 'following') return [h('p', null, "You don't follow anyone yet."), h('a', { class: 'tf-sbtn', href: link('explore') }, 'Explore clips')];
        if (f.feed === 'liked') return [h('p', null, 'Clips you like show up here.'), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => switchFeed({ feed: 'foryou' }) }, 'Open For You')];
        return [h('p', null, 'No clips here.')];
      }

      const P = clipPlayer({
        route: 'feed',
        load,
        back: bar,
        empty: emptyNodes,
        end: () => [h('p', null, "You've reached the end."), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => switchFeed({}) }, 'Back to the top')],
        onActive: (c) => hub.replaceHash(address(c.s.id)),
      });

      // The player handle the hash branch and leave() use (H51): the feed is
      // a page, so it has no close transition (H65).
      open.player = {
        modal: false,
        setClip(id) {
          if (P.goTo(id)) return;
          P.reload(() => { cold = numId(id); });
        },
        stop() {},
        suspend: () => P.suspend(),
        resume: () => P.resume(),
      };

      // ---- Filters: genre, length, sound; applied once ----
      function openFilter() {
        const pick = { genre: f.genre.slice(), length: f.length, sound: f.sound };
        const chip = (label, on, toggle) => h('button', { type: 'button', class: 'ads-chip', 'aria-pressed': String(on), onclick: (e) => { toggle(); paint(); e.currentTarget.focus(); } }, label);
        const box = h('div', { class: 'ads-filter-box' });
        function paint() {
          const focusedLabel = document.activeElement && box.contains(document.activeElement) ? document.activeElement.textContent : null;
          fill(box,
            h('h4', null, 'Genre'),
            h('div', { class: 'ads-chips', role: 'group', 'aria-label': 'Genre' },
              chip('All', !pick.genre.length, () => { pick.genre = []; }),
              GENRES.map(([k, label]) => chip(label, pick.genre.includes(k), () => { pick.genre = pick.genre.includes(k) ? pick.genre.filter((g) => g !== k) : [...pick.genre, k]; }))),
            h('h4', null, 'Length'),
            h('div', { class: 'ads-chips', role: 'group', 'aria-label': 'Length' },
              chip('Any length', !pick.length, () => { pick.length = null; }),
              LENGTHS.map(([k, label]) => chip(label, pick.length === k, () => { pick.length = pick.length === k ? null : k; }))),
            h('h4', null, 'Sound'),
            h('div', { class: 'ads-chips', role: 'group', 'aria-label': 'Sound' }, chip('With sound', pick.sound, () => { pick.sound = !pick.sound; })),
            h('div', { class: 'tf-sheet-btns' }, h('button', { type: 'button', class: 'tf-sbtn light', onclick: apply }, 'Show clips')));
          if (focusedLabel) { const again = [...box.querySelectorAll('button')].find((b) => b.textContent === focusedLabel); if (again) again.focus({ preventScroll: true }); }
        }
        function apply() {
          sheet.close();
          const same = pick.genre.join(',') === f.genre.join(',') && pick.length === f.length && pick.sound === f.sound;
          if (!same) switchFeed(pick);
        }
        paint();
        const sheet = SH.open('Filter clips', box, { cls: 'ads-sheet' });
      }

      return [h('div', { class: 'ads-feed' }, P.root)];
    }

    // --- Explore: the grid and clip search (plan H52, H64; UX 3, 9.3, 9.5, 10.2) ---
    // The grid's list lives in the store (H38), so Back from the player or
    // from another view in the module finds the same tiles, words and scroll.
    // A tap on a tile opens the player over the grid with one history entry
    // of its own (UX 9.3, 10.3); swiping plays on through the grid's list and
    // loads its next pages into the grid too (H52).
    const GRID_PAGE = 60; // H64: at most 60
    const SEARCH_MIN = 2; // UX 9.5
    const SEARCH_DELAY = 300;
    const colsOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 2 && n <= 6 ? n : null; };
    const genresOf = (v) => String(v || '').split(',').filter((g) => GENRES.some(([k]) => k === g));
    function clockOf(sec) {
      if (!Number.isFinite(sec) || sec <= 0) return '';
      const t = Math.round(sec);
      return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    }

    function viewExplore() {
      const gen = generation;
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      const genre = genresOf(params.get('genre'));
      // `cols` stays in the address only once it was there or was picked.
      let colsSet = colsOf(params.get('cols')) !== null;
      let cols = colsOf(params.get('cols')) || colsOf(adsStore.get('grabbit.ads.cols')) || 3;
      const startClip = numId(params.get('clip'));
      const address = (clip) => link('explore', { genre: genre.join(','), cols: colsSet ? cols : null, clip });
      // The words a search runs with: at least two characters, else none.
      const wordsNow = () => { const w = store.words.trim().slice(0, 100); return w.length >= SEARCH_MIN ? w : ''; };
      const keyOf = (words) => `${genre.join(',')}|${words}`;

      // ---- The list (one per explore view, kept in the store) ----
      let L = store.lists.get('explore');
      if (L && L.key !== keyOf(wordsNow())) L = null;
      // One list request in flight (UX 9.5): a newer one aborts it.
      let reqCtl = null;
      onLeave(() => { if (reqCtl) reqCtl.abort(); });
      const timers = new Set();
      const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (live(gen)) fn(); }, ms); timers.add(t); return t; };
      onLeave(() => { for (const t of timers) clearTimeout(t); timers.clear(); });

      function fetchPage(words, cursor, signal) {
        const more = cursor !== null && cursor !== undefined;
        if (words) {
          // M2: the words only in the POST body, never in an address (H6).
          const body = { q: words, limit: GRID_PAGE };
          if (genre.length) body.genre = genre.join(',');
          if (more) body.next = cursor;
          return call('search', { method: 'POST', body, signal });
        }
        const q = new URLSearchParams();
        if (genre.length) q.set('genre', genre.join(','));
        q.set('limit', String(GRID_PAGE));
        if (more) q.set('next', String(cursor));
        return call(`clips?${q}`, { signal });
      }
      // The first page of the list for the current words and genre.
      function startList() {
        if (reqCtl) reqCtl.abort();
        reqCtl = new AbortController();
        const sig = reqCtl.signal;
        const words = wordsNow();
        const fresh = { key: keyOf(words), words, items: [], cursor: null, hasMore: true, scroll: 0, error: null, pending: null };
        L = fresh;
        store.lists.set('explore', fresh);
        fresh.pending = fetchPage(words, null, sig)
          .then((d) => {
            if (sig.aborted || L !== fresh) return;
            fresh.items = (d.items || []).filter((c) => c && numId(c.id));
            fresh.cursor = d.next ?? null;
            fresh.hasMore = fresh.cursor !== null;
          })
          .catch((e) => {
            if (aborted(e) || L !== fresh) return;
            fresh.error = e;
            // UX 5.2: a search over the limit tries again after Retry-After.
            if (e.status === 429 && words) later(() => { if (L === fresh) startList(); }, Math.max(1, e.retryAfter || 5) * 1000);
          })
          .finally(() => {
            if (L !== fresh) return;
            fresh.pending = null;
            paintAll();
          });
        paintAll();
        return fresh.pending;
      }
      // The next page, shared by the grid and the player: one at a time.
      // Resolves to the new items; rejects for the player's retry row.
      function more() {
        const cur = L;
        if (!cur) return Promise.resolve([]);
        // A page already on its way: both callers get its items.
        if (cur.pending) return cur.pending.then((a) => (Array.isArray(a) ? a : []));
        if (!cur.hasMore) return Promise.resolve([]);
        const sig = (reqCtl = reqCtl || new AbortController()).signal;
        const p = fetchPage(cur.words, cur.cursor, sig)
          .then((d) => {
            if (L !== cur) return [];
            const have = new Set(cur.items.map((c) => c.id));
            const added = (d.items || []).filter((c) => c && numId(c.id) && !have.has(c.id));
            cur.items.push(...added);
            cur.cursor = d.next ?? null;
            cur.hasMore = cur.cursor !== null;
            cur.error = null;
            addTiles(added);
            return added;
          }, (e) => {
            if (L === cur && !aborted(e)) cur.error = e;
            throw e;
          })
          .finally(() => {
            if (L !== cur) return;
            cur.pending = null;
            paintFoot();
          });
        cur.pending = p;
        paintFoot();
        return p;
      }

      // ---- Search box (UX 9.5): as you type, 300 ms, two characters ----
      const input = h('input', {
        type: 'search', class: 'field ads-search-in', placeholder: 'Search title, creator or #hashtag',
        'aria-label': 'Search clips', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', maxlength: '100',
      });
      input.value = store.words;
      let typing = 0;
      const runSearch = () => {
        clearTimeout(typing);
        timers.delete(typing);
        if (!L || L.key !== keyOf(wordsNow())) startList();
      };
      input.addEventListener('input', () => {
        store.words = input.value;
        clearTimeout(typing);
        timers.delete(typing);
        typing = later(runSearch, SEARCH_DELAY);
      });
      const searchForm = h('form', { class: 'ads-search', role: 'search', onsubmit: (e) => { e.preventDefault(); runSearch(); } }, lu('search', 18), input);
      function clearSearch() {
        store.words = '';
        input.value = '';
        runSearch();
        input.focus();
      }

      // ---- Genre chips and grid density ----
      const chips = h('div', { class: 'ads-chips ads-genres', role: 'group', 'aria-label': 'Genre' });
      function paintChips() {
        const pick = (next) => {
          genre.splice(0, genre.length, ...next);
          hub.replaceHash(address(null));
          startList();
          paintChips();
        };
        fill(chips,
          h('button', { type: 'button', class: 'ads-chip', 'aria-pressed': String(!genre.length), onclick: () => { if (genre.length) pick([]); } }, 'All'),
          GENRES.map(([k, label]) => h('button', {
            type: 'button', class: 'ads-chip', 'aria-pressed': String(genre.includes(k)),
            onclick: () => pick(genre.includes(k) ? genre.filter((g) => g !== k) : [...genre, k]),
          }, label)));
      }
      paintChips();
      const density = h('input', { type: 'range', min: '2', max: '6', step: '1', value: String(cols), 'aria-label': 'Grid columns' });
      density.addEventListener('input', () => {
        cols = colsOf(density.value) || cols;
        colsSet = true;
        grid.style.setProperty('--ads-cols', String(cols));
        adsStore.set('grabbit.ads.cols', String(cols));
        hub.replaceHash(address(null));
      });
      const tools = h('div', { class: 'ads-tools' }, h('label', { class: 'ads-density' }, lu('listVideo', 16), density));

      // ---- The grid ----
      const grid = h('div', { class: 'ads-grid', style: `--ads-cols:${cols}` });
      const note = h('div', { class: 'ads-grid-note' });
      const foot = h('div', { class: 'ads-grid-foot' });
      const sentinel = h('div', { class: 'ads-sentinel', 'aria-hidden': 'true' });
      function tile(c) {
        const thumb = h('span', { class: 'ads-thumb', 'data-media-bg': '1' });
        if (c.poster) {
          thumb.append(h('img', {
            alt: '', src: c.poster, loading: 'lazy', decoding: 'async',
            // No picture upstream (the 1x1 placeholder) or none at all: the
            // tile keeps its plain background (UX 5.2).
            onload: (e) => { if (e.currentTarget.naturalWidth <= 1) e.currentTarget.remove(); },
            onerror: (e) => e.currentTarget.remove(),
          }));
        }
        const ready = c.status === 'ready' && c.deleted !== true;
        const label = c.title || (c.creator && c.creator.name) || 'Clip';
        return h('a', {
          class: 'ads-tile', href: address(c.id), 'data-clip': String(c.id), 'aria-label': label,
          onclick: (e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            openPlayer(c.id, 'tap', e.currentTarget);
          },
        },
        thumb,
        h('span', { class: 'ads-tile-meta' },
          c.duration ? h('span', { class: 'ads-dur' }, clockOf(c.duration)) : null,
          !ready ? h('span', { class: 'ads-badge' }, c.status === 'failed' ? 'failed' : 'processing') : null,
          c.visibility === 'private' ? h('span', { class: 'ads-badge' }, lu('lock', 11), 'private') : null),
        h('span', { class: 'ads-tile-title' }, c.title || (c.creator ? `@${c.creator.name}` : '')));
      }
      function addTiles(items) { if (items.length) grid.append(...items.map(tile)); }
      function paintFoot() {
        if (!L || !L.items.length) { fill(foot); return; }
        if (L.pending) fill(foot, h('span', { class: 'tf-spin', 'aria-label': 'Loading' }));
        else if (L.error && L.hasMore) {
          // H87: the grid's last row says why and offers a retry.
          const e = L.error;
          const wait = e.status === 429 && e.retryAfter ? e.retryAfter * 1000 : 0;
          const again = h('button', { type: 'button', class: 'btn ghost', disabled: !!wait, onclick: () => { L.error = null; more().catch(() => {}); } }, 'Retry');
          if (wait) later(() => { again.disabled = false; }, wait);
          fill(foot, h('p', { role: 'status' }, errorWords(e, true)), again);
        } else if (!L.hasMore) fill(foot, h('span', { class: 'muted' }, `${L.items.length} clip${L.items.length === 1 ? '' : 's'}`));
        else fill(foot);
      }
      function paintAll() {
        if (!live(gen)) return;
        fill(grid);
        fill(note);
        if (!L) { fill(foot); return; }
        if (L.pending && !L.items.length) {
          fill(note, h('p', { class: 'muted' }, L.words ? 'Searching ...' : 'Loading ...'));
        } else if (L.error && !L.items.length) {
          const e = L.error;
          if (e.status === 429 && L.words) fill(note, h('p', { class: 'ads-empty', role: 'status' }, 'Too many searches. Wait a moment.'));
          else if (e.status === 424) fill(note, retryBanner('Adshortis is not reachable right now.', startList));
          else fill(note, h('div', { class: 'ads-empty', role: 'status' }, h('p', null, errorWords(e, false)), h('button', { type: 'button', class: 'btn ghost', onclick: startList }, 'Retry')));
        } else if (!L.items.length) {
          if (L.words) fill(note, empty('Nothing found for this search.', h('button', { type: 'button', class: 'btn ghost', onclick: clearSearch }, 'Clear search')));
          else if (genre.length) fill(note, empty('No clips match these filters.', h('button', { type: 'button', class: 'btn ghost', onclick: () => { genre.length = 0; hub.replaceHash(address(null)); startList(); paintChips(); } }, 'Clear filters')));
          else fill(note, empty('No clips here yet.'));
        } else {
          addTiles(L.items);
        }
        paintFoot();
      }
      // Next page when the end of the grid comes near (not under the player:
      // the player asks for its own pages).
      const io = new IntersectionObserver((entries) => {
        if (!entries.some((x) => x.isIntersecting) || open.player || !L || L.pending || L.error || !L.hasMore) return;
        more().catch(() => {});
      }, { rootMargin: '800px' });
      io.observe(sentinel);
      onLeave(() => io.disconnect());

      // ---- Scroll: kept in the store, put back on redraw ----
      const saveScroll = () => { if (L) L.scroll = window.scrollY; };
      onLeave(() => { if (!open.player) saveScroll(); });
      function restoreScroll(y) {
        requestAnimationFrame(() => { if (live(gen)) window.scrollTo(0, y); });
      }

      // ---- The player over the grid (H52, UX 9.3, 10.3) ----
      // how: 'tap' (pushes its own entry, Back closes it), 'hash' (an
      // in-module link pushed the entry: Back closes it too), 'cold' (the
      // address was opened as is: closing only replaces the address).
      function openPlayer(id, how, opener) {
        if (open.player || !live(gen)) return;
        saveScroll();
        const scrollAt = window.scrollY;
        const known = L && L.items.some((c) => String(c.id) === String(id));
        let cold = known ? null : numId(id);
        let first = true;
        const local = [];
        let shut = false;
        const box = h('div', { class: 'viewer ads-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Clip player', 'data-feed-player': '' });
        // The first load keeps its state until it succeeds: the player's Retry
        // runs it again, with the requested clip, and restarts a failed grid
        // page instead of paging past it (3a review C-B1).
        let head = null;
        async function load() {
          if (first) {
            if (cold && !head) head = await coldClip(cold);
            if (!L || (L.error && !L.items.length)) startList();
            if (L.pending && !L.items.length) await L.pending;
            if (L.error && !L.items.length) throw L.error;
            first = false;
            cold = null;
            const items = L.items.filter((c) => !head || c.id !== head.id);
            return { items: head ? [head, ...items] : items, nextCursor: L.hasMore ? 'more' : null };
          }
          const added = await more();
          return { items: added, nextCursor: L && L.hasMore ? 'more' : null };
        }
        const backBtn = h('button', { type: 'button', class: 'tf-pill tf-back', 'aria-label': 'Close the player', onclick: () => closeAsked() },
          lu('chevronLeft', 15), h('span', null, wordsNow() ? 'Search results' : 'Explore'));
        const P = clipPlayer({
          route: 'explore',
          load,
          back: backBtn,
          start: known ? { focus: Number(id) } : {},
          empty: () => [h('p', null, wordsNow() ? 'Nothing found for this search.' : 'No clips here yet.')],
          end: () => [h('p', null, "You've reached the end."), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => closeAsked() }, 'Back to the list')],
          onActive: (c) => { if (!shut) hub.replaceHash(address(c.s.id)); },
          ownHistory: how === 'tap',
          onClose: () => closeModal(false),
          onLeave: (fn) => local.push(fn),
          onHidden: (cid) => {
            if (!L) return;
            L.items = L.items.filter((c) => c.id !== cid);
            const t = grid.querySelector(`[data-clip="${cid}"]`);
            if (t) t.remove();
          },
        });
        box.append(P.root);
        // Escape with no sheet over it closes the player (UX 10.1); the
        // sheet stack stops the key while a sheet is open.
        const onKey = (e) => {
          if (e.key === 'Tab') { trapTab(e); return; }
          if (e.key !== 'Escape' || e.defaultPrevented || SH.count() || P.fullscreen) return;
          if (document.querySelector('[role=dialog][aria-modal=true]:not([data-feed-player])')) return;
          e.preventDefault();
          closeAsked();
        };
        document.addEventListener('keydown', onKey);
        local.push(() => document.removeEventListener('keydown', onKey));
        // A Back already asked for counts as closing: a second Escape or tap
        // before the popstate must not step back past the grid (C-M2).
        let backAsked = false;
        function closeAsked() {
          if (shut || backAsked) return;
          if (how === 'tap') P.close();
          else if (how === 'hash') { backAsked = true; history.back(); }
          else closeModal(false);
        }
        // Once, whichever way it ends: Back, the button, Escape, a view change.
        function closeModal(leaving) {
          if (shut) return;
          shut = true;
          if (open.player === handle) open.player = null;
          for (const fn of local.reverse()) {
            try { fn(); } catch (e) { console.warn('ads: player cleanup failed', e); }
          }
          box.remove();
          if (leaving) return;
          if (parse(location.hash).clip) hub.replaceHash(address(null));
          hub.updateNav();
          window.scrollTo(0, scrollAt);
          const back = opener && opener.isConnected ? opener : grid.querySelector(`[data-clip="${CSS.escape(String(id))}"]`);
          if (back) back.focus({ preventScroll: true });
        }
        onLeave(() => closeModal(true));
        // H-M2: the page behind is inert while the player is open: the hub's
        // top bar and view always, the menu only while it is closed (the
        // player's own menu button opens it, and it stays usable then).
        // Only what this player made inert is given back.
        const main = document.querySelector('.app > .main');
        const side = document.getElementById('side');
        const madeInert = new Set();
        function setInert(el, on) {
          if (!el) return;
          if (on && !el.inert) { el.inert = true; madeInert.add(el); }
          else if (!on && madeInert.has(el)) { el.inert = false; madeInert.delete(el); }
        }
        const paintInert = () => { if (!shut) { setInert(main, true); setInert(side, !hub.sideOpen()); } };
        paintInert();
        window.addEventListener('grabbit:side', paintInert);
        // Tab and Shift+Tab wrap inside the player (and the open menu); a
        // sheet over it keeps its own trap. Called from onKey above.
        function trapTab(e) {
          if (e.defaultPrevented || SH.count()) return;
          if (document.querySelector('[role=dialog][aria-modal=true]:not([data-feed-player])')) return;
          const scopes = side && !side.inert ? [side, box] : [box];
          const items = scopes.flatMap((sc) => [...sc.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')])
            .filter((el) => !el.disabled && !el.closest('[hidden], [inert]') && el.getClientRects().length);
          if (!items.length) return;
          const at = document.activeElement;
          const inside = scopes.some((sc) => sc.contains(at));
          if (e.shiftKey && (!inside || at === items[0])) { e.preventDefault(); items[items.length - 1].focus(); }
          else if (!e.shiftKey && (!inside || at === items[items.length - 1])) { e.preventDefault(); items[0].focus(); }
        }
        local.push(() => {
          window.removeEventListener('grabbit:side', paintInert);
          for (const el of [...madeInert]) setInert(el, false);
        });
        const handle = {
          modal: true,
          setClip(cid) { P.goTo(cid); },
          stop: () => closeModal(false),
          suspend: () => P.suspend(),
          resume: () => P.resume(),
        };
        open.player = handle;
        document.body.append(box);
        // The player's own controls take the keys from here.
        const sc = P.root.querySelector('.tf-scroll');
        if (sc) sc.focus({ preventScroll: true });
      }
      open.grid = { openClip: (id) => openPlayer(id, 'hash', null) };

      // ---- First paint: from the store, or a fresh list ----
      const view = [pageHead('Explore'), searchForm, chips, tools, note, grid, foot, sentinel];
      if (L) {
        paintAll();
        restoreScroll(L.scroll || 0);
      } else startList();
      // A clip in the address (a shared link, a reload, Back onto it): it
      // plays over the grid; with the store empty X comes first (H64).
      if (startClip) setTimeout(() => { if (live(gen)) openPlayer(startClip, 'cold', null); }, 0);
      return view;
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
      return [pageHead('Adshortis'), linkForm((d) => {
        const id = d.user ? d.user.id : null;
        if (S.userId !== null && id !== S.userId) clearStore();
        S.userId = id;
        S.session = { linked: true, user: d.user || null };
        redraw();
        hub.updateNav();
      })];
    }
    // O1: what linking means, said the same way on the form and in Settings.
    const LINK_ONCE = 'You sign in once: this browser stays linked to that Adshortis account while you are signed in to Grabbit, for up to 30 days.';
    // The sign-in form (S1). onLinked(d) runs with the S1 answer; the caller
    // decides what comes next (the page, or the re-link sheet of H17).
    function linkForm(onLinked, intro) {
      const user = h('input', { class: 'field', name: 'username', autocomplete: 'username', required: true, 'aria-label': 'Username', placeholder: 'Username' });
      const pass = h('input', { class: 'field', name: 'password', type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Password', placeholder: 'Password' });
      const msg = h('p', { class: 'ads-form-msg', role: 'alert', hidden: true });
      const btn = h('button', { class: 'btn', type: 'submit' }, 'Sign in');
      const say = (text) => { msg.textContent = text; msg.hidden = !text; };
      const gen = generation;
      return h('form', {
        class: 'ads-link',
        onsubmit: (e) => {
          e.preventDefault();
          btn.disabled = true;
          say('');
          // Its own signal: the re-link sheet sits over a live view.
          call('session', { method: 'POST', body: { username: user.value, password: pass.value }, signal: new AbortController().signal })
            .then((d) => { announceLink(); if (live(gen)) onLinked(d); })
            .catch((err) => {
              if (aborted(err)) return;
              btn.disabled = false;
              pass.value = '';
              if (err.status === 401) say('Wrong username or password.');
              else if (err.status === 429) say(`Too many attempts. Try again in ${Math.max(1, Math.ceil((err.retryAfter || 60) / 60))} minutes.`);
              else if (err.status === 403) say('This Adshortis account cannot sign in. Ask the admin.');
              else if (err.reason === 'login_id_missing') { leave(); S.session = { linked: false, reason: 'login_id_missing' }; redraw(); }
              else say('Adshortis is not reachable right now.');
            });
        },
      },
      h('h2', null, 'Sign in to Adshortis'),
      h('p', { class: 'muted' }, intro || 'No Adshortis account is linked yet. Adshortis has its own accounts, separate from Grabbit and TikShortis.'),
      h('p', { class: 'muted' }, LINK_ONCE),
      user, pass, msg, btn);
    }

    // --- Views ---------------------------------------------------------------
    // Sections in the sidebar (UX 2). Admin is phase 4. The first install
    // lists only what works (B3): Liked is the feed's Liked order. Profiles,
    // Tags, Playlists, Mine and Upload stay out of the menu until they are
    // built; their routes keep the placeholder below.
    const LIKED = { feed: 'liked' };
    const SECTIONS = [
      ['feed', 'Feed'],
      ['explore', 'Explore'],
      ['liked', 'Liked', LIKED],
      ['settings', 'Settings'],
    ];
    // A detail view lights up the section it belongs to.
    const SECTION_OF = { creator: 'profiles', person: 'profiles', tag: 'tags', playlist: 'playlists', hidden: 'settings' };
    // Every route of UX 3. `id` is the second path segment's check: views
    // with an id answer a bad one with "does not exist" before any request.
    // A view without `draw` is not built yet (phase 3 slices C-E): it shows a
    // placeholder and never calls the gateway.
    const VIEWS = {
      feed: { title: 'Feed', draw: viewFeed },
      explore: { title: 'Explore', draw: viewExplore },
      profiles: { title: 'Profiles' },
      creator: { title: 'Creator', id: numId },
      person: { title: 'Person', id: numId },
      tags: { title: 'Tags' },
      tag: { title: 'Tag', id: (v) => (v && v.length <= 100 ? v : null) },
      playlists: { title: 'Playlists' },
      playlist: { title: 'Playlist', id: numId },
      // The old Liked route opens the Liked feed (B3).
      liked: { title: 'Liked', draw: () => { hub.replaceHash(link('feed', LIKED)); return drawView(parse(link('feed', LIKED))); } },
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
          h('p', null, 'Linked Adshortis account: ', h('strong', null, (u && (u.username || u.name)) || 'unknown')),
          h('p', { class: 'muted' }, 'This is your Adshortis account, not your Grabbit or TikShortis one. ', LINK_ONCE),
          h('p', { class: 'muted' }, 'The link ends when you sign out of Adshortis here or sign out of Grabbit.'),
          h('button', { type: 'button', class: 'btn ghost', onclick: unlink }, 'Sign out of Adshortis')),
      ];
    }
    function unlink() {
      const gen = generation;
      call('session', { method: 'DELETE', signal: new AbortController().signal })
        .catch(() => {})
        .finally(() => {
          announceLink();
          // The session ends either way; the address moves only while the
          // view that asked is still on show (3a review C-M1). Another
          // Adshortis view on show by now is redrawn signed out at its own
          // address; off the module redraw() does nothing.
          const here = live(gen);
          reset();
          S.session = { linked: false, user: null };
          S.userId = null;
          if (here) hub.replaceHash(BASE);
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
        // Close: the player stops and the grid shows from the store. A
        // player over a grid that already closed on the same Back (its
        // popstate came first) leaves nothing to do.
        if (a.clip && !b.clip && (open.player ? open.player.modal : open.grid)) {
          const p = open.player;
          open.player = null;
          if (p) p.stop();
          hub.updateNav();
          return;
        }
        // Open: a link onto a clip of the grid on show plays it over the
        // grid; the link's own entry is the player's (H52).
        if (!a.clip && b.clip && open.grid && !open.player && numId(b.clip)) {
          open.grid.openClip(b.clip);
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
      let cur = SECTION_OF[first] || first;
      if (first === 'feed' && new URLSearchParams(location.hash.split('?')[1] || '').get('feed') === 'liked') cur = 'liked';
      return SECTIONS.map(([id, label, q]) => (q ? { href: link('feed', q), label, current: cur === id } : { href: link(id), label, current: cur === id }));
    }

    // The build check may reload only an idle page (plan H63, H75, H88).
    const idle = () => !open.player && open.sheets === 0 && SH.count() === 0 && storeEmpty();

    // The hub's top search on an Adshortis view (3a review H-M1): the words go
    // to Explore's own search (POST body only), never into an address.
    function search(q) {
      store.words = String(q || '').slice(0, 200);
      if (parse(location.hash).sub[0] === 'explore' && root && root.isConnected) {
        leave();
        redraw();
      } else {
        location.hash = link('explore');
      }
    }

    return { view, leave, reset, subnav, onHash, idle, hasView, link, search };
  }
})();
