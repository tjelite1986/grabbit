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
          // Still linked: the failure was something else (a dead clip).
          if (r.ok && d && d.linked) return;
          if (!live(gen)) return;
          const p = open.player;
          if (p && p.suspend && r.ok) { relinkSheet(p); return; }
          leave();
          S.session = undefined;
          return loadSession(true);
        })
        .catch(() => {})
        .finally(() => { relinking = false; });
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
      if (isFeed(src.get('feed'))) out.feed = src.get('feed');
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

    function viewFeed() {
      const gen = generation;
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
          try {
            const d = await call(`clips/${want}`);
            if (d && d.id && d.status === 'ready' && d.deleted === false) head = d;
            else hub.toast('This clip is not available.');
          } catch (e) {
            if (aborted(e) || e.status === 401) throw e;
            hub.toast('This clip is not available.');
          }
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
        if (f.feed === 'following') return [h('p', null, "You don't follow anyone yet."), h('a', { class: 'tf-sbtn', href: link('profiles') }, 'Browse profiles')];
        if (f.feed === 'liked') return [h('p', null, 'Clips you like show up here.'), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => switchFeed({ feed: 'foryou' }) }, 'Open For You')];
        return [h('p', null, 'No clips here.')];
      }

      const P = window.GrabbitShared.feedPlayer({
        h,
        icon: lu,
        sheets: SH,
        store: adsStore,
        storeKeys: { soundLast: 'grabbit.ads.sound', autoScroll: 'grabbit.ads.autoscroll', chrome: 'grabbit.ads.clean', resume: null },
        prefs,
        side: { toggle: () => hub.toggleSide(), isOpen: () => hub.sideOpen() },
        closeMenu: () => hub.closeMenu(),
        onLeave,
        start: {},
        ahead: 5,
        load,
        errorText: errorWords,
        retryDelay: (e) => (e && e.status === 429 && e.retryAfter ? e.retryAfter * 1000 : null),
        end: () => [h('p', null, "You've reached the end."), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => switchFeed({}) }, 'Back to the top')],
        back: bar,
        empty: emptyNodes,
        card: cardBody,
        paintSound,
        videoSrc: (c) => (c.status === 'ready' && c.deleted !== true && c.video ? c.video : null),
        poster: (c) => c.poster || '',
        onDoubleTap: (c) => toggleLike(c, true),
        onLongPress: (c) => openMore(c),
        onActive: (c) => hub.replaceHash(address(c.s.id)),
        onVideoError: () => lostLink(),
        keys: { l: (c) => toggleLike(c, false), s: (c) => openSave(c) },
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
        const reload = () => call(`clips/${s.id}/comments`, { signal: new AbortController().signal }).then((d) => {
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
          Promise.all([call('playlists?all=1', sig()), call(`clips/${s.id}/playlists`, sig())]).then(([a, b]) => {
            pls = a.items || [];
            inIds = new Set(b.items || []);
            paint();
          }).catch((e) => fill(listEl, h('p', { class: 'tf-cm-err' }, errorWords(e, false))));
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
          const ok = await copyText(shareLink('feed', s.id));
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
            .then((d) => { if (live(gen)) onLinked(d); })
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
      h('p', { class: 'muted' }, intro || 'Adshortis has its own accounts. Your sign-in stays in this browser.'),
      user, pass, msg, btn);
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
      feed: { title: 'Feed', draw: viewFeed },
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
        if (a.clip && !b.clip && open.player && open.player.modal) {
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
    const idle = () => !open.player && open.sheets === 0 && SH.count() === 0 && storeEmpty();

    return { view, leave, reset, subnav, onHash, idle, hasView, link };
  }
})();
