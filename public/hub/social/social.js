'use strict';
// Grabbit 3.0 phase 2: Social & Photos, drawn by the hub over Elitogram
// (EGRAM_MODE=native).
//
// Every request goes to Grabbit's gateway at /api/egram/*, which forwards an
// allowlisted set of Elitogram routes with the viewer's linked Elitogram
// session and an audience scope. This file never talks to Elitogram directly.
//
// Audience: every page shows general material only. The Review lane is the one
// exception: it asks the gateway for unclassified material (lane=review), says
// so on every screen, and exists to classify it. 18+ is never reachable here.
//
// Loaded before hub.js. It registers itself in window.GrabbitModules; hub.js
// calls create() once with its helpers and routes #/social/<section> here,
// calling leave() before it replaces the view.
(() => {
  const registry = (window.GrabbitModules = window.GrabbitModules || []);
  registry.push({ id: 'social', create });

  function create(hub) {
    const { h, num, ago } = hub;
    // replaceChildren() prints null as "null": drop gaps the way h() does.
    const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    const enc = encodeURIComponent;
    const intOf = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

    // --- Icons (stroke paths, 24 px grid) ------------------------------------
    const PATHS = {
      heart: 'M12 21s-8-5.3-8-11a5 5 0 0 1 8-3.9A5 5 0 0 1 20 10c0 5.7-8 11-8 11z',
      bookmark: 'M6 3h12v18l-6-4-6 4z',
      folder: 'M3 6h6l2 2h10v11H3z',
      download: 'M12 3v12m0 0-5-5m5 5 5-5M4 19h16',
      external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
      prev: 'M15 5l-7 7 7 7',
      next: 'M9 5l7 7-7 7',
      close: 'M6 6l12 12M18 6 6 18',
      play: 'M8 5v14l11-7z',
      stack: 'M8 8h12v12H8zM4 16V4h12',
      check: 'M5 12l5 5 9-10',
      plus: 'M12 5v14M5 12h14',
      grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
      list: 'M4 6h16M4 12h16M4 18h16',
    };
    function ic(name, size = 20) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('style', `width:${size}px;height:${size}px`);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', PATHS[name] || PATHS.play);
      svg.append(p);
      return svg;
    }

    // --- Addresses -----------------------------------------------------------
    const BASE = '#/social';
    function link(path, query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query || {})) if (v !== null && v !== undefined && v !== '' && v !== false) q.set(k, String(v));
      const qs = q.toString();
      return `${BASE}${path ? `/${path}` : ''}${qs ? `?${qs}` : ''}`;
    }
    // Media addresses are built from numeric ids only, never from a string
    // Elitogram sent, so nothing upstream can steer a src or an href.
    const laneQ = (lane, extra) => {
      const q = new URLSearchParams(extra || {});
      if (lane === 'review') q.set('lane', 'review');
      const s = q.toString();
      return s ? `?${s}` : '';
    };
    const mediaUrl = (id, lane, extra) => `/api/egram/m/${Number(id)}${laneQ(lane, extra)}`;
    const thumbUrl = (id, lane, w) => `/api/egram/m/${Number(id)}/t${laneQ(lane, w ? { w } : null)}`;
    function avatarUrl(path, lane) {
      const m = /^\/m\/(ca|ua)\/(\d{1,12})$/.exec(String(path || ''));
      return m ? `/api/egram/m/${m[1]}/${m[2]}${laneQ(lane)}` : null;
    }
    const safeHttps = (u) => {
      try {
        const x = new URL(String(u || ''));
        return x.protocol === 'https:' ? x.href : null;
      } catch {
        return null;
      }
    };

    // --- Module state ----------------------------------------------------------
    const S = {
      session: undefined, // { linked, user } once loaded
      sessionError: null,
      loading: null,
    };
    const me = () => (S.session && S.session.user) || null;
    const canClassify = () => !!(me() && me().can_classify);

    let cleanups = [];
    const onLeave = (fn) => { cleanups.push(fn); };
    let generation = 0;
    const live = (gen) => gen === generation;
    function leave() {
      generation++;
      const list = cleanups;
      cleanups = [];
      for (const fn of list.reverse()) {
        try { fn(); } catch (e) { console.warn('social: cleanup failed', e); }
      }
      closeViewer();
      closeSheet();
    }

    // --- API -------------------------------------------------------------------
    class SocialError extends Error {
      constructor(msg, status) { super(msg); this.status = status; }
    }
    async function call(path, { method = 'GET', body, lane } = {}) {
      const opts = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
      if (body !== undefined) {
        opts.headers['content-type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const sep = path.includes('?') ? '&' : '?';
      const url = `/api/egram/api/${path}${lane === 'review' ? `${sep}lane=review` : ''}`;
      let r;
      try { r = await fetch(url, opts); } catch { throw new SocialError('No connection to Grabbit', 0); }
      let d = null;
      try { d = await r.json(); } catch { /* not JSON */ }
      if (r.status === 401) {
        loadSession(true);
        throw new SocialError('Signed out of Elitogram', 401);
      }
      if (!r.ok || (d && d.ok === false)) throw new SocialError((d && d.error) || `Elitogram answered ${r.status}`, r.status);
      return d || {};
    }
    function loadSession(force) {
      if (S.loading) return S.loading;
      if (S.session !== undefined && !force) return Promise.resolve(S.session);
      S.loading = fetch('/api/egram/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(async (r) => {
          if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
          const d = await r.json().catch(() => null);
          if (!r.ok || !d) throw new Error((d && d.error) || `HTTP ${r.status}`);
          const was = S.session;
          S.session = d;
          S.sessionError = null;
          if (!was || was.linked !== d.linked) hub.rerender();
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

    // --- Small pieces ------------------------------------------------------------
    let toastEl = null;
    let toastTimer = null;
    function say(msg) {
      if (!toastEl) {
        toastEl = h('div', { class: 'sg-toast', role: 'status', 'aria-live': 'polite' });
        document.body.append(toastEl);
      }
      clearTimeout(toastTimer);
      toastEl.textContent = msg;
      toastEl.hidden = false;
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
    }
    const fail = (e) => say(e && e.message ? e.message : String(e));

    function pageHead(title, ...extra) {
      return h('div', { class: 'sg-head' }, h('h1', null, title), ...extra);
    }
    const empty = (text, ...extra) => h('div', { class: 'sg-empty' }, h('p', null, text), ...extra);
    function reviewBanner() {
      return h('p', { class: 'sg-review-banner', role: 'note' },
        h('b', null, 'Review lane: unclassified. '),
        'Nobody has classified these posts yet. They are shown only here, and only so you can classify them.');
    }

    function initials(name) {
      const s = String(name || '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      return (s.split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
    }
    function avatar(path, name, lane, size = 36) {
      const box = h('span', { class: 'sg-av', style: `width:${size}px;height:${size}px` }, initials(name));
      const src = avatarUrl(path, lane);
      if (src) box.append(h('img', { alt: '', src, loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }));
      return box;
    }

    // Caption text with #tags as links; everything else stays text.
    function captionNodes(text) {
      const out = [];
      const re = /#([\p{L}\p{N}_]{1,100})/gu;
      let last = 0;
      let m;
      const s = String(text || '');
      while ((m = re.exec(s))) {
        if (m.index > last) out.push(s.slice(last, m.index));
        out.push(h('a', { href: link(`tag/${enc(m[1].toLowerCase())}`) }, m[0]));
        last = m.index + m[0].length;
      }
      if (last < s.length) out.push(s.slice(last));
      return out;
    }

    // Infinite list: calls load(cursor) until it returns next = null. Items are
    // appended to `box` by draw(). Stops when the page is left.
    function pager(box, load, draw, { emptyText = 'Nothing here yet.' } = {}) {
      const gen = generation;
      const more = h('div', { class: 'sg-more' }, h('span', { class: 'muted' }, 'Loading ...'));
      const wrap = h('div', null, box, more);
      let cursor = null;
      let busy = false;
      let done = false;
      let count = 0;
      async function next() {
        if (busy || done || !live(gen)) return;
        busy = true;
        try {
          const d = await load(cursor);
          if (!live(gen)) return;
          const items = d.items || [];
          for (const it of items) {
            const el = draw(it);
            if (el) { box.append(el); count++; }
          }
          cursor = d.next == null ? null : d.next;
          done = d.next == null;
          if (done) fill(more, count ? null : h('p', { class: 'muted' }, emptyText));
        } catch (e) {
          if (!live(gen)) return;
          done = true;
          fill(more, h('p', { class: 'muted' }, e.message), h('button', { type: 'button', class: 'btn small ghost', onclick: () => { done = false; fill(more, h('span', { class: 'muted' }, 'Loading ...')); next(); } }, 'Try again'));
        } finally {
          busy = false;
        }
        // Short pages: keep going while the sentinel is still in view.
        if (!done && live(gen) && more.getBoundingClientRect().top < window.innerHeight + 400) next();
      }
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) next(); }, { rootMargin: '600px' });
      io.observe(more);
      onLeave(() => io.disconnect());
      next();
      return wrap;
    }

    // --- Tiles -------------------------------------------------------------------
    function tile(t, lane, query) {
      const id = intOf(t.id);
      const mid = intOf(t.media_id);
      if (!id || !mid) return null;
      return h('a', { class: 'sg-tile', href: link(`post/${id}`, { ...(query || {}), lane: lane === 'review' ? 'review' : null }), 'aria-label': `Post by ${t.author_handle || 'unknown'}` },
        h('img', { alt: '', src: thumbUrl(mid, lane), loading: 'lazy', decoding: 'async', 'data-media-bg': '1', onerror: (e) => e.currentTarget.classList.add('sg-broken') }),
        t.has_video ? h('span', { class: 'sg-badge' }, ic('play', 16)) : t.count > 1 ? h('span', { class: 'sg-badge' }, ic('stack', 16)) : null);
    }
    const tileGrid = () => h('div', { class: 'sg-grid' });

    function chips(options, current, href) {
      return h('div', { class: 'sg-chips', role: 'group' },
        options.map(([value, label]) => h('a', { class: `sg-chip${current === value ? ' on' : ''}`, href: href(value), 'aria-current': current === value ? 'true' : null }, label)));
    }

    // --- One post ------------------------------------------------------------------
    function postCard(p, { lane, single = false } = {}) {
      const id = intOf(p.id);
      if (!id) return null;
      const media = (p.media || []).filter((m) => intOf(m.id));
      let at = 0;
      const stage = h('div', { class: 'sg-stage' });
      const dots = h('div', { class: 'sg-dots' });
      const dl = h('a', { class: 'sg-act', title: 'Download this file', 'aria-label': 'Download this file', download: '' }, ic('download', 22));
      function show(i) {
        at = Math.max(0, Math.min(media.length - 1, i));
        const m = media[at];
        if (!m) { fill(stage, h('div', { class: 'sg-missing' }, 'No media')); return; }
        // A video is paused before it is replaced.
        for (const v of stage.querySelectorAll('video')) v.pause();
        const ratio = m.width && m.height ? Math.max(0.5, Math.min(1.91, m.width / m.height)) : 1;
        stage.style.aspectRatio = String(ratio < 0.8 ? 0.8 : ratio);
        const el = m.kind === 'video'
          ? h('video', { src: mediaUrl(m.id, lane), poster: thumbUrl(m.id, lane, 1080), controls: true, playsinline: true, preload: 'metadata', 'data-media-bg': '1' })
          : h('img', { src: mediaUrl(m.id, lane), alt: p.caption ? String(p.caption).slice(0, 120) : '', loading: single ? 'eager' : 'lazy', decoding: 'async', 'data-media-bg': '1' });
        fill(stage, el,
          media.length > 1 && at > 0 ? h('button', { type: 'button', class: 'sg-nav prev', 'aria-label': 'Previous', onclick: () => show(at - 1) }, ic('prev')) : null,
          media.length > 1 && at < media.length - 1 ? h('button', { type: 'button', class: 'sg-nav next', 'aria-label': 'Next', onclick: () => show(at + 1) }, ic('next')) : null);
        fill(dots, media.length > 1 ? media.map((_, i) => h('span', { class: i === at ? 'on' : null })) : null);
        dl.href = mediaUrl(m.id, lane, { download: '1' });
      }
      // Swipe between items on touch screens.
      let x0 = null;
      stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      stage.addEventListener('touchend', (e) => {
        if (x0 == null) return;
        const dx = e.changedTouches[0].clientX - x0;
        x0 = null;
        if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1));
      });
      show(0);

      const a = p.author || {};
      const creatorHref = a.type === 'creator' && a.handle ? link(`creator/${enc(a.handle)}`, lane === 'review' ? { lane: 'review' } : null) : null;
      const likeBtn = h('button', { type: 'button', class: `sg-act${p.liked ? ' on' : ''}`, 'aria-pressed': p.liked ? 'true' : 'false', 'aria-label': 'Like' }, ic('heart', 22));
      const likeN = h('span', { class: 'sg-count' }, p.like_count ? num(p.like_count) : '');
      likeBtn.addEventListener('click', async () => {
        const on = likeBtn.getAttribute('aria-pressed') !== 'true';
        likeBtn.disabled = true;
        try {
          const d = await call(`posts/${id}/like`, { method: on ? 'POST' : 'DELETE', lane });
          likeBtn.setAttribute('aria-pressed', d.liked ? 'true' : 'false');
          likeBtn.classList.toggle('on', !!d.liked);
          likeN.textContent = d.like_count ? num(d.like_count) : '';
        } catch (e) { fail(e); } finally { likeBtn.disabled = false; }
      });
      const favBtn = h('button', { type: 'button', class: `sg-act${p.favorited ? ' on' : ''}`, 'aria-pressed': p.favorited ? 'true' : 'false', 'aria-label': 'Favorite', title: 'Favorite' }, ic('bookmark', 22));
      favBtn.addEventListener('click', async () => {
        const on = favBtn.getAttribute('aria-pressed') !== 'true';
        favBtn.disabled = true;
        try {
          const d = await call(`posts/${id}/favorite`, { method: on ? 'POST' : 'DELETE', lane });
          favBtn.setAttribute('aria-pressed', d.favorited ? 'true' : 'false');
          favBtn.classList.toggle('on', !!d.favorited);
          say(d.favorited ? 'Added to favorites' : 'Removed from favorites');
        } catch (e) { fail(e); } finally { favBtn.disabled = false; }
      });
      const saveBtn = h('button', { type: 'button', class: 'sg-act', 'aria-label': 'Save to a collection', title: 'Save to a collection', onclick: () => collectionSheet(id, lane) }, ic('folder', 22));
      const source = safeHttps(p.source_url);
      const meta = p.meta && typeof p.meta === 'object' ? p.meta : null;
      const tags = meta && Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string').slice(0, 12) : [];

      return h('article', { class: `sg-post${single ? ' single' : ''}`, 'data-post': id },
        h('header', { class: 'sg-post-head' },
          avatar(a.avatar, a.name || a.handle, lane),
          h('div', { class: 'sg-who' },
            creatorHref ? h('a', { href: creatorHref, class: 'sg-handle' }, a.handle) : h('span', { class: 'sg-handle' }, a.handle || 'unknown'),
            h('span', { class: 'muted small' }, ago(p.created_at), meta && typeof meta.platform === 'string' ? ` · ${meta.platform}` : '')),
          !single ? h('a', { class: 'sg-act', href: link(`post/${id}`, lane === 'review' ? { lane: 'review' } : null), 'aria-label': 'Open the post', title: 'Open' }, ic('external', 20)) : null),
        stage,
        dots,
        h('div', { class: 'sg-actions' },
          likeBtn, likeN, favBtn, saveBtn, dl,
          source ? h('a', { class: 'sg-act', href: source, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open the source', title: 'Open the source' }, ic('external', 22)) : null),
        p.caption ? h('p', { class: 'sg-caption' }, captionNodes(single ? p.caption : String(p.caption).slice(0, 400))) : null,
        tags.length ? h('div', { class: 'sg-tags' }, tags.map((t) => h('span', { class: 'chip' }, t))) : null,
        lane === 'review' ? classifyPostBar(id) : null);
    }

    // In the Review lane only: classify one post.
    function classifyPostBar(id) {
      const bar = h('div', { class: 'sg-classify' }, h('span', { class: 'muted small' }, 'Unclassified post'));
      const act = (aud, label) => h('button', {
        type: 'button',
        class: `btn small${aud === 'adult' ? ' danger' : ''}`,
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await call(`posts/${id}`, { method: 'PATCH', body: { audience: aud }, lane: 'review' });
            say(aud === 'general' ? 'Marked general' : 'Marked 18+: it leaves Social & Photos');
            const card = bar.closest('.sg-post, .sg-review-item');
            if (card) card.remove();
            else location.hash = link('review', { tab: 'posts' });
          } catch (err) { fail(err); btn.disabled = false; }
        },
      }, label);
      bar.append(act('general', 'Mark general'), act('adult', 'Mark 18+'));
      return bar;
    }

    // --- Sheets and the photo viewer --------------------------------------------------
    let sheetEl = null;
    function closeSheet() {
      if (!sheetEl) return;
      sheetEl.remove();
      sheetEl = null;
    }
    function sheet(title, body) {
      closeSheet();
      const panel = h('div', { class: 'sg-sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'sg-sheet-head' }, h('b', null, title), h('button', { type: 'button', class: 'sg-act', 'aria-label': 'Close', onclick: closeSheet }, ic('close'))),
        body);
      sheetEl = h('div', { class: 'sg-sheet', onclick: (e) => { if (e.target === sheetEl) closeSheet(); } }, panel);
      sheetEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } });
      document.body.append(sheetEl);
      const first = panel.querySelector('input, button:not(.sg-act)') || panel.querySelector('button');
      if (first) first.focus();
    }

    async function collectionSheet(postId, lane) {
      const body = h('div', { class: 'sg-sheet-body' }, h('p', { class: 'muted' }, 'Loading ...'));
      sheet('Save to a collection', body);
      try {
        const [cols, mine] = await Promise.all([call('collections', { lane }), call(`posts/${postId}/collections`, { lane })]);
        const inSet = new Set(mine.items || []);
        const rows = (cols.items || []).map((c) => {
          const box = h('input', { type: 'checkbox', checked: inSet.has(c.id) });
          box.addEventListener('change', async () => {
            box.disabled = true;
            try {
              if (box.checked) await call(`collections/${c.id}/items`, { method: 'POST', body: { post_id: postId }, lane });
              else await call(`collections/${c.id}/items/${postId}`, { method: 'DELETE', lane });
            } catch (e) { box.checked = !box.checked; fail(e); } finally { box.disabled = false; }
          });
          return h('label', { class: 'sg-row' }, box, h('span', null, c.name), h('span', { class: 'muted small' }, num(c.count)));
        });
        const name = h('input', { type: 'text', maxlength: '80', placeholder: 'New collection', 'aria-label': 'New collection name' });
        const form = h('form', { class: 'sg-inline', onsubmit: async (e) => {
          e.preventDefault();
          const n = name.value.trim();
          if (!n) return;
          try {
            const c = await call('collections', { method: 'POST', body: { name: n }, lane });
            await call(`collections/${c.id}/items`, { method: 'POST', body: { post_id: postId }, lane });
            say(`Saved to ${n}`);
            closeSheet();
          } catch (err) { fail(err); }
        } }, name, h('button', { type: 'submit', class: 'btn small' }, 'Create and save'));
        fill(body, rows.length ? rows : h('p', { class: 'muted' }, 'No collections yet.'), form);
      } catch (e) {
        fill(body, h('p', { class: 'muted' }, e.message));
      }
    }

    // Photos open in a full-screen viewer that steps through the loaded grid.
    let viewerEl = null;
    let viewerKeys = null;
    function closeViewer() {
      if (!viewerEl) return;
      viewerEl.remove();
      viewerEl = null;
      document.removeEventListener('keydown', viewerKeys, true);
      viewerKeys = null;
    }
    function openViewer(list, index, lane) {
      closeViewer();
      let i = index;
      const img = h('img', { alt: '', 'data-media-bg': '1' });
      const info = h('div', { class: 'sg-viewer-info' });
      function paint() {
        const it = list[i];
        img.src = mediaUrl(it.media_id, lane);
        fill(info,
          h('span', null, it.author_handle ? `@${it.author_handle}` : ''),
          h('span', { class: 'muted small' }, `${i + 1} / ${list.length}`, it.width && it.height ? ` · ${it.width}×${it.height}` : ''),
          h('a', { class: 'btn small ghost', href: link(`post/${intOf(it.post_id)}`, lane === 'review' ? { lane: 'review' } : null), onclick: closeViewer }, 'Open post'),
          h('a', { class: 'btn small ghost', href: mediaUrl(it.media_id, lane, { download: '1' }), download: '' }, ic('download', 16), ' Download'));
        call(`posts/${intOf(it.post_id)}/view`, { method: 'POST', lane }).catch(() => {});
      }
      const step = (d) => { i = Math.max(0, Math.min(list.length - 1, i + d)); paint(); };
      viewerEl = h('div', { class: 'sg-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo' },
        img,
        h('button', { type: 'button', class: 'sg-viewer-btn close', 'aria-label': 'Close', onclick: closeViewer }, ic('close', 24)),
        h('button', { type: 'button', class: 'sg-viewer-btn prev', 'aria-label': 'Previous photo', onclick: () => step(-1) }, ic('prev', 28)),
        h('button', { type: 'button', class: 'sg-viewer-btn next', 'aria-label': 'Next photo', onclick: () => step(1) }, ic('next', 28)),
        info);
      let x0 = null;
      viewerEl.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      viewerEl.addEventListener('touchend', (e) => {
        if (x0 == null) return;
        const dx = e.changedTouches[0].clientX - x0;
        x0 = null;
        if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
      });
      viewerKeys = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeViewer(); }
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
      };
      document.addEventListener('keydown', viewerKeys, true);
      document.body.append(viewerEl);
      paint();
      viewerEl.querySelector('.sg-viewer-btn.close').focus();
    }

    // --- Pages ---------------------------------------------------------------------
    function viewFeed() {
      const box = h('div', { class: 'sg-feed' });
      return [pageHead('Social'), pager(box, (cur) => call(`feed${cur ? `?cursor=${enc(cur)}` : ''}`), (p) => postCard(p), { emptyText: 'No general posts yet. Classify creators in the Review lane to fill this feed.' })];
    }

    function viewPhotos(r) {
      const orient = ['portrait', 'landscape', 'square'].includes(r.params.get('orient')) ? r.params.get('orient') : '';
      const list = [];
      const box = h('div', { class: 'sg-grid sg-photos' });
      const q = orient ? `orient=${orient}` : '';
      return [
        pageHead('Photos'),
        chips([['', 'All'], ['portrait', 'Portrait'], ['landscape', 'Landscape'], ['square', 'Square']], orient, (v) => link('photos', { orient: v })),
        pager(box, (cur) => call(`photos?${[q, cur ? `cursor=${enc(cur)}` : ''].filter(Boolean).join('&')}`), (it) => {
          const mid = intOf(it.media_id);
          if (!mid) return null;
          const idx = list.push(it) - 1;
          return h('button', { type: 'button', class: 'sg-tile', 'aria-label': `Photo by ${it.author_handle || 'unknown'}`, onclick: () => openViewer(list, idx) },
            h('img', { alt: '', src: thumbUrl(mid), loading: 'lazy', decoding: 'async', 'data-media-bg': '1' }));
        }, { emptyText: 'No general photos yet.' }),
      ];
    }

    let categories = { at: 0, data: null };
    function viewExplore(r) {
      const kind = ['image', 'video'].includes(r.params.get('kind')) ? r.params.get('kind') : '';
      const orient = ['portrait', 'landscape', 'square'].includes(r.params.get('orient')) ? r.params.get('orient') : '';
      const q = (r.params.get('q') || '').slice(0, 200);
      const keep = { kind, orient, q };
      const cats = h('div', { class: 'sg-cats' });
      const gen = generation;
      const paintCats = (d) => fill(cats, d && d.tags && d.tags.length
        ? h('div', { class: 'sg-chips' }, d.tags.slice(0, 24).map((t) => h('a', { class: 'sg-chip', href: link(`tag/${enc(t.tag)}`) }, `#${t.tag}`, h('span', { class: 'muted small' }, ` ${num(t.n)}`))))
        : null);
      if (categories.data && Date.now() - categories.at < 60000) paintCats(categories.data);
      else call('categories').then((d) => { categories = { at: Date.now(), data: d }; if (live(gen)) paintCats(d); }).catch(() => {});
      const qs = (cur) => new URLSearchParams(Object.entries({ kind, orient, q, cursor: cur || '' }).filter(([, v]) => v)).toString();
      const grid = tileGrid();
      return [
        pageHead('Explore', q ? h('span', { class: 'muted' }, `"${q}"`) : null),
        chips([['', 'Everything'], ['image', 'Photos'], ['video', 'Videos']], kind, (v) => link('explore', { ...keep, kind: v })),
        chips([['', 'Any shape'], ['portrait', 'Portrait'], ['landscape', 'Landscape'], ['square', 'Square']], orient, (v) => link('explore', { ...keep, orient: v })),
        q ? null : cats,
        pager(grid, (cur) => call(`explore?${qs(cur)}`), (t) => tile(t), { emptyText: 'Nothing matches.' }),
      ];
    }

    function viewTag(r) {
      const tag = String(r.sub[1] || '').toLowerCase().slice(0, 100);
      if (!tag) return [pageHead('Tag'), empty('No tag given.')];
      const total = h('span', { class: 'muted' });
      const grid = tileGrid();
      return [
        pageHead(`#${tag}`, total),
        pager(grid, async (cur) => {
          const d = await call(`hashtags/${enc(tag)}${cur ? `?cursor=${enc(cur)}` : ''}`);
          if (d.total != null) total.textContent = `${num(d.total)} posts`;
          return d;
        }, (t) => tile(t), { emptyText: 'No general posts with this tag.' }),
      ];
    }

    function viewSearch(r) {
      const q = (r.params.get('q') || '').trim().slice(0, 200);
      if (!q) return [pageHead('Search'), empty('Type in the search box above to find creators, tags and posts.')];
      const top = h('div', { class: 'sg-search-top' }, h('p', { class: 'muted' }, 'Searching ...'));
      const gen = generation;
      call(`search?q=${enc(q)}`).then((d) => {
        if (!live(gen)) return;
        fill(top,
          (d.creators || []).length ? h('div', { class: 'sg-creator-row' }, d.creators.map((c) => h('a', { class: 'sg-creator-chip', href: link(`creator/${enc(c.handle)}`) }, avatar(c.avatar, c.display_name || c.handle, null, 28), h('span', null, c.handle)))) : null,
          (d.tags || []).length ? h('div', { class: 'sg-chips' }, d.tags.map((t) => h('a', { class: 'sg-chip', href: link(`tag/${enc(t.tag)}`) }, `#${t.tag}`))) : null);
      }).catch((e) => { if (live(gen)) fill(top, h('p', { class: 'muted' }, e.message)); });
      const grid = tileGrid();
      return [pageHead('Search', h('span', { class: 'muted' }, `"${q}"`)), top, pager(grid, (cur) => call(`explore?q=${enc(q)}${cur ? `&cursor=${enc(cur)}` : ''}`), (t) => tile(t), { emptyText: 'No posts match.' })];
    }

    function viewCreators(r) {
      const q = (r.params.get('q') || '').slice(0, 80);
      const box = h('div', { class: 'sg-creators' });
      const input = h('input', { type: 'search', value: q, placeholder: 'Find a creator', 'aria-label': 'Find a creator' });
      const form = h('form', { class: 'sg-inline', onsubmit: (e) => { e.preventDefault(); location.hash = link('creators', { q: input.value.trim() }); } }, input, h('button', { type: 'submit', class: 'btn small ghost' }, 'Find'));
      return [
        pageHead('Creators'),
        form,
        pager(box, async (cur) => {
          const d = await call(`creators?${new URLSearchParams(Object.entries({ q, offset: cur || '' }).filter(([, v]) => v))}`);
          return { items: d.items || [], next: d.next };
        }, (c) => h('a', { class: 'sg-creator', href: link(`creator/${enc(c.handle)}`) },
          avatar(c.avatar, c.display_name || c.handle, null, 48),
          h('span', { class: 'sg-creator-name' }, h('b', null, c.display_name || c.handle), h('span', { class: 'muted small' }, `@${c.handle}`)),
          h('span', { class: 'muted small' }, `${num(c.post_count)} posts`)), { emptyText: 'No general creators yet.' }),
      ];
    }

    function viewCreator(r) {
      const handle = String(r.sub[1] || '').toLowerCase();
      const lane = r.params.get('lane') === 'review' ? 'review' : null;
      if (!/^[a-z0-9._~-]{1,100}$/.test(handle)) return [pageHead('Creator'), empty('No such creator.')];
      const head = h('div', { class: 'sg-profile' }, h('p', { class: 'muted' }, 'Loading ...'));
      const gen = generation;
      call(`creators/${enc(handle)}`, { lane }).then((c) => {
        if (!live(gen)) return;
        const follow = h('button', { type: 'button', class: `btn small${c.following ? ' ghost' : ''}` }, c.following ? 'Following' : 'Follow');
        follow.addEventListener('click', async () => {
          follow.disabled = true;
          try {
            const d = await call(`creators/${enc(handle)}/follow`, { method: c.following ? 'DELETE' : 'POST', lane });
            c.following = d.following;
            follow.textContent = d.following ? 'Following' : 'Follow';
            follow.classList.toggle('ghost', !!d.following);
          } catch (e) { fail(e); } finally { follow.disabled = false; }
        });
        fill(head,
          avatar(c.avatar, c.display_name || c.handle, lane, 88),
          h('div', { class: 'sg-profile-text' },
            h('h1', null, c.display_name || c.handle),
            h('p', { class: 'muted' }, `@${c.handle} · ${num(c.post_count)} posts · ${num(c.follower_count)} followers`),
            c.bio ? h('p', { class: 'sg-bio' }, c.bio) : null,
            h('div', { class: 'sg-inline' }, follow,
              lane === 'review' && canClassify() ? classifyCreatorButtons([c.handle], () => { location.hash = link('review'); }) : null)));
      }).catch((e) => { if (live(gen)) fill(head, empty(e.status === 404 ? 'This creator is not in Social & Photos.' : e.message)); });
      const grid = tileGrid();
      return [lane === 'review' ? reviewBanner() : null, head, pager(grid, (cur) => call(`creators/${enc(handle)}/posts${cur ? `?cursor=${enc(cur)}` : ''}`, { lane }), (t) => tile(t, lane), { emptyText: 'No posts here.' })];
    }

    function viewPost(r) {
      const id = intOf(r.sub[1]);
      const lane = r.params.get('lane') === 'review' ? 'review' : null;
      if (!id) return [pageHead('Post'), empty('No such post.')];
      const box = h('div', { class: 'sg-single' }, h('p', { class: 'muted' }, 'Loading ...'));
      const gen = generation;
      call(`posts/${id}`, { lane }).then((p) => {
        if (!live(gen)) return;
        fill(box, postCard(p, { lane, single: true }));
        call(`posts/${id}/view`, { method: 'POST', lane }).catch(() => {});
      }).catch((e) => { if (live(gen)) fill(box, empty(e.status === 404 ? 'This post is not in Social & Photos.' : e.message)); });
      return [lane === 'review' ? reviewBanner() : null, h('a', { class: 'sg-back', href: lane === 'review' ? link('review', { tab: 'posts' }) : BASE, onclick: (e) => { if (history.length > 1) { e.preventDefault(); history.back(); } } }, ic('prev', 18), 'Back'), box];
    }

    function viewCollections() {
      const box = h('div', { class: 'sg-collections' });
      const name = h('input', { type: 'text', maxlength: '80', placeholder: 'New collection', 'aria-label': 'New collection name' });
      const form = h('form', { class: 'sg-inline', onsubmit: async (e) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) return;
        try {
          await call('collections', { method: 'POST', body: { name: n } });
          hub.rerender();
        } catch (err) { fail(err); }
      } }, name, h('button', { type: 'submit', class: 'btn small' }, 'Create'));
      const gen = generation;
      call('collections').then((d) => {
        if (!live(gen)) return;
        const items = d.items || [];
        fill(box, items.length ? items.map((c) => h('a', { class: 'sg-collection', href: link(`collection/${intOf(c.id)}`) },
          c.cover && intOf(c.cover.media_id) ? h('img', { alt: '', src: thumbUrl(c.cover.media_id), loading: 'lazy', 'data-media-bg': '1' }) : h('div', { class: 'sg-collection-empty' }, ic('folder', 32)),
          h('b', null, c.name), h('span', { class: 'muted small' }, `${num(c.count)} posts`))) : empty('No collections yet. Save a post to one from its folder button.'));
      }).catch((e) => { if (live(gen)) fill(box, empty(e.message)); });
      return [pageHead('Collections'), form, box];
    }

    function viewCollection(r) {
      const id = intOf(r.sub[1]);
      if (!id) return [pageHead('Collection'), empty('No such collection.')];
      const title = h('h1', null, 'Collection');
      const tools = h('div', { class: 'sg-inline' },
        h('button', { type: 'button', class: 'btn small ghost', onclick: async () => {
          const n = prompt('New name for this collection', title.textContent);
          if (!n || !n.trim()) return;
          try { await call(`collections/${id}`, { method: 'PATCH', body: { name: n.trim() } }); title.textContent = n.trim(); } catch (e) { fail(e); }
        } }, 'Rename'),
        h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
          if (!confirm('Delete this collection? The posts stay where they are.')) return;
          try { await call(`collections/${id}`, { method: 'DELETE' }); location.hash = link('collections'); } catch (e) { fail(e); }
        } }, 'Delete'));
      const grid = tileGrid();
      return [
        h('div', { class: 'sg-head' }, title, tools),
        pager(grid, async (cur) => {
          const d = await call(`collections/${id}/posts${cur ? `?cursor=${enc(cur)}` : ''}`);
          if (d.collection && d.collection.name) title.textContent = d.collection.name;
          return d;
        }, (t) => tile(t), { emptyText: 'This collection is empty.' }),
      ];
    }

    function viewFavorites() {
      return [pageHead('Favorites'), pager(tileGrid(), (cur) => call(`favorites${cur ? `?cursor=${enc(cur)}` : ''}`), (t) => tile(t), { emptyText: 'No favorites yet.' })];
    }

    function viewHistory() {
      const clear = h('button', { type: 'button', class: 'btn small ghost', onclick: async () => {
        if (!confirm('Clear your viewing history?')) return;
        try { await call('history', { method: 'DELETE' }); hub.rerender(); } catch (e) { fail(e); }
      } }, 'Clear history');
      return [pageHead('History', clear), pager(tileGrid(), (cur) => call(`history${cur ? `?cursor=${enc(cur)}` : ''}`), (t) => tile(t), { emptyText: 'Nothing viewed yet.' })];
    }

    // --- Review lane -------------------------------------------------------------------
    function classifyCreatorButtons(handlesOf, after) {
      const go = (aud) => async (e) => {
        const btn = e.currentTarget;
        const handles = typeof handlesOf === 'function' ? handlesOf() : handlesOf;
        if (!handles.length) return say('Choose at least one creator');
        if (aud === 'adult' && !confirm(`Mark ${handles.length} creator(s) 18+? They leave Social & Photos.`)) return;
        btn.disabled = true;
        try {
          const r = await fetch('/api/egram/creators-classify', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ handles, audience: aud, lane: 'review' }),
          });
          const d = await r.json().catch(() => null);
          if (!r.ok || !d || d.ok === false) throw new Error((d && d.error) || `HTTP ${r.status}`);
          const skipped = (d.skipped || []).length;
          say(`${d.updated.length} classified ${aud === 'adult' ? '18+' : 'general'}${skipped ? `, ${skipped} skipped` : ''}`);
          if (after) after(d);
        } catch (err) { fail(err); } finally { btn.disabled = false; }
      };
      return [
        h('button', { type: 'button', class: 'btn small', onclick: go('general') }, 'Mark general'),
        h('button', { type: 'button', class: 'btn small danger', onclick: go('adult') }, 'Mark 18+'),
      ];
    }

    function viewReview(r) {
      const tab = r.params.get('tab') === 'posts' ? 'posts' : 'creators';
      const tabs = chips([['creators', 'Creators'], ['posts', 'Posts']], tab, (v) => link('review', { tab: v }));
      if (tab === 'posts') {
        return [pageHead('Review'), reviewBanner(), tabs, pager(tileGrid(), (cur) => call(`explore${cur ? `?cursor=${enc(cur)}` : ''}`, { lane: 'review' }), (t) => tile(t, 'review'), { emptyText: 'Nothing left to review.' })];
      }
      const selected = new Set();
      const count = h('span', { class: 'muted small' }, '0 chosen');
      const box = h('div', { class: 'sg-review-list' });
      const bar = canClassify()
        ? h('div', { class: 'sg-review-bar' }, count, classifyCreatorButtons(() => [...selected], (d) => {
          for (const hnd of d.updated || []) {
            const row = box.querySelector(`[data-handle="${CSS.escape(hnd)}"]`);
            if (row) row.remove();
            selected.delete(hnd);
          }
          count.textContent = `${selected.size} chosen`;
        }))
        : h('p', { class: 'muted small' }, 'Your Elitogram account cannot classify creators (it needs the profiles permission).');
      return [
        pageHead('Review'),
        reviewBanner(),
        tabs,
        bar,
        pager(box, async (cur) => {
          const d = await call(`creators?samples=1${cur ? `&offset=${enc(cur)}` : ''}`, { lane: 'review' });
          return { items: d.items || [], next: d.next };
        }, (c) => {
          if (!c.post_count) return null;
          const pick = h('input', { type: 'checkbox', 'aria-label': `Choose ${c.handle}`, disabled: !canClassify() });
          pick.addEventListener('change', () => {
            if (pick.checked) selected.add(c.handle); else selected.delete(c.handle);
            count.textContent = `${selected.size} chosen`;
          });
          return h('div', { class: 'sg-review-item', 'data-handle': c.handle },
            h('label', { class: 'sg-review-who' }, pick, avatar(c.avatar, c.display_name || c.handle, 'review', 40),
              h('span', null, h('b', null, c.handle), h('span', { class: 'muted small' }, ` ${num(c.post_count)} posts`))),
            h('div', { class: 'sg-review-samples' }, (c.samples || []).map((t) => tile(t, 'review'))),
            h('a', { class: 'btn small ghost', href: link(`creator/${enc(c.handle)}`, { lane: 'review' }) }, 'All posts'));
        }, { emptyText: 'No unclassified creators left.' }),
      ];
    }

    // --- Account ---------------------------------------------------------------------
    function viewAccount() {
      const s = S.session || {};
      if (s.linked) {
        const u = s.user || {};
        return [
          pageHead('Elitogram account'),
          h('p', null, 'Linked as ', h('b', null, u.display_name || u.username || '?'), u.username ? ` (@${u.username})` : ''),
          h('p', { class: 'muted small' }, 'Grabbit keeps only the Elitogram session, sealed in a cookie for this site. Your password is not stored.'),
          h('button', { type: 'button', class: 'btn ghost', onclick: async (e) => {
            e.currentTarget.disabled = true;
            await fetch('/api/egram/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
            S.session = undefined;
            loadSession(true);
          } }, 'Unlink'),
        ];
      }
      const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, maxlength: '100' });
      const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: '1024' });
      const msg = h('p', { class: 'muted small', role: 'status' });
      const form = h('form', { class: 'sg-link', onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button');
        btn.disabled = true;
        msg.textContent = '';
        try {
          const r = await fetch('/api/egram/session', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ username: user.value.trim(), password: pass.value }),
          });
          const d = await r.json().catch(() => null);
          if (!r.ok || !d || d.ok === false) throw new Error((d && d.error) || `HTTP ${r.status}`);
          pass.value = '';
          S.session = undefined;
          await loadSession(true);
          location.hash = BASE;
        } catch (err) { msg.textContent = err.message; btn.disabled = false; }
      } },
        h('label', null, 'User name', user),
        h('label', null, 'Password', pass),
        h('button', { type: 'submit', class: 'btn' }, 'Link account'),
        msg);
      return [
        pageHead('Social & Photos'),
        h('p', null, 'Link your Elitogram account to see its posts and photos here.'),
        h('p', { class: 'muted small' }, 'Grabbit sends the password to Elitogram once and keeps only the session it gets back, in a cookie for this site.'),
        form,
      ];
    }

    // --- Router ----------------------------------------------------------------------
    const SECTIONS = [
      ['', 'Feed'],
      ['photos', 'Photos'],
      ['explore', 'Explore'],
      ['creators', 'Creators'],
      ['collections', 'Collections'],
      ['favorites', 'Favorites'],
      ['history', 'History'],
      ['review', 'Review'],
      ['account', 'Account'],
    ];
    const SECTION_OF = { tag: 'explore', search: 'explore', creator: 'creators', collection: 'collections', post: '' };
    function subnav(r) {
      if (!S.session || !S.session.linked) return null;
      const first = r.sub[0] || '';
      const cur = first in SECTION_OF ? SECTION_OF[first] : first;
      const lane = r.params.get('lane') === 'review';
      return SECTIONS.map(([id, label]) => ({ href: link(id), label, current: lane ? id === 'review' : cur === id }));
    }

    function view(r) {
      const first = r.sub[0] || '';
      let body;
      if (S.session === undefined) {
        if (S.sessionError) {
          body = [pageHead('Social & Photos'), empty(`Elitogram is not reachable: ${S.sessionError}`, h('button', { type: 'button', class: 'btn', onclick: () => { S.sessionError = null; loadSession(true); hub.rerender(); } }, 'Try again'))];
        } else {
          loadSession();
          body = [pageHead('Social & Photos'), h('p', { class: 'muted' }, 'Loading ...')];
        }
      } else if (!S.session.linked || first === 'account') {
        body = viewAccount(r);
      } else {
        switch (first) {
          case '': body = viewFeed(r); break;
          case 'photos': body = viewPhotos(r); break;
          case 'explore': body = viewExplore(r); break;
          case 'tag': body = viewTag(r); break;
          case 'search': body = viewSearch(r); break;
          case 'creators': body = viewCreators(r); break;
          case 'creator': body = viewCreator(r); break;
          case 'post': body = viewPost(r); break;
          case 'collections': body = viewCollections(r); break;
          case 'collection': body = viewCollection(r); break;
          case 'favorites': body = viewFavorites(r); break;
          case 'history': body = viewHistory(r); break;
          case 'review': body = viewReview(r); break;
          default: body = [pageHead('Social & Photos'), empty('This page does not exist.', h('a', { class: 'btn', href: BASE }, 'Go to the feed'))];
        }
      }
      return h('div', { class: 'sg-root' }, body);
    }

    // Signing out of Grabbit ends the Elitogram session too (see hub.js).
    const signOut = () => fetch('/api/egram/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});

    return { view, leave, subnav, signOut, searchHash: (q) => link('search', { q }) };
  }
})();
