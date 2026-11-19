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
      comment: 'M4 5h16v11H9l-5 4z',
      share: 'M12 3v12M7 8l5-5 5 5M5 13v7h14v-7',
      fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
      unfullscreen: 'M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5',
      zoomin: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20M10.5 8v5M8 10.5h5',
      zoomout: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20M8 10.5h5',
      reset: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
      edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
      trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
      send: 'M4 12l16-8-6 16-2-7z',
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
      closeSheet();
      closeViewer();
    }

    // --- The on-screen keyboard ---------------------------------------------------
    // Android Chrome shrinks only the visual viewport when the keyboard opens,
    // so a sheet pinned to bottom: 0 ends up behind it (Grabbit 3.0.2 lesson
    // from tik.js). --sg-kb is the height the keyboard takes off the bottom of
    // the layout viewport and --sg-vvh the height still visible; sheets sit on
    // top of the keyboard and never grow past what is visible.
    const vvp = window.visualViewport;
    function syncKeyboard() {
      if (!vvp) return;
      const root = document.documentElement.style;
      const kb = Math.max(0, Math.round(window.innerHeight - vvp.height - vvp.offsetTop));
      root.setProperty('--sg-kb', `${kb}px`);
      root.setProperty('--sg-vvh', `${Math.round(vvp.height)}px`);
    }
    if (vvp) {
      vvp.addEventListener('resize', syncKeyboard);
      vvp.addEventListener('scroll', syncKeyboard);
      syncKeyboard();
    }

    // Sheets and toasts go into the viewer while it is open: in browser
    // fullscreen only the fullscreen element's subtree is drawn.
    const layer = () => viewerEl || document.body;

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
      if (!toastEl) toastEl = h('div', { class: 'sg-toast', role: 'status', 'aria-live': 'polite' });
      if (toastEl.parentNode !== layer()) layer().append(toastEl);
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
      // The sentinel says "Loading ..." only while a page is on its way. Between
      // pages it is empty: a long list (the Review lane has dozens of pages)
      // otherwise reads as never finishing.
      const more = h('div', { class: 'sg-more' });
      const wrap = h('div', null, box, more);
      let cursor = null;
      let busy = false;
      let done = false;
      let count = 0;
      async function next() {
        if (busy || done || !live(gen)) return;
        busy = true;
        more.setAttribute('aria-busy', 'true');
        fill(more, h('span', { class: 'muted' }, 'Loading ...'));
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
          fill(more, done && !count ? h('p', { class: 'muted' }, emptyText) : null);
        } catch (e) {
          if (!live(gen)) return;
          done = true;
          fill(more, h('p', { class: 'muted' }, e.message), h('button', { type: 'button', class: 'btn small ghost', onclick: () => { done = false; next(); } }, 'Try again'));
        } finally {
          busy = false;
          more.removeAttribute('aria-busy');
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

    // "1 post", "2 posts"
    const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : many}`;

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
          : h('img', { src: mediaUrl(m.id, lane), alt: p.caption ? String(p.caption).slice(0, 120) : '', loading: single ? 'eager' : 'lazy', decoding: 'async', 'data-media-bg': '1', class: 'sg-zoomable', title: 'Open full screen', onclick: () => openViewer(viewerItems(), at, lane) });
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
      const commentN = h('span', { class: 'sg-count' }, p.comment_count ? num(p.comment_count) : '');
      const commentBtn = h('button', { type: 'button', class: 'sg-act', 'aria-label': 'Comments', title: 'Comments', onclick: () => commentsSheet(id, lane, (n) => { commentN.textContent = n ? num(n) : ''; }) }, ic('comment', 22));
      const shareBtn = h('button', { type: 'button', class: 'sg-act', 'aria-label': 'Share', title: 'Share', onclick: () => shareSheet(id, lane) }, ic('share', 22));
      const viewerItems = () => media.map((m) => ({ media_id: m.id, post_id: id, kind: m.kind, width: m.width, height: m.height, author_handle: (p.author || {}).handle }));
      const source = safeHttps(p.source_url);
      const meta = p.meta && typeof p.meta === 'object' ? p.meta : null;
      const tags = meta && Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string').slice(0, 12) : [];
      const caption = h('p', { class: 'sg-caption', hidden: !p.caption }, captionNodes(single ? p.caption : String(p.caption || '').slice(0, 400)));

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
          likeBtn, likeN, commentBtn, commentN, shareBtn, favBtn, saveBtn, dl,
          source ? h('a', { class: 'sg-act', href: source, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open the source', title: 'Open the source' }, ic('external', 22)) : null),
        caption,
        tags.length ? h('div', { class: 'sg-tags' }, tags.map((t) => h('span', { class: 'chip' }, t))) : null,
        single && p.can_edit ? ownerBar(p, lane, caption) : null,
        lane === 'review' ? classifyPostBar(id) : null);
    }

    // The author (or an admin) of a post: edit its caption or delete it.
    // Elitogram decides who may (can_edit, and again on every write).
    function ownerBar(p, lane, captionEl) {
      const id = intOf(p.id);
      const edit = h('button', { type: 'button', class: 'btn small ghost', onclick: () => {
        const text = h('textarea', { rows: '5', maxlength: '5000', 'aria-label': 'Caption' });
        text.value = p.caption || '';
        const form = h('form', { class: 'sg-form', onsubmit: async (e) => {
          e.preventDefault();
          const btn = form.querySelector('button[type=submit]');
          btn.disabled = true;
          try {
            const d = await call(`posts/${id}`, { method: 'PATCH', body: { caption: text.value }, lane });
            p.caption = d && typeof d.caption === 'string' ? d.caption : text.value;
            fill(captionEl, captionNodes(p.caption));
            captionEl.hidden = !p.caption;
            closeSheet();
            say('Caption saved');
          } catch (err) { fail(err); btn.disabled = false; }
        } }, text, h('p', { class: 'muted small' }, 'Write #tags in the caption; they become the post\'s tags.'),
          h('div', { class: 'sg-inline' }, h('button', { type: 'submit', class: 'btn small' }, 'Save'), h('button', { type: 'button', class: 'btn small ghost', onclick: closeSheet }, 'Cancel')));
        sheet('Edit caption', form);
      } }, ic('edit', 16), ' Edit caption');
      const del = h('button', { type: 'button', class: 'btn small ghost danger', onclick: async (e) => {
        if (!confirm('Delete this post? It can be restored in standalone Elitogram.')) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await call(`posts/${id}`, { method: 'DELETE', lane });
          say('Post deleted');
          location.hash = lane === 'review' ? link('review', { tab: 'posts' }) : BASE;
        } catch (err) { fail(err); btn.disabled = false; }
      } }, ic('trash', 16), ' Delete post');
      return h('div', { class: 'sg-owner' }, h('span', { class: 'muted small' }, 'Your post'), edit, del);
    }

    // In the Review lane only: classify one post.
    function classifyPostBar(id) {
      const bar = h('div', { class: 'sg-classify' }, h('span', { class: 'muted small' }, 'Unclassified post'));
      const act = (aud, label) => h('button', {
        type: 'button',
        class: `btn small${aud === 'adult' ? ' ghost danger' : ''}`,
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
    let sheetBack = null;
    // Escape closes the sheet wherever focus is: a row the sheet redraws (a
    // deleted comment) takes focus with it to <body>, outside the sheet.
    function sheetKeys(e) {
      if (e.key !== 'Escape' || !sheetEl) return;
      e.preventDefault();
      e.stopPropagation();
      closeSheet();
    }
    function closeSheet() {
      if (!sheetEl) return;
      document.removeEventListener('keydown', sheetKeys, true);
      sheetEl.remove();
      sheetEl = null;
      const back = sheetBack;
      sheetBack = null;
      if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    }
    // A bottom sheet on phones, a centred dialog on wider screens. It rides
    // on top of the on-screen keyboard (--sg-kb) and is drawn inside the
    // viewer when the viewer is open, so it also works in fullscreen.
    function sheet(title, body, opts = {}) {
      const back = sheetEl ? sheetBack : document.activeElement;
      closeSheet();
      sheetBack = back;
      const panel = h('div', { class: `sg-sheet-panel${opts.cls ? ` ${opts.cls}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'sg-sheet-head' }, h('b', null, title), h('button', { type: 'button', class: 'sg-act', 'aria-label': 'Close', onclick: closeSheet }, ic('close'))),
        body);
      sheetEl = h('div', { class: 'sg-sheet', onclick: (e) => { if (e.target === sheetEl) closeSheet(); } }, panel);
      document.addEventListener('keydown', sheetKeys, true);
      layer().append(sheetEl);
      const first = opts.focus || panel.querySelector('input, textarea, select, button:not(.sg-act)') || panel.querySelector('button');
      if (first) first.focus({ preventScroll: true });
      return panel;
    }

    // --- Share ---------------------------------------------------------------------
    // The same as the rest of Grabbit (tik.js openShare): the system share
    // sheet where there is one, the clipboard otherwise. The address is the
    // post's own page in Grabbit, so whoever opens it passes Grabbit's login
    // and the gateway's audience checks; nothing about the file is in it.
    const postAddress = (id, lane) => `${location.origin}/${link(`post/${Number(id)}`, lane === 'review' ? { lane: 'review' } : null)}`;
    function shareSheet(id, lane) {
      const url = postAddress(id, lane);
      const label = h('span', null, navigator.share ? 'Share or copy the link' : 'Copy link');
      const row = h('button', { type: 'button', class: 'sg-row sg-share-row', onclick: async () => {
        if (navigator.share) {
          try { await navigator.share({ url }); closeSheet(); return; } catch (err) { if (err && err.name === 'AbortError') return; }
        }
        try {
          await navigator.clipboard.writeText(url);
          label.textContent = 'Link copied!';
          setTimeout(() => { label.textContent = 'Copy link'; }, 2000);
        } catch { say('Could not copy the link'); }
      } }, ic('share', 18), label);
      const shown = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Link to the post', class: 'sg-share-url', onfocus: (e) => e.currentTarget.select() });
      sheet('Share', [row, shown, h('p', { class: 'muted small' }, lane === 'review'
        ? 'The link opens the Review lane. Only signed-in Grabbit users whose Elitogram account may review can see it.'
        : 'The link opens the post in Grabbit. It needs a Grabbit sign-in and shows only general material.')], { focus: row });
    }

    // --- Comments ----------------------------------------------------------------------
    // The comment field stays above the on-screen keyboard: the sheet is
    // lifted by --sg-kb and its height capped by --sg-vvh, the list scrolls
    // and the form stays at the bottom of the sheet.
    function commentsSheet(postId, lane, onCount) {
      const pid = intOf(postId);
      if (!pid) return;
      const list = h('div', { class: 'sg-comments', 'aria-live': 'polite' }, h('p', { class: 'muted' }, 'Loading ...'));
      const text = h('textarea', { rows: '1', maxlength: '2000', placeholder: 'Add a comment ...', 'aria-label': 'Add a comment', enterkeyhint: 'send' });
      const send = h('button', { type: 'submit', class: 'sg-act sg-send', 'aria-label': 'Post comment', title: 'Post comment' }, ic('send', 20));
      const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(120, text.scrollHeight)}px`; };
      text.addEventListener('input', grow);
      // Enter sends on a hardware keyboard; Shift+Enter is a new line.
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
      });
      // On a phone the keyboard opens after focus; keep the field in view.
      text.addEventListener('focus', () => setTimeout(() => text.scrollIntoView({ block: 'nearest' }), 300));
      let count = 0;
      async function load() {
        try {
          const d = await call(`posts/${pid}/comments`, { lane });
          const items = d.items || [];
          count = items.length;
          if (onCount) onCount(count);
          fill(list, items.length ? items.map(row) : h('p', { class: 'muted' }, 'No comments yet. Be the first.'));
          list.scrollTop = list.scrollHeight;
        } catch (e) { fill(list, h('p', { class: 'muted' }, e.message)); }
      }
      function row(c) {
        const cid = intOf(c.id);
        if (!cid) return null;
        const u = c.user || {};
        return h('div', { class: 'sg-comment' },
          avatar(u.avatar, u.name || u.username, lane, 32),
          h('div', { class: 'sg-comment-text' },
            h('span', null, h('b', null, u.name || u.username || 'unknown'), ' ', h('span', { class: 'muted small' }, ago(c.created_at))),
            h('p', null, captionNodes(c.body))),
          c.can_delete ? h('button', { type: 'button', class: 'sg-act', 'aria-label': 'Delete comment', title: 'Delete comment', onclick: async (e) => {
            const btn = e.currentTarget;
            if (!confirm('Delete this comment?')) return;
            btn.disabled = true;
            try { await call(`posts/${pid}/comments/${cid}`, { method: 'DELETE', lane }); await load(); } catch (err) { fail(err); btn.disabled = false; }
          } }, ic('trash', 18)) : null);
      }
      const form = h('form', { class: 'sg-comment-form', onsubmit: async (e) => {
        e.preventDefault();
        const body = text.value.trim();
        if (!body) return;
        send.disabled = true;
        try {
          await call(`posts/${pid}/comments`, { method: 'POST', body: { body }, lane });
          text.value = '';
          grow();
          await load();
        } catch (err) { fail(err); } finally { send.disabled = false; }
      } }, text, send);
      sheet('Comments', [list, form], { cls: 'sg-sheet-comments', focus: matchMedia('(pointer: coarse)').matches ? null : text });
      load();
    }

    async function collectionSheet(postId, lane) {
      const body = h('div', { class: 'sg-sheet-body' }, h('p', { class: 'muted' }, 'Loading ...'));
      sheet('Save to a collection', body);
      try {
        const [cols, mine] = await Promise.all([call('collections', { lane }), call(`posts/${postId}/collections`, { lane })]);
        const inSet = new Set(mine.items || []);
        const pid = intOf(postId);
        if (!pid) throw new Error('No such post');
        const rows = (cols.items || []).map((c) => {
          // Ids from Elitogram go into a path only as validated integers.
          const cid = intOf(c.id);
          if (!cid) return null;
          const box = h('input', { type: 'checkbox', checked: inSet.has(c.id) });
          box.addEventListener('change', async () => {
            box.disabled = true;
            try {
              if (box.checked) await call(`collections/${cid}/items`, { method: 'POST', body: { post_id: postId }, lane });
              else await call(`collections/${cid}/items/${postId}`, { method: 'DELETE', lane });
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
            const cid = intOf(c.id);
            if (!cid) throw new Error('Elitogram sent an unexpected answer');
            await call(`collections/${cid}/items`, { method: 'POST', body: { post_id: postId }, lane });
            say(`Saved to ${n}`);
            closeSheet();
          } catch (err) { fail(err); }
        } }, name, h('button', { type: 'submit', class: 'btn small' }, 'Create and save'));
        const shown = rows.filter(Boolean);
        fill(body, shown.length ? shown : h('p', { class: 'muted' }, 'No collections yet.'), form);
      } catch (e) {
        fill(body, h('p', { class: 'muted' }, e.message));
      }
    }

    // --- The full-screen viewer ----------------------------------------------------------
    // Opens from Photos and from any image in a post. Browser fullscreen where
    // the browser allows it (the page's own full-window view otherwise), the
    // original file at full quality (the thumbnail shows while it loads),
    // pinch, wheel and double-tap zoom, pan, swipe and prev/next, and the
    // post's menus (comments, share, open, download) inside the viewer.
    let viewerEl = null;
    let viewerKeys = null;
    let viewerFs = null;
    const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
    function exitFs() {
      if (!fsEl()) return;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(document)).catch(() => {});
    }
    function closeViewer() {
      if (!viewerEl) return;
      closeSheet();
      if (fsEl() === viewerEl) exitFs();
      for (const v of viewerEl.querySelectorAll('video')) v.pause();
      viewerEl.remove();
      viewerEl = null;
      document.removeEventListener('keydown', viewerKeys, true);
      document.removeEventListener('fullscreenchange', viewerFs);
      document.removeEventListener('webkitfullscreenchange', viewerFs);
      viewerKeys = null;
      viewerFs = null;
      document.documentElement.classList.remove('sg-viewer-open');
    }
    function openViewer(items, index, lane) {
      closeViewer();
      const list = (items || []).filter((it) => intOf(it.media_id));
      if (!list.length) return;
      let i = Math.max(0, Math.min(list.length - 1, index || 0));
      const MAX = 8;
      let s = 1;
      let tx = 0;
      let ty = 0;
      const stage = h('div', { class: 'sg-vstage' });
      const info = h('div', { class: 'sg-viewer-info' });
      const counter = h('span', { class: 'sg-viewer-count' });
      const resetBtn = h('button', { type: 'button', class: 'sg-viewer-btn', 'aria-label': 'Reset zoom', title: 'Reset zoom (0)', hidden: true, onclick: () => zoomTo(1) }, ic('reset', 22));
      const fsBtn = h('button', { type: 'button', class: 'sg-viewer-btn', 'aria-label': 'Full screen', title: 'Full screen (F)', onclick: () => toggleFs() }, ic('fullscreen', 22));
      let media = null; // the <img> or <video> on show
      let token = 0;

      const isImg = () => media && media.tagName === 'IMG';
      function apply() {
        if (!media) return;
        media.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
        viewerEl.classList.toggle('sg-zoomed', s > 1);
        resetBtn.hidden = s === 1;
      }
      // Keeps the image over the stage: no pan past its edges.
      function clampPan() {
        if (!media) return;
        const W = stage.clientWidth;
        const H = stage.clientHeight;
        const mx = Math.max(0, (media.offsetWidth * s - W) / 2);
        const my = Math.max(0, (media.offsetHeight * s - H) / 2);
        tx = Math.max(-mx, Math.min(mx, tx));
        ty = Math.max(-my, Math.min(my, ty));
      }
      // Zoom to `next`, keeping the screen point (px, py) where it is.
      function zoomTo(next, px, py) {
        if (!isImg()) return;
        next = Math.max(1, Math.min(MAX, next));
        const r = stage.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const ax = (px == null ? cx : px) - cx;
        const ay = (py == null ? cy : py) - cy;
        tx = ax - (next / s) * (ax - tx);
        ty = ay - (next / s) * (ay - ty);
        s = next;
        if (s === 1) { tx = 0; ty = 0; }
        clampPan();
        apply();
      }

      function paint() {
        const it = list[i];
        const my = ++token;
        s = 1; tx = 0; ty = 0;
        for (const v of stage.querySelectorAll('video')) v.pause();
        if (it.kind === 'video') {
          media = h('video', { src: mediaUrl(it.media_id, lane), poster: thumbUrl(it.media_id, lane, 1080), controls: true, playsinline: true, autoplay: true, 'data-media-bg': '1' });
        } else {
          // The thumbnail first, then the original file in full quality.
          media = h('img', { alt: '', src: thumbUrl(it.media_id, lane, 1080), draggable: 'false', 'data-media-bg': '1', class: 'sg-loading' });
          const full = new Image();
          full.onload = () => { if (my === token && media) { media.src = full.src; media.classList.remove('sg-loading'); } };
          full.onerror = () => { if (my === token && media) media.classList.remove('sg-loading'); };
          full.src = mediaUrl(it.media_id, lane);
        }
        fill(stage, media);
        apply();
        const pid = intOf(it.post_id);
        counter.textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
        fill(info,
          h('span', { class: 'sg-viewer-who' }, it.author_handle ? `@${it.author_handle}` : '', it.width && it.height ? h('span', { class: 'muted small' }, ` · ${it.width}×${it.height}`) : null),
          pid ? h('button', { type: 'button', class: 'sg-viewer-btn', 'aria-label': 'Comments', title: 'Comments', onclick: () => commentsSheet(pid, lane) }, ic('comment', 22)) : null,
          pid ? h('button', { type: 'button', class: 'sg-viewer-btn', 'aria-label': 'Share', title: 'Share', onclick: () => shareSheet(pid, lane) }, ic('share', 22)) : null,
          h('a', { class: 'sg-viewer-btn', href: mediaUrl(it.media_id, lane, { download: '1' }), download: '', 'aria-label': 'Download the original', title: 'Download the original' }, ic('download', 22)),
          pid ? h('a', { class: 'sg-viewer-btn', href: link(`post/${pid}`, lane === 'review' ? { lane: 'review' } : null), 'aria-label': 'Open the post', title: 'Open the post', onclick: closeViewer }, ic('external', 22)) : null);
        prevBtn.hidden = i === 0;
        nextBtn.hidden = i === list.length - 1;
        if (pid) call(`posts/${pid}/view`, { method: 'POST', lane }).catch(() => {});
      }
      const step = (d) => {
        const n = Math.max(0, Math.min(list.length - 1, i + d));
        if (n !== i) { i = n; paint(); }
      };
      const prevBtn = h('button', { type: 'button', class: 'sg-viewer-btn sg-viewer-side prev', 'aria-label': 'Previous', onclick: () => step(-1) }, ic('prev', 28));
      const nextBtn = h('button', { type: 'button', class: 'sg-viewer-btn sg-viewer-side next', 'aria-label': 'Next', onclick: () => step(1) }, ic('next', 28));

      function toggleFs() {
        if (fsEl()) { exitFs(); return; }
        const req = viewerEl.requestFullscreen || viewerEl.webkitRequestFullscreen;
        if (!req) { say('This browser has no full screen; the viewer fills the window'); return; }
        try {
          Promise.resolve(req.call(viewerEl, { navigationUI: 'hide' })).catch(() => say('Full screen was refused; the viewer fills the window'));
        } catch { say('Full screen was refused; the viewer fills the window'); }
      }
      viewerFs = () => {
        const on = fsEl() === viewerEl;
        fill(fsBtn, ic(on ? 'unfullscreen' : 'fullscreen', 22));
        fsBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
        requestAnimationFrame(() => { clampPan(); apply(); });
      };

      viewerEl = h('div', { class: 'sg-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Viewer' },
        stage,
        h('div', { class: 'sg-viewer-top' },
          counter,
          h('button', { type: 'button', class: 'sg-viewer-btn', 'aria-label': 'Zoom out', title: 'Zoom out (-)', onclick: () => zoomTo(s / 1.5) }, ic('zoomout', 22)),
          h('button', { type: 'button', class: 'sg-viewer-btn', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: () => zoomTo(s * 1.5) }, ic('zoomin', 22)),
          resetBtn, fsBtn,
          h('button', { type: 'button', class: 'sg-viewer-btn close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closeViewer }, ic('close', 24))),
        prevBtn, nextBtn, info);

      // Pointers: one finger pans a zoomed image or swipes between items,
      // two fingers pinch. Mouse drag pans too.
      const pts = new Map();
      let gesture = null;
      let lastTap = 0;
      const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      stage.addEventListener('pointerdown', (e) => {
        // The first finger must be on the image; a second may land anywhere.
        if (!isImg() || (!pts.size && e.target !== media)) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        stage.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          gesture = { kind: 'pinch', d0: dist(a, b), s0: s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        } else if (pts.size === 1) {
          gesture = { kind: s > 1 ? 'pan' : 'swipe', x0: e.clientX, y0: e.clientY, tx0: tx, ty0: ty, t0: Date.now(), moved: false };
        }
      });
      stage.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId) || !gesture) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (gesture.kind === 'pinch' && pts.size === 2) {
          const [a, b] = [...pts.values()];
          zoomTo(gesture.s0 * (dist(a, b) / gesture.d0), gesture.mx, gesture.my);
        } else if (gesture.kind === 'pan') {
          tx = gesture.tx0 + (e.clientX - gesture.x0);
          ty = gesture.ty0 + (e.clientY - gesture.y0);
          if (Math.abs(e.clientX - gesture.x0) + Math.abs(e.clientY - gesture.y0) > 6) gesture.moved = true;
          clampPan();
          apply();
        } else if (gesture.kind === 'swipe') {
          const dx = e.clientX - gesture.x0;
          if (Math.abs(dx) > 6) gesture.moved = true;
          media.style.transform = `translateX(${dx}px)`;
        }
      });
      const endPointer = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        const g = gesture;
        if (pts.size === 1 && g && g.kind === 'pinch') {
          // One finger left after a pinch: carry on as a pan.
          const [p] = [...pts.values()];
          gesture = { kind: 'pan', x0: p.x, y0: p.y, tx0: tx, ty0: ty, t0: Date.now(), moved: true };
          return;
        }
        if (pts.size) return;
        gesture = null;
        if (!g) return;
        if (g.kind === 'swipe') {
          const dx = e.clientX - g.x0;
          const dy = e.clientY - g.y0;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { step(dx < 0 ? 1 : -1); return; }
          apply();
        }
        // Double tap (touch) zooms in at the finger, or back out.
        if (!g.moved && e.pointerType !== 'mouse' && e.type === 'pointerup') {
          const now = Date.now();
          if (now - lastTap < 300) { lastTap = 0; zoomTo(s > 1 ? 1 : 2.5, e.clientX, e.clientY); } else lastTap = now;
        }
      };
      stage.addEventListener('pointerup', endPointer);
      stage.addEventListener('pointercancel', endPointer);
      stage.addEventListener('dblclick', (e) => { if (isImg() && e.target === media) zoomTo(s > 1 ? 1 : 2.5, e.clientX, e.clientY); });
      stage.addEventListener('wheel', (e) => {
        if (!isImg()) return;
        e.preventDefault();
        zoomTo(s * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX, e.clientY);
      }, { passive: false });
      // A click on the dark area around the image closes the viewer.
      stage.addEventListener('click', (e) => { if (e.target === stage && s === 1) closeViewer(); });

      viewerKeys = (e) => {
        // A sheet open in the viewer handles its own keys (Escape closes it first).
        if (sheetEl || !viewerEl) return;
        if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const k = e.key;
        if (k === 'Escape') {
          // In browser fullscreen the browser leaves fullscreen on Escape;
          // the viewer itself closes on the next one.
          if (fsEl()) return;
          e.preventDefault(); e.stopPropagation(); closeViewer();
        } else if (k === 'ArrowLeft' && s === 1) { e.preventDefault(); step(-1); }
        else if (k === 'ArrowRight' && s === 1) { e.preventDefault(); step(1); }
        else if (k === '+' || k === '=') { e.preventDefault(); zoomTo(s * 1.5); }
        else if (k === '-') { e.preventDefault(); zoomTo(s / 1.5); }
        else if (k === '0') { e.preventDefault(); zoomTo(1); }
        else if (k === 'f' || k === 'F') { e.preventDefault(); toggleFs(); }
      };
      document.addEventListener('keydown', viewerKeys, true);
      document.addEventListener('fullscreenchange', viewerFs);
      document.addEventListener('webkitfullscreenchange', viewerFs);
      document.documentElement.classList.add('sg-viewer-open');
      document.body.append(viewerEl);
      paint();
      // Browser fullscreen needs the click that opened the viewer, so it is asked for now.
      if (matchMedia('(pointer: coarse)').matches) toggleFs();
      viewerEl.querySelector('.sg-viewer-btn.close').focus({ preventScroll: true });
    }

    // --- Pages ---------------------------------------------------------------------
    function viewFeed() {
      const box = h('div', { class: 'sg-feed' });
      return [pageHead('Feed'), pager(box, (cur) => call(`feed${cur ? `?cursor=${enc(cur)}` : ''}`), (p) => postCard(p), { emptyText: 'No general posts yet. Classify creators in the Review lane to fill this feed.' })];
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
        q || kind ? null : cats,
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
          if (d.total != null) total.textContent = plural(d.total, 'post', 'posts');
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
          h('span', { class: 'muted small' }, plural(c.post_count, 'post', 'posts'))), { emptyText: 'No general creators yet.' }),
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
            h('p', { class: 'muted' }, `@${c.handle} · ${plural(c.post_count, 'post', 'posts')} · ${plural(c.follower_count, 'follower', 'followers')}`),
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
          h('b', null, c.name), h('span', { class: 'muted small' }, plural(c.count, 'post', 'posts')))) : empty('No collections yet. Save a post to one from its folder button.'));
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
        h('button', { type: 'button', class: 'btn small ghost danger', onclick: async () => {
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
        if (aud === 'general' && handles.length > 1 && !confirm(`Mark ${handles.length} creators general? Their posts show up in every Social & Photos page.`)) return;
        btn.disabled = true;
        // Grabbit takes at most 200 handles per request, so a large choice is sent in parts.
        const d = { updated: [], skipped: [], mirror_failed: [] };
        try {
          for (let i = 0; i < handles.length; i += 200) {
            const r = await fetch('/api/egram/creators-classify', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ handles: handles.slice(i, i + 200), audience: aud, lane: 'review' }),
            });
            const part = await r.json().catch(() => null);
            if (!r.ok || !part || part.ok === false) throw new Error((part && part.error) || `HTTP ${r.status}`);
            for (const k of Object.keys(d)) d[k].push(...(part[k] || []));
          }
          const skipped = d.skipped.length;
          const unsaved = d.mirror_failed.length;
          say(`${d.updated.length} classified ${aud === 'adult' ? '18+' : 'general'}${skipped ? `, ${skipped} skipped` : ''}${unsaved ? `, ${unsaved} not saved in Grabbit (try again)` : ''}`);
        } catch (err) {
          fail(d.updated.length ? new Error(`${err.message} (${d.updated.length} were classified before this)`) : err);
        } finally {
          btn.disabled = false;
          // Parts that went through are shown as done even when a later part failed.
          if (after && d.updated.length) after(d);
        }
      };
      return [
        h('button', { type: 'button', class: 'btn small', onclick: go('general') }, 'Mark general'),
        h('button', { type: 'button', class: 'btn small ghost danger', onclick: go('adult') }, 'Mark 18+'),
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
      // "Choose all shown" covers the creators loaded so far, not the whole lane.
      const all = h('input', { type: 'checkbox', 'aria-label': 'Choose all creators shown' });
      const picks = () => [...box.querySelectorAll('.sg-review-who input[type="checkbox"]')];
      const sync = () => {
        const shown = picks().length;
        count.textContent = `${selected.size} chosen`;
        all.checked = shown > 0 && selected.size === shown;
        all.indeterminate = selected.size > 0 && selected.size < shown;
      };
      all.addEventListener('change', () => {
        for (const p of picks()) {
          p.checked = all.checked;
          const hnd = p.closest('[data-handle]').dataset.handle;
          if (all.checked) selected.add(hnd); else selected.delete(hnd);
        }
        sync();
      });
      const bar = canClassify()
        ? h('div', { class: 'sg-review-bar' }, h('label', { class: 'sg-review-all small' }, all, 'Choose all shown'), count, classifyCreatorButtons(() => [...selected], (d) => {
          for (const hnd of d.updated || []) {
            const row = box.querySelector(`[data-handle="${CSS.escape(hnd)}"]`);
            if (row) row.remove();
            selected.delete(hnd);
          }
          sync();
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
            sync();
          });
          // A new page of rows arrives unchosen: "all" turns partial once it is in the list.
          queueMicrotask(sync);
          return h('div', { class: 'sg-review-item', 'data-handle': c.handle },
            h('label', { class: 'sg-review-who' }, pick, avatar(c.avatar, c.display_name || c.handle, 'review', 40),
              h('span', { class: 'sg-review-name' }, h('b', null, c.handle), h('span', { class: 'muted small' }, plural(c.post_count, 'post', 'posts')))),
            h('div', { class: 'sg-review-samples' }, (c.samples || []).map((t) => tile(t, 'review'))),
            h('a', { class: 'btn small ghost', href: link(`creator/${enc(c.handle)}`, { lane: 'review' }) }, 'All posts'));
        }, { emptyText: 'No unclassified creators left.' }),
      ];
    }

    // --- Upload --------------------------------------------------------------------
    // Elitogram's own upload (POST api/posts, multipart, streamed through the
    // gateway): the files are stored as sent, at original quality, in
    // Elitogram's library. One file is a single post, several are a carousel
    // in the order shown. Unclassified (the default) lands in the Review lane;
    // only an account that may classify can publish straight to general.
    const UPLOAD_SOFT_LIMIT = 100 * 1024 * 1024; // what Cloudflare passes per request
    const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
    function tagsOf(text) {
      const out = [];
      for (const raw of String(text || '').split(/[\s,]+/)) {
        const t = raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 100);
        if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
      }
      return out.slice(0, 30);
    }
    function viewUpload() {
      const gen = generation;
      const picked = []; // { file, url }
      onLeave(() => { for (const p of picked) URL.revokeObjectURL(p.preview); });
      const previews = h('div', { class: 'sg-up-list' });
      const total = h('p', { class: 'muted small', role: 'status' });
      const input = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', class: 'sg-up-input', id: 'sg-up-files' });
      const drop = h('label', { class: 'sg-up-drop', for: 'sg-up-files' }, ic('plus', 28), h('b', null, 'Choose photos or videos'), h('span', { class: 'muted small' }, 'or drop them here. Several files become one carousel post.'));
      function add(files) {
        for (const f of files) {
          if (!/^(image|video)\//.test(f.type)) { say(`${f.name} is not a photo or a video`); continue; }
          if (picked.length >= 50) { say('At most 50 files in one post'); break; }
          picked.push({ file: f, preview: URL.createObjectURL(f) });
        }
        paintList();
      }
      function move(i, d) {
        const j = i + d;
        if (j < 0 || j >= picked.length) return;
        [picked[i], picked[j]] = [picked[j], picked[i]];
        paintList();
      }
      function paintList() {
        fill(previews, picked.map((p, i) => h('div', { class: 'sg-up-item' },
          p.file.type.startsWith('video/')
            ? h('video', { src: p.preview, muted: true, playsinline: true, preload: 'metadata', 'data-media-bg': '1' })
            : h('img', { src: p.preview, alt: '', 'data-media-bg': '1' }),
          h('span', { class: 'sg-up-pos' }, String(i + 1)),
          h('div', { class: 'sg-up-tools' },
            h('button', { type: 'button', class: 'sg-act', 'aria-label': `Move ${p.file.name} earlier`, disabled: i === 0, onclick: () => move(i, -1) }, ic('prev', 18)),
            h('button', { type: 'button', class: 'sg-act', 'aria-label': `Remove ${p.file.name}`, onclick: () => { URL.revokeObjectURL(p.preview); picked.splice(i, 1); paintList(); } }, ic('close', 18)),
            h('button', { type: 'button', class: 'sg-act', 'aria-label': `Move ${p.file.name} later`, disabled: i === picked.length - 1, onclick: () => move(i, 1) }, ic('next', 18))))));
        const bytes = picked.reduce((n, p) => n + p.file.size, 0);
        total.textContent = picked.length
          ? `${plural(picked.length, 'file', 'files')}, ${fmtBytes(bytes)}${picked.length > 1 ? ' · one carousel post' : ''}${bytes > UPLOAD_SOFT_LIMIT ? ' · over 100 MB: through Cloudflare this may be refused, upload fewer files at a time' : ''}`
          : 'No files chosen.';
        send.disabled = !picked.length;
      }
      input.addEventListener('change', () => { add(input.files); input.value = ''; });
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('sg-over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('sg-over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('sg-over'); add(e.dataTransfer.files); });

      // Creator: empty posts as the account itself. Suggestions come from
      // both lanes the account may see; Elitogram resolves the name.
      const u = me() || {};
      const creator = h('input', { type: 'text', list: 'sg-up-creators', maxlength: '80', autocomplete: 'off', placeholder: `Empty: posted as @${u.username || 'you'}`, 'aria-label': 'Creator' });
      const options = h('datalist', { id: 'sg-up-creators' });
      let timer = null;
      creator.addEventListener('input', () => {
        clearTimeout(timer);
        const q = creator.value.trim().replace(/^@/, '');
        if (q.length < 2) return;
        timer = setTimeout(async () => {
          const ask = (lane) => call(`creators?q=${enc(q)}`, { lane }).then((d) => d.items || []).catch(() => []);
          const [a, b] = await Promise.all([ask(null), ask('review')]);
          if (!live(gen)) return;
          const seen = new Set();
          fill(options, [...a, ...b].filter((c) => c && typeof c.handle === 'string' && !seen.has(c.handle) && seen.add(c.handle)).slice(0, 20)
            .map((c) => h('option', { value: c.handle }, c.display_name && c.display_name !== c.handle ? c.display_name : null)));
        }, 250);
      });
      onLeave(() => clearTimeout(timer));
      const desc = h('textarea', { rows: '4', maxlength: '4000', placeholder: 'Description', 'aria-label': 'Description' });
      const tags = h('input', { type: 'text', maxlength: '600', placeholder: 'beach, summer, travel', 'aria-label': 'Tags' });
      const audience = h('select', { 'aria-label': 'Classification' },
        h('option', { value: '' }, 'Unclassified: goes to the Review lane'),
        canClassify() ? h('option', { value: 'general' }, 'General: shown in Social & Photos') : null,
        h('option', { value: 'adult' }, '18+: stored in Elitogram, never shown in Grabbit'));
      const bar = h('progress', { max: '100', value: '0', class: 'sg-up-bar', hidden: true });
      const status = h('div', { class: 'sg-up-status', role: 'status', 'aria-live': 'polite' });
      const send = h('button', { type: 'submit', class: 'btn', disabled: true }, 'Upload');
      const cancel = h('button', { type: 'button', class: 'btn ghost', hidden: true }, 'Cancel');
      let xhr = null;
      onLeave(() => { if (xhr) xhr.abort(); });

      // Where did the new post land? The gateway does not say; each lane is
      // asked through the normal checks.
      async function landing(id) {
        try { await call(`posts/${id}`); return 'general'; } catch { /* not general */ }
        try { await call(`posts/${id}`, { lane: 'review' }); return 'review'; } catch { /* not in review */ }
        return 'hidden';
      }
      const form = h('form', { class: 'sg-form sg-upload', onsubmit: (e) => {
        e.preventDefault();
        if (!picked.length || xhr) return;
        const tagList = tagsOf(tags.value);
        const caption = [desc.value.trim(), tagList.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n');
        const fd = new FormData();
        // Text fields first, then the files in the order shown.
        if (creator.value.trim()) fd.append('creator', creator.value.trim().replace(/^@/, ''));
        fd.append('caption', caption);
        if (audience.value) fd.append('audience', audience.value);
        for (const p of picked) fd.append('files', p.file, p.file.name);
        xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/egram/api/posts');
        xhr.setRequestHeader('accept', 'application/json');
        xhr.responseType = 'json';
        const busy = (on) => { send.disabled = on; cancel.hidden = !on; bar.hidden = !on; for (const el of form.querySelectorAll('input, textarea, select, .sg-up-tools button')) el.disabled = on; };
        busy(true);
        bar.value = 0;
        fill(status, h('span', null, 'Uploading ...'));
        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          const pct = Math.round((ev.loaded / ev.total) * 100);
          bar.value = pct;
          fill(status, h('span', null, pct < 100 ? `Uploading ${pct} % (${fmtBytes(ev.loaded)} of ${fmtBytes(ev.total)})` : 'Elitogram is storing the files ...'));
        };
        const done = () => { xhr = null; busy(false); paintList(); };
        xhr.onerror = () => { done(); fill(status, h('p', { class: 'sg-up-err' }, 'The upload was cut off. Nothing was posted if Elitogram did not answer; try again.')); };
        xhr.onabort = () => { done(); fill(status, h('p', { class: 'muted' }, 'Upload cancelled.')); };
        xhr.onload = async () => {
          const d = xhr.response && typeof xhr.response === 'object' ? xhr.response : null;
          const code = xhr.status;
          done();
          if (code === 401) { loadSession(true); fill(status, h('p', { class: 'sg-up-err' }, 'Signed out of Elitogram. Link the account again.')); return; }
          if (code === 413) { fill(status, h('p', { class: 'sg-up-err' }, 'Too large for one request. Upload fewer or smaller files at a time.')); return; }
          if (code !== 201 || !d || !intOf(d.id)) { fill(status, h('p', { class: 'sg-up-err' }, (d && d.error) || `Elitogram answered ${code}`)); return; }
          const id = intOf(d.id);
          const rejected = Array.isArray(d.rejected) ? d.rejected : [];
          for (const p of picked) URL.revokeObjectURL(p.preview);
          picked.length = 0;
          paintList();
          desc.value = '';
          tags.value = '';
          fill(status, h('p', null, 'Uploaded. Checking where it landed ...'));
          const where = await landing(id);
          if (!live(gen)) return;
          fill(status,
            where === 'general' ? h('p', null, 'Published in Social & Photos. ', h('a', { href: link(`post/${id}`) }, 'Open the post'))
              : where === 'review' ? h('p', null, 'Waiting in the Review lane until it is classified. ', h('a', { href: link(`post/${id}`, { lane: 'review' }) }, 'Open it in Review'))
                : h('p', null, 'Stored in Elitogram. It is not shown in Grabbit (18+ or under an 18+ creator).'),
            rejected.length ? h('div', { class: 'sg-up-err' }, h('p', null, `Elitogram refused ${plural(rejected.length, 'file', 'files')}:`),
              h('ul', null, rejected.map((r) => h('li', null, `${r.name}: ${r.reason}`)))) : null);
        };
        cancel.onclick = () => { if (xhr) xhr.abort(); };
        xhr.send(fd);
      } },
        drop, input, total, previews,
        h('label', null, 'Creator', creator, options),
        h('label', null, 'Description', desc),
        h('label', null, 'Tags', tags, h('span', { class: 'muted small' }, 'Separated by spaces or commas. They are added to the caption as #tags.')),
        h('label', null, 'Classification', audience),
        h('div', { class: 'sg-inline' }, send, cancel),
        bar, status);
      paintList();
      return [pageHead('Upload'), form];
    }

    // --- Notifications ------------------------------------------------------------------
    // Elitogram's notifications, scoped by the gateway: nothing about an 18+
    // creator or post reaches this list. Opening the page marks them read.
    function viewNotifications() {
      const box = h('div', { class: 'sg-notes' }, h('p', { class: 'muted' }, 'Loading ...'));
      const gen = generation;
      call('notifications').then((d) => {
        if (!live(gen)) return;
        const items = d.items || [];
        fill(box, items.length ? items.map((n) => {
          const pid = intOf(n.post_id);
          const href = pid ? link(`post/${pid}`) : n.creator_handle && /^[a-z0-9._~-]{1,100}$/i.test(n.creator_handle) ? link(`creator/${enc(String(n.creator_handle).toLowerCase())}`) : null;
          const body = [avatar(n.actor_avatar, n.text, null, 36),
            h('span', { class: 'sg-note-text' }, h('span', null, n.text || n.kind || ''), h('span', { class: 'muted small' }, ago(n.created_at)))];
          return href
            ? h('a', { class: `sg-note${n.read_at ? '' : ' sg-unread'}`, href }, body)
            : h('div', { class: `sg-note${n.read_at ? '' : ' sg-unread'}` }, body);
        }) : empty('No notifications.'));
        // Only the ones shown here: the gateway may have left some out of the list.
        const unread = items.filter((n) => !n.read_at).map((n) => intOf(n.id)).filter(Boolean).slice(0, 500);
        if (unread.length) call('notifications/read', { method: 'POST', body: { ids: unread } }).catch(() => {});
      }).catch((e) => { if (live(gen)) fill(box, empty(e.message)); });
      return [pageHead('Notifications'), box];
    }

    // --- Settings --------------------------------------------------------------------
    // What daily use needs from Elitogram's settings. The rest stays in
    // standalone Elitogram on purpose (listed on the page).
    function viewSettings() {
      const u = (S.session && S.session.user) || {};
      const name = h('input', { type: 'text', maxlength: '120', autocomplete: 'name', value: u.display_name || '' });
      const bio = h('textarea', { rows: '4', maxlength: '1000' });
      bio.value = u.bio || '';
      const profileMsg = h('p', { class: 'muted small', role: 'status' });
      const profile = h('form', { class: 'sg-form', onsubmit: async (e) => {
        e.preventDefault();
        const btn = profile.querySelector('button');
        btn.disabled = true;
        profileMsg.textContent = '';
        try {
          await call('me', { method: 'PATCH', body: { display_name: name.value.trim(), bio: bio.value } });
          profileMsg.textContent = 'Saved.';
          loadSession(true);
        } catch (err) { profileMsg.textContent = err.message; } finally { btn.disabled = false; }
      } }, h('h2', null, 'Profile'),
        h('label', null, 'Display name', name),
        h('label', null, 'Bio', bio),
        h('div', { class: 'sg-inline' }, h('button', { type: 'submit', class: 'btn small' }, 'Save profile')), profileMsg);

      const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: '200' });
      const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '200' });
      const again = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '200' });
      const passMsg = h('p', { class: 'muted small', role: 'status' });
      const password = h('form', { class: 'sg-form', onsubmit: async (e) => {
        e.preventDefault();
        passMsg.textContent = '';
        if (next.value !== again.value) { passMsg.textContent = 'The new passwords do not match.'; return; }
        const btn = password.querySelector('button');
        btn.disabled = true;
        try {
          await call('me/password', { method: 'POST', body: { current: cur.value, password: next.value } });
          cur.value = ''; next.value = ''; again.value = '';
          passMsg.textContent = 'Password changed. Other Elitogram sessions stay signed in until they expire.';
        } catch (err) { passMsg.textContent = err.message; } finally { btn.disabled = false; }
      } }, h('h2', null, 'Elitogram password'),
        h('label', null, 'Current password', cur),
        h('label', null, 'New password (at least 8 characters)', next),
        h('label', null, 'New password again', again),
        h('div', { class: 'sg-inline' }, h('button', { type: 'submit', class: 'btn small' }, 'Change password')), passMsg);

      const linked = h('section', { class: 'sg-form' }, h('h2', null, 'Linked account'),
        h('p', null, 'Linked as ', h('b', null, u.display_name || u.username || '?'), u.username ? ` (@${u.username})` : '', u.can_classify ? ' · may classify' : ''),
        h('p', { class: 'muted small' }, 'Grabbit keeps only the Elitogram session, sealed in a cookie for this site. Your password is not stored.'),
        h('div', { class: 'sg-inline' }, h('button', { type: 'button', class: 'btn small ghost', onclick: async (e) => {
          e.currentTarget.disabled = true;
          await fetch('/api/egram/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
          S.session = undefined;
          loadSession(true);
        } }, 'Unlink')));

      const standalone = h('section', { class: 'sg-form' }, h('h2', null, 'Only in standalone Elitogram'),
        h('p', { class: 'muted small' }, 'These stay in Elitogram itself, on purpose: they touch 18+ material, other people\'s accounts or the library on disk.'),
        h('ul', { class: 'sg-plain' },
          h('li', null, 'Stories'),
          h('li', null, 'Push notifications on this device'),
          h('li', null, '18+ material, its PIN and unlock'),
          h('li', null, 'Profile picture upload'),
          h('li', null, 'Creator management: aliases, linked accounts, merges, renames'),
          h('li', null, 'Duplicates, import management and the library on disk'),
          h('li', null, 'Administration: users, permissions, badges, restoring deleted posts')));
      return [pageHead('Settings'), h('div', { class: 'sg-settings' }, profile, password, linked, standalone)];
    }

    // --- Account ---------------------------------------------------------------------
    function viewAccount() {
      const s = S.session || {};
      if (s.linked) return viewSettings();
      const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, maxlength: '100' });
      const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: '1024' });
      const msg = h('p', { class: 'muted small', role: 'status' });
      const form = h('form', { class: 'sg-link', onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button');
        btn.disabled = true;
        msg.textContent = '';
        // Where the page was when the form was sent. The re-render after a link
        // starts a new generation, so live(gen) cannot tell whether the user
        // went elsewhere meanwhile; the address can.
        const from = location.hash;
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
          if (location.hash === from) location.hash = BASE;
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
      ['upload', 'Upload'],
      ['notifications', 'Notifications'],
      ['settings', 'Settings'],
    ];
    const SECTION_OF = { tag: 'explore', search: 'explore', creator: 'creators', collection: 'collections', post: '', account: 'settings' };
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
      } else if (!S.session.linked || first === 'account' || first === 'settings') {
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
          case 'upload': body = viewUpload(r); break;
          case 'notifications': body = viewNotifications(r); break;
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
