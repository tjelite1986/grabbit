'use strict';
// Grabbit 3.0 native Adshortis: the permission matrix as data (plan part 11,
// H101). Pure module, no I/O.
//
// The phase-1 gateway (adshortis-gateway.js, mounted at /api/ads/*) takes its
// method + path allowlist from liveRoutes()/matchRoute() here and from nowhere
// else, so the rule below is enforced in one place and tested per phase:
//
//   A route is live only when its phase has started AND its row has no open
//   GAP. There is no per-row exception.
//
// A row is also held while its rule group is undecided (group null), while its
// path is unnamed, and while a deployment condition it needs is not met (for
// example the `tasks` group needs Adshortis A4 and A17 deployed). Conditions
// are passed in by the caller as a Set of the strings in CONDITIONS.
//
// Source: the planning matrix (permission matrix parts 1 and 2, rows S, M, D,
// A, J, T, X) with GAP status as amended by plan part 11. Grabbit-side rows
// (G1-G15) are not gateway routes and are not listed here.

const PHASES = ['0', '1', '2', '3', '4', '4b'];

function phaseIndex(phase) {
  const i = PHASES.indexOf(String(phase));
  if (i < 0) throw new Error(`Unknown phase: ${phase}`);
  return i;
}

// Deployment and decision conditions a row or group can wait on.
const CONDITIONS = {
  'adshortis:A2': 'Adshortis A2 deployed: an over-limit upload is a 413/422 upstream, never a 5xx',
  'adshortis:A4': 'Adshortis A4 deployed',
  'adshortis:A8': 'Adshortis A8 deployed',
  'adshortis:A12': 'Adshortis A12 deployed',
  'adshortis:A13': 'Adshortis A13 deployed',
  'adshortis:A15': 'Adshortis A15 deployed',
  'adshortis:A17': 'Adshortis A17 deployed (stored task area)',
  'grabbit:H10': 'every H10 row implemented',
  'owner:D13': 'owner decision D13 answered',
  'projection:no-error': 'the admin projection drops `error` (and import file names for non-import holders), H81/A16',
};

// Rule groups (H7): the phase a group is enabled from and what it waits on.
const GROUPS = {
  session: { phase: '1', requires: [] },
  member: { phase: '1', requires: [] },
  curate: { phase: '4', requires: [] },
  admin: { phase: '4', requires: [] },
  tasks: { phase: '4', requires: ['adshortis:A4', 'adshortis:A17'] },
  sources: {
    phase: '4b',
    requires: ['adshortis:A8', 'adshortis:A12', 'adshortis:A13', 'adshortis:A15', 'grabbit:H10', 'owner:D13'],
  },
};

// GAP list (matrix part 2 section 11). `open` blocks every row that names it;
// `held` blocks until its condition is met; `closed` blocks nothing.
const GAPS = {
  1: { status: 'closed', topic: 'NL status (S1): 409 login_id_missing, H101' },
  2: { status: 'closed', topic: 'Session fields (S1, S2): six-key allowlist, H101' },
  3: { status: 'open', topic: 'List field allowlist (M1, M2, M9, A19)' },
  4: { status: 'closed', topic: '`q` on GET is refused with 400 (M1, M13), H101' },
  5: { status: 'held', until: 'adshortis:A2', topic: 'Upload timing (M12)' },
  6: { status: 'open', topic: 'Prefs keys (M25, S2 prefs)' },
  7: { status: 'open', topic: 'Absolute URLs in creator detail (M15)' },
  8: { status: 'open', topic: 'Avatars without clip scope (D3, D4)' },
  9: { status: 'open', topic: 'Download (D5)' },
  10: { status: 'closed', topic: 'Eligibility mechanism for media (D1, D2), H93/H100' },
  11: { status: 'open', topic: 'Deleted preview: who may preview/restore (A13); partly closed by H93' },
  12: { status: 'open', topic: 'Owner edit group (A1, A3, A4)' },
  13: { status: 'open', topic: 'Write bodies (A1, A2, J2)' },
  14: { status: 'held', until: 'projection:no-error', topic: '`error` in admin lists (A5, A7, A10, A12, A14)' },
  15: { status: 'closed', topic: 'Job projection (J1): the J1 field list is adopted' },
  16: { status: 'open', topic: '`import` job (J2)' },
  17: { status: 'open', topic: 'Task id format (T2)' },
  18: { status: 'open', topic: '/api/creators/all (A20)' },
  19: { status: 'open', topic: 'Creator edit and create (X7, X8)' },
  20: { status: 'open', topic: 'Source listing fields (X2)' },
  21: { status: 'open', topic: 'Avatar upload group (A18)' },
  22: { status: 'open', topic: 'Analysis group (A19)' },
  23: { status: 'open', topic: 'Comments on deleted clips (M5)' },
};

