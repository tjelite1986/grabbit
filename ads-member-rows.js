'use strict';
// Grabbit 3.0 native Adshortis, phase 3: the member rows (M1-M25) and media
// rows (D1-D3) as data. Pure module, no I/O; adshortis-gateway.js does the
// requests. Per row it says:
//
//   - the upstream path, built from the matched row and its numeric params,
//     never from the browser's path;
//   - which query keys pass and with which values (`q` is refused everywhere,
//     GAP 4 / H6: search words travel only in POST bodies);
//   - the write body the gateway re-serialises (unknown keys dropped);
//   - the projection of the upstream answer (field allowlist: unknown keys and
//     `error` never pass; relative /m/ URLs become /api/ads/m/, others drop).
//
// A projection returns undefined when the upstream answer has the wrong
// shape; the gateway then answers 424.

const matrix = require('./ads-route-matrix');

const MOUNT = '/api/ads';

// H82: a tag in ?tag= (and in a share link).
const TAG_RE = /^[\p{L}\p{N}_]{1,60}$/u;
const NUM_RE = /^[0-9]{1,15}$/;
const CURSOR_RE = /^-?[0-9]{1,16}$/;
const GENRE_RE = /^[a-z_]{1,30}(,[a-z_]{1,30}){0,19}$/;
const REPORT_REASONS = ['no_play', 'wrong_meta', 'duplicate', 'inappropriate', 'other'];
const VISIBILITY = ['public', 'private'];
// H64: a page holds at most 60 clips.
const PAGE_MAX = 60;
const SEARCH_MAX = 100;
const LOOKUP_MAX = 100;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const idOf = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const intOf = (v) => (Number.isSafeInteger(v) ? v : null);
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOf = (v) => (typeof v === 'string' ? v : null);
const boolOf = (v) => (typeof v === 'boolean' ? v : null);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// A media path from upstream JSON: relative /m/... becomes /api/ads/m/...;
// anything else (absolute, protocol-relative, foreign, odd) is dropped.
function rewriteMediaUrl(v) {
  if (typeof v !== 'string') return null;
  if (!/^\/m\/[A-Za-z0-9._~\-/]{1,500}$/.test(v) || v.includes('//') || v.split('/').includes('..')) return null;
  return MOUNT + v;
}

// --- Projections -------------------------------------------------------------------

// GAP 3 / H81: the list fields. M3 adds DETAIL_FIELDS. `error` is never one.
const CLIP_FIELDS = [
  'id', 'title', 'genre', 'visibility', 'status', 'deleted', 'created_at', 'source_url', 'tags', 'creator',
  'width', 'height', 'duration', 'has_audio', 'poster', 'video', 'like_count', 'comment_count', 'liked', 'mine',
];
const DETAIL_FIELDS = ['hidden', 'can_edit', 'can_curate', 'ai_description'];

function projectClip(c, detail = false) {
  if (!isObj(c) || !idOf(c.id)) return null;
  const cr = isObj(c.creator) && idOf(c.creator.id)
    ? { id: c.creator.id, name: strOf(c.creator.name) || '', avatar: rewriteMediaUrl(c.creator.avatar), following: c.creator.following === true }
    : null;
  const out = {
    id: c.id,
    title: strOf(c.title) || '',
    genre: strOf(c.genre),
    visibility: VISIBILITY.includes(c.visibility) ? c.visibility : null,
    status: strOf(c.status),
    // Unknown stays null, and null is not eligible for playback (H80).
    deleted: boolOf(c.deleted),
    created_at: numOf(c.created_at),
    // Kept as text; the hub opens it only through safeHref() (matrix J).
    source_url: typeof c.source_url === 'string' && c.source_url.length <= 2000 ? c.source_url : null,
    tags: strList(c.tags),
    creator: cr,
    width: numOf(c.width),
    height: numOf(c.height),
    duration: numOf(c.duration),
    has_audio: boolOf(c.has_audio),
    poster: rewriteMediaUrl(c.poster),
    video: rewriteMediaUrl(c.video),
    like_count: intOf(c.like_count) || 0,
    comment_count: intOf(c.comment_count) || 0,
    liked: c.liked === true,
    mine: c.mine === true,
  };
  if (detail) {
    out.hidden = c.hidden === true;
    out.can_edit = c.can_edit === true;
    out.can_curate = c.can_curate === true;
    out.ai_description = strOf(c.ai_description);
  }
  return out;
}

