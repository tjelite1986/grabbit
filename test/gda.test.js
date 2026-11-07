'use strict';
// Unit tests for gda.js: target mapping, registry validation, the scope matrix
// (every client x every target), sessions and tokens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gda = require('../gda');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gda-test-'));
const silent = { error() {} };
const newRegistry = (name) =>
  gda.createRegistry({ file: path.join(tmp, `${name}.json`), sessionSecret: 'test-secret', log: silent });

test('legacy dest/channel/folder map to the target Grabbit already uses', () => {
  const t = gda.targetForLegacy;
  assert.equal(t({ dest: 'elite', channel: 'main' }), 'legacy.tikshortis');
  assert.equal(t({ dest: 'elite', channel: '18plus' }), 'adshortis.inbox');
  assert.equal(t({ dest: 'server' }), 'server.downloads');
  assert.equal(t({ dest: 'server', folder: 'videos' }), 'server.downloads');
  assert.equal(t({ dest: 'server', folder: 'adults' }), 'library.adults');
  // server.js sanitizes the folder name the same way before using it.
  assert.equal(t({ dest: 'server', folder: 'Adults' }), 'library.adults');
  assert.equal(t({ dest: 'server', folder: 'adults!' }), 'library.adults');
  assert.equal(t({ dest: 'server', folder: ' .adults. ' }), 'library.adults');
  assert.equal(t({ dest: 'navidrome' }), 'library.music');
  assert.equal(t({ dest: 'audiobooks' }), 'library.audiobooks');
});

test('every target maps back to itself', () => {
  for (const [id, target] of Object.entries(gda.TARGETS)) {
    assert.equal(gda.targetForLegacy(target.legacy), id, id);
  }
});

test('a general client cannot be given an adult target, nor the reverse', () => {
  const base = { client_id: 'x1', allowed_ops: ['job'] };
  assert.match(
    gda.validateClient({ ...base, audience: 'general', allowed_targets: ['adshortis.inbox'] }).join(),
    /adult, client is general/,
  );
  assert.match(
    gda.validateClient({ ...base, audience: 'adult', allowed_targets: ['legacy.tikshortis'] }).join(),
    /general, client is adult/,
  );
  assert.match(gda.validateClient({ ...base, audience: 'admin', allowed_targets: ['legacy.tikshortis'] }).join(), /audience/);
  assert.match(gda.validateClient({ ...base, client_id: 'legacy-shared', audience: 'general', allowed_targets: ['legacy.tikshortis'] }).join(), /reserved/);
  assert.deepEqual(gda.validateClient({ ...base, audience: 'general', allowed_targets: ['legacy.tikshortis'] }), []);
});

test('a hand-edited registry entry that breaks the audience rule is not loaded', () => {
  const file = path.join(tmp, 'bad.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      clients: [
        { client_id: 'sneaky', audience: 'general', allowed_targets: ['library.adults'], allowed_ops: ['job'] },
        { client_id: 'fine', audience: 'general', allowed_targets: ['legacy.tikshortis'], allowed_ops: ['job'] },
      ],
    }),
  );
  const errors = [];
  const r = gda.createRegistry({ file, sessionSecret: 's', log: { error: (m) => errors.push(m) } });
  assert.deepEqual(r.load().map((c) => c.client_id), ['fine']);
  assert.match(errors.join(), /sneaky refused/);
});

test('an unreadable registry loads no clients', () => {
  const file = path.join(tmp, 'broken.json');
  fs.writeFileSync(file, '{not json');
  const r = gda.createRegistry({ file, sessionSecret: 's', log: silent });
  assert.deepEqual(r.load(), []);
});

// The scope matrix from the security plan (rev4.2 §4.1), as deployed in step 4.
const MATRIX = {
  elitebook: { audience: 'general', targets: ['legacy.tikshortis'] },
  elitetok: { audience: 'general', targets: ['legacy.tikshortis'] },
  'grabbit-send': {
    audience: 'general',
    targets: ['legacy.tikshortis', 'server.downloads', 'library.music', 'library.audiobooks'],
  },
  elitegifs: { audience: 'adult', targets: ['adshortis.inbox'] },
};

test('scope matrix: every client x every target', () => {
  const r = newRegistry('matrix');
  for (const [id, m] of Object.entries(MATRIX)) {
    r.upsertClient({ client_id: id, audience: m.audience, allowed_targets: m.targets, allowed_ops: ['job', 'status'] });
  }
  for (const [id, m] of Object.entries(MATRIX)) {
    const who = gda.principalFor(r.byId(id), 'password');
    for (const target of Object.keys(gda.TARGETS)) {
      const allowed = m.targets.includes(target);
      if (allowed) assert.doesNotThrow(() => gda.authorize(who, target, 'job'), `${id} -> ${target}`);
      else
        assert.throws(
          () => gda.authorize(who, target, 'job'),
          (e) => e.code === 'forbidden_target' && e.status === 403,
          `${id} -> ${target}`,
        );
    }
  }
  // The shared password and internal callers keep today's full access.
  for (const target of Object.keys(gda.TARGETS)) {
    assert.doesNotThrow(() => gda.authorize(gda.LEGACY_SHARED, target, 'job'));
    assert.doesNotThrow(() => gda.authorize(gda.INTERNAL, target, 'job'));
  }
});

