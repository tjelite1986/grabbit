# Test contracts (guard tests)

The `test/guard-*.test.js` files pin behaviour that must not change by
accident when `server.js` is refactored. They test through HTTP against a real
`server.js` process (or call small modules directly), so they keep working when
code moves between files. If one fails after a refactor, the refactor changed
behaviour: fix the code, or get the owner's decision before changing the test.

## Run

```bash
npm ci                                    # once, needs network
node --test test/                         # whole suite (npm test), about 1 minute
node --test test/guard-*.test.js          # guard tests only, about 25 seconds
node --test test/guard-http.test.js       # one area
```

Each command exits non-zero when a test fails. To keep the exit code while
shortening the output, see `documentation/claude-workflow.md` section 4.

What decides pass or fail is the exit code and the `# fail` line, not the
words `not ok` (a known gap prints `not ok ... # TODO`, see below).

| Command | Expected summary |
|---------|------------------|
| `node --test test/guard-*.test.js` | `tests 92`, `pass 92`, `fail 0`, `skipped 0`, `todo 0` |
| `node --test test/known-gaps.test.js` | `tests 5`, `pass 0`, `fail 0`, `todo 5` |
| `node --test test/` | `fail 0` and `todo 5`. `skipped` depends on the machine: 1 where `onnxruntime-node` is installed (the ONNX-missing test skips), 0 where it is not |

`todo` is not a failure. `skipped` is not a failure either.

## What each file protects

| File | Contract | Binding rule |
|------|----------|--------------|
| `guard-http.test.js` | Login cookie flags and `Location: /`; 401 JSON for `/api/*`, redirect for pages; internal secret exact match, ignored behind the proxy (`X-Forwarded-Host`) and when unset; cross-site refusal (`Sec-Fetch-Site`, `Origin`) before the session, also for unauthenticated callers; job start validation and response shape; cancel; 422 on failed synchronous saves and on `/api/resolve`; internal `device=0` JSON shapes (Shorts and server library); `/api/download-all` SSE framing (error and success); rules validation (`sanitizeRules`) over HTTP; `route=smart` access (D3 pinned) | `CLAUDE.md` "Contracts with callers and deployments", "Security" |
| `guard-ytdlp-args.test.js` | Extra yt-dlp args: accepted and refused tables, token and length caps, template validation, internal principal, real argv (extra args before `--`, URL last) for video, audio and cut jobs, `/api/download` ignores `xargs`, a text scan that the yt-dlp/gallery-dl spawn sites it recognises end with `--` and one operand | `CLAUDE.md` "Security" (allowlist only) |
| `guard-url.test.js` | Blocked and allowed address ranges (198.18.0.0/15 and mapped IPv4 deliberately allowed), schemes, encoded hosts, hostnames with mixed public and private DNS answers (stubbed DNS), `ALLOW_PRIVATE_ADDRESSES`, `safeFetch` redirect re-checks, extractor load filter, hostname-only `match()`, guard before any extractor, `--` in extractor argv, D2 list pinned (text scan, `test/helpers/fetch-scan.js`) | `CLAUDE.md` "Security" |
| `guard-storage.test.js` | Corrupt state file kept as `.corrupt-*` byte for byte, restore from the newest non-empty snapshot, D1 pinned, fresh-install seeding, registry write integrity, no temp leftovers, `/api/health` state rows | `CLAUDE.md` "Writing files safely" |
| `guard-jobs.test.js` | Job success and failure paths, failures never marked downloaded, retry queue with backoff, repeat saves skipped, `MAX_ACTIVE_JOBS` cap and FIFO (slots released one at a time), cancel of a queued job, routing log fields, D4 pinned, Shorts roots opt-in, `ELITE_ENABLED` fallback | `CLAUDE.md` "Downloads and extractors" |
| `guard-test-isolation.test.js` | Every test that boots `server.js` names its own `DATA_DIR`, `DOWNLOAD_DIR` and `YTDLP_BIN`, and does not spread `process.env`. A text check of the test sources, not proof of isolation | `CLAUDE.md` "Data safety" |
| `known-gaps.test.js` | Desired behaviour for D1-D4, marked `todo` | `documentation/open-decisions.md` |

## Isolation

`test/helpers/guard-server.js` boots the server for these tests:

- one `mkdtemp` directory per boot for `DATA_DIR`, `DOWNLOAD_DIR`, the app
  roots, `TMPDIR` and `HOME`, removed after the test once the server process
  has exited;
- an environment built from scratch: `PATH` from the parent, the variables
  `boot()` sets, and the test's own overrides. Nothing else leaks in from the
  shell or a real install;
