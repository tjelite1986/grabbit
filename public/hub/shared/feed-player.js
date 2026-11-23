'use strict';
// Grabbit 3.0 Adshortis phase 2: the vertical clip player shared by the hub's
// native modules (moved out of public/hub/tik/tik.js viewFeed without a change
// in look or behaviour).
//
// The core owns what every clip feed does the same way: the vertical swipe,
// one playing video with NEAR sources around it, sound (start, last, forced
// mute), auto-scroll and the clean display, fullscreen and the immersive
// page, the keyboard and its guard, the timeline and the tap gestures,
// paging mechanics, and tearing all of it down on leave.
//
// The product (the module that opens it) owns its data and its words: it
// loads pages, builds each card's rail and caption, acts on a clip, fills the
// sheets, and says what to keep in the address and in storage. Data reaches
// the core only through the callbacks in opts; storage only through the store
// and the key names the product passes in. No API path and no product key
// lives in this file.
//
// GrabbitShared.feedPlayer(opts) returns the player handle P (P.root is the
// element to mount). opts:
//   h, icon(name, size, stroke, cls)    the hub's element and icon helpers
//   sheets                              the shared sheet stack (count, whenClosed)
//   store, storeKeys { soundLast, autoScroll, chrome, resume }
//   prefs { muted, speed, autoScroll, chromeHidden }  the product's live
//                                       settings object; the core changes it
//   side { toggle(), isOpen() }, closeMenu()  the hub's menu hooks
//   onLeave(fn)                         the product's leave hook (P2-ONCE)
//   start { cursor, prev, restoreFocus }
//   load({ cursor } | { after })        -> Promise<{ items, nextCursor }>; items carry an integer id
//   selector({ btn, menu, item })       paints the top-centre feed selector, or
//   back                                an element shown there instead
//   empty()                             nodes for an empty feed
//   card(c, P)                          -> { label, top: [], bottom: [] } the product's
//                                       part of a card; paintSound(c) repaints its sound button
//   videoSrc(item), poster(item)
//   onDoubleTap(c), onLongPress(c), onActive(c), resumeEntry(c) -> object | null,
//   onFirstPage(), onRestoreMiss(), onWatched(c, ms, completed), onTabHidden()
//   keys { [key]: fn(c) }               product keys (plain letters)
//   ownHistory, onClose()               see "History" below
// Optional (Adshortis phase 3):
//   ahead                               load the next page this many cards
//                                       from the end (default 3)
//   errorText(err, more) -> string      the words for a failed page (first
//                                       page: more false); default the core's
//   retryDelay(err) -> ms | null        wait before the next try (Retry-After)
//   end() -> nodes                      shown on the last card once the list
//                                       has no more pages
//   onVideoError(c)                     the active clip's video failed
//   videoSrc(item) may return null: the card shows its poster only.
(() => {
  const shared = (window.GrabbitShared = window.GrabbitShared || {});

  const NEAR = 2; // cards around the active one that keep their video source
  const SEEK_SECONDS = 10;
  // The core's own root carries this marker, so its own dialogs never count
  // as a foreign modal (hub viewers carry .viewer, so that class cannot be
  // the test).
  const ROOT_ATTR = 'data-feed-player';
  // Sheets and overlays of every hub module; .dm-overlay-cmp has no dialog
  // role, so the classes are named.
  const SHEET_MARKERS = '.tik-sheet, .sg-sheet-panel, .dm-overlay';

  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  function clock(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '';
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function foreignModalOpen() {
    if (document.querySelector(SHEET_MARKERS)) return true;
    for (const d of document.querySelectorAll('[role=dialog][aria-modal=true]')) {
      if (!d.closest(`[${ROOT_ATTR}]`)) return true;
    }
    return false;
  }
  // The one key guard (H29): true when the player must leave the key alone.
  function keyBlocked(e, sheetCount) {
    if (e.metaKey || e.ctrlKey || e.altKey) return true;
    const at = (sel) => !!(e.target && e.target.closest && e.target.closest(sel));
    if (at('input, textarea, select, [contenteditable]')) return true;
    // Space and the arrows belong to a focused control (a button, the feed
    // selector), not to the player.
    if ((e.key === ' ' || String(e.key).startsWith('Arrow')) && at('button, a[href], [role=menu], [role=listbox]')) return true;
    return sheetCount > 0 || foreignModalOpen();
  }
  shared.playerKeyBlocked = keyBlocked;

  shared.feedPlayer = function feedPlayer(opts) {
    const { h, icon: lu, sheets: SH, store, storeKeys: KEYS, prefs: S, onLeave } = opts;
    const start = opts.start || {};
    const AHEAD = Number.isInteger(opts.ahead) && opts.ahead > 0 ? opts.ahead : 3;
    let alive = true; // false once the product's page is left
    // Every pending timer of this player (tap, long press, hints, bursts,
    // offers, auto-advance): leave cancels them all, so nothing fires into a
    // page that is gone (phase-2 E7 MINOR).
    const timers = new Set();
    const later = (fn, ms) => {
      const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms);
      timers.add(t);
      return t;
    };
    const cancel = (t) => { if (t) { clearTimeout(t); timers.delete(t); } };
    onLeave(() => { for (const t of timers) clearTimeout(t); timers.clear(); });

    const F = {
      token: 0, // bumps when the feed is reset in place: late pages are dropped
      items: [],
      cards: [],
      ids: new Set(),
      cursor: start.cursor ?? null,
      hasMore: true,
      loading: false,
      errors: 0,
      retryAt: 0,
      prev: start.prev ?? null,
      hasPrev: start.prev != null,
      loadingPrev: false,
      active: -1,
      soundBlocked: false,
      fullscreen: false,
      firstPage: true,
      // The clip to start on when a saved place is continued.
      restoreFocus: start.restoreFocus ?? null,
    };
    document.body.classList.add('tik-feed');

    const scroller = h('div', { class: 'tf-scroll', tabindex: '-1' });
    const status = h('div', { class: 'tf-status' });
    const topSentinel = h('div', { class: 'tf-sentinel tf-sentinel-top', 'aria-hidden': 'true' });
    const bottomSentinel = h('div', { class: 'tf-sentinel', 'aria-hidden': 'true' });
    scroller.append(topSentinel, bottomSentinel);

    // ---- Sound ----
    function setMuted(m) {
      S.muted = m;
      F.soundBlocked = false;
      store.set(KEYS.soundLast, m ? 'muted' : 'on');
      if (opts.paintSound) for (const c of F.cards) opts.paintSound(c);
      const c = F.cards[F.active];
      if (c) c.video.muted = m;
    }
    // The browser refused sound before the first touch: the next touch that
    // is not a sound button ([data-sound-toggle]) brings the wanted sound back.
    const unblock = (e) => {
      if (!F.soundBlocked || (e.target.closest && e.target.closest('[data-sound-toggle]'))) return;
      F.soundBlocked = false;
      const c = F.cards[F.active];
      if (c && !S.muted) { c.video.muted = false; }
    };
    document.addEventListener('pointerdown', unblock, true);
    onLeave(() => document.removeEventListener('pointerdown', unblock, true));

    // ---- Top left: the Grabbit menu (Grabbit's own control) ----
    const sideBtn = h('button', { type: 'button', class: 'tf-cbtn tf-side', onclick: () => opts.side.toggle() });
    function paintSide() {
      const open = opts.side.isOpen();
      fill(sideBtn, lu(open ? 'panelLeftClose' : 'panelLeft', 18));
      sideBtn.setAttribute('aria-label', open ? 'Hide the Grabbit menu' : 'Show the Grabbit menu');
      sideBtn.setAttribute('aria-expanded', String(open));
    }
    paintSide();
    window.addEventListener('grabbit:side', paintSide);
    onLeave(() => window.removeEventListener('grabbit:side', paintSide));

    // ---- Top centre: the feed selector, or the product's way back ----
    const menus = []; // open-state closers for Escape and outside clicks
    let modeBox;
    let paintSelector = () => {};
    if (opts.selector) {
      const btn = h('button', { type: 'button', class: 'tf-pill tf-mode-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
      const menu = h('div', { class: 'tf-mode-menu', role: 'menu', hidden: true });
      modeBox = h('div', { class: 'tf-modebox' }, btn, menu);
      const setOpen = (v) => {
        // Closing with the focus inside: hand it back to the button, never
        // leave it on a hidden item.
        const inside = !v && menu.contains(document.activeElement);
        menu.hidden = !v;
        btn.setAttribute('aria-expanded', String(v));
        modeBox.classList.toggle('open', v);
        if (inside) btn.focus({ preventScroll: true });
      };
      // Up and Down move between the items, as in any menu.
      menu.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...menu.querySelectorAll('[role=menuitemradio]')];
        const i = items.indexOf(document.activeElement);
        const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
        if (next) next.focus();
      });
      menus.push(() => { if (!menu.hidden) { setOpen(false); return true; } return false; });
      btn.addEventListener('click', () => setOpen(menu.hidden));
      const item = (label, cur, pick) => h('button', { type: 'button', class: 'tf-mode-item', role: 'menuitemradio', 'aria-checked': String(cur), onclick: () => { setOpen(false); pick(); } }, label);
      paintSelector = () => opts.selector({ btn, menu, item });
      paintSelector();
    } else {
      modeBox = h('div', { class: 'tf-modebox' }, opts.back);
    }

    // ---- Top right: the view controls, collapsed to one chevron ----
    let ctlOpen = false;
    const ctlToggle = h('button', { type: 'button', class: 'tf-cbtn', onclick: () => { ctlOpen = !ctlOpen; paintCtl(); } });
    const fsBtn = h('button', { type: 'button', class: 'tf-cbtn', onclick: () => toggleFullscreen() });
    const chromeBtn = h('button', { type: 'button', class: 'tf-cbtn', onclick: () => toggleChrome() });
    const autoBtn = h('button', { type: 'button', class: 'tf-cbtn', onclick: () => toggleAutoScroll() });
    const ctlBox = h('div', { class: 'tf-ctl' }, ctlToggle, fsBtn, chromeBtn, autoBtn);
    function paintCtl() {
      fill(ctlToggle, lu(ctlOpen ? 'chevronsUp' : 'chevronsDown', 18));
      ctlToggle.setAttribute('aria-label', ctlOpen ? 'Collapse controls' : 'Expand controls');
      ctlToggle.setAttribute('aria-expanded', String(ctlOpen));
      fsBtn.hidden = chromeBtn.hidden = autoBtn.hidden = !ctlOpen;
      fill(fsBtn, lu(F.fullscreen ? 'minimize' : 'maximize', 18));
      fsBtn.setAttribute('aria-label', F.fullscreen ? 'Exit fullscreen' : 'Fullscreen');
      fill(chromeBtn, lu(S.chromeHidden ? 'eyeOff' : 'eye', 18));
      chromeBtn.setAttribute('aria-label', S.chromeHidden ? 'Show overlay' : 'Clear display');
      fill(autoBtn, lu('chevronsDown', 18));
      autoBtn.classList.toggle('on', S.autoScroll);
      autoBtn.setAttribute('aria-label', 'Auto-scroll');
      autoBtn.setAttribute('aria-pressed', String(S.autoScroll));
    }
    paintCtl();

    const resumeBox = h('div', { class: 'tf-resume', hidden: true });
    const hintEl = h('div', { class: 'tf-hint', hidden: true, role: 'status' }, 'Long-press a clip for the menu');
    const root = h('div', { class: `tf${S.chromeHidden ? ' clean' : ''}`, [ROOT_ATTR]: '' }, scroller, status, sideBtn, modeBox, ctlBox, resumeBox, hintEl);

    const onDocDown = (e) => {
      if (modeBox.contains(e.target)) return;
      for (const close of menus) close();
    };
    document.addEventListener('pointerdown', onDocDown, true);
    onLeave(() => document.removeEventListener('pointerdown', onDocDown, true));

    // ---- View toggles ----
    let hintTimer = 0;
    function toggleChrome() {
      S.chromeHidden = !S.chromeHidden;
      store.set(KEYS.chrome, S.chromeHidden ? '1' : null);
      root.classList.toggle('clean', S.chromeHidden);
      if (S.chromeHidden) {
        hintEl.hidden = false;
        cancel(hintTimer);
        hintTimer = later(() => { hintEl.hidden = true; }, 2500);
      }
      paintCtl();
    }
    function toggleAutoScroll() {
      S.autoScroll = !S.autoScroll;
      store.set(KEYS.autoScroll, S.autoScroll ? '1' : null);
      for (const x of F.cards) x.video.loop = !S.autoScroll;
      paintCtl();
    }
    function setSpeed(r) {
      S.speed = r;
      const cur = F.cards[F.active];
      if (cur) { cur.video.defaultPlaybackRate = r; cur.video.playbackRate = r; }
    }
    // Fullscreen is the whole document, as in TikShortis: the sheets, menus
    // and toasts are children of <body>, and a fullscreen element only shows
    // what sits inside it. The page itself hides the Grabbit menu, the top
    // bar and the bottom bar (body.tik-immersive, read by the hub's side
    // logic) and puts them back as they were on the way out.
    function setImmersive(on) {
      F.fullscreen = on;
      document.body.classList.toggle('tik-immersive', on);
      if (on) opts.closeMenu();
      paintCtl();
      window.dispatchEvent(new Event('grabbit:side'));
    }
    function toggleFullscreen() {
      const de = document.documentElement;
      if (!F.fullscreen) {
        setImmersive(true);
        // Best effort: iPhone Safari has no element fullscreen; the page
        // still fills the screen without the browser's own bars hidden.
        const req = de.requestFullscreen || de.webkitRequestFullscreen;
        if (req) { try { const pr = req.call(de); if (pr && pr.catch) pr.catch(() => {}); } catch { /* not allowed */ } }
      } else {
        setImmersive(false);
        const el = document.fullscreenElement || document.webkitFullscreenElement;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (el && exit) { try { const pr = exit.call(document); if (pr && pr.catch) pr.catch(() => {}); } catch { /* ignore */ } }
      }
    }
    // Leaving fullscreen through the browser (Esc, the Back gesture) ends the
    // immersive view too.
    const onFs = () => { if (!(document.fullscreenElement || document.webkitFullscreenElement) && F.fullscreen) setImmersive(false); };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);

    // ---- Loading pages ----
    const current = (tok) => alive && tok === F.token;
    const fresh = (d) => (d.items || []).filter((s) => s && Number.isInteger(s.id) && !F.ids.has(s.id));
    async function loadMore() {
      if (F.loading || !F.hasMore || Date.now() < F.retryAt) return;
      const tok = F.token;
      const pageAt = F.cursor;
      F.loading = true;
      paintStatus();
      try {
        const d = await opts.load({ cursor: pageAt });
        if (!current(tok)) return;
        F.errors = 0;
        let items = fresh(d);
        if (F.restoreFocus !== null) {
          // Continuing a saved place: start on the clip the viewer was on
          // (the ones before it on that page were already watched). A saved
          // order that no longer reaches that far starts over.
          const at = items.findIndex((s) => s.id === F.restoreFocus);
          F.restoreFocus = null;
          if (!items.length && !F.cards.length) { opts.onRestoreMiss(); return; }
          if (at > 0) items = items.slice(at);
        }
        for (const s of items) addCard(s, false, pageAt);
        F.cursor = d.nextCursor;
        F.hasMore = d.nextCursor !== null && d.nextCursor !== undefined;
        if (F.active < 0 && F.cards.length) {
          pickActive();
          if (F.firstPage && opts.onFirstPage) opts.onFirstPage();
          F.firstPage = false;
          // The top sentinel was already in view before the first page came,
          // so its observer will not fire again: ask once here.
          loadPrev();
        }
      } catch (e) {
        if (!current(tok)) return;
        F.errors++;
        const wait = opts.retryDelay ? opts.retryDelay(e) : null;
        F.retryAt = Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : Math.min(30000, 2 ** F.errors * 1000));
        F.lastError = e;
      } finally {
        if (current(tok)) { F.loading = false; paintStatus(); }
      }
    }
    // Items above the top one, after a deep link (orders paged by id; the
    // product passes start.prev only for those).
    async function loadPrev() {
      if (F.loadingPrev || !F.hasPrev || F.prev === null || !F.cards.length) return;
      const tok = F.token;
      F.loadingPrev = true;
      try {
        const d = await opts.load({ after: F.prev });
        if (!current(tok)) return;
        const firstCard = F.cards[0];
        const delta = firstCard.el.offsetTop - scroller.scrollTop;
        for (const s of fresh(d).reverse()) addCard(s, true);
        F.prev = d.nextCursor;
        F.hasPrev = d.nextCursor !== null && d.nextCursor !== undefined;
        // Keep the clip on screen exactly where it was.
        scroller.scrollTop = firstCard.el.offsetTop - delta;
        pickActive();
      } catch {
        if (current(tok)) F.hasPrev = false;
      } finally {
        if (current(tok)) F.loadingPrev = false;
      }
    }
    const errorText = (more) => (opts.errorText && F.lastError ? opts.errorText(F.lastError, more) : null) || (more ? 'Could not load more.' : 'Could not load the feed.');
    // A retry the viewer asks for still waits out a Retry-After.
    const retryNow = () => { if (Date.now() >= F.retryAt || !opts.retryDelay) F.retryAt = 0; loadMore(); };
    function paintStatus() {
      if (F.cards.length) {
        // The current clip keeps playing; the row sits over the last card.
        const atEnd = !F.hasMore && !F.loading && opts.end && F.active === F.cards.length - 1;
        status.hidden = !(F.loading || (F.errors && F.hasMore) || atEnd);
        status.classList.add('more');
        if (F.loading) fill(status, h('span', { class: 'tf-spin', 'aria-label': 'Loading' }));
        else if (F.errors && F.hasMore) fill(status, h('span', { role: 'status' }, `${errorText(true)} `, h('button', { type: 'button', class: 'linkish', onclick: retryNow }, 'Try again')));
        else if (atEnd) fill(status, h('div', { class: 'tf-end', role: 'status' }, opts.end()));
        return;
      }
      status.hidden = false;
      status.classList.remove('more');
      if (F.loading) fill(status, h('span', { class: 'tf-spin', 'aria-label': 'Loading' }));
      else if (F.errors) fill(status, h('p', { role: 'status' }, errorText(false)), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => { F.errors = 0; retryNow(); } }, 'Try again'));
      else fill(status, opts.empty());
    }
    // A new order in place: no navigation, so fullscreen and the sheets'
    // history entry survive. prepare() is the product's: it changes its
    // query and replaces the address.
    function reload(prepare) {
      F.token++;
      const c = F.cards[F.active];
      if (c) deactivate(c);
      for (const x of F.cards) { unload(x); activeObserver.unobserve(x.el); x.el.remove(); }
      Object.assign(F, { items: [], cards: [], ids: new Set(), cursor: null, hasMore: true, loading: false, errors: 0, retryAt: 0, prev: null, hasPrev: false, loadingPrev: false, active: -1, restoreFocus: null });
      if (prepare) prepare();
      resumeBox.hidden = true;
      scroller.scrollTop = 0;
      paintSelector();
      paintStatus();
      loadMore();
    }

    // ---- Cards ----
    function addCard(s, atTop, pageAt) {
      F.ids.add(s.id);
      const c = buildCard(s);
      // The offset cursor of the page the item came in (offset-paged
      // orders), so a saved place can load that page again.
      c.pageAt = Number.isInteger(pageAt) ? pageAt : null;
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
      const c = { s, maxTime: 0, lastTime: 0, completed: false, scrubbing: false, wantPlay: false };

      // Overlays in the middle of the clip.
      c.burst = h('span', { class: 'tf-burst', hidden: true, 'aria-hidden': 'true' }, lu('heart', 96));
      c.seekHint = h('div', { class: 'tf-seekhint', hidden: true, 'aria-hidden': 'true' });
      c.playIcon = h('span', { class: 'tf-paused', hidden: true, 'aria-hidden': 'true' }, h('span', null, lu('play', 40)));

      // Timeline: drag anywhere on the strip; the time shows while dragging.
      c.tlFill = h('div', { class: 'tf-tl-fill' });
      c.tlKnob = h('div', { class: 'tf-tl-knob' });
      c.tlBar = h('div', { class: 'tf-tl-bar' }, c.tlFill, c.tlKnob);
      c.tlTime = h('div', { class: 'tf-tl-time', hidden: true });
      c.timeline = h('div', { class: 'tf-tl', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, c.tlTime, c.tlBar);
      attachTimeline(c);

      // The product's part: what sits over the clip (top) and the rail and
      // caption (bottom).
      const body = opts.card(c, P);
      const video = h('video', {
        class: 'tf-video',
        playsinline: true,
        'webkit-playsinline': true,
        preload: 'none',
        loop: !S.autoScroll,
        poster: opts.poster(s),
        'data-media-bg': '1',
        'aria-label': body.label || 'Clip',
      });
      video.muted = true;
      c.video = video;

      c.el = h('section', { class: 'tf-card', 'data-id': String(s.id) },
        video, ...(body.top || []), c.burst, c.seekHint, c.playIcon,
        h('div', { class: 'tf-scrim', 'aria-hidden': 'true' }), c.timeline, ...(body.bottom || []));

      video.addEventListener('timeupdate', () => {
        const t = video.currentTime;
        const d = video.duration;
        if (t > c.maxTime) c.maxTime = t;
        if (Number.isFinite(d) && d > 0) {
          if (t >= d * 0.95) c.completed = true;
          // A loop wrap from near the end counts as watched through.
          if (c.lastTime >= d * 0.9 && t < c.lastTime - 1) c.completed = true;
          if (!c.scrubbing) paintProgress(c, t / d);
        }
        c.lastTime = t;
      });
      video.addEventListener('ended', () => {
        c.completed = true;
        // Not under an open sheet: the sheet's Back entry would then point at
        // the clip before.
        if (S.autoScroll && F.cards[F.active] === c) { if (SH.count()) c.advanceOnClose = true; else step(1); }
      });
      video.addEventListener('play', () => { c.playIcon.hidden = true; });
      // An unloaded card (removed src) fires no error; only a real failure of
      // the clip on screen reaches the product (a lost sign-in, H17).
      video.addEventListener('error', () => {
        if (alive && video.getAttribute('src') && F.cards[F.active] === c && opts.onVideoError) opts.onVideoError(c);
      });
      video.addEventListener('pause', () => { c.playIcon.hidden = F.cards[F.active] !== c; });
      attachGestures(c);
      return c;
    }
    function paintProgress(c, frac) {
      const pct = Math.max(0, Math.min(1, frac || 0)) * 100;
      c.tlFill.style.width = `${pct}%`;
      c.tlKnob.style.left = `${pct}%`;
      c.timeline.setAttribute('aria-valuenow', String(Math.round(pct)));
      const d = c.video.duration;
      if (Number.isFinite(d) && d > 0) c.timeline.setAttribute('aria-valuetext', `${clock((pct / 100) * d)} of ${clock(d)}`);
      if (c.scrubbing && Number.isFinite(d) && d > 0) c.tlTime.textContent = `${clock((pct / 100) * d)} / ${clock(d)}`;
    }
    function attachTimeline(c) {
      const tl = c.timeline;
      const seekTo = (clientX) => {
        const v = c.video;
        const d = v.duration;
        const rect = c.tlBar.getBoundingClientRect();
        const frac = rect.width ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
        if (Number.isFinite(d) && d > 0) v.currentTime = frac * d;
        paintProgress(c, frac);
      };
      const end = (e) => {
        if (!c.scrubbing) return;
        c.scrubbing = false;
        tl.classList.remove('scrub');
        c.tlTime.hidden = true;
        if (e) e.stopPropagation();
      };
      tl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        c.scrubbing = true;
        tl.classList.add('scrub');
        c.tlTime.hidden = !(Number.isFinite(c.video.duration) && c.video.duration > 0);
        try { tl.setPointerCapture(e.pointerId); } catch { /* old browser */ }
        seekTo(e.clientX);
      });
      tl.addEventListener('pointermove', (e) => { if (c.scrubbing) { e.stopPropagation(); seekTo(e.clientX); } });
      tl.addEventListener('pointerup', end);
      tl.addEventListener('pointercancel', end);
      // Keyboard: Left and Right step five seconds.
      tl.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        // Focus can stay here while an overlay opens above the player.
        if (e.metaKey || e.ctrlKey || e.altKey || SH.count() || foreignModalOpen()) return;
        e.preventDefault();
        e.stopPropagation();
        const v = c.video;
        if (!(Number.isFinite(v.duration) && v.duration > 0)) return;
        v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
        paintProgress(c, v.currentTime / v.duration);
      });
    }

    // ---- Gestures: tap, double tap, long press ----
    function attachGestures(c) {
      let tapTimer = null;
      let lastTap = 0;
      let press = null;
      let long = false;
      let startAt = null;
      const onControl = (e) => !!(e.target.closest && e.target.closest('a, button, input, .tf-info, .tf-tl, .tf-rail, .tf-ai'));
      c.el.addEventListener('pointerdown', (e) => {
        if (onControl(e) || e.button > 0) return;
        startAt = { x: e.clientX, y: e.clientY };
        long = false;
        press = later(() => { press = null; long = true; }, 550);
      });
      c.el.addEventListener('pointermove', (e) => {
        if (!startAt) return;
        if (Math.abs(e.clientX - startAt.x) > 10 || Math.abs(e.clientY - startAt.y) > 10) { cancel(press); press = null; startAt = null; }
      });
      c.el.addEventListener('pointercancel', () => { cancel(press); press = null; startAt = null; });
      c.el.addEventListener('contextmenu', (e) => { if (!onControl(e)) e.preventDefault(); });
      c.el.addEventListener('pointerup', (e) => {
        if (!startAt) return;
        startAt = null;
        cancel(press);
        press = null;
        // The player menu opens on release, as in TikShortis.
        if (long) { long = false; opts.onLongPress(c); return; }
        const rect = c.el.getBoundingClientRect();
        const x = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
        const now = Date.now();
        if (tapTimer && now - lastTap < 260) {
          cancel(tapTimer);
          tapTimer = null;
          // Outer thirds seek, the middle is the product's (a like).
          if (x > 0.65) skip(c, SEEK_SECONDS);
          else if (x < 0.35) skip(c, -SEEK_SECONDS);
          else opts.onDoubleTap(c);
          return;
        }
        lastTap = now;
        tapTimer = later(() => { tapTimer = null; togglePlay(c); }, 220);
      });
    }
    function skip(c, by) {
      const v = c.video;
      const d = Number.isFinite(v.duration) ? v.duration : Infinity;
      v.currentTime = Math.max(0, Math.min(d - 0.1, v.currentTime + by));
      fill(c.seekHint, lu(by > 0 ? 'fastForward' : 'rewind', 28), h('span', null, `${by > 0 ? '+' : '-'}${Math.abs(by)}s`));
      c.seekHint.classList.toggle('fwd', by > 0);
      c.seekHint.classList.toggle('back', by < 0);
      c.seekHint.hidden = false;
      cancel(c.seekTimer);
      c.seekTimer = later(() => { c.seekHint.hidden = true; }, 600);
    }
    function togglePlay(c) {
      if (F.cards[F.active] !== c) return;
      if (c.video.paused) play(c); else { c.wantPlay = false; c.video.pause(); }
    }
    function heartBurst(c) {
      c.burst.hidden = false;
      c.burst.classList.remove('go');
      void c.burst.offsetWidth;
      c.burst.classList.add('go');
      cancel(c.burstTimer);
      c.burstTimer = later(() => { c.burst.hidden = true; c.burst.classList.remove('go'); }, 700);
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
    // The sidebar opening or closing, fullscreen and a rotation change the
    // feed's size: keep the current clip snapped in place.
    let lastHeight = 0;
    const resizeObserver = new ResizeObserver(() => {
      const hgt = scroller.clientHeight;
      if (hgt === lastHeight) return;
      lastHeight = hgt;
      const c = F.cards[F.active];
      if (c) scroller.scrollTop = c.el.offsetTop;
    });
    resizeObserver.observe(scroller);
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
      if (F.suspended || (i === F.active && !force)) return;
      const old = F.cards[F.active];
      if (old && old !== F.cards[i]) deactivate(old);
      F.active = i;
      F.cards.forEach((c, j) => {
        if (Math.abs(j - i) <= NEAR) {
          c.video.preload = j === i || j === i + 1 ? 'auto' : 'metadata';
          if (!c.video.getAttribute('src')) setSrc(c);
        } else unload(c);
      });
      const c = F.cards[i];
      if (!c) return;
      play(c);
      for (const x of F.cards) x.playIcon.hidden = true;
      // The product keeps the current item in the address (a reload or Back
      // lands here) and says what to save as the place to resume.
      if (opts.onActive) opts.onActive(c);
      const saved = opts.resumeEntry ? opts.resumeEntry(c) : null;
      if (saved) store.set(KEYS.resume, JSON.stringify(saved));
      if (i >= F.cards.length - AHEAD) loadMore();
      paintStatus();
    }
    // The product may have no source for an item (not ready): poster only.
    function setSrc(c) {
      const src = F.suspended ? null : opts.videoSrc(c.s);
      if (src) c.video.src = src;
      return !!src;
    }
    function play(c) {
      const v = c.video;
      if (!v.getAttribute('src') && !setSrc(c)) return;
      v.muted = S.muted;
      v.defaultPlaybackRate = S.speed;
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
      if (opts.onWatched) opts.onWatched(c, c.maxTime * 1000, c.completed);
      c.maxTime = 0;
      c.lastTime = 0;
      c.completed = false;
      c.playIcon.hidden = true;
      paintProgress(c, 0);
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
    // A product edit changed the item: draw its card again in place, keeping
    // the playing position.
    function rebuild(oldC) {
      const i = F.cards.indexOf(oldC);
      if (i < 0) return;
      const freshC = buildCard(oldC.s);
      const wasActive = i === F.active;
      const t = oldC.video.currentTime;
      activeObserver.unobserve(oldC.el);
      deactivate(oldC);
      unload(oldC);
      oldC.el.replaceWith(freshC.el);
      F.cards[i] = freshC;
      activeObserver.observe(freshC.el);
      if (wasActive) {
        setSrc(freshC);
        freshC.video.addEventListener('loadedmetadata', () => { try { freshC.video.currentTime = t; } catch { /* ignore */ } }, { once: true });
        play(freshC);
      }
    }

    // Move to an item already in the list (a clip-only address change).
    // False when it is not loaded; the product decides what to do then.
    function goTo(id) {
      const i = F.cards.findIndex((c) => String(c.s.id) === String(id));
      if (i < 0) return false;
      if (i !== F.active) F.cards[i].el.scrollIntoView({ block: 'start' });
      return true;
    }
    // A lost sign-in (H17): every media element lets go of its source; the
    // list, the cursor and the current item stay. resume() plays on.
    function suspend() {
      if (F.suspended) return;
      const c = F.cards[F.active];
      if (c) { c.wantPlay = false; c.video.pause(); c.resumeAt = c.video.currentTime || 0; }
      F.suspended = true;
      for (const x of F.cards) unload(x);
    }
    function resume() {
      if (!F.suspended || !alive) return;
      F.suspended = false;
      const c = F.cards[F.active];
      const at = c ? c.resumeAt : 0;
      if (c && at > 0) c.video.addEventListener('loadedmetadata', () => { try { c.video.currentTime = at; } catch { /* ignore */ } }, { once: true });
      if (F.active >= 0) setActive(F.active, true);
      if (F.errors) { F.retryAt = 0; loadMore(); }
      else if (!F.cards.length) loadMore();
    }

    // ---- Keyboard ----
    const extraKeys = opts.keys || {};
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Escape belongs to an overlay that is still open above the player
        // (a sheet whose stack did not consume it, or a foreign modal).
        if (SH.count() || foreignModalOpen()) return;
        // An open feed selector closes first.
        for (const close of menus) if (close()) { e.preventDefault(); return; }
        // No browser fullscreen to leave (refused or unsupported): Escape
        // ends the page's own immersive view. Not when the same key just
        // closed a sheet (the stack's handler runs first, prevents the
        // default and stops the key).
        if (F.fullscreen && !e.defaultPrevented && !SH.count() && !(document.fullscreenElement || document.webkitFullscreenElement)) { e.preventDefault(); toggleFullscreen(); return; }
      }
      if (keyBlocked(e, SH.count())) return;
      const c = F.cards[F.active];
      const k = e.key;
      if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') { e.preventDefault(); step(1); }
      else if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') { e.preventDefault(); step(-1); }
      else if (k === ' ' && c) { e.preventDefault(); togglePlay(c); }
      else if (k === 'm') setMuted(!S.muted);
      else if (k === 'f') toggleFullscreen();
      else if (c && Object.prototype.hasOwnProperty.call(extraKeys, k)) extraKeys[k](c);
    };
    document.addEventListener('keydown', onKey);
    // A clip that ended under a sheet moves on once the sheet is closed.
    let advanceTimer = 0;
    const onSheetsClosed = () => {
      const c = F.cards[F.active];
      if (!c || !c.advanceOnClose) return;
      c.advanceOnClose = false;
      // After the stack has taken the sheet's history entry back off (a
      // setTimeout 0 plus the async history.back()); stepping sooner would
      // write the next clip's address into that entry. A sheet opened in the
      // meantime (menu -> Report) waits for its own close.
      cancel(advanceTimer);
      advanceTimer = later(() => {
        if (!alive || !S.autoScroll || F.cards[F.active] !== c || !c.video.ended) return;
        if (SH.count()) c.advanceOnClose = true; else step(1);
      }, 150);
    };
    SH.whenClosed.add(onSheetsClosed);
    onLeave(() => SH.whenClosed.delete(onSheetsClosed));

    // ---- Pause when the tab is hidden; resume what was playing ----
    const onVis = () => {
      const c = F.cards[F.active];
      if (!c) return;
      if (document.hidden) { if (opts.onTabHidden) opts.onTabHidden(); if (!c.video.paused) { c.resumeOnShow = true; c.video.pause(); } }
      else if (c.resumeOnShow) { c.resumeOnShow = false; play(c); }
    };
    document.addEventListener('visibilitychange', onVis);

    // ---- The resume / reshuffle offer under the top bar ----
    let offerTimer = 0;
    function offer(node) {
      fill(resumeBox, node);
      resumeBox.hidden = false;
      cancel(offerTimer);
      offerTimer = later(() => { resumeBox.hidden = true; }, 15000);
    }

    // ---- History ----
    // The core never relies on the hub's a.tile click hook for a history
    // entry. A route-owned player (opts.ownHistory false: a feed page is a
    // hash route) leaves history to the route. A player the product opens
    // with a tap over another page (opts.ownHistory true) pushes its own
    // entry, closes with history.back(), and calls opts.onClose() once.
    //
    // M6-HIST (phase-2 E7 MAJOR): the entry carries this instance's token, so
    //   - a sheet's entry above it (it copies the state) popping back onto
    //     ours is not a close: Back closes the sheet first, then the player;
    //   - any other entry (an older player's stale token included) means our
    //     entry is gone: close, once;
    //   - close() is idempotent: a second call (a double tap, Escape while
    //     the Back is still on its way) does nothing;
    //   - the entry is pushed only inside a user activation (Chrome skips
    //     entries pushed without one, and Back would leave the app).
    const token = `fp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let pushed = false;
    let closing = false;
    let closed = false;
    const ours = () => !!(history.state && history.state.feedPlayer === token);
    function finish() {
      if (closed) return;
      closed = true;
      if (opts.onClose) opts.onClose();
    }
    if (opts.ownHistory) {
      const ua = navigator.userActivation;
      if (!ua || ua.isActive) {
        history.pushState({ ...(history.state || {}), feedPlayer: token }, '');
        pushed = true;
      }
      const onPop = () => {
        if (!pushed || closed || ours()) return;
        pushed = false;
        finish();
      };
      window.addEventListener('popstate', onPop);
      onLeave(() => window.removeEventListener('popstate', onPop));
    }
    function close() {
      if (closed || closing) return;
      if (pushed && ours()) {
        closing = true;
        // A sheet's entry still on top: step over it too (the sheet stack
        // closes its sheets on the same popstate).
        history.go(history.state.tikSheet ? -2 : -1);
      } else {
        pushed = false;
        finish();
      }
    }

    // ---- Leaving the page stops everything ----
    onLeave(() => {
      alive = false;
      F.token++;
      activeObserver.disconnect();
      edgeObserver.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      const c = F.cards[F.active];
      if (c) deactivate(c);
      for (const x of F.cards) unload(x);
      F.cards = [];
      document.body.classList.remove('tik-feed', 'tik-immersive');
    });

    const P = {
      root,
      get cards() { return F.cards; },
      get items() { return F.items; },
      get fullscreen() { return F.fullscreen; },
      setMuted,
      setSpeed,
      toggleChrome,
      toggleAutoScroll,
      toggleFullscreen,
      removeCard,
      reinsert,
      rebuild,
      burst: heartBurst,
      reload,
      offer,
      hideOffer: () => { resumeBox.hidden = true; },
      close,
      goTo,
      suspend,
      resume,
      get activeItem() { return F.cards[F.active] ? F.cards[F.active].s : null; },
    };

    paintStatus();
    loadMore();
    return P;
  };
})();
