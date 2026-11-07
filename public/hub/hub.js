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
    if (ch.includes('main')) out.push({ value: 'main', label: 'Shorts', q: { dest: 'elite', channel: 'main' }, shorts: true });
    if (ch.includes('18plus')) out.push({ value: '18plus', label: 'Shorts 18+', q: { dest: 'elite', channel: '18plus' }, shorts: true });
    out.push({ value: 'navidrome', label: 'Music library (audio)', q: { dest: 'navidrome' } });
    out.push({ value: 'audiobooks', label: 'Audiobooks (audio)', q: { dest: 'audiobooks' } });
    return out;
  }
  const DEST_KEY = 'grabbit.hub.dest';

  // The form survives live repaints (job events re-render the dashboard), so
  // a half-typed link is not wiped. It is rebuilt on navigation only.
  let grabCache = null;
  function grabForm(opts) {
    const key = route().id;
    if (grabCache && grabCache.key === key) return grabCache.el;
    grabCache = { key, el: buildGrabForm(opts) };
    return grabCache.el;
  }
  function buildGrabForm({ big }) {
    const dests = destinations();
    const saved = localStorage.getItem(DEST_KEY);
    const select = h('select', { class: 'field', 'aria-label': 'Save to' },
      dests.map((d) => h('option', { value: d.value, selected: d.value === saved }, d.label)));
    const webBox = h('input', { type: 'checkbox' });
    const webLabel = h('label', null, webBox, ' Web copy (H.264/AAC) next to the original');
    const syncWeb = () => {
      const d = dests.find((x) => x.value === select.value);
      webLabel.hidden = !(d && d.shorts);
    };
    select.addEventListener('change', () => { localStorage.setItem(DEST_KEY, select.value); syncWeb(); });
    syncWeb();
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
        const q = new URLSearchParams({ url: input.value.trim(), device: '0', ...d.q });
        if (d.shorts && webBox.checked) q.set('web', '1');
        button.disabled = true;
        try {
          await api('/api/jobs/start?' + q.toString());
          connectStream();
          input.value = '';
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

  function healthRows() {
    const hl = state.health;
    if (!hl) return [h('li', { class: 'empty' }, 'Loading ...')];
    const tool = (name, v) => h('li', null, h('span', { class: `dot ${v ? 'ok' : 'bad'}` }), name, h('span', { class: `v ${v ? 'ok-t' : 'bad-t'}` }, v || 'missing'));
    const badDests = (hl.dests || []).filter((d) => !d.exists || !d.writable || d.unreachable);
    const rows = [
      tool('yt-dlp', hl.tools && hl.tools.ytdlp),
      tool('ffmpeg (conversion)', hl.tools && hl.tools.ffmpeg),
      tool('gallery-dl', hl.tools && hl.tools.gallerydl),
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
  function routeRows() {
    const dests = ((state.health && state.health.dests) || []).filter((d) => /^(shorts|platform|posts)/.test(d.label));
    if (!state.health) return [h('li', { class: 'empty' }, 'Loading ...')];
    if (!dests.length) return [h('li', { class: 'empty' }, 'No app destinations are configured on this server.')];
    return dests.map((d) => {
      const good = d.exists && d.writable && !d.unreachable;
      return h('li', null, h('span', { class: `dot ${good ? 'ok' : 'bad'}` }), d.label,
        h('span', { class: `v ${good ? 'ok-t' : 'bad-t'}` }, d.unreachable ? 'unreachable' : !d.exists ? 'missing' : !d.writable ? 'read-only' : 'ready'));
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
            h('p', { class: 'empty', style: 'padding-bottom:0' }, 'Linked accounts, merging and splitting come with the profile store.')),
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

  function viewProfiles(params) {
    const box = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
    const input = h('input', { class: 'field', type: 'search', placeholder: 'Filter creators', value: params.get('q') || '' });
    let timer;
    const fill = async () => {
      try {
        const d = await api('/api/hub/creators?limit=300&q=' + encodeURIComponent(input.value));
        box.replaceChildren(
          h('p', { class: 'empty' }, `${num(d.total)} creators${d.total > d.items.length ? `, showing the top ${d.items.length}` : ''}.`),
          h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Creator'), h('th', null, 'Sources'), h('th', { class: 'num' }, 'Files'), h('th', null, 'Latest'))),
            h('tbody', null, d.items.map((c) => h('tr', null, h('td', null, c.name), h('td', null, c.sites.map((s) => h('span', { class: 'chip' }, s))), h('td', { class: 'num' }, num(c.files)), h('td', null, ago(c.lastAt)))))));
      } catch (e) {
        box.replaceChildren(h('p', { class: 'empty' }, e.message));
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(fill, 250); });
    fill();
    return [
      h('h1', null, 'Profiles'),
      h('p', { class: 'lead' }, 'Creators as they appear in downloaded file names.'),
      h('p', { class: 'note' }, 'Read-only for now. Shared creator profiles with linked TikTok, Instagram and Facebook accounts, plus edit, merge and split, need a profile store that is not built yet.'),
      h('div', { class: 'toolbar', style: 'margin-top:14px' }, input),
      box,
    ];
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
    const t = (state.health && state.health.tools) || {};
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
        card('App destinations', 'share', null, h('ul', { class: 'rows' }, routeRows())),
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
    await load(['config', 'summary', 'history', 'jobs']);
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
