'use strict';
// Grabbit 3.0.4: the Smart Duplicate Manager (#/duplicates/<tab>).
//
// Seven tabs instead of one long page: Overview, Identical, Similar Photos,
// Similar Videos, Cache & Thumbnails, Trash and Settings. Every list is paged
// on the server; filters, sorting and the view live in the address, and the
// scroll position is kept per address, so Back returns to the same place.
//
// Lists show small JPEG thumbnails made by the server. A video player is only
// created in the side-by-side comparison, when the owner opens it.
//
// 18+: hidden by default. Groups with a copy in an 18+ folder (or an item
// classified adult) are left out of lists and previews until the owner picks
// "Show 18+" for this visit; counts say how many were left out.
//
// Loaded before hub.js; registers itself in window.GrabbitModules.
(() => {
  const registry = (window.GrabbitModules = window.GrabbitModules || []);
  registry.push({ id: 'dupes', create });

  function create(hub) {
    const { h, api, toast, num, ago, bytes } = hub;
    const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    const enc = encodeURIComponent;
    const BASE = '/api/hub/dupes/v2';
    const post = (p, body) => api(`${BASE}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const get = (p) => api(`${BASE}/${p}`);
    let generation = 0;
    const live = (g) => g === generation;
    let pollTimer = null;
    let adultMode = 'hide'; // per visit only: never stored
    const selected = new Set();

    const PATHS = {
      overview: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z',
      identical: 'M8 8h12v12H8zM4 16V4h12',
      photo: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01',
      video: 'M4 6h12v12H4zM16 10l4-2v8l-4-2',
      cache: 'M4 7c0-2 16-2 16 0v10c0 2-16 2-16 0zM4 7c0 2 16 2 16 0M4 12c0 2 16 2 16 0',
      trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
      settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1-2-2V4h-4v2L9 8 7 7 5 11l2 1v2l-2 1 2 4 2-1 2 2v2h4v-2l2-2 2 1 2-4-2-1z',
      grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
      list: 'M4 6h16M4 12h16M4 18h16',
      compare: 'M4 5h7v14H4zM13 5h7v14h-7z',
      play: 'M8 5v14l11-7z',
      pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
      fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
      close: 'M6 6l12 12M18 6 6 18',
      check: 'M5 12l5 5 9-10',
      star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.4 6.5 20.4l1-6.3L3 9.7l6.2-.9z',
      restore: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
      lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
      merge: 'M6 4v6a6 6 0 0 0 6 6h6M18 12l4 4-4 4M6 20v-4',
      info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
      scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16',
      ai: 'M12 3v3M12 18v3M3 12h3M18 12h3M7 7h10v10H7zM10 10h4v4h-4z',
      expand: 'M6 9l6 6 6-6',
    };
    function ic(name, size = 18) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('style', `width:${size}px;height:${size}px`);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', PATHS[name] || PATHS.info);
      svg.append(p);
      return svg;
    }

    const TABS = [
      ['overview', 'Overview', 'overview'],
      ['identical', 'Identical', 'identical'],
      ['photos', 'Similar Photos', 'photo'],
      ['videos', 'Similar Videos', 'video'],
      ['cache', 'Cache & Thumbnails', 'cache'],
      ['trash', 'Trash', 'trash'],
      ['settings', 'Settings', 'settings'],
    ];
    const MATCH_LABEL = {
      exact: 'Exact match',
      near: 'Near duplicate',
      similar: 'Visually similar',
      reencoded: 'Re-encoded duplicate',
      partial: 'Partial match',
    };
    const MATCH_HELP = {
      exact: 'The files have exactly the same bytes.',
      near: 'The same picture in different files (resized, recompressed, converted, slightly cropped or turned).',
      similar: 'They look alike. They may be different originals: compare before removing anything.',
      reencoded: 'The same video with another codec, resolution, bitrate or container.',
      partial: 'One video appears inside the other. A clip is its own video and is never a removable copy.',
    };
    const STATUS_LABEL = { open: 'Open', reviewed: 'Reviewed', keep_all: 'Keep all', ignored: 'Ignored', known: 'Known/OK' };

    // --- address state ---------------------------------------------------------
    function tabOf(r) {
      const t = r.sub[0] || 'overview';
      return TABS.some(([id]) => id === t) ? t : 'overview';
    }
    function link(tab, params) {
      const q = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v !== '' && v != null)).toString();
      return `#/duplicates/${tab}${q ? `?${q}` : ''}`;
    }
    const scrollKey = () => `grabbit.dupes.scroll:${location.hash}`;
    function saveScroll() {
      try { sessionStorage.setItem(scrollKey(), String(window.scrollY || document.documentElement.scrollTop || 0)); } catch {}
    }
    function restoreScroll() {
      let y = 0;
      try { y = Number(sessionStorage.getItem(scrollKey())) || 0; } catch {}
      if (y) requestAnimationFrame(() => window.scrollTo(0, y));
    }
    window.addEventListener('scroll', () => { if (location.hash.startsWith('#/duplicates/')) saveScroll(); }, { passive: true });

    function leave() {
      generation++;
      clearTimeout(pollTimer);
      closeOverlay();
    }

    // --- small pieces ------------------------------------------------------------
    const fmtDur = (s) => {
      if (s == null) return '-';
      const m = Math.floor(s / 60);
      const r = Math.round(s % 60);
      return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
    };
    const fmtEta = (s) => (s == null ? '-' : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
    const pct = (x) => `${Math.round((x || 0) * 100)}%`;
    const date = (ms) => (ms ? new Date(ms).toLocaleDateString() : '-');
    const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
    const statTile = (label, value, sub, iconName, href) => h(href ? 'a' : 'div', { class: 'dm-stat', href: href || null },
      h('span', { class: 'dm-stat-ic' }, ic(iconName, 22)),
      h('span', null, h('b', null, value), h('small', null, label), sub ? h('em', null, sub) : null));
    const busyBtn = async (btn, fn) => {
      const label = btn.textContent;
      btn.disabled = true;
      try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
    };

    // A dialog: a centred sheet with a title, a body and buttons. Resolves
    // with the chosen value (null when dismissed).
    let overlay = null;
    function closeOverlay() {
      if (overlay) {
        overlay.querySelectorAll('video').forEach((v) => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} });
        overlay.remove();
        overlay = null;
        document.removeEventListener('keydown', escClose);
      }
    }
    function escClose(e) { if (e.key === 'Escape') closeOverlay(); }
    function host() { return document.fullscreenElement || document.body; }
    function dialog(title, body, buttons) {
      closeOverlay();
      return new Promise((resolve) => {
        const done = (v) => { closeOverlay(); resolve(v); };
        overlay = h('div', { class: 'dm-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { class: 'dm-dialog' },
            h('h2', null, title),
            h('div', { class: 'dm-dialog-body' }, body),
            h('div', { class: 'dm-dialog-actions' },
              h('button', { class: 'btn small ghost', type: 'button', onclick: () => done(null) }, 'Cancel'),
              buttons.map((b) => h('button', { class: `btn small${b.danger ? ' danger' : ''}${b.ghost ? ' ghost' : ''}`, type: 'button', onclick: () => done(b.value) }, b.label)))));
        host().append(overlay);
        document.addEventListener('keydown', escClose);
        const first = overlay.querySelector('.dm-dialog-actions .btn:last-child');
        if (first) first.focus();
      });
    }

    function thumb(m, size = 'md') {
      if (!m.preview) {
        return h('div', { class: `dm-thumb dm-thumb-${size} dm-thumb-hidden`, title: m.audience === 'adult' ? '18+ preview hidden' : 'No preview' },
          m.audience === 'adult' ? h('span', null, '18+') : ic(m.kind === 'video' ? 'video' : m.kind === 'image' ? 'photo' : 'identical', 22));
      }
      if (m.kind === 'audio') return h('div', { class: `dm-thumb dm-thumb-${size} dm-thumb-hidden` }, ic('identical', 22));
      return h('div', { class: `dm-thumb dm-thumb-${size}` },
        h('img', { src: `${BASE}/thumb/${m.id}`, alt: '', loading: 'lazy', decoding: 'async', 'data-media-bg': '1', onerror: (e) => { e.currentTarget.replaceWith(ic(m.kind === 'video' ? 'video' : 'photo', 22)); } }),
        m.kind === 'video' ? h('span', { class: 'dm-thumb-badge' }, m.duration ? fmtDur(m.duration) : ic('play', 12)) : null);
    }

    // --- page frame ------------------------------------------------------------------
    function view(r) {
      generation++;
      clearTimeout(pollTimer);
      const tab = tabOf(r);
      const gen = generation;
      const body = h('div', { class: 'dm-body' }, h('p', { class: 'empty' }, 'Loading ...'));
      const counts = h('span', { class: 'muted small dm-head-note' });
      const nav = h('nav', { class: 'dm-tabs', 'aria-label': 'Duplicate Manager sections' },
        TABS.map(([id, label, iconName]) => h('a', { href: `#/duplicates/${id}`, class: 'dm-tab', 'aria-current': id === tab ? 'page' : null, 'data-tab': id },
          ic(iconName, 16), h('span', null, label), h('span', { class: 'dm-tab-n', hidden: true }))));
      const render = {
        overview: () => viewOverview(body, gen),
        identical: () => viewGroups(body, gen, 'identical', r),
        photos: () => viewGroups(body, gen, 'photos', r),
        videos: () => viewGroups(body, gen, 'videos', r),
        cache: () => viewCache(body, gen, r),
        trash: () => viewTrash(body, gen, r),
        settings: () => viewSettings(body, gen),
      }[tab];
      Promise.resolve().then(render).catch((e) => { if (live(gen)) fill(body, h('p', { class: 'empty' }, e.message)); });
      get('overview').then((o) => {
        if (!live(gen)) return;
        const n = { identical: o.identical.open, photos: o.photos.open, videos: o.videos.open, cache: o.cache.duplicateGroups, trash: o.trash.files };
        for (const a of nav.querySelectorAll('.dm-tab')) {
          const b = a.querySelector('.dm-tab-n');
          const v = n[a.dataset.tab];
          b.hidden = !v;
          b.textContent = v ? num(v) : '';
        }
        counts.textContent = `${num(o.totals.files)} files, ${bytes(o.totals.bytes)} scanned`;
      }).catch(() => {});
      return [
        h('div', { class: 'dm-head' },
          h('h1', null, 'Smart Duplicate Manager'),
          counts),
        nav,
        body,
      ];
    }

    // --- Overview ----------------------------------------------------------------------
    async function viewOverview(body, gen) {
      const o = await get('overview');
      if (!live(gen)) return;
      const s = o.scan || {};
      const a = o.analysis || {};
      const t = (s.totals || {});
      const pctDone = t.bytes ? Math.min(100, Math.floor((100 * (t.hashedBytes || 0)) / t.bytes)) : 0;
      const lastScan = s.lastPassAt ? ago(s.lastPassAt) : 'never';
      const stats = h('div', { class: 'dm-stats' },
        statTile('Total scanned files', num(o.totals.files), null, 'scan'),
        statTile('Scanned storage', bytes(o.totals.bytes), null, 'cache'),
        statTile('Exact duplicate groups', num(o.identical.groups), o.identical.open !== o.identical.groups ? `${num(o.identical.open)} open` : null, 'identical', '#/duplicates/identical'),
        statTile('Similar photo candidates', num(o.photos.groups), null, 'photo', '#/duplicates/photos'),
        statTile('Similar video candidates', num(o.videos.groups), o.videos.partial ? `+ ${num(o.videos.partial)} partial` : null, 'video', '#/duplicates/videos'),
        statTile('Reclaimable space', bytes(o.identical.reclaimable), `of ${bytes(o.identical.duplicateBytes)} in identical copies${o.photos.reclaimable ? `; up to ${bytes(o.photos.reclaimable)} more in similar photos you review` : ''}`, 'restore', '#/duplicates/identical?deletable=1'),
        statTile('Trash size', bytes(o.trash.bytes), plural(o.trash.files, 'file', 'files'), 'trash', '#/duplicates/trash'),
        statTile('Last scan', lastScan, s.state ? `scan ${s.state}` : null, 'overview'));

      const scanBtns = h('div', { class: 'dm-btns' });
      const scanAct = (action) => async (e) => {
        const btn = e.currentTarget;
        await busyBtn(btn, async () => {
          try { await post('scan', { action }); toast(action === 'rescan' ? 'A new scan started.' : `Scan ${action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running'}.`); } catch (err) { toast(err.message); }
        });
        if (live(gen)) viewOverview(body, gen);
      };
      if (s.state === 'running') scanBtns.append(h('button', { class: 'btn small ghost', type: 'button', onclick: scanAct('pause') }, 'Pause'));
      else scanBtns.append(h('button', { class: 'btn small', type: 'button', onclick: scanAct('start') }, s.state === 'paused' ? 'Resume' : 'Start'));
      if (s.state && s.state !== 'stopped') scanBtns.append(h('button', { class: 'btn small ghost', type: 'button', onclick: scanAct('stop') }, 'Stop'));
      scanBtns.append(h('button', { class: 'btn small ghost', type: 'button', onclick: scanAct('rescan') }, 'Scan now'));
      const activity = s.state === 'off' ? 'Switched off on this server'
        : s.state !== 'running' ? (s.state === 'paused' ? 'Paused' : 'Stopped')
          : s.phase === 'walking' ? 'Listing files' : s.phase === 'hashing' ? 'Reading files' : s.phase === 'waiting' ? 'Up to date; checks again later' : 'Starting';

      const scanCard = h('section', { class: 'card dm-card' },
        h('h2', null, ic('scan'), 'Scan status'),
        h('div', { class: 'dm-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctDone), 'aria-label': 'Scan progress' }, h('span', { style: `width:${pctDone}%` })),
        h('dl', { class: 'dm-facts' },
          h('dt', null, 'Current activity'), h('dd', null, activity, s.current && s.current.rel && s.state === 'running' ? h('div', { class: 'muted small dm-break' }, s.current.rel) : null),
          h('dt', null, 'Files scanned'), h('dd', null, `${num(t.hashed || 0)} of ${num(t.files || 0)} (${pctDone}%)`),
          h('dt', null, 'Current speed'), h('dd', null, s.speedBps ? `${(s.speedBps / 1048576).toFixed(1)} MB/s` : '-', h('span', { class: 'muted small' }, ` (limit ${s.mbPerSec || '-'} MB/s)`)),
          h('dt', null, 'Estimated time remaining'), h('dd', null, s.state === 'running' && t.todo ? fmtEta(s.etaSeconds) : t.todo ? `${num(t.todo)} files waiting` : 'Nothing waiting'),
          h('dt', null, 'Last completed scan'), h('dd', null, s.lastPassAt ? `${ago(s.lastPassAt)} (${new Date(s.lastPassAt).toLocaleString()})` : 'Never')),
        s.lastError ? h('p', { class: 'dm-err' }, s.lastError) : null,
        scanBtns);

      const aBtns = h('div', { class: 'dm-btns' });
      const aAct = (action) => async (e) => {
        const btn = e.currentTarget;
        await busyBtn(btn, async () => { try { await post('analysis', { action }); } catch (err) { toast(err.message); } });
        if (live(gen)) viewOverview(body, gen);
      };
      if (a.state === 'running') aBtns.append(h('button', { class: 'btn small ghost', type: 'button', onclick: aAct('pause') }, 'Pause analysis'));
      else aBtns.append(h('button', { class: 'btn small', type: 'button', onclick: aAct('start') }, a.state === 'paused' ? 'Resume analysis' : 'Start analysis'));
      if (a.state && a.state !== 'stopped') aBtns.append(h('button', { class: 'btn small ghost', type: 'button', onclick: aAct('stop') }, 'Stop'));
      const en = a.enabled || {};
      const aCard = h('section', { class: 'card dm-card' },
        h('h2', null, ic('ai'), 'Photo and video analysis'),
        h('dl', { class: 'dm-facts' },
          h('dt', null, 'State'), h('dd', null, a.state || 'off', a.phase && a.state === 'running' ? h('span', { class: 'muted small' }, ` - ${a.phase}`) : null),
          h('dt', null, 'Photos analysed'), h('dd', null, num((a.photos || {}).analysed || 0), en.photo ? '' : h('span', { class: 'muted small' }, ' (engine off)'), a.msPerImage ? h('span', { class: 'muted small' }, ` - ${a.msPerImage} ms each`) : null),
          h('dt', null, 'AI comparison'), h('dd', null, en.ai ? `${a.model} model${a.modelInstalled ? '' : ' (not installed yet)'}` : 'Off', a.msPerEmbedding ? h('span', { class: 'muted small' }, ` - ${a.msPerEmbedding} ms each`) : null),
          h('dt', null, 'Videos analysed'), h('dd', null, num((a.videos || {}).analysed || 0), en.video ? '' : h('span', { class: 'muted small' }, ' (engine off)'), a.msPerVideo ? h('span', { class: 'muted small' }, ` - ${(a.msPerVideo / 1000).toFixed(1)} s each`) : null)),
        a.lastError ? h('p', { class: 'dm-err' }, a.lastError) : null,
        h('p', { class: 'muted small' }, 'Runs one file at a time at low priority, pauses on request and resumes after a restart. All analysis happens on this server; nothing is uploaded.'),
        aBtns);

      const explain = h('section', { class: 'card dm-card dm-explain' },
        h('h2', null, ic('info'), 'Found versus reclaimable'),
        h('p', null, `${bytes(o.identical.duplicateBytes)} is held in extra identical copies. `,
          h('b', null, `${bytes(o.identical.reclaimable)}`), ' of it can be freed by Grabbit now (its own folders, and app copies the app can merge). The rest belongs to apps that keep their own copy, or is already stored once (hard links).'),
        o.identical.adultGroups ? h('p', { class: 'muted small' }, `${plural(o.identical.adultGroups, 'group involves', 'groups involve')} 18+ folders; they are hidden in the lists until you choose Show 18+.`) : null,
        h('p', { class: 'muted small' }, `Cache & Thumbnails: ${num(o.cache.files)} generated files (${bytes(o.cache.bytes)}) are kept out of the duplicate lists.`));

      const libBox = h('div', null, h('p', { class: 'empty' }, 'Loading ...'));
      const lib = h('details', { class: 'card dm-card dm-lib', ontoggle: (e) => { if (e.currentTarget.open) loadLib(); } },
        h('summary', null, ic('cache'), h('span', null, 'Library Status'), h('span', { class: 'muted small' }, `${(s.roots || []).length} folders`)),
        libBox);
      async function loadLib() {
        try {
          const d = await get('library');
          if (!live(gen)) return;
          fill(libBox, h('div', { class: 'dm-scroll' }, h('table', { class: 'dm-table' },
            h('thead', null, h('tr', null, ['Folder', 'Access', 'Files', 'Read', 'Size', 'Errors'].map((x, i) => h('th', { class: i > 1 ? 'num' : null }, x)))),
            h('tbody', null, d.roots.map((x) => h('tr', null,
              h('td', null, x.label, x.adult ? h('span', { class: 'chip adult' }, '18+') : null, h('div', { class: 'muted small dm-break' }, x.path)),
              h('td', { class: 'small' }, x.access),
              h('td', { class: 'num' }, num(x.files)),
              h('td', { class: 'num' }, num(x.hashed)),
              h('td', { class: 'num' }, bytes(x.bytes)),
              h('td', { class: 'num' }, num(x.errors))))))));
        } catch (e) { fill(libBox, h('p', { class: 'empty' }, e.message)); }
      }

      const hist = (o.history || []).slice(0, 6);
      const histCard = hist.length ? h('section', { class: 'card dm-card' },
        h('h2', null, ic('restore'), 'Recent runs'),
        h('ul', { class: 'dm-hist' }, hist.map((x) => h('li', null,
          h('b', null, x.engine === 'exact' ? 'Exact scan' : 'Analysis'),
          h('span', { class: 'muted small' }, ` ${new Date(x.started_at).toLocaleString()}`),
          h('span', { class: 'small' }, x.finished_at ? ` - ${x.outcome}${x.files != null ? `, ${num(x.files)} files` : ''}${x.bytes ? `, ${bytes(x.bytes)}` : ''}` : ' - running'))))) : null;

      fill(body, stats, h('div', { class: 'dm-grid2' }, scanCard, aCard), explain, lib, histCard);
      if (s.state === 'running' || a.state === 'running') {
        pollTimer = setTimeout(() => { if (live(gen) && !document.querySelector('.dm-lib[open]')) viewOverview(body, gen); else if (live(gen)) pollTimer = setTimeout(() => viewOverview(body, gen), 8000); }, 5000);
      }
    }

    // --- group lists ---------------------------------------------------------------------
    function readFilters(r, tab) {
      const p = r.params;
      return {
        tab,
        status: p.get('status') || 'open',
        app: p.get('app') || '',
        type: p.get('type') || '',
        match: p.get('match') || '',
        deletable: p.get('deletable') || '',
        protected: p.get('protected') || '',
        minBytes: p.get('minBytes') || '',
        minSimilarity: p.get('minSimilarity') || '',
        sort: p.get('sort') || (tab === 'identical' || tab === 'cache' ? 'space' : 'similarity'),
        view: p.get('view') === 'list' ? 'list' : 'grid',
        page: Math.max(0, Number(p.get('page')) || 0),
      };
    }

    async function viewGroups(body, gen, tab, r) {
      const f = readFilters(r, tab);
      const PAGE = 24;
      const q = { ...f, adult: adultMode, limit: PAGE, offset: f.page * PAGE };
      delete q.view;
      delete q.page;
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '' && v != null)).toString();
      const d = await get(`groups?${qs}`);
      if (!live(gen)) return;
      const go = (patch) => { location.hash = link(tab, { ...f, page: 0, ...patch }); };
      const sel = (label, key, options) => h('label', { class: 'dm-field' }, h('span', null, label),
        h('select', { onchange: (e) => go({ [key]: e.currentTarget.value }) },
          options.map(([v, l]) => h('option', { value: v, selected: String(f[key]) === v ? true : null }, l))));
      const toggle = (label, key) => h('label', { class: 'dm-check' },
        h('input', { type: 'checkbox', checked: f[key] === '1' ? true : null, onchange: (e) => go({ [key]: e.currentTarget.checked ? '1' : '' }) }), label);
      const matchOpts = tab === 'photos' ? [['', 'Any match'], ['near', 'Near duplicate'], ['similar', 'Visually similar']]
        : tab === 'videos' ? [['', 'Any match'], ['reencoded', 'Re-encoded'], ['similar', 'Similar video'], ['partial', 'Partial match']]
          : null;
      const filters = h('div', { class: 'dm-filters' },
        sel('Status', 'status', [['open', 'Open'], ['reviewed', 'Reviewed'], ['ignored', 'Ignored'], ['all', 'All']]),
        sel('Source app', 'app', [['', 'All apps'], ...d.apps.map((a) => [a, a])]),
        tab === 'identical' ? sel('Type', 'type', [['', 'All types'], ['image', 'Photos'], ['video', 'Videos'], ['audio', 'Music']]) : null,
        matchOpts ? sel('Match type', 'match', matchOpts) : null,
        sel('File size', 'minBytes', [['', 'Any size'], ['1048576', 'Over 1 MB'], ['10485760', 'Over 10 MB'], ['104857600', 'Over 100 MB'], ['1073741824', 'Over 1 GB']]),
        tab === 'photos' || tab === 'videos' ? sel('Similarity', 'minSimilarity', [['', 'Any'], ['0.9', '90% or more'], ['0.95', '95% or more'], ['0.98', '98% or more']]) : null,
        sel('Sort', 'sort', [['space', 'Largest space saving'], ['similarity', 'Highest similarity'], ['size', 'Largest groups'], ['newest', 'Newest'], ['oldest', 'Oldest'], ['type', 'File type']]),
        h('div', { class: 'dm-checks' }, toggle('Deletable', 'deletable'), toggle('Protected', 'protected')),
        h('label', { class: 'dm-field' }, h('span', null, '18+'),
          h('select', { 'aria-label': '18+ groups', onchange: (e) => { adultMode = e.currentTarget.value; viewGroups(body, generation, tab, r); } },
            [['hide', 'Hidden'], ['show', 'Show 18+'], ['only', 'Only 18+']].map(([v, l]) => h('option', { value: v, selected: adultMode === v ? true : null }, l)))),
        h('div', { class: 'dm-viewsw', role: 'group', 'aria-label': 'View' },
          h('a', { class: 'dm-iconbtn', href: link(tab, { ...f, view: 'grid' }), 'aria-label': 'Grid view', 'aria-pressed': f.view === 'grid' ? 'true' : 'false' }, ic('grid')),
          h('a', { class: 'dm-iconbtn', href: link(tab, { ...f, view: 'list' }), 'aria-label': 'Compact list view', 'aria-pressed': f.view === 'list' ? 'true' : 'false' }, ic('list'))));

      const intro = {
        identical: 'Files with exactly the same bytes. Generated thumbnails and posters are under Cache & Thumbnails.',
        photos: 'Pictures that show the same image or look alike. Nothing is removed for you: pick what to keep in each group.',
        videos: 'Videos that are the same despite other codecs, sizes or bitrates. Partial matches (a clip of a longer video) are listed but never removable.',
        cache: '',
      }[tab];

      const batchBar = h('div', { class: 'dm-batch', hidden: true });
      const updateBatch = () => {
        const n = [...selected].filter((k) => k.startsWith(tab === 'photos' ? 'photo:' : tab === 'videos' ? 'video:' : 'exact:')).length;
        batchBar.hidden = !n;
        const count = batchBar.querySelector('.dm-batch-n');
        if (count) count.textContent = `${num(n)} selected`;
      };
      const keysHere = () => [...selected].filter((k) => k.startsWith(tab === 'photos' ? 'photo:' : tab === 'videos' ? 'video:' : 'exact:'));
      // Selects every group the filter matches (not only this page). Moving
      // copies still goes through "Move selected to Trash" and its summary.
      async function selectMatching() {
        try {
          const s = await post('batch', { filter: { ...q, limit: undefined, offset: undefined }, action: 'mark_reviewed', dryRun: true });
          (s.keys || []).forEach((k) => selected.add(k));
          list.querySelectorAll('.dm-gsel').forEach((c) => { c.checked = selected.has(c.value); });
          updateBatch();
          toast(`${num((s.keys || []).length)} groups selected`);
        } catch (e) { toast(e.message); }
      }
      async function runBatch(action) {
        const payload = { keys: keysHere(), action };
        try {
          const s = await post('batch', { ...payload, dryRun: true });
          const lines = [
            h('ul', { class: 'dm-sum' },
              h('li', null, h('b', null, num(s.groups)), ' groups'),
              h('li', null, h('b', null, num(s.files)), action === 'trash_extras' ? ' extra copies move to the trash' : ' files'),
              action === 'trash_extras' ? h('li', null, h('b', null, bytes(s.bytes)), ' can be freed once the trash is emptied') : null,
              s.apps.length ? h('li', null, 'Apps: ', s.apps.join(', ')) : null,
              s.similarSkipped ? h('li', null, `${num(s.similarSkipped)} similarity groups left alone: choose those copies yourself`) : null,
              s.otherActions ? h('li', null, h('b', null, num(s.otherActions)), ' copies need a merge or an app link instead: not included, open the group to do that') : null,
              s.blockedTotal ? h('li', null, h('b', null, num(s.blockedTotal)), ' copies stay (blocked)') : null),
            s.blocked.length ? h('details', { class: 'dm-blocked' }, h('summary', null, 'Why some copies stay'),
              h('ul', null, s.blocked.slice(0, 20).map((b) => h('li', null, h('b', null, b.name), ': ', b.why, b.fix ? h('div', { class: 'muted small' }, b.fix) : null)))) : null,
          ];
          if (action === 'trash_extras' && !s.files) return dialog('Nothing to move', lines, []);
          const ok = await dialog(action === 'trash_extras' ? 'Move extra copies to the trash?' : 'Apply to the selected groups?', lines,
            [{ label: action === 'trash_extras' ? `Move ${num(s.files)} to the trash` : 'Apply', value: true, danger: action === 'trash_extras' }]);
          if (!ok) return null;
          const out = await post('batch', { ...payload, dryRun: false, expect: { files: s.files } });
          toast(action === 'trash_extras' ? `${num(out.done)} copies moved to the trash${out.refused && out.refused.length ? `; ${num(out.refused.length)} refused` : ''}.` : `${num(out.done)} groups updated.`);
          selected.clear();
          viewGroups(body, generation, tab, r);
        } catch (e) { toast(e.message); }
        return null;
      }
      fill(batchBar,
        h('span', { class: 'dm-batch-n' }),
        tab === 'identical' || tab === 'cache' ? h('button', { class: 'btn small danger', type: 'button', onclick: () => runBatch('trash_extras') }, 'Move selected to Trash') : null,
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => runBatch('mark_reviewed') }, 'Mark selected as reviewed'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { selected.clear(); list.querySelectorAll('.dm-gsel').forEach((c) => { c.checked = false; }); updateBatch(); } }, 'Clear'));

      const selectBar = h('div', { class: 'dm-selectbar' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { d.items.forEach((g) => selected.add(g.key)); list.querySelectorAll('.dm-gsel').forEach((c) => { c.checked = true; }); updateBatch(); } }, 'Select all visible'),
        tab === 'identical' || tab === 'cache' ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => selectMatching() }, `Select all matching filter (${num(d.total)})`) : null,
        tab === 'identical' || tab === 'cache' ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => { d.items.filter((g) => g.deletable).forEach((g) => selected.add(g.key)); list.querySelectorAll('.dm-gsel').forEach((c) => { c.checked = selected.has(c.value); }); updateBatch(); } }, 'Select recommended extras') : null,
        h('span', { class: 'muted small' }, `${num(d.total)} groups`, d.reclaim ? `, ${bytes(d.reclaim)} reclaimable` : '', d.hiddenAdult ? ` - ${num(d.hiddenAdult)} 18+ hidden` : ''));

      const list = h('div', { class: `dm-groups dm-${f.view}` });
      if (!d.items.length) {
        fill(list, h('div', { class: 'dm-emptystate' }, ic(tab === 'photos' ? 'photo' : tab === 'videos' ? 'video' : 'identical', 36),
          h('b', null, f.status === 'open' ? 'Nothing to review here' : 'No groups match'),
          h('p', { class: 'muted' }, tab === 'photos' || tab === 'videos' ? 'The analysis fills this list as it reads your library. Start it on the Overview tab.' : 'Change the filters, or run a scan on the Overview tab.')));
      } else {
        fill(list, d.items.map((g) => groupCard(g, { tab, view: f.view, rerender: () => viewGroups(body, generation, tab, r), updateBatch })));
      }
      const pages = Math.ceil(d.total / PAGE);
      const pager = pages > 1 ? h('nav', { class: 'dm-pager', 'aria-label': 'Pages' },
        f.page > 0 ? h('a', { class: 'btn small ghost', href: link(tab, { ...f, page: f.page - 1 }) }, 'Previous') : null,
        h('span', { class: 'muted small' }, `Page ${f.page + 1} of ${pages}`),
        f.page + 1 < pages ? h('a', { class: 'btn small ghost', href: link(tab, { ...f, page: f.page + 1 }) }, 'Next') : null) : null;
      fill(body, intro ? h('p', { class: 'muted dm-intro' }, intro) : null, filters, selectBar, batchBar, list, pager);
      updateBatch();
      restoreScroll();
    }

    function memberMeta(m) {
      const bits = [];
      if (m.width && m.height) bits.push(`${m.width}x${m.height}`);
      if (m.duration) bits.push(fmtDur(m.duration));
      if (m.vcodec) bits.push(m.vcodec);
      if (m.bitrate && m.kind === 'video') bits.push(`${Math.round(m.bitrate / 1000)} kb/s`);
      bits.push(bytes(m.bytes));
      return bits.join(' - ');
    }

    function groupCard(g, ctx) {
      const rec = g.members.find((m) => m.recommended) || g.members[0];
      const head = h('div', { class: 'dm-ghead' },
        h('label', { class: 'dm-gselwrap', title: 'Select this group' },
          h('input', { type: 'checkbox', class: 'dm-gsel', value: g.key, checked: selected.has(g.key) ? true : null, 'aria-label': 'Select this group',
            onchange: (e) => { if (e.currentTarget.checked) selected.add(g.key); else selected.delete(g.key); ctx.updateBatch(); } })),
        h('div', { class: 'dm-gthumbs' }, g.members.slice(0, ctx.view === 'list' ? 2 : 4).map((m) => thumb(m, ctx.view === 'list' ? 'sm' : 'md'))),
        h('div', { class: 'dm-gmain' },
          h('div', { class: 'dm-gtitle' },
            h('span', { class: `dm-match dm-match-${g.match}`, title: MATCH_HELP[g.match] }, MATCH_LABEL[g.match]),
            g.match !== 'exact' ? h('span', { class: 'dm-score', title: 'Similarity score. A score is evidence, not proof that two files share one original.' }, pct(g.score)) : null,
            g.status !== 'open' ? h('span', { class: 'chip' }, STATUS_LABEL[g.status] || g.status) : null,
            g.adult ? h('span', { class: 'chip adult' }, '18+') : null),
          h('div', { class: 'dm-gname dm-break' }, rec.name),
          h('div', { class: 'muted small' },
            `${plural(g.files, 'copy', 'copies')} - ${bytes(g.bytes)}${g.match === 'exact' ? ' each' : ' largest'}`,
            g.reclaim ? h('b', { class: 'dm-reclaim' }, ` - ${bytes(g.reclaim)} reclaimable`) : g.protected ? h('span', null, ' - ', ic('lock', 12), ' protected') : null),
          h('div', { class: 'dm-apps' }, g.apps.map((a) => h('span', { class: 'chip' }, a)))),
        h('button', { class: 'dm-iconbtn dm-expand', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Show the copies', onclick: (e) => toggleOpen(e.currentTarget) }, ic('expand')));
      const detail = h('div', { class: 'dm-gdetail', hidden: true });
      const card = h('article', { class: `dm-group${g.adult ? ' dm-adult' : ''}`, 'data-key': g.key }, head, detail);
      let built = false;
      function toggleOpen(btn) {
        const open = detail.hidden;
        detail.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        card.classList.toggle('dm-open', open);
        if (open && !built) { built = true; buildDetail(); }
      }
      function buildDetail() {
        const keep = new Set([g.keepId]);
        const rows = g.members.map((m) => {
          const box = h('input', { type: 'checkbox', checked: keep.has(m.id) ? true : null, 'aria-label': `Keep ${m.name}`,
            onchange: (e) => { if (e.currentTarget.checked) keep.add(m.id); else keep.delete(m.id); } });
          return h('li', { class: `dm-member${m.recommended ? ' dm-rec' : ''}` },
            h('label', { class: 'dm-keep' }, box, h('span', null, 'Keep')),
            thumb(m, 'md'),
            h('div', { class: 'dm-minfo' },
              h('div', null, m.recommended ? h('span', { class: 'dm-recbadge' }, ic('star', 12), 'Recommended') : null,
                h('b', { class: 'dm-break' }, m.name)),
              h('div', { class: 'muted small dm-break' }, `${m.app || m.rootLabel} - ${m.rel}`),
              h('div', { class: 'small' }, memberMeta(m), ` - ${date(m.mtime_ms)}`, m.copies > 1 ? ` - ${m.copies} identical copies` : ''),
              m.item ? h('div', { class: 'small' }, 'Library item: ', h('b', null, m.item.creator || '-'), m.item.title ? ` ${m.item.title}` : '') : null,
              m.matchWhy && m.matchWhy.length ? h('ul', { class: 'dm-why' }, m.matchWhy.map((w) => h('li', null, w))) : null,
              m.reasons && m.reasons.length ? h('div', { class: 'small dm-reasons' }, m.reasons.join(' - ')) : null,
              h('div', { class: `small dm-status${m.action ? ' dm-can' : ' dm-cant'}` },
                m.action ? ic(m.action === 'trash' ? 'trash' : 'merge', 12) : m.recommended ? ic('check', 12) : ic('lock', 12),
                ` ${m.why || ''}`),
              m.fix ? h('div', { class: 'small dm-fix' }, m.fix) : null));
        });
        const refsBox = h('div', { class: 'dm-refs' });
        const showRefs = g.members.some((m) => m.app === 'TikShortis' || m.app === 'egram');
        const act = (action, label, opts = {}) => h('button', { class: `btn small${opts.danger ? ' danger' : ' ghost'}`, type: 'button', disabled: opts.disabled ? true : null, title: opts.title || null,
          onclick: async (e) => {
            const btn = e.currentTarget;
            if (opts.confirm) {
              const ok = await opts.confirm();
              if (!ok) return;
            }
            await busyBtn(btn, async () => {
              try {
                const out = await post('groups/action', { key: g.key, action, keep: [...keep] });
                if (out.done || out.refused) {
                  toast(`${num(out.done.length)} done${out.refused.length ? `, ${num(out.refused.length)} refused: ${out.refused[0].error}` : ''}.`);
                } else toast(`Marked ${STATUS_LABEL[out.status] || out.status}.`);
                ctx.rerender();
              } catch (err) { toast(err.message); }
            });
          } }, label);
        const goers = () => g.members.filter((m) => !keep.has(m.id));
        const canGo = (list) => list.filter((m) => m.action);
        const confirmKeepSelected = async () => {
          const go = goers();
          if (!keep.size) { toast('Choose at least one copy to keep.'); return false; }
          const can = canGo(go);
          return dialog('Keep the selected copies?', [
            h('p', null, `${plural(keep.size, 'copy stays', 'copies stay')}. ${plural(can.length, 'copy goes', 'copies go')} to the trash or is merged (restorable).`),
            go.length > can.length ? h('p', { class: 'muted small' }, `${num(go.length - can.length)} other copies cannot be removed here and stay.`) : null,
            g.match !== 'exact' ? h('p', { class: 'dm-warn' }, 'These files are not identical. Check the comparison first: a similar picture can be a different original.') : null,
          ], [{ label: 'Keep selected', value: true, danger: true }]);
        };
        const extras = g.members.filter((m) => m.suggested && m.action);
        const hasLink = extras.some((m) => m.action === 'link' || m.action === 'merge');
        const hasTrash = extras.some((m) => m.action === 'trash');
        const actions = h('div', { class: 'dm-gactions' },
          h('button', { class: 'btn small', type: 'button', onclick: () => compare(g) }, ic('compare', 14), ' Compare side by side'),
          act('keep', 'Keep', { title: 'Keep the recommended copy and mark the group reviewed' }),
          act('keep_both', g.files > 2 ? 'Keep multiple' : 'Keep both', { title: 'Every copy stays; the group is not offered again' }),
          act('keep_selected', 'Keep selected', { danger: true, confirm: confirmKeepSelected }),
          g.match === 'exact' && hasTrash ? act('trash_extras', 'Move extra copies to Trash', { danger: true, confirm: () => dialog('Move the extra copies to the trash?', [h('p', null, `${plural(extras.filter((m) => m.action === 'trash').length, 'copy moves', 'copies move')} to the trash. The recommended copy stays. You can restore them.`)], [{ label: 'Move to Trash', value: true, danger: true }]) }) : null,
          g.match === 'exact' && hasLink ? act('merge', 'Merge references', { title: 'Every post or library entry keeps working; the file is stored once', confirm: () => dialog('Merge references?', [h('p', null, 'The copies become one stored file with several names. Every post, library entry, like and comment keeps working. The original extra copy is held in the trash until you empty it.')], [{ label: 'Merge', value: true }]) }) : null,
          act('mark_known', 'Mark known/OK'),
          act('ignore', 'Ignore group'),
          g.status !== 'open' ? act('reopen', 'Open again') : null);
        fill(detail,
          g.explain && g.explain.summary ? h('p', { class: 'small dm-explain-line' }, ic('info', 14), ` ${g.explain.summary}`) : null,
          g.recommendation && g.recommendation.reasons.length ? h('p', { class: 'small' }, h('b', null, 'Why the recommendation: '), g.recommendation.reasons.join(', ')) : null,
          h('ul', { class: 'dm-members' }, rows),
          showRefs ? h('button', { class: 'btn small ghost', type: 'button', onclick: async (e) => {
            const btn = e.currentTarget;
            await busyBtn(btn, async () => {
              try {
                const r2 = await get(`groups/${enc(g.key)}/references`);
                fill(refsBox, Object.entries(r2.references).map(([id, ref]) => {
                  const m = g.members.find((x) => String(x.id) === id);
                  return h('div', { class: 'small' }, h('b', null, m ? m.name : id), ': ',
                    ref.error ? ref.error : (ref.refs || []).length ? ref.refs.map((x) => `${x.type} ${x.label || x.id}${x.likes != null ? ` (${x.likes} likes, ${x.comments || 0} comments)` : ''}`).join('; ') : 'not used by any post');
                }));
              } catch (err) { toast(err.message); }
            });
          } }, 'Show posts using these files') : null,
          refsBox,
          actions);
      }
      return card;
    }

    // --- side-by-side comparison --------------------------------------------------------------
    function compare(g) {
      closeOverlay();
      const members = g.members.filter((m) => m.preview);
      if (members.length < 2) return toast('Previews are hidden for this group (18+). Choose Show 18+ to compare.');
      const partial = g.match === 'partial';
      // A partial match is a source and a clip: neither is "recommended".
      let pair = partial
        ? [members.find((m) => m.role === 'source') || members[0], members.find((m) => m.role === 'clip') || members[1]]
        : [members.find((m) => m.recommended) || members[0], members.find((m) => !m.recommended) || members[1]];
      const shown = (m) => (partial ? false : m.recommended);
      // Where the clip sits in the source, so synchronized playback lines up.
      const offsetOf = () => (partial ? Number((pair[1] || {}).offset) || 0 : 0);
      const panes = h('div', { class: 'dm-cmp-panes' });
      const controls = h('div', { class: 'dm-cmp-controls' });
      const table = h('div', { class: 'dm-cmp-table' });
      const isVideo = g.mediaType === 'video';
      let videos = [];
      const box = h('div', { class: 'dm-cmp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Compare side by side' },
        h('div', { class: 'dm-cmp-top' },
          h('b', null, MATCH_LABEL[g.match], g.match !== 'exact' ? ` - ${pct(g.score)}` : ''),
          members.length > 2 ? h('label', { class: 'dm-field dm-cmp-pick' }, h('span', null, 'Compare with'),
            h('select', { onchange: (e) => { pair = [pair[0], members.find((m) => String(m.id) === e.currentTarget.value)]; draw(); } },
              members.filter((m) => m.id !== pair[0].id).map((m) => h('option', { value: String(m.id) }, m.name)))) : null,
          h('button', { class: 'dm-iconbtn', type: 'button', 'aria-label': 'Fullscreen', onclick: () => { if (document.fullscreenElement) document.exitFullscreen(); else box.requestFullscreen && box.requestFullscreen().catch(() => {}); } }, ic('fullscreen')),
          h('button', { class: 'dm-iconbtn', type: 'button', 'aria-label': 'Close', onclick: closeOverlay }, ic('close'))),
        panes, controls, table);
      overlay = h('div', { class: 'dm-overlay dm-overlay-cmp' }, box);
      host().append(overlay);
      document.addEventListener('keydown', escClose);
      function draw() {
        videos.forEach((v) => { try { v.pause(); } catch {} });
        videos = [];
        fill(panes, pair.map((m) => {
          const src = `/api/hub/dupes/file/${m.id}`;
          let media;
          if (isVideo) {
            media = h('video', { src, preload: 'metadata', playsinline: true, muted: true });
            videos.push(media);
          } else {
            media = h('img', { src, alt: m.name, 'data-media-bg': '1' });
          }
          return h('figure', { class: `dm-cmp-pane${shown(m) ? ' dm-rec' : ''}` }, media,
            h('figcaption', null, shown(m) ? h('span', { class: 'dm-recbadge' }, ic('star', 12), 'Recommended') : null,
              partial ? h('span', { class: 'chip' }, m.role === 'clip' ? `Clip, from ${fmtDur(offsetOf())} in the source` : 'Source video') : null,
              h('span', { class: 'dm-break' }, m.name)));
        }));
        if (isVideo) {
          const [a, b] = videos;
          const play = h('button', { class: 'dm-iconbtn', type: 'button', 'aria-label': 'Play' }, ic('play'));
          const scrub = h('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Position', class: 'dm-scrub' });
          const time = h('span', { class: 'small muted' }, '0:00');
          const sync = h('label', { class: 'dm-check' }, h('input', { type: 'checkbox', checked: true }), 'Synchronized');
          const synced = () => sync.querySelector('input').checked;
          const both = (fn) => (synced() ? videos : [a]).forEach(fn);
          play.onclick = () => {
            if (a.paused) { both((v) => v.play().catch(() => {})); fill(play, ic('pause')); play.setAttribute('aria-label', 'Pause'); } else { videos.forEach((v) => v.pause()); fill(play, ic('play')); play.setAttribute('aria-label', 'Play'); }
          };
          // Where B should be when A is at t: the same moment of the video
          // (scaled for two renditions of one length), or t minus the clip's
          // offset for a partial match.
          const bAt = (t) => (partial ? t - offsetOf() : t * (b.duration / a.duration));
          a.addEventListener('timeupdate', () => {
            if (!a.duration) return;
            scrub.value = String(Math.round((a.currentTime / a.duration) * 1000));
            time.textContent = `${fmtDur(a.currentTime)} / ${fmtDur(a.duration)}`;
            if (!synced() || !b.duration) return;
            const want = bAt(a.currentTime);
            if (want < 0 || want > b.duration) { if (!b.paused) b.pause(); return; }
            if (b.paused && !a.paused) b.play().catch(() => {});
            if (Math.abs(b.currentTime - want) > 0.4) b.currentTime = want;
          });
          scrub.oninput = () => {
            const t = (Number(scrub.value) / 1000) * (a.duration || 0);
            a.currentTime = t;
            if (synced() && b.duration) b.currentTime = Math.max(0, Math.min(b.duration, bAt(t)));
          };
          fill(controls, play, scrub, time, sync);
        } else {
          fill(controls, h('span', { class: 'muted small' }, 'Pictures are shown fitted to the pane; open one in Fullscreen for detail.'));
        }
        const rowsDef = [
          ['Duration', (m) => (m.duration ? fmtDur(m.duration) : '-'), isVideo],
          ['Resolution', (m) => (m.width ? `${m.width}x${m.height}` : '-'), true],
          ['Codec / format', (m) => m.vcodec || m.container || '-', true],
          ['Bitrate', (m) => (m.bitrate ? `${Math.round(m.bitrate / 1000)} kb/s` : '-'), isVideo],
          ['Audio', (m) => m.acodec || 'none', isVideo],
          ['File size', (m) => bytes(m.bytes), true],
          ['Source app', (m) => m.app || m.rootLabel, true],
          ['Date', (m) => date(m.mtime_ms), true],
          ['Recommended', (m) => (shown(m) ? 'Yes' : '-'), !partial],
          ['Why', (m) => (m.reasons || []).join(', ') || '-', true],
        ].filter((x) => x[2]);
        fill(table, h('table', { class: 'dm-table' },
          h('thead', null, h('tr', null, h('th', null, ''), pair.map((m) => h('th', null, partial ? (m.role === 'clip' ? 'Clip' : 'Source') : m.recommended ? 'Recommended' : 'Other copy')))),
          h('tbody', null, rowsDef.map(([label, fn]) => h('tr', null, h('th', { scope: 'row' }, label), pair.map((m) => h('td', null, fn(m))))))));
      }
      draw();
    }

    // --- Cache & Thumbnails ---------------------------------------------------------------
    async function viewCache(body, gen, r) {
      fill(body, h('p', { class: 'empty' }, 'Loading ...'));
      const c = await get('cache');
      if (!live(gen)) return;
      const appCards = c.apps.map((a) => {
        const out = h('div', { class: 'small' });
        const run = (action, dry) => async (e) => {
          const btn = e.currentTarget;
          await busyBtn(btn, async () => {
            try {
              if (action === 'rebuild' && !dry) {
                // egram stops a rebuild after its time budget and reports what
                // is left; call again until nothing is left or no progress is made.
                let made = 0;
                let failed = 0;
                let x = {};
                for (let round = 0; round < 50; round++) {
                  btn.textContent = made ? `Rebuilding ... ${num(made)} made` : 'Rebuilding ...';
                  x = (await post(`cache/${a.id}/rebuild`, { dryRun: false })).result || {};
                  made += x.made || 0;
                  failed += x.failed || 0;
                  const more = (x.stoppedEarly && x.stopReason === 'time') || (x.remaining || 0) > 0;
                  if (!more || x.stopReason === 'disconnected' || (!x.made && !x.inProgress)) break;
                }
                const left = x.remaining || 0;
                toast(`${num(made)} thumbnails made${failed ? `, ${num(failed)} failed` : ''}${left ? `; ${num(left)} still missing` : ''}.`);
                viewCache(body, generation, r);
                return null;
              }
              const res = await post(`cache/${a.id}/${action}`, { dryRun: dry });
              const x = res.result || {};
              if (dry) {
                const ok = await dialog(action === 'clean' ? 'Clean unused cache?' : 'Rebuild thumbnails?', [
                  h('p', null, action === 'clean'
                    ? `${num(x.files || 0)} unused generated files (${bytes(x.bytes || 0)}) in ${a.app}. They are rebuilt from the originals if ever needed.`
                    : `${num(x.missing || 0)} thumbnails are missing in ${a.app}${x.limit ? `; they are made in batches of up to ${num(x.limit)} until none is left` : ''}.`),
                ], [{ label: action === 'clean' ? 'Clean' : 'Rebuild', value: true, danger: action === 'clean' }]);
                if (ok) return run(action, false)({ currentTarget: btn });
                return null;
              }
              toast(action === 'clean' ? `${num(x.files || 0)} files removed (${bytes(x.bytes || 0)}).` : `${num(x.made || 0)} thumbnails made.`);
              viewCache(body, generation, r);
            } catch (err) { toast(err.message); }
            return null;
          });
        };
        if (!a.ok) fill(out, h('p', { class: 'dm-err' }, a.error), a.fix ? h('p', { class: 'small dm-fix' }, a.fix) : null);
        else {
          fill(out, h('dl', { class: 'dm-facts' },
            h('dt', null, 'Thumbnails'), h('dd', null, `${num(a.thumbs || 0)} (${bytes(a.thumbBytes || 0)})`),
            h('dt', null, 'Unused (orphaned)'), h('dd', null, `${num(a.orphans || 0)} (${bytes(a.orphanBytes || 0)})`),
            h('dt', null, 'Duplicate thumbnails'), h('dd', null, `${num(a.duplicates || 0)}`),
            h('dt', null, 'Missing'), h('dd', null, `${num(a.missing || 0)}`)),
          a.note ? h('p', { class: 'muted small' }, a.note) : null);
        }
        return h('section', { class: 'card dm-card' }, h('h2', null, ic('cache'), a.app), out,
          a.ok ? h('div', { class: 'dm-btns' },
            h('button', { class: 'btn small ghost danger', type: 'button', onclick: run('clean', true) }, 'Clean unused cache'),
            h('button', { class: 'btn small ghost', type: 'button', onclick: run('clean', true) }, 'Remove duplicate thumbnails'),
            h('button', { class: 'btn small ghost', type: 'button', onclick: run('rebuild', true) }, 'Rebuild thumbnails')) : null);
      });
      const kinds = h('section', { class: 'card dm-card' }, h('h2', null, ic('cache'), 'Generated files in the scanned folders'),
        c.kinds.length ? h('div', { class: 'dm-scroll' }, h('table', { class: 'dm-table' },
          h('thead', null, h('tr', null, h('th', null, 'App'), h('th', null, 'Kind'), h('th', { class: 'num' }, 'Files'), h('th', { class: 'num' }, 'Size'), h('th', null, 'Rebuildable'))),
          h('tbody', null, c.kinds.map((k) => h('tr', null, h('td', null, k.app), h('td', null, k.what), h('td', { class: 'num' }, num(k.files)), h('td', { class: 'num' }, bytes(k.bytes)), h('td', null, k.regenerable ? 'Yes' : 'No')))))) : h('p', { class: 'empty' }, 'None found.'));
      const stats = h('div', { class: 'dm-stats' },
        statTile('Cache files', num(c.files), null, 'cache'),
        statTile('Total size', bytes(c.bytes), null, 'cache'),
        statTile('Duplicate thumbnails', num(c.duplicateFiles), `${num(c.duplicateGroups)} groups`, 'identical'),
        statTile('Possible space freed', bytes(c.duplicateBytes + c.apps.reduce((n, a) => n + (a.orphanBytes || 0), 0)), null, 'restore'));
      const groupsBox = h('div');
      fill(body, h('p', { class: 'muted dm-intro' }, 'Thumbnails, posters, previews and caches that apps generate. They are left out of the duplicate lists and cleaned through the app that owns them.'),
        stats, h('div', { class: 'dm-grid2' }, appCards, kinds), h('h2', { class: 'dm-subhead' }, 'Identical generated files'), groupsBox);
      await viewGroups(groupsBox, gen, 'cache', r);
    }

    // --- Trash ------------------------------------------------------------------------------
    async function viewTrash(body, gen, r) {
      const p = r.params;
      const f = { q: p.get('q') || '', app: p.get('app') || '', type: p.get('type') || '', page: Math.max(0, Number(p.get('page')) || 0) };
      const PAGE = 50;
      const qs = new URLSearchParams(Object.entries({ q: f.q, app: f.app, type: f.type, adult: adultMode, limit: PAGE, offset: f.page * PAGE }).filter(([, v]) => v !== '' && v != null)).toString();
      const d = await get(`trash?${qs}`);
      if (!live(gen)) return;
      const tsel = new Set();
      const go = (patch) => { location.hash = link('trash', { ...f, page: 0, ...patch }); };
      const days = d.summary.retentionDays;
      const stats = h('div', { class: 'dm-stats' },
        statTile('Total files', num(d.summary.files), null, 'trash'),
        statTile('Total size', bytes(d.summary.bytes), 'freed when deleted', 'cache'),
        statTile('Kept for', days ? `${days} days` : 'Until you empty it', days ? 'then deleted automatically' : 'manual cleanup only', 'restore', '#/duplicates/settings'));
      const search = h('input', { type: 'search', value: f.q, placeholder: 'Search file names and reasons', 'aria-label': 'Search the trash' });
      const filters = h('form', { class: 'dm-filters', onsubmit: (e) => { e.preventDefault(); go({ q: search.value.trim() }); } },
        h('label', { class: 'dm-field dm-grow' }, h('span', null, 'Search'), search),
        h('label', { class: 'dm-field' }, h('span', null, 'Source app'), h('select', { onchange: (e) => go({ app: e.currentTarget.value }) },
          [['', 'All apps'], ...d.apps.map((a) => [a, a])].map(([v, l]) => h('option', { value: v, selected: f.app === v ? true : null }, l)))),
        h('label', { class: 'dm-field' }, h('span', null, 'Media type'), h('select', { onchange: (e) => go({ type: e.currentTarget.value }) },
          [['', 'All'], ['image', 'Photos'], ['video', 'Videos'], ['audio', 'Music']].map(([v, l]) => h('option', { value: v, selected: f.type === v ? true : null }, l)))),
        h('label', { class: 'dm-field' }, h('span', null, '18+'), h('select', { onchange: (e) => { adultMode = e.currentTarget.value; viewTrash(body, generation, r); } },
          [['hide', 'Hidden'], ['show', 'Show 18+'], ['only', 'Only 18+']].map(([v, l]) => h('option', { value: v, selected: adultMode === v ? true : null }, l)))));
      const selN = h('span', { class: 'small muted' }, '0 selected');
      const upd = () => { selN.textContent = `${num(tsel.size)} selected`; };
      async function doRestore(ids, all = false) {
        try {
          const out = await post('trash/restore', all ? { all: true } : { ids });
          toast(`${num(out.done.length)} restored${out.done.some((x) => x.renamed) ? ' (some under a new name: a newer file had taken the place)' : ''}${out.refused.length ? `; ${num(out.refused.length)} refused: ${out.refused[0].error}` : ''}.`);
          viewTrash(body, generation, r);
        } catch (e) { toast(e.message); }
      }
      async function doDelete(ids) {
        const list = d.items.filter((t) => ids.includes(t.id));
        const sum = list.reduce((n, t) => n + t.bytes, 0);
        const ok = await dialog('Delete permanently?', [h('p', null, `${plural(ids.length, 'file', 'files')} (${bytes(sum)}) will be deleted for good. This cannot be undone.`)], [{ label: 'Delete permanently', value: true, danger: true }]);
        if (!ok) return;
        try {
          const out = await post('trash/delete', { ids });
          toast(`${num(out.done)} deleted, ${bytes(out.bytes)} freed${out.refused.length ? `; ${num(out.refused.length)} refused: ${out.refused[0].error}` : ''}.`);
          viewTrash(body, generation, r);
        } catch (e) { toast(e.message); }
      }
      async function doEmpty() {
        const s = (await get('trash?limit=1')).summary;
        const ok = await dialog('Empty the trash?', [
          h('p', null, h('b', null, plural(s.files, 'file', 'files')), ' - ', h('b', null, bytes(s.bytes)), ' will be deleted permanently.'),
          h('p', { class: 'muted small' }, 'This includes 18+ entries hidden in the list. App-held copies are deleted by their app. This cannot be undone.'),
        ], [{ label: `Delete ${num(s.files)} files`, value: true, danger: true }]);
        if (!ok) return;
        try {
          const out = await post('trash/empty', { expect: { files: s.files, bytes: s.bytes, fingerprint: s.fingerprint } });
          toast(`Trash emptied: ${num(out.done)} files, ${bytes(out.bytes)} freed${out.refused.length ? `; ${num(out.refused.length)} refused` : ''}.`);
          viewTrash(body, generation, r);
        } catch (e) { toast(e.message); }
      }
      const bar = h('div', { class: 'dm-selectbar' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { d.items.forEach((t) => tsel.add(t.id)); rowsBox.querySelectorAll('.dm-tsel').forEach((c) => { c.checked = true; }); upd(); } }, 'Select all'),
        selN,
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => (tsel.size ? doRestore([...tsel]) : toast('Select something first.')) }, 'Restore selected'),
        h('button', { class: 'btn small ghost', type: 'button', disabled: d.summary.files ? null : true, onclick: async () => {
          const ok = await dialog('Restore everything?', [h('p', null, `${plural(d.summary.files, 'file goes', 'files go')} back to where they were.`)], [{ label: 'Restore all', value: true }]);
          if (ok) doRestore([], true);
        } }, 'Restore all'),
        // The permanent actions sit apart from the restore ones, so a mis-tap
        // between them is unlikely; both still ask for confirmation.
        h('div', { class: 'dm-destructive' },
          h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => (tsel.size ? doDelete([...tsel]) : toast('Select something first.')) }, 'Delete selected permanently'),
          h('button', { class: 'btn small dm-danger-solid', type: 'button', disabled: d.summary.files ? null : true, onclick: doEmpty }, 'Empty Trash')));
      const rowsBox = h('ul', { class: 'dm-trash' });
      if (!d.items.length) {
        fill(rowsBox, h('li', { class: 'dm-emptystate' }, ic('trash', 36), h('b', null, d.summary.files ? 'Nothing matches' : 'The trash is empty'),
          d.hiddenAdult ? h('p', { class: 'muted' }, `${num(d.hiddenAdult)} 18+ entries hidden.`) : null));
      } else {
        fill(rowsBox, d.items.map((t) => h('li', { class: 'dm-trow' },
          h('input', { type: 'checkbox', class: 'dm-tsel', 'aria-label': `Select ${t.name}`, onchange: (e) => { if (e.currentTarget.checked) tsel.add(t.id); else tsel.delete(t.id); upd(); } }),
          t.preview && t.kind === 'image' && t.source === 'grabbit'
            ? h('div', { class: 'dm-thumb dm-thumb-sm' }, h('img', { src: `${BASE}/trash/${t.id}/file`, alt: '', loading: 'lazy', 'data-media-bg': '1' }))
            : h('div', { class: 'dm-thumb dm-thumb-sm dm-thumb-hidden' }, t.audience === 'adult' && !t.preview ? h('span', null, '18+') : ic(t.kind === 'video' ? 'video' : t.kind === 'image' ? 'photo' : 'identical', 18)),
          h('div', { class: 'dm-minfo' },
            h('b', { class: 'dm-break' }, t.name),
            h('div', { class: 'muted small dm-break' }, `${t.app} - ${t.rootLabel}/${t.rel}`),
            h('div', { class: 'small' }, `${bytes(t.bytes)} - removed ${date(t.at)}`, t.expiresAt ? ` - deleted ${date(t.expiresAt)}` : ' - kept until you empty it', ` - ${t.reason}`)),
          h('div', { class: 'dm-tact' },
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => doRestore([t.id]) }, ic('restore', 14), ' Restore'),
            h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => doDelete([t.id]) }, 'Delete')))));
      }
      // App calls that stopped half way: the app may have carried them out,
      // so they wait here until the owner has looked in the app.
      const unfinished = (d.unfinished || []).length ? h('section', { class: 'card dm-card' },
        h('h2', null, ic('restore', 16), ' Unfinished app operations'),
        h('p', { class: 'dm-warn' }, 'These apps stopped answering half way. The change may or may not have happened; Grabbit has not recorded it in the trash.'),
        h('ul', { class: 'dm-trash' }, d.unfinished.map((o) => h('li', { class: 'dm-trow' },
          h('div', { class: 'dm-minfo' },
            h('b', { class: 'dm-break' }, `${o.app}: ${o.what}`),
            h('div', { class: 'small dm-break' }, o.check),
            h('div', { class: 'muted small' }, `Started ${date(o.at)}`)),
          h('div', { class: 'dm-tact' },
            h('button', { class: 'btn small ghost', type: 'button', onclick: async (e) => {
              const btn = e.currentTarget;
              const ok = await dialog('Mark as checked?', [h('p', null, `Only do this after you have looked in ${o.app}. The entry leaves this list; nothing is changed in ${o.app} or in Grabbit's trash.`)], [{ label: 'Checked', value: true }]);
              if (!ok) return;
              await busyBtn(btn, async () => {
                try { await post(`ops/${o.id}/checked`); viewTrash(body, generation, r); } catch (err) { toast(err.message); }
              });
            } }, 'Mark checked')))))) : null;
      const pages = Math.ceil(d.total / PAGE);
      fill(body, stats, unfinished, filters, bar, rowsBox,
        pages > 1 ? h('nav', { class: 'dm-pager' },
          f.page > 0 ? h('a', { class: 'btn small ghost', href: link('trash', { ...f, page: f.page - 1 }) }, 'Previous') : null,
          h('span', { class: 'muted small' }, `Page ${f.page + 1} of ${pages}`),
          f.page + 1 < pages ? h('a', { class: 'btn small ghost', href: link('trash', { ...f, page: f.page + 1 }) }, 'Next') : null) : null);
      restoreScroll();
    }

    // --- Settings -----------------------------------------------------------------------------
    async function viewSettings(body, gen) {
      const d = await get('settings');
      if (!live(gen)) return;
      const s = d.settings;
      const m = d.models;
      const form = h('form', { class: 'dm-settings', onsubmit: (e) => e.preventDefault() });
      const sw = (label, key, help, disabled) => h('label', { class: 'dm-switch' },
        h('input', { type: 'checkbox', name: key, checked: s[key] ? true : null, disabled: disabled ? true : null }),
        h('span', null, h('b', null, label), help ? h('small', { class: 'muted' }, help) : null));
      const selectF = (label, name, value, options, help) => h('label', { class: 'dm-field' }, h('span', null, label),
        h('select', { name }, options.map(([v, l]) => h('option', { value: String(v), selected: String(value) === String(v) ? true : null }, l))),
        help ? h('small', { class: 'muted' }, help) : null);
      const slider = h('input', { type: 'range', name: 'sensitivity', min: '0', max: '100', value: String(s.sensitivity), 'aria-label': 'Custom sensitivity' });
      const sliderOut = h('output', null, String(s.sensitivity));
      slider.addEventListener('input', () => { sliderOut.textContent = slider.value; });
      const modelRows = m.models.map((x) => h('li', null,
        h('label', { class: 'dm-radio' }, h('input', { type: 'radio', name: 'model', value: x.id, checked: s.model === x.id ? true : null }),
          h('span', null, h('b', null, x.label), h('small', { class: 'muted' }, ` about ${x.ramMb} MB memory`))),
        x.installed ? h('span', { class: 'chip keep' }, 'Installed')
          : x.downloading ? h('span', { class: 'chip' }, `Downloading ${pct(x.downloading.bytes / x.downloading.total)}`)
            : h('button', { class: 'btn small ghost', type: 'button', onclick: async (e) => {
              const btn = e.currentTarget;
              await busyBtn(btn, async () => { try { await post(`models/${x.id}/download`); toast('Download started. It continues in the background.'); } catch (err) { toast(err.message); } });
              setTimeout(() => { if (live(gen)) viewSettings(body, gen); }, 3000);
            } }, `Download (${bytes(x.bytes)})`),
        x.lastError ? h('p', { class: 'dm-err' }, `Last download failed: ${x.lastError}`) : null));
      const prev = s.prevention;
      fill(form,
        h('section', { class: 'card dm-card' }, h('h2', null, ic('scan'), 'Exact Match scan'),
          h('label', { class: 'dm-field' }, h('span', null, 'Read speed limit (MB/s)'), h('input', { type: 'number', name: 'scanMbps', min: '1', max: '500', value: s.scanMbps || '', placeholder: 'Server default (20)' }),
            h('small', { class: 'muted' }, 'Lower it if other apps feel slow while a scan runs.'))),
        h('section', { class: 'card dm-card' }, h('h2', null, ic('photo'), 'AI Photo Engine'),
          sw('Find similar photos', 'photo', 'Perceptual hashes; cheap and always local.', !m.flags.photo),
          sw('AI comparison (DINOv2)', 'ai', m.runtime ? 'Finds edited and cropped copies more reliably. Runs on this server.' : 'Not available in this build.', !m.flags.ai || !m.runtime),
          h('ul', { class: 'dm-models' }, modelRows),
          h('p', { class: 'muted small' }, 'Changing the model keeps every decision you made; pictures are compared again with the new model.'),
          selectF('Matching mode', 'mode', s.mode, [['strict', 'Strict'], ['balanced', 'Balanced'], ['relaxed', 'Relaxed'], ['custom', 'Custom sensitivity']]),
          h('label', { class: 'dm-field' }, h('span', null, 'Custom sensitivity (0 strict - 100 relaxed)'), h('div', { class: 'dm-row' }, slider, sliderOut))),
        h('section', { class: 'card dm-card' }, h('h2', null, ic('video'), 'Video Fingerprint Engine'),
          sw('Find re-encoded and similar videos', 'video', 'Reads keyframes with ffmpeg at low priority.', !m.flags.video),
          selectF('Worker threads for AI', 'threads', s.threads, [[1, '1 (gentlest)'], [2, '2'], [3, '3'], [4, '4']]),
          selectF('Pause between files', 'pauseMs', s.pauseMs, [[0, 'None'], [150, '0.15 s'], [500, '0.5 s'], [2000, '2 s']])),
        h('section', { class: 'card dm-card' }, h('h2', null, ic('star'), 'Smart Quality Selection'),
          selectF('Default rule', 'defaultRule', s.defaultRule, [['recommended', 'Recommended'], ['highest_quality', 'Highest quality'], ['highest_resolution', 'Highest resolution'], ['largest', 'Largest file'], ['smallest', 'Smallest file'], ['oldest', 'Oldest'], ['newest', 'Newest'], ['keep_original', 'Keep original'], ['manual', 'Manual selection']],
            'You can always choose another copy in each group.')),
        h('section', { class: 'card dm-card' }, h('h2', null, ic('trash'), 'Smart Trash'),
          selectF('Keep removed copies for', 'trashRetentionDays', s.trashRetentionDays, [[7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [0, 'Manual cleanup only']])),
        h('section', { class: 'card dm-card' }, h('h2', null, ic('identical'), 'Duplicate Prevention'),
          h('label', { class: 'dm-switch' }, h('input', { type: 'checkbox', name: 'prevention.enabled', checked: prev.enabled ? true : null }), h('span', null, h('b', null, 'Check new downloads'), h('small', { class: 'muted' }, 'After a save, without slowing the download.'))),
          selectF('When the exact file already exists', 'prevention.exact', prev.exact, [['review', 'Send to duplicate review'], ['keep', 'Keep separate post'], ['skip', 'Skip exact duplicate (to Trash)'], ['link', 'Link to existing media']],
            'Skip and Link apply only inside Grabbit\'s own library; a new post in an app always stays.'),
          selectF('When a picture looks like one already there', 'prevention.perceptual', prev.perceptual, [['review', 'Send to duplicate review'], ['keep', 'Keep both']], 'AI and perceptual matches are never acted on automatically.')),
        h('div', { class: 'dm-btns dm-save' }, h('button', { class: 'btn', type: 'submit', onclick: save }, 'Save settings')));
      async function save(e) {
        const btn = e.currentTarget;
        const fd = new FormData(form);
        const bool = (n) => form.querySelector(`[name="${n}"]`) && form.querySelector(`[name="${n}"]`).checked;
        const patch = {
          scanMbps: fd.get('scanMbps') ? Number(fd.get('scanMbps')) : null,
          photo: bool('photo'), ai: bool('ai'), video: bool('video'),
          model: fd.get('model') || s.model, mode: fd.get('mode'), sensitivity: Number(fd.get('sensitivity')),
          threads: Number(fd.get('threads')), pauseMs: Number(fd.get('pauseMs')), defaultRule: fd.get('defaultRule'),
          trashRetentionDays: Number(fd.get('trashRetentionDays')),
          prevention: { enabled: bool('prevention.enabled'), exact: fd.get('prevention.exact'), perceptual: fd.get('prevention.perceptual') },
        };
        // A shorter hold time deletes older held copies at the next hourly
        // purge, so it is confirmed on its own; the server checks it too.
        const was = Number(s.trashRetentionDays) || 0;
        const days = patch.trashRetentionDays;
        let confirmRetention = false;
        if (days && (!was || days < was)) {
          // Ask the server first: it refuses the shorter time and says how
          // many held copies, and how much, it would delete.
          let warning = null;
          try {
            await post('settings', { settings: patch });
          } catch (err) {
            if (!/Confirm the shorter time/.test(err.message)) { toast(err.message); return; }
            warning = err.message.replace(/\s*Confirm the shorter time to save it\.$/, '');
          }
          if (warning == null) { toast('Settings saved.'); viewSettings(body, generation); return; }
          confirmRetention = await dialog('Shorten how long removed copies are kept?',
            [h('p', null, h('b', null, warning)), h('p', null, 'Copies you may still want back should be restored first.')],
            [{ label: `Keep for ${days} days`, value: true, danger: true }]);
          if (!confirmRetention) return;
        }
        await busyBtn(btn, async () => {
          try { await post('settings', { settings: patch, confirmRetention }); toast('Settings saved.'); viewSettings(body, generation); } catch (err) { toast(err.message); }
        });
      }
      fill(body, form);
    }

    return { view, leave, subnav: (r) => TABS.map(([id, label]) => ({ href: `#/duplicates/${id}`, label, current: tabOf(r) === id })) };
  }
})();