// Job names the gateway may run or stop (J2, J3), cumulative by phase.
// `import` is in no list (GAP 16); `update_downloader` and `ai_describe` never.
const JOBS = {
  4: ['transcode', 'duplicate_scan', 'probe_audio', 'cleanup', 'db_backup', 'db_maintenance'],
  '4b': ['auto_poll', 'fetch_titles', 'backfill_captions', 'fetch_audio'],
};
const NEVER_JOBS = ['update_downloader', 'ai_describe', 'import'];

function jobsFor(phase) {
  const at = phaseIndex(phase);
  const out = [];
  for (const [p, names] of Object.entries(JOBS)) if (phaseIndex(p) <= at) out.push(...names);
  return out;
}

// S2: the only keys GET /api/ads/session passes. `prefs` joins in phase 3 once
// GAP 6 names the keys; `ai` and `nav_tabs` never pass.
const SESSION_FIELDS = ['id', 'username', 'display_name', 'role', 'permissions', 'avatar'];
const NEVER_SESSION_FIELDS = ['ai', 'nav_tabs'];

function sessionFields(phase) {
  const out = SESSION_FIELDS.slice();
  if (phaseIndex(phase) >= phaseIndex('3') && GAPS[6].status === 'closed') out.push('prefs');
  return out;
}

// S1 for a Grabbit session without the per-login id: answered by the gateway
// without calling upstream. Not 401, so the hub never reads it as a sign-out.
const NL_RESPONSE = Object.freeze({
  status: 409,
  body: Object.freeze({ ok: false, error: 'Sign in to Grabbit again', reason: 'login_id_missing' }),
});

// Path parameters. `:id` and `:clip` are the N control (numeric only, 404
// before upstream otherwise). `:name` is a job name, checked against jobsFor().
// `:task` has no pattern until GAP 17 decides one, so T2 never matches live.
const PARAMS = {
  id: '[0-9]{1,15}',
  clip: '[0-9]{1,15}',
  name: '[a-z_]{1,40}',
};

// [row, methods, path, group, phase, gaps, requires]
// path null: the route has no name yet (never live).
const R = (row, methods, path, group, phase, gaps = [], requires = []) =>
  ({ row, methods, path, group, phase, gaps, requires });

