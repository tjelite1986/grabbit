'use strict';
// Grabbit 3.0 phase 1: TikShortis drawn by the hub itself (TIKSHORTIS_MODE=native).
//
// Every request goes to Grabbit's gateway at /api/tik/*, which forwards an
// allowlisted set of TikShortis API routes with the viewer's linked TikShortis
// session and drops anything outside the general channel. This file never
// talks to TikShortis directly and never holds a TikShortis secret: the link
// is an HttpOnly cookie that only the gateway can read.
//
// Loaded before hub.js. It registers itself in window.GrabbitModules; hub.js
// calls create() once with its helpers and routes #/tikshortis/<section> here.
// The hub calls leave() before it replaces the view, which stops every player.
(() => {
  const registry = (window.GrabbitModules = window.GrabbitModules || []);
  registry.push({ id: 'tikshortis', create });

  function create(hub) {
    const { h, num } = hub;
    // replaceChildren() turns a null or false argument into the text "null" /
    // "false", and these pages build optional parts as `cond ? el : null`.
    // fill() drops them the way h() does for its children.
    const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    const enc = encodeURIComponent;

    // --- Icons -------------------------------------------------------------
    const PATHS = {
      heart: 'M12 21s-8-5.3-8-11a5 5 0 0 1 8-3.9A5 5 0 0 1 20 10c0 5.7-8 11-8 11z',
      chat: 'M4 5h16v11H8l-4 4z',
      bookmark: 'M6 3h12v18l-6-4-6 4z',
      share: 'M14 5l7 7-7 7M21 12H9a6 6 0 0 0-6 6v1',
      more: 'M5 12h.01M12 12h.01M19 12h.01',
      compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15 9l-2 5-4 1 2-5z',
      plus: 'M12 5v14M5 12h14',
      lib: 'M4 4h4v16H4zM10 4h4v16h-4zM16 5l4 1-3 14-4-1z',
      menu: 'M4 6h16M4 12h16M4 18h16',
      home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
      search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
      sound: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11',
      muted: 'M4 9h4l5-4v14l-5-4H4zM16.5 9.5l5 5M21.5 9.5l-5 5',
      up: 'M5 15l7-7 7 7',
      down: 'M5 9l7 7 7-7',
      close: 'M6 6l12 12M18 6 6 18',
      play: 'M8 5v14l11-7z',
      lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
      download: 'M12 3v12m0 0-5-5m5 5 5-5M4 19h16',
      check: 'M5 12l5 5 9-10',
      back: 'M15 5l-7 7 7 7',
      edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    };
    function ic(name) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', PATHS[name] || PATHS.play);
      svg.append(p);
      return svg;
    }

    // --- Addresses ---------------------------------------------------------
    const BASE = '#/tikshortis';
    // link('profile/3', { focus: 9 }) -> #/tikshortis/profile/3?focus=9
    function link(path, query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query || {})) if (v !== null && v !== undefined && v !== '' && v !== false) q.set(k, String(v));
      const qs = q.toString();
      return `${BASE}${path ? `/${path}` : ''}${qs ? `?${qs}` : ''}`;
    }
    const posterOf = (s) => (s && s.has_poster ? `/api/tik/shorts/${s.id}/poster?v=${enc(s.poster_v || '2')}` : null);
    const coverOf = (id, v) => (Number.isInteger(id) ? `/api/tik/shorts/${id}/poster?v=${enc(v || '2')}` : null);
    const videoOf = (id) => `/api/tik/shorts/${id}/video`;
    const avatarOf = (pid, v) => `/api/tik/shorts/profiles/${pid}/avatar${v ? `?v=${enc(v)}` : ''}`;
    // Same rule as TikShortis lib/handle.ts handleOf().
    const handleOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9._]/g, '').replace(/^[._]+|[._]+$/g, '');
    // Same rule as the /tag/[tag] page: letters, digits and _ only.
    const tagOf = (raw) => String(raw || '').replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 100);
    const intOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
    const tagHref = (t) => link(`tag/${enc(tagOf(t))}`);
    // Only http(s) links from captions and profile rows become hrefs.
    function safeHref(u) {
      try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
    }
    function when(s) {
      const t = Date.parse(String(s || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
      return Number.isFinite(t) ? hub.ago(t) : '';
    }
    function clock(sec) {
      if (!Number.isFinite(sec) || sec < 0) return '';
      const s = Math.round(sec);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    const initials = (name) => (String(name || '?').replace(/^@/, '').trim()[0] || '?').toUpperCase();

    // Caption grammar, ported from TikShortis lib/shorts-caption.ts so an edit
    // made here reads back the same there: "title\n\n#tag1 #tag2\n\nSource: <url>".
    const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;
    const SOURCE_RE = /(?:^|\s)Source:\s*(https?:\/\/\S+)/i;
    function splitCaption(caption) {
      const c = caption == null ? '' : String(caption);
      const m = c.match(SOURCE_RE);
      const source = m ? m[1] : null;
      const stripped = c.replace(SOURCE_RE, ' ');
      const tags = stripped.match(HASHTAG_RE) || [];
      const title = stripped.replace(HASHTAG_RE, '').replace(/\s+/g, ' ').trim();
      return { title, tags: [...new Set(tags)], source };
    }
    function buildCaption({ title, tags, source }) {
      return [title.trim(), tags.join(' '), source ? `Source: ${source}` : ''].filter(Boolean).join('\n\n');
    }
    // The link back to where a clip came from (short-card.tsx): the caption's
    // Source line, else what the source id says.
    function sourceLink(s, parts) {
      if (parts.source) return safeHref(parts.source);
      const sid = String(s.source_id || '');
      if (/^https?:\/\//i.test(sid)) return safeHref(sid);
      if (/^\d{15,}$/.test(sid) && s.profile_name) return `https://www.tiktok.com/@${enc(handleOf(s.profile_name))}/video/${sid}`;
      if (/^[A-Za-z0-9_-]{11}$/.test(sid)) return `https://www.youtube.com/watch?v=${sid}`;
      return null;
    }

    // --- Local settings (grabbit.* keys only) -------------------------------
    const KEYS = { soundStart: 'grabbit.tik.soundStart', soundLast: 'grabbit.tik.soundLast', autoScroll: 'grabbit.tik.autoScroll', chrome: 'grabbit.tik.chromeHidden', resume: 'grabbit.tik.resume' };
    const store = {
      get(k) { try { return localStorage.getItem(k); } catch { return null; } },
      set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } },
    };
    const soundStart = () => store.get(KEYS.soundStart) || 'muted';
    function initialMuted() {
      const start = soundStart();
      if (start === 'on') return false;
      if (start === 'last') return store.get(KEYS.soundLast) !== 'on';
      return true;
    }

    // --- Module state ------------------------------------------------------
    const S = {
      session: undefined, // { linked, user, outdated } once loaded
      sessionError: null,
      loading: null,
      muted: initialMuted(),
      speed: 1,
      autoScroll: store.get(KEYS.autoScroll) === '1',
      chromeHidden: store.get(KEYS.chrome) === '1',
      gridCache: new Map(), // key -> { items, cursor, hasMore, scrollY, at }
      catalogue: { tags: null, creators: null, at: 0 },
    };
    const me = () => (S.session && S.session.user) || null;
    const isAdmin = () => !!(me() && me().role === 'admin');
    const canTools = () => !!(me() && me().canTools);
    const isOwner = (s) => !!(me() && s.uploader_id != null && s.uploader_id === me().id);

    // Everything the current page started; leave() undoes it.
    let cleanups = [];
    const onLeave = (fn) => { cleanups.push(fn); };
    let generation = 0; // bumps on leave: late answers for an old page are dropped
    function leave() {
      generation++;
      const list = cleanups;
      cleanups = [];
      for (const fn of list.reverse()) {
        try { fn(); } catch (e) { console.warn('tik: cleanup failed', e); }
      }
      closeAllSheets();
      flushViews();
      document.body.classList.remove('tik-feed', 'tik-immersive');
    }
    const live = (gen) => gen === generation;

    // --- API ---------------------------------------------------------------
    class TikError extends Error {
      constructor(msg, status) { super(msg); this.status = status; }
    }
    let relinking = null;
    async function call(path, { method = 'GET', body } = {}) {
      const opts = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
      if (body !== undefined) {
        opts.headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      let r;
      try { r = await fetch(`/api/tik/${path}`, opts); } catch { throw new TikError('No connection to Grabbit', 0); }
      let d = null;
      try { d = await r.json(); } catch { /* not JSON */ }
      if (r.status === 401) {
        lostLink();
        throw new TikError('Signed out of TikShortis', 401);
      }
      if (!r.ok || (d && d.ok === false)) throw new TikError((d && d.error) || `TikShortis answered ${r.status}`, r.status);
      return d || {};
    }
    // A 401 from /api/tik is either Grabbit's own sign-in (gone) or the linked
    // TikShortis session (ended). The session route tells them apart.
    function lostLink() {
      if (relinking) return;
      relinking = loadSession(true).finally(() => { relinking = null; });
    }
    function loadSession(force) {
      if (S.loading) return S.loading;
      if (S.session !== undefined && !force) return Promise.resolve(S.session);
      S.loading = fetch('/api/tik/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(async (r) => {
          if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
          const d = await r.json().catch(() => null);
          if (!r.ok || !d) throw new Error((d && d.error) || `HTTP ${r.status}`);
          const was = S.session;
          // Another account (or none) since the last answer: what was cached
          // for the old one (grids, the tag catalogue built from its private
          // clips) must not show for the new one.
          const who = (x) => (x && x.linked ? `${(x.user && x.user.id) ?? '?'}` : '');
          if (was && who(was) !== who(d)) {
            S.gridCache.clear();
            S.catalogue = { tags: null, creators: null, at: 0 };
          }
          S.session = d;
          S.sessionError = null;
          // Redraw when the link state changed (or on the first answer).
          if (!was || was.linked !== d.linked || !!was.user !== !!d.user) hub.rerender();
          return d;
        })
        .catch((e) => {
          S.sessionError = e.message;
          S.session = undefined;
          hub.rerender();
          return null;
        })
        .finally(() => { S.loading = null; });
      return S.loading;
    }

    // --- Small UI pieces ---------------------------------------------------
    // A toast with an optional action (Undo); the hub's own toast has none.
    let toastEl = null;
    let toastTimer = null;
    function say(msg, action) {
      if (!toastEl) {
        toastEl = h('div', { class: 'tik-toast', role: 'status', 'aria-live': 'polite' });
        document.body.append(toastEl);
      }
      clearTimeout(toastTimer);
      fill(toastEl, h('span', null, msg), action ? h('button', { type: 'button', class: 'btn small', onclick: () => { toastEl.hidden = true; action.run(); } }, action.label) : null);
      toastEl.hidden = false;
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, action ? 5000 : 3500);
    }
    const fail = (e) => say(e && e.message ? e.message : String(e));

    function avatar(name, pid, v, size) {
      const box = h('span', { class: 'tik-av', style: size ? `width:${size}px;height:${size}px` : null }, initials(name));
      if (pid) {
        // Initials until the picture loads; a profile without one stays initials.
        const img = h('img', { alt: '', src: avatarOf(pid, v), loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() });
        box.append(img);
      }
      return box;
    }
    function pageHead(title, ...extra) {
      const u = me();
      return h('header', { class: 'tik-head' },
        h('h1', null, title),
        ...extra,
        u ? h('a', { class: 'tik-who', href: link('account'), title: 'Your TikShortis account' }, `Signed in to TikShortis as ${u.displayName || u.username || u.handle || u.email}`) : null);
    }
    const empty = (text, ...more) => h('div', { class: 'tik-empty' }, h('p', null, text), ...more);
    function pills(name, options, current, onPick) {
      return h('div', { class: 'tik-pills', role: 'group', 'aria-label': name },
        options.map(([v, label]) => h('button', { type: 'button', class: 'tik-pill', 'aria-pressed': String(v === current), onclick: () => onPick(v) }, label)));
    }
    const LENGTHS = [['all', 'Any length'], ['short', 'Short'], ['long', 'Long']];

    // --- Sheets (dialogs) --------------------------------------------------
    // One stack. The device Back button closes the open sheets: while any is
    // open, ONE history entry with the same address sits on top (no
    // hashchange, no redraw). One entry, not one per sheet, because a sheet
    // often closes and the next opens in the same click (More -> Edit), and a
    // history.back() per sheet would land late and close the new one.
    const sheets = [];
    let guard = false; // our history entry is on top
    let ignorePop = 0; // pops we caused ourselves
    function openSheet(title, body, opts = {}) {
      const close = () => closeSheet(entry, true);
      const panel = h('div', { class: `tik-sheet${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'tik-sheet-grab', 'aria-hidden': 'true' }),
        h('div', { class: 'tik-sheet-head' }, h('h3', null, title), h('button', { type: 'button', class: 'tik-x', 'aria-label': 'Close', onclick: close }, ic('close'))),
        h('div', { class: 'tik-sheet-body' }, body));
      const scrim = h('div', { class: 'tik-scrim', onclick: close });
      const entry = { panel, scrim, onClose: opts.onClose, back: document.activeElement };
      document.body.append(scrim, panel);
      sheets.push(entry);
      if (!guard) {
        try { history.pushState({ ...(history.state || {}), tikSheet: 1 }, '', location.href); guard = true; } catch { /* ignore */ }
      }
      const first = panel.querySelector('input, textarea, select, button:not(.tik-x)');
      (first || panel.querySelector('.tik-x')).focus({ preventScroll: true });
      return { close, panel, body: panel.querySelector('.tik-sheet-body') };
    }
    function closeSheet(entry, viaUi) {
      const i = sheets.indexOf(entry);
      if (i < 0) return;
      sheets.splice(i, 1);
      entry.panel.remove();
      entry.scrim.remove();
      if (entry.onClose) entry.onClose();
      if (!viaUi) return;
      if (entry.back && entry.back.isConnected && !sheets.length) entry.back.focus({ preventScroll: true });
      // Closed on screen: take the history entry back off, unless another
      // sheet opens right away (it reuses the entry).
      setTimeout(() => {
        if (sheets.length || !guard) return;
        guard = false;
        if (history.state && history.state.tikSheet) { ignorePop++; history.back(); }
      }, 0);
    }
    function closeAllSheets() {
      while (sheets.length) closeSheet(sheets[sheets.length - 1], false);
      // Leaving the page: the entry stays below the new address and is a
      // harmless duplicate of the old one.
      guard = false;
    }
    window.addEventListener('popstate', () => {
      if (ignorePop) { ignorePop--; return; }
      if (!guard) return;
      guard = false;
      while (sheets.length) closeSheet(sheets[sheets.length - 1], false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sheets.length) { e.preventDefault(); closeSheet(sheets[sheets.length - 1], true); }
      // aria-modal: Tab and Shift+Tab cycle inside the top sheet and never
      // reach the page behind the scrim.
      if (e.key === 'Tab' && sheets.length) {
        const panel = sheets[sheets.length - 1].panel;
        const items = [...panel.querySelectorAll('a[href], button, input, textarea, select, video[controls], [tabindex]:not([tabindex="-1"])')]
          .filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        const inside = panel.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === firstEl)) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && (!inside || document.activeElement === lastEl)) { e.preventDefault(); firstEl.focus(); }
      }
    });
    function confirmSheet(title, text, label, run) {
      const s = openSheet(title, [
        h('p', null, text),
        h('div', { class: 'tik-row-btns' },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => s.close() }, 'Cancel'),
          h('button', { type: 'button', class: 'btn danger', onclick: async (e) => { e.currentTarget.disabled = true; try { await run(); s.close(); } catch (err) { fail(err); e.currentTarget.disabled = false; } } }, label)),
      ]);
    }

    // --- Watch history (the view beacon) ----------------------------------
    // Same contract as TikShortis lib/view-beacon.ts: latest report per clip,
    // flushed 4 s after the first one, on hide and on leaving the page.
    const pendingViews = new Map();
    let viewTimer = null;
    function queueView(id, watchMs, completed) {
      if (!(watchMs > 0) && !completed) return;
      pendingViews.set(id, { id, watchMs: Math.round(watchMs), completed: !!completed });
      if (!viewTimer) viewTimer = setTimeout(flushViews, 4000);
    }
    function flushViews() {
      clearTimeout(viewTimer);
      viewTimer = null;
      if (!pendingViews.size) return;
      const batch = [...pendingViews.values()].slice(0, 50);
      pendingViews.clear();
      const body = JSON.stringify({ views: batch });
      let sent = false;
      try { sent = navigator.sendBeacon && navigator.sendBeacon('/api/tik/shorts/views', body); } catch { sent = false; }
      if (!sent) fetch('/api/tik/shorts/views', { method: 'POST', body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
    }
    window.addEventListener('pagehide', flushViews);

    // =======================================================================
    // Feed: the vertical player
    // =======================================================================
    const MODES = [['foryou', 'For You'], ['following', 'Following'], ['new', 'New'], ['liked', 'Liked'], ['random', 'Random']];
    const SEEDED = new Set(['foryou', 'random']);
    const NEAR = 2; // cards around the active one that keep their video source
    const newSeed = () => 1 + Math.floor(Math.random() * 2147483645);

    function viewFeed(r, scoped) {
      const gen = generation;
      const p = r.params;
      const tag = tagOf(p.get('tag'));
      const scope = {};
      if (scoped) {
        if (intOf(p.get('profile'))) scope.profile = intOf(p.get('profile'));
        if (intOf(p.get('playlist'))) scope.playlist = intOf(p.get('playlist'));
        if (p.get('handle')) scope.handle = handleOf(p.get('handle'));
      }
      if (tag) scope.tag = tag;
      const focus = intOf(p.get('focus'));
      let sort = MODES.some(([m]) => m === p.get('sort')) ? p.get('sort') : 'foryou';
      // TikShortis rules: a tag or a scoped feed is newest first; a focus
      // cannot anchor in a seeded (offset) order, so it reads as New.
      if (scoped || tag) sort = 'new';
      if (focus && SEEDED.has(sort)) sort = 'new';
      const length = ['short', 'long'].includes(p.get('length')) ? p.get('length') : 'all';
      const seed = SEEDED.has(sort) ? newSeed() : null;
      // New, Following and Liked page by clip id, so a deep link can also
      // load the clips above it (`after`); the others page by offset.
      const byId = !SEEDED.has(sort) && sort !== 'history';
      const inPlaylist = !!scope.playlist;
      const mainFeed = !scoped && !tag;
      const showModes = mainFeed;

      const F = {
        items: [],
        cards: [],
        ids: new Set(),
        cursor: focus ? focus + 1 : null,
        hasMore: true,
        loading: false,
        errors: 0,
        retryAt: 0,
        prev: focus && byId ? focus : null,
        hasPrev: !!(focus && byId),
        loadingPrev: false,
        active: -1,
        soundBlocked: false,
      };
      document.body.classList.add('tik-feed');

      const scroller = h('div', { class: 'tf-scroll', tabindex: '-1' });
      const status = h('div', { class: 'tf-status' });
      const topSentinel = h('div', { class: 'tf-sentinel tf-sentinel-top', 'aria-hidden': 'true' });
      const bottomSentinel = h('div', { class: 'tf-sentinel', 'aria-hidden': 'true' });
      scroller.append(topSentinel, bottomSentinel);
      const panel = h('aside', { class: 'tf-panel', hidden: true, 'aria-label': 'Comments' });
      const muteBtn = h('button', { type: 'button', class: 'tf-round tf-mute', 'data-sound-toggle': '1', 'aria-label': S.muted ? 'Turn sound on' : 'Mute', onclick: () => setMuted(!S.muted) }, ic(S.muted ? 'muted' : 'sound'));
      function setMuted(m) {
        S.muted = m;
        F.soundBlocked = false;
        store.set(KEYS.soundLast, m ? 'muted' : 'on');
        fill(muteBtn, ic(m ? 'muted' : 'sound'));
        muteBtn.setAttribute('aria-label', m ? 'Turn sound on' : 'Mute');
        const c = F.cards[F.active];
        if (c) c.video.muted = m;
      }
      // The browser refused sound before the first touch: the next touch
      // that is not the speaker button brings the wanted sound back.
      const unblock = (e) => {
        if (!F.soundBlocked || (e.target.closest && e.target.closest('[data-sound-toggle]'))) return;
        F.soundBlocked = false;
        const c = F.cards[F.active];
        if (c && !S.muted) { c.video.muted = false; }
      };
      document.addEventListener('pointerdown', unblock, true);
      onLeave(() => document.removeEventListener('pointerdown', unblock, true));

      const modeBar = showModes
        ? h('nav', { class: 'tf-modes', 'aria-label': 'Feed' },
          MODES.map(([m, label]) => h('a', { href: link('', { sort: m === 'foryou' ? null : m, length: length === 'all' ? null : length }), 'aria-current': m === sort ? 'page' : null }, label)),
          h('button', { type: 'button', class: 'tf-len', title: 'Clip length', onclick: () => {
            const next = LENGTHS[(LENGTHS.findIndex(([v]) => v === length) + 1) % LENGTHS.length][0];
            location.hash = link('', { sort: sort === 'foryou' ? null : sort, length: next === 'all' ? null : next });
          } }, LENGTHS.find(([v]) => v === length)[1]))
        : h('nav', { class: 'tf-modes scoped' },
          h('a', { href: scopeBackHref(scope), class: 'tf-back' }, ic('back'), h('span', null, scopeLabel(scope))));
      const head = h('div', { class: 'tf-top' },
        muteBtn,
        modeBar,
        h('a', { class: 'tf-round tf-search', href: link('search'), 'aria-label': 'Search tags and creators' }, ic('search')));
      const stepper = h('div', { class: 'tf-step' },
        h('button', { type: 'button', class: 'tf-round', 'aria-label': 'Previous clip', onclick: () => step(-1) }, ic('up')),
        h('button', { type: 'button', class: 'tf-round', 'aria-label': 'Next clip', onclick: () => step(1) }, ic('down')));
      const resumeBox = h('div', { class: 'tf-resume', hidden: true });
      const root = h('div', { class: `tf${S.chromeHidden ? ' clean' : ''}` },
        h('div', { class: 'tf-main' }, head, scroller, status, stepper, resumeBox),
        panel);

      // ---- Loading pages ----
      function feedQuery(extra) {
        const q = new URLSearchParams({ channel: 'main' });
        for (const [k, v] of Object.entries(scope)) q.set(k, String(v));
        if (sort !== 'new') q.set('sort', sort);
        if (seed) q.set('seed', String(seed));
        if (length !== 'all') q.set('length', length);
        for (const [k, v] of Object.entries(extra || {})) if (v != null) q.set(k, String(v));
        return `shorts/feed?${q}`;
      }
      async function loadMore() {
        if (F.loading || !F.hasMore || Date.now() < F.retryAt) return;
        F.loading = true;
        paintStatus();
        try {
          const d = await call(feedQuery({ cursor: F.cursor }));
          if (!live(gen)) return;
          F.errors = 0;
          const fresh = (d.items || []).filter((s) => s && Number.isInteger(s.id) && !F.ids.has(s.id));
          for (const s of fresh) addCard(s, false);
          F.cursor = d.nextCursor;
          F.hasMore = d.nextCursor !== null && d.nextCursor !== undefined;
          if (F.active < 0 && F.cards.length) {
            pickActive();
            offerResume();
            // The top sentinel was already in view before the first page
            // came, so its observer will not fire again: ask once here.
            loadPrev();
          }
        } catch (e) {
          if (!live(gen)) return;
          F.errors++;
          F.retryAt = Date.now() + Math.min(30000, 2 ** F.errors * 1000);
          F.lastError = e.message;
        } finally {
          if (live(gen)) { F.loading = false; paintStatus(); }
        }
      }
      // Clips above the top one, after a focus deep link (id-paged orders).
      async function loadPrev() {
        if (!byId || F.loadingPrev || !F.hasPrev || F.prev === null || !F.cards.length) return;
        F.loadingPrev = true;
        try {
          const d = await call(feedQuery({ after: F.prev }));
          if (!live(gen)) return;
          const firstCard = F.cards[0];
          const delta = firstCard.el.offsetTop - scroller.scrollTop;
          const fresh = (d.items || []).filter((s) => s && Number.isInteger(s.id) && !F.ids.has(s.id));
          for (const s of fresh.reverse()) addCard(s, true);
          F.prev = d.nextCursor;
          F.hasPrev = d.nextCursor !== null && d.nextCursor !== undefined;
          // Keep the clip on screen exactly where it was.
          scroller.scrollTop = firstCard.el.offsetTop - delta;
          pickActive();
        } catch {
          F.hasPrev = false;
        } finally {
          F.loadingPrev = false;
        }
      }
      function paintStatus() {
        if (F.cards.length) {
          status.hidden = !(F.loading || (F.errors && F.hasMore));
          fill(status, F.loading ? 'Loading ...' : h('span', null, 'Could not load more. ', h('button', { type: 'button', class: 'linkish', onclick: () => { F.retryAt = 0; loadMore(); } }, 'Try again')));
          return;
        }
        status.hidden = false;
        if (F.loading) fill(status, h('p', null, 'Loading ...'));
        else if (F.errors) fill(status, h('p', null, `Could not load the feed: ${F.lastError || ''}`), h('button', { type: 'button', class: 'btn', onclick: () => { F.retryAt = 0; loadMore(); } }, 'Try again'));
        else if (sort === 'following') fill(status, h('p', null, 'Nothing from creators you follow.'), h('p', { class: 'muted small' }, 'TikShortis has no follow button yet; this list only holds follows carried over from the old app.'));
        else fill(status, h('p', null, 'No clips yet.'), h('a', { class: 'btn', href: link('upload') }, 'Upload a clip'));
      }

      // ---- Cards ----
      function addCard(s, atTop) {
        F.ids.add(s.id);
        const c = buildCard(s);
        if (atTop) {
          F.items.unshift(s);
          F.cards.unshift(c);
          if (F.active >= 0) F.active++;
          topSentinel.after(c.el);
        } else {
          F.items.push(s);
          F.cards.push(c);
          bottomSentinel.before(c.el);
        }
        activeObserver.observe(c.el);
      }
      function removeCard(c) {
        const i = F.cards.indexOf(c);
        if (i < 0) return -1;
        deactivate(c);
        unload(c);
        activeObserver.unobserve(c.el);
        c.el.remove();
        F.cards.splice(i, 1);
        F.items.splice(i, 1);
        F.ids.delete(c.s.id);
        if (F.active === i) F.active = -1;
        else if (F.active > i) F.active--;
        requestAnimationFrame(pickActive);
        if (!F.cards.length) paintStatus();
        return i;
      }
      function reinsert(c, i) {
        F.ids.add(c.s.id);
        const before = F.cards[i];
        (before ? before.el : bottomSentinel).before(c.el);
        F.cards.splice(i, 0, c);
        F.items.splice(i, 0, c.s);
        if (F.active >= i) F.active++;
        activeObserver.observe(c.el);
        status.hidden = true;
        c.el.scrollIntoView({ block: 'start' });
      }

      function buildCard(s) {
        const parts = splitCaption(s.caption);
        const video = h('video', {
          class: 'tf-video',
          playsinline: true,
          'webkit-playsinline': true,
          preload: 'none',
          loop: !S.autoScroll,
          poster: posterOf(s),
          'data-media-bg': '1',
          'aria-label': parts.title || 'Clip',
        });
        video.muted = true;
        const seek = h('input', { class: 'tf-seek', type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Seek' });
        const time = h('span', { class: 'tf-time' });
        const burst = h('span', { class: 'tf-burst', hidden: true, 'aria-hidden': 'true' }, ic('heart'));
        const playIcon = h('span', { class: 'tf-paused', hidden: true, 'aria-hidden': 'true' }, ic('play'));
        const likeBtn = railBtn('heart', 'Like', () => toggleLike(c, false));
        const commentBtn = railBtn('chat', 'Comments', () => openComments(c));
        const saveBtn = railBtn('bookmark', 'Save', () => openSave(c));
        const shareBtn = railBtn('share', 'Share', () => share(c));
        const moreBtn = railBtn('more', 'More', () => openMore(c));
        const author = s.profile_id && s.profile_name
          ? h('a', { class: 'tf-author', href: link(`person/${enc(handleOf(s.profile_name))}`) }, `@${s.profile_name}`)
          : h('span', { class: 'tf-author' }, s.uploader_name ? `@${s.uploader_name}` : '');
        const titleEl = h('p', { class: 'tf-title' }, parts.title);
        if (parts.title.length > 40) {
          titleEl.classList.add('clamp');
          titleEl.append(' ');
          titleEl.addEventListener('click', () => titleEl.classList.toggle('clamp'));
        }
        const src = sourceLink(s, parts);
        const tagsShown = parts.tags.slice(0, 3);
        const tagRow = h('div', { class: 'tf-tags' },
          tagsShown.map((t) => h('a', { href: tagHref(t) }, t)),
          parts.tags.length > 3 ? h('button', { type: 'button', class: 'linkish', onclick: (e) => {
            e.currentTarget.replaceWith(...parts.tags.slice(3).map((t) => h('a', { href: tagHref(t) }, t)));
          } }, `+${parts.tags.length - 3} more`) : null);
        const meta = h('div', { class: 'tf-meta' },
          h('div', { class: 'tf-by' }, author, s.is_private && (isOwner(s) || isAdmin()) ? h('span', { class: 'tf-lock', title: 'Private' }, ic('lock'), 'Private') : null),
          parts.title ? titleEl : null,
          src ? h('a', { class: 'tf-src', href: src, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'Source') : null,
          parts.tags.length ? tagRow : null);
        const stage = h('div', { class: 'tf-stage' }, video, playIcon, burst, meta, h('div', { class: 'tf-seekbar' }, seek, time));
        const rail = h('div', { class: 'tf-rail' },
          s.profile_id ? h('a', { class: 'tf-rail-av', href: link(`profile/${s.profile_id}`), 'aria-label': `Profile ${s.profile_name || ''}` }, avatar(s.profile_name, s.profile_id, null, 48)) : null,
          likeBtn.el, commentBtn.el, saveBtn.el, shareBtn.el, moreBtn.el);
        const el = h('section', { class: 'tf-card', 'data-id': String(s.id) }, h('div', { class: 'tf-player' }, stage), rail);
        const c = { s, el, video, seek, time, likeBtn, commentBtn, saveBtn, stage, burst, playIcon, maxTime: 0, lastTime: 0, completed: false, seeking: false, wantPlay: false };
        paintCounts(c);

        video.addEventListener('timeupdate', () => {
          const t = video.currentTime;
          const d = video.duration;
          if (t > c.maxTime) c.maxTime = t;
          if (Number.isFinite(d) && d > 0) {
            if (t >= d * 0.95) c.completed = true;
            // A loop wrap from near the end counts as watched through.
            if (c.lastTime >= d * 0.9 && t < c.lastTime - 1) c.completed = true;
            if (!c.seeking) seek.value = String(Math.round((t / d) * 1000));
            time.textContent = `${clock(t)} / ${clock(d)}`;
          }
          c.lastTime = t;
        });
        video.addEventListener('ended', () => {
          c.completed = true;
          if (S.autoScroll && F.cards[F.active] === c) step(1);
        });
        video.addEventListener('play', () => { playIcon.hidden = true; });
        video.addEventListener('pause', () => { playIcon.hidden = F.cards[F.active] !== c; });
        seek.addEventListener('input', () => {
          c.seeking = true;
          const d = video.duration;
          if (Number.isFinite(d) && d > 0) video.currentTime = (Number(seek.value) / 1000) * d;
        });
        seek.addEventListener('change', () => { c.seeking = false; });
        attachGestures(c);
        return c;
      }
      function railBtn(name, label, onclick) {
        const count = h('span', { class: 'tf-count' }, label);
        const btn = h('button', { type: 'button', class: 'tf-rb', 'aria-label': label, onclick }, ic(name));
        return { el: h('div', { class: 'tf-r' }, btn, count), btn, count };
      }
      function paintCounts(c) {
        const s = c.s;
        c.likeBtn.btn.classList.toggle('on', !!s.viewer_liked);
        c.likeBtn.btn.setAttribute('aria-pressed', String(!!s.viewer_liked));
        c.likeBtn.btn.setAttribute('aria-label', s.viewer_liked ? 'Unlike' : 'Like');
        c.likeBtn.count.textContent = num(s.like_count);
        c.commentBtn.count.textContent = num(s.comment_count);
        c.saveBtn.btn.classList.toggle('saved', !!s.viewer_saved);
        c.saveBtn.count.textContent = s.viewer_saved ? 'Saved' : 'Save';
      }

      // ---- Gestures: tap, double tap, long press ----
      function attachGestures(c) {
        let tapTimer = null;
        let lastTap = 0;
        let press = null;
        let long = false;
        let start = null;
        const onControl = (e) => !!(e.target.closest && e.target.closest('a, button, input, .tf-meta'));
        c.stage.addEventListener('pointerdown', (e) => {
          if (onControl(e) || e.button > 0) return;
          start = { x: e.clientX, y: e.clientY };
          long = false;
          press = setTimeout(() => { press = null; long = true; }, 550);
        });
        c.stage.addEventListener('pointermove', (e) => {
          if (!start) return;
          if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) { clearTimeout(press); press = null; start = null; }
        });
        c.stage.addEventListener('pointercancel', () => { clearTimeout(press); press = null; start = null; });
        c.stage.addEventListener('contextmenu', (e) => { if (!onControl(e)) e.preventDefault(); });
        c.stage.addEventListener('pointerup', (e) => {
          if (!start) return;
          start = null;
          clearTimeout(press);
          press = null;
          if (long) { long = false; openMore(c); return; }
          const rect = c.stage.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          const now = Date.now();
          if (tapTimer && now - lastTap < 260) {
            clearTimeout(tapTimer);
            tapTimer = null;
            if (x > 0.65) skip(c, 10);
            else if (x < 0.35) skip(c, -10);
            else toggleLike(c, true);
            return;
          }
          lastTap = now;
          tapTimer = setTimeout(() => { tapTimer = null; togglePlay(c); }, 220);
        });
      }
      function skip(c, by) {
        const v = c.video;
        const d = Number.isFinite(v.duration) ? v.duration : Infinity;
        v.currentTime = Math.max(0, Math.min(d - 0.1, v.currentTime + by));
        say(by > 0 ? '+10 s' : '-10 s');
      }
      function togglePlay(c) {
        if (F.cards[F.active] !== c) return;
        if (c.video.paused) play(c); else { c.wantPlay = false; c.video.pause(); }
      }

      // ---- Active card, preloading, playback ----
      const activeObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting || en.intersectionRatio < 0.6) continue;
          const i = F.cards.findIndex((c) => c.el === en.target);
          if (i >= 0) setActive(i);
        }
      }, { root: scroller, threshold: [0.6] });
      const edgeObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          if (en.target === bottomSentinel) loadMore();
          else if (en.target === topSentinel) loadPrev();
        }
      }, { root: scroller, rootMargin: '600px 0px 400px 0px' });
      edgeObserver.observe(bottomSentinel);
      edgeObserver.observe(topSentinel);
      function pickActive() {
        const top = scroller.getBoundingClientRect().top;
        let best = -1;
        let bestDist = Infinity;
        F.cards.forEach((c, i) => {
          const dist = Math.abs(c.el.getBoundingClientRect().top - top);
          if (dist < bestDist) { bestDist = dist; best = i; }
        });
        if (best >= 0) setActive(best, true);
      }
      function setActive(i, force) {
        if (i === F.active && !force) return;
        const old = F.cards[F.active];
        if (old && old !== F.cards[i]) deactivate(old);
        F.active = i;
        F.cards.forEach((c, j) => {
          if (Math.abs(j - i) <= NEAR) {
            c.video.preload = j === i || j === i + 1 ? 'auto' : 'metadata';
            if (!c.video.getAttribute('src')) c.video.src = videoOf(c.s.id);
          } else unload(c);
        });
        const c = F.cards[i];
        if (!c) return;
        play(c);
        for (const x of F.cards) x.playIcon.hidden = true;
        // Keep the current clip in the address (a reload or Back lands here).
        const q = new URLSearchParams(r.params);
        q.set('focus', String(c.s.id));
        q.delete('path');
        const sub = r.sub.length ? `/${r.sub.map(enc).join('/')}` : '';
        hub.replaceHash(`${BASE}${sub}?${q}`);
        if (mainFeed && sort !== 'history') store.set(KEYS.resume, JSON.stringify({ focus: c.s.id, at: Date.now() }));
        if (i >= F.cards.length - 3) loadMore();
        if (panel.dataset.open === '1') openComments(c, true);
      }
      function play(c) {
        const v = c.video;
        if (!v.getAttribute('src')) v.src = videoOf(c.s.id);
        v.muted = S.muted;
        v.playbackRate = S.speed;
        v.loop = !S.autoScroll;
        c.wantPlay = true;
        const pr = v.play();
        if (pr && pr.catch) {
          pr.catch((e) => {
            if (!c.wantPlay || F.cards[F.active] !== c) return;
            if (e && e.name === 'NotAllowedError' && !v.muted) {
              v.muted = true;
              F.soundBlocked = true;
              v.play().catch(() => { c.playIcon.hidden = false; });
            } else c.playIcon.hidden = false;
          });
        }
      }
      function deactivate(c) {
        c.wantPlay = false;
        c.video.pause();
        if (c.video.getAttribute('src')) { try { c.video.currentTime = 0; } catch { /* not loaded */ } }
        queueView(c.s.id, c.maxTime * 1000, c.completed);
        c.maxTime = 0;
        c.lastTime = 0;
        c.completed = false;
        c.playIcon.hidden = true;
      }
      // Drops the video source to free the decoder and the memory it holds.
      function unload(c) {
        if (!c.video.getAttribute('src')) return;
        c.video.pause();
        c.video.removeAttribute('src');
        c.video.load();
      }
      function step(by) {
        const next = F.cards[F.active + by];
        if (next) next.el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      }

      // ---- Like, comments, save, share ----
      async function toggleLike(c, onlyLike) {
        const s = c.s;
        heartBurst(c);
        if (onlyLike && s.viewer_liked) return;
        const was = { liked: s.viewer_liked, count: s.like_count };
        s.viewer_liked = !was.liked;
        s.like_count = Math.max(0, was.count + (s.viewer_liked ? 1 : -1));
        paintCounts(c);
        try {
          const d = await call(`shorts/${s.id}/like`, { method: 'POST' });
          s.viewer_liked = !!d.liked;
          if (Number.isFinite(d.like_count)) s.like_count = d.like_count;
        } catch (e) {
          s.viewer_liked = was.liked;
          s.like_count = was.count;
          fail(e);
        }
        paintCounts(c);
      }
      function heartBurst(c) {
        c.burst.hidden = false;
        c.burst.classList.remove('go');
        void c.burst.offsetWidth;
        c.burst.classList.add('go');
        setTimeout(() => { c.burst.hidden = true; }, 700);
      }
      // Wide screens: a panel beside the video. Narrow: a bottom sheet.
      const widePanel = () => matchMedia('(min-width: 1101px)').matches;
      function openComments(c, follow) {
        if (follow && panel.dataset.open !== '1') return;
        const box = commentsBox(c);
        if (widePanel()) {
          panel.hidden = false;
          panel.dataset.open = '1';
          root.classList.add('with-panel');
          fill(panel, 
            h('div', { class: 'tik-sheet-head' }, h('h3', null, `Comments (${num(c.s.comment_count)})`), h('button', { type: 'button', class: 'tik-x', 'aria-label': 'Close comments', onclick: closePanel }, ic('close'))),
            box);
        } else if (!follow) {
          openSheet(`Comments (${num(c.s.comment_count)})`, box);
        }
      }
      function closePanel() {
        panel.hidden = true;
        panel.dataset.open = '';
        root.classList.remove('with-panel');
        fill(panel, );
      }
      function commentsBox(c) {
        const s = c.s;
        const listEl = h('div', { class: 'tik-comments' }, h('p', { class: 'muted' }, 'Loading ...'));
        const input = h('textarea', { rows: '1', maxlength: '2000', placeholder: 'Add a comment', 'aria-label': 'Comment' });
        const send = h('button', { type: 'submit', class: 'btn' }, 'Post');
        const form = h('form', { class: 'tik-compose', onsubmit: async (e) => {
          e.preventDefault();
          const body = input.value.trim();
          if (!body) return;
          send.disabled = true;
          try {
            const d = await call(`shorts/${s.id}/comments`, { method: 'POST', body: { body } });
            input.value = '';
            s.comment_count = (s.comment_count || 0) + 1;
            paintCounts(c);
            if (listEl.querySelector('.muted')) fill(listEl, );
            if (d.comment) listEl.append(commentRow(d.comment));
            const head = form.closest('.tik-sheet, .tf-panel');
            const h3 = head && head.querySelector('h3');
            if (h3) h3.textContent = `Comments (${num(s.comment_count)})`;
            listEl.scrollTop = listEl.scrollHeight;
          } catch (err) {
            // The text stays in the box on failure.
            say(err.status === 401 ? 'Signed out of TikShortis: link your account again to comment.' : err.message);
          } finally { send.disabled = false; }
        } }, input, send);
        call(`shorts/${s.id}/comments`).then((d) => {
          const list = d.comments || [];
          fill(listEl, ...(list.length ? list.map(commentRow) : [h('p', { class: 'muted' }, 'No comments yet.')]));
        }).catch((e) => fill(listEl, h('p', { class: 'err' }, e.message)));
        return h('div', { class: 'tik-comments-box' }, listEl, form);
      }
      function commentRow(m) {
        return h('div', { class: 'tik-cm' }, avatar(m.author_name), h('div', null, h('b', null, m.author_name || 'Someone'), ' ', h('small', null, when(m.created_at)), h('p', null, m.body)));
      }
      function openSave(c) {
        const s = c.s;
        const listEl = h('div', { class: 'tik-list' }, h('p', { class: 'muted' }, 'Loading ...'));
        const name = h('input', { type: 'text', maxlength: '120', placeholder: 'New playlist', 'aria-label': 'New playlist name' });
        const form = h('form', { class: 'tik-inline-form', onsubmit: async (e) => {
          e.preventDefault();
          const n = name.value.trim();
          if (!n) return;
          try {
            const d = await call('shorts/playlists', { method: 'POST', body: { name: n } });
            if (d.playlist) await call(`shorts/playlists/${d.playlist.id}/items`, { method: 'POST', body: { shortId: s.id } });
            name.value = '';
            s.viewer_saved = true;
            paintCounts(c);
            reload();
          } catch (err) { fail(err); }
        } }, name, h('button', { type: 'submit', class: 'btn' }, 'Create'));
        function reload() {
          call(`shorts/playlists?short=${s.id}`).then((d) => {
            const pls = d.playlists || [];
            fill(listEl, ...(pls.length ? pls.map(row) : [h('p', { class: 'muted' }, 'No playlists yet.')]));
            s.viewer_saved = pls.some((x) => Number(x.contains) === 1);
            paintCounts(c);
          }).catch((e) => fill(listEl, h('p', { class: 'err' }, e.message)));
        }
        function row(pl) {
          const box = h('input', { type: 'checkbox', checked: Number(pl.contains) === 1 });
          box.addEventListener('change', async () => {
            const want = box.checked;
            try {
              if (want) await call(`shorts/playlists/${pl.id}/items`, { method: 'POST', body: { shortId: s.id } });
              else await call(`shorts/playlists/${pl.id}/items?short=${s.id}`, { method: 'DELETE' });
              pl.contains = want ? 1 : 0;
            } catch (e) { box.checked = !want; fail(e); }
            reload();
          });
          return h('label', { class: 'tik-check' }, box, h('span', null, pl.name), h('small', { class: 'muted' }, `${num(pl.item_count)} clips`));
        }
        reload();
        openSheet('Save to playlist', [listEl, form]);
      }
      async function share(c) {
        const url = `${location.origin}/${link('', { focus: c.s.id, sort: 'new' })}`;
        try {
          if (navigator.share) { await navigator.share({ url, title: splitCaption(c.s.caption).title || 'TikShortis clip' }); return; }
          await navigator.clipboard.writeText(url);
          say('Link copied');
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          say('Could not share the link');
        }
      }

      // ---- More menu and the sheets behind it ----
      function hideFromFeed(c, msg, undoable) {
        // In a playlist and in Liked the clip stays; elsewhere it leaves.
        if (inPlaylist || sort === 'liked') { c.s.viewer_hidden = true; say(msg); return; }
        const i = removeCard(c);
        say(msg, undoable ? { label: 'Undo', run: async () => {
          try {
            await call(`shorts/${c.s.id}/hide`, { method: 'DELETE' });
            c.s.viewer_hidden = false;
            if (live(gen) && i >= 0) reinsert(c, Math.min(i, F.cards.length));
          } catch (e) { fail(e); }
        } } : null);
      }
      function openMore(c) {
        const s = c.s;
        const owner = isOwner(s) || isAdmin();
        const rows = [];
        const row = (label, run, opts = {}) => rows.push(h('button', { type: 'button', class: `tik-menu-row${opts.danger ? ' danger' : ''}`, onclick: () => { sheet.close(); run(); } }, label, opts.note ? h('small', null, opts.note) : null));
        rows.push(h('a', { class: 'tik-menu-row', href: `${videoOf(s.id)}?download=1`, download: '' }, 'Download'));
        if (s.viewer_hidden) row('Show in feed again', async () => { try { await call(`shorts/${s.id}/hide`, { method: 'DELETE' }); s.viewer_hidden = false; say('Shown in your feed again'); } catch (e) { fail(e); } });
        else row('Not interested', async () => { try { await call(`shorts/${s.id}/hide`, { method: 'POST' }); s.viewer_hidden = true; hideFromFeed(c, 'Hidden from your feed', true); } catch (e) { fail(e); } });
        if (s.why) row('Why this post', () => openSheet('Why this post', h('p', null, s.why)));
        row(s.viewer_reported ? 'Reported' : 'Report', () => openReport(c));
        row(`Speed: ${S.speed}x`, () => { const all = [0.5, 1, 1.5, 2]; S.speed = all[(all.indexOf(S.speed) + 1) % all.length]; const cur = F.cards[F.active]; if (cur) cur.video.playbackRate = S.speed; say(`Speed ${S.speed}x`); });
        row(S.chromeHidden ? 'Show overlay' : 'Clear display', () => { S.chromeHidden = !S.chromeHidden; store.set(KEYS.chrome, S.chromeHidden ? '1' : null); root.classList.toggle('clean', S.chromeHidden); });
        row(`Auto-scroll: ${S.autoScroll ? 'on' : 'off'}`, () => { S.autoScroll = !S.autoScroll; store.set(KEYS.autoScroll, S.autoScroll ? '1' : null); for (const x of F.cards) x.video.loop = !S.autoScroll; say(`Auto-scroll ${S.autoScroll ? 'on' : 'off'}`); });
        if (document.pictureInPictureEnabled) row('Picture-in-picture', () => { c.video.requestPictureInPicture().catch(() => say('Picture-in-picture is not available')); });
        row(document.fullscreenElement ? 'Leave full screen' : 'Full screen', toggleFullscreen);
        if (owner) {
          row(s.is_private ? 'Private: make public' : 'Public: make private', async () => {
            const want = !s.is_private;
            s.is_private = want;
            try { const d = await call(`shorts/${s.id}/visibility`, { method: 'PATCH', body: { isPrivate: want } }); s.is_private = !!d.is_private; say(s.is_private ? 'Now private' : 'Now public'); } catch (e) { s.is_private = !want; fail(e); }
          });
          row('Edit title and tags', () => openEdit(s, (caption) => { s.caption = caption; const fresh = buildCard(s); swapCard(c, fresh); }));
        }
        if (isAdmin()) {
          row('Fetch title from source', async () => { try { const d = await call(`shorts/${s.id}/fetch-title`, { method: 'POST' }); s.caption = d.caption; swapCard(c, buildCard(s)); say('Title updated'); } catch (e) { fail(e); } });
          row('Set cover from this frame', async () => {
            c.video.pause();
            try { await call(`shorts/${s.id}/poster`, { method: 'POST', body: { time: c.video.currentTime || 0 } }); s.has_poster = true; c.video.poster = `/api/tik/shorts/${s.id}/poster?v=${Date.now()}`; say('Cover updated'); } catch (e) { fail(e); }
          });
          row('Describe with AI', () => describe(s));
        }
        if (owner) {
          row('Hand over to 18+', () => confirmSheet('Hand over to 18+', 'Move this clip to the 18+ library? It leaves TikShortis and every general feed.', 'Hand over', async () => {
            await call(`shorts/${s.id}/channel`, { method: 'PATCH', body: { channel: '18plus' } });
            removeCard(c);
            say('Handed over to 18+');
          }), { danger: true });
          row('Delete', () => confirmSheet('Delete clip', 'Delete this clip? Its files are removed.', 'Delete', async () => {
            await call(`shorts/${s.id}`, { method: 'DELETE' });
            removeCard(c);
            say('Deleted');
          }), { danger: true });
        }
        const sheet = openSheet('More', h('div', { class: 'tik-menulist' }, rows));
      }
      function swapCard(oldC, fresh) {
        const i = F.cards.indexOf(oldC);
        if (i < 0) return;
        const wasActive = i === F.active;
        const t = oldC.video.currentTime;
        activeObserver.unobserve(oldC.el);
        deactivate(oldC);
        unload(oldC);
        oldC.el.replaceWith(fresh.el);
        F.cards[i] = fresh;
        activeObserver.observe(fresh.el);
        if (wasActive) {
          fresh.video.src = videoOf(fresh.s.id);
          fresh.video.addEventListener('loadedmetadata', () => { try { fresh.video.currentTime = t; } catch { /* ignore */ } }, { once: true });
          play(fresh);
        }
      }
      function openReport(c) {
        const s = c.s;
        const REASONS = [['broken', 'Video does not play or is cut off'], ['wrong_creator', 'Wrong creator or title'], ['duplicate', 'Duplicate of another clip'], ['inappropriate', 'Inappropriate content'], ['other', 'Something else']];
        const note = h('textarea', { rows: '3', maxlength: '500', placeholder: 'Anything to add (optional)', 'aria-label': 'Note' });
        const send = h('button', { type: 'submit', class: 'btn' }, 'Report');
        const form = h('form', { class: 'tik-form', onsubmit: async (e) => {
          e.preventDefault();
          const reason = (form.querySelector('input[name="reason"]:checked') || {}).value;
          if (!reason) { say('Choose a reason'); return; }
          send.disabled = true;
          try {
            const body = { reason };
            if (note.value.trim()) body.note = note.value.trim();
            await call(`shorts/${s.id}/report`, { method: 'POST', body });
            s.viewer_reported = true;
            s.viewer_hidden = true;
            sheet.close();
            hideFromFeed(c, 'Reported and hidden from your feed', false);
          } catch (err) { fail(err); send.disabled = false; }
        } },
        REASONS.map(([v, label]) => h('label', { class: 'tik-check' }, h('input', { type: 'radio', name: 'reason', value: v }), h('span', null, label))),
        note, send);
        const sheet = openSheet('Report clip', form);
      }
      function toggleFullscreen() {
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
        if (!root.requestFullscreen) { say('Full screen is not available'); return; }
        root.requestFullscreen().then(() => document.body.classList.add('tik-immersive')).catch(() => say('Full screen is not available'));
      }
      const onFs = () => { if (!document.fullscreenElement) document.body.classList.remove('tik-immersive'); };
      document.addEventListener('fullscreenchange', onFs);

      // ---- Keyboard ----
      const onKey = (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
        if (sheets.length || document.querySelector('[role=dialog][aria-modal=true]')) return;
        const c = F.cards[F.active];
        const k = e.key;
        if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') { e.preventDefault(); step(1); }
        else if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') { e.preventDefault(); step(-1); }
        else if (k === ' ' && c) { e.preventDefault(); togglePlay(c); }
        else if (k === 'm') setMuted(!S.muted);
        else if (k === 'l' && c) toggleLike(c, false);
        else if (k === 's' && c) openSave(c);
        else if (k === 'f') toggleFullscreen();
      };
      document.addEventListener('keydown', onKey);

      // ---- Pause when the tab is hidden; resume what was playing ----
      const onVis = () => {
        const c = F.cards[F.active];
        if (!c) return;
        if (document.hidden) { flushViews(); if (!c.video.paused) { c.resumeOnShow = true; c.video.pause(); } }
        else if (c.resumeOnShow) { c.resumeOnShow = false; play(c); }
      };
      document.addEventListener('visibilitychange', onVis);

      // ---- Resume offer (main feed, no deep link) ----
      function offerResume() {
        if (!mainFeed || focus) return;
        let saved = null;
        try { saved = JSON.parse(store.get(KEYS.resume) || 'null'); } catch { saved = null; }
        if (!saved || !intOf(saved.focus) || !(Date.now() - saved.at < 7 * 86400000)) return;
        if (F.items[0] && F.items[0].id === saved.focus) return;
        fill(resumeBox, 
          h('a', { class: 'btn small', href: link('', { focus: saved.focus, sort: 'new' }) }, 'Continue where you left off'),
          h('button', { type: 'button', class: 'tik-x', 'aria-label': 'Dismiss', onclick: () => { resumeBox.hidden = true; } }, ic('close')));
        resumeBox.hidden = false;
        const t = setTimeout(() => { resumeBox.hidden = true; }, 15000);
        onLeave(() => clearTimeout(t));
      }

      // ---- Leaving the page stops everything ----
      onLeave(() => {
        activeObserver.disconnect();
        edgeObserver.disconnect();
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVis);
        document.removeEventListener('fullscreenchange', onFs);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        const c = F.cards[F.active];
        if (c) deactivate(c);
        for (const x of F.cards) unload(x);
        F.cards = [];
      });

      paintStatus();
      loadMore();
      return root;
    }
    function scopeLabel(scope) {
      if (scope.tag) return `#${scope.tag}`;
      if (scope.handle) return `@${scope.handle}`;
      if (scope.playlist) return 'Playlist';
      if (scope.profile) return 'Profile';
      return 'Back';
    }
    function scopeBackHref(scope) {
      if (scope.playlist) return link(`playlist/${scope.playlist}`);
      if (scope.profile) return link(`profile/${scope.profile}`);
      if (scope.handle) return link(`person/${enc(scope.handle)}`);
      if (scope.tag) return link(`tag/${enc(scope.tag)}`);
      return link('');
    }

    // Edit title, source and tags (owner or admin), from the player or a tile.
    function openEdit(s, onSaved) {
      const parts = splitCaption(s.caption);
      const title = h('input', { type: 'text', value: parts.title, maxlength: '1000', 'aria-label': 'Title' });
      const source = h('input', { type: 'url', value: parts.source || '', placeholder: 'https://', 'aria-label': 'Source URL' });
      const tags = h('input', { type: 'text', value: parts.tags.join(' '), placeholder: '#tag1 #tag2', 'aria-label': 'Tags' });
      const ai = h('div', { class: 'tik-ai' });
      const send = h('button', { type: 'submit', class: 'btn' }, 'Save');
      const form = h('form', { class: 'tik-form', onsubmit: async (e) => {
        e.preventDefault();
        const src = source.value.trim();
        if (src && !/^https?:\/\/\S+$/.test(src)) { say('The source must be an http(s) link'); return; }
        const tagList = [...new Set(tags.value.split(/[\s,]+/).map(tagOf).filter(Boolean).map((t) => `#${t}`))];
        const caption = buildCaption({ title: title.value, tags: tagList, source: src || null });
        send.disabled = true;
        try {
          const d = await call(`shorts/${s.id}`, { method: 'PATCH', body: { caption } });
          sheet.close();
          say('Saved');
          onSaved(d.caption === undefined ? caption : d.caption);
        } catch (err) { fail(err); send.disabled = false; }
      } },
      h('label', null, 'Title', title), h('label', null, 'Source URL', source), h('label', null, 'Tags', tags), ai, send);
      const sheet = openSheet('Edit clip', form);
      call(`shorts/summarize?id=${s.id}`).then((d) => {
        const sum = d.summary;
        fill(ai, 
          sum && sum.summary ? h('p', { class: 'muted small' }, `AI description: ${sum.summary}`) : null,
          isAdmin() ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { sheet.close(); describe(s); } }, sum && sum.summary ? 'Describe again with AI' : 'Describe with AI') : null);
      }).catch(() => {});
    }
    // Starts one AI description (admin) and waits for it, like the card does.
    async function describe(s) {
      const gen = generation;
      try {
        const d = await call(`shorts/summarize?id=${s.id}`, { method: 'POST' });
        say(d.message || 'Describing ...');
        for (let i = 0; i < 40; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          if (!live(gen)) return;
          const st = await call('shorts/summarize');
          if (!st.running) break;
        }
        const r = await call(`shorts/summarize?id=${s.id}`);
        if (!live(gen)) return;
        const sum = r.summary;
        openSheet('AI description', sum && sum.summary ? h('p', null, sum.summary) : h('p', { class: 'muted' }, (sum && sum.error) || 'No description yet.'));
      } catch (e) { fail(e); }
    }

    // =======================================================================
    // Grids
    // =======================================================================
    // A grid of clips from the feed API (30 a page), with infinite scroll and
    // a five-minute memory of what was loaded, so Back lands where it was.
    function grid({ key, query, tileHref, controls, emptyText, admin }) {
      const gen = generation;
      const cache = S.gridCache.get(key);
      const fresh = cache && Date.now() - cache.at < 5 * 60000;
      const G = fresh ? { items: cache.items.slice(), cursor: cache.cursor, hasMore: cache.hasMore } : { items: [], cursor: null, hasMore: true };
      G.loading = false;
      const tiles = h('div', { class: 'tik-grid' });
      const status = h('div', { class: 'tik-grid-status' });
      const sentinel = h('div', { class: 'tf-sentinel', 'aria-hidden': 'true' });
      const remember = () => S.gridCache.set(key, { items: G.items.slice(0, 800), cursor: G.cursor, hasMore: G.hasMore, scrollY: window.scrollY, at: Date.now() });
      function tile(s) {
        const poster = posterOf(s);
        const parts = splitCaption(s.caption);
        const canEdit = admin && (isOwner(s) || isAdmin());
        const el = h('div', { class: 'tik-tile-wrap' },
          h('a', { class: 'tik-tile', href: tileHref(s), onclick: remember },
            poster ? h('img', { src: poster, alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : null,
            h('span', { class: 'tik-tile-meta' },
              s.is_private ? h('span', { class: 'tik-badge', title: 'Private' }, ic('lock')) : null,
              s.viewer_seen ? h('span', { class: 'tik-badge seen' }, 'Seen') : null,
              Number.isFinite(s.duration) ? h('span', { class: 'tik-badge' }, clock(s.duration)) : null),
            h('span', { class: 'tik-tile-cap' }, h('span', { class: 'tik-tile-t' }, parts.title || (s.profile_name ? `@${s.profile_name}` : '')), h('small', null, ic('heart'), num(s.like_count)))),
          canEdit ? h('button', { type: 'button', class: 'tik-tile-act', 'aria-label': 'Clip actions', onclick: () => tileActions(s, el) }, ic('edit')) : null);
        return el;
      }
      function tileActions(s, el) {
        const rows = [
          h('button', { type: 'button', class: 'tik-menu-row', onclick: () => { sheet.close(); openEdit(s, (caption) => { s.caption = caption; el.replaceWith(tile(s)); }); } }, 'Edit title and tags'),
          isAdmin() ? h('button', { type: 'button', class: 'tik-menu-row', onclick: () => { sheet.close(); moveToProfile(s, () => { el.remove(); }); } }, 'Move to another profile') : null,
          h('button', { type: 'button', class: 'tik-menu-row danger', onclick: () => { sheet.close(); confirmSheet('Delete clip', 'Delete this clip? Its files are removed.', 'Delete', async () => { await call(`shorts/${s.id}`, { method: 'DELETE' }); el.remove(); say('Deleted'); }); } }, 'Delete'),
        ];
        const sheet = openSheet('Clip', h('div', { class: 'tik-menulist' }, rows));
      }
      async function more() {
        if (G.loading || !G.hasMore) return;
        G.loading = true;
        fill(status, 'Loading ...');
        try {
          const q = new URLSearchParams(query);
          q.set('limit', '30');
          if (G.cursor != null) q.set('cursor', String(G.cursor));
          const d = await call(`shorts/feed?${q}`);
          if (!live(gen)) return;
          const have = new Set(G.items.map((x) => x.id));
          const add = (d.items || []).filter((s) => s && Number.isInteger(s.id) && !have.has(s.id));
          G.items.push(...add);
          tiles.append(...add.map(tile));
          G.cursor = d.nextCursor;
          G.hasMore = d.nextCursor !== null && d.nextCursor !== undefined;
          fill(status, G.items.length ? '' : emptyText || 'No clips here yet.');
        } catch (e) {
          if (!live(gen)) return;
          fill(status, h('span', { class: 'err' }, e.message), ' ', h('button', { type: 'button', class: 'linkish', onclick: () => { G.hasMore = true; more(); } }, 'Try again'));
          G.hasMore = false;
        } finally {
          if (live(gen)) G.loading = false;
        }
      }
      const io = new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting)) more(); }, { rootMargin: '800px 0px' });
      io.observe(sentinel);
      onLeave(() => io.disconnect());
      if (G.items.length) {
        tiles.append(...G.items.map(tile));
        // Back to the same spot once the tiles are laid out.
        requestAnimationFrame(() => window.scrollTo(0, cache.scrollY || 0));
      }
      return h('div', { class: 'tik-grid-box' }, controls || null, tiles, status, sentinel);
    }
    // Admin: move a clip to another profile (or a new manual one).
    async function moveToProfile(s, done) {
      const listEl = h('div', { class: 'tik-list' }, h('p', { class: 'muted' }, 'Loading ...'));
      const filter = h('input', { type: 'search', placeholder: 'Filter profiles', 'aria-label': 'Filter profiles' });
      const newName = h('input', { type: 'text', placeholder: 'New profile name', maxlength: '120', 'aria-label': 'New profile name' });
      const sheet = openSheet('Move to profile', [filter, listEl, h('form', { class: 'tik-inline-form', onsubmit: async (e) => {
        e.preventDefault();
        const n = newName.value.trim();
        if (!n) return;
        try {
          const d = await call('shorts/profiles', { method: 'POST', body: { name: n, channel: 'main', source_type: 'manual' } });
          await assign(d.profile.id);
        } catch (err) { fail(err); }
      } }, newName, h('button', { type: 'submit', class: 'btn' }, 'Create and move'))]);
      async function assign(pid) {
        try {
          await call(`shorts/${s.id}/profile`, { method: 'PATCH', body: { profileId: pid } });
          sheet.close();
          say('Moved');
          S.gridCache.clear();
          done();
        } catch (err) { fail(err); }
      }
      let all = [];
      const paint = () => {
        const q = filter.value.trim().toLowerCase();
        const shown = all.filter((p) => p.id !== s.profile_id && (!q || String(p.name).toLowerCase().includes(q))).slice(0, 200);
        fill(listEl, ...shown.map((p) => h('button', { type: 'button', class: 'tik-menu-row', onclick: () => assign(p.id) }, p.name, h('small', null, `${num(p.clip_count)} clips`))));
      };
      filter.addEventListener('input', paint);
      try { all = (await call('shorts/profiles')).profiles || []; paint(); } catch (e) { fill(listEl, h('p', { class: 'err' }, e.message)); }
    }
    function lengthControls(r, extra) {
      const length = ['short', 'long'].includes(r.params.get('length')) ? r.params.get('length') : 'all';
      const unseen = r.params.get('unseen') === '1';
      const go = (patch) => {
        const q = new URLSearchParams(r.params);
        for (const [k, v] of Object.entries(patch)) { if (v) q.set(k, v); else q.delete(k); }
        const sub = r.sub.map(enc).join('/');
        location.hash = `${BASE}${sub ? `/${sub}` : ''}${q.toString() ? `?${q}` : ''}`;
      };
      return h('div', { class: 'tik-controls' },
        pills('Clip length', LENGTHS, length, (v) => go({ length: v === 'all' ? null : v })),
        h('button', { type: 'button', class: 'tik-pill', 'aria-pressed': String(unseen), onclick: () => go({ unseen: unseen ? null : '1' }) }, 'Unseen'),
        extra || null);
    }
    const lengthQuery = (r) => {
      const q = {};
      if (['short', 'long'].includes(r.params.get('length'))) q.length = r.params.get('length');
      if (r.params.get('unseen') === '1') q.unseen = '1';
      return q;
    };
    const gridKey = (r) => `${r.sub.join('/')}?${r.params}`;

    // =======================================================================
    // Pages
    // =======================================================================
    function viewExplore(r) {
      const lq = lengthQuery(r);
      return [pageHead('Explore'), grid({
        key: gridKey(r),
        query: { channel: 'main', ...lq },
        tileHref: (s) => link('', { sort: 'new', length: lq.length, focus: s.id }),
        controls: lengthControls(r),
        admin: true,
      })];
    }

    function viewTags(r) {
      const gen = generation;
      const q = h('input', { type: 'search', placeholder: 'Find a tag', 'aria-label': 'Find a tag', value: r.params.get('q') || '' });
      const listEl = h('div', { class: 'tik-tags' }, h('p', { class: 'muted' }, 'Loading ...'));
      let all = [];
      let shown = 60;
      const paint = () => {
        const term = tagOf(q.value).toLowerCase();
        const hits = all.filter((t) => !term || String(t.tag).toLowerCase().includes(term));
        fill(listEl, 
          ...hits.slice(0, shown).map((t) => h('a', { class: 'tik-tagcard', href: tagHref(t.tag) },
            t.coverId ? h('img', { src: coverOf(t.coverId, t.coverV), alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : null,
            h('span', null, h('b', null, `#${t.tag}`), h('small', null, `${num(t.count)} clips`)))),
          hits.length > shown ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { shown += 60; paint(); } }, 'Show more') : null,
          hits.length ? null : h('p', { class: 'muted' }, all.length ? 'No tag matches.' : 'No tags yet.'));
      };
      q.addEventListener('input', () => { shown = 60; paint(); });
      catalogue().then(() => { if (!live(gen)) return; all = S.catalogue.tags || []; paint(); }).catch((e) => { if (live(gen)) fill(listEl, h('p', { class: 'err' }, e.status === 404 ? 'This TikShortis cannot list tags yet (it needs the Grabbit 3.0 update).' : e.message)); });
      return [pageHead('Tags'), h('div', { class: 'tik-controls' }, q), listEl];
    }
    // Tags and creators, shared by Tags, Profiles and Search; kept a minute.
    async function catalogue() {
      if (S.catalogue.tags && S.catalogue.creators && Date.now() - S.catalogue.at < 60000) return S.catalogue;
      const [t, c] = await Promise.allSettled([call('shorts/tags'), call('shorts/creators')]);
      if (t.status === 'rejected' && c.status === 'rejected') throw t.reason;
      S.catalogue = { tags: t.status === 'fulfilled' ? t.value.tags || [] : null, creators: c.status === 'fulfilled' ? c.value.creators || [] : null, at: Date.now() };
      if (t.status === 'rejected') throw t.reason;
      return S.catalogue;
    }

    function viewTag(r) {
      const tag = tagOf(r.sub[1]);
      if (!tag) return [pageHead('Tag'), empty('No such tag.')];
      return [pageHead(`#${tag}`), grid({
        key: gridKey(r),
        query: { channel: 'main', tag },
        tileHref: (s) => link('', { tag, focus: s.id }),
        admin: true,
      })];
    }

    function viewProfiles(r) {
      const gen = generation;
      const q = h('input', { type: 'search', placeholder: 'Find a creator', 'aria-label': 'Find a creator', value: r.params.get('q') || '' });
      const listEl = h('div', { class: 'tik-creators' }, h('p', { class: 'muted' }, 'Loading ...'));
      let all = [];
      const paint = () => {
        const term = q.value.trim().toLowerCase();
        const hits = all.filter((c) => !term || String(c.name).toLowerCase().includes(term) || handleOf(c.name).includes(handleOf(term)));
        fill(listEl, ...hits.slice(0, 400).map(creatorCard), hits.length ? null : h('p', { class: 'muted' }, all.length ? 'No creator matches.' : 'No creators yet.'));
      };
      q.addEventListener('input', paint);
      call('shorts/creators').then((d) => { if (!live(gen)) return; all = d.creators || []; paint(); }).catch((e) => { if (live(gen)) fill(listEl, h('p', { class: 'err' }, e.message)); });
      return [pageHead('Profiles'), h('div', { class: 'tik-controls' }, q), listEl];
    }
    function creatorCard(c) {
      return h('div', { class: 'tik-creator' },
        h('a', { class: 'tik-tile', href: link(`profile/${c.id}`), 'aria-label': `Profile ${c.name}` },
          c.cover_id ? h('img', { src: coverOf(c.cover_id, 'c2'), alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : null),
        h('a', { class: 'tik-creator-name', href: link(`person/${enc(handleOf(c.name))}`) }, `@${c.name}`),
        h('small', { class: 'muted' }, `${num(c.clip_count)} clips`));
    }

    const LINK_KINDS = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', other: 'Link' };
    function viewProfile(r) {
      const gen = generation;
      const id = intOf(r.sub[1]);
      if (!id) return [pageHead('Profile'), empty('No such profile.')];
      if (r.sub[2] === 'candidates') return viewCandidates(r, id);
      const head = h('div', { class: 'tik-profile' }, h('p', { class: 'muted' }, 'Loading ...'));
      const lq = lengthQuery(r);
      call(`shorts/profiles/${id}`).then((d) => {
        if (!live(gen)) return;
        const p = d.profile;
        fill(head, 
          avatar(p.name, p.avatar_key ? p.id : null, p.avatar_checked_at, 88),
          h('div', { class: 'tik-profile-main' },
            h('h1', null, `@${p.name}`),
            h('div', { class: 'tik-stats' }, h('span', null, h('b', null, num(p.clip_count)), ' clips'), h('span', null, h('b', null, num(p.like_count)), ' likes')),
            linksRow(id, d.links || []),
            h('div', { class: 'tik-row-btns' },
              h('a', { class: 'btn small ghost', href: link(`person/${enc(p.handle || handleOf(p.name))}`) }, 'All handles of this person'),
              isAdmin() ? h('a', { class: 'btn small ghost', href: link(`profile/${id}/candidates`) }, 'Source videos') : null)));
      }).catch((e) => {
        if (live(gen)) fill(head, h('p', { class: 'err' }, e.status === 404 ? 'This profile is not in TikShortis.' : e.message));
      });
      return [head, grid({
        key: gridKey(r),
        query: { profile: id, ...lq },
        tileHref: (s) => link('watch', { profile: id, length: lq.length, focus: s.id }),
        controls: lengthControls(r),
        admin: true,
      })];
    }
    function linksRow(pid, links) {
      const box = h('div', { class: 'tik-links' });
      const paint = (list) => {
        fill(box, 
          ...list.map((l) => {
            const href = safeHref(l.url);
            return h('span', { class: 'tik-link' },
              href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, l.label || LINK_KINDS[l.kind] || 'Link') : h('span', null, l.label || l.url),
              isAdmin() && l.id != null ? h('button', { type: 'button', class: 'tik-x small', 'aria-label': 'Remove link', onclick: () => confirmSheet('Remove link', `Remove ${l.url}?`, 'Remove', async () => { const d = await call(`shorts/profiles/${pid}/links/${l.id}`, { method: 'DELETE' }); paint(d.links || []); }) }, ic('close')) : null);
          }),
          isAdmin() ? h('button', { type: 'button', class: 'btn small ghost', onclick: addLink }, 'Add link') : null);
      };
      function addLink() {
        const url = h('input', { type: 'url', placeholder: 'https://', required: true, 'aria-label': 'URL' });
        const label = h('input', { type: 'text', maxlength: '60', placeholder: 'Label (optional)', 'aria-label': 'Label' });
        const sheet = openSheet('Add link', h('form', { class: 'tik-form', onsubmit: async (e) => {
          e.preventDefault();
          try {
            const body = { url: url.value.trim() };
            if (label.value.trim()) body.label = label.value.trim();
            const d = await call(`shorts/profiles/${pid}/links`, { method: 'POST', body });
            paint(d.links || []);
            sheet.close();
          } catch (err) { fail(err); }
        } }, h('label', null, 'URL', url), h('label', null, 'Label', label), h('button', { type: 'submit', class: 'btn' }, 'Add')));
      }
      paint(links);
      return box;
    }
    function viewCandidates(r, id) {
      if (!isAdmin()) return [pageHead('Source videos'), empty('Only an admin can download source videos.')];
      const gen = generation;
      let limit = 40;
      const listEl = h('div', { class: 'tik-cands' }, h('p', { class: 'muted' }, 'Loading ...'));
      const url = h('input', { type: 'url', placeholder: 'Add a video by URL', 'aria-label': 'Video URL' });
      async function load() {
        fill(listEl, h('p', { class: 'muted' }, 'Loading ...'));
        try {
          const d = await call(`shorts/profiles/${id}/candidates?limit=${limit}`);
          if (!live(gen)) return;
          const list = d.candidates || [];
          fill(listEl, ...list.map(row), list.length >= limit && limit < 200 ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { limit = Math.min(200, limit + 40); load(); } }, 'Show more') : null, list.length ? null : h('p', { class: 'muted' }, 'No source videos found.'));
        } catch (e) { if (live(gen)) fill(listEl, h('p', { class: 'err' }, e.message)); }
      }
      function row(c) {
        const thumb = c.thumbnail && safeHref(c.thumbnail) ? `/api/tik/image-proxy?url=${enc(c.thumbnail)}` : null;
        const btn = h('button', { type: 'button', class: 'btn small', disabled: c.downloaded ? true : null }, c.downloaded ? 'Downloaded' : 'Download');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Downloading ...';
          try {
            const d = await call(`shorts/profiles/${id}/candidates`, { method: 'POST', body: { id: c.id, url: c.url, title: c.title } });
            btn.textContent = d.alreadyDownloaded ? 'Already there' : 'Downloaded';
            S.gridCache.clear();
          } catch (e) { btn.disabled = false; btn.textContent = 'Download'; fail(e); }
        });
        return h('div', { class: 'tik-cand' },
          thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : h('span', { class: 'tik-cand-ph' }),
          h('div', null, h('b', null, c.title || c.id), h('small', { class: 'muted' }, [Number.isFinite(c.duration) ? clock(c.duration) : '', Number.isFinite(c.view_count) ? `${num(c.view_count)} views` : ''].filter(Boolean).join(' · '))),
          btn);
      }
      load();
      return [pageHead('Source videos', h('a', { class: 'btn small ghost', href: link(`profile/${id}`) }, 'Back to profile')),
        h('form', { class: 'tik-inline-form', onsubmit: async (e) => {
          e.preventDefault();
          if (!safeHref(url.value.trim())) { say('Enter an http(s) link'); return; }
          try { const d = await call(`shorts/profiles/${id}/candidates`, { method: 'POST', body: { url: url.value.trim() } }); say(d.alreadyDownloaded ? 'Already downloaded' : 'Downloaded'); url.value = ''; S.gridCache.clear(); load(); } catch (err) { fail(err); }
        } }, url, h('button', { type: 'submit', class: 'btn' }, 'Download')),
        listEl];
    }

    function viewPerson(r) {
      const gen = generation;
      const handle = handleOf(r.sub[1]);
      if (!handle) return [pageHead('Person'), empty('No such person.')];
      const also = h('p', { class: 'muted' });
      call(`shorts/people/${enc(handle)}`).then((d) => {
        if (!live(gen)) return;
        const m = (d.person && d.person.members) || [];
        fill(also, m.length ? ['also ', ...m.flatMap((x, i) => [i ? ', ' : '', h('a', { href: link(`person/${enc(x)}`) }, `@${x}`)])] : '');
      }).catch((e) => { if (live(gen)) fill(also, e.status === 404 ? 'Nobody uses this handle.' : ''); });
      const lq = lengthQuery(r);
      return [pageHead(`@${handle}`), also, grid({
        key: gridKey(r),
        query: { channel: 'main', handle, ...lq },
        tileHref: (s) => link('watch', { handle, length: lq.length, focus: s.id }),
        controls: lengthControls(r),
        admin: true,
      })];
    }

    function viewPlaylists() {
      const gen = generation;
      const listEl = h('div', { class: 'tik-playlists' }, h('p', { class: 'muted' }, 'Loading ...'));
      const name = h('input', { type: 'text', maxlength: '120', placeholder: 'New playlist', 'aria-label': 'New playlist name' });
      async function load() {
        try {
          const d = await call('shorts/playlists');
          if (!live(gen)) return;
          const pls = d.playlists || [];
          fill(listEl, ...pls.map(card), pls.length ? null : h('p', { class: 'muted' }, 'No playlists yet. Save a clip from the player, or create one here.'));
        } catch (e) { if (live(gen)) fill(listEl, h('p', { class: 'err' }, e.message)); }
      }
      function card(pl) {
        return h('div', { class: 'tik-creator' },
          h('a', { class: 'tik-tile', href: link(`playlist/${pl.id}`), 'aria-label': pl.name },
            pl.cover_id ? h('img', { src: coverOf(pl.cover_id, 'c2'), alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : null),
          h('a', { class: 'tik-creator-name', href: link(`playlist/${pl.id}`) }, pl.name),
          h('small', { class: 'muted' }, `${num(pl.item_count)} clips`),
          h('div', { class: 'tik-row-btns' },
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => rename(pl) }, 'Rename'),
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => confirmSheet('Delete playlist', `Delete "${pl.name}"? The clips stay in TikShortis.`, 'Delete', async () => { await call(`shorts/playlists/${pl.id}`, { method: 'DELETE' }); load(); }) }, 'Delete')));
      }
      function rename(pl) {
        const input = h('input', { type: 'text', maxlength: '120', value: pl.name, 'aria-label': 'Name' });
        const sheet = openSheet('Rename playlist', h('form', { class: 'tik-form', onsubmit: async (e) => {
          e.preventDefault();
          try { await call(`shorts/playlists/${pl.id}`, { method: 'PATCH', body: { name: input.value.trim() } }); sheet.close(); load(); } catch (err) { fail(err); }
        } }, input, h('button', { type: 'submit', class: 'btn' }, 'Save')));
      }
      load();
      return [pageHead('Playlists'), h('p', { class: 'muted small' }, 'Playlists are private: only you see them.'),
        h('form', { class: 'tik-inline-form', onsubmit: async (e) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          try { await call('shorts/playlists', { method: 'POST', body: { name: name.value.trim() } }); name.value = ''; load(); } catch (err) { fail(err); }
        } }, name, h('button', { type: 'submit', class: 'btn' }, 'Create')),
        listEl];
    }
    function viewPlaylist(r) {
      const gen = generation;
      const id = intOf(r.sub[1]);
      if (!id) return [pageHead('Playlist'), empty('No such playlist.')];
      const title = h('h1', null, 'Playlist');
      call(`shorts/playlists/${id}`).then((d) => { if (live(gen) && d.playlist) title.textContent = d.playlist.name; }).catch((e) => { if (live(gen)) title.textContent = e.status === 404 ? 'Playlist not found' : 'Playlist'; });
      return [h('header', { class: 'tik-head' }, title, h('a', { class: 'btn small ghost', href: link('playlists') }, 'All playlists')), grid({
        key: gridKey(r),
        query: { playlist: id },
        tileHref: (s) => link('watch', { playlist: id, focus: s.id }),
        emptyText: 'This playlist is empty.',
      })];
    }

    function viewSimpleGrid(r, title, query, tileQuery, emptyText) {
      return [pageHead(title), grid({
        key: gridKey(r),
        query: { channel: 'main', ...query },
        tileHref: (s) => link('', { ...tileQuery, focus: s.id }),
        emptyText,
        admin: true,
      })];
    }

    function viewAnalysis() {
      const gen = generation;
      const listEl = h('div', { class: 'tik-analysis' }, h('p', { class: 'muted' }, 'Loading ...'));
      call('shorts/analysis').then((d) => {
        if (!live(gen)) return;
        const items = d.items || [];
        fill(listEl, ...items.map((it) => {
          let tags = [];
          try { tags = JSON.parse(it.ai_summary_tags || '[]'); } catch { tags = []; }
          return h('a', { class: 'tik-an', href: link('', { sort: 'new', focus: it.id }) },
            it.poster_key ? h('img', { src: coverOf(it.id, 'a'), alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : h('span', { class: 'tik-cand-ph' }),
            h('div', null,
              h('b', null, splitCaption(it.caption).title || 'Untitled'),
              h('p', null, it.ai_summary),
              Array.isArray(tags) && tags.length ? h('small', { class: 'muted' }, tags.map((t) => `#${tagOf(t)}`).join(' ')) : null));
        }), items.length ? null : h('p', { class: 'muted' }, 'No clip has an AI description yet.'));
      }).catch((e) => { if (live(gen)) fill(listEl, h('p', { class: 'err' }, e.status === 404 ? 'This TikShortis cannot list analysed clips yet (it needs the Grabbit 3.0 update).' : e.message)); });
      return [pageHead('Analysis'), h('p', { class: 'muted small' }, 'Public clips with an AI description, newest first.'), listEl];
    }

    function viewUpload() {
      let file = null;
      let preview = null;
      let xhr = null;
      const input = h('input', { type: 'file', accept: '*/*', 'aria-label': 'Video file' });
      const pv = h('div', { class: 'tik-upload-pv' });
      const caption = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'Caption, #tags', 'aria-label': 'Caption' });
      const vis = h('select', { 'aria-label': 'Visibility' }, h('option', { value: 'private', selected: true }, 'Private (only you)'), h('option', { value: 'public' }, 'Public'));
      const bar = h('progress', { max: '100', value: '0', hidden: true });
      const send = h('button', { type: 'submit', class: 'btn' }, 'Upload');
      input.addEventListener('change', () => {
        file = input.files && input.files[0];
        if (preview) URL.revokeObjectURL(preview);
        preview = null;
        fill(pv, );
        if (!file) return;
        if (file.size > 1024 ** 3) { say('The file is larger than 1 GB'); file = null; input.value = ''; return; }
        preview = URL.createObjectURL(file);
        pv.append(h('video', { src: preview, controls: true, muted: true, playsinline: true, preload: 'metadata', 'data-media-bg': '1' }), h('small', { class: 'muted' }, `${file.name} · ${hub.bytes(file.size)}`));
      });
      onLeave(() => {
        if (xhr) xhr.abort();
        const v = pv.querySelector('video');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
        if (preview) URL.revokeObjectURL(preview);
      });
      const form = h('form', { class: 'tik-form tik-upload', onsubmit: (e) => {
        e.preventDefault();
        if (!file) { say('Choose a video first'); return; }
        send.disabled = true;
        bar.hidden = false;
        xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/tik/shorts/upload');
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('x-upload-name', enc(file.name));
        xhr.setRequestHeader('x-upload-caption', enc(caption.value.trim()));
        xhr.setRequestHeader('x-upload-channel', 'main');
        xhr.setRequestHeader('x-upload-visibility', vis.value === 'public' ? 'public' : 'private');
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) bar.value = Math.round((ev.loaded / ev.total) * 100); };
        xhr.onload = () => {
          let d = null;
          try { d = JSON.parse(xhr.responseText); } catch { d = null; }
          const ok = xhr.status >= 200 && xhr.status < 300 && d && d.ok;
          xhr = null;
          if (ok) {
            S.gridCache.clear();
            say('Uploaded');
            location.hash = link('mine');
            return;
          }
          send.disabled = false;
          bar.hidden = true;
          say((d && d.error) || 'The upload failed');
        };
        xhr.onerror = () => { xhr = null; send.disabled = false; bar.hidden = true; say('The upload failed'); };
        xhr.send(file);
      } },
      h('label', null, 'Video', input), pv, h('label', null, 'Caption', caption), h('label', null, 'Visibility', vis), bar, send);
      return [pageHead('Upload'), h('p', { class: 'muted small' }, 'MP4 and WebM play at once; other formats wait for the server to convert them.'), form];
    }

    function viewSearch(r) {
      const gen = generation;
      const term = String(r.params.get('q') || '').trim();
      const input = h('input', { type: 'search', value: term, placeholder: 'Search tags and creators', 'aria-label': 'Search tags and creators' });
      const out = h('div', null, h('p', { class: 'muted' }, 'Loading ...'));
      const paint = () => {
        const t = input.value.trim().toLowerCase().replace(/^[#@]/, '');
        const cat = S.catalogue;
        const tags = (cat.tags || []).filter((x) => t && String(x.tag).toLowerCase().includes(t)).slice(0, 60);
        const creators = (cat.creators || []).filter((x) => t && (String(x.name).toLowerCase().includes(t) || handleOf(x.name).includes(handleOf(t)))).slice(0, 60);
        fill(out, 
          !t ? h('p', { class: 'muted' }, 'Type part of a tag or a creator name.') : null,
          t ? h('h2', { class: 'section' }, `Creators (${creators.length})`) : null,
          t ? h('div', { class: 'tik-creators' }, creators.map(creatorCard)) : null,
          t ? h('h2', { class: 'section' }, `Tags (${tags.length})`) : null,
          t ? h('div', { class: 'tik-taglist' }, tags.map((x) => h('a', { class: 'tik-pill', href: tagHref(x.tag) }, `#${x.tag} · ${num(x.count)}`))) : null,
          h('p', { class: 'muted small' }, 'Clip titles are not searchable yet: TikShortis has no search API.'));
      };
      input.addEventListener('input', () => {
        paint();
        hub.replaceHash(link('search', { q: input.value.trim() }));
      });
      catalogue().then(() => { if (live(gen)) paint(); }).catch(() => { if (live(gen)) paint(); });
      setTimeout(() => input.focus(), 0);
      return [pageHead('Search'), h('div', { class: 'tik-controls' }, input), out];
    }

    // The mobile "Library" tab: every section that is not For You or Explore.
    function viewLibrary() {
      const item = (href, title, sub) => h('a', { class: 'tik-libitem', href }, h('b', null, title), sub ? h('small', { class: 'muted' }, sub) : null);
      return [pageHead('Library'), h('div', { class: 'tik-lib' },
        item(link('playlists'), 'Playlists', 'Your private collections'),
        item(link('liked'), 'Liked', 'Clips you liked'),
        item(link('history'), 'History', 'What you watched'),
        item(link('mine'), 'My uploads', 'Public and private'),
        item(link('tags'), 'Tags', 'Every hashtag'),
        item(link('profiles'), 'Profiles', 'Creators'),
        item(link('analysis'), 'Analysis', 'AI descriptions'),
        item(link('settings'), 'Settings', 'Playback and tools'),
        item(link('account'), 'Account', me() ? `Linked as ${me().handle || me().email}` : 'Link your TikShortis account'))];
    }

    // --- Account linking ----------------------------------------------------
    function viewAccount() {
      const s = S.session || {};
      if (s.linked) {
        const u = s.user;
        return [pageHead('Account'),
          h('section', { class: 'card' },
            u ? h('ul', { class: 'rows' },
              h('li', null, 'Name', h('span', { class: 'v' }, u.displayName || u.username || '')),
              h('li', null, 'Handle', h('span', { class: 'v' }, u.handle ? `@${u.handle}` : '')),
              h('li', null, 'Email', h('span', { class: 'v' }, u.email || '')),
              h('li', null, 'Role', h('span', { class: 'v' }, u.role || 'user')))
              : h('p', { class: 'muted' }, 'Linked, but this TikShortis cannot say who you are (it needs the Grabbit 3.0 update).'),
            h('p', { class: 'muted small' }, 'Grabbit keeps only the TikShortis session, sealed in a cookie for this site. Your password is not stored.'),
            h('button', { type: 'button', class: 'btn ghost', onclick: () => confirmSheet('Unlink TikShortis', 'Sign this browser out of TikShortis? Your TikShortis data stays as it is.', 'Unlink', async () => {
              const r = await fetch('/api/tik/session', { method: 'DELETE', credentials: 'same-origin' });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              S.session = undefined;
              S.gridCache.clear();
              S.catalogue = { tags: null, creators: null, at: 0 };
              await loadSession(true);
            }) }, 'Unlink this browser'))];
      }
      const email = h('input', { type: 'email', autocomplete: 'username', required: true, maxlength: '320', 'aria-label': 'TikShortis email' });
      const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: '1024', 'aria-label': 'TikShortis password' });
      const msg = h('p', { class: 'err', hidden: true });
      const send = h('button', { type: 'submit', class: 'btn' }, 'Link account');
      const form = h('form', { class: 'tik-form tik-link', onsubmit: async (e) => {
        e.preventDefault();
        send.disabled = true;
        msg.hidden = true;
        try {
          const r = await fetch('/api/tik/session', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ email: email.value.trim(), password: pass.value }),
          });
          const d = await r.json().catch(() => null);
          if (r.status === 401 && !(d && d.error)) { location.href = '/login'; return; }
          if (!r.ok || !d || !d.ok) {
            const wait = r.headers.get('retry-after');
            throw new Error(r.status === 429 ? `Too many attempts. Try again${wait ? ` in ${wait} s` : ' later'}.` : (d && d.error) || `HTTP ${r.status}`);
          }
          pass.value = '';
          S.session = undefined;
          await loadSession(true);
          if (location.hash.startsWith(`${BASE}/account`)) location.hash = BASE;
        } catch (err) {
          msg.textContent = err.message;
          msg.hidden = false;
          send.disabled = false;
        }
      } },
      h('label', null, 'Email', email), h('label', null, 'Password', pass), msg, send);
      return [pageHead('Link TikShortis'),
        h('section', { class: 'card tik-link-card' },
          h('p', null, 'Sign in with your TikShortis account once to watch, like, comment and upload here.'),
          h('p', { class: 'muted small' }, 'Grabbit sends the password to TikShortis and keeps only the session it gets back, in a cookie for this site. Accounts are never matched by name.'),
          s.expired ? h('p', { class: 'err' }, 'Your TikShortis session ended. Sign in again.') : null,
          form)];
    }

    // --- Settings -----------------------------------------------------------
    const TABS = [
      { key: 'playback', label: 'Playback', show: () => true },
      { key: 'sources', label: 'Sources', show: isAdmin },
      { key: 'import', label: 'Import', show: canTools },
      { key: 'duplicates', label: 'Duplicates', show: canTools },
      { key: 'cleaning', label: 'Cleaning', show: canTools },
      { key: 'titles', label: 'Titles', show: isAdmin },
      { key: 'reports', label: 'Reports', show: isAdmin },
    ];
    function viewSettings(r) {
      const tabs = TABS.filter((t) => t.show());
      const cur = tabs.find((t) => t.key === r.params.get('tab')) || tabs[0];
      const body = {
        playback: settingsPlayback, sources: settingsSources, import: settingsImport, duplicates: settingsDuplicates,
        cleaning: settingsCleaning, titles: settingsTitles, reports: settingsReports,
      }[cur.key]();
      return [pageHead('Settings'),
        h('nav', { class: 'tik-tabs-row', 'aria-label': 'Settings sections' }, tabs.map((t) => h('a', { class: 'tik-pill', href: link('settings', { tab: t.key === 'playback' ? null : t.key }), 'aria-current': t === cur ? 'page' : null }, t.label))),
        body];
    }
    // Polls a background job's state while the page is open.
    function poll(fn, ms) {
      const gen = generation;
      let t = null;
      const tick = async () => {
        if (!live(gen)) return;
        let again = false;
        try { again = await fn(); } catch { again = false; }
        if (again && live(gen)) t = setTimeout(tick, ms);
      };
      onLeave(() => clearTimeout(t));
      tick();
    }
    const errRow = (e) => h('p', { class: 'err' }, e.message || String(e));
    function settingsPlayback() {
      const gen = generation;
      const start = soundStart();
      const sel = h('select', { 'aria-label': 'Sound when a clip starts' },
        [['muted', 'Muted'], ['on', 'Sound on'], ['last', 'As I last left it']].map(([v, l]) => h('option', { value: v, selected: v === start }, l)));
      sel.addEventListener('change', () => { store.set(KEYS.soundStart, sel.value); S.muted = initialMuted(); say('Saved'); });
      const auto = h('input', { type: 'checkbox', checked: S.autoScroll });
      auto.addEventListener('change', () => { S.autoScroll = auto.checked; store.set(KEYS.autoScroll, S.autoScroll ? '1' : null); });
      const hidden = h('span', { class: 'v' }, '...');
      const clear = h('button', { type: 'button', class: 'btn small ghost' }, 'Show them all again');
      clear.addEventListener('click', async () => {
        try { const d = await call('shorts/hidden', { method: 'DELETE' }); hidden.textContent = '0'; say(`${num(d.cleared)} clips back in your feed`); } catch (e) { fail(e); }
      });
      call('shorts/hidden').then((d) => { if (live(gen)) hidden.textContent = num(d.count); }).catch(() => { if (live(gen)) hidden.textContent = '?'; });
      return h('section', { class: 'card' },
        h('label', { class: 'tik-field' }, 'Sound when a clip starts', sel),
        h('label', { class: 'tik-check' }, auto, h('span', null, 'Auto-scroll: go to the next clip when one ends')),
        h('ul', { class: 'rows' }, h('li', null, 'Clips marked "Not interested"', hidden)),
        clear);
    }
    function settingsSources() {
      const gen = generation;
      const listEl = h('div', null, h('p', { class: 'muted' }, 'Loading ...'));
      const src = h('input', { type: 'url', placeholder: 'Profile or channel URL', required: true, 'aria-label': 'Source URL' });
      const name = h('input', { type: 'text', placeholder: 'Name (optional)', maxlength: '120', 'aria-label': 'Name' });
      const type = h('select', { 'aria-label': 'Source type' }, h('option', { value: 'yt-dlp' }, 'yt-dlp'), h('option', { value: 'rss' }, 'RSS'));
      const limit = h('input', { type: 'number', min: '1', max: '100', value: '20', 'aria-label': 'Videos per poll' });
      const auto = h('input', { type: 'checkbox', checked: true });
      let refreshUntil = 0;
      async function load() {
        try {
          const d = await call('shorts/profiles');
          if (!live(gen)) return false;
          const rows = d.profiles || [];
          fill(listEl, rows.length ? h('table', { class: 'tik-table' },
            h('thead', null, h('tr', null, h('th', null, 'Profile'), h('th', null, 'Source'), h('th', { class: 'num' }, 'Clips'), h('th', null, 'Last poll'), h('th', null, 'Auto'), h('th', null, ''))),
            h('tbody', null, rows.map((p) => {
              const toggle = h('input', { type: 'checkbox', checked: !!p.auto_poll, 'aria-label': `Auto-poll ${p.name}`, disabled: p.source_type === 'manual' ? true : null });
              toggle.addEventListener('change', async () => { try { await call(`shorts/profiles/${p.id}`, { method: 'PATCH', body: { auto_poll: toggle.checked } }); } catch (e) { toggle.checked = !toggle.checked; fail(e); } });
              const href = safeHref(p.source_ref);
              return h('tr', null,
                h('td', null, h('a', { href: link(`profile/${p.id}`) }, p.name)),
                h('td', { class: 'small' }, p.source_type, ' ', href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'link') : null),
                h('td', { class: 'num' }, num(p.clip_count)),
                h('td', { class: 'small' }, p.last_polled_at ? when(p.last_polled_at) : 'never'),
                h('td', null, toggle),
                h('td', { class: 'tik-row-btns' },
                  p.source_type !== 'manual' ? h('button', { type: 'button', class: 'btn small ghost', onclick: async () => { try { await call(`shorts/profiles/${p.id}/poll`, { method: 'POST' }); say('Polling'); refreshUntil = Date.now() + 60000; poll(load, 4000); } catch (e) { fail(e); } } }, 'Poll now') : null,
                  h('button', { type: 'button', class: 'btn small ghost', onclick: () => confirmSheet('Delete source', `Delete the profile "${p.name}"? Its clips stay, without a profile.`, 'Delete', async () => { await call(`shorts/profiles/${p.id}`, { method: 'DELETE' }); load(); }) }, 'Delete')));
            }))) : h('p', { class: 'muted' }, 'No sources yet.'));
          return Date.now() < refreshUntil;
        } catch (e) { if (live(gen)) fill(listEl, errRow(e)); return false; }
      }
      const form = h('form', { class: 'tik-form', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const body = { source_ref: src.value.trim(), source_type: type.value, videos_limit: Math.max(1, Math.min(100, Number(limit.value) || 20)), auto_poll: auto.checked, channel: 'main' };
          if (name.value.trim()) body.name = name.value.trim();
          const d = await call('shorts/profiles', { method: 'POST', body });
          say(d.reused ? 'That profile already exists' : 'Added; the first poll is running');
          src.value = '';
          name.value = '';
          refreshUntil = Date.now() + 60000;
          poll(load, 4000);
        } catch (err) { fail(err); }
      } }, h('h2', null, 'Add a source'), h('label', null, 'URL', src), h('label', null, 'Name', name), h('label', null, 'Type', type), h('label', null, 'Videos per poll', limit), h('label', { class: 'tik-check' }, auto, h('span', null, 'Poll automatically')), h('button', { type: 'submit', class: 'btn' }, 'Add source'));
      load();
      return [h('section', { class: 'card' }, h('h2', null, 'Sources'), listEl), h('section', { class: 'card' }, form), mergeCard()];
    }
    function mergeCard() {
      const gen = generation;
      const box = h('div', null, h('p', { class: 'muted' }, 'Loading ...'));
      call('admin/shorts/profiles?channel=main').then((d) => {
        if (!live(gen)) return;
        const rows = d.profiles || [];
        const primary = h('select', { 'aria-label': 'Keep this profile' }, rows.map((p) => h('option', { value: String(p.id) }, `${p.name} (${num(p.clips)})`)));
        const filter = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter profiles to merge' });
        const checks = rows.map((p) => ({ p, box: h('input', { type: 'checkbox', value: String(p.id) }) }));
        const listEl = h('div', { class: 'tik-merge-list' });
        const paint = () => {
          const t = filter.value.trim().toLowerCase();
          fill(listEl, ...checks.filter(({ p }) => !t || p.name.toLowerCase().includes(t)).slice(0, 300).map(({ p, box: b }) => h('label', { class: 'tik-check' }, b, h('span', null, p.name), h('small', { class: 'muted' }, `${num(p.clips)} clips`))));
        };
        filter.addEventListener('input', paint);
        paint();
        fill(box, 
          h('label', { class: 'tik-field' }, 'Keep', primary), filter, listEl,
          h('button', { type: 'button', class: 'btn', onclick: () => {
            const primaryId = Number(primary.value);
            const mergeIds = checks.filter((c) => c.box.checked).map((c) => c.p.id).filter((x) => x !== primaryId);
            if (!mergeIds.length) { say('Tick the profiles to merge into it'); return; }
            confirmSheet('Merge profiles', `Merge ${mergeIds.length} profile(s) into "${primary.selectedOptions[0].textContent}"? Their clips move to it.`, 'Merge', async () => {
              const d = await call('admin/shorts/merge-profiles', { method: 'POST', body: { primaryId, mergeIds } });
              say(`Merged ${num(d.merged)}; ${num(d.reassigned)} clips moved`);
              S.gridCache.clear();
              hub.rerender();
            });
          } }, 'Merge'));
      }).catch((e) => { if (live(gen)) fill(box, errRow(e)); });
      return h('section', { class: 'card' }, h('h2', null, 'Merge profiles'), h('p', { class: 'muted small' }, 'One person with several profiles: keep one and move the others into it.'), box);
    }
    function settingsImport() {
      const out = h('div');
      return h('section', { class: 'card' },
        h('p', null, 'Clips dropped into TikShortis\' import folder are filed automatically. Grabbit saves there when you pick "Tikshortis (shorts)" as the destination.'),
        isAdmin() ? h('button', { type: 'button', class: 'btn', onclick: async (e) => {
          e.currentTarget.disabled = true;
          fill(out, 'Importing ...');
          try {
            const d = await call('shorts/import', { method: 'POST' });
            fill(out, h('p', null, `Imported ${num(d.imported)}, new profiles ${num(d.profilesNew)}, skipped ${num(d.skipped)}.`));
            S.gridCache.clear();
          } catch (err) { fill(out, errRow(err)); }
          e.currentTarget.disabled = false;
        } }, 'Import now') : h('p', { class: 'muted small' }, 'Only an admin can start an import by hand.'),
        out);
    }
    function settingsDuplicates() {
      const stateEl = h('p', { class: 'muted' }, 'Loading ...');
      const groupsEl = h('div', { class: 'tik-dupes' });
      const scan = h('button', { type: 'button', class: 'btn' }, 'Scan for duplicates');
      async function load() {
        const d = await call('shorts/duplicates?channel=main');
        const st = d.state || {};
        stateEl.textContent = st.status === 'running' ? `Scanning ... ${num(st.scanned)} clips so far` : st.finished_at ? `Last scan ${when(st.finished_at)}: ${num(st.groups)} groups. ${st.message || ''}` : 'Never scanned.';
        scan.disabled = st.status === 'running';
        const groups = d.groups || [];
        fill(groupsEl, ...groups.map(group), groups.length ? null : h('p', { class: 'muted' }, 'No duplicates found.'));
        return st.status === 'running';
      }
      function group(g) {
        const members = g.members || [];
        const extras = members.filter((m) => !m.is_best).map((m) => m.short_id);
        return h('div', { class: 'tik-dupe' },
          h('small', { class: 'muted' }, g.match_type === 'exact' ? 'Exact copies' : 'Look alike'),
          h('div', { class: 'tik-dupe-row' }, members.map((m) => h('a', { class: `tik-dupe-m${m.is_best ? ' best' : ''}`, href: link('', { sort: 'new', focus: m.short_id }) },
            m.poster_key ? h('img', { src: coverOf(m.short_id, 'd'), alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : h('span', { class: 'tik-cand-ph' }),
            h('small', null, m.is_best ? 'Keep · ' : '', [m.width && m.height ? `${m.width}x${m.height}` : '', Number.isFinite(m.duration) ? clock(m.duration) : '', m.size_bytes ? hub.bytes(m.size_bytes) : ''].filter(Boolean).join(' · ')),
            h('small', { class: 'muted' }, m.profile_name ? `@${m.profile_name}` : '')))),
          h('div', { class: 'tik-row-btns' },
            h('button', { type: 'button', class: 'btn small ghost', onclick: async () => { try { await call('shorts/duplicates', { method: 'POST', body: { shortIds: members.map((m) => m.short_id) } }); poll(load, 3000); } catch (e) { fail(e); } } }, 'Not duplicates'),
            extras.length ? h('button', { type: 'button', class: 'btn small danger', onclick: () => confirmSheet('Delete copies', `Delete ${extras.length} copy(ies) and keep the best one?`, 'Delete', async () => { const d = await call('shorts/duplicates/resolve', { method: 'POST', body: { shortIds: extras } }); say(`Deleted ${num(d.deleted)}`); S.gridCache.clear(); poll(load, 3000); }) }, 'Delete the copies') : null));
      }
      scan.addEventListener('click', async () => { try { await call('shorts/duplicates/scan', { method: 'POST' }); poll(load, 3000); } catch (e) { fail(e); } });
      poll(() => load().catch((e) => { fill(stateEl, errRow(e)); return false; }), 3000);
      return h('section', { class: 'card' }, stateEl, scan, groupsEl);
    }
    function settingsCleaning() {
      const gen = generation;
      const box = h('div', null, h('p', { class: 'muted' }, 'Loading ...'));
      async function load() {
        try {
          const d = await call('shorts/maintenance?channel=main');
          if (!live(gen)) return;
          const orphans = d.orphans || [];
          const pls = d.emptyPlaylists || [];
          fill(box, 
            h('h2', null, `Clips whose file is missing (${orphans.length})`),
            orphans.length ? h('ul', { class: 'rows' }, orphans.slice(0, 200).map((o) => h('li', null, splitCaption(o.caption).title || `#${o.id}`, h('span', { class: 'v small' }, o.profile_name || '')))) : h('p', { class: 'muted' }, 'None.'),
            orphans.length ? h('button', { type: 'button', class: 'btn small danger', onclick: () => confirmSheet('Remove missing clips', `Remove ${orphans.length} clip(s) whose file is gone?`, 'Remove', async () => { const r = await call('shorts/maintenance?channel=main', { method: 'POST', body: { action: 'orphans' } }); say(`Removed ${num(r.deleted)}`); load(); }) }, 'Remove them') : null,
            h('h2', null, `Empty playlists (${pls.length})`),
            pls.length ? h('ul', { class: 'rows' }, pls.slice(0, 200).map((p) => h('li', null, p.name, h('span', { class: 'v small' }, p.owner_name || '')))) : h('p', { class: 'muted' }, 'None.'),
            pls.length && isAdmin() ? h('button', { type: 'button', class: 'btn small danger', onclick: () => confirmSheet('Remove empty playlists', `Remove ${pls.length} empty playlist(s), including other people's?`, 'Remove', async () => { const r = await call('shorts/maintenance', { method: 'POST', body: { action: 'playlists' } }); say(`Removed ${num(r.deleted)}`); load(); }) }, 'Remove them') : null);
        } catch (e) { if (live(gen)) fill(box, errRow(e)); }
      }
      load();
      return h('section', { class: 'card' }, box);
    }
    function settingsTitles() {
      const job = (title, what, note) => {
        const st = h('p', { class: 'muted' }, 'Loading ...');
        const btn = h('button', { type: 'button', class: 'btn' }, 'Start');
        async function load() {
          const d = await call(`shorts/${what}`);
          const s = d.state || {};
          st.textContent = s.status === 'running' ? `Running ... ${num(s.processed)} of ${num(s.total)}, ${num(s.updated)} updated` : s.finished_at ? `Last run ${when(s.finished_at)}: ${num(s.updated)} updated. ${s.message || ''}` : 'Never run.';
          btn.disabled = s.status === 'running';
          return s.status === 'running';
        }
        btn.addEventListener('click', async () => { try { await call(`shorts/${what}/scan?channel=main`, { method: 'POST' }); poll(load, 3000); } catch (e) { fail(e); } });
        poll(() => load().catch((e) => { fill(st, errRow(e)); return false; }), 3000);
        return h('section', { class: 'card' }, h('h2', null, title), h('p', { class: 'muted small' }, note), st, btn);
      };
      return [
        job('Fetch titles', 'titles', 'Asks each clip\'s source for its title, for clips that have none.'),
        job('Fill in captions', 'captions', 'Reads captions and tags from the source pages through Grabbit.'),
      ];
    }
    function settingsReports() {
      const gen = generation;
      const box = h('div', null, h('p', { class: 'muted' }, 'Loading ...'));
      const REASON = { broken: 'Does not play', wrong_creator: 'Wrong creator or title', duplicate: 'Duplicate', inappropriate: 'Inappropriate', other: 'Other' };
      async function load() {
        try {
          const d = await call('admin/shorts/reports');
          if (!live(gen)) return;
          const items = d.items || [];
          fill(box, ...items.map((it) => h('div', { class: 'tik-report' },
            h('a', { href: link('', { sort: 'new', focus: it.id }) }, it.has_poster ? h('img', { src: coverOf(it.id, it.poster_v), alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : h('span', { class: 'tik-cand-ph' })),
            h('div', null,
              h('b', null, splitCaption(it.caption).title || `Clip ${it.id}`),
              h('small', { class: 'muted' }, ` ${it.profile_name ? `@${it.profile_name}` : it.uploader_name || ''} · ${num(it.report_count)} report(s)`),
              h('ul', null, (it.reports || []).map((rep) => h('li', null, `${REASON[rep.reason] || rep.reason}${rep.note ? `: ${rep.note}` : ''}`, h('small', { class: 'muted' }, ` ${rep.reporter || ''} ${when(rep.created_at)}`)))),
              h('div', { class: 'tik-row-btns' },
                h('button', { type: 'button', class: 'btn small ghost', onclick: async () => { try { await call('admin/shorts/reports', { method: 'POST', body: { shortId: it.id, action: 'dismiss' } }); load(); } catch (e) { fail(e); } } }, 'Dismiss'),
                h('button', { type: 'button', class: 'btn small danger', onclick: () => confirmSheet('Delete clip', 'Delete the reported clip? Its files are removed.', 'Delete', async () => { await call(`shorts/${it.id}`, { method: 'DELETE' }); await call('admin/shorts/reports', { method: 'POST', body: { shortId: it.id, action: 'dismiss' } }); S.gridCache.clear(); load(); }) }, 'Delete clip'))))),
          items.length ? null : h('p', { class: 'muted' }, 'No open reports.'));
        } catch (e) { if (live(gen)) fill(box, errRow(e)); }
      }
      load();
      return h('section', { class: 'card' }, box);
    }

    // =======================================================================
    // Shell: sections, bottom bar, the hub's hooks
    // =======================================================================
    const SECTIONS = [
      { sub: '', label: 'For You', test: (r) => !r.sub.length && !r.params.get('sort') && !r.params.get('tag') },
      { sub: '', q: { sort: 'following' }, label: 'Following', test: (r) => !r.sub.length && r.params.get('sort') === 'following' },
      { sub: 'explore', label: 'Explore' },
      { sub: 'tags', label: 'Tags', also: ['tag'] },
      { sub: 'profiles', label: 'Profiles', also: ['profile', 'person'] },
      { sub: 'playlists', label: 'Playlists', also: ['playlist'] },
      { sub: 'liked', label: 'Liked' },
      { sub: 'history', label: 'History' },
      { sub: 'mine', label: 'My uploads' },
      { sub: 'upload', label: 'Upload' },
      { sub: 'analysis', label: 'Analysis' },
      { sub: 'settings', label: 'Settings', also: ['account'] },
    ];
    function sectionCurrent(sec, r) {
      if (sec.test) return sec.test(r);
      return r.sub[0] === sec.sub || (sec.also || []).includes(r.sub[0]);
    }
    function subnav(r) {
      if (!S.session || !S.session.linked) return [{ href: link('account'), label: 'Link account', current: true }];
      return SECTIONS.map((sec) => ({ href: link(sec.sub, sec.q), label: sec.label, current: sectionCurrent(sec, r) }));
    }
    function tabBar(r) {
      const first = r.sub[0] || '';
      const libSubs = ['library', 'playlists', 'playlist', 'liked', 'history', 'mine', 'tags', 'tag', 'profiles', 'profile', 'person', 'analysis', 'settings', 'account', 'search'];
      const tab = (href, label, name, cur, extra) => h('a', { href, class: extra || null, 'aria-current': cur ? 'page' : null }, extra === 'plus' ? h('span', { class: 'tik-plus' }, ic(name)) : ic(name), h('span', null, label));
      return h('nav', { class: 'tik-tabbar', 'aria-label': 'TikShortis' },
        tab(link(''), 'For You', 'home', !first || first === 'watch'),
        tab(link('explore'), 'Explore', 'compass', first === 'explore'),
        tab(link('upload'), 'Upload', 'plus', first === 'upload', 'plus'),
        tab(link('library'), 'Library', 'lib', libSubs.includes(first)),
        h('button', { type: 'button', onclick: hub.openMenu, 'aria-label': 'Open the Grabbit menu' }, ic('menu'), h('span', null, 'Menu')));
    }
    // A 2.2 link (#/tikshortis?path=/explore) opens the same native page.
    function fromLegacyPath(raw) {
      let u;
      try { u = new URL(String(raw || '/'), 'https://x.invalid'); } catch { return BASE; }
      if (u.origin !== 'https://x.invalid') return BASE;
      const seg = u.pathname.split('/').filter(Boolean);
      const q = Object.fromEntries(u.searchParams);
      const known = new Set(['explore', 'tags', 'tag', 'profiles', 'profile', 'person', 'playlists', 'history', 'mine', 'upload', 'settings', 'analysis']);
      if (!seg.length) return link('', { focus: intOf(q.focus), sort: q.sort, tag: q.tag, length: q.length });
      if (seg[0] === 'playlists' && seg[1]) return seg[2] === 'watch' ? link('watch', { playlist: intOf(seg[1]), focus: intOf(q.focus) }) : link(`playlist/${enc(seg[1])}`);
      if ((seg[0] === 'profile' || seg[0] === 'person') && seg[2] === 'watch') {
        return link('watch', seg[0] === 'profile' ? { profile: intOf(seg[1]), focus: intOf(q.focus) } : { handle: seg[1], focus: intOf(q.focus) });
      }
      if (known.has(seg[0])) return link(seg.slice(0, 3).map(enc).join('/'), q.tab ? { tab: q.tab } : null);
      return BASE;
    }

    function view(r) {
      if (!r.sub.length && r.params.has('path')) {
        hub.replaceHash(fromLegacyPath(r.params.get('path')));
        r = hub.route();
      }
      const first = r.sub[0] || '';
      let body;
      let feed = false;
      if (S.session === undefined) {
        if (S.sessionError) {
          body = [pageHead('TikShortis'), empty(`TikShortis is not reachable: ${S.sessionError}`, h('button', { type: 'button', class: 'btn', onclick: () => { S.sessionError = null; loadSession(true); hub.rerender(); } }, 'Try again'))];
        } else {
          loadSession();
          body = [pageHead('TikShortis'), h('p', { class: 'muted' }, 'Loading ...')];
        }
      } else if (!S.session.linked || first === 'account') {
        body = viewAccount(r);
      } else {
        switch (first) {
          case '': feed = true; body = viewFeed(r, false); break;
          case 'watch': feed = true; body = viewFeed(r, true); break;
          case 'explore': body = viewExplore(r); break;
          case 'tags': body = viewTags(r); break;
          case 'tag': body = viewTag(r); break;
          case 'profiles': body = viewProfiles(r); break;
          case 'profile': body = viewProfile(r); break;
          case 'person': body = viewPerson(r); break;
          case 'playlists': body = viewPlaylists(r); break;
          case 'playlist': body = viewPlaylist(r); break;
          case 'liked': body = viewSimpleGrid(r, 'Liked', { sort: 'liked' }, { sort: 'liked' }, 'You have not liked any clip yet.'); break;
          case 'history': body = viewSimpleGrid(r, 'History', { sort: 'history' }, { sort: 'new' }, 'Nothing watched yet.'); break;
          case 'mine': body = viewSimpleGrid(r, 'My uploads', { mine: '1' }, { sort: 'new' }, 'You have not uploaded anything yet.'); break;
          case 'upload': body = viewUpload(r); break;
          case 'analysis': body = viewAnalysis(r); break;
          case 'search': body = viewSearch(r); break;
          case 'library': body = viewLibrary(r); break;
          case 'settings': body = viewSettings(r); break;
          default: body = [pageHead('TikShortis'), empty('This page does not exist.', h('a', { class: 'btn', href: BASE }, 'Go to For You'))];
        }
      }
      const banner = S.session && S.session.linked && S.session.outdated
        ? h('p', { class: 'tik-banner' }, 'This TikShortis is older than Grabbit 3.0: some pages (tags, profiles, analysis) need its update.')
        : null;
      return h('div', { class: `tik-root${feed ? ' is-feed' : ''}` }, banner, body, tabBar(r));
    }

    return { view, leave, subnav };
  }
})();