test('the audience check holds even if the in-memory client lists a foreign target', () => {
  const forged = { client_id: 'f', audience: 'general', allowed_targets: ['adshortis.inbox'], allowed_ops: ['job'] };
  assert.throws(() => gda.authorize(gda.principalFor(forged, 'password'), 'adshortis.inbox', 'job'), /may not save/);
});

test('ops are enforced', () => {
  const c = { client_id: 'o', audience: 'general', allowed_targets: ['legacy.tikshortis'], allowed_ops: ['status'] };
  assert.throws(() => gda.authorize(gda.principalFor(c, 'password'), 'legacy.tikshortis', 'job'), (e) => e.code === 'forbidden_op');
  assert.throws(() => gda.authorize(gda.LEGACY_SHARED, 'nope', 'job'), (e) => e.code === 'unknown_target');
});

test('passwords pick the client; a new password ends old sessions; revoke ends all', () => {
  const r = newRegistry('pw');
  r.upsertClient({ client_id: 'app-a', audience: 'general', allowed_targets: ['legacy.tikshortis'], allowed_ops: ['job'] });
  r.upsertClient({ client_id: 'app-b', audience: 'adult', allowed_targets: ['adshortis.inbox'], allowed_ops: ['job'] });
  const pa = r.setPassword('app-a');
  const pb = r.setPassword('app-b');
  assert.notEqual(pa, pb);
  assert.equal(r.clientForPassword(pa).client_id, 'app-a');
  assert.equal(r.clientForPassword(pb).client_id, 'app-b');
  assert.equal(r.clientForPassword('wrong'), null);

  const session = r.sessionValue(r.byId('app-a'));
  assert.equal(r.clientForSession(session).client_id, 'app-a');
  // Tampering with the id or the MAC fails.
  assert.equal(r.clientForSession(session.replace('app-a', 'app-b')), null);
  assert.equal(r.clientForSession(session.slice(0, -1) + (session.endsWith('0') ? '1' : '0')), null);

  r.setPassword('app-a');
  assert.equal(r.clientForSession(session), null, 'old session survives a password change');
  assert.equal(r.clientForPassword(pa), null, 'old password still works');

  const s2 = r.sessionValue(r.byId('app-b'));
  r.revokeClient('app-b');
  assert.equal(r.clientForSession(s2), null);
  assert.equal(r.clientForPassword(pb), null);
});

test('sessions from another server secret are refused', () => {
  const file = path.join(tmp, 'secret.json');
  const a = gda.createRegistry({ file, sessionSecret: 'one', log: silent });
  a.upsertClient({ client_id: 'app', audience: 'general', allowed_targets: ['legacy.tikshortis'], allowed_ops: ['job'] });
  a.setPassword('app');
  const b = gda.createRegistry({ file, sessionSecret: 'two', log: silent });
  assert.equal(b.clientForSession(a.sessionValue(a.byId('app'))), null);
});

test('tokens: stored hashed, revocable one by one', () => {
  const r = newRegistry('tok');
  r.upsertClient({ client_id: 'tok-app', audience: 'general', allowed_targets: ['legacy.tikshortis'], allowed_ops: ['job'] });
  const t1 = r.issueToken('tok-app');
  const t2 = r.issueToken('tok-app');
  assert.match(t1.token, /^gda_tok-app_[A-Za-z0-9_-]{32}$/);
  const onDisk = fs.readFileSync(path.join(tmp, 'tok.json'), 'utf8');
  assert.ok(!onDisk.includes(t1.token) && !onDisk.includes(t1.token.split('_').pop()), 'token stored in clear');
  assert.equal(r.clientForToken(t1.token).client.client_id, 'tok-app');
  r.revokeToken('tok-app', t1.id);
  assert.deepEqual(r.clientForToken(t1.token), { revoked: true });
  assert.equal(r.clientForToken(t2.token).client.client_id, 'tok-app');
  assert.equal(r.clientForToken('gda_tok-app_' + 'A'.repeat(32)), null);
  assert.equal(r.clientForToken('garbage'), null);
});

test('upsert refuses an invalid client and leaves the file as it was', () => {
  const r = newRegistry('upsert');
  r.upsertClient({ client_id: 'ok', audience: 'general', allowed_targets: ['legacy.tikshortis'], allowed_ops: ['job'] });
  const before = fs.readFileSync(path.join(tmp, 'upsert.json'), 'utf8');
  assert.throws(() => r.upsertClient({ client_id: 'ok', audience: 'general', allowed_targets: ['library.adults'], allowed_ops: ['job'] }));
  assert.equal(fs.readFileSync(path.join(tmp, 'upsert.json'), 'utf8'), before);
});

test('v1 status mapping', () => {
  assert.equal(gda.v1Status({ status: 'scheduled' }), 'queued');
  assert.equal(gda.v1Status({ status: 'queued' }), 'queued');
  assert.equal(gda.v1Status({ status: 'running' }), 'fetching');
  assert.equal(gda.v1Status({ status: 'done', saved: true }), 'stored');
  assert.equal(gda.v1Status({ status: 'done', saved: false }), 'delivered');
  assert.equal(gda.v1Status({ status: 'error' }), 'failed');
  assert.equal(gda.v1Status({ status: 'cancelled' }), 'cancelled');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