const ROWS = [
  // Session (part 1 section 2)
  R('S1', ['POST'], '/api/ads/session', 'session', '1', [1, 2]),
  R('S2', ['GET'], '/api/ads/session', 'session', '1', [2]),
  R('S3', ['DELETE'], '/api/ads/session', 'session', '1'),
  // Member (part 1 section 3; group on from phase 1, features in phase 3)
  R('M1', ['GET'], '/api/ads/clips', 'member', '3', [3, 4]),
  R('M2', ['POST'], '/api/ads/search', 'member', '3', [3]), // answers as M1
  R('M3', ['GET'], '/api/ads/clips/:id', 'member', '3'),
  R('M4', ['POST', 'DELETE'], '/api/ads/clips/:id/like', 'member', '3'),
  R('M5', ['GET'], '/api/ads/clips/:id/comments', 'member', '3', [23]),
  R('M6', ['POST'], '/api/ads/clips/:id/comments', 'member', '3'),
  R('M7', ['DELETE'], '/api/ads/comments/:id', 'member', '3'),
  R('M8', ['POST', 'DELETE'], '/api/ads/clips/:id/hide', 'member', '3'),
  R('M9', ['GET'], '/api/ads/hidden', 'member', '3', [3]),
  R('M10', ['POST'], '/api/ads/clips/:id/report', 'member', '3'),
  R('M11', ['GET'], '/api/ads/tags', 'member', '3'),
  R('M12', ['POST'], '/api/ads/upload', 'member', '3', [5]),
  R('M13', ['GET'], '/api/ads/creators', 'member', '3', [4]),
  R('M14', ['POST'], '/api/ads/creators/lookup', 'member', '3'),
  R('M15', ['GET'], '/api/ads/creators/:id', 'member', '3', [7]),
  R('M16', ['POST', 'DELETE'], '/api/ads/creators/:id/follow', 'member', '3'),
  R('M17', ['GET'], '/api/ads/persons/:id', 'member', '3'),
  R('M18', ['GET'], '/api/ads/playlists', 'member', '3'),
  R('M19', ['GET'], '/api/ads/playlists/:id', 'member', '3'),
  R('M20', ['POST'], '/api/ads/playlists', 'member', '3'),
  R('M21', ['PATCH', 'DELETE'], '/api/ads/playlists/:id', 'member', '3'),
  R('M22', ['POST'], '/api/ads/playlists/:id/items', 'member', '3'),
  R('M23', ['DELETE'], '/api/ads/playlists/:id/items/:clip', 'member', '3'),
  R('M24', ['GET'], '/api/ads/clips/:id/playlists', 'member', '3'),
  R('M25', ['PATCH'], '/api/ads/me/prefs', 'member', '3', [6]),
  // Media (part 1 section 4)
  R('D1', ['GET', 'HEAD'], '/api/ads/m/video/:id', 'member', '3', [10]),
  R('D2', ['GET', 'HEAD'], '/api/ads/m/poster/:id', 'member', '3', [10]),
  R('D3', ['GET'], '/api/ads/m/avatar/creator/:id', 'member', '3', [8]),
  R('D4', ['GET'], '/api/ads/m/avatar/user/:id', 'member', '3', [8]),
  R('D5', ['GET'], '/api/ads/m/download/:id', null, '3', [9]),
  // Curate and admin (part 2 section 5)
  R('A1', ['PATCH'], '/api/ads/clips/:id', 'curate', '4', [12, 13]),
  R('A2', ['POST'], '/api/ads/clips/bulk', 'curate', '4', [13]),
  R('A3', ['DELETE'], '/api/ads/clips/:id', null, '4', [12]),
  R('A4', ['POST'], '/api/ads/clips/:id/restore', null, '4', [12]),
  R('A5', ['GET'], '/api/ads/admin/reports', 'admin', '4', [14]),
  R('A6', ['POST'], '/api/ads/admin/reports/:id/resolve', 'admin', '4'),
  R('A7', ['GET'], '/api/ads/admin/import', 'admin', '4', [14]),
  R('A8', ['POST'], '/api/ads/admin/import/claim', 'admin', '4'),
  R('A9', ['POST'], '/api/ads/admin/clips/:id/retry', 'admin', '4'),
  R('A10', ['GET'], '/api/ads/admin/duplicates', 'admin', '4', [14]),
  R('A11', ['POST'], '/api/ads/admin/duplicates/:id', 'admin', '4'),
  R('A12', ['GET'], '/api/ads/admin/deleted', 'admin', '4', [14]),
  R('A13', ['GET', 'HEAD'], null, 'admin', '4', [11]),
  R('A14', ['GET'], '/api/ads/admin/titles', 'admin', '4', [14]),
  R('A15', ['POST'], '/api/ads/admin/merge', 'admin', '4'),
  R('A16', ['GET', 'POST'], '/api/ads/admin/persons', 'admin', '4'),
  R('A17', ['POST'], '/api/ads/admin/creators/:id/person', 'admin', '4'),
  R('A18', ['POST'], '/api/ads/creators/:id/avatar', null, '4', [21]),
  R('A19', ['GET'], '/api/ads/analysis', null, '4', [3, 22]),
  R('A20', ['GET'], '/api/ads/creators/all', null, '4', [18]),
  // Jobs (part 2 section 6)
  R('J1', ['GET'], '/api/ads/admin/jobs', 'admin', '4', [15]),
  R('J2', ['POST'], '/api/ads/admin/jobs/:name/run', 'admin', '4', [13, 16]),
  R('J3', ['POST'], '/api/ads/admin/jobs/:name/stop', 'admin', '4'),
  // Tasks (part 2 section 7)
  R('T1', ['GET'], '/api/ads/tasks', 'tasks', '4'),
  R('T2', ['GET'], '/api/ads/tasks/:task', 'tasks', '4', [17]),
  // Sources (part 2 section 8)
  R('X1', ['GET'], '/api/ads/admin/sources', 'sources', '4b'),
  R('X2', ['GET'], '/api/ads/creators/:id/source', 'sources', '4b', [20]),
  R('X3', ['POST'], '/api/ads/creators/:id/source/skip', 'sources', '4b'),
  R('X4', ['POST'], '/api/ads/creators/:id/source/fetch', 'sources', '4b'),
  R('X5', ['POST'], '/api/ads/creators/:id/poll', 'sources', '4b'),
  R('X6', ['GET'], '/api/ads/m/thumb', 'sources', '4b'),
  R('X7', ['PATCH'], '/api/ads/creators/:id', 'sources', '4b', [19]),
  R('X8', ['POST'], '/api/ads/creators', 'sources', '4b', [19]),
];

