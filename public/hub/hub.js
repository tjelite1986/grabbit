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
    review: 'M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11',
    sites: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
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
  const thumbSrc = (u) => (/^https?:\/\//i.test(String(u || '')) ? '/api/thumb?url=' + encodeURIComponent(u) : null);
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
    jobs: new Map(),
    review: null,
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
      review: () => api('/api/hub/review').then((d) => { state.review = d; }),
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
      if (d.job.status === 'done' && prev && prev.status !== 'done') load(['summary', 'history']).then(scheduleRender);
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
    { id: 'duplicates', label: 'Duplicates', icon: 'dupes', planned: true, view: viewDuplicates },
    { id: 'conversion', label: 'Conversion', icon: 'convert', view: viewConversion },
    { id: 'metadata', label: 'Metadata & tags', icon: 'tags', planned: true, view: viewMetadata },
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
  function render(focus = true) {
    const r = route();
    const view = $('#view');
    view.replaceChildren(...[r.view(r.params)].flat());
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
    const advanced = h('a', { href: '/' }, 'Advanced options in the classic view');
    input.addEventListener('input', () => {
      advanced.href = input.value ? '/share?url=' + encodeURIComponent(input.value) : '/';
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
    if (withActions && (j.status === 'error' || j.status === 'cancelled')) {
      acts.append(h('button', { class: 'btn small', onclick: () => post(`/api/jobs/${encodeURIComponent(j.id)}/retry`).then(() => toast('Retrying')).catch((e) => toast(e.message)) }, 'Retry'));
    }
    return h('div', { class: 'job' },
      src ? h('img', { class: 'thumb', src, alt: '', loading: 'lazy', 'data-media-bg': '1' }) : h('div', { class: 'thumb' }),
      h('div', { style: 'min-width:0' },
        h('div', { class: 't' }, [j.creator, j.title].filter(Boolean).join(' - ') || 'Resolving link ...'),
        h('div', { class: 's' }, status),
        ACTIVE.has(j.status) && pct !== null ? h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })) : null),
      acts);
  }

  function tile(it) {
    const src = thumbSrc(it.thumbnail);
    const site = hostOf(it.sourceUrl);
    return h('a', { class: 'tile', href: it.sourceUrl && /^https?:/i.test(it.sourceUrl) ? it.sourceUrl : null, target: '_blank', rel: 'noopener noreferrer', title: [it.creator, it.title].filter(Boolean).join(' - ') },
      src ? h('img', { src, alt: '', loading: 'lazy', 'data-media-bg': '1' }) : null,
      site ? h('span', { class: 'chip site' }, site) : null,
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
    const recent = (state.history || []).filter((it) => it.filename).slice(0, 6);
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
              recent.length ? h('div', { class: 'tiles' }, recent.map(tile)) : h('p', { class: 'empty' }, state.history ? 'No downloads in the history yet.' : 'Loading ...'))),
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

  function viewMedia(params) {
    const kind = params.get('kind') || '';
    const q = (params.get('q') || '').toLowerCase();
    const kindOf = (name) => {
      const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
      const e = (ext || '').toLowerCase();
      if (['mp4', 'mkv', 'webm', 'mov', 'm4v'].includes(e)) return 'video';
      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif'].includes(e)) return 'image';
      if (['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aac', 'm4b'].includes(e)) return 'audio';
      return 'other';
    };
    const items = (state.history || [])
      .filter((it) => it.filename)
      .filter((it) => !kind || kindOf(it.filename) === kind)
      .filter((it) => !q || [it.creator, it.title, it.filename].join(' ').toLowerCase().includes(q));
    const tab = (k, label) => h('a', { class: `btn small ${kind === k ? '' : 'ghost'}`, href: `#/media${k ? '?kind=' + k : ''}` }, label);
    return [
      h('h1', null, 'Media'),
      h('p', { class: 'lead' }, 'The latest downloads from the history log (it keeps the newest 100). A full media library with previews is planned.'),
      h('div', { class: 'toolbar' }, tab('', 'All'), tab('video', 'Videos'), tab('image', 'Images'), tab('audio', 'Audio'),
        q ? h('span', { class: 'chip' }, `Search: ${q}`) : null),
      items.length ? h('div', { class: 'media-grid' }, items.map(tile)) : h('p', { class: 'empty' }, state.history ? 'Nothing matches.' : 'Loading ...'),
    ];
  }

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
              h('td', null, h('a', { href: `#/profiles?id=${p.id}` }, p.name), ' ', p.status !== 'general' ? audienceChip(p.status) : null),
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
      h('h1', null, p.name, ' ', audienceChip(p.status)),
      classifyBar(p),
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

  function viewDuplicates() {
    const s = state.summary;
    return [
      h('h1', null, 'Duplicates'),
      h('p', { class: 'lead' }, 'Planned: find, review and resolve duplicate media without losing data.'),
      card('What exists today', 'dupes', null,
        h('ul', { class: 'rows' },
          h('li', null, 'Registry keys', h('span', { class: 'v' }, s ? num(s.keys) : '-')),
          h('li', null, 'Distinct files behind them', h('span', { class: 'v' }, s ? num(s.files) : '-')),
          h('li', null, 'Marks without a file (playlist and manual marks)', h('span', { class: 'v' }, s ? num(s.marks) : '-'))),
        h('p', { class: 'empty' }, 'A link Grabbit has already saved is skipped before it is downloaded again, keyed on the site id. Content-level checks (the same clip from two sites) are not built yet.')),
    ];
  }

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

  function viewMetadata() {
    return [
      h('h1', null, 'Metadata & tags'),
      h('p', { class: 'lead' }, 'Planned: edit captions, tags, creators and source links in one place.'),
      h('p', { class: 'note' }, 'Today the classic view has the rules engine (auto-tagging and routing by site or creator), naming templates and the music tag editor.'),
      h('p', null, h('a', { class: 'btn ghost', href: '/' }, 'Open the classic view')),
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
    grabCache = null;
    render();
  });

  async function boot() {
    buildNav();
    render();
    await load(['config', 'summary', 'history', 'jobs', 'review']);
    const apps = (state.summary && state.summary.apps) || [];
    if (state.summary && state.summary.brand) $('#brandSub').textContent = state.summary.brand;
    if (apps.length) {
      $('#appsList').replaceChildren(...apps.map((a) => h('li', null, h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name, h('span', { 'aria-hidden': 'true' }, '↗')))));
      $('#appsBox').hidden = false;
    }
    render(false);
    connectStream();
    // The health probe touches every mount; it can take a moment.
    await load(['health']);
    render(false);
    // Refresh the numbers; repaint only pages without inputs of their own.
    setInterval(() => load(['health', 'summary']).then(() => { if (route().live) render(false); }), 60000);
  }
  boot();
})();