// GW-ELIG (H80): a single clip plays only when it is not deleted and ready,
// for every role, the uploader and admins included.
const eligible = (clip) => !!clip && clip.deleted === false && clip.status === 'ready';

const cursorOf = (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

function clipPage(d) {
  if (!isObj(d) || !Array.isArray(d.items)) return undefined;
  const out = { items: d.items.map((c) => projectClip(c)).filter(Boolean), next: cursorOf(d.next), prev: cursorOf(d.prev) };
  if (Number.isSafeInteger(d.total)) out.total = d.total;
  return out;
}

const clipArray = (d) => (Array.isArray(d) ? { items: d.map((c) => projectClip(c)).filter(Boolean) } : undefined);

function creatorCard(c) {
  if (!isObj(c) || !idOf(c.id)) return null;
  return {
    id: c.id,
    name: strOf(c.name) || '',
    count: intOf(c.count) || 0,
    avatar: rewriteMediaUrl(c.avatar),
    cover: rewriteMediaUrl(c.cover),
    cover_clip: idOf(c.cover_clip),
  };
}
const creatorList = (d) => (Array.isArray(d) ? { items: d.map(creatorCard).filter(Boolean) } : undefined);

// GAP 7 (owner Q5): a link passes only with an https: URL; `source` never.
function httpsUrl(v) {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function creatorDetail(d) {
  if (!isObj(d)) return undefined;
  if (Object.hasOwn(d, 'redirect')) return idOf(d.redirect) ? { redirect: d.redirect } : undefined;
  if (!idOf(d.id)) return undefined;
  const links = (Array.isArray(d.links) ? d.links : [])
    .map((l) => (isObj(l) && httpsUrl(l.url) ? { kind: strOf(l.kind), url: httpsUrl(l.url), label: strOf(l.label) } : null))
    .filter(Boolean);
  return {
    id: d.id,
    name: strOf(d.name) || '',
    avatar: rewriteMediaUrl(d.avatar),
    has_avatar: d.has_avatar === true,
    links,
    aliases: strList(d.aliases),
    person: isObj(d.person) && idOf(d.person.id) ? { id: d.person.id, name: strOf(d.person.name) || '' } : null,
    merged_into: idOf(d.merged_into),
    following: d.following === true,
  };
}

function person(d) {
  if (!isObj(d) || !idOf(d.id)) return undefined;
  const profiles = (Array.isArray(d.profiles) ? d.profiles : [])
    .map((p) => (isObj(p) && idOf(p.id) ? { id: p.id, name: strOf(p.name) || '', avatar: rewriteMediaUrl(p.avatar) } : null))
    .filter(Boolean);
  return { id: d.id, name: strOf(d.name) || '', profiles, aliases: strList(d.aliases) };
}

// M5: comment authors show as initials (D4 stays held, owner Q4), so no
// avatar and no upstream user id pass.
function comments(d) {
  if (!Array.isArray(d)) return undefined;
  const items = d
    .map((c) => (isObj(c) && idOf(c.id)
      ? { id: c.id, body: strOf(c.body) || '', created_at: numOf(c.created_at), display_name: strOf(c.display_name) || '', can_delete: c.can_delete === true }
      : null))
    .filter(Boolean);
  return { items };
}

function tags(d) {
  if (!Array.isArray(d)) return undefined;
  return { items: d.filter((t) => isObj(t) && typeof t.tag === 'string').map((t) => ({ tag: t.tag, count: intOf(t.count) || 0 })) };
}

function playlists(d) {
  if (!Array.isArray(d)) return undefined;
  const items = d
    .map((p) => (isObj(p) && idOf(p.id) ? { id: p.id, name: strOf(p.name) || '', count: intOf(p.count) || 0, cover: rewriteMediaUrl(p.cover) } : null))
    .filter(Boolean);
  return { items };
}

const idName = (d) => (isObj(d) && idOf(d.id) ? { id: d.id, name: strOf(d.name) || '' } : undefined);
const okOnly = (d) => (isObj(d) ? {} : undefined);
const flag = (key) => (d) => (isObj(d) && typeof d[key] === 'boolean' ? { [key]: d[key] } : undefined);
const prefs = (d) => {
  const p = matrix.projectPrefs(d);
  return p ? { prefs: p } : undefined;
};

// --- Query and body validation ----------------------------------------------------------

const bad = (error = 'Bad request') => ({ status: 400, error });

// M1 (and M2's filters): the query keys that pass, each with its value check.
const CLIP_QUERY = {
  feed: (v) => matrix.FEEDS.includes(v),
  genre: (v) => GENRE_RE.test(v),
  length: (v) => v === 'short' || v === 'long',
  sound: (v) => v === '1',
  creator: (v) => NUM_RE.test(v),
  person: (v) => NUM_RE.test(v),
  playlist: (v) => NUM_RE.test(v),
  around: (v) => NUM_RE.test(v),
  tag: (v) => TAG_RE.test(v),
  mine: (v) => v === '1',
  count: (v) => v === '1',
  seed: (v) => /^[0-9]{1,10}$/.test(v),
  next: (v) => CURSOR_RE.test(v),
  prev: (v) => CURSOR_RE.test(v),
  limit: (v) => /^[0-9]{1,3}$/.test(v) && Number(v) >= 1,
};

// Pairs [key, value] -> a query string for the upstream path, or { status }.
// Unknown keys are dropped; a known key twice, or with a bad value, is 400.
function clipQuery(pairs) {
  const out = new URLSearchParams();
  const seen = new Set();
  for (const [k, raw] of pairs) {
    if (!Object.hasOwn(CLIP_QUERY, k)) continue;
    if (seen.has(k)) return bad();
    seen.add(k);
    const v = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof v !== 'string' || !CLIP_QUERY[k](v)) return bad(k === 'tag' ? 'This tag cannot be opened.' : 'Bad request');
    out.set(k, k === 'limit' ? String(Math.min(Number(v), PAGE_MAX)) : v);
  }
  return { qs: out.toString() };
}

// M2 body: { q, ...M1 filters } -> the upstream query with the words as `q`.
function searchQuery(body) {
  if (!isObj(body)) return bad();
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  if (!q || q.length > SEARCH_MAX) return bad('Search words are required');
  const r = clipQuery(Object.entries(body).filter(([k]) => k !== 'q'));
  if (r.status) return r;
  const p = new URLSearchParams(r.qs);
  p.set('q', q);
  return { qs: p.toString() };
}

const numeric = (v) => (Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && NUM_RE.test(v) && Number(v) > 0);

const WRITE_BODY = {
  M6(b) {
    const body = isObj(b) && typeof b.body === 'string' ? b.body.trim() : '';
    if (!body || body.length > 2000) return bad('Comment is empty or too long');
    return { body: { body } };
  },
  M10(b) {
    if (!isObj(b) || !REPORT_REASONS.includes(b.reason)) return bad('Unknown reason');
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 1000)) return bad('Note is too long');
    return { body: { reason: b.reason, ...(typeof b.note === 'string' && b.note.trim() ? { note: b.note.trim() } : {}) } };
  },
  M20(b) {
    const name = isObj(b) && typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) return bad('Name is required');
    if (b.clip_id !== undefined && b.clip_id !== null && !numeric(b.clip_id)) return bad();
    return { body: { name, ...(numeric(b.clip_id) ? { clip_id: Number(b.clip_id) } : {}) } };
  },
  M21(b) {
    const name = isObj(b) && typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) return bad('Name is required');
    return { body: { name } };
  },
  M22(b) {
    if (!isObj(b) || !numeric(b.clip_id)) return bad();
    return { body: { clip_id: Number(b.clip_id) } };
  },
  // GAP 6: only PREFS_FIELDS with upstream's own value rules; the rest drops.
  M25(b) {
    if (!isObj(b)) return bad();
    const out = {};
    if (typeof b.sound === 'boolean') out.sound = b.sound;
    if (typeof b.autoplay === 'boolean') out.autoplay = b.autoplay;
    if (Number.isSafeInteger(b.grid_columns) && b.grid_columns >= 2 && b.grid_columns <= 8) out.grid_columns = b.grid_columns;
    if (matrix.FEEDS.includes(b.feed)) out.feed = b.feed;
    if (isObj(b.feed_pos)) {
      const pos = {};
      let n = 0;
      for (const [k, v] of Object.entries(b.feed_pos)) {
        if (n >= matrix.FEED_POS_MAX) break;
        if (k.length > matrix.FEED_POS_KEY_MAX || k === '__proto__') continue;
        if (v === null || Number.isSafeInteger(v)) { pos[k] = v; n++; }
      }
      out.feed_pos = pos;
    }
    return { body: out };
  },
};