// Part 2 section 10: upstream routes that are never reachable natively, as the
// Grabbit path the default mapping would give them. No row may match these.
const NEVER = [
  ['POST', '/api/ads/login'],
  ['POST', '/api/ads/logout'],
  ['POST', '/api/ads/me/password'],
  ['GET', '/api/ads/admin/users'],
  ['POST', '/api/ads/admin/users'],
  ['PATCH', '/api/ads/admin/users/1'],
  ['DELETE', '/api/ads/admin/users/1'],
  ['POST', '/api/ads/admin/purge'],
  ['GET', '/api/ads/admin/settings'],
  ['PATCH', '/api/ads/admin/settings'],
  ['POST', '/api/ads/admin/analysis/1'],
  ['POST', '/api/ads/admin/grab/resolve'],
  ['POST', '/api/ads/admin/grab/fetch'],
  ['PATCH', '/api/ads/admin/jobs/transcode'],
  ['POST', '/api/ads/hooks/jobs/transcode/run'],
  ['GET', '/api/ads/healthz'],
  ['GET', '/api/ads/robots.txt'],
  ['GET', '/api/ads/version'],
  ['GET', '/api/ads/'],
  ['GET', '/api/ads/index.html'],
];

function compile(path) {
  if (!path) return null;
  const names = [];
  const src = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([a-z]+)/g, (_, n) => {
    names.push(n);
    return PARAMS[n] ? `(${PARAMS[n]})` : '(?!)'; // unknown parameter: never matches
  });
  return { re: new RegExp(`^${src}$`), names };
}

const COMPILED = ROWS.map((r) => ({ ...r, compiled: compile(r.path) }));

function gapBlocks(n, met) {
  const g = GAPS[n];
  if (!g) return true; // unknown GAP number: treat as open
  if (g.status === 'closed') return false;
  if (g.status === 'held') return !met.has(g.until);
  return true;
}

// Why a row is not live in `phase` with conditions `met`, or null if it is.
function holdReason(row, phase, met = new Set()) {
  const at = phaseIndex(phase);
  if (!row.path) return 'path not named';
  if (!row.group || !GROUPS[row.group]) return 'rule group undecided';
  const group = GROUPS[row.group];
  if (phaseIndex(group.phase) > at) return `group ${row.group} starts in phase ${group.phase}`;
  if (phaseIndex(row.phase) > at) return `row starts in phase ${row.phase}`;
  const gap = row.gaps.find((n) => gapBlocks(n, met));
  if (gap !== undefined) return `GAP ${gap} ${GAPS[gap] ? GAPS[gap].status : 'unknown'}`;
  const need = [...group.requires, ...row.requires].find((c) => !met.has(c));
  if (need) return `waits on ${need}`;
  return null;
}

// The gateway allowlist for `phase`: every live row, in matrix order.
function liveRoutes(phase, met = new Set()) {
  return ROWS.filter((r) => holdReason(r, phase, met) === null);
}

// The matrix row a request would hit, ignoring whether it is live.
function findRow(method, path) {
  const m = String(method).toUpperCase();
  for (const r of COMPILED) {
    if (!r.compiled || !r.methods.includes(m)) continue;
    const hit = r.compiled.re.exec(path);
    if (!hit) continue;
    const params = {};
    r.compiled.names.forEach((n, i) => { params[n] = hit[i + 1]; });
    return { row: r, params };
  }
  return null;
}

// The live row for a request in `phase`, or null (the gateway answers 404
// "Not available through Grabbit"). `path` is the pathname without query.
function matchRoute(method, path, phase, met = new Set()) {
  const hit = findRow(method, path);
  if (!hit || holdReason(hit.row, phase, met) !== null) return null;
  if (hit.params.name !== undefined && !jobsFor(phase).includes(hit.params.name)) return null;
  const { compiled, ...row } = hit.row;
  return { row, params: hit.params };
}

module.exports = {
  PHASES,
  CONDITIONS,
  GROUPS,
  GAPS,
  ROWS,
  NEVER,
  NEVER_JOBS,
  SESSION_FIELDS,
  NEVER_SESSION_FIELDS,
  NL_RESPONSE,
  jobsFor,
  sessionFields,
  holdReason,
  liveRoutes,
  findRow,
  matchRoute,
};
