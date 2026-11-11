'use strict';
// Grabbit 2.0 hub: a second front end over the same API as the classic
// interface at /. Every number on screen comes from the server; a feature that
// is not built yet says so instead of showing a placeholder value.
(() => {
  // --- Small helpers -------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);

  // Builds DOM without innerHTML, so site-supplied text never becomes markup.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') throw new Error('no html');
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    download: 'M12 3v12m0 0-5-5m5 5 5-5M4 19h16',
    queue: 'M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4',
    media: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4',
    video: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4',
    audio: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    profiles: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M17 11a3 3 0 1 0 0-6M22 21v-1a5 5 0 0 0-4-4.9',
    dupes: 'M8 8h12v12H8zM4 16V4h12',
    convert: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16',
    tags: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01',
    share: 'M14 5l7 7-7 7M21 12H9a6 6 0 0 0-6 6v1',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.9.2 7 7 0 0 1-1.6.9 1.7 1.7 0 0 0-1.1 1.5V23H9v-.2a1.7 1.7 0 0 0-1.1-1.5 7 7 0 0 1-1.6-.9 1.7 1.7 0 0 0-1.9-.2l-.2.1-2-3.4.1-.1a1.7 1.7 0 0 0 .3-1.8 7 7 0 0 1 0-1.8 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2-3.4.2.1a1.7 1.7 0 0 0 1.9-.2 7 7 0 0 1 1.6-.9A1.7 1.7 0 0 0 9 1.2V1h4v.2a1.7 1.7 0 0 0 1.1 1.5 7 7 0 0 1 1.6.9 1.7 1.7 0 0 0 1.9.2l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.8 7 7 0 0 1 0 1.8z',
    link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
    pulse: 'M3 12h4l3-8 4 16 3-8h4',
    inbox: 'M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z',
    review: 'M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11',
    sites: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    play: 'M8 5v14l11-7z',
    close: 'M6 6l12 12M18 6 6 18',
    prev: 'M15 5l-7 7 7 7',
    next: 'M9 5l7 7-7 7',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
    zoomin: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6M11 8v6',
    zoomout: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
    fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name] || ICONS.media);
    svg.append(p);
    return svg;
  }

  const nf = new Intl.NumberFormat('en-US');
  const num = (n) => nf.format(Number(n) || 0);
  function ago(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  function bytes(n) {
    if (!Number.isFinite(n)) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
  }
  // Site thumbnails go through Grabbit's proxy: their CDNs refuse a foreign Referer.
  // A picture Grabbit took itself (a video frame) is already a local /api/thumb?id= path.
  const thumbSrc = (u) => {
    const s = String(u || '');
    if (/^https?:\/\//i.test(s)) return '/api/thumb?url=' + encodeURIComponent(s);
    if (/^\/api\/thumb\?id=local-[0-9a-f]{40}$/.test(s)) return s;
    return null;
  };
  // Signed CDN links expire; a picture that can no longer be fetched gives way
  // to the empty placeholder instead of a broken-image icon.
  const dropBrokenImg = (e) => {
    const img = e.currentTarget;
    const parent = img.parentNode;
    img.remove();
    if (parent && parent.classList && parent.classList.contains('tile')) parent.classList.add('no-thumb');
  };
  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^(www|m|music)\./, '').replace(/\.com$/, ''); } catch { return ''; }
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  async function api(path, opts) {
    const r = await fetch(path, { credentials: 'same-origin', ...opts });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    let d;
    try { d = await r.json(); } catch { throw new Error(`HTTP ${r.status}`); }
    if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }
  const post = (path) => api(path, { method: 'POST' });

  // --- State ---------------------------------------------------------------
  const state = {
    summary: null,
    health: null,
    config: null,
    history: null,
    media: null,
    mediaMisses: null,
    jobs: new Map(),
    review: null,
    inbox: null,
  };
  const ACTIVE = new Set(['queued', 'running', 'scheduled']);
  const activeJobs = () => [...state.jobs.values()].filter((j) => ACTIVE.has(j.status)).sort((a, b) => a.createdAt - b.createdAt);
  const allJobs = () => [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);

  async function load(what) {
    const tasks = {
      summary: () => api('/api/hub/summary').then((d) => { state.summary = d; }),
      health: () => api('/api/health').then((d) => { state.health = d; }),
      config: () => api('/api/config').then((d) => { state.config = d; }),
      history: () => api('/api/history').then((d) => { state.history = d.items || []; }),
      media: () => api('/api/hub/media').then((d) => { state.media = d.items || []; state.mediaMisses = d.misses || []; }),
      review: () => api('/api/hub/review').then((d) => { state.review = d; }),
      inbox: () => api('/api/hub/inbox?limit=1').then((d) => { state.inbox = d; }),
      jobs: () => api('/api/jobs').then((d) => { state.jobs = new Map((d.jobs || []).map((j) => [j.id, j])); }),
    };
    await Promise.all(what.map((k) => tasks[k]().catch((e) => { console.warn(`hub: ${k} failed`, e); })));
  }

  // --- Live job stream -----------------------------------------------------
  let stream = null;
  let renderQueued = false;
  function connectStream() {
    if (stream) return;
    stream = new EventSource('/api/jobs/stream');
    stream.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d.type !== 'job' || !d.job) return;
      const prev = state.jobs.get(d.job.id);
      state.jobs.set(d.job.id, d.job);
      // A finished download changes the counts and the recent list.
      if (d.job.status === 'done' && prev && prev.status !== 'done') load(['summary', 'history', 'media']).then(scheduleRender);
      scheduleRender();
    };
    // A closed stream (container restart) never reopens by itself.
    stream.onerror = () => {
      if (stream.readyState !== EventSource.CLOSED) return;
      stream = null;
      setTimeout(connectStream, 5000);
    };
  }
  // Job events arrive many times a second during a download; repaint once per frame.
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      updateNav();
      const r = route();
      if (r.live) render(false);
    });
  }

  // --- Navigation ----------------------------------------------------------
  const PAGES = [
    { id: '', label: 'Dashboard', icon: 'home', live: true, view: viewDashboard },
    { id: 'download', label: 'Download', icon: 'download', view: viewDownload },
    { id: 'queue', label: 'Queue & jobs', icon: 'queue', badge: () => activeJobs().length, live: true, view: viewQueue },
    { id: 'media', label: 'Media', icon: 'media', view: viewMedia },
    { id: 'profiles', label: 'Profiles', icon: 'profiles', view: viewProfiles },
    { id: 'review', label: 'Review', icon: 'review', badge: () => (state.review ? state.review.creators.unclassified : 0), view: viewReview },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', badge: () => (state.inbox && state.inbox.counts ? state.inbox.counts.held || 0 : 0), view: viewInbox },
    { id: 'duplicates', label: 'Duplicates', icon: 'dupes', ownData: true, view: viewDuplicates },
    { id: 'conversion', label: 'Conversion', icon: 'convert', view: viewConversion },
    { id: 'metadata', label: 'Metadata & tags', icon: 'tags', ownData: true, view: viewMetadata },
    { id: 'distribution', label: 'Distribution', icon: 'share', view: viewDistribution },
    { id: 'settings', label: 'Settings', icon: 'settings', view: viewSettings },
  ];
  function route() {
    const [id, query] = location.hash.replace(/^#\/?/, '').split('?');
    const page = PAGES.find((p) => p.id === id) || PAGES[0];
    return { ...page, params: new URLSearchParams(query || '') };
  }
  function buildNav() {
    const nav = $('#nav');
    nav.replaceChildren(
      ...PAGES.map((p) =>
        h('a', { href: `#/${p.id}`, 'data-page': p.id }, icon(p.icon), h('span', null, p.label),
          p.badge ? h('span', { class: 'badge', hidden: true }) : null,
          p.planned ? h('span', { class: 'tag' }, 'planned') : null)
      )
    );
  }
  function updateNav() {
    const cur = route().id;
    for (const a of document.querySelectorAll('#nav a')) {
      const p = PAGES.find((x) => x.id === a.dataset.page);
      if (p.id === cur) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
      const b = a.querySelector('.badge');
      if (b) {
        const n = p.badge();
        b.textContent = n;
        b.hidden = !n;
      }
    }
  }
  // The route without the viewer's `open` parameter.
  function pageKey() {
    const r = route();
    const q = new URLSearchParams(r.params);
    q.delete('open');
    return `${r.id}?${q}`;
  }
  let renderedKey = null;
  function render(focus = true) {
    renderedKey = pageKey();
    const r = route();
    const view = $('#view');
    // Views return a node or a list with gaps (null/false) like h() children.
    view.replaceChildren(...[r.view(r.params)].flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    updateNav();
    if (focus) {
      view.focus({ preventScroll: true });
      closeMenu();
    }
  }

  // --- Shared pieces -------------------------------------------------------
  function card(title, iconName, more, ...body) {
    return h('section', { class: 'card' },
      h('h2', null, iconName ? icon(iconName) : null, title, more ? h('a', { href: more.href }, more.label) : null),
      ...body);
  }

  // Where a link can be saved, from what this deploy has configured.
  function destinations() {
    const cfg = state.config || {};
    const out = [{ value: 'server', label: 'Server library', q: { dest: 'server' } }];
    const ch = cfg.channels || [];
    if (ch.includes('platform')) out.unshift({ value: 'platform', label: 'Platform inbox (social app)', q: { dest: 'elite', channel: 'platform' }, platform: true });
    if (ch.includes('main')) out.push({ value: 'main', label: 'Tikshortis (shorts)', q: { dest: 'elite', channel: 'main' }, shorts: true });
    out.push({ value: 'navidrome', label: 'Music library (audio)', q: { dest: 'navidrome' } });
    out.push({ value: 'audiobooks', label: 'Audiobooks (audio)', q: { dest: 'audiobooks' } });
    // Adshortis is its own destination, listed apart from every general one
    // and only when the server reports it configured and separate.
    if (ch.includes('18plus')) out.push({ value: '18plus', label: 'Adshortis (18+ shorts)', q: { dest: 'elite', channel: '18plus' }, shorts: true, adult: true });
    return out;
  }
  const DEST_KEY = 'grabbit.hub.dest';

  // The form survives live repaints (job events re-render the dashboard), so
  // a half-typed link is not wiped. It is rebuilt on navigation only.
  let grabCache = null;
  function grabForm(opts) {
    // The destinations come from /api/config, which loads after the first
    // paint: a form built before it must be rebuilt once it is there.
    const key = `${route().id}:${state.config ? 'cfg' : 'none'}`;
    if (grabCache && grabCache.key === key) return grabCache.el;
    grabCache = { key, el: buildGrabForm(opts) };
    return grabCache.el;
  }
  function buildGrabForm({ big }) {
    const dests = destinations();
    // An 18+ destination is never restored as the default: it is chosen on
    // purpose, every time.
    const saved = localStorage.getItem(DEST_KEY);
    const opt = (d) => h('option', { value: d.value, selected: !d.adult && d.value === saved }, d.label);
    const general = dests.filter((d) => !d.adult);
    const adult = dests.filter((d) => d.adult);
    const select = h('select', { class: 'field', 'aria-label': 'Save to' },
      adult.length
        ? [h('optgroup', { label: 'General' }, general.map(opt)), h('optgroup', { label: '18+ only' }, adult.map(opt))]
        : general.map(opt));
    const webBox = h('input', { type: 'checkbox' });
    const webLabel = h('label', null, webBox, ' Web copy (H.264/AAC) next to the original');
    const adultBox = h('input', { type: 'checkbox' });
    const adultLabel = h('label', { class: 'adult-confirm' }, adultBox, ' This link is 18+ content for Adshortis');
    const syncDest = () => {
      const d = dests.find((x) => x.value === select.value);
      webLabel.hidden = !(d && d.shorts);
      adultLabel.hidden = !(d && d.adult);
      adultBox.checked = false;
    };
    select.addEventListener('change', () => {
      const d = dests.find((x) => x.value === select.value);
      if (d && !d.adult) localStorage.setItem(DEST_KEY, select.value);
      syncDest();
    });
    syncDest();
    const input = h('input', { type: 'url', required: true, placeholder: 'Paste a link (Facebook, TikTok, Instagram, YouTube ...)', 'aria-label': 'Link' });
    const button = h('button', { class: 'btn', type: 'submit' }, icon('download'), 'Add');
    const advanced = h('a', { href: '/classic/' }, 'Advanced options in the classic view');
    input.addEventListener('input', () => {
      advanced.href = input.value ? '/share?url=' + encodeURIComponent(input.value) : '/classic/';
    });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const d = dests.find((x) => x.value === select.value) || dests[0];
        if (d.adult && !adultBox.checked) return toast('Confirm that this link is 18+ content first');
        const q = new URLSearchParams({ url: input.value.trim(), device: '0', ...d.q });
        if (d.shorts && webBox.checked) q.set('web', '1');
        button.disabled = true;
        try {
          await api('/api/jobs/start?' + q.toString());
          connectStream();
          input.value = '';
          adultBox.checked = false;
          toast(`Queued for ${d.label}`);
        } catch (err) {
          toast(err.message);
        } finally {
          button.disabled = false;
        }
      },
    }, h('span', { class: 'field-wrap', style: 'display:contents' }, input), select, button);
    const sites = ((state.summary && state.summary.sites) || []).slice(0, 8);
    return h('section', { class: 'card grab' },
      big ? h('h2', null, icon('link'), 'Add a link') : null,
      form,
      h('div', { class: 'grab-foot' },
        adultLabel,
        webLabel,
        sites.length ? h('span', { class: 'sites' }, 'Most used:', sites.map((s) => h('span', { class: 'chip' }, s.site))) : null,
        advanced));
  }

  function jobRow(j, withActions) {
    const pct = Number.isFinite(j.percent) ? Math.round(j.percent) : null;
    const where = j.channel && j.dest === 'elite' ? `${j.dest}/${j.channel}` : j.dest || '';
    const status =
      j.status === 'error' ? h('span', { class: 'err' }, j.error || 'Failed')
      : j.status === 'done' ? `Done ${ago(j.doneAt)}${where ? ' - ' + where : ''}`
      : j.status === 'scheduled' ? `Scheduled ${j.at ? new Date(j.at).toLocaleString() : ''}`
      : [j.phase || j.status, pct !== null ? ` ${pct} %` : '', j.speed ? ` - ${j.speed}` : '', j.eta ? ` - ${j.eta} left` : ''].join('');
    const src = thumbSrc(j.thumbnail);
    const acts = h('div', { class: 'acts' });
    if (withActions && ACTIVE.has(j.status)) {
      acts.append(h('button', { class: 'btn ghost small', onclick: () => post(`/api/jobs/${encodeURIComponent(j.id)}/cancel`).catch((e) => toast(e.message)) }, 'Cancel'));
    }
    // A general app refused it because nobody has classified the creator yet:
    // one click classifies this one item general by hand and sends it again.
    if (withActions && j.status === 'error' && / is a general app and the audience of .* is not classified/.test(j.error || '')) {
      acts.append(h('button', {
        class: 'btn small',
        title: 'Marks only this item as general (not the creator) and retries the job',
        onclick: (e) => {
          const btn = e.currentTarget; // currentTarget is gone once the promise settles
          const who = j.creator ? `"${j.creator}"` : 'this item';
          if (!confirm(`Classify this item from ${who} as general (OK for general apps) and send it again?`)) return;
          btn.disabled = true;
          jsonPost(`/api/jobs/${encodeURIComponent(j.id)}/classify-retry`, {})
            .then(() => { toast('Classified general - retrying'); return load(['review']).then(updateNav); })
            .catch((err) => { btn.disabled = false; toast(err.message); });
        },
      }, 'Classify general & retry'));
    }
    if (withActions && (j.status === 'error' || j.status === 'cancelled')) {
      acts.append(h('button', { class: 'btn small', onclick: () => post(`/api/jobs/${encodeURIComponent(j.id)}/retry`).then(() => toast('Retrying')).catch((e) => toast(e.message)) }, 'Retry'));
    }
    return h('div', { class: 'job' },
      src ? h('img', { class: 'thumb', src, alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.replaceWith(h('div', { class: 'thumb' })) }) : h('div', { class: 'thumb' }),
      h('div', { style: 'min-width:0' },
        h('div', { class: 't' }, [j.creator, j.title].filter(Boolean).join(' - ') || 'Resolving link ...'),
        h('div', { class: 's' }, status),
        ACTIVE.has(j.status) && pct !== null ? h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null),
      acts);
  }

  // A tile opens the media viewer for its history entry. `query` is the Media
  // page's own filter, so next/previous in the viewer walks the same list.
  function tile(it, query) {
    const src = thumbSrc(it.thumbnail);
    const site = hostOf(it.sourceUrl);
    const q = new URLSearchParams(query || '');
    q.set('open', it.id);
    return h('a', { class: `tile${src ? '' : ' no-thumb'}`, 'data-kind': it.kind || null, href: `#/media?${q}`, title: [it.creator, it.title].filter(Boolean).join(' - ') },
      src ? h('img', { src, alt: '', loading: 'lazy', 'data-media-bg': '1', onerror: dropBrokenImg }) : null,
      site ? h('span', { class: 'chip site' }, site) : null,
      it.audience === 'adult' ? h('span', { class: 'chip adult aud' }, '18+') : null,
      it.kind === 'video' ? h('span', { class: 'play', 'aria-hidden': 'true' }, icon('play')) : null,
      h('span', { class: 'cap' }, it.title || it.filename || ''));
  }

  // /api/health sends tools as [{ name, version }]; the views look them up as
  // { ytdlp, ffmpeg, ... }. Accept both shapes.
  function toolVersions(hl) {
    const raw = hl && hl.tools;
    if (!raw) return {};
    if (!Array.isArray(raw)) return raw;
    const out = {};
    for (const t of raw) {
      if (t && t.name) out[String(t.name).replace(/-/g, '')] = t.version || (t.ok === false ? null : 'ok');
    }
    return out;
  }

  function healthRows() {
    const hl = state.health;
    if (!hl) return [h('li', { class: 'empty' }, 'Loading ...')];
    const tv = toolVersions(hl);
    const tool = (name, v) => h('li', null, h('span', { class: `dot ${v ? 'ok' : 'bad'}` }), name, h('span', { class: `v ${v ? 'ok-t' : 'bad-t'}` }, v || 'missing'));
    const badDests = (hl.dests || []).filter((d) => !d.exists || !d.writable || d.unreachable);
    const rows = [
      tool('yt-dlp', tv.ytdlp),
      tool('ffmpeg (conversion)', tv.ffmpeg),
      tool('gallery-dl', tv.gallerydl),
      h('li', null, h('span', { class: `dot ${badDests.length ? 'warn' : 'ok'}` }), 'Save locations',
        h('span', { class: `v ${badDests.length ? 'warn-t' : 'ok-t'}` }, badDests.length ? `${badDests.length} need attention` : 'all writable')),
      h('li', null, h('span', { class: `dot ${hl.retry && hl.retry.queued ? 'warn' : 'ok'}` }), 'Retry queue', h('span', { class: 'v' }, num(hl.retry && hl.retry.queued))),
    ];
    const st = state.summary && state.summary.storage;
    if (st && st.size) {
      const used = Math.round(((st.size - st.free) / st.size) * 100);
      rows.push(h('li', { style: 'display:block' },
        h('div', { style: 'display:flex;gap:10px;align-items:center' }, h('span', { class: `dot ${used > 90 ? 'bad' : used > 75 ? 'warn' : 'ok'}` }), 'Download storage', h('span', { class: 'v' }, `${used} %`)),
        h('div', { class: 'meter' }, h('i', { style: `width:${used}%` })),
        h('small', { style: 'color:var(--muted)' }, `${bytes(st.free)} free of ${bytes(st.size)}`)));
    }
    return rows;
  }

  // Shorts/platform save locations, as the health check reports them.
  // adult=true lists the 18+ app only, adult=false every general one, and
  // no argument lists both (the dashboard summary).
  const isAdultRoute = (d) => /18\+/.test(d.label);
  function routeRows(adult) {
    const dests = ((state.health && state.health.dests) || [])
      .filter((d) => /^(shorts|platform|posts)/.test(d.label) && (adult === undefined || isAdultRoute(d) === adult));
    if (!state.health) return [h('li', { class: 'empty' }, 'Loading ...')];
    if (!dests.length) return [h('li', { class: 'empty' }, adult ? 'Adshortis is not configured on this server.' : 'No app destinations are configured on this server.')];
    return dests.map((d) => {
      const good = d.exists && d.writable && !d.unreachable && !d.blocked;
      return h('li', { title: d.blocked || null }, h('span', { class: `dot ${good ? 'ok' : 'bad'}` }), d.label,
        h('span', { class: `v ${good ? 'ok-t' : 'bad-t'}` }, d.blocked ? 'blocked' : d.unreachable ? 'unreachable' : !d.exists ? 'missing' : !d.writable ? 'read-only' : 'ready'));
    });
  }

  // --- Views ---------------------------------------------------------------
  function viewDashboard() {
    const s = state.summary;
    const k = (s && s.kinds) || {};
    const stat = (iconName, value, label, href, extra) =>
      h('a', { class: 'stat', href }, icon(iconName), h('span', null, h('b', null, s ? num(value) : '-'), h('small', null, label), extra));
    const active = activeJobs();
    const recent = (state.media || []).slice(0, 6);
    return [
      h('h1', null, 'Welcome back'),
      h('p', { class: 'lead' }, 'Grabbit 2.0 - one place to download, sort, convert and hand media to your apps.'),
      h('div', { class: 'grid-dash' },
        h('div', { class: 'col' },
          h('div', { class: 'stats' },
            stat('download', s && s.files, 'Files', '#/media', s && s.addedToday ? h('span', { class: 'up' }, `+${num(s.addedToday)} today`) : null),
            stat('video', k.video, 'Videos', '#/media?kind=video'),
            stat('media', k.image, 'Images', '#/media?kind=image'),
            stat('audio', k.audio, 'Audio', '#/media?kind=audio'),
            stat('profiles', s && s.creators, 'Creators', '#/profiles'),
            stat('sites', s && s.sites.length, 'Sources', '#/distribution')),
          grabForm({ big: false }),
          h('div', { class: 'two' },
            card(`Active queue (${active.length})`, 'queue', { href: '#/queue', label: 'Show all' },
              active.length ? h('div', { class: 'jobs' }, active.slice(0, 4).map((j) => jobRow(j, true))) : h('p', { class: 'empty' }, 'Nothing is downloading right now.')),
            card('Recently downloaded', 'media', { href: '#/media', label: 'Show all' },
              recent.length ? h('div', { class: 'tiles' }, recent.map((it) => tile(it))) : h('p', { class: 'empty' }, state.media ? 'No downloads in the history yet.' : 'Loading ...'))),
          card('Workflow in Grabbit', 'pulse', null, h('div', { class: 'flow' },
            flowStep('download', 'Import', 'Fetch media', '#/download'),
            flowStep('dupes', 'Duplicate check', 'Avoid copies', '#/duplicates'),
            flowStep('tags', 'Metadata', 'Captions, tags', '#/metadata'),
            flowStep('convert', 'Conversion', 'Web copies', '#/conversion'),
            flowStep('profiles', 'Profiles', 'Creators', '#/profiles'),
            flowStep('share', 'Distribution', 'To the right app', '#/distribution')))),
        h('div', { class: 'col aside' },
          card('Profiles', 'profiles', { href: '#/profiles', label: 'Show all' },
            h('p', { style: 'margin:0' }, s ? `${num(s.creators)} creators named in file names` : 'Loading ...'),
            h('p', { class: 'empty', style: 'padding-bottom:0' }, 'Link platform accounts, merge and split on the Profiles page.')),
          card('App routing', 'share', { href: '#/distribution', label: 'Details' }, h('ul', { class: 'rows' }, routeRows())),
          card('System status', 'pulse', { href: '#/settings', label: 'Details' }, h('ul', { class: 'rows' }, healthRows())))),
    ];
  }
  function flowStep(iconName, title, sub, href) {
    return h('a', { href }, icon(iconName), h('b', null, title), h('small', null, sub));
  }

  function viewDownload() {
    return [
      h('h1', null, 'Download'),
      h('p', { class: 'lead' }, 'Paste a link and choose where it goes. Profiles, playlists, formats and scheduling are in the classic view for now.'),
      grabForm({ big: true }),
      h('div', { style: 'height:18px' }),
      card('Supported sources in use', 'sites', null,
        state.summary && state.summary.sites.length
          ? h('table', null, h('thead', null, h('tr', null, h('th', null, 'Source'), h('th', { class: 'num' }, 'Files'))),
            h('tbody', null, state.summary.sites.map((s) => h('tr', null, h('td', null, s.site), h('td', { class: 'num' }, num(s.count))))))
          : h('p', { class: 'empty' }, 'Nothing downloaded yet.')),
    ];
  }

  function viewQueue() {
    const jobs = allJobs();
    const finished = jobs.filter((j) => !ACTIVE.has(j.status));
    return [
      h('h1', null, 'Queue & jobs'),
      h('p', { class: 'lead' }, `${activeJobs().length} active, ${finished.length} finished in this session. Status is live.`),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn ghost', disabled: !finished.length, onclick: () => post('/api/jobs/clear').then(() => load(['jobs'])).then(() => render(false)).catch((e) => toast(e.message)) }, 'Clear finished')),
      jobs.length ? h('div', { class: 'jobs' }, jobs.map((j) => jobRow(j, true))) : h('p', { class: 'empty' }, 'No jobs since the server started.'),
    ];
  }

  // The Media page's list for a set of filters. The viewer steps through the
  // same list, so next/previous never leaves the audience or kind on screen.
  function mediaList(params) {
    const kind = params.get('kind') || '';
    const aud = params.get('aud') || '';
    const q = (params.get('q') || '').toLowerCase();
    const profile = Number(params.get('profile')) || 0;
    return (state.media || [])
      .filter((it) => !profile || it.profileId === profile)
      .filter((it) => !kind || it.kind === kind)
      .filter((it) => !aud || it.audience === aud)
      .filter((it) => !q || [it.creator, it.title, it.filename].join(' ').toLowerCase().includes(q));
  }

  // With no audience chosen the page shows each audience in a section of its
  // own, so 18+ never sits between general items. Anything not classified as
  // general or adult gets its own section rather than joining General.
  const MEDIA_GROUPS = [['general', 'General'], ['adult', '18+'], ['unknown', 'Unclassified']];
  const mediaGroup = (it) => (it.audience === 'adult' || it.audience === 'general' ? it.audience : 'unknown');

  // A no-file entry: the error it failed with, and, when its item has been
  // classified general by hand since, a button that sends it again.
  function missState(it) {
    if (!it.resend) return h('div', { class: 'bad-t' }, it.error || 'No file was saved.');
    const button = h('button', {
      class: 'btn small',
      onclick: () => {
        button.disabled = true;
        jsonPost(`/api/hub/media/${encodeURIComponent(it.id)}/resend`, {})
          .then(() => { connectStream(); toast(`Sending again to ${it.app}`); })
          .catch((err) => { button.disabled = false; toast(err.message); });
      },
    }, `Send again to ${it.app}`);
    return h('div', null,
      h('div', { class: 'muted small' }, `${it.app} refused it as unclassified. It has been classified general by hand since, but not sent again.`),
      button);
  }

  function viewMedia(params) {
    const kind = params.get('kind') || '';
    const aud = params.get('aud') || '';
    const q = (params.get('q') || '').toLowerCase();
    // History entries without a file are refused or failed attempts, not media.
    // They stay out of the grid, but the newest ones are named above it so the
    // latest download never just goes missing.
    const misses = state.mediaMisses || [];
    const items = mediaList(params);
    const query = new URLSearchParams(params);
    query.delete('open');
    const withParam = (k, v) => {
      const n = new URLSearchParams(query);
      if (v) n.set(k, v);
      else n.delete(k);
      return `#/media${n.toString() ? '?' + n : ''}`;
    };
    const tab = (k, label) => h('a', { class: `btn small ${kind === k ? '' : 'ghost'}`, href: withParam('kind', k) }, label);
    const audSelect = h('select', {
      class: 'field small',
      'aria-label': 'Audience',
      onchange: (e) => { location.hash = withParam('aud', e.currentTarget.value); },
    },
    [['', 'All audiences'], ['general', 'General'], ['adult', '18+'], ['unknown', 'Unclassified']]
      .map(([v, label]) => h('option', { value: v, selected: v === aud }, label)));
    return [
      h('h1', null, 'Media'),
      h('p', { class: 'lead' }, 'The latest downloads from the history log. Click one to play or view it here.'),
      h('div', { class: 'toolbar' }, tab('', 'All'), tab('video', 'Videos'), tab('image', 'Images'), tab('audio', 'Audio'), audSelect,
        q ? h('span', { class: 'chip' }, `Search: ${q}`) : null),
      misses.length
        ? h('div', { class: 'note warn-note' },
            h('strong', null, misses.length === 1 ? 'The newest download has no file:' : `The ${misses.length} newest downloads have no file:`),
            h('ul', null, misses.map((it) => h('li', null,
              h('span', null, [it.creator, it.title].filter(Boolean).join(' - ') || it.sourceUrl || 'Unknown item'),
              ' ', h('span', { class: 'muted' }, `(${ago(it.time)})`),
              missState(it)))))
        : null,
      !items.length
        ? h('p', { class: 'empty' }, state.media ? 'Nothing matches.' : 'Loading ...')
        : aud
          ? h('div', { class: 'media-grid' }, items.map((it) => tile(it, query)))
          : h('div', { class: 'media-sections' }, MEDIA_GROUPS.map(([g, label]) => {
            const part = items.filter((it) => mediaGroup(it) === g);
            return part.length
              ? h('section', { class: `media-section aud-${g}` },
                h('h2', null, label, ' ', h('span', { class: 'muted' }, `(${part.length})`)),
                h('div', { class: 'media-grid' }, part.map((it) => tile(it, query))))
              : null;
          })),
    ];
  }

  // --- Media viewer --------------------------------------------------------
  // A full-screen layer over the Media page, driven by the `open` parameter:
  // the back button closes it, and a link to it opens the same item. The file
  // is fetched by entry id and variant; the server decides where it lives.
  const viewer = { el: null, id: null, detail: null, variant: null, seq: 0, zoom: null };
  const fmtDuration = (s) => {
    if (!Number.isFinite(s)) return '';
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const fileUrl = (id, v, download) => `/api/hub/media/${encodeURIComponent(id)}/file?v=${v}${download ? '&download=1' : ''}`;

  function viewerNeighbours() {
    const r = route();
    let list = mediaList(r.params);
    // Under "All audiences" next/previous stays inside the item's own section.
    const cur = list.find((it) => it.id === viewer.id);
    if (cur && !r.params.get('aud')) list = list.filter((it) => mediaGroup(it) === mediaGroup(cur));
    const i = list.findIndex((it) => it.id === viewer.id);
    return { list, i, prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
  }
  // Stepping replaces the history entry, so one back press closes the viewer.
  function viewerGo(it) {
    if (!it) return;
    const r = route();
    const q = new URLSearchParams(r.params);
    q.set('open', it.id);
    location.replace(`#/media?${q}`);
  }
  let viewerPushed = false;
  function viewerClose() {
    if (viewerPushed) return history.back();
    const q = new URLSearchParams(route().params);
    q.delete('open');
    location.replace(`#/${route().id}${q.toString() ? '?' + q : ''}`);
  }

  function syncViewer() {
    const r = route();
    const id = r.id === 'media' ? r.params.get('open') : null;
    if (!id) {
      if (viewer.el) {
        viewer.el.remove();
        viewer.el = null;
        viewer.id = null;
        document.body.classList.remove('viewer-open');
        viewerPushed = false;
      }
      return;
    }
    if (viewer.el && viewer.id === id) return;
    viewer.id = id;
    viewer.detail = null;
    viewer.variant = null;
    if (!viewer.el) {
      viewer.el = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media viewer' });
      document.body.append(viewer.el);
      document.body.classList.add('viewer-open');
    }
    drawViewer();
    const seq = ++viewer.seq;
    api(`/api/hub/media/${encodeURIComponent(id)}`)
      .then((d) => {
        if (seq !== viewer.seq) return;
        viewer.detail = d.item;
        const vs = d.item.variants || [];
        // The web copy is made for browsers and phones; the original is the
        // choice when there is no copy, or when the original plays as it is.
        const web = vs.find((v) => v.variant === 'web');
        const orig = vs.find((v) => v.variant === 'original');
        viewer.variant = (web && (!orig || orig.playable !== 'yes' || orig.bytes > web.bytes * 1.5) ? web : orig || web || {}).variant || null;
        drawViewer();
      })
      .catch((e) => {
        if (seq !== viewer.seq) return;
        viewer.detail = { error: e.message };
        drawViewer();
      });
  }

  function drawViewer() {
    const el = viewer.el;
    if (!el) return;
    const fromList = (state.media || []).find((it) => it.id === viewer.id) || null;
    const d = viewer.detail;
    const it = (d && !d.error ? d : null) || fromList || {};
    const nb = viewerNeighbours();
    const title = [it.creator, it.title].filter(Boolean).join(' - ') || it.filename || 'Media';
    const btn = (label, iconName, onclick, attrs) =>
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, title: label, onclick, ...(attrs || {}) }, icon(iconName));
    const prevBtn = btn('Previous', 'prev', () => viewerGo(nb.prev), { class: 'icon-btn nav-btn prev', disabled: !nb.prev });
    const nextBtn = btn('Next', 'next', () => viewerGo(nb.next), { class: 'icon-btn nav-btn next', disabled: !nb.next });

    const stage = h('div', { class: 'v-stage' });
    viewer.zoom = null;
    if (!d) {
      stage.append(h('p', { class: 'muted' }, 'Loading ...'));
    } else if (d.error) {
      stage.append(h('p', { class: 'bad-t' }, d.error));
    } else {
      const cur = (d.variants || []).find((v) => v.variant === viewer.variant);
      const poster = d.poster ? fileUrl(d.id, 'poster') : thumbSrc(d.thumbnail);
      if (!cur) {
        stage.append(h('div', { class: 'v-missing' },
          poster ? h('img', { src: poster, alt: '', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : null,
          h('p', null, 'The file is not on this server any more.'),
          h('p', { class: 'muted' }, d.channel === '18plus' || d.channel === 'platform'
            ? 'This app takes the file out of its drop folder when it imports it.'
            : d.kind === 'audio' ? 'Audio is played in the music or audiobook library.' : 'It was moved or deleted after the download.')));
      } else if (cur.kind === 'video') {
        const video = h('video', {
          src: fileUrl(d.id, cur.variant),
          controls: true,
          playsinline: true,
          preload: 'metadata',
          poster: poster || null,
          'data-media-bg': '1',
        });
        video.addEventListener('error', () => {
          if (!video.error) return;
          const other = (d.variants || []).find((v) => v.variant !== cur.variant && v.kind === 'video');
          stage.append(h('p', { class: 'v-err' }, 'This browser cannot play this file.', other ? ' Try the other copy below.' : ' Download it to play it elsewhere.'));
        });
        stage.append(video);
        if (cur.playable === 'no') stage.append(h('p', { class: 'v-err' }, `${cur.format.toUpperCase()} with ${cur.videoCodec || 'this codec'} may not play in a browser.`));
        // Autoplay only with sound off is allowed everywhere; leave it to the user.
      } else if (cur.kind === 'image') {
        stage.append(imageZoom(fileUrl(d.id, cur.variant), title));
      } else if (cur.kind === 'audio') {
        stage.append(h('div', { class: 'v-audio' },
          poster ? h('img', { src: poster, alt: '', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }) : icon('audio'),
          h('audio', { src: fileUrl(d.id, cur.variant), controls: true, preload: 'metadata' })));
      }
    }
    swipe(stage);

    el.replaceChildren(
      h('header', { class: 'v-top' },
        btn('Close', 'close', viewerClose),
        h('div', { class: 'v-title' }, h('strong', null, title),
          h('small', null, nb.i >= 0 ? `${nb.i + 1} of ${nb.list.length}` : '', it.audience === 'adult' ? ' - 18+' : '')),
        viewer.zoom ? h('div', { class: 'v-zoom' },
          btn('Zoom out', 'zoomout', () => viewer.zoom.step(1 / 1.5)),
          btn('Reset zoom', 'fit', () => viewer.zoom.reset()),
          btn('Zoom in', 'zoomin', () => viewer.zoom.step(1.5))) : null,
        btn('Details', 'info', () => el.classList.toggle('info-open'), { class: 'icon-btn info-btn' })),
      h('div', { class: 'v-body' },
        h('div', { class: 'v-media' }, prevBtn, stage, nextBtn),
        h('aside', { class: 'v-info' }, d && !d.error ? viewerInfo(d) : null)));
  }

  function viewerInfo(d) {
    const cur = (d.variants || []).find((v) => v.variant === viewer.variant);
    const row = (k, ...v) => (v.flat().some((x) => x !== null && x !== undefined && x !== '') ? h('div', { class: 'kv' }, h('dt', null, k), h('dd', null, ...v)) : null);
    const res = cur && cur.width && cur.height ? `${cur.width} x ${cur.height}` : '';
    const profile = d.profileId
      ? h('a', { href: `#/profiles?id=${d.profileId}` }, 'Open profile')
      : d.creator ? h('a', { href: `#/profiles?q=${encodeURIComponent(d.creator)}` }, 'Find profile') : null;
    return [
      h('dl', null,
        row('Creator', d.creator || '', profile ? [' ', profile] : null),
        row('Title', d.title || ''),
        row('Platform', d.site || d.extractor || ''),
        row('Original URL', d.sourceUrl ? h('a', { href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer', class: 'break' }, d.sourceUrl) : ''),
        row('Saved to', d.place || ''),
        row('Downloaded', d.time ? new Date(d.time).toLocaleString() : ''),
        row('Classification', audienceChip(d.audience), d.reasons && d.reasons.length ? h('div', { class: 'muted small' }, d.reasons.join('; ')) : null),
        cur ? [
          row('File', h('span', { class: 'break' }, cur.name)),
          row('Format', [cur.format.toUpperCase(), cur.videoCodec, cur.audioCodec].filter(Boolean).join(' / ')),
          row('Size', bytes(cur.bytes)),
          row('Resolution', res),
          cur.kind === 'image' ? null : row('Duration', fmtDuration(cur.duration)),
        ] : null),
      (d.variants || []).length > 1
        ? h('div', { class: 'v-variants' }, h('span', { class: 'muted' }, 'Copy:'),
            d.variants.map((v) => h('button', {
              type: 'button',
              class: `btn small ${v.variant === viewer.variant ? '' : 'ghost'}`,
              onclick: () => { viewer.variant = v.variant; drawViewer(); },
            }, v.variant === 'web' ? `Web copy (${bytes(v.bytes)})` : `Original (${bytes(v.bytes)})`)))
        : null,
      cur ? h('p', null, h('a', { class: 'btn small ghost', href: fileUrl(d.id, cur.variant, true) }, 'Download file')) : null,
    ];
  }

  // Zoom and pan for a picture: wheel, double click or double tap, pinch, drag.
  function imageZoom(src, alt) {
    const img = h('img', { src, alt, draggable: 'false', 'data-media-bg': '1' });
    const box = h('div', { class: 'v-zoombox' }, img);
    let scale = 1;
    let x = 0;
    let y = 0;
    const apply = () => {
      if (scale <= 1.001) { scale = 1; x = 0; y = 0; }
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      box.classList.toggle('zoomed', scale > 1);
    };
    // Zoom around a point given in box coordinates (the centre when omitted).
    const zoomAt = (factor, cx, cy) => {
      const rect = box.getBoundingClientRect();
      const px = (cx === undefined ? rect.width / 2 : cx) - rect.width / 2;
      const py = (cy === undefined ? rect.height / 2 : cy) - rect.height / 2;
      const next = Math.min(8, Math.max(1, scale * factor));
      const k = next / scale;
      x = px - (px - x) * k;
      y = py - (py - y) * k;
      scale = next;
      apply();
    };
    viewer.zoom = { step: (f) => zoomAt(f), reset: () => { scale = 1; apply(); }, zoomed: () => scale > 1 };
    box.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    // A double tap is handled in pointerdown; the dblclick the browser then
    // synthesises from the same taps would undo it.
    let lastPointer = 'mouse';
    box.addEventListener('dblclick', (e) => {
      if (lastPointer === 'touch') return;
      const r = box.getBoundingClientRect();
      if (scale > 1) { scale = 1; apply(); } else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top);
    });
    // Pointer events cover mouse, pen and touch: one pointer pans, two pinch.
    const pts = new Map();
    let pinch = null;
    let lastTap = 0;
    box.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType;
      box.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
      }
      if (e.pointerType === 'touch' && pts.size === 1) {
        const now = Date.now();
        if (now - lastTap < 300) {
          const r = box.getBoundingClientRect();
          if (scale > 1) { scale = 1; apply(); } else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top);
          lastTap = 0;
        } else lastTap = now;
      }
    });
    box.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const r = box.getBoundingClientRect();
        const target = pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist);
        zoomAt(target / scale, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      } else if (pts.size === 1 && scale > 1) {
        x += dx;
        y += dy;
        apply();
      }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    return box;
  }

  // A horizontal swipe on the stage steps to the next or previous item, unless
  // a picture is zoomed in (then the finger pans) or the touch starts on the
  // video's own control bar.
  function swipe(stage) {
    let start = null;
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || (viewer.zoom && viewer.zoom.zoomed())) { start = null; return; }
      const t = e.touches[0];
      const v = stage.querySelector('video');
      if (v) {
        const r = v.getBoundingClientRect();
        if (t.clientY > r.bottom - 70) { start = null; return; }
      }
      start = { x: t.clientX, y: t.clientY, at: Date.now() };
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (!start || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const quick = Date.now() - start.at < 600;
      start = null;
      if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const nb = viewerNeighbours();
      viewerGo(dx < 0 ? nb.next : nb.prev);
    }, { passive: true });
  }

  document.addEventListener('keydown', (e) => {
    if (!viewer.el || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    if (e.key === 'Escape') { e.preventDefault(); viewerClose(); return; }
    // On a focused video the arrows seek; elsewhere they step through the list.
    if (tag === 'VIDEO' || tag === 'AUDIO') return;
    const nb = viewerNeighbours();
    if (e.key === 'ArrowRight') { e.preventDefault(); viewerGo(nb.next); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); viewerGo(nb.prev); }
    else if (viewer.zoom && (e.key === '+' || e.key === '=')) viewer.zoom.step(1.5);
    else if (viewer.zoom && e.key === '-') viewer.zoom.step(1 / 1.5);
    else if (viewer.zoom && e.key === '0') viewer.zoom.reset();
  });
  // A click on a tile pushes the viewer's history entry; close then goes back.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.tile');
    if (a && !e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) viewerPushed = true;
  });

  // --- Profiles ------------------------------------------------------------
  const jsonPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // 'general', 'adult' or 'unknown' (not classified by hand yet).
  const audienceChip = (a) =>
    h('span', { class: `chip ${a === 'adult' ? 'adult' : a === 'unknown' ? 'unclassified' : ''}` },
      a === 'adult' ? '18+' : a === 'unknown' ? 'unclassified' : 'general');
  const webHref = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
  function skippedNote(r) {
    if (!r.skipped || !r.skipped.length) return '';
    const why = [...new Set(r.skipped.map((x) => x.reason))].join('; ');
    return ` ${r.skipped.length} skipped (${why}).`;
  }
  const accountLabel = (a) => `${a.platform} @${a.handle}`;
  const accountKey = (a) => `${a.platform}:${a.handle.toLowerCase()}`;

  // No picture is stored for a profile, so show a round badge: the first letter
  // of the name on a colour derived from it. The same name always looks the same.
  function avatar(p, big) {
    const name = String(p.name || '?').trim();
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const letter = (Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0] || '?').toUpperCase();
    return h('span', { class: `avatar${big ? ' big' : ''}`, style: `background:hsl(${hash % 360} 45% 38%)`, 'aria-hidden': 'true' }, letter);
  }

  function viewProfiles(params) {
    if (params.get('id')) return viewProfile(params.get('id'));
    const box = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    const input = h('input', { class: 'field', type: 'search', placeholder: 'Filter by name, alias or handle', value: params.get('q') || '' });
    const aud = h('select', { class: 'field' },
      h('option', { value: '' }, 'All audiences'), h('option', { value: 'general' }, 'General'), h('option', { value: 'adult' }, '18+'));
    const picked = new Map(); // id -> profile
    const mergeBar = h('div', { class: 'mergebar', hidden: true });
    let timer;

    function paintMergeBar() {
      const list = [...picked.values()];
      mergeBar.hidden = list.length < 2;
      if (list.length < 2) return mergeBar.replaceChildren();
      const mixed = new Set(list.map((p) => p.audience)).size > 1;
      const target = h('select', { class: 'field' }, list.map((p) => h('option', { value: p.id }, `${p.name} (#${p.id})`)));
      const go = h('button', { class: 'btn small', type: 'button', disabled: mixed, onclick: async () => {
        const t = Number(target.value);
        const sources = list.map((p) => p.id).filter((id) => id !== t);
        if (!confirm(`Merge ${sources.length} profile(s) into "${picked.get(t).name}"? Their aliases and accounts move; nothing on disk changes. A merge can be undone with split.`)) return;
        go.disabled = true;
        try {
          await jsonPost('/api/hub/profiles/merge', { target: t, sources });
          toast('Merged');
          picked.clear();
          location.hash = `#/profiles?id=${t}`;
        } catch (e) { toast(e.message); go.disabled = false; }
      } }, 'Merge');
      mergeBar.replaceChildren(
        h('b', null, `${list.length} selected`),
        mixed ? h('span', { class: 'bad-t' }, 'General and 18+ profiles are never merged.') : h('span', null, 'Merge into'),
        mixed ? null : target, mixed ? null : go,
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { picked.clear(); fill(); } }, 'Clear'));
    }

    const fill = async () => {
      try {
        const d = await api(`/api/hub/profiles?limit=300&audience=${aud.value}&q=${encodeURIComponent(input.value)}`);
        box.replaceChildren(
          h('p', { class: 'empty' }, `${num(d.total)} profiles${d.total > d.items.length ? `, showing the top ${d.items.length}` : ''}. ${num(d.counts.general)} general, ${num(d.counts.adult)} 18+, ${num(d.counts.linked)} with linked accounts.`),
          h('div', { class: 'scroll-x' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Profile'), h('th', null, 'Accounts'), h('th', { class: 'num' }, 'Aliases'), h('th', { class: 'num' }, 'Files'), h('th', null, 'Latest'))),
            h('tbody', null, d.items.map((p) => h('tr', null,
              h('td', null, h('input', { type: 'checkbox', 'aria-label': `Select ${p.name}`, checked: picked.has(p.id), onchange: (e) => { if (e.target.checked) picked.set(p.id, p); else picked.delete(p.id); paintMergeBar(); } })),
              h('td', null, h('span', { class: 'who' }, avatar(p), h('a', { href: `#/profiles?id=${p.id}` }, p.name)), ' ', p.status !== 'general' ? audienceChip(p.status) : null),
              h('td', null, p.accounts.length ? p.accounts.map((a) => h('span', { class: 'chip' }, accountLabel(a))) : h('span', { class: 'muted' }, p.sites.join(', '))),
              h('td', { class: 'num' }, num(p.aliases.length)),
              h('td', { class: 'num' }, num(p.files)),
              h('td', null, ago(p.lastAt))))))));
        paintMergeBar();
      } catch (e) {
        box.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(fill, 250); });
    aud.addEventListener('change', fill);
    fill();
    return [
      h('h1', null, 'Profiles'),
      h('p', { class: 'lead' }, 'One profile per creator: linked platform accounts plus the creator names found in downloaded files.'),
      h('p', { class: 'note' }, 'Every creator name in a file name belongs to exactly one profile. Merge and split only move names and accounts between profiles; no file is renamed or moved. General and 18+ profiles are kept apart.'),
      h('div', { class: 'toolbar', style: 'margin-top:14px' }, input, aud),
      h('div', { class: 'toolbar' }, newProfileForm()),
      mergeBar,
      box,
    ];
  }

  function newProfileForm() {
    const name = h('input', { class: 'field', placeholder: 'New profile name', maxlength: 100 });
    // No default audience: choosing one is a permission decision.
    const aud = h('select', { class: 'field', 'aria-label': 'Audience' },
      h('option', { value: '' }, 'Audience ...'), h('option', { value: 'general' }, 'General'), h('option', { value: 'adult' }, '18+'));
    return h('form', { class: 'inline', onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim() || !aud.value) return toast('Give the profile a name and choose its audience');
      try {
        const d = await jsonPost('/api/hub/profiles', { name: name.value, audience: aud.value });
        location.hash = `#/profiles?id=${d.profile.id}`;
      } catch (err) { toast(err.message); }
    } }, name, aud, h('button', { class: 'btn small ghost', type: 'submit' }, 'Create'));
  }

  function viewProfile(id) {
    const box = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    (async () => {
      try {
        const d = await api(`/api/hub/profiles/${encodeURIComponent(id)}`);
        box.replaceChildren(...profileDetail(d.profile, d.platforms));
      } catch (e) {
        box.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    })();
    return [h('p', null, h('a', { class: 'back', href: '#/profiles' }, '← All profiles')), box];
  }

  function profileDetail(p, platforms) {
    const datalist = h('datalist', { id: 'platformList' }, platforms.map((x) => h('option', { value: x })));
    const name = h('input', { class: 'field', value: p.name, maxlength: 100, 'aria-label': 'Name' });
    const note = h('textarea', { class: 'field', rows: 3, maxlength: 1000, placeholder: 'Note (who this is, why profiles were merged ...)', 'aria-label': 'Note' }, p.note || '');
    const rows = h('div', { class: 'acc-rows' });
    const addRow = (a = {}) => {
      const row = h('div', { class: 'acc-row' },
        h('input', { class: 'field plat', list: 'platformList', placeholder: 'platform', value: a.platform || '', 'aria-label': 'Platform' }),
        h('input', { class: 'field', placeholder: 'handle', value: a.handle || '', 'aria-label': 'Handle' }),
        h('input', { class: 'field', type: 'url', placeholder: 'https://profile link (optional)', value: a.url || '', 'aria-label': 'Profile link' }),
        a.source ? h('small', { class: 'muted', title: a.addedAt ? new Date(a.addedAt).toLocaleString() : '' }, a.source) : h('small', { class: 'muted' }, 'new'),
        h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Remove account', onclick: () => row.remove() }, 'Remove'));
      rows.append(row);
    };
    p.accounts.forEach(addRow);
    const save = h('button', { class: 'btn', type: 'submit' }, 'Save');
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const accounts = [...rows.children].map((r) => {
        const [plat, handle, url] = r.querySelectorAll('input');
        return { platform: plat.value.trim(), handle: handle.value.trim(), url: url.value.trim() || null };
      }).filter((a) => a.platform || a.handle || a.url);
      save.disabled = true;
      try {
        const d = await jsonPost(`/api/hub/profiles/${p.id}`, { name: name.value, note: note.value, accounts });
        toast('Saved');
        $('#view').replaceChildren(h('p', null, h('a', { class: 'back', href: '#/profiles' }, '← All profiles')), ...profileDetail(d.profile, platforms));
      } catch (err) { toast(err.message); save.disabled = false; }
    } },
      h('h2', null, icon('link'), 'Profile and linked accounts'),
      h('label', { class: 'lbl' }, 'Name', name),
      h('label', { class: 'lbl' }, 'Note', note),
      h('div', { class: 'lbl' }, 'Accounts'),
      rows,
      datalist,
      h('div', { class: 'toolbar', style: 'margin-top:10px' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => addRow() }, 'Add account'),
        save));

    // Split: pick aliases and accounts to move to a new profile.
    const splitName = h('input', { class: 'field', placeholder: 'Name of the new profile', maxlength: 100 });
    const aliasBoxes = p.aliases.map((a) => ({ a, box: h('input', { type: 'checkbox', 'aria-label': `Move ${a.name}` }) }));
    const accBoxes = p.accounts.map((a) => ({ a, box: h('input', { type: 'checkbox', 'aria-label': `Move ${accountLabel(a)}` }) }));
    const splitBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
      const aliases = aliasBoxes.filter((x) => x.box.checked).map((x) => x.a.name);
      const accounts = accBoxes.filter((x) => x.box.checked).map((x) => accountKey(x.a));
      if (!aliases.length && !accounts.length) return toast('Tick the names or accounts to move');
      if (!splitName.value.trim()) return toast('Name the new profile');
      splitBtn.disabled = true;
      try {
        const d = await jsonPost(`/api/hub/profiles/${p.id}/split`, { name: splitName.value, aliases, accounts });
        toast(`Split into #${d.profile.id}`);
        location.hash = `#/profiles?id=${d.profile.id}`;
      } catch (err) { toast(err.message); splitBtn.disabled = false; }
    } }, 'Split off');

    return [
      profileHeader(p),
      classifyBar(p),
      profileGallery(p),
      h('p', { class: 'lead' },
        `#${p.id} · ${num(p.files)} files · ${p.sites.length ? p.sites.join(', ') : 'no files yet'}`,
        p.lastAt ? ` · latest ${ago(p.lastAt)}` : '',
        p.origin === 'registry' ? ' · created from file names' : p.origin === 'manual' ? ' · created by hand' : p.origin.startsWith('split:') ? ` · split from #${p.origin.slice(6)}` : '',
        p.mergedFrom.length ? ` · merged from #${p.mergedFrom.join(', #')}` : ''),
      h('div', { class: 'two' },
        form,
        card('Names in file names', 'profiles', null,
          p.aliases.length
            ? h('ul', { class: 'rows' }, aliasBoxes.map(({ a, box }) => h('li', null, h('label', { class: 'pick' }, box, a.name), h('span', { class: 'v' }, `${num(a.files)} files${a.lastAt ? ' · ' + ago(a.lastAt) : ''}`))))
            : h('p', { class: 'empty' }, 'None. Merge a profile in to give this one its files.'),
          accBoxes.length ? h('ul', { class: 'rows', style: 'margin-top:8px' }, accBoxes.map(({ a, box }) => h('li', null, h('label', { class: 'pick' }, box, accountLabel(a)), h('span', { class: 'v' }, a.source)))) : null,
          h('p', { class: 'empty' }, 'Tick names or accounts that belong to someone else and split them into a new profile. At least one must stay here.'),
          h('div', { class: 'toolbar' }, splitName, splitBtn))),
    ];
  }

  // Instagram-style header: avatar (first picture of the profile laid over the
  // same coloured initial badge the list uses; no profile picture is stored), name, audience and the post counts.
  function profileHeader(p) {
    const mine = (state.media || []).filter((it) => it.profileId === p.id);
    const count = (k) => mine.filter((it) => it.kind === k).length;
    const first = mine.find((it) => it.kind === 'image' && thumbSrc(it.thumbnail)) || mine.find((it) => thumbSrc(it.thumbnail));
    const src = first ? thumbSrc(first.thumbnail) : null;
    const stat = (n, label) => h('div', { class: 'pf-stat' }, h('b', null, num(n)), h('span', null, label));
    return h('div', { class: 'pf-head' },
      h('div', { class: 'pf-avatar', 'data-media-bg': '1' },
        avatar(p, true),
        src ? h('img', { src, alt: '', onerror: dropBrokenImg }) : null),
      h('div', { class: 'pf-main' },
        h('h1', null, p.name, ' ', audienceChip(p.status)),
        h('div', { class: 'pf-stats' }, stat(mine.length, 'posts'), stat(count('image'), 'photos'), stat(count('video'), 'videos'), stat(p.aliases.length, 'names')),
        p.accounts.length ? h('div', { class: 'pf-accounts' }, p.accounts.map((a) => (a.url && /^https?:\/\//i.test(a.url)
          ? h('a', { class: 'chip', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, accountLabel(a))
          : h('span', { class: 'chip' }, accountLabel(a))))) : null,
        p.note ? h('p', { class: 'pf-note' }, p.note) : null));
  }

  // Photos and Videos in separate tabs, as on a creator page. Tiles open the
  // media viewer, which then steps through the same tab.
  function profileGallery(p) {
    const mine = (state.media || []).filter((it) => it.profileId === p.id);
    const tabs = [['image', 'Photos'], ['video', 'Videos']];
    const other = mine.filter((it) => it.kind !== 'image' && it.kind !== 'video');
    if (other.length) tabs.push(['audio', 'Audio']);
    let kind = mine.some((it) => it.kind === 'image') || !mine.some((it) => it.kind === 'video') ? 'image' : 'video';
    const grid = h('div', { class: 'pf-grid' });
    const bar = h('div', { class: 'pf-tabs', role: 'tablist' });
    const draw = () => {
      const items = mine.filter((it) => it.kind === kind);
      const query = new URLSearchParams({ profile: String(p.id), kind });
      grid.replaceChildren(...(items.length
        ? items.map((it) => tile(it, query))
        : [h('p', { class: 'empty' }, mine.length ? `No ${kind === 'image' ? 'photos' : kind === 'video' ? 'videos' : 'audio'} for this profile yet.` : 'No downloaded media for this profile yet.')]));
      bar.replaceChildren(...tabs.map(([k, label]) => h('button', {
        class: `pf-tab${k === kind ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(k === kind),
        onclick: () => { kind = k; draw(); },
      }, `${label} (${num(mine.filter((it) => it.kind === k).length)})`)));
    };
    draw();
    return h('div', { class: 'pf-gallery' }, bar, grid);
  }

  // The owner's decision for one profile, from its own page.
  function classifyBar(p) {
    const set = async (aud) => {
      const msg = aud === 'adult'
        ? `Classify "${p.name}" as 18+? This cannot be undone: an 18+ creator is never classified general again.`
        : `Classify "${p.name}" as general? Its files may then go to the general apps.`;
      if (!confirm(msg)) return;
      try {
        const r = await jsonPost('/api/hub/review/creators', { audience: aud, ids: [p.id] });
        toast(`${r.changed.length ? 'Classified' : 'Nothing changed'}.${skippedNote(r)}`);
        load(['review']).then(updateNav);
        render(false);
      } catch (e) { toast(e.message); }
    };
    if (p.status === 'adult') return h('p', { class: 'note' }, '18+: never delivered to a general app, and never classified general again.');
    return h('div', { class: 'toolbar' },
      p.status === 'unknown' ? h('span', { class: 'muted' }, 'Not classified: general apps refuse this creator.') : h('span', { class: 'muted' }, 'General (classified by hand).'),
      p.status === 'unknown' ? h('button', { class: 'btn small', type: 'button', onclick: () => set('general') }, 'Classify general') : null,
      h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => set('adult') }, 'Classify 18+'));
  }

  // --- Review queue ----------------------------------------------------------
  // Creators no one has classified, and the items general apps refused. Every
  // decision is by hand; 18+ is final.
  function viewReview() {
    return [
      h('h1', null, 'Review'),
      h('p', { class: 'lead' }, 'General apps only take creators and items you classified by hand. Everything else waits here.'),
      h('p', { class: 'note' }, 'Having been delivered before is not a classification. 18+ always wins and is final: an 18+ creator or item is never classified general again.'),
      ...reviewCreatorCards(),
      reviewItems(),
    ];
  }

  // Where a group's files went before. Delivery is history, not a decision.
  const HISTORY_LABEL = { main: 'main (Tikshortis)', platform: 'Platform', none: 'server library only' };
  const historyLabel = (hist) => (hist.length ? hist.map((c) => HISTORY_LABEL[c] || c).join(' + ') : 'no files');

  // The groups card and the creators card share one group filter.
  function reviewCreatorCards() {
    const ctl = { group: null, refresh: () => {} };
    const groupsCard = reviewGroups(ctl);
    const creatorsCard = reviewCreators(ctl);
    return [groupsCard, creatorsCard];
  }

  // Unclassified creators grouped by site and delivery history. A group is
  // classified only by an explicit click, a confirm naming its count, and a
  // server check that the count is still the same.
  function reviewGroups(ctl) {
    const box = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));

    async function decide(aud, g) {
      const where = `${g.sites.length ? g.sites.join(', ') : 'no site'}, delivered to ${historyLabel(g.history)}`;
      const msg = aud === 'adult'
        ? `Classify all ${num(g.count)} creators in the group "${where}" (${num(g.files)} files) as 18+? This cannot be undone.`
        : `Classify all ${num(g.count)} creators in the group "${where}" (${num(g.files)} files) as general? Their files may then go to Tikshortis, Platform and the posts library.`;
      if (!confirm(msg)) return;
      try {
        const r = await jsonPost('/api/hub/review/creators', { audience: aud, all: true, q: '', group: g.group, expected: g.count });
        toast(`${num(r.changed.length)} classified ${aud === 'adult' ? '18+' : 'general'}.${skippedNote(r)}`);
        load(['review']).then(updateNav);
        ctl.refresh();
      } catch (e) { toast(e.message); }
    }

    async function fill() {
      try {
        const d = await api('/api/hub/review/groups');
        if (!d.groups.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Every creator is classified.'));
        box.replaceChildren(h('div', { class: 'scroll-x' }, h('table', { class: 'groups' },
          h('thead', null, h('tr', null, h('th', null, 'Sources'), h('th', null, 'Delivered before to'), h('th', { class: 'num' }, 'Creators'), h('th', { class: 'num' }, 'Files'), h('th', null, 'Latest'), h('th', null, ''))),
          h('tbody', null, d.groups.map((g) => h('tr', { class: ctl.group === g.group ? 'selected' : null },
            h('td', null, g.sites.length ? g.sites.join(', ') : h('span', { class: 'muted' }, 'no site')),
            h('td', { class: 'muted' }, historyLabel(g.history)),
            h('td', { class: 'num', 'data-label': 'Creators' }, num(g.count)),
            h('td', { class: 'num', 'data-label': 'Files' }, num(g.files)),
            h('td', { 'data-label': 'Latest' }, g.lastAt ? ago(g.lastAt) : ''),
            h('td', null, h('div', { class: 'toolbar' },
              h('button', { class: 'btn small ghost', type: 'button', onclick: () => ctl.show(ctl.group === g.group ? null : g) }, ctl.group === g.group ? 'Showing' : 'Show'),
              h('button', { class: 'btn small', type: 'button', onclick: () => decide('general', g) }, `General (${num(g.count)})`),
              h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => decide('adult', g) }, `18+ (${num(g.count)})`)))))))));
      } catch (e) {
        box.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    }
    ctl.fillGroups = fill;
    fill();
    return card('Creators by source and history', 'profiles', null,
      h('p', { class: 'note' }, 'Grouped by the exact sites and the exact channels their files were delivered to. Delivered before is not a classification: look at a group before you classify it.'),
      box);
  }

  function pager(page, total, size, go) {
    if (total <= size) return null;
    const last = Math.max(0, Math.ceil(total / size) - 1);
    return h('div', { class: 'toolbar' },
      h('button', { class: 'btn small ghost', type: 'button', disabled: page <= 0, onclick: () => go(page - 1) }, 'Previous'),
      h('span', { class: 'muted' }, `Page ${page + 1} of ${last + 1}`),
      h('button', { class: 'btn small ghost', type: 'button', disabled: page >= last, onclick: () => go(page + 1) }, 'Next'));
  }

  function reviewCreators(ctl) {
    const SIZE = 100;
    const input = h('input', { class: 'field', type: 'search', placeholder: 'Filter creators', 'aria-label': 'Filter creators' });
    const box = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    const picked = new Set();
    let page = 0;
    let total = 0;
    let timer;

    async function decide(aud, ids, all) {
      const n = all ? total : ids.length;
      if (!n) return toast('Tick the creators first');
      const what = all
        ? `all ${num(n)} unclassified creators${groupLabel ? ` in the group "${groupLabel}"` : ''}${input.value.trim() ? ` matching "${input.value.trim()}"` : ''}`
        : `${num(n)} creator(s)`;
      const msg = aud === 'adult'
        ? `Classify ${what} as 18+? This cannot be undone.`
        : `Classify ${what} as general? Their files may then go to Tikshortis, Platform and the posts library.`;
      if (!confirm(msg)) return;
      try {
        const body = all ? { audience: aud, all: true, q: input.value, group: ctl.group || '', expected: total } : { audience: aud, ids };
        const r = await jsonPost('/api/hub/review/creators', body);
        toast(`${num(r.changed.length)} classified ${aud === 'adult' ? '18+' : 'general'}.${skippedNote(r)}`);
        picked.clear();
        load(['review']).then(updateNav);
        ctl.refresh();
      } catch (e) { toast(e.message); }
    }

    async function fill() {
      try {
        const d = await api(`/api/hub/review/creators?limit=${SIZE}&offset=${page * SIZE}&q=${encodeURIComponent(input.value)}&group=${encodeURIComponent(ctl.group || '')}`);
        total = d.total;
        if (!d.total) return box.replaceChildren(groupChip() || '', h('p', { class: 'empty' }, input.value || ctl.group ? 'No unclassified creator matches.' : 'Every creator is classified.'));
        const all = h('input', { type: 'checkbox', 'aria-label': 'Select every creator on this page', onchange: (e) => {
          for (const p of d.items) { if (e.target.checked) picked.add(p.id); else picked.delete(p.id); }
          fill();
        } });
        box.replaceChildren(
          groupChip() || '',
          h('div', { class: 'toolbar' },
            h('b', null, `${num(d.total)} unclassified`),
            h('button', { class: 'btn small', type: 'button', onclick: () => decide('general', [...picked]) }, `General (${picked.size})`),
            h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => decide('adult', [...picked]) }, `18+ (${picked.size})`),
            h('span', { class: 'muted' }, 'or every match:'),
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => decide('general', null, true) }, `All ${num(d.total)} general`),
            h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => decide('adult', null, true) }, `All ${num(d.total)} 18+`)),
          h('div', { class: 'scroll-x' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, all), h('th', null, 'Creator'), h('th', null, 'Sources'), h('th', { class: 'num' }, 'Files'), h('th', null, 'Latest'))),
            h('tbody', null, d.items.map((p) => h('tr', null,
              h('td', null, h('input', { type: 'checkbox', 'aria-label': `Select ${p.name}`, checked: picked.has(p.id), onchange: (e) => { if (e.target.checked) picked.add(p.id); else picked.delete(p.id); fill(); } })),
              h('td', null, h('a', { href: `#/profiles?id=${p.id}` }, p.name)),
              h('td', { class: 'muted' }, p.accounts.length ? p.accounts.map(accountLabel).join(', ') : p.sites.join(', ')),
              h('td', { class: 'num' }, num(p.files)),
              h('td', null, ago(p.lastAt))))))),
          pager(page, d.total, SIZE, (n) => { page = n; fill(); }) || '');
      } catch (e) {
        box.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    }
    function groupChip() {
      if (!ctl.group) return null;
      return h('div', { class: 'toolbar' },
        h('span', null, 'Group: ', h('b', null, groupLabel)),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => ctl.show(null) }, 'Show every group'));
    }
    let groupLabel = '';
    ctl.show = (g) => {
      ctl.group = g ? g.group : null;
      groupLabel = g ? `${g.sites.length ? g.sites.join(', ') : 'no site'}, delivered to ${historyLabel(g.history)}` : '';
      page = 0;
      picked.clear();
      ctl.fillGroups();
      fill();
    };
    ctl.refresh = () => { ctl.fillGroups(); fill(); };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; picked.clear(); fill(); }, 250); });
    fill();
    return card('Creators', 'profiles', null, h('div', { class: 'toolbar' }, input), box);
  }

  function reviewItems() {
    const SIZE = 100;
    const input = h('input', { class: 'field', type: 'search', placeholder: 'Filter items', 'aria-label': 'Filter items' });
    const refusedOnly = h('input', { type: 'checkbox', checked: true });
    const box = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    const picked = new Set();
    let page = 0;
    let timer;

    async function decide(aud) {
      if (!picked.size) return toast('Tick the items first');
      const msg = aud === 'adult'
        ? `Classify ${picked.size} item(s) as 18+? This cannot be undone.`
        : `Classify ${picked.size} item(s) as general? Only these items, not their creators.`;
      if (!confirm(msg)) return;
      try {
        const r = await jsonPost('/api/hub/review/items', { audience: aud, ids: [...picked] });
        toast(`${num(r.changed.length)} classified ${aud === 'adult' ? '18+' : 'general'}.${skippedNote(r)}`);
        picked.clear();
        fill();
      } catch (e) { toast(e.message); }
    }

    async function fill() {
      try {
        const d = await api(`/api/hub/review/items?refused=${refusedOnly.checked ? 1 : 0}&limit=${SIZE}&offset=${page * SIZE}&q=${encodeURIComponent(input.value)}`);
        if (!d.total) return box.replaceChildren(h('p', { class: 'empty' }, refusedOnly.checked ? 'No refused item is waiting.' : 'No unclassified item.'));
        box.replaceChildren(
          h('div', { class: 'toolbar' },
            h('b', null, `${num(d.total)} unclassified${refusedOnly.checked ? ', refused by a general app' : ''}`),
            h('button', { class: 'btn small', type: 'button', onclick: () => decide('general') }, `General (${picked.size})`),
            h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => decide('adult') }, `18+ (${picked.size})`)),
          h('div', { class: 'scroll-x' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Item'), h('th', null, 'Creator'), h('th', null, 'Why it waits'), h('th', null, 'Refused'))),
            h('tbody', null, d.items.map((r) => {
              const href = webHref(r.source_url);
              const label = r.title || r.filename || r.key;
              return h('tr', null,
                h('td', null, h('input', { type: 'checkbox', 'aria-label': `Select ${label}`, checked: picked.has(r.id), onchange: (e) => { if (e.target.checked) picked.add(r.id); else picked.delete(r.id); fill(); } })),
                h('td', null, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label) : label, r.site ? h('small', { class: 'muted' }, ` · ${r.site}`) : null),
                h('td', null, r.creator || h('span', { class: 'muted' }, 'none')),
                h('td', { class: 'muted' }, h('span', { class: 'clamp', title: r.last_refusal || '' }, r.last_refusal || 'imported from the download registry')),
                h('td', null, r.last_refused_at ? `${ago(r.last_refused_at)}${r.refusals > 1 ? ` (${r.refusals}x)` : ''}` : ''));
            })))),
          pager(page, d.total, SIZE, (n) => { page = n; fill(); }) || '');
      } catch (e) {
        box.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; picked.clear(); fill(); }, 250); });
    refusedOnly.addEventListener('change', () => { page = 0; picked.clear(); fill(); });
    fill();
    return card('Items', 'media', null,
      h('div', { class: 'toolbar' }, input, h('label', { class: 'muted' }, refusedOnly, ' Refused only')),
      box);
  }

  // --- Instagram inbox -------------------------------------------------------
  // What the patched Instagram app saved, before it reaches any app. Creators
  // are classified here with one click; a general creator's items go out to
  // the apps switched on below, now and from then on.
  const INBOX_APPS = [['egram', 'egram'], ['main', 'Tikshortis'], ['platform', 'Platform']];
  const INBOX_DEST_LABEL = { egram: 'egram', main: 'Tikshortis', platform: 'Platform', '18plus': 'Adshortis' };
  function viewInbox() {
    const head = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    const settingsBox = h('div');
    const waitingBox = h('div');
    const doneBox = h('div');
    const shadowBox = h('div');
    let donePage = 0;

    function modeNote(d) {
      if (d.mode === 'off') return h('p', { class: 'note' }, 'The inbox is off on this server (INBOX_MODE / INBOX_DROP_DIR). Nothing is read from the drop folder.');
      if (d.mode === 'shadow') return h('p', { class: 'note' }, 'Shadow mode: the drop folder is only read, nothing is moved or delivered. The old bridge still delivers.');
      return null;
    }
    function lastRun(r) {
      if (!r) return h('span', { class: 'muted' }, 'No run yet.');
      if (r.error) return h('span', { class: 'muted' }, `Last run ${ago(r.at)} failed: ${r.error}`);
      const rel = r.release || {};
      return h('span', { class: 'muted' },
        `Last run ${ago(r.at)}: ${num(r.staged || 0)} new, ${num(rel.delivered || 0)} delivered, ${num(r.waiting || 0)} still uploading` +
        (r.ignoredTotal ? `, ${num(r.ignoredTotal)} left in the drop folder` : ''));
    }

    function settingsCard(d) {
      const boxes = {};
      const rows = INBOX_APPS.map(([id, label]) => {
        boxes[id] = h('input', { type: 'checkbox', checked: d.settings.auto[id], disabled: !d.available[id] });
        return h('label', { class: 'muted', style: 'display:block;margin:4px 0' }, boxes[id], ` ${label}`,
          d.available[id] ? (id === 'egram' ? '' : ' (videos only)') : ' (not configured on this server)');
      });
      const keep = h('input', { class: 'field', type: 'number', min: 1, max: 90, value: d.settings.keepDays, style: 'width:80px', 'aria-label': 'Days to keep staged files' });
      const save = async () => {
        try {
          const auto = {};
          for (const [id] of INBOX_APPS) auto[id] = boxes[id].checked;
          await jsonPost('/api/hub/inbox/settings', { auto, keepDays: Number(keep.value) });
          toast('Inbox settings saved');
          fill();
        } catch (e) { toast(e.message); }
      };
      settingsBox.replaceChildren(card('Automatic delivery', 'share', null,
        h('p', { class: 'muted' }, 'A creator classified general sends its items to the apps ticked here. Unclassified and 18+ creators always wait.'),
        ...rows,
        h('div', { class: 'toolbar' },
          h('label', { class: 'muted' }, 'Remove Grabbit\'s staged copy after ', keep, ' days'),
          h('button', { class: 'btn small', type: 'button', onclick: save }, 'Save'))));
    }

    async function classify(username, aud) {
      const msg = aud === 'adult'
        ? `Classify @${username} as 18+? Nothing of theirs will reach a general app, and this cannot be undone.`
        : `Classify @${username} as general? Their waiting items and every later one go to the apps switched on.`;
      if (!confirm(msg)) return;
      try {
        const r = await jsonPost('/api/hub/inbox/creators', { username, audience: aud });
        const rel = r.run && r.run.release;
        toast(`@${username} classified ${aud === 'adult' ? '18+' : 'general'}${rel ? `; ${num(rel.delivered)} delivered` : ''}`);
        fill();
      } catch (e) { toast(e.message); }
    }
    async function deliver(row, dest) {
      try {
        const r = await jsonPost(`/api/hub/inbox/${row.id}/deliver`, { destination: dest });
        const ok = r.results.filter((x) => x.ok).length;
        toast(`${num(ok)} sent to ${INBOX_DEST_LABEL[dest]}${r.error ? ` (${r.error})` : ''}`);
        fill();
      } catch (e) { toast(e.message); }
    }

    function thumb(row) {
      const src = `/api/hub/inbox/${row.id}/file`;
      const media = row.kind === 'profile' ? null
        : row.item_kind === 'video'
          ? h('video', { src, muted: true, preload: 'metadata', playsinline: true })
          : h('img', { src, alt: '', loading: 'lazy', onerror: dropBrokenImg });
      return h('div', { class: `tile${media ? '' : ' no-thumb'}`, 'data-kind': row.kind === 'profile' ? 'profile' : row.item_kind || 'media', 'data-media-bg': '1' },
        media, row.item_kind === 'video' ? h('span', { class: 'play' }, icon('play')) : null);
    }

    function creatorBlock(username, rows, available) {
      const held = rows.filter((r) => r.state === 'held');
      const ready = rows.filter((r) => r.state === 'ready');
      const adult = rows.some((r) => r.audience === 'adult');
      const unknown = rows.some((r) => r.audience === 'unknown' || (r.kind === 'profile' && /not|no profile/.test(r.reason || '')));
      const reason = (held[0] || ready[0] || {}).reason || '';
      const media = rows.filter((r) => r.kind === 'media');
      const destSel = h('select', { class: 'field', 'aria-label': `Send @${username}'s items to` },
        ...['egram', 'main', 'platform', '18plus'].filter((d) => available[d]).map((d) => h('option', { value: d }, INBOX_DEST_LABEL[d])));
      const sendAll = async () => {
        const dest = destSel.value;
        for (const r of media.filter((x) => !x.deliveries.some((y) => y.destination === dest && y.status === 'dropped'))) await deliver(r, dest);
      };
      return h('section', { class: 'card' },
        h('h2', null, icon('profiles'),
          h('a', { href: `https://www.instagram.com/${encodeURIComponent(username)}/`, target: '_blank', rel: 'noopener noreferrer' }, `@${username}`),
          h('span', { class: `chip ${adult ? 'adult' : unknown ? 'unclassified' : ''}` }, adult ? '18+' : unknown ? 'unclassified' : 'general')),
        h('p', { class: 'muted' }, `${num(media.length)} item(s) waiting`, reason ? ` - ${reason}` : ''),
        media.length ? h('div', { class: 'inbox-grid' }, media.slice(0, 8).map(thumb)) : null,
        media.length > 8 ? h('p', { class: 'muted' }, `and ${num(media.length - 8)} more`) : null,
        h('div', { class: 'toolbar' },
          adult ? null : h('button', { class: 'btn small', type: 'button', onclick: () => classify(username, 'general') }, 'General'),
          adult ? null : h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => classify(username, 'adult') }, '18+'),
          media.length && (ready.length || adult) ? h('span', { class: 'toolbar' }, destSel,
            h('button', { class: 'btn small ghost', type: 'button', onclick: sendAll }, 'Send by hand')) : null));
    }

    async function fillWaiting(d) {
      const [held, ready] = await Promise.all([
        api('/api/hub/inbox?state=held&limit=1000'),
        api('/api/hub/inbox?state=ready&limit=1000'),
      ]);
      const rows = [...held.items, ...ready.items];
      if (!rows.length) return waitingBox.replaceChildren(card('Waiting', 'review', null, h('p', { class: 'empty' }, 'Nothing waits in the inbox.')));
      const by = new Map();
      for (const r of rows) (by.get(r.username) || by.set(r.username, []).get(r.username)).push(r);
      const users = [...by.keys()].sort((a, b) => by.get(b).length - by.get(a).length || a.localeCompare(b));
      waitingBox.replaceChildren(
        h('h2', { class: 'section' }, `Waiting: ${num(rows.length)} from ${num(users.length)} creator(s)`),
        ...users.map((u) => creatorBlock(u, by.get(u), d.available)));
    }

    async function fillDone() {
      const SIZE = 50;
      const d = await api(`/api/hub/inbox?limit=${SIZE}&offset=${donePage * SIZE}`);
      const rows = d.items.filter((r) => r.state === 'delivered' || r.state === 'duplicate');
      doneBox.replaceChildren(card('Recent', 'media', null,
        rows.length ? h('div', { class: 'scroll-x' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Creator'), h('th', null, 'State'), h('th', null, 'Delivered to'), h('th', null, 'Received'))),
          h('tbody', null, rows.map((r) => {
            const href = webHref(r.source_url);
            const label = r.title || r.entry;
            return h('tr', null,
              h('td', null, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label) : label),
              h('td', null, `@${r.username}`),
              h('td', null, h('span', { class: 'clamp', title: r.reason || '' }, r.state)),
              h('td', null, r.deliveries.filter((x) => x.status === 'dropped').map((x) => INBOX_DEST_LABEL[x.destination] || x.destination).join(', ') || (r.kind === 'profile' ? 'profile' : '')),
              h('td', { class: 'muted' }, ago(r.received_at)));
          })))) : h('p', { class: 'empty' }, 'Nothing delivered yet.'),
        pager(donePage, d.total, SIZE, (n) => { donePage = n; fillDone(); }) || ''));
    }

    async function fillShadow() {
      const s = await api('/api/hub/inbox/shadow');
      const unknownCreators = Object.entries(s.creators).filter(([, c]) => c.audience !== 'general');
      shadowBox.replaceChildren(card('Shadow run', 'pulse', null,
        h('p', null, `${num(s.entries)} drops seen${s.first ? ` since ${new Date(s.first).toLocaleString()}` : ''}: ` +
          `${num(s.audience.general)} general, ${num(s.audience.unknown)} unclassified, ${num(s.audience.adult)} 18+, ${num(s.duplicates)} duplicates.`),
        h('p', { class: 'muted' }, 'Would deliver: ' + (Object.entries(s.wouldDeliver).map(([k, v]) => `${INBOX_DEST_LABEL[k] || k} ${num(v)}`).join(', ') || 'nothing')),
        unknownCreators.length ? h('p', { class: 'muted' }, `${num(unknownCreators.length)} creator(s) would wait for a classification: ` +
          unknownCreators.slice(0, 30).map(([u, c]) => `@${u} (${c.media})`).join(', ')) : null));
    }

    async function fill() {
      try {
        const d = await api('/api/hub/inbox?limit=1');
        state.inbox = d;
        updateNav();
        const c = d.counts || {};
        head.replaceChildren(
          modeNote(d) || '',
          h('p', null, `${num(c.held || 0)} waiting for a decision, ${num(c.ready || 0)} general but not sent, ${num(c.delivered || 0)} delivered, ${num(c.duplicate || 0)} duplicates. `, lastRun(d.lastRun)),
          d.mode === 'off' ? '' : h('div', { class: 'toolbar' }, h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
            try { await post('/api/hub/inbox/run'); fill(); } catch (e) { toast(e.message); }
          } }, 'Check the drop folder now')));
        settingsCard(d);
        if (d.mode === 'shadow') await fillShadow(); else shadowBox.replaceChildren();
        await fillWaiting(d);
        await fillDone();
      } catch (e) {
        head.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    }
    fill();
    return [
      h('h1', null, 'Inbox'),
      h('p', { class: 'lead' }, 'What the Instagram app saved. Classify a creator once; their items then go to the apps you switched on.'),
      head, shadowBox, waitingBox, settingsBox, doneBox,
    ];
  }

  // --- Duplicates ----------------------------------------------------------
  // The scan reads Grabbit's folders and the apps' media folders (never
  // writing to them) and lists files with the same bytes. Nothing is deleted
  // here: a group can only be marked known/OK.
  function viewDuplicates() {
    const scanBox = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    const groupBox = h('div', null);
    const which = h('select', { class: 'field', 'aria-label': 'Which groups' },
      h('option', { value: 'open' }, 'Open groups'),
      h('option', { value: 'acked' }, 'Marked known/OK'),
      h('option', { value: 'all' }, 'All groups'));
    const SIZE = 25;
    let page = 0;
    let poll;

    async function scanAction(action) {
      try {
        await jsonPost('/api/hub/dupes/scan', { action });
        fill();
      } catch (e) { toast(e.message); }
    }
    async function ack(g) {
      const note = prompt(`Mark these ${g.files} copies as known/OK? Nothing is deleted. A note (optional):`, '');
      if (note === null) return;
      try {
        await jsonPost(`/api/hub/dupes/${g.sha256}/ack`, { note });
        toast('Marked known/OK. A new copy opens the group again.');
        fill();
      } catch (e) { toast(e.message); }
    }
    async function removeOne(m) {
      if (!confirm(`Move this copy to the trash?\n\n${m.rel}\n\nThe other copy stays. You can restore it for 30 days.`)) return;
      try {
        await jsonPost('/api/hub/dupes/remove', { id: m.id });
        toast('Moved to the trash.');
        fill();
      } catch (e) { toast(e.message); }
    }
    async function removeGroup(g) {
      if (!confirm(`Move the ${g.removable} extra ${g.removable === 1 ? 'copy' : 'copies'} of this group to the trash? The copy marked Keep stays. You can restore for 30 days.`)) return;
      try {
        const r = await jsonPost('/api/hub/dupes/remove-all', { sha256: g.sha256 });
        toast(r.failed.length ? `${r.files} moved, ${r.failed.length} refused: ${r.failed[0].error}` : `${r.files} moved to the trash.`);
        fill();
      } catch (e) { toast(e.message); }
    }
    async function removeAll() {
      try {
        const p = await jsonPost('/api/hub/dupes/remove-all', { dryRun: true });
        if (!p.files) return toast('No extra copy can be removed. The rest sit in app folders.');
        if (!confirm(`Move ${p.files} extra copies in ${p.groups} groups (${bytes(p.bytes)}) to the trash?\n\nOne copy of each group stays: the one an app reads, else the one linked to an item, else the oldest. Groups marked known/OK are left alone. You can restore for 30 days.`)) return;
        removeAllBtn.disabled = true;
        removeAllBtn.textContent = 'Removing ...';
        const r = await jsonPost('/api/hub/dupes/remove-all', {});
        toast(`${r.files} copies (${bytes(r.bytes)}) moved to the trash${r.failed.length ? `; ${r.failed.length} refused (${r.failed[0].error})` : ''}.`);
      } catch (e) { toast(e.message); }
      removeAllBtn.disabled = false;
      removeAllBtn.textContent = 'Remove all extra copies';
      fill();
    }
    const removeAllBtn = h('button', { class: 'btn small danger', type: 'button', onclick: removeAll }, 'Remove all extra copies');
    const trashBox = h('div', null);
    async function fillTrash() {
      try {
        const t = await api('/api/hub/dupes/trash');
        if (!t.items.length) return trashBox.replaceChildren(h('p', { class: 'empty' }, 'The trash is empty.'));
        trashBox.replaceChildren(
          h('p', { class: 'note' }, `${num(t.items.length)} copies, ${bytes(t.bytes)}. Each is deleted for good 30 days after it was removed.`),
          h('ul', { class: 'rows' }, t.items.map((x) => h('li', null,
            h('div', null, h('b', null, x.rootLabel), h('span', { class: 'muted' }, ` · ${bytes(x.bytes)} · removed ${ago(x.at)}, deleted ${new Date(x.purgeAt).toLocaleDateString()}`)),
            h('div', { class: 'break mono' }, x.rel),
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => restore(x) }, 'Restore')))));
      } catch (e) { trashBox.replaceChildren(h('p', { class: 'empty' }, e.message)); }
    }
    async function restore(x) {
      try {
        await jsonPost(`/api/hub/dupes/trash/${x.id}/restore`, {});
        toast('Restored. The scan reads it again.');
        fill();
      } catch (e) { toast(e.message); }
    }
    async function unack(g) {
      try {
        await jsonPost(`/api/hub/dupes/${g.sha256}/unack`, {});
        fill();
      } catch (e) { toast(e.message); }
    }

    function scanView(s) {
      if (s.state === 'off') return [h('p', { class: 'empty' }, `The scan is switched off on this server (${s.reason}).`)];
      const t = s.totals || {};
      const pct = t.bytes ? Math.floor((100 * (t.hashedBytes || 0)) / t.bytes) : 0;
      const label = s.state === 'running'
        ? (s.phase === 'walking' ? 'Listing files' : s.phase === 'hashing' ? 'Reading files' : s.phase === 'waiting' ? 'Up to date; checks again later' : 'Running')
        : s.state === 'paused' ? 'Paused' : 'Not started';
      return [
        h('div', { class: 'toolbar' },
          h('b', null, label),
          s.state === 'running'
            ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => scanAction('pause') }, 'Pause')
            : h('button', { class: 'btn small', type: 'button', onclick: () => scanAction('start') }, s.state === 'paused' ? 'Resume' : 'Start scan'),
          h('span', { class: 'muted' }, `${num(t.hashed)} of ${num(t.files)} files read (${bytes(t.hashedBytes || 0)} of ${bytes(t.bytes || 0)}, ${pct}%)`),
          s.lastPassAt ? h('span', { class: 'muted' }, `last full pass ${ago(s.lastPassAt)}`) : null),
        s.current && s.current.rel ? h('p', { class: 'note' }, `Now: ${s.current.rel}`) : null,
        s.lastError ? h('p', { class: 'err' }, s.lastError) : null,
        h('div', { class: 'scroll-x' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Folder'), h('th', null, 'Belongs to'), h('th', { class: 'num' }, 'Files'), h('th', { class: 'num' }, 'Read'), h('th', { class: 'num' }, 'Linked to an item'), h('th', { class: 'num' }, 'Errors'))),
          h('tbody', null, (s.roots || []).map((r) => h('tr', null,
            h('td', null, r.label, h('div', { class: 'muted' }, r.path)),
            h('td', { class: 'muted' }, r.owner === 'app' ? `${r.app} (read only)` : r.app ? `Grabbit, for ${r.app}` : 'Grabbit'),
            h('td', { class: 'num' }, num(r.files)),
            h('td', { class: 'num' }, num(r.hashed)),
            h('td', { class: 'num' }, num(r.linked), r.ambiguous ? h('div', { class: 'muted' }, `${num(r.ambiguous)} ambiguous`) : null),
            h('td', { class: 'num' }, num(r.errors))))))),
        h('p', { class: 'note' }, `Reads at most ${s.mbPerSec} MB/s, one file at a time. A file is read again only when its size, date or inode changes. Pausing stops within a second; the scan resumes after a restart only if it was running.`),
      ];
    }

    // One copy: where it is, then what Grabbit knows about it. A list, not a
    // table: long file paths must wrap on a phone.
    function memberRow(m) {
      const who = m.item_id
        ? [m.creator ? h('b', null, m.creator) : null, m.title ? ` ${m.title}` : null, m.site ? h('span', { class: 'muted' }, ` · ${m.site}`) : null, ' ', m.audience ? audienceChip(m.audience) : null]
        : h('span', { class: 'muted' }, m.link === 'ambiguous' ? 'Not linked: two items share this file name' : 'Not linked to an item');
      const ext = ((/\.([a-z0-9]+)$/i.exec(m.rel) || [])[1] || '').toLowerCase();
      const src = `/api/hub/dupes/file/${m.id}`;
      const preview = ['mp4', 'm4v', 'mov', 'webm', 'mkv'].includes(ext)
        ? h('video', { class: 'dupe-preview', src: `${src}#t=0.1`, controls: true, preload: 'metadata', muted: true, playsinline: true })
        : ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext)
          ? h('img', { class: 'dupe-preview', src, loading: 'lazy', alt: '' })
          : ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav'].includes(ext)
            ? h('audio', { class: 'dupe-audio', src, controls: true, preload: 'none' })
            : null;
      return h('li', { class: `dupe-member${m.suggested ? ' dupe-extra' : ''}` },
        preview,
        h('div', null, h('b', null, m.rootLabel), m.adultFolder ? h('span', { class: 'chip adult' }, '18+') : null,
          m.mtime_ms ? h('span', { class: 'muted' }, ` · ${new Date(m.mtime_ms).toLocaleDateString()}`) : null),
        h('div', { class: 'break mono' }, m.rel),
        h('div', null, who),
        h('div', { class: 'toolbar dupe-actions' },
          m.keep ? h('span', { class: 'chip keep' }, 'Keep') : null,
          m.removable
            ? h('button', { class: 'btn small danger', type: 'button', onclick: () => removeOne(m) }, 'Remove')
            : null,
          m.why && !m.keep ? h('span', { class: 'muted' }, m.why) : null));
    }

    // The scan poll refreshes only the scan box and the summary line. The
    // list is rebuilt when the owner acts, never under them: a rebuild
    // reloads every video preview. A changed list is offered with a button.
    const groupHead = h('div', null);
    let shownSig = '';
    const sigOf = (d) => JSON.stringify([d.total, d.items.map((g) => [g.sha256, Boolean(g.ack && g.ack.current), g.members.map((m) => m.id)])]);

    let seq = 0;
    async function fill(opts = {}) {
      clearTimeout(poll);
      const mine = ++seq;
      try {
        const d = await api(`/api/hub/dupes?state=${which.value}&limit=${SIZE}&offset=${page * SIZE}`);
        if (mine !== seq) return; // a newer fill owns the view
        scanBox.replaceChildren(...scanView(d.scan).filter(Boolean));
        const sig = sigOf(d);
        const keepList = opts.poll && shownSig;
        removeAllBtn.hidden = !d.canRemove;
        if (!keepList && d.canRemove) fillTrash();
        groupHead.replaceChildren(h('p', { class: 'note' },
          `${num(d.groups)} groups of identical files in all; ${bytes(d.openBytes)} in extra copies across the open ones.`),
        keepList && sig !== shownSig
          ? h('p', { class: 'note' }, 'The scan changed this list. ',
            h('button', { class: 'btn small', type: 'button', onclick: () => fill() }, 'Show the new list'))
          : '');
        if (keepList) {
          // Leave the rendered groups alone.
        } else if (!d.items.length) {
          shownSig = sig;
          groupBox.replaceChildren(h('p', { class: 'empty' }, d.scan.totals && d.scan.totals.files ? 'No group in this list.' : 'Nothing read yet. Start the scan above.'));
        } else {
          shownSig = sig;
          groupBox.replaceChildren(...d.items.map((g) => h('div', { class: 'dupe-group' },
            h('div', { class: 'toolbar' },
              h('b', null, `${g.files} copies, ${bytes(g.bytes)} each`),
              h('span', { class: 'muted mono' }, g.sha256.slice(0, 16)),
              g.crossesAudience ? h('span', { class: 'chip adult' }, 'In an 18+ folder and a general app') : null,
              g.ack && g.ack.current
                ? [h('span', { class: 'chip' }, `Known/OK ${ago(g.ack.at)}${g.ack.note ? `: ${g.ack.note}` : ''}`),
                  h('button', { class: 'btn small ghost', type: 'button', onclick: () => unack(g) }, 'Open again')]
                : [g.ack ? h('span', { class: 'muted' }, 'Changed since it was marked') : null,
                  h('button', { class: 'btn small ghost', type: 'button', onclick: () => ack(g) }, 'Mark known/OK')],
              g.removable && !(g.ack && g.ack.current)
                ? h('button', { class: 'btn small danger', type: 'button', onclick: () => removeGroup(g) }, `Remove ${g.removable} extra`)
                : null),
            h('ul', { class: 'rows dupe-grid' }, g.members.map(memberRow)))),
          pager(page, d.total, SIZE, (n) => { page = n; fill(); }) || '');
        }
        if (d.scan.state === 'running' && location.hash.startsWith('#/duplicates')) poll = setTimeout(() => fill({ poll: true }), 4000);
      } catch (e) {
        scanBox.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    }
    which.addEventListener('change', () => { page = 0; fill(); });
    fill();
    return [
      h('h1', null, 'Duplicates'),
      h('p', { class: 'lead' }, 'Files with exactly the same bytes, in Grabbit\'s folders and the apps\' media folders.'),
      h('p', { class: 'note' }, 'Remove moves a copy to Grabbit\'s trash; it can be restored for 30 days and is deleted after that. Only copies in Grabbit\'s own folders, or in an app\'s import folder when the app\'s library already has the same bytes, can be removed. Copies an app reads stay, and so does the last copy linked to an item. All copies in a group have exactly the same bytes, so the quality is the same; the one marked Keep is the one an app reads, else the one linked to an item, else the oldest. A file is linked to an item only when exactly one item was saved under that file name.'),
      card('Scan', 'pulse', null, scanBox),
      card('Identical files', 'dupes', null, h('div', { class: 'toolbar' }, which, removeAllBtn), groupHead, groupBox),
      card('Trash', 'dupes', null, trashBox),
    ];
  }

  // --- Metadata & tags -------------------------------------------------------
  // The source's title, creator, caption and tags stay as they came; the
  // owner's title, creator and tags sit beside them. None of it changes an
  // item's audience.
  const TAG_ORIGIN_LABEL = { site: 'from the site', category: 'site category', caption: 'from the caption', user: 'your tag' };
  // One chip per tag. Its colour says where it came from; a tag the site and
  // the caption both have shows once, as the site's. Only your own tags can
  // be removed.
  function tagChips(tags, onRemove) {
    const chips = (tags.all || []).map((t) => {
      const k = t.kind === 'category' ? 'category' : t.origins.includes('site') ? 'site' : t.origins.includes('caption') ? 'caption' : 'user';
      const title = t.origins.map((o) => (t.kind === 'category' ? TAG_ORIGIN_LABEL.category : TAG_ORIGIN_LABEL[o])).join(', ');
      return h('span', { class: `chip t-${k}`, title },
        k === 'category' ? t.label : `#${t.label}`,
        k === 'user' && onRemove ? h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${t.label}`, onclick: () => onRemove(t.label) }, '\u00d7') : null);
    });
    return chips.length ? h('div', { class: 'chips' }, chips) : h('span', { class: 'muted' }, 'No tags');
  }

  function viewMetadata(params) {
    const SIZE = 50;
    const q = h('input', { class: 'field', type: 'search', placeholder: 'Search title, creator, caption, file name', 'aria-label': 'Search' });
    const tag = h('input', { class: 'field', type: 'search', placeholder: 'Tag', 'aria-label': 'Tag', value: (params && params.get && params.get('tag')) || '' });
    const origin = h('select', { class: 'field', 'aria-label': 'Tag origin' },
      h('option', { value: 'any' }, 'Any origin'), h('option', { value: 'source' }, 'From the source'),
      h('option', { value: 'site' }, 'From the site'), h('option', { value: 'caption' }, 'From the caption'), h('option', { value: 'user' }, 'Your tags'));
    const tagged = h('select', { class: 'field', 'aria-label': 'Has tags' },
      h('option', { value: '' }, 'Tagged or not'), h('option', { value: 'any' }, 'Has tags'), h('option', { value: 'source' }, 'Has source tags'),
      h('option', { value: 'user' }, 'Has your tags'), h('option', { value: 'none' }, 'No tags'));
    const aud = h('select', { class: 'field', 'aria-label': 'Audience' },
      h('option', { value: '' }, 'Any audience'), h('option', { value: 'general' }, 'General'), h('option', { value: 'adult' }, '18+'), h('option', { value: 'unknown' }, 'Unclassified'));
    const edited = h('input', { type: 'checkbox' });
    const countsBox = h('div', null);
    const cloud = h('div', null);
    const listBox = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    const detail = h('div', null);
    const picked = new Set();
    let page = 0;
    let timer;

    const query = () => `q=${encodeURIComponent(q.value)}&tag=${encodeURIComponent(tag.value)}&origin=${origin.value}&tagged=${tagged.value}&audience=${aud.value}${edited.checked ? '&edited=1' : ''}`;

    async function changeTags(ids, add, remove) {
      try {
        const r = await jsonPost('/api/hub/meta/tags', { ids, add, remove });
        const a = r.added ? r.added.changed.length : 0;
        const rm = r.removed ? r.removed.changed.length : 0;
        const skipped = [...(r.added ? r.added.skipped : []), ...(r.removed ? r.removed.skipped : [])];
        toast(`${add.length ? `Tagged ${num(a)} item(s). ` : ''}${remove.length ? `Removed from ${num(rm)} item(s). ` : ''}${skipped.length ? `${skipped.length} skipped (${[...new Set(skipped.map((x) => x.reason))].join('; ')}).` : ''}`);
        fill();
        if (detail.dataset.id) openItem(Number(detail.dataset.id));
      } catch (e) { toast(e.message); }
    }

    async function openItem(id) {
      detail.dataset.id = String(id);
      try {
        const { item: it } = await api(`/api/hub/meta/${id}`);
        const title = h('input', { class: 'field', value: it.title || '', 'aria-label': 'Title' });
        const creator = h('input', { class: 'field', value: it.creator || '', 'aria-label': 'Creator' });
        const newTag = h('input', { class: 'field', placeholder: 'Add your tags (space or comma separated)', 'aria-label': 'New tags' });
        const save = async () => {
          try {
            const r = await jsonPost(`/api/hub/meta/${id}`, { title: title.value, creator: creator.value });
            toast(r.changed.length ? `Saved ${r.changed.join(' and ')}.` : 'Nothing changed.');
            fill();
            openItem(id);
          } catch (e) { toast(e.message); }
        };
        detail.replaceChildren(h('div', { class: 'meta-edit' }, card(`Item ${it.id}`, 'tags', null,
          h('div', { class: 'toolbar' }, audienceChip(it.audience), it.site ? h('span', { class: 'chip' }, it.site) : null,
            webHref(it.sourceUrl) ? h('a', { href: webHref(it.sourceUrl), target: '_blank', rel: 'noopener noreferrer' }, 'Source page') : null,
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => { detail.replaceChildren(); delete detail.dataset.id; } }, 'Close')),
          h('label', { class: 'lbl' }, 'Title', it.edited.title ? h('span', { class: 'muted' }, ` (source: ${it.source.title || 'none'})`) : null), title,
          h('label', { class: 'lbl' }, 'Creator', it.edited.creator ? h('span', { class: 'muted' }, ` (source: ${it.source.creator || 'none'})`) : null), creator,
          h('div', { class: 'toolbar' }, h('button', { class: 'btn small', type: 'button', onclick: save }, 'Save'),
            h('span', { class: 'muted' }, 'Empty a field to show the source value again. This never changes who may see the item.')),
          h('h3', null, 'Tags'),
          tagChips(it.tags, (label) => changeTags([id], [], [label])),
          h('div', { class: 'toolbar' }, newTag,
            h('button', { class: 'btn small', type: 'button', onclick: () => { const l = splitTags(newTag.value); if (l.length) changeTags([id], l, []); } }, 'Add')),
          h('h3', null, 'Caption from the source'),
          it.description ? h('p', { class: 'caption' }, it.description) : h('p', { class: 'muted' }, 'The source gave no caption.'),
          it.raw ? h('details', null, h('summary', null, `Raw source record${it.extractor ? ` (${it.extractor})` : ''}`), h('pre', { class: 'raw' }, JSON.stringify(it.raw, null, 2))) : null,
          it.edits.length ? h('details', null, h('summary', null, `Change log (${it.edits.length})`),
            h('ul', { class: 'rows' }, it.edits.map((e) => h('li', null, `${e.field.replace('_', ' ')}: ${e.old_value || '—'} → ${e.new_value || '—'}`, h('span', { class: 'v' }, ago(e.at)))))) : null)));
        detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { toast(e.message); }
    }

    async function fillCloud() {
      try {
        const d = await api(`/api/hub/meta/tags?origin=${origin.value === 'any' ? 'any' : origin.value}&limit=40`);
        cloud.replaceChildren(d.tags.length
          ? h('div', { class: 'chips' }, d.tags.map((t) => h('button', { class: `chip pick${tag.value && t.norm === tag.value.replace(/^#/, '').toLowerCase() ? ' on' : ''}`, type: 'button', title: t.origins.map((o) => TAG_ORIGIN_LABEL[o]).join(', '), onclick: () => { tag.value = tag.value === t.norm ? '' : t.norm; page = 0; fill(); fillCloud(); } }, `#${t.label} `, h('span', { class: 'muted' }, num(t.items)))))
          : h('p', { class: 'empty' }, 'No tags yet. New downloads bring the source\'s tags along.'));
      } catch (e) { cloud.replaceChildren(h('p', { class: 'empty' }, e.message)); }
    }

    async function fill() {
      try {
        const d = await api(`/api/hub/meta?${query()}&limit=${SIZE}&offset=${page * SIZE}`);
        const c = d.counts;
        countsBox.replaceChildren(h('ul', { class: 'rows' },
          h('li', null, 'Items', h('span', { class: 'v' }, num(c.items))),
          h('li', null, 'With a caption from the source', h('span', { class: 'v' }, num(c.withCaption))),
          h('li', null, 'With tags from the site', h('span', { class: 'v' }, num(c.withSiteTags))),
          h('li', null, 'With hashtags from the caption', h('span', { class: 'v' }, num(c.withCaptionTags))),
          h('li', null, 'With your tags', h('span', { class: 'v' }, num(c.withUserTags))),
          h('li', null, 'Edited by you', h('span', { class: 'v' }, num(c.edited)))));
        const bulkTag = h('input', { class: 'field', placeholder: 'Tags for the ticked items', 'aria-label': 'Tags for the ticked items' });
        const all = h('input', { type: 'checkbox', 'aria-label': 'Select every item on this page', onchange: (e) => {
          for (const it of d.items) { if (e.target.checked) picked.add(it.id); else picked.delete(it.id); }
          fill();
        } });
        listBox.replaceChildren(
          h('div', { class: 'toolbar' },
            h('b', null, `${num(d.total)} items`),
            bulkTag,
            h('button', { class: 'btn small', type: 'button', onclick: () => { const l = splitTags(bulkTag.value); if (!picked.size) return toast('Tick the items first'); if (l.length) changeTags([...picked], l, []); } }, `Add to ${picked.size}`),
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => { const l = splitTags(bulkTag.value); if (!picked.size) return toast('Tick the items first'); if (l.length) changeTags([...picked], [], l); } }, `Remove from ${picked.size}`)),
          d.items.length ? h('div', { class: 'scroll-x' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, all), h('th', null, 'Title'), h('th', null, 'Creator'), h('th', null, 'Tags'), h('th', null, ''))),
            h('tbody', null, d.items.map((it) => h('tr', null,
              h('td', null, h('input', { type: 'checkbox', 'aria-label': `Select item ${it.id}`, checked: picked.has(it.id), onchange: (e) => { if (e.target.checked) picked.add(it.id); else picked.delete(it.id); } })),
              h('td', null, it.title || h('span', { class: 'muted' }, it.filename || it.key), it.edited.title ? h('span', { class: 'chip' }, 'edited') : null,
                h('div', { class: 'muted' }, [it.site, it.kind].filter(Boolean).join(' · '), ' ', audienceChip(it.audience))),
              h('td', null, it.creator || '', it.edited.creator ? h('span', { class: 'chip' }, 'edited') : null),
              h('td', null, tagChips(it.tags, (label) => changeTags([it.id], [], [label]))),
              h('td', null, h('button', { class: 'btn small ghost', type: 'button', onclick: () => openItem(it.id) }, 'Edit'))))))) : h('p', { class: 'empty' }, 'No item matches.'),
          pager(page, d.total, SIZE, (n) => { page = n; fill(); }) || '');
      } catch (e) {
        listBox.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    }

    // Bulk creator rename: pick a creator as shown, give the new name, confirm
    // the count. Profile merges stay on the Profiles page.
    function renameCard() {
      const from = h('input', { class: 'field', type: 'search', placeholder: 'Find a creator', 'aria-label': 'Creator to rename' });
      const to = h('input', { class: 'field', placeholder: 'New creator name', 'aria-label': 'New creator name' });
      const box = h('div', null);
      let chosen = null;
      let t2;
      async function find() {
        if (!from.value.trim()) return box.replaceChildren();
        try {
          const d = await api(`/api/hub/meta/creators?q=${encodeURIComponent(from.value)}&limit=20`);
          box.replaceChildren(d.creators.length ? h('div', { class: 'chips' }, d.creators.map((c) => h('button', { class: `chip pick${chosen && chosen.creator === c.creator ? ' on' : ''}`, type: 'button', onclick: () => { chosen = c; find(); } }, `${c.creator} `, h('span', { class: 'muted' }, num(c.items))))) : h('p', { class: 'empty' }, 'No creator matches.'));
        } catch (e) { box.replaceChildren(h('p', { class: 'empty' }, e.message)); }
      }
      async function go() {
        if (!chosen) return toast('Pick a creator first');
        if (!to.value.trim()) return toast('Give the new name');
        if (!confirm(`Show all ${num(chosen.items)} items of "${chosen.creator}" under "${to.value.trim()}"? The source names are kept and this can be undone the same way. It does not change who may see the items.`)) return;
        try {
          const r = await jsonPost('/api/hub/meta/creator-rename', { from: chosen.creator, to: to.value.trim(), expected: chosen.items });
          toast(`${num(r.changed)} item(s) renamed.`);
          chosen = null;
          from.value = '';
          to.value = '';
          box.replaceChildren();
          fill();
        } catch (e) { toast(e.message); }
      }
      from.addEventListener('input', () => { clearTimeout(t2); chosen = null; t2 = setTimeout(find, 250); });
      return card('Rename a creator', 'profiles', { href: '#/profiles', label: 'Profiles' },
        h('div', { class: 'toolbar' }, from, to, h('button', { class: 'btn small', type: 'button', onclick: go }, 'Rename')),
        box,
        h('p', { class: 'note' }, 'Changes the creator shown on every item of that name, in Grabbit only. To join or split creator profiles (and their audience), use the Profiles page.'));
    }

    for (const el of [q, tag]) el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; fill(); }, 250); });
    for (const el of [origin, tagged, aud, edited]) el.addEventListener('change', () => { page = 0; fill(); if (el === origin) fillCloud(); });
    fill();
    fillCloud();
    return [
      h('h1', null, 'Metadata & tags'),
      h('p', { class: 'lead' }, 'Titles, creators and tags in one place. What the source said is kept; your changes sit beside it.'),
      h('p', { class: 'note' }, 'Changes stay in Grabbit: files the apps already imported are not touched. Nothing here changes whether an item is general or 18+.'),
      h('div', { class: 'two' },
        card('Overview', 'tags', null, countsBox),
        card('Most used tags', 'tags', null, cloud)),
      detail,
      card('Items', 'media', null,
        h('div', { class: 'toolbar' }, q, tag, origin, tagged, aud, h('label', null, edited, ' Edited by you')),
        listBox),
      renameCard(),
    ];
  }
  const splitTags = (s) => String(s || '').split(/[\s,;]+/).map((t) => t.replace(/^#+/, '').trim()).filter(Boolean);

  function viewConversion() {
    const t = toolVersions(state.health);
    return [
      h('h1', null, 'Conversion'),
      h('p', { class: 'lead' }, 'Originals are kept. A web copy (H.264/AAC) can be made next to them for shorts saves.'),
      card('Tools', 'convert', null, h('ul', { class: 'rows' },
        ['ffmpeg', 'ffprobe', 'ytdlp', 'gallerydl', 'mutagen'].map((k) =>
          h('li', null, h('span', { class: `dot ${t[k] ? 'ok' : 'bad'}` }), k === 'ytdlp' ? 'yt-dlp' : k === 'gallerydl' ? 'gallery-dl' : k, h('span', { class: 'v' }, t[k] || 'missing'))))),
      h('div', { style: 'height:18px' }),
      h('p', { class: 'note' }, 'Today: tick "Web copy" when adding a shorts link. Planned: a conversion queue for files already in the library.'),
    ];
  }

  function viewDistribution() {
    const s = state.summary;
    return [
      h('h1', null, 'Distribution'),
      h('p', { class: 'lead' }, 'Where Grabbit hands media to other apps. Each app imports from its own drop folder under its own rules.'),
      h('div', { class: 'two' },
        h('div', { class: 'col' },
          card('App destinations', 'share', null, h('ul', { class: 'rows' }, routeRows(false))),
          card('18+ destination (Adshortis)', 'share', null,
            h('ul', { class: 'rows' }, routeRows(true)),
            h('p', { class: 'note' }, 'Kept apart from every general app: its folder may not share a tree with them, only the owner session and 18+ app clients can save to it, and it is never the default choice.'),
            state.config && state.config.adultBlocked ? h('p', { class: 'err' }, state.config.adultBlocked) : null)),
        card('Downloads by source', 'sites', null,
          s ? h('ul', { class: 'rows' }, s.sites.map((x) => h('li', null, x.site, h('span', { class: 'v' }, num(x.count))))) : h('p', { class: 'empty' }, 'Loading ...'))),
    ];
  }

  function viewSettings() {
    const hl = state.health;
    const dests = (hl && hl.dests) || [];
    return [
      h('h1', null, 'Settings'),
      h('p', { class: 'lead' }, 'Download options, cookies, rules, playlists and notifications are in the classic view.'),
      h('p', null, h('a', { class: 'btn ghost', href: '/' }, 'Open the classic view')),
      card('Save locations', 'pulse', null,
        hl ? h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Location'), h('th', null, 'State'), h('th', { class: 'num' }, 'Free'))),
          h('tbody', null, dests.map((d) => {
            const good = d.exists && d.writable && !d.unreachable;
            return h('tr', null, h('td', null, d.label), h('td', { class: good ? 'ok-t' : 'bad-t' }, good ? 'ready' : d.unreachable ? 'unreachable' : !d.exists ? 'missing' : 'read-only'), h('td', { class: 'num' }, d.free != null ? bytes(d.free) : ''));
          })))
        : h('p', { class: 'empty' }, 'Loading ...')),
      h('div', { style: 'height:18px' }),
      card('System status', 'pulse', null, h('ul', { class: 'rows' }, healthRows())),
    ];
  }

  // --- Menu, search, boot --------------------------------------------------
  function closeMenu() {
    $('#side').classList.remove('open');
    $('#scrim').hidden = true;
  }
  $('#menuBtn').addEventListener('click', () => {
    $('#side').classList.add('open');
    $('#scrim').hidden = false;
  });
  $('#scrim').addEventListener('click', closeMenu);
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    location.hash = q ? `#/media?q=${encodeURIComponent(q)}` : '#/media';
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#searchInput').focus();
    }
  });
  window.addEventListener('hashchange', () => {
    // Opening, closing or stepping in the viewer changes only `open`: the page
    // under it keeps its scroll position and is not rebuilt.
    if (pageKey() === renderedKey) return syncViewer();
    grabCache = null;
    render();
    syncViewer();
  });

  // Repaint after the boot loads, except a page that fetches its own data:
  // rebuilding it would throw away what the owner already opened or typed.
  function settle() {
    if (route().ownData) updateNav();
    else render(false);
  }

  async function boot() {
    buildNav();
    render();
    await load(['config', 'summary', 'history', 'media', 'jobs', 'review', 'inbox']);
    const apps = (state.summary && state.summary.apps) || [];
    if (state.summary && state.summary.brand) $('#brandSub').textContent = state.summary.brand;
    if (apps.length) {
      $('#appsList').replaceChildren(...apps.map((a) => h('li', null, h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name, h('span', { 'aria-hidden': 'true' }, '↗')))));
      $('#appsBox').hidden = false;
    }
    settle();
    syncViewer();
    connectStream();
    // The health probe touches every mount; it can take a moment.
    await load(['health']);
    settle();
    // Refresh the numbers; repaint only pages without inputs of their own.
    setInterval(() => load(['health', 'summary']).then(() => { if (route().live) render(false); }), 60000);
  }
  boot();
})();