// M14 body: { name } -> the upstream creators query.
function lookupQuery(body) {
  const name = isObj(body) && typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > LOOKUP_MAX) return bad('A profile name is required');
  return { qs: new URLSearchParams({ q: name }).toString(), name };
}
// Exact name match in Grabbit (H35): upstream matches LIKE %name% and aliases.
function lookupFilter(list, name) {
  const want = name.normalize('NFC');
  return { items: list.items.filter((c) => c.name.normalize('NFC') === want) };
}

// Upload (M12) metadata, sent by the hub as base64url JSON in X-Ads-Upload.
// Field allowlist: title, tags, creator, genre, visibility (the file is the
// request body).
const UPLOAD_META_MAX = 8 * 1024;
function uploadMeta(header) {
  if (header === undefined) return { fields: {} };
  if (typeof header !== 'string' || header.length > UPLOAD_META_MAX || !/^[A-Za-z0-9_-]*$/.test(header)) return bad();
  let m;
  try {
    m = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    return bad();
  }
  if (!isObj(m)) return bad();
  const fields = {};
  const text = (k, max) => {
    if (m[k] === undefined || m[k] === null) return true;
    if (typeof m[k] !== 'string' || m[k].length > max) return false;
    if (m[k].trim()) fields[k] = m[k].trim();
    return true;
  };
  if (!text('title', 500) || !text('tags', 1000) || !text('creator', 120)) return bad();
  if (m.genre !== undefined && m.genre !== null) {
    if (typeof m.genre !== 'string' || !/^[a-z_]{1,30}$/.test(m.genre)) return bad();
    fields.genre = m.genre;
  }
  if (m.visibility !== undefined && m.visibility !== null) {
    if (!VISIBILITY.includes(m.visibility)) return bad();
    fields.visibility = m.visibility;
  }
  // No control characters in a multipart field (they would end the part).
  for (const v of Object.values(fields)) if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(v)) return bad();
  return { fields };
}

