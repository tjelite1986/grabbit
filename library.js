'use strict';
// Grabbit 2.1 library: virtual views over items.db (media tree, categories,
// profile tree). Nothing here moves, copies or deletes a media file; a view is
// a query, and a category is a row that points at an item.
//
// Rules, each one a promise to the owner:
// - Every read takes a scope, 'general' or 'adult', and filters on the item's
//   audience in SQL before anything else. A general scope sees general items
//   only: adult and unknown items never reach a count, a tree, a search or a
//   list. A bad scope is an error, never a default.
// - Categories are general or adult, never both, and an item joins only a
//   category of its own audience (trigger in schema v6). A category of the
//   other scope does not exist as far as a scope is concerned.
// - One item can sit in many categories; membership is a row, not a copy.
// - Source tags and the owner's tags are only read here, to make suggestions.
//   A suggestion never writes a membership.
// - Short or long is decided from the source's explicit format and the
//   duration where both are reliable; otherwise the item is flagged
//   uncertain and the owner can correct it (items.format_override).
// - Every change to categories, memberships or an override is logged in
//   library_log.

const sourceMeta = require('./source-meta');
const audience = require('./audience');
const profilesLib = require('./profiles');

const SCOPES = ['general', 'adult'];
const NAME_MAX = 80;
const DEPTH_MAX = 6;
const BULK_MAX = 5000;
const SHORT_MAX_S = 60;
const SHORT_EXPLICIT_MAX_S = 180;
const LONG_MIN_S = 240;
// Sites that only host short vertical clips: their format is explicit, the
// same way a TikTok address is. Matched on the site slug (siteSlug()).
const SHORT_FORM_SITES = new Set(['redgifs', 'fikfap', 'xxxfollow', 'reddclips', 'nuditok', 'tikporn', 'tik']);

class LibraryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function scopeOf(scope) {
  if (!SCOPES.includes(scope)) throw new LibraryError('scope must be general or adult');
  return scope;
}

const GENERAL_SECTIONS = [
  ['shortis', 'Shortis'],
  ['videos', 'Videos'],
  ['music', 'Music'],
  ['movies', 'Movies'],
  ['photos', 'Photos'],
];
const ADULT_SECTIONS = [
  ['shortis-adults', 'Shortis Adults'],
  ['videos-adults', 'Videos Adults'],
  ['photos-adults', 'Photos Adults'],
];
const PLATFORM_ORDER = ['tiktok', 'facebook', 'instagram', 'youtube'];
const PLATFORM_LABELS = { tiktok: 'TikTok', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', other: 'Other' };

// A hostname or extractor name as one lowercase slug: redgifs.com -> redgifs,
// tik.porn -> tikporn, RedGifs -> redgifs.
function siteSlug(site) {
  let s = String(site || '').trim().toLowerCase();
  if (!s) return 'other';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
  } catch { /* keep as is */ }
  s = s.replace(/^(www|m)\./, '');
  if (s.includes('.')) s = s.slice(0, s.lastIndexOf('.'));
  return s.replace(/[^a-z0-9]+/g, '') || 'other';
}

const slugLabel = (slug) => PLATFORM_LABELS[slug] || (slug === 'other' ? 'Other' : slug.charAt(0).toUpperCase() + slug.slice(1));

function generalPlatform(site, url) {
  const p = audience.platformOfSite(site) || audience.platformOfSite(url);
  return PLATFORM_ORDER.includes(p) ? p : 'other';
}

