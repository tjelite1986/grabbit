'use strict';
// Dedicated tests for the extra yt-dlp argument allowlist (ALLOWED_ARGS and
// parseExtraArgs in server.js). Binding rule, CLAUDE.md "Security": allowlist
// of long flags with an arity check only; short flags, unknown flags and stray
// positionals return 400; never switch to a denylist (one was bypassed by
// -P/tmp, --exec and --ppa).
//
// parseExtraArgs is not exported, so everything goes through HTTP:
//  - GET /api/jobs/start?xargs=... with `at` a year ahead stores the parsed
//    list in scheduled.json without running anything;
//  - POST /api/templates/save validates the same way;
//  - one immediate job runs against a fake yt-dlp that records its argv, to
//    prove accepted flags reach yt-dlp before the `--` that guards the URL.
// A change to ALLOWED_ARGS must update the ACCEPTED table below on purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, FUTURE } = require('./helpers/guard-server');

// Public literal from TEST-NET-1: passes the URL guard without a DNS lookup,
// and nothing is ever fetched from it (yt-dlp is a local fake).
const URL_ = 'https://192.0.2.10/watch/1';

const ACCEPTED = [
  ['', []],
  ['   ', []],
  ['--write-subs --sub-langs en', ['--write-subs', '--sub-langs', 'en']],
  ['--format=bv*+ba/b', ['--format=bv*+ba/b']],
  ['--referer "https://example.com/a b"', ['--referer', 'https://example.com/a b']],
  ["--user-agent 'Agent X/1.0'", ['--user-agent', 'Agent X/1.0']],
  ['--limit-rate 2M --retries 3 --embed-metadata', ['--limit-rate', '2M', '--retries', '3', '--embed-metadata']],
  ['--sponsorblock-remove sponsor,intro', ['--sponsorblock-remove', 'sponsor,intro']],
  ['--extractor-args "youtube:player_client=web"', ['--extractor-args', 'youtube:player_client=web']],
  // A value-taking flag consumes the next token whatever it looks like, and
  // yt-dlp (optparse) does the same, so this is --format with the value
  // "--exec": no second flag reaches yt-dlp.
  ['--format --exec', ['--format', '--exec']],
];

const REFUSED = [
  // [input, message pattern]
  ['-P/tmp', /"-P\/tmp" is not allowed/],
  ['-o /tmp/x', /"-o" is not allowed/],
  ['-f best', /"-f" is not allowed/],
  ['--exec "touch /tmp/pwned"', /"--exec" is not allowed/],
  ['--exec=touch', /"--exec" is not allowed/],
  ['--ppa "ffmpeg:-i /etc/passwd"', /"--ppa" is not allowed/],
  ['--use-postprocessor Exec', /"--use-postprocessor" is not allowed/],
  ['--output /tmp/x', /"--output" is not allowed/],
  ['--paths /tmp', /"--paths" is not allowed/],
  ['--config-locations /tmp/c', /"--config-locations" is not allowed/],
  ['--batch-file /etc/passwd', /"--batch-file" is not allowed/],
  ['--load-info-json /tmp/i.json', /"--load-info-json" is not allowed/],
  ['--cookies /tmp/c.txt', /"--cookies" is not allowed/],
  ['--FORMAT best', /"--FORMAT" is not allowed/],
  ['https://evil.example/other', /"https:\/\/evil.example\/other" is not allowed/],
  ['--write-subs https://evil.example/other', /is not allowed/],
  ['-- https://evil.example/other', /"--" is not allowed/],
  ['--format', /--format needs a value/],
  ['--embed-subs=yes', /--embed-subs does not take a value/],
  // 42 tokens in 252 characters: the token cap (40) fires.
  ['--retries 1 '.repeat(21), /Too many extra arguments/],
  // Input is cut at 500 characters before parsing; a flag cut in half is
  // then unknown and refused (fail closed), never passed on truncated.
  ['--embed-subs '.repeat(41), /"--embe" is not allowed/],
];

const scheduled = (s) => {
  try {
    return s.readJson('scheduled.json');
  } catch {
    return [];
  }
};
const startQ = (xargs, extra = {}) =>
  new URLSearchParams({ url: URL_, dest: 'server', channel: 'main', device: '0', at: String(FUTURE()), xargs, ...extra });