- the server listens on `127.0.0.1` only, on a port the OS picks
  (`test/fixtures/loopback-listen.js`, preloaded with `node -r`; production
  code still binds `0.0.0.0`);
- `yt-dlp`, `gallery-dl`, `ffmpeg`, `ffprobe` and `python3` are `/bin/false`,
  or a local fake yt-dlp that records its argv and never downloads;
- the owner login is checked at boot: if it fails, the test fails with the
  status and the server log instead of a stream of 401s;
- with `media: true`, extractors are replaced by
  `test/fixtures/fake-extractors.js` and files come from a loopback server in
  the test process. A media boot also sets `ALLOW_PRIVATE_ADDRESSES=true` so
  the server may fetch from `127.0.0.1`: **the URL guard is off in a media
  boot**. The URL guard tests never use `media`. Hosts are `example.com`
  (never fetched), TEST-NET literals such as `192.0.2.10` (no DNS lookup) or
  `fake.test`.

No test needs a password, token or account from a real install; the values in
the tests are dummies.

## Known gaps (`todo`)

`test/known-gaps.test.js` holds one test per open decision. Each asserts the
protection we would want. The current behaviour is pinned by an ordinary test
in the matching guard file, labelled "D<n> (current behaviour)".

A gap test reports one of three ways (real output, shortened):

```text
not ok 4 - KNOWN GAP D3: route=smart is refused for the internal principal (owner web UI only) # TODO D3 open owner decision
ok 4 - KNOWN GAP D3: route=smart is refused for the internal principal (owner web UI only) # TODO GAP CLOSED: D3 now behaves as desired; remove this test (see documentation/test-contracts.md)
not ok 4 - KNOWN GAP D3: route=smart is refused for the internal principal (owner web UI only)
  error: 'HARNESS: precondition failed: an ordinary internal job start returned 401: ...'
```

1. `not ok ... # TODO <Dn> open owner decision`: the gap is open. An
   assertion failed; the run still exits 0.
2. `ok ... # TODO GAP CLOSED`: the desired behaviour now holds. Exit 0, but
   act on it (see below).
3. `not ok` with no `# TODO` and an error starting `HARNESS:`: the setup broke
   (server did not start, a precondition failed, an error that is not an
   assertion). This is a real failure and the run exits 1. A broken harness
   never passes for an open gap.

Quick check that all five gaps are open, for a handoff or CI:

```bash
node --test test/known-gaps.test.js 2>&1 | grep -c '^not ok .*# TODO D[0-9] open owner decision'   # must print 5
# as a gate (exit 1 unless exactly five gaps are open):
test "$(node --test test/known-gaps.test.js 2>&1 | grep -c '^not ok .*# TODO D[0-9] open owner decision')" = 5
```

When the owner decides:

- **fix it:** the gap test reports `GAP CLOSED`. Delete it (or move its
  assertions into the guard file as an ordinary test) and delete the "current
  behaviour" test it replaces.
- **keep it:** delete the gap test and keep the "current behaviour" test.

## Documented exceptions and residual gaps

- **Origin check (current behaviour, pinned in `guard-http.test.js`):**
  `Origin: null` is let through, and the Origin is compared by host only, so
  scheme and default port are not checked. This is narrower than the wording
  "any Origin that doesn't match" in `CLAUDE.md`; left for the owner.
- **Text scans:** the `--` checks over spawn sites and the D2 plain-`fetch()`
  scan read source text. They catch the usual shapes, not every possible one
  (for example a name built at run time). The D2 pin is per file: a new
  plain `fetch()` inside one of the eight listed extractors is not flagged.
  The runtime argv checks cover yt-dlp for video, audio, cut and the
  synchronous route; gallery-dl and profile resolution are covered only by
  the text scan. Review still matters.
- **Loopback only:** every test that boots `server.js` preloads
  `test/fixtures/loopback-listen.js`; `guard-test-isolation.test.js` fails a
  new one that does not.
- **Not verified by these tests:** the UI sinks `cssUrl()` and `safeHref()` in
  `public/index.html` (no browser test here); a server-level redirect through
  a real extractor fetch path with the guard on (the hop logic is covered by
  the `safeFetch` unit tests, and D2 lists the extractors that bypass it).

## Adding a guard test

1. Find the contract in `CLAUDE.md` or the code (`rg -n`), not by guessing.
2. Use `boot(t, { ... })` from `test/helpers/guard-server.js`; seed state with
   `seed(dataDir)`.
3. Assert exact status codes and bodies. A bare `status === 400` can pass for
   the wrong reason; match the error text too.
4. Prove the test can fail: break the code locally (one line), run the test,
   see it fail, revert.