// short | long | uncertain, with the reason. Explicit format first (a Shorts,
// Reel or TikTok address), then duration; a clip that is neither clearly short
// nor clearly long stays uncertain and is shown with the long videos.
function classifyFormat({ url, site, duration }) {
  const d = Number.isFinite(Number(duration)) && duration !== null ? Number(duration) : null;
  let path = '';
  let host = '';
  try {
    const u = new URL(String(url || ''));
    path = u.pathname;
    host = u.hostname.replace(/^(www|m)\./, '');
  } catch { /* no usable address */ }
  const explicitShort =
    /\/shorts\//.test(path) ||
    (/(^|\.)(instagram|facebook)\.com$/.test(host) && /\/reels?\//.test(path)) ||
    /(^|\.)tiktok\.com$/.test(host) ||
    audience.platformOfSite(site) === 'tiktok' ||
    SHORT_FORM_SITES.has(siteSlug(site)) ||
    (host && SHORT_FORM_SITES.has(siteSlug(host)));
  if (explicitShort) {
    if (d === null || d <= SHORT_EXPLICIT_MAX_S) return { format: 'short', reason: 'source format' };
    return { format: 'uncertain', reason: 'short format but long duration' };
  }
  if (d === null) return { format: 'uncertain', reason: 'no duration' };
  if (d <= SHORT_MAX_S) return { format: 'short', reason: 'duration' };
  if (d >= LONG_MIN_S) return { format: 'long', reason: 'duration' };
  return { format: 'uncertain', reason: 'duration between short and long' };
}

// Where an item sits in the media tree.
function placement(row, scope) {
  const adult = scope === 'adult';
  const sub = (slug) => (adult ? slug : slug);
  let format = null;
  let uncertain = false;
  let section;
  if (row.kind === 'audio') section = 'music';
  else if (row.kind === 'image') section = 'photos';
  else {
    if (row.format_override === 'movie') format = 'movie';
    else if (row.format_override === 'short') format = 'short';
    else if (row.format_override === 'long') format = 'long';
    else {
      const c = classifyFormat({ url: row.wurl || row.source_url, site: row.site, duration: row.dur });
      format = c.format === 'uncertain' ? 'long' : c.format;
      uncertain = c.format === 'uncertain';
    }
    section = format === 'movie' ? 'movies' : format === 'short' ? 'shortis' : 'videos';
  }
  if (adult) {
    if (section === 'music' || section === 'movies') return { section: null, sub: null, uncertain };
    return { section: `${section}-adults`, sub: sub(siteSlug(row.site)), uncertain };
  }
  if (section === 'music' || section === 'movies') return { section, sub: null, uncertain };
  return { section, sub: generalPlatform(row.site, row.source_url), uncertain };
}

function cleanName(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) throw new LibraryError('a category needs a name');
  if (s.length > NAME_MAX) throw new LibraryError(`a category name is at most ${NAME_MAX} characters`);
  return s;
}
const normName = (s) => s.normalize('NFKC').toLocaleLowerCase('und');

