'use strict';
// H101: a GAP row is never live. The Adshortis gateway allowlist is
// enumerated phase by phase from ads-route-matrix.js; a row with an open GAP,
// an undecided group, an unnamed path or an unmet condition must never be in
// it, and nothing from the never-reachable list may match any row.
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../ads-route-matrix');

const ids = (rows) => rows.map((r) => r.row);
const ALL_CONDITIONS = new Set(Object.keys(m.CONDITIONS));

test('the matrix has 66 gateway rows with unique ids, known groups and known GAPs', () => {
  assert.equal(m.ROWS.length, 66);
  assert.equal(new Set(ids(m.ROWS)).size, m.ROWS.length);
  for (const r of m.ROWS) {
    assert.ok(m.PHASES.includes(r.phase), `${r.row} phase`);
    assert.ok(r.group === null || m.GROUPS[r.group], `${r.row} group`);
    for (const n of r.gaps) assert.ok(m.GAPS[n], `${r.row} names unknown GAP ${n}`);
    for (const c of r.requires) assert.ok(m.CONDITIONS[c], `${r.row} names unknown condition ${c}`);
    if (r.path) assert.match(r.path, /^\/api\/ads\//, `${r.row} path`);
  }
  for (const [n, g] of Object.entries(m.GAPS)) {
    assert.ok(['open', 'held', 'closed'].includes(g.status), `GAP ${n} status`);
    if (g.status === 'held') assert.ok(m.CONDITIONS[g.until], `GAP ${n} held on unknown condition`);
  }
  for (const g of Object.values(m.GROUPS)) for (const c of g.requires) assert.ok(m.CONDITIONS[c]);
});

test('no row with an open GAP is live in any phase, whatever is deployed', () => {
  for (const phase of m.PHASES) {
    for (const met of [new Set(), ALL_CONDITIONS]) {
      for (const r of m.liveRoutes(phase, met)) {
        for (const n of r.gaps) {
          const g = m.GAPS[n];
          assert.notEqual(g.status, 'open', `phase ${phase}: ${r.row} live with open GAP ${n}`);
          if (g.status === 'held') assert.ok(met.has(g.until), `phase ${phase}: ${r.row} live with held GAP ${n}`);
        }
        assert.ok(r.path, `${r.row} live without a path`);
        assert.ok(r.group, `${r.row} live without a group`);
        assert.ok(m.PHASES.indexOf(r.phase) <= m.PHASES.indexOf(phase), `${r.row} live before its phase`);
      }
    }
  }
});

test('the allowlist per phase', () => {
  assert.deepEqual(ids(m.liveRoutes('0')), []);
  assert.deepEqual(ids(m.liveRoutes('1')), ['S1', 'S2', 'S3']);
  assert.deepEqual(ids(m.liveRoutes('2')), ['S1', 'S2', 'S3']);

  const p3 = ids(m.liveRoutes('3'));
  assert.deepEqual(p3, [
    'S1', 'S2', 'S3',
    'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M13', 'M14',
    'M15', 'M16', 'M17', 'M18', 'M19', 'M20', 'M21', 'M22', 'M23', 'M24', 'M25', 'D3',
  ]);
  // E1: with both phase-3 conditions met, exactly the phase-3 live set.
  assert.deepEqual(ids(m.liveRoutes('3', new Set(['adshortis:A2', 'adshortis:A18']))), [
    'S1', 'S2', 'S3',
    'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M14',
    'M15', 'M16', 'M17', 'M18', 'M19', 'M20', 'M21', 'M22', 'M23', 'M24', 'M25', 'D1', 'D2', 'D3',
  ]);
  // H100 (Codex phase-0 MAJOR): ordinary media stays off until A18 is
  // deployed and checked, also in phase 3.
  for (const r of ['D1', 'D2']) assert.ok(!p3.includes(r), r);
  assert.equal(m.matchRoute('GET', '/api/ads/m/video/12', '3'), null);
  assert.equal(m.matchRoute('HEAD', '/api/ads/m/poster/12', '3'), null);
  assert.match(m.holdReason(m.ROWS.find((r) => r.row === 'D1'), '3'), /waits on adshortis:A18/);
  const p3a18 = ids(m.liveRoutes('3', new Set(['adshortis:A18'])));
  assert.ok(p3a18.includes('D1') && p3a18.includes('D2'));
  // Held: user avatars (GAP 8, owner Q4), download (GAP 9); upload waits on
  // A2 (GAP 5). GAPs 3, 6, 7 and 23 closed in phase 3.
  for (const r of ['M12', 'D4', 'D5']) assert.ok(!p3.includes(r), r);
  assert.ok(ids(m.liveRoutes('3', new Set(['adshortis:A2']))).includes('M12'));

  const p4 = ids(m.liveRoutes('4'));
  for (const r of ['A6', 'A8', 'A9', 'A11', 'A15', 'A16', 'A17', 'J1', 'J3']) assert.ok(p4.includes(r), r);
  for (const r of ['A1', 'A2', 'A3', 'A4', 'A5', 'A7', 'A10', 'A12', 'A13', 'A14', 'A18', 'A19', 'A20', 'J2', 'T1', 'T2']) {
    assert.ok(!p4.includes(r), r);
  }
  const p4met = ids(m.liveRoutes('4', ALL_CONDITIONS));
  for (const r of ['A5', 'A7', 'A10', 'A12', 'A14', 'T1']) assert.ok(p4met.includes(r), r);
  for (const r of ['T2', 'J2', 'A13']) assert.ok(!p4met.includes(r), r);
  // The sources group is phase 4b and waits on its own deployments.
  for (const r of p4met) assert.ok(!r.startsWith('X'), r);

  const p4b = ids(m.liveRoutes('4b'));
  for (const r of p4b) assert.ok(!r.startsWith('X'), `${r} without the sources conditions`);
  const p4bmet = ids(m.liveRoutes('4b', ALL_CONDITIONS));
  assert.deepEqual(p4bmet.filter((r) => r.startsWith('X')), ['X1', 'X3', 'X4', 'X5', 'X6']);
});

test('holdReason names why a row is not live', () => {
  const row = (id) => m.ROWS.find((r) => r.row === id);
  assert.equal(m.holdReason(row('S1'), '0'), 'group session starts in phase 1');
  assert.equal(m.holdReason(row('S1'), '1'), null);
  assert.equal(m.holdReason(row('M3'), '1'), 'row starts in phase 3');
  assert.equal(m.holdReason(row('M1'), '3'), null);
  assert.equal(m.holdReason(row('D4'), '3'), 'GAP 8 open');
  assert.equal(m.holdReason(row('D5'), '3'), 'rule group undecided');
  assert.equal(m.holdReason(row('M12'), '3'), 'GAP 5 held');
  assert.equal(m.holdReason(row('A3'), '4'), 'rule group undecided');
  assert.equal(m.holdReason(row('A13'), '4'), 'path not named');
  assert.equal(m.holdReason(row('T1'), '4'), 'waits on adshortis:A4');
});

test('matchRoute: method, numeric ids and the job name allowlist', () => {
  assert.equal(m.matchRoute('POST', '/api/ads/session', '0'), null);
  assert.equal(m.matchRoute('POST', '/api/ads/session', '1').row.row, 'S1');
  assert.equal(m.matchRoute('get', '/api/ads/session', '1').row.row, 'S2');
  assert.equal(m.matchRoute('PUT', '/api/ads/session', '1'), null);
  assert.equal(m.matchRoute('GET', '/api/ads/clips/12', '1'), null);

  const hit = m.matchRoute('GET', '/api/ads/clips/12', '3');
  assert.equal(hit.row.row, 'M3');
  assert.deepEqual(hit.params, { id: '12' });
  assert.equal(hit.row.compiled, undefined);
  for (const bad of ['/api/ads/clips/12a', '/api/ads/clips/-1', '/api/ads/clips/%31', '/api/ads/clips/1/', '/api/ads/clips/']) {
    assert.equal(m.matchRoute('GET', bad, '3'), null, bad);
  }
  assert.equal(m.matchRoute('DELETE', '/api/ads/playlists/3/items/9', '3').row.row, 'M23');
  assert.equal(m.matchRoute('GET', '/api/ads/creators/all', '4', ALL_CONDITIONS), null);

  assert.equal(m.matchRoute('POST', '/api/ads/admin/jobs/transcode/stop', '4').row.row, 'J3');
  assert.equal(m.matchRoute('POST', '/api/ads/admin/jobs/auto_poll/stop', '4'), null);
  assert.equal(m.matchRoute('POST', '/api/ads/admin/jobs/auto_poll/stop', '4b').row.row, 'J3');
  for (const name of m.NEVER_JOBS) {
    for (const phase of m.PHASES) {
      assert.equal(m.matchRoute('POST', `/api/ads/admin/jobs/${name}/stop`, phase, ALL_CONDITIONS), null, name);
    }
    assert.ok(!m.jobsFor('4b').includes(name), name);
  }
});

test('nothing on the never-reachable list matches any row', () => {
  for (const [method, path] of m.NEVER) assert.equal(m.findRow(method, path), null, `${method} ${path}`);
});

test('S1 and S2 contracts (H101)', () => {
  assert.equal(m.NL_RESPONSE.status, 409);
  assert.deepEqual(m.NL_RESPONSE.body, { ok: false, error: 'Sign in to Grabbit again', reason: 'login_id_missing' });
  assert.ok(Object.isFrozen(m.NL_RESPONSE) && Object.isFrozen(m.NL_RESPONSE.body));
  assert.deepEqual(m.SESSION_FIELDS, ['id', 'username', 'display_name', 'role', 'permissions', 'avatar']);
  for (const phase of m.PHASES) {
    const f = m.sessionFields(phase);
    for (const k of m.NEVER_SESSION_FIELDS) assert.ok(!f.includes(k), `${k} in phase ${phase}`);
    // prefs joins in phase 3 (GAP 6 closed), never before.
    assert.deepEqual(f, m.PHASES.indexOf(phase) >= m.PHASES.indexOf('3') ? [...m.SESSION_FIELDS, 'prefs'] : m.SESSION_FIELDS, phase);
  }
});

// Codex phase-0 MAJOR on H101: the S1 and S2 contracts run as code. The
// fake upstream counts calls; the NL answer never reaches it.
test('S1 NL answer and S2 projection run as code, with no upstream call for NL', () => {
  let calls = 0;
  const upstream = () => {
    calls++;
    return { id: 7, username: 'ada', display_name: 'Ada', role: 'member', permissions: ['x'], avatar: null, prefs: { a: 1 }, ai: { k: 1 }, nav_tabs: ['x'], extra: 'no' };
  };
  // What the phase-1 gateway does for a session request.
  const gateway = (method, path, loginId, phase = '1') => {
    const nl = m.sessionPreflight(method, path, loginId);
    if (nl) return nl;
    if (!m.matchRoute(method, path, phase)) return { status: 404 };
    return { status: 200, body: method === 'GET' ? m.projectSession(upstream(), phase) : { ok: true } };
  };
  for (const id of [undefined, null, '', '   ', 42]) {
    assert.deepEqual(gateway('POST', '/api/ads/session', id), m.NL_RESPONSE);
  }
  assert.equal(calls, 0, 'no upstream call for an NL caller');
  assert.equal(m.sessionPreflight('GET', '/api/ads/session', ''), null, 'only S1 answers NL');
  assert.equal(m.sessionPreflight('POST', '/api/ads/session', 'login-1'), null);
  const s2 = gateway('GET', '/api/ads/session', 'login-1');
  assert.deepEqual(Object.keys(s2.body), m.SESSION_FIELDS, 'exactly the six keys, in order');
  assert.equal(calls, 1);
  for (const phase of m.PHASES) {
    const out = m.projectSession(upstream(), phase);
    for (const k of m.NEVER_SESSION_FIELDS) assert.ok(!(k in out), `${k} in phase ${phase}`);
    assert.ok(!('extra' in out));
  }
  assert.deepEqual(m.projectSession({ id: 1 }, '1'), { id: 1, username: null, display_name: null, role: null, permissions: null, avatar: null });
  for (const bad of [null, 'x', [], 3]) assert.equal(m.projectSession(bad, '1'), null);
  // What only the gateway can prove is named for phase 1.
  assert.ok(m.PHASE1_GATEWAY_TESTS.length >= 7);
  for (const topic of ['S1 NL', 'principal', 'origin', 'seal', 'S2', 'S3', 'S5']) {
    assert.ok(m.PHASE1_GATEWAY_TESTS.some((t) => t.includes(topic)), topic);
  }
});

test('ADSHORTIS_CONDITIONS: only A2 and A18, never assumed met', () => {
  assert.deepEqual([...m.parseConditions(undefined).met], []);
  assert.deepEqual([...m.parseConditions('').met], []);
  const r = m.parseConditions(' A2, adshortis:a18 ,A4,owner:D13,, x ');
  assert.deepEqual([...r.met].sort(), ['adshortis:A18', 'adshortis:A2']);
  assert.deepEqual(r.unknown, ['A4', 'owner:D13', 'x']);
  // A4 and the other phase-4 conditions can never be set this way.
  for (const c of Object.keys(m.CONDITIONS)) {
    if (!['adshortis:A2', 'adshortis:A18'].includes(c)) assert.ok(!m.parseConditions(c).met.has(c), c);
  }
});

test('S2 prefs (GAP 6): exactly PREFS_FIELDS with their types; nav and unknown keys dropped', () => {
  const me = {
    id: 7, username: 'a', display_name: 'A', role: 'user', permissions: [], avatar: null, ai: true, nav_tabs: ['x'],
    prefs: { sound: true, autoplay: 'yes', nav: ['feed'], grid_columns: 3, feed: 'evil', feed_pos: { 'foryou|': 12, bad: 'x', ['k'.repeat(201)]: 3 }, extra: 1 },
  };
  const out = m.projectSession(me, '3');
  assert.deepEqual(Object.keys(out), [...m.SESSION_FIELDS, 'prefs']);
  assert.deepEqual(out.prefs, { sound: true, autoplay: null, grid_columns: 3, feed: null, feed_pos: { 'foryou|': 12 } });
  assert.equal(m.projectSession({ ...me, prefs: 'x' }, '3').prefs, null);
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(m.projectPrefs({ feed_pos: many }).feed_pos).length, m.FEED_POS_MAX);
  assert.equal('prefs' in m.projectSession(me, '1'), false);
});