test('extra yt-dlp args: allowlist contract', async (t) => {
  const s = await boot(t, { ytdlp: 'record' });

  await t.test('accepted flags are stored exactly as parsed', async () => {
    for (const [input, expected] of ACCEPTED) {
      const r = await s.call(`/api/jobs/start?${startQ(input)}`);
      assert.equal(r.status, 200, `${input}: ${r.text}`);
      const job = scheduled(s).find((x) => x.id === r.body.jobId);
      assert.deepEqual(job.params.extraArgs, expected, input);
    }
  });

  await t.test('refused input is 400 with a reason, and nothing is scheduled', async () => {
    const before = scheduled(s).length;
    for (const [input, pattern] of REFUSED) {
      const r = await s.call(`/api/jobs/start?${startQ(input)}`);
      assert.equal(r.status, 400, input);
      assert.equal(r.body.ok, false, input);
      assert.match(r.body.error, pattern, input);
    }
    assert.equal(scheduled(s).length, before);
  });

  await t.test('templates/save validates with the same allowlist and keeps refused input off disk', async () => {
    const file = path.join(s.dataDir, 'templates.json');
    for (const [input] of REFUSED) {
      const r = await s.call(`/api/templates/save?${new URLSearchParams({ name: 'bad', args: input })}`, { method: 'POST' });
      // An all-whitespace or empty args string is "missing", the rest are refusals.
      assert.equal(r.status, 400, input);
      assert.equal(r.body.ok, false);
    }
    assert.equal(fs.existsSync(file), false, 'a refused template must not be written');
    const ok = await s.call(`/api/templates/save?${new URLSearchParams({ name: 'subs', args: '--write-subs --sub-langs en' })}`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((x) => [x.name, x.args]), [['subs', '--write-subs --sub-langs en']]);
    const list = await s.call('/api/templates');
    assert.deepEqual(list.body.templates.map((x) => x.args), ['--write-subs --sub-langs en']);
  });

  await t.test('the internal principal keeps xargs (it is an owner-level caller)', async () => {
    const r = await s.call(`/api/jobs/start?${startQ('--embed-subs')}`, { headers: s.internal });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(scheduled(s).find((x) => x.id === r.body.jobId).params.extraArgs, ['--embed-subs']);
  });

  await t.test('the internal principal is refused the same disallowed flags', async () => {
    const r = await s.call(`/api/jobs/start?${startQ('--exec id')}`, { headers: s.internal });
    assert.equal(r.status, 400);
  });
});

test('extra yt-dlp args reach yt-dlp before the `--` separator; the synchronous route ignores them', async (t) => {
  const s = await boot(t, { ytdlp: 'record' });
  s.yt.setInfo({
    id: 'guard1',
    title: 'Guard clip',
    extractor: 'generic',
    extractor_key: 'Generic',
    webpage_url: URL_,
    ext: 'mp4',
    duration: 5,
    width: 1920,
    height: 1080,
  });
  const downloads = () => s.yt.calls().filter((a) => !a.includes('-j') && !a.includes('--list-extractors') && !a.includes('--flat-playlist'));

  await t.test('background job: accepted extra args are in argv, before `--`, and the URL is last', async () => {
    const q = { url: URL_, dest: 'server', xargs: '--write-subs --sub-langs "en,sv"' };
    const { started, job } = await s.runJob(q);
    assert.equal(started.status, 200, started.text);
    // The fake yt-dlp refuses every download, so the job ends as failed.
    assert.ok(['failed', 'error'].includes(job.status), JSON.stringify(job));
    const calls = downloads();
    assert.ok(calls.length >= 1, `no download call recorded: ${JSON.stringify(s.yt.calls())}\n${s.logs()}`);
    for (const argv of calls) {
      const sep = argv.indexOf('--');
      assert.equal(sep, argv.length - 2, JSON.stringify(argv));
      assert.equal(argv[argv.length - 1], URL_);
      const at = argv.indexOf('--write-subs');
      assert.ok(at >= 0 && at < sep, JSON.stringify(argv));
      assert.deepEqual(argv.slice(argv.indexOf('--sub-langs'), argv.indexOf('--sub-langs') + 2), ['--sub-langs', 'en,sv']);
    }
    // The metadata probe never carries the user's extra args.
    for (const argv of s.yt.calls().filter((a) => a.includes('-j'))) {
      assert.ok(!argv.includes('--write-subs'), JSON.stringify(argv));
      assert.equal(argv[argv.length - 2], '--');
    }
  });

  await t.test('synchronous /api/download takes no xargs at all', async () => {
    const before = downloads().length;
    const q = new URLSearchParams({ url: URL_, dest: 'server', device: '0', xargs: '--exec "touch /tmp/x" --write-subs' });
    const r = await s.call(`/api/download?${q}`);
    assert.equal(r.status, 422, r.text);
    const calls = downloads().slice(before);
    assert.ok(calls.length >= 1, 'the synchronous route should have reached the (fake) download step');
    for (const argv of calls) {
      assert.ok(!argv.includes('--exec') && !argv.includes('--write-subs'), JSON.stringify(argv));
      assert.equal(argv[argv.length - 2], '--');
      assert.equal(argv[argv.length - 1], URL_);
    }
  });
});