const uploadResult = (d) => (isObj(d) && idOf(d.id) ? { id: d.id, status: strOf(d.status) } : undefined);

// --- The rows -------------------------------------------------------------------------------

// row -> { path(params), query: 'clips' | 'all' | undefined, body: validator,
// project(d), eligible: check the clip first (GAP 23) }.
// Methods come from the matrix; a row with two methods shares its spec.
const ROWS = {
  M1: { path: () => '/api/clips', query: 'clips', project: clipPage },
  M2: { path: () => '/api/clips', search: true, limited: true, project: clipPage },
  M3: { path: (p) => `/api/clips/${p.id}`, project: (d) => projectClip(d, true) || undefined, single: true },
  M4: { path: (p) => `/api/clips/${p.id}/like`, project: (d) => (isObj(d) && typeof d.liked === 'boolean' ? { liked: d.liked, like_count: intOf(d.like_count) || 0 } : undefined) },
  M5: { path: (p) => `/api/clips/${p.id}/comments`, eligible: true, project: comments },
  M6: { path: (p) => `/api/clips/${p.id}/comments`, body: WRITE_BODY.M6, project: (d) => (isObj(d) && idOf(d.id) ? { id: d.id } : undefined) },
  M7: { path: (p) => `/api/comments/${p.id}`, project: okOnly },
  M8: { path: (p) => `/api/clips/${p.id}/hide`, project: flag('hidden') },
  M9: { path: () => '/api/hidden', project: clipArray },
  M10: { path: (p) => `/api/clips/${p.id}/report`, body: WRITE_BODY.M10, project: okOnly },
  M11: { path: () => '/api/tags', project: tags },
  M12: { path: () => '/api/upload', upload: true, project: uploadResult },
  M13: { path: () => '/api/creators', project: creatorList },
  M14: { path: () => '/api/creators', lookup: true, limited: true, project: creatorList },
  M15: { path: (p) => `/api/creators/${p.id}`, project: creatorDetail },
  M16: { path: (p) => `/api/creators/${p.id}/follow`, project: flag('following') },
  M17: { path: (p) => `/api/persons/${p.id}`, project: person },
  M18: { path: () => '/api/playlists', query: 'all', project: playlists },
  M19: { path: (p) => `/api/playlists/${p.id}`, project: idName },
  M20: { path: () => '/api/playlists', body: WRITE_BODY.M20, project: idName },
  M21: { path: (p) => `/api/playlists/${p.id}`, body: WRITE_BODY.M21, bodyOn: ['PATCH'], project: okOnly },
  M22: { path: (p) => `/api/playlists/${p.id}/items`, body: WRITE_BODY.M22, project: okOnly },
  M23: { path: (p) => `/api/playlists/${p.id}/items/${p.clip}`, project: okOnly },
  M24: { path: (p) => `/api/clips/${p.id}/playlists`, project: (d) => (Array.isArray(d) ? { items: d.filter((x) => idOf(x)) } : undefined) },
  M25: { path: () => '/api/me/prefs', body: WRITE_BODY.M25, project: prefs },
  // Media: streamed, never projected.
  D1: { path: (p) => `/m/video/${p.id}`, media: 'video' },
  D2: { path: (p) => `/m/poster/${p.id}`, media: 'image' },
  D3: { path: (p) => `/m/avatar/creator/${p.id}`, media: 'image' },
};

// Every key a row's query may carry, as [key, value] pairs from the URL.
// Returns { qs } or { status, error }.
function rowQuery(spec, pairs) {
  // GAP 4 / H6: words never travel in a URL; `q` is refused on every row.
  if (pairs.some(([k]) => k === 'q')) return bad('Search goes through POST /api/ads/search');
  if (spec.query === 'clips') return clipQuery(pairs);
  if (spec.query === 'all') {
    const all = pairs.filter(([k]) => k === 'all');
    if (all.length > 1 || (all.length === 1 && all[0][1] !== '1')) return bad();
    return { qs: all.length ? 'all=1' : '' };
  }
  return { qs: '' };
}

module.exports = {
  MOUNT,
  TAG_RE,
  PAGE_MAX,
  CLIP_FIELDS,
  DETAIL_FIELDS,
  ROWS,
  rewriteMediaUrl,
  projectClip,
  eligible,
  clipQuery,
  searchQuery,
  lookupQuery,
  lookupFilter,
  uploadMeta,
  rowQuery,
  httpsUrl,
};
