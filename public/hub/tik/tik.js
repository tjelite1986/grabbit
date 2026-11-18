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
    // The player's icons are TikShortis' own: Lucide 0.577.0 (ISC licence,
    // https://lucide.dev), the version TikShortis ships, copied element by
    // element so the strokes, sizes and shapes are the original ones.
    const LUCIDE = {
      heart: [["path",{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}]],
      messageCircle: [["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}]],
      listVideo: [["path",{"d":"M21 5H3"}],["path",{"d":"M10 12H3"}],["path",{"d":"M10 19H3"}],["path",{"d":"M15 12.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997a1 1 0 0 1-1.517-.86z"}]],
      share2: [["circle",{"cx":"18","cy":"5","r":"3"}],["circle",{"cx":"6","cy":"12","r":"3"}],["circle",{"cx":"18","cy":"19","r":"3"}],["line",{"x1":"8.59","x2":"15.42","y1":"13.51","y2":"17.49"}],["line",{"x1":"15.41","x2":"8.59","y1":"6.51","y2":"10.49"}]],
      download: [["path",{"d":"M12 15V3"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["path",{"d":"m7 10 5 5 5-5"}]],
      volume2: [["path",{"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}],["path",{"d":"M16 9a5 5 0 0 1 0 6"}],["path",{"d":"M19.364 18.364a9 9 0 0 0 0-12.728"}]],
      volumeX: [["path",{"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}],["line",{"x1":"22","x2":"16","y1":"9","y2":"15"}],["line",{"x1":"16","x2":"22","y1":"9","y2":"15"}]],
      moreVertical: [["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"12","cy":"5","r":"1"}],["circle",{"cx":"12","cy":"19","r":"1"}]],
      play: [["path",{"d":"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"}]],
      compass: [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"}]],
      users: [["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["path",{"d":"M16 3.128a4 4 0 0 1 0 7.744"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["circle",{"cx":"9","cy":"7","r":"4"}]],
      menu: [["path",{"d":"M4 5h16"}],["path",{"d":"M4 12h16"}],["path",{"d":"M4 19h16"}]],
      chevronDown: [["path",{"d":"m6 9 6 6 6-6"}]],
      chevronsDown: [["path",{"d":"m7 6 5 5 5-5"}],["path",{"d":"m7 13 5 5 5-5"}]],
      chevronsUp: [["path",{"d":"m17 11-5-5-5 5"}],["path",{"d":"m17 18-5-5-5 5"}]],
      chevronLeft: [["path",{"d":"m15 18-6-6 6-6"}]],
      maximize: [["path",{"d":"M8 3H5a2 2 0 0 0-2 2v3"}],["path",{"d":"M21 8V5a2 2 0 0 0-2-2h-3"}],["path",{"d":"M3 16v3a2 2 0 0 0 2 2h3"}],["path",{"d":"M16 21h3a2 2 0 0 0 2-2v-3"}]],
      minimize: [["path",{"d":"M8 3v3a2 2 0 0 1-2 2H3"}],["path",{"d":"M21 8h-3a2 2 0 0 1-2-2V3"}],["path",{"d":"M3 16h3a2 2 0 0 1 2 2v3"}],["path",{"d":"M16 21v-3a2 2 0 0 1 2-2h3"}]],
      eye: [["path",{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
      eyeOff: [["path",{"d":"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"}],["path",{"d":"M14.084 14.158a3 3 0 0 1-4.242-4.242"}],["path",{"d":"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"}],["path",{"d":"m2 2 20 20"}]],
      link2: [["path",{"d":"M9 17H7A5 5 0 0 1 7 7h2"}],["path",{"d":"M15 7h2a5 5 0 1 1 0 10h-2"}],["line",{"x1":"8","x2":"16","y1":"12","y2":"12"}]],
      lock: [["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 10 0v4"}]],
      history: [["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["path",{"d":"M12 7v5l4 2"}]],
      undo2: [["path",{"d":"M9 14 4 9l5-5"}],["path",{"d":"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"}]],
      sparkles: [["path",{"d":"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}],["path",{"d":"M20 2v4"}],["path",{"d":"M22 4h-4"}],["circle",{"cx":"4","cy":"20","r":"2"}]],
      image: [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}],["circle",{"cx":"9","cy":"9","r":"2"}],["path",{"d":"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"}]],
      hash: [["line",{"x1":"4","x2":"20","y1":"9","y2":"9"}],["line",{"x1":"4","x2":"20","y1":"15","y2":"15"}],["line",{"x1":"10","x2":"8","y1":"3","y2":"21"}],["line",{"x1":"16","x2":"14","y1":"3","y2":"21"}]],
      clapperboard: [["path",{"d":"m12.296 3.464 3.02 3.956"}],["path",{"d":"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"}],["path",{"d":"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}],["path",{"d":"m6.18 5.276 3.1 3.899"}]],
      upload: [["path",{"d":"M12 3v12"}],["path",{"d":"m17 8-5-5-5 5"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}]],
      settings: [["path",{"d":"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
      logOut: [["path",{"d":"m16 17 5-5-5-5"}],["path",{"d":"M21 12H9"}],["path",{"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}]],
      x: [["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],
      send: [["path",{"d":"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"}],["path",{"d":"m21.854 2.147-10.94 10.939"}]],
      plus: [["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],
      bookmark: [["path",{"d":"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"}]],
      gauge: [["path",{"d":"m12 14 4-4"}],["path",{"d":"M3.34 19a10 10 0 1 1 17.32 0"}]],
      minimize2: [["path",{"d":"m14 10 7-7"}],["path",{"d":"M20 10h-6V4"}],["path",{"d":"m3 21 7-7"}],["path",{"d":"M4 14h6v6"}]],
      pip: [["path",{"d":"M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"}],["rect",{"width":"10","height":"7","x":"12","y":"13","rx":"2"}]],
      globe: [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]],
      pencil: [["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],["path",{"d":"m15 5 4 4"}]],
      type: [["path",{"d":"M12 4v16"}],["path",{"d":"M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"}],["path",{"d":"M9 20h6"}]],
      arrowRightLeft: [["path",{"d":"m16 3 4 4-4 4"}],["path",{"d":"M20 7H4"}],["path",{"d":"m8 21-4-4 4-4"}],["path",{"d":"M4 17h16"}]],
      trash2: [["path",{"d":"M10 11v6"}],["path",{"d":"M14 11v6"}],["path",{"d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}],["path",{"d":"M3 6h18"}],["path",{"d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}]],
      flag: [["path",{"d":"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"}]],
      info: [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 16v-4"}],["path",{"d":"M12 8h.01"}]],
      fastForward: [["path",{"d":"M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"}],["path",{"d":"M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"}]],
      rewind: [["path",{"d":"M12 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 12 18z"}],["path",{"d":"M22 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 22 18z"}]],
      panelLeft: [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],
      panelLeftClose: [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}],["path",{"d":"m16 15-3-3 3-3"}]],
      search: [["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],
      check: [["path",{"d":"M20 6 9 17l-5-5"}]],
      userRound: [["circle",{"cx":"12","cy":"8","r":"5"}],["path",{"d":"M20 21a8 8 0 0 0-16 0"}]],
    };
    const SVGNS = 'http://www.w3.org/2000/svg';
    // lu('heart', 22) -> a 22 px Lucide icon. The size is set inline because
    // the hub's stylesheet gives every svg 20 px.
    function lu(name, size = 24, stroke = 2, cls) {
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', `lu lu-${name}${cls ? ` ${cls}` : ''}`);
      svg.setAttribute('style', `width:${size}px;height:${size}px;stroke-width:${stroke}`);
      for (const [tag, attrs] of LUCIDE[name] || LUCIDE.play) {
        const el = document.createElementNS(SVGNS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        svg.append(el);
      }
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
      // TikShortis' undo pill: the text, then a round button with its icon.
      fill(toastEl, h('span', null, msg), action ? h('button', { type: 'button', class: 'tik-toast-act', onclick: () => { toastEl.hidden = true; action.run(); } }, action.label === 'Undo' ? lu('undo2', 14) : null, action.label) : null);
      toastEl.classList.toggle('with-act', !!action);
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
    //
    // The look is TikShortis' bottom sheet: full width with a title row and
    // an X (comments, playlists, share, the menu). opts.size 'narrow' is the
    // player menu and its confirmations (at most 448 px wide), 'form' a sheet
    // with inputs. opts.bare drops the title row, as TikShortis' player menu
    // has none; opts.clear leaves the page behind undimmed.
    function openSheet(title, body, opts = {}) {
      const close = () => closeSheet(entry, true);
      const cls = ['tik-sheet', opts.size || (opts.wide ? 'wide' : 'form'), opts.bare ? 'bare' : null, opts.cls || null].filter(Boolean).join(' ');
      const panel = h('div', { class: cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        opts.bare ? null : h('div', { class: 'tik-sheet-head' }, h('h3', null, title), h('button', { type: 'button', class: 'tik-x', 'aria-label': 'Close', onclick: close }, lu('x', 20))),
        h('div', { class: 'tik-sheet-body' }, body));
      const scrim = h('div', { class: `tik-scrim${opts.clear ? ' clear' : ''}`, onclick: close });
      const entry = { panel, scrim, onClose: opts.onClose, back: document.activeElement };
      document.body.append(scrim, panel);
      sheets.push(entry);
      if (!guard) {
        try { history.pushState({ ...(history.state || {}), tikSheet: 1 }, '', location.href); guard = true; } catch { /* ignore */ }
      }
      const first = panel.querySelector('input, textarea, select, button:not(.tik-x), a[href]');
      const target = first || panel.querySelector('.tik-x');
      if (target) target.focus({ preventScroll: true });
      return { close, panel, body: panel.querySelector('.tik-sheet-body') };
    }
    // Called once the last sheet is gone (the feed resumes auto-scroll).
    const whenSheetsClosed = new Set();
    function closeSheet(entry, viaUi) {
      const i = sheets.indexOf(entry);
      if (i < 0) return;
      sheets.splice(i, 1);
      entry.panel.remove();
      entry.scrim.remove();
      if (entry.onClose) entry.onClose();
      if (!sheets.length) for (const fn of whenSheetsClosed) { try { fn(); } catch (e) { console.warn('tik: sheet-close hook failed', e); } }
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
    // TikShortis' confirmation sheet (the clip's "Delete this clip?"): a title,
    // one line, then the action in red and Cancel side by side.
    function confirmSheet(title, text, label, run) {
      const s = openSheet(title, [
        h('p', { class: 'tf-sheet-title' }, title),
        h('p', { class: 'tf-sheet-sub' }, text),
        h('div', { class: 'tf-sheet-btns' },
          h('button', { type: 'button', class: 'tf-sbtn danger', onclick: async (e) => {
            // currentTarget is gone after the await: keep the button.
            const btn = e.currentTarget;
            btn.disabled = true;
            try { await run(); s.close(); } catch (err) { fail(err); btn.disabled = false; }
          } }, label),
          h('button', { type: 'button', class: 'tf-sbtn', onclick: () => s.close() }, 'Cancel')),
      ], { size: 'narrow', bare: true });
      // The destructive button comes first, as in TikShortis, but the focus
      // starts on Cancel: Enter (or a held key) must never confirm by itself.
      const cancel = s.panel.querySelector('.tf-sheet-btns .tf-sbtn:not(.danger)');
      if (cancel) cancel.focus({ preventScroll: true });
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
    // Grabbit 3.0.1: drawn after TikShortis' own player (components/
    // shorts-feed.tsx and short-card.tsx at 79e8a3b): the same overlay layout,
    // icons, order, sizes and colours, with its controls doing the same things.
    // Grabbit adds one button of its own (top left: show or hide the Grabbit
    // menu) and a back pill on scoped feeds.
    // Mode order and labels as in TikShortis' selector (SORT_ORDER).
    const MODES = [['foryou', 'For You'], ['new', 'New'], ['following', 'Following'], ['liked', 'Liked'], ['random', 'Random']];
    const SEEDED = new Set(['foryou', 'random']);
    const NEAR = 2; // cards around the active one that keep their video source
    const SEEK_SECONDS = 10;
    const SPEEDS = [0.5, 1, 1.5, 2];
    const newSeed = () => 1 + Math.floor(Math.random() * 2147483645);
    const labelOf = (list, v) => (list.find(([k]) => k === v) || list[0])[1];
    // Same rules as short-card.tsx: the creator profile when the clip has one,
    // else the uploader; two initials in the round avatar.
    const authorLabel = (s) => (s.profile_id && s.profile_name ? s.profile_name : s.uploader_name || s.profile_name || 'unknown');
    const initials2 = (name) => (String(name || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
    function hostLabel(href) {
      try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return null; }
    }
    // linkify-text.tsx: http(s) and www. links and @mentions become links.
    const TOKEN_RE = /(https?:\/\/[^\s<]+[^\s<.,:;!?"')\]}]|www\.[^\s<]+[^\s<.,:;!?"')\]}])|@([a-zA-Z0-9_.]{1,30})/gi;
    function linkify(text) {
      const out = [];
      let last = 0;
      let m;
      TOKEN_RE.lastIndex = 0;
      while ((m = TOKEN_RE.exec(text)) !== null) {
        if (m[2] && m.index > 0 && !/\s/.test(text[m.index - 1])) continue;
        if (m.index > last) out.push(text.slice(last, m.index));
        if (m[1]) {
          const href = safeHref(m[1].startsWith('http') ? m[1] : `https://${m[1]}`);
          out.push(href ? h('a', { class: 'tf-link', href, target: '_blank', rel: 'noopener noreferrer nofollow' }, m[1]) : m[1]);
        } else {
          out.push(h('a', { class: 'tf-mention', href: link(`person/${enc(handleOf(m[2]))}`) }, `@${m[2]}`));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }
    // post-avatar.tsx: initials on a rose-to-purple disc; the creator's
    // picture on top when the profile has one.
    function discAvatar(name, pid, size) {
      const box = h('span', { class: 'tf-av', style: `width:${size}px;height:${size}px` }, initials2(name));
      if (pid) box.append(h('img', { alt: '', src: avatarOf(pid), loading: 'lazy', 'data-media-bg': '1', onerror: (e) => e.currentTarget.remove() }));
      return box;
    }
    // One button of the right rail: icon over a small label, no disc.
    function railBtn(name, label, onclick, extra) {
      const iconBox = h('span', { class: 'tf-rb-ic' }, lu(name, 22));
      const text = h('span', { class: 'tf-rb-l' }, label);
      const el = h(extra && extra.href ? 'a' : 'button', { class: 'tf-rb', type: extra && extra.href ? null : 'button', 'aria-label': (extra && extra.aria) || label, href: extra && extra.href, download: extra && extra.href ? '' : null, onclick, 'data-sound-toggle': extra && extra.sound ? '1' : null }, iconBox, text);
      return { el, iconBox, text };
    }
    // One row of the player menu: an icon on a small disc, the label, and an
    // optional control at the right edge.
    function moreRow(name, label, onclick, opts = {}) {
      const body = [h('span', { class: 'tf-row-ic' }, opts.icon || lu(name, 18)), h('span', { class: 'tf-row-l' }, label), opts.trailing ? h('span', { class: 'tf-row-t' }, opts.trailing) : null];
      return opts.href
        ? h('a', { class: `tf-row${opts.danger ? ' danger' : ''}`, href: opts.href, download: '', onclick }, body)
        : h('button', { type: 'button', class: `tf-row${opts.danger ? ' danger' : ''}`, onclick }, body);
    }
    function switchEl(on) {
      return h('span', { class: `tf-switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!on) }, h('span'));
    }

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
      let length = ['short', 'long'].includes(p.get('length')) ? p.get('length') : 'all';
      let seed = SEEDED.has(sort) ? newSeed() : null;
      // New, Following and Liked page by clip id, so a deep link can also
      // load the clips above it (`after`); the others page by offset.
      let byId = !SEEDED.has(sort);
      const inPlaylist = !!scope.playlist;
      const mainFeed = !scoped && !tag;
      // The address the feed keeps up to date (the current clip goes in
      // `focus`); a mode switch replaces it.
      let baseParams = new URLSearchParams(p);
      baseParams.delete('path');
      const subPath = r.sub.length ? `/${r.sub.map(enc).join('/')}` : '';

      const F = {
        token: 0, // bumps when the feed is reset in place: late pages are dropped
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
        fullscreen: false,
        firstPage: true,
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
        for (const c of F.cards) paintSound(c);
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

      // ---- Top left: the Grabbit menu (Grabbit's own control) ----
      const sideBtn = h('button', { type: 'button', class: 'tf-cbtn tf-side', onclick: () => hub.toggleSide() });
      function paintSide() {
        const open = hub.sideOpen();
        fill(sideBtn, lu(open ? 'panelLeftClose' : 'panelLeft', 18));
        sideBtn.setAttribute('aria-label', open ? 'Hide the Grabbit menu' : 'Show the Grabbit menu');
        sideBtn.setAttribute('aria-expanded', String(open));
      }
      paintSide();
      window.addEventListener('grabbit:side', paintSide);
      onLeave(() => window.removeEventListener('grabbit:side', paintSide));

      // ---- Top centre: the feed selector ("For You v") ----
      const menus = []; // open-state closers for Escape and outside clicks
      let modeBox;
      let paintMode = () => {};
      if (mainFeed) {
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
        paintMode = () => {
          fill(btn, h('span', null, labelOf(MODES, sort)), length !== 'all' ? h('span', { class: 'tf-mode-len' }, `· ${labelOf(LENGTHS, length)}`) : null, lu('chevronDown', 15, 2, 'tf-chev'));
          btn.setAttribute('aria-label', `Feed: ${labelOf(MODES, sort)}${length !== 'all' ? `, ${labelOf(LENGTHS, length)}` : ''}`);
          // Length is a second axis that narrows whichever order is picked,
          // so it sits below its own divider (as in TikShortis).
          fill(menu,
            MODES.map(([m, label]) => item(label, m === sort, () => switchFeed(m, length))),
            h('div', { class: 'tf-mode-sep', role: 'separator' }),
            LENGTHS.map(([l, label]) => item(label, l === length, () => switchFeed(sort, l))));
        };
        paintMode();
      } else {
        // A tag, profile or playlist feed: no selector, a way back instead.
        modeBox = h('div', { class: 'tf-modebox' },
          h('a', { class: 'tf-pill tf-back', href: scopeBackHref(scope) }, lu('chevronLeft', 15), h('span', null, scopeLabel(scope))));
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
      const root = h('div', { class: `tf${S.chromeHidden ? ' clean' : ''}` }, scroller, status, sideBtn, modeBox, ctlBox, resumeBox, hintEl);

      const onDocDown = (e) => {
        if (modeBox.contains(e.target)) return;
        for (const close of menus) close();
      };
      document.addEventListener('pointerdown', onDocDown, true);
      onLeave(() => document.removeEventListener('pointerdown', onDocDown, true));

      // ---- View toggles ----
      function toggleChrome() {
        S.chromeHidden = !S.chromeHidden;
        store.set(KEYS.chrome, S.chromeHidden ? '1' : null);
        root.classList.toggle('clean', S.chromeHidden);
        if (S.chromeHidden) {
          hintEl.hidden = false;
          setTimeout(() => { hintEl.hidden = true; }, 2500);
        }
        paintCtl();
      }
      function toggleAutoScroll() {
        S.autoScroll = !S.autoScroll;
        store.set(KEYS.autoScroll, S.autoScroll ? '1' : null);
        for (const x of F.cards) x.video.loop = !S.autoScroll;
        paintCtl();
      }
      // Fullscreen is the whole document, as in TikShortis: the sheets,
      // menus and toasts are children of <body>, and a fullscreen element
      // only shows what sits inside it. The page itself hides the Grabbit
      // menu, the top bar and the bottom bar (body.tik-immersive) and puts
      // them back as they were on the way out.
      function setImmersive(on) {
        F.fullscreen = on;
        document.body.classList.toggle('tik-immersive', on);
        if (on) hub.closeMenu();
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
      // Leaving fullscreen through the browser (Esc, the Back gesture) ends
      // the immersive view too.
      const onFs = () => { if (!(document.fullscreenElement || document.webkitFullscreenElement) && F.fullscreen) setImmersive(false); };
      document.addEventListener('fullscreenchange', onFs);
      document.addEventListener('webkitfullscreenchange', onFs);

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
      const current = (tok) => live(gen) && tok === F.token;
      async function loadMore() {
        if (F.loading || !F.hasMore || Date.now() < F.retryAt) return;
        const tok = F.token;
        F.loading = true;
        paintStatus();
        try {
          const d = await call(feedQuery({ cursor: F.cursor }));
          if (!current(tok)) return;
          F.errors = 0;
          const fresh = (d.items || []).filter((s) => s && Number.isInteger(s.id) && !F.ids.has(s.id));
          for (const s of fresh) addCard(s, false);
          F.cursor = d.nextCursor;
          F.hasMore = d.nextCursor !== null && d.nextCursor !== undefined;
          if (F.active < 0 && F.cards.length) {
            pickActive();
            if (F.firstPage) offerResume();
            F.firstPage = false;
            // The top sentinel was already in view before the first page
            // came, so its observer will not fire again: ask once here.
            loadPrev();
          }
        } catch (e) {
          if (!current(tok)) return;
          F.errors++;
          F.retryAt = Date.now() + Math.min(30000, 2 ** F.errors * 1000);
          F.lastError = e.message;
        } finally {
          if (current(tok)) { F.loading = false; paintStatus(); }
        }
      }
      // Clips above the top one, after a focus deep link (id-paged orders).
      async function loadPrev() {
        if (!byId || F.loadingPrev || !F.hasPrev || F.prev === null || !F.cards.length) return;
        const tok = F.token;
        F.loadingPrev = true;
        try {
          const d = await call(feedQuery({ after: F.prev }));
          if (!current(tok)) return;
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
          if (current(tok)) F.hasPrev = false;
        } finally {
          if (current(tok)) F.loadingPrev = false;
        }
      }
      function paintStatus() {
        if (F.cards.length) {
          status.hidden = !(F.loading || (F.errors && F.hasMore));
          status.classList.add('more');
          fill(status, F.loading ? h('span', { class: 'tf-spin', 'aria-label': 'Loading' }) : h('span', null, 'Could not load more. ', h('button', { type: 'button', class: 'linkish', onclick: () => { F.retryAt = 0; loadMore(); } }, 'Try again')));
          return;
        }
        status.hidden = false;
        status.classList.remove('more');
        if (F.loading) fill(status, h('span', { class: 'tf-spin', 'aria-label': 'Loading' }));
        else if (F.errors) fill(status, h('p', null, 'Could not load the feed.'), h('button', { type: 'button', class: 'tf-sbtn', onclick: () => { F.retryAt = 0; F.errors = 0; loadMore(); } }, 'Try again'));
        else if (sort === 'following') fill(status, h('p', null, 'Nothing from creators you follow.'), h('p', { class: 'small' }, 'TikShortis has no follow button yet; this list only holds follows carried over from the old app.'));
        else fill(status, h('p', null, 'No clips yet.'), h('a', { class: 'tf-sbtn rose', href: link('upload') }, 'Upload the first one'));
      }
      // A new order or length, in place: no navigation, so fullscreen and the
      // sheets' history entry survive, and the address is replaced (Back
      // leaves the feed, as in TikShortis).
      function switchFeed(nextSort, nextLength) {
        if (nextSort === sort && nextLength === length) return;
        F.token++;
        const c = F.cards[F.active];
        if (c) deactivate(c);
        for (const x of F.cards) { unload(x); activeObserver.unobserve(x.el); x.el.remove(); }
        Object.assign(F, { items: [], cards: [], ids: new Set(), cursor: null, hasMore: true, loading: false, errors: 0, retryAt: 0, prev: null, hasPrev: false, loadingPrev: false, active: -1 });
        sort = nextSort;
        length = nextLength;
        seed = SEEDED.has(sort) ? newSeed() : null;
        byId = !SEEDED.has(sort);
        resumeBox.hidden = true;
        baseParams = new URLSearchParams();
        if (sort !== 'foryou') baseParams.set('sort', sort);
        if (length !== 'all') baseParams.set('length', length);
        hub.replaceHash(`${BASE}${subPath}${baseParams.toString() ? `?${baseParams}` : ''}`);
        scroller.scrollTop = 0;
        paintMode();
        paintStatus();
        loadMore();
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
        const c = { s, video, maxTime: 0, lastTime: 0, completed: false, scrubbing: false, wantPlay: false };

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

        // Right rail, in TikShortis' order.
        c.likeBtn = railBtn('heart', '0', () => toggleLike(c, false), { aria: 'Like' });
        c.commentBtn = railBtn('messageCircle', '0', () => openComments(c), { aria: 'Comments' });
        c.saveBtn = railBtn('listVideo', 'Playlists', () => openSave(c), { aria: 'Playlists' });
        const shareBtn = railBtn('share2', 'Share', () => openShare(c));
        const dlBtn = railBtn('download', 'Download', null, { href: `${videoOf(s.id)}?download=1` });
        c.soundBtn = railBtn(S.muted ? 'volumeX' : 'volume2', S.muted ? 'Muted' : 'Sound', () => setMuted(!S.muted), { sound: true });
        const moreBtn = railBtn('moreVertical', 'More', () => openMore(c));
        const rail = h('div', { class: 'tf-rail' }, c.likeBtn.el, c.commentBtn.el, c.saveBtn.el, shareBtn.el, dlBtn.el, c.soundBtn.el, moreBtn.el);

        // Bottom left: who, the title, where it came from, the tags.
        const name = authorLabel(s);
        const who = s.profile_id && s.profile_name
          ? h('a', { class: 'tf-who', href: link(`person/${enc(handleOf(s.profile_name))}`) }, discAvatar(name, s.profile_id, 40), h('span', { class: 'tf-name' }, name))
          : h('div', { class: 'tf-who' }, discAvatar(s.uploader_name || 'Unknown', null, 40), h('span', { class: 'tf-name' }, name));
        let titleEl = null;
        if (parts.title) {
          const long = parts.title.length > 40;
          const more = long ? h('button', { type: 'button', class: 'tf-title-more', 'aria-expanded': 'false' }, 'more') : null;
          titleEl = h('p', { class: `tf-title${long ? ' long' : ''}` }, linkify(parts.title), more);
          if (long) titleEl.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            const open = titleEl.classList.toggle('open');
            more.textContent = open ? 'less' : 'more';
            more.setAttribute('aria-expanded', String(open));
          });
        }
        const src = sourceLink(s, parts);
        const srcLabel = src && hostLabel(src);
        const srcEl = src && srcLabel ? h('a', { class: 'tf-src', href: src, target: '_blank', rel: 'noopener noreferrer nofollow', title: src }, lu('link2', 12), h('span', null, srcLabel)) : null;
        let tagsEl = null;
        if (parts.tags.length) {
          tagsEl = h('div', { class: 'tf-tags' });
          const paintTags = (all) => fill(tagsEl,
            (all ? parts.tags : parts.tags.slice(0, 3)).map((t) => h('a', { class: 'tf-tag', href: tagHref(t) }, t)),
            parts.tags.length > 3 ? h('button', { type: 'button', class: 'tf-tag tf-tag-more', 'aria-expanded': String(all), onclick: () => paintTags(!all) }, all ? 'less' : `+${parts.tags.length - 3} more`) : null);
          paintTags(false);
        }
        const info = h('div', { class: 'tf-info' }, who, titleEl, srcEl, tagsEl);

        // Admin: describe with AI and take the cover from this frame, up by the
        // view controls; the private badge top left.
        const admin = isAdmin()
          ? [h('button', { type: 'button', class: 'tf-cbtn tf-adm describe', title: 'Describe this clip with AI', 'aria-label': 'Describe this clip with AI', onclick: () => describeHere(c) }, lu('sparkles', 18)),
            h('button', { type: 'button', class: 'tf-cbtn tf-adm cover', title: 'Thumbnail: use current frame', 'aria-label': 'Set thumbnail from current frame', onclick: () => setCover(c) }, lu('image', 18))]
          : [];
        c.privateEl = h('div', { class: 'tf-private', hidden: !(s.is_private && (isOwner(s) || isAdmin())) }, lu('lock', 12), 'Private');
        c.aiEl = h('div', { class: 'tf-ai', hidden: true, onclick: () => { c.aiEl.hidden = true; } });

        c.el = h('section', { class: 'tf-card', 'data-id': String(s.id) },
          video, ...admin, c.privateEl, c.aiEl, c.burst, c.seekHint, c.playIcon,
          h('div', { class: 'tf-scrim', 'aria-hidden': 'true' }), c.timeline, rail, info);
        paintCounts(c);

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
          // Not under an open sheet: the sheet's Back entry would then point
          // at the clip before.
          if (S.autoScroll && F.cards[F.active] === c) { if (sheets.length) c.advanceOnClose = true; else step(1); }
        });
        video.addEventListener('play', () => { c.playIcon.hidden = true; });
        video.addEventListener('pause', () => { c.playIcon.hidden = F.cards[F.active] !== c; });
        attachGestures(c);
        return c;
      }
      function paintCounts(c) {
        const s = c.s;
        c.likeBtn.el.classList.toggle('liked', !!s.viewer_liked);
        c.likeBtn.el.setAttribute('aria-pressed', String(!!s.viewer_liked));
        c.likeBtn.el.setAttribute('aria-label', `${s.viewer_liked ? 'Unlike' : 'Like'} (${num(s.like_count)})`);
        c.likeBtn.text.textContent = String(s.like_count || 0);
        c.commentBtn.text.textContent = String(s.comment_count || 0);
        c.commentBtn.el.setAttribute('aria-label', `Comments (${num(s.comment_count)})`);
        c.saveBtn.el.classList.toggle('saved', !!s.viewer_saved);
      }
      function paintSound(c) {
        fill(c.soundBtn.iconBox, lu(S.muted ? 'volumeX' : 'volume2', 22));
        c.soundBtn.text.textContent = S.muted ? 'Muted' : 'Sound';
        c.soundBtn.el.setAttribute('aria-label', S.muted ? 'Turn sound on' : 'Mute');
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
        let start = null;
        const onControl = (e) => !!(e.target.closest && e.target.closest('a, button, input, .tf-info, .tf-tl, .tf-rail, .tf-ai'));
        c.el.addEventListener('pointerdown', (e) => {
          if (onControl(e) || e.button > 0) return;
          start = { x: e.clientX, y: e.clientY };
          long = false;
          press = setTimeout(() => { press = null; long = true; }, 550);
        });
        c.el.addEventListener('pointermove', (e) => {
          if (!start) return;
          if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) { clearTimeout(press); press = null; start = null; }
        });
        c.el.addEventListener('pointercancel', () => { clearTimeout(press); press = null; start = null; });
        c.el.addEventListener('contextmenu', (e) => { if (!onControl(e)) e.preventDefault(); });
        c.el.addEventListener('pointerup', (e) => {
          if (!start) return;
          start = null;
          clearTimeout(press);
          press = null;
          // The player menu opens on release, as in TikShortis.
          if (long) { long = false; openMore(c); return; }
          const rect = c.el.getBoundingClientRect();
          const x = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
          const now = Date.now();
          if (tapTimer && now - lastTap < 260) {
            clearTimeout(tapTimer);
            tapTimer = null;
            // Outer thirds seek, the middle likes.
            if (x > 0.65) skip(c, SEEK_SECONDS);
            else if (x < 0.35) skip(c, -SEEK_SECONDS);
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
        fill(c.seekHint, lu(by > 0 ? 'fastForward' : 'rewind', 28), h('span', null, `${by > 0 ? '+' : '-'}${Math.abs(by)}s`));
        c.seekHint.classList.toggle('fwd', by > 0);
        c.seekHint.classList.toggle('back', by < 0);
        c.seekHint.hidden = false;
        clearTimeout(c.seekTimer);
        c.seekTimer = setTimeout(() => { c.seekHint.hidden = true; }, 600);
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
        const q = new URLSearchParams(baseParams);
        q.set('focus', String(c.s.id));
        hub.replaceHash(`${BASE}${subPath}?${q}`);
        if (mainFeed) store.set(KEYS.resume, JSON.stringify({ focus: c.s.id, at: Date.now() }));
        if (i >= F.cards.length - 3) loadMore();
      }
      function play(c) {
        const v = c.video;
        if (!v.getAttribute('src')) v.src = videoOf(c.s.id);
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
        queueView(c.s.id, c.maxTime * 1000, c.completed);
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

      // ---- Like, comments, playlists, share ----
      async function toggleLike(c, onlyLike) {
        const s = c.s;
        if (onlyLike && s.viewer_liked) { heartBurst(c); return; }
        const was = { liked: s.viewer_liked, count: s.like_count };
        s.viewer_liked = !was.liked;
        s.like_count = Math.max(0, (was.count || 0) + (s.viewer_liked ? 1 : -1));
        if (s.viewer_liked) heartBurst(c);
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
        clearTimeout(c.burstTimer);
        c.burstTimer = setTimeout(() => { c.burst.hidden = true; c.burst.classList.remove('go'); }, 700);
      }
      // TikShortis' comments sheet: "N comments", "@name text" rows, and a
      // round field with a send button.
      function openComments(c) {
        const s = c.s;
        let list = [];
        const listEl = h('div', { class: 'tf-cm-list' }, h('p', { class: 'tf-dim' }, 'Loading…'));
        const errEl = h('p', { class: 'tf-cm-err', role: 'alert', hidden: true });
        const input = h('input', { type: 'text', maxlength: '2000', placeholder: 'Add a comment…', 'aria-label': 'Comment' });
        const send = h('button', { type: 'submit', class: 'tf-round-btn', 'aria-label': 'Post comment' }, lu('send', 18));
        const headTitle = () => `${list.length} comment${list.length === 1 ? '' : 's'}`;
        const row = (m) => h('div', { class: 'tf-cm' }, h('b', null, `@${m.author_name || 'Unknown'}`), ' ', h('span', null, m.body));
        const paint = () => {
          fill(listEl, ...(list.length ? list.map(row) : [h('p', { class: 'tf-dim' }, 'Be the first to comment.')]));
          const t = sheet.panel.querySelector('.tik-sheet-head h3');
          if (t) t.textContent = headTitle();
        };
        const form = h('form', { class: 'tf-cm-form', onsubmit: async (e) => {
          e.preventDefault();
          const body = input.value.trim();
          if (!body || send.disabled) return;
          send.disabled = true;
          errEl.hidden = true;
          try {
            const d = await call(`shorts/${s.id}/comments`, { method: 'POST', body: { body } });
            input.value = '';
            if (d.comment) list.push(d.comment);
            s.comment_count = list.length;
            paintCounts(c);
            paint();
            listEl.scrollTop = listEl.scrollHeight;
          } catch (err) {
            // The text stays in the field on failure.
            errEl.textContent = err.status === 401 ? 'Signed out of TikShortis: link your account again to comment.' : 'Could not post.';
            errEl.hidden = false;
          } finally { send.disabled = false; }
        } }, input, send);
        const sheet = openSheet(`${num(s.comment_count)} comments`, h('div', { class: 'tf-cm-box' }, listEl, errEl, form), { clear: true, cls: 'tf-sheet-comments' });
        call(`shorts/${s.id}/comments`).then((d) => {
          list = d.comments || [];
          paint();
        }).catch((e) => fill(listEl, h('p', { class: 'tf-cm-err' }, e.message)));
      }
      // Save to playlist: a new-playlist field on top, then every playlist
      // with a bookmark that is filled when the clip is in it.
      function openSave(c) {
        const s = c.s;
        let pls = [];
        const listEl = h('div', { class: 'tf-pl-list' }, h('p', { class: 'tf-dim' }, 'Loading…'));
        const name = h('input', { type: 'text', maxlength: '120', placeholder: 'New playlist…', 'aria-label': 'New playlist name' });
        const setSaved = () => { s.viewer_saved = pls.some((x) => Number(x.contains) === 1); paintCounts(c); };
        const paint = () => {
          fill(listEl, ...(pls.length ? pls.map(row) : [h('p', { class: 'tf-dim' }, 'No playlists yet — create one above.')]));
        };
        function row(pl) {
          const inIt = Number(pl.contains) === 1;
          return h('button', { type: 'button', class: 'tf-pl', 'aria-pressed': String(inIt), onclick: async () => {
            const before = { contains: pl.contains, item_count: pl.item_count };
            pl.contains = inIt ? 0 : 1;
            pl.item_count = Math.max(0, (pl.item_count || 0) + (inIt ? -1 : 1));
            setSaved();
            paint();
            try {
              if (inIt) await call(`shorts/playlists/${pl.id}/items?short=${s.id}`, { method: 'DELETE' });
              else await call(`shorts/playlists/${pl.id}/items`, { method: 'POST', body: { shortId: s.id } });
            } catch (e) {
              // Undo this row only: another row may have changed meanwhile.
              Object.assign(pl, before);
              setSaved();
              paint();
              fail(e);
            }
          } },
          h('span', { class: 'tf-pl-t' }, h('b', null, pl.name), h('small', null, `${num(pl.item_count)} clips`)),
          lu('bookmark', 20, 2, inIt ? 'on' : null));
        }
        function reload() {
          call(`shorts/playlists?short=${s.id}`).then((d) => {
            pls = d.playlists || [];
            setSaved();
            paint();
          }).catch((e) => fill(listEl, h('p', { class: 'tf-cm-err' }, e.message)));
        }
        const form = h('form', { class: 'tf-pl-form', onsubmit: async (e) => {
          e.preventDefault();
          const n = name.value.trim();
          if (!n) return;
          name.value = '';
          try {
            const d = await call('shorts/playlists', { method: 'POST', body: { name: n } });
            if (d.playlist) await call(`shorts/playlists/${d.playlist.id}/items`, { method: 'POST', body: { shortId: s.id } });
            reload();
          } catch (err) { fail(err); }
        } }, name, h('button', { type: 'submit', class: 'tf-round-btn', 'aria-label': 'Create playlist' }, lu('plus', 18)));
        reload();
        openSheet('Save to playlist', [form, listEl], { clear: true, cls: 'tf-sheet-save' });
      }
      // Share: the system share sheet where there is one, the clipboard
      // otherwise; the clip's own address in Grabbit.
      function openShare(c) {
        const url = `${location.origin}/${link('', { focus: c.s.id, sort: 'new' })}`;
        const label = h('span', null, 'Copy link / share');
        const btn = h('button', { type: 'button', class: 'tf-row tf-share-row', onclick: async () => {
          if (navigator.share) {
            try { await navigator.share({ url }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
          }
          try {
            await navigator.clipboard.writeText(url);
            label.textContent = 'Link copied!';
            setTimeout(() => { label.textContent = 'Copy link / share'; }, 2000);
          } catch { say('Could not copy the link'); }
        } }, h('span', { class: 'tf-row-ic' }, lu('link2', 17)), label);
        openSheet('Share', btn, { clear: true, cls: 'tf-sheet-share' });
      }

      // ---- The player menu and the sheets behind it ----
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
      async function toggleHidden(c) {
        const s = c.s;
        try {
          if (s.viewer_hidden) {
            await call(`shorts/${s.id}/hide`, { method: 'DELETE' });
            s.viewer_hidden = false;
            say('Shown in your feed again');
          } else {
            await call(`shorts/${s.id}/hide`, { method: 'POST' });
            s.viewer_hidden = true;
            hideFromFeed(c, 'Hidden from your feed', true);
          }
        } catch (e) { fail(e); }
      }
      // Modelled on TikShortis' long-press sheet: viewing controls for
      // everyone first, then the owner's and the admin's.
      function openMore(c) {
        const s = c.s;
        const owner = isOwner(s) || isAdmin();
        const close = (fn) => () => { sheet.close(); fn(); };
        const speedBox = h('div', { class: 'tf-speeds', role: 'group', 'aria-label': 'Speed' });
        const paintSpeed = () => fill(speedBox, SPEEDS.map((r) => h('button', { type: 'button', class: `tf-speed${r === S.speed ? ' on' : ''}`, 'aria-pressed': String(r === S.speed), onclick: () => {
          S.speed = r;
          const cur = F.cards[F.active];
          if (cur) { cur.video.defaultPlaybackRate = r; cur.video.playbackRate = r; }
          paintSpeed();
        } }, `${r.toFixed(1)}×`)));
        paintSpeed();
        const autoRow = moreRow('chevronsDown', 'Auto scroll', () => { toggleAutoScroll(); fill(autoRow.querySelector('.tf-row-t'), switchEl(S.autoScroll)); }, { trailing: switchEl(S.autoScroll) });
        const pip = document.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
        const rows = [
          moreRow('download', 'Download', () => sheet.close(), { href: `${videoOf(s.id)}?download=1` }),
          moreRow(s.viewer_hidden ? 'eye' : 'eyeOff', s.viewer_hidden ? 'Show in feed again' : 'Not interested', close(() => toggleHidden(c))),
          s.why ? moreRow('info', 'Why this post', close(() => openWhy(c))) : null,
          moreRow('flag', s.viewer_reported ? 'Reported' : 'Report', close(() => openReport(c))),
          h('div', { class: 'tf-sep' }),
          h('div', { class: 'tf-row tf-row-static' }, h('span', { class: 'tf-row-ic' }, lu('gauge', 18)), h('span', { class: 'tf-row-l' }, 'Speed'), speedBox),
          moreRow('minimize2', S.chromeHidden ? 'Show overlay' : 'Clear display', close(toggleChrome)),
          autoRow,
          pip ? moreRow('pip', 'Picture-in-Picture', close(() => { c.video.requestPictureInPicture().catch(() => say('Picture-in-Picture is not available')); })) : null,
          moreRow(F.fullscreen ? 'minimize' : 'maximize', F.fullscreen ? 'Exit fullscreen' : 'Fullscreen', close(toggleFullscreen)),
        ];
        if (owner) {
          rows.push(
            h('div', { class: 'tf-sep' }),
            moreRow(s.is_private ? 'lock' : 'globe', s.is_private ? 'Private — make public' : 'Public — make private', close(() => toggleVisibility(c)), s.is_private ? { icon: lu('lock', 18, 2, 'amber') } : {}),
            moreRow('pencil', 'Edit title', close(() => editHere(c))),
            moreRow('hash', 'Tags', close(() => editHere(c))));
          if (isAdmin()) rows.push(moreRow('type', 'Fetch title from source', close(() => fetchTitle(c))));
          rows.push(
            h('div', { class: 'tf-sep' }),
            moreRow('arrowRightLeft', 'Hand over to 18+', close(() => confirmSheet('Hand over to 18+?', 'The clip moves to the 18+ library and leaves TikShortis and every general feed. There is no way back from here.', 'Hand over', async () => {
              const d = await call(`shorts/${s.id}/channel`, { method: 'PATCH', body: { channel: '18plus' } });
              removeCard(c);
              say(d.message || 'Handed over to 18+');
            }))),
            moreRow('trash2', 'Delete', close(() => confirmSheet('Delete this clip?', 'The video and its file are removed. This can’t be undone.', 'Delete', async () => {
              await call(`shorts/${s.id}`, { method: 'DELETE' });
              removeCard(c);
              say('Deleted');
            })), { danger: true, icon: lu('trash2', 18, 2, 'red') }));
        }
        const sheet = openSheet('Player menu', h('div', { class: 'tf-more' }, rows), { size: 'narrow', bare: true });
      }
      async function toggleVisibility(c) {
        const s = c.s;
        const want = !s.is_private;
        s.is_private = want;
        c.privateEl.hidden = !want;
        try {
          const d = await call(`shorts/${s.id}/visibility`, { method: 'PATCH', body: { isPrivate: want } });
          s.is_private = !!d.is_private;
        } catch (e) { s.is_private = !want; fail(e); }
        c.privateEl.hidden = !(s.is_private && (isOwner(s) || isAdmin()));
      }
      function editHere(c) {
        openEdit(c.s, (caption) => { c.s.caption = caption; swapCard(c, buildCard(c.s)); });
      }
      async function fetchTitle(c) {
        say('Fetching title…');
        try {
          const d = await call(`shorts/${c.s.id}/fetch-title`, { method: 'POST' });
          c.s.caption = d.caption;
          swapCard(c, buildCard(c.s));
          say('Title updated');
        } catch (e) { fail(e); }
      }
      async function setCover(c) {
        c.video.pause();
        say('Saving cover…');
        try {
          await call(`shorts/${c.s.id}/poster`, { method: 'POST', body: { time: c.video.currentTime || 0 } });
          c.s.has_poster = true;
          c.video.poster = `/api/tik/shorts/${c.s.id}/poster?v=${Date.now()}`;
          say('Cover set');
        } catch (e) { fail(e); }
      }
      // The AI description shows over the clip, dismissed with a tap.
      function describeHere(c) {
        describe(c.s, (text, error) => {
          if (!text) { say(error ? 'Could not read it' : 'Failed'); return; }
          fill(c.aiEl, h('div', { class: 'tf-ai-head' }, lu('sparkles', 12), 'AI description', h('span', null, 'tap to dismiss')), text);
          c.aiEl.hidden = false;
        });
      }
      function openWhy(c) {
        const s = c.s;
        const sheet = openSheet('Why you’re seeing this', [
          h('p', { class: 'tf-sheet-title' }, 'Why you’re seeing this'),
          h('p', { class: 'tf-sheet-sub light' }, s.why),
          h('p', { class: 'tf-sheet-note' }, 'Not what you want? Mark it Not interested and the feed stops showing it. Liking and following shape For You.'),
          h('div', { class: 'tf-sheet-btns' },
            s.viewer_hidden ? null : h('button', { type: 'button', class: 'tf-sbtn', onclick: () => { sheet.close(); toggleHidden(c); } }, 'Not interested'),
            h('button', { type: 'button', class: 'tf-sbtn light', onclick: () => sheet.close() }, 'Got it')),
        ], { size: 'narrow', bare: true });
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
      // TikShortis' report sheet: a reason list, an optional note, Send.
      function openReport(c) {
        const s = c.s;
        const REASONS = [['broken', 'Video does not play or is cut off'], ['wrong_creator', 'Wrong creator or title'], ['duplicate', 'Duplicate of another clip'], ['inappropriate', 'Inappropriate content'], ['other', 'Something else']];
        let reason = null;
        const note = h('textarea', { rows: '2', maxlength: '500', placeholder: 'Anything the admin should know (optional)', 'aria-label': 'Note' });
        const send = h('button', { type: 'button', class: 'tf-sbtn rose', disabled: true }, s.viewer_reported ? 'Update report' : 'Send report');
        const listEl = h('div', { class: 'tf-reasons', role: 'radiogroup', 'aria-label': 'Reason' });
        const paint = () => fill(listEl, REASONS.map(([v, label]) => h('button', { type: 'button', class: `tf-reason${reason === v ? ' on' : ''}`, role: 'radio', 'aria-checked': String(reason === v), onclick: () => { reason = v; send.disabled = false; paint(); } }, h('span', { class: 'tf-dot' }), label)));
        paint();
        send.addEventListener('click', async () => {
          if (!reason) return;
          send.disabled = true;
          try {
            const body = { reason };
            if (note.value.trim()) body.note = note.value.trim();
            await call(`shorts/${s.id}/report`, { method: 'POST', body });
            s.viewer_reported = true;
            s.viewer_hidden = true;
            sheet.close();
            hideFromFeed(c, 'Reported and hidden from your feed', true);
          } catch (err) { fail(err); send.disabled = false; }
        });
        const sheet = openSheet('Report this clip', [
          h('p', { class: 'tf-sheet-title' }, s.viewer_reported ? 'Update your report' : 'Report this clip'),
          h('p', { class: 'tf-sheet-sub' }, 'An admin will look at it. The clip leaves your feed right away.'),
          listEl, note,
          h('div', { class: 'tf-sheet-btns' }, send, h('button', { type: 'button', class: 'tf-sbtn', onclick: () => sheet.close() }, 'Cancel')),
        ], { size: 'narrow', bare: true });
      }

      // ---- Keyboard ----
      const onKey = (e) => {
        if (e.key === 'Escape') {
          // An open feed selector closes first.
          for (const close of menus) if (close()) { e.preventDefault(); return; }
          // No browser fullscreen to leave (refused or unsupported): Escape
          // ends the page's own immersive view. Not when the same key just
          // closed a sheet (its handler runs first and prevents the default).
          if (F.fullscreen && !e.defaultPrevented && !sheets.length && !(document.fullscreenElement || document.webkitFullscreenElement)) { e.preventDefault(); toggleFullscreen(); return; }
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
        // Space and the arrows belong to a focused control (a button, the
        // feed selector), not to the player.
        if ((e.key === ' ' || e.key.startsWith('Arrow')) && e.target.closest && e.target.closest('button, a[href], [role=menu], [role=listbox]')) return;
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
      // A clip that ended under a sheet moves on once the sheet is closed.
      const onSheetsClosed = () => {
        const c = F.cards[F.active];
        if (!c || !c.advanceOnClose) return;
        c.advanceOnClose = false;
        // After closeSheet() has taken the sheet's history entry back off
        // (a setTimeout 0 plus the async history.back()); stepping sooner
        // would write the next clip's address into that entry.
        const t = setTimeout(() => { if (live(gen) && S.autoScroll && F.cards[F.active] === c && c.video.ended) step(1); }, 150);
        onLeave(() => clearTimeout(t));
      };
      whenSheetsClosed.add(onSheetsClosed);
      onLeave(() => whenSheetsClosed.delete(onSheetsClosed));

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
        fill(resumeBox, h('a', { class: 'tf-resume-btn', href: link('', { focus: saved.focus, sort: 'new' }), onclick: () => { resumeBox.hidden = true; } }, lu('history', 16), 'Continue where you left off'));
        resumeBox.hidden = false;
        const t = setTimeout(() => { resumeBox.hidden = true; }, 15000);
        onLeave(() => clearTimeout(t));
      }

      // ---- Leaving the page stops everything ----
      onLeave(() => {
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
    // done(text, error): the caller shows the result; without it, a sheet.
    async function describe(s, done) {
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
        if (done) { done(sum && sum.summary ? sum.summary : null, sum && sum.error); return; }
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
          const btn = e.currentTarget;
          btn.disabled = true;
          fill(out, 'Importing ...');
          try {
            const d = await call('shorts/import', { method: 'POST' });
            fill(out, h('p', null, `Imported ${num(d.imported)}, new profiles ${num(d.profilesNew)}, skipped ${num(d.skipped)}.`));
            S.gridCache.clear();
          } catch (err) { fill(out, errRow(err)); }
          btn.disabled = false;
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
    // The hub's side menu lists every section; the feed's own selector picks
    // the order, so "Videos" is current on the main feed whatever the order.
    const SECTIONS = [
      { sub: '', label: 'Videos', test: (r) => !r.sub.length },
      { sub: 'explore', label: 'Explore' },
      { sub: 'tags', label: 'Categories', also: ['tag'] },
      { sub: 'profiles', label: 'Profiles', also: ['profile', 'person'] },
      { sub: 'playlists', label: 'Playlists', also: ['playlist'] },
      { sub: 'liked', label: 'Liked' },
      { sub: 'history', label: 'History' },
      { sub: 'mine', label: 'Mine' },
      { sub: 'upload', label: 'Upload' },
      { sub: 'analysis', label: 'Analysis' },
      { sub: 'search', label: 'Search' },
      { sub: 'settings', label: 'Settings', also: ['account'] },
    ];
    function sectionCurrent(sec, r) {
      if (sec.test) return sec.test(r);
      if (r.sub[0] === 'watch') return watchTab(r) === sec.sub;
      return r.sub[0] === sec.sub || (sec.also || []).includes(r.sub[0]);
    }
    // A scoped feed (#/tikshortis/watch?playlist=3) belongs to the section it
    // was opened from.
    function watchTab(r) {
      if (intOf(r.params.get('playlist'))) return 'playlists';
      if (intOf(r.params.get('profile')) || r.params.get('handle')) return 'profiles';
      return '';
    }
    function subnav(r) {
      if (!S.session || !S.session.linked) return [{ href: link('account'), label: 'Link account', current: true }];
      return SECTIONS.map((sec) => ({ href: link(sec.sub, sec.q), label: sec.label, current: sectionCurrent(sec, r) }));
    }
    // TikShortis' bottom bar (components/bottom-nav.tsx): four tabs and a Menu
    // button for everything that does not earn a tab.
    function tabBar(r) {
      const first = r.sub[0] === 'watch' ? watchTab(r) : r.sub[0] || '';
      const TABS = [
        ['', 'Videos', 'play', ['']],
        ['explore', 'Explore', 'compass', ['explore', 'tag']],
        ['profiles', 'Profiles', 'users', ['profiles', 'profile', 'person']],
        ['playlists', 'Playlists', 'listVideo', ['playlists', 'playlist']],
      ];
      const menuBtn = h('button', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
      const paintMenu = (open) => {
        fill(menuBtn, lu('menu', 22, open ? 2.4 : 2), 'Menu');
        menuBtn.setAttribute('aria-expanded', String(open));
      };
      paintMenu(false);
      menuBtn.addEventListener('click', () => {
        paintMenu(true);
        openMenuSheet(() => paintMenu(false));
      });
      return h('nav', { class: 'tik-tabbar', 'aria-label': 'TikShortis' },
        TABS.map(([sub, label, icon, subs]) => {
          const cur = subs.includes(first);
          return h('a', { href: link(sub), 'aria-current': cur ? 'page' : null }, lu(icon, 22, cur ? 2.4 : 2), label);
        }),
        menuBtn);
    }
    // The Menu sheet: TikShortis' own list, plus Grabbit's way to its menu.
    function openMenuSheet(onClose) {
      const u = me();
      const handle = u ? u.handle || handleOf(u.displayName || u.username) || 'you' : 'you';
      const row = (sub, label, icon) => {
        const href = sub.startsWith('#') ? sub : link(sub);
        return h('a', { class: 'tf-row', href, onclick: (e) => { if (location.hash === href) { e.preventDefault(); sheet.close(); } } }, lu(icon, 18, 2, 'dim'), h('span', { class: 'tf-row-l' }, label));
      };
      const wide = matchMedia('(min-width: 901px)').matches;
      const sideLabel = wide ? (hub.sideOpen() ? 'Hide the Grabbit menu' : 'Show the Grabbit menu') : 'Grabbit menu';
      const sheet = openSheet(`@${handle}`, h('div', { class: 'tf-menu' },
        row('tags', 'Categories', 'hash'),
        row('analysis', 'Analysis', 'sparkles'),
        row('mine', 'Mine', 'clapperboard'),
        row('history', 'History', 'history'),
        row('upload', 'Upload', 'upload'),
        row('search', 'Search', 'search'),
        // Grabbing is Grabbit's own job: its start page.
        isAdmin() ? row('#/', 'Grab', 'download') : null,
        row('settings', 'Settings', 'settings'),
        h('div', { class: 'tf-sep' }),
        h('button', { type: 'button', class: 'tf-row', onclick: () => { sheet.close(); hub.toggleSide(); } }, lu(wide ? 'panelLeft' : 'menu', 18, 2, 'dim'), h('span', { class: 'tf-row-l' }, sideLabel)),
        h('button', { type: 'button', class: 'tf-row', onclick: async (e) => {
          // TikShortis' Sign out ends its session; here that is the link.
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const res = await fetch('/api/tik/session', { method: 'DELETE', credentials: 'same-origin' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            sheet.close();
            S.session = undefined;
            S.gridCache.clear();
            S.catalogue = { tags: null, creators: null, at: 0 };
            await loadSession(true);
          } catch (err) { fail(err); btn.disabled = false; }
        } }, lu('logOut', 18, 2, 'dim'), h('span', { class: 'tf-row-l' }, 'Sign out of TikShortis'))),
      { size: 'wide', cls: 'tf-sheet-menu', onClose });
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