function idList(ids, what = 'ids') {
  if (!Array.isArray(ids) || !ids.length) throw new LibraryError(`${what} must be a list`);
  if (ids.length > BULK_MAX) throw new LibraryError(`at most ${BULK_MAX} ${what} at a time`);
  return [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
}

// The profile ids of merged-away profiles resolve to the profile they went into.
function canonicalMap(store) {
  const m = new Map();
  for (const p of (store && store.profiles) || []) {
    m.set(p.id, p.id);
    for (const id of p.mergedFrom || []) if (!m.has(id)) m.set(id, p.id);
  }
  return m;
}

function attach(db) {
  const st = {
    cat: db.prepare('SELECT * FROM categories WHERE id = ?'),
    cats: db.prepare('SELECT * FROM categories WHERE adult = ? ORDER BY norm, id'),
    catInsert: db.prepare('INSERT INTO categories (parent_id, name, norm, adult, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    catUpdate: db.prepare('UPDATE categories SET parent_id = ?, name = ?, norm = ?, updated_at = ? WHERE id = ?'),
    catDelete: db.prepare('DELETE FROM categories WHERE id = ?'),
    catChildren: db.prepare('UPDATE categories SET parent_id = ?, updated_at = ? WHERE parent_id = ?'),
    siblings: db.prepare('SELECT id FROM categories WHERE COALESCE(parent_id, 0) = ? AND adult = ? AND norm = ?'),
    members: db.prepare(`SELECT ic.item_id, ic.category_id FROM item_categories ic
      JOIN categories c ON c.id = ic.category_id JOIN items i ON i.id = ic.item_id
      WHERE c.adult = @adult AND i.audience = @audience`),
    link: db.prepare('INSERT OR IGNORE INTO item_categories (item_id, category_id, at, by) VALUES (?, ?, ?, ?)'),
    unlink: db.prepare('DELETE FROM item_categories WHERE item_id = ? AND category_id = ?'),
    moveMembers: db.prepare('INSERT OR IGNORE INTO item_categories (item_id, category_id, at, by) SELECT item_id, ?, ?, ? FROM item_categories WHERE category_id = ?'),
    dropMembers: db.prepare('DELETE FROM item_categories WHERE category_id = ?'),
    item: db.prepare('SELECT id, audience, kind FROM items WHERE id = ?'),
    setFormat: db.prepare('UPDATE items SET format_override = ?, updated_at = ? WHERE id = ?'),
    log: db.prepare('INSERT INTO library_log (action, detail, by, at) VALUES (?, ?, ?, ?)'),
    tagHits: db.prepare('SELECT item_id, origin, label FROM item_tags WHERE norm = ? ORDER BY origin, item_id'),
    itemTags: db.prepare('SELECT norm FROM item_tags WHERE item_id = ?'),
  };

  const log = (action, detail, by, now) => st.log.run(action, JSON.stringify(detail), by || null, now);

  // The scoped rows. The audience filter is the first thing in the query.
  function scopedRows(scope) {
    scopeOf(scope);
    return db.prepare(`
      SELECT i.id, i.key, i.site, i.kind, i.audience, i.source_url, i.filename, i.format_override, i.profile_id,
        COALESCE(i.title_edit, i.title) AS title, COALESCE(i.creator_edit, i.creator) AS creator,
        i.updated_at,
        CASE WHEN json_valid(m.raw) THEN json_extract(m.raw, '$.duration') END AS dur,
        CASE WHEN json_valid(m.raw) THEN json_extract(m.raw, '$.webpage_url') END AS wurl,
        CASE WHEN json_valid(m.raw) THEN json_extract(m.raw, '$.thumbnail') END AS thumb
      FROM items i LEFT JOIN item_source_meta m ON m.item_id = i.id
      WHERE i.audience = ?
      ORDER BY i.updated_at DESC, i.id DESC`).all(scope);
  }

  function catIn(scope, id) {
    const c = Number.isInteger(Number(id)) ? st.cat.get(Number(id)) : null;
    if (!c || c.adult !== (scope === 'adult' ? 1 : 0)) throw new LibraryError('no such category', 404);
    return c;
  }
  const depthOf = (c) => {
    let n = 1;
    for (let p = c; p.parent_id; n++) p = st.cat.get(p.parent_id);
    return n;
  };
  const descendants = (scope, id) => {
    const all = st.cats.all(scope === 'adult' ? 1 : 0);
    const out = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of all) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) { out.add(c.id); grew = true; }
    }
    return out;
  };
  const heightOf = (scope, id) => {
    const all = st.cats.all(scope === 'adult' ? 1 : 0);
    const h = (cid) => 1 + Math.max(0, ...all.filter((c) => c.parent_id === cid).map((c) => h(c.id)));
    return h(id);
  };
  const clash = (parentId, adult, norm, exceptId) =>
    st.siblings.all(parentId || 0, adult, norm).some((r) => r.id !== exceptId);

  const tx = (fn) => db.transaction(fn);

  const api = {
    scopes: SCOPES,

    // ---- media tree -------------------------------------------------------
    mediaTree(scope) {
      scopeOf(scope);
      const rows = scopedRows(scope);
      const sections = scope === 'adult' ? ADULT_SECTIONS : GENERAL_SECTIONS;
      const counts = new Map(sections.map(([id]) => [id, { n: 0, subs: new Map() }]));
      let total = 0;
      for (const r of rows) {
        const p = placement(r, scope);
        total++;
        if (!p.section) continue;
        const s = counts.get(p.section);
        s.n++;
        if (p.sub) s.subs.set(p.sub, (s.subs.get(p.sub) || 0) + 1);
      }
      const subOrder = (a, b) => {
        const ia = PLATFORM_ORDER.indexOf(a[0]);
        const ib = PLATFORM_ORDER.indexOf(b[0]);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        if (a[0] === 'other') return 1;
        if (b[0] === 'other') return -1;
        return a[0].localeCompare(b[0]);
      };
      // Unclassified items belong to neither scope. Only their number is
      // given, so the owner knows how much is waiting in Review.
      const unclassified = db.prepare("SELECT COUNT(*) AS n FROM items WHERE audience = 'unknown'").get().n;
      return {
        scope,
        id: 'all',
        label: 'All Media',
        count: total,
        unclassified,
        children: sections.map(([id, label]) => ({
          id,
          label,
          count: counts.get(id).n,
          children: [...counts.get(id).subs.entries()].sort(subOrder).map(([sub, n]) => ({ id: `${id}:${sub}`, label: slugLabel(sub), count: n })),
        })),
      };
    },

    // ---- items of a node ----------------------------------------------------
    // node: 'all', 'shortis', 'shortis:tiktok', 'cat:12', 'profile:3', 'profile:none'.
    // `store` is the profile store (only for profile nodes).
    listItems({ scope, node = 'all', q = '', uncertain = false, branch = true, limit = 60, offset = 0, store = null } = {}) {
      scopeOf(scope);
      let rows = scopedRows(scope);
      const nodeStr = String(node || 'all');
      if (nodeStr.startsWith('cat:')) {
        const c = catIn(scope, nodeStr.slice(4));
        const ids = branch ? descendants(scope, c.id) : new Set([c.id]);
        const inCat = new Set(st.members.all({ adult: scope === 'adult' ? 1 : 0, audience: scope }).filter((m) => ids.has(m.category_id)).map((m) => m.item_id));
        rows = rows.filter((r) => inCat.has(r.id));
      } else if (nodeStr.startsWith('profile:')) {
        const canon = canonicalMap(store);
        const want = nodeStr.slice(8);
        if (want === 'none') rows = rows.filter((r) => !r.profile_id || !canon.has(r.profile_id));
        else {
          const p = ((store && store.profiles) || []).find((x) => x.id === Number(want));
          if (!p || profilesLib.effectiveAudience(p) !== scope) throw new LibraryError('no such profile', 404);
          rows = rows.filter((r) => canon.get(r.profile_id) === p.id);
        }
      }
      let placed = rows.map((r) => ({ r, p: placement(r, scope) }));
      if (!nodeStr.startsWith('cat:') && !nodeStr.startsWith('profile:') && nodeStr !== 'all') {
        const [sec, sub] = nodeStr.split(':');
        placed = placed.filter(({ p }) => p.section === sec && (!sub || p.sub === sub));
      }
      if (uncertain) placed = placed.filter(({ p }) => p.uncertain);
      const needle = String(q || '').trim().toLowerCase();
      if (needle) {
        placed = placed.filter(({ r }) => [r.title, r.creator, r.filename].some((v) => v && String(v).toLowerCase().includes(needle)));
      }
      const total = placed.length;
      const lim = Math.max(1, Math.min(200, Number(limit) || 60));
      const off = Math.max(0, Number(offset) || 0);
      const page = placed.slice(off, off + lim);
      const cats = new Map();
      for (const m of st.members.all({ adult: scope === 'adult' ? 1 : 0, audience: scope })) {
        if (!cats.has(m.item_id)) cats.set(m.item_id, []);
        cats.get(m.item_id).push(m.category_id);
      }
      return {
        scope,
        total,
        offset: off,
        items: page.map(({ r, p }) => ({
          id: r.id, key: r.key, title: r.title, creator: r.creator, site: r.site, kind: r.kind, filename: r.filename,
          audience: r.audience, profileId: r.profile_id, section: p.section, sub: p.sub, formatUncertain: p.uncertain,
          formatOverride: r.format_override, categories: cats.get(r.id) || [],
          thumb: typeof r.thumb === 'string' && /^https?:\/\//i.test(r.thumb) ? r.thumb : null, sourceUrl: r.source_url || null,
        })),
      };
    },

    // The owner's correction of short / long / movie for videos in this scope.
    // value null clears it.
    setFormat({ scope, ids, value, by = null, now = Date.now() }) {
      scopeOf(scope);
      if (value !== null && !['short', 'long', 'movie'].includes(value)) throw new LibraryError('format must be short, long, movie or null');
      const list = idList(ids);
      const changed = [];
      const skipped = [];
      tx(() => {
        for (const id of list) {
          const it = st.item.get(id);
          if (!it || it.audience !== scope) skipped.push({ id, reason: 'no such item' });
          else if (it.kind !== 'video') skipped.push({ id, reason: 'only videos have a format' });
          else {
            st.setFormat.run(value, now, id);
            changed.push(id);
          }
        }
        if (changed.length) log('format', { ids: changed, value }, by, now);
      })();
      return { changed, skipped };
    },

    // ---- categories ---------------------------------------------------------
    categoryTree(scope) {
      scopeOf(scope);
      const all = st.cats.all(scope === 'adult' ? 1 : 0);
      const direct = new Map();
      for (const m of st.members.all({ adult: scope === 'adult' ? 1 : 0, audience: scope })) {
        if (!direct.has(m.category_id)) direct.set(m.category_id, new Set());
        direct.get(m.category_id).add(m.item_id);
      }
      const kids = new Map();
      for (const c of all) {
        const k = c.parent_id || 0;
        if (!kids.has(k)) kids.set(k, []);
        kids.get(k).push(c);
      }
      const build = (c) => {
        const children = (kids.get(c.id) || []).map(build);
        const set = new Set(direct.get(c.id) || []);
        for (const ch of children) ch._set.forEach((x) => set.add(x));
        return { id: c.id, name: c.name, parentId: c.parent_id, direct: (direct.get(c.id) || new Set()).size, count: set.size, children, _set: set };
      };
      const roots = (kids.get(0) || []).map(build);
      const strip = (n) => { delete n._set; n.children.forEach(strip); return n; };
      roots.forEach(strip);
      const everyone = new Set();
      for (const s of direct.values()) s.forEach((x) => everyone.add(x));
      return { scope, categorised: everyone.size, roots };
    },

    createCategory({ scope, name, parentId = null, by = null, now = Date.now() }) {
      scopeOf(scope);
      const adult = scope === 'adult' ? 1 : 0;
      const clean = cleanName(name);
      let parent = null;
      if (parentId !== null && parentId !== undefined) {
        parent = catIn(scope, parentId);
        if (depthOf(parent) >= DEPTH_MAX) throw new LibraryError(`categories are at most ${DEPTH_MAX} levels deep`);
      }
      const norm = normName(clean);
      if (clash(parent && parent.id, adult, norm)) throw new LibraryError('a category with that name already exists here', 409);
      return tx(() => {
        const id = Number(st.catInsert.run(parent ? parent.id : null, clean, norm, adult, now, now).lastInsertRowid);
        log('category_create', { id, name: clean, parentId: parent ? parent.id : null, scope }, by, now);
        return st.cat.get(id);
      })();
    },

    renameCategory({ scope, id, name, by = null, now = Date.now() }) {
      const c = catIn(scope, id);
      const clean = cleanName(name);
      const norm = normName(clean);
      if (clash(c.parent_id, c.adult, norm, c.id)) throw new LibraryError('a category with that name already exists here', 409);
      return tx(() => {
        st.catUpdate.run(c.parent_id, clean, norm, now, c.id);
        log('category_rename', { id: c.id, from: c.name, to: clean }, by, now);
        return st.cat.get(c.id);
      })();
    },

    // parentId null moves to the top level.
    moveCategory({ scope, id, parentId = null, by = null, now = Date.now() }) {
      const c = catIn(scope, id);
      let parent = null;
      if (parentId !== null && parentId !== undefined) {
        parent = catIn(scope, parentId);
        if (descendants(scope, c.id).has(parent.id)) throw new LibraryError('a category cannot be moved into itself or its own subcategory');
        if (depthOf(parent) + heightOf(scope, c.id) > DEPTH_MAX) throw new LibraryError(`categories are at most ${DEPTH_MAX} levels deep`);
      }
      if (clash(parent && parent.id, c.adult, c.norm, c.id)) throw new LibraryError('a category with that name already exists there', 409);
      return tx(() => {
        st.catUpdate.run(parent ? parent.id : null, c.name, c.norm, now, c.id);
        log('category_move', { id: c.id, from: c.parent_id, to: parent ? parent.id : null }, by, now);
        return st.cat.get(c.id);
      })();
    },

    // Folds `sourceId` into `targetId`: its items and subcategories go to the
    // target and the emptied category row is removed. No item is touched.
    mergeCategories({ scope, sourceId, targetId, by = null, now = Date.now() }) {
      const src = catIn(scope, sourceId);
      const dst = catIn(scope, targetId);
      if (src.id === dst.id) throw new LibraryError('a category cannot be merged into itself');
      if (descendants(scope, src.id).has(dst.id)) throw new LibraryError('a category cannot be merged into its own subcategory');
      const moving = st.cats.all(src.adult).filter((c) => c.parent_id === src.id);
      for (const ch of moving) {
        if (clash(dst.id, dst.adult, ch.norm, ch.id)) throw new LibraryError(`"${ch.name}" already exists in "${dst.name}"; merge those first`, 409);
      }
      if (depthOf(dst) + Math.max(0, heightOf(scope, src.id) - 1) > DEPTH_MAX) throw new LibraryError(`categories are at most ${DEPTH_MAX} levels deep`);
      return tx(() => {
        const before = db.prepare('SELECT COUNT(*) AS n FROM item_categories WHERE category_id = ?').get(src.id).n;
        st.moveMembers.run(dst.id, now, by, src.id);
        st.dropMembers.run(src.id);
        st.catChildren.run(dst.id, now, src.id);
        st.catDelete.run(src.id);
        log('category_merge', { source: { id: src.id, name: src.name }, target: dst.id, items: before }, by, now);
        return st.cat.get(dst.id);
      })();
    },

    // Mass edit: add or remove categories on many items at once. An item of
    // another audience than the scope is skipped with a reason.
    assign({ scope, ids, categoryIds, remove = false, by = null, now = Date.now() }) {
      scopeOf(scope);
      const items = idList(ids);
      const cats = idList(categoryIds, 'categories').map((id) => catIn(scope, id));
      const changed = [];
      const skipped = [];
      tx(() => {
        for (const id of items) {
          const it = st.item.get(id);
          if (!it || it.audience !== scope) { skipped.push({ id, reason: 'no such item' }); continue; }
          let touched = 0;
          for (const c of cats) touched += (remove ? st.unlink.run(id, c.id) : st.link.run(id, c.id, now, by)).changes;
          if (touched) changed.push(id);
        }
        if (changed.length) log(remove ? 'unassign' : 'assign', { items: changed, categories: cats.map((c) => c.id) }, by, now);
      })();
      return { changed, skipped };
    },

    // Items that carry a tag (source or owner's) named like the category and
    // are not in it yet. Read-only: the owner decides, via assign().
    suggestForCategory({ scope, categoryId, limit = 100 }) {
      const c = catIn(scope, categoryId);
      const norm = sourceMeta.tagNorm(c.name);
      if (!norm) return { category: c.id, items: [] };
      const have = new Set(db.prepare('SELECT item_id FROM item_categories WHERE category_id = ?').all(c.id).map((r) => r.item_id));
      const byItem = new Map();
      for (const h of st.tagHits.all(norm)) {
        if (have.has(h.item_id)) continue;
        const it = st.item.get(h.item_id);
        if (!it || it.audience !== scope) continue;
        if (!byItem.has(h.item_id)) byItem.set(h.item_id, { id: h.item_id, origins: [] });
        byItem.get(h.item_id).origins.push(h.origin);
      }
      return { category: c.id, items: [...byItem.values()].slice(0, Math.max(1, Math.min(500, Number(limit) || 100))) };
    },

    // Categories (of this scope) named like one of the item's tags that the
    // item is not in yet.
    suggestForItem({ scope, itemId }) {
      scopeOf(scope);
      const it = st.item.get(Number(itemId));
      if (!it || it.audience !== scope) throw new LibraryError('no such item', 404);
      const norms = new Set(st.itemTags.all(it.id).map((r) => r.norm));
      const mine = new Set(db.prepare('SELECT category_id FROM item_categories WHERE item_id = ?').all(it.id).map((r) => r.category_id));
      return st.cats.all(scope === 'adult' ? 1 : 0)
        .filter((c) => !mine.has(c.id) && norms.has(sourceMeta.tagNorm(c.name)))
        .map((c) => ({ id: c.id, name: c.name }));
    },

    // ---- profile tree -------------------------------------------------------
    // One canonical creator per profile, listed under every platform it has an
    // account on, or under Unlinked when it has none. `store` is the profile
    // store; only profiles whose gate audience equals the scope are shown.
    profileTree(scope, store) {
      scopeOf(scope);
      const canon = canonicalMap(store);
      const perProfile = new Map();
      let noProfile = 0;
      for (const r of scopedRows(scope)) {
        const pid = r.profile_id ? canon.get(r.profile_id) : null;
        if (!pid) { noProfile++; continue; }
        perProfile.set(pid, (perProfile.get(pid) || 0) + 1);
      }
      const visible = ((store && store.profiles) || []).filter((p) => profilesLib.effectiveAudience(p) === scope);
      const groups = new Map();
      const put = (key, p) => {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      };
      for (const p of visible) {
        const entry = {
          id: p.id,
          name: p.name,
          count: perProfile.get(p.id) || 0,
          accounts: (p.accounts || []).map((a) => ({ platform: a.platform, handle: a.handle })),
        };
        const platforms = [...new Set(entry.accounts.map((a) => a.platform))];
        if (!platforms.length) put('unlinked', entry);
        else platforms.forEach((pl) => put(pl, entry));
      }
      const children = [...groups.entries()]
        .sort((a, b) => (a[0] === 'unlinked') - (b[0] === 'unlinked') || a[0].localeCompare(b[0]))
        .map(([key, list]) => ({
          id: `profiles:${key}`,
          label: key === 'unlinked' ? 'Unlinked' : slugLabel(key),
          count: list.reduce((n, p) => n + p.count, 0),
          profiles: list.sort((a, b) => a.name.localeCompare(b.name)),
        }));
      return {
        scope,
        id: 'profiles',
        label: 'Profiles',
        count: visible.length,
        withoutProfile: noProfile,
        children,
      };
    },
  };
  return api;
}

module.exports = { attach, LibraryError, classifyFormat, siteSlug, placement, canonicalMap, SCOPES };
