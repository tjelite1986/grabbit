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
node --test test/guard-*.test.js          # guard tests only, about 20 seconds
node --test test/guard-http.test.js       # one area
```

Each command exits non-zero when a test fails. To keep the exit code while
shortening the output, see `documentation/claude-workflow.md` section 4.

Expected summary for the whole suite: `fail 0`, `skipped 1` (the ONNX test
skips when `onnxruntime-node` is installed) and `todo 5` (the known gaps
below). `todo` is not a failure.

## What each file protects

| File | Contract | Binding rule |
|------|----------|--------------|
| `guard-http.test.js` | Login cookie flags; 401 JSON for `/api/*`, redirect for pages; internal secret exact match, ignored behind the proxy (`X-Forwarded-Host`) and when unset; cross-site refusal (`Sec-Fetch-Site`, `Origin`) before the session; job start validation and response shape; cancel; 422 on failed synchronous saves; `route=smart` access (D3 pinned) | `CLAUDE.md` "Contracts with callers and deployments" |
| `guard-ytdlp-args.test.js` | Extra yt-dlp args: accepted and refused tables, token and length caps, template validation, internal principal, real argv (extra args before `--`, URL last) for video, audio and cut jobs, `/api/download` ignores `xargs`, every yt-dlp/gallery-dl spawn ends with `--` and one operand | `CLAUDE.md` "Security" (allowlist only) |
| `guard-url.test.js` | Blocked and allowed address ranges (198.18.0.0/15 and mapped IPv4 deliberately allowed), schemes, encoded hosts, `ALLOW_PRIVATE_ADDRESSES`, `safeFetch` redirect re-checks, extractor load filter, hostname-only `match()`, guard before any extractor, `--` in extractor argv, D2 list pinned | `CLAUDE.md` "Security" |
| `guard-storage.test.js` | Corrupt state file kept as `.corrupt-*` byte for byte, restore from the newest non-empty snapshot, D1 pinned, fresh-install seeding, registry write integrity, no temp leftovers, `/api/health` state rows | `CLAUDE.md` "Writing files safely" |
| `guard-jobs.test.js` | Job success and failure paths, failures never marked downloaded, retry queue with backoff, repeat saves skipped, `MAX_ACTIVE_JOBS` cap and FIFO, cancel of a queued job, routing log fields, D4 pinned, Shorts roots opt-in, `ELITE_ENABLED` fallback | `CLAUDE.md` "Downloads and extractors" |
| `guard-test-isolation.test.js` | Every test that boots `server.js` sets its own `DATA_DIR`, `DOWNLOAD_DIR` and fake `YTDLP_BIN`, and does not inherit the parent environment | `CLAUDE.md` "Data safety" |
| `known-gaps.test.js` | Desired behaviour for D1-D4, marked `todo` | `documentation/open-decisions.md` |

## Isolation

`test/helpers/guard-server.js` boots the server for these tests:

- one `mkdtemp` directory per boot for `DATA_DIR`, `DOWNLOAD_DIR` and the app
  roots, removed after the test;
- an environment built from scratch (`PATH` only), so nothing leaks in from the
  shell or a real install;
- `yt-dlp`, `gallery-dl`, `ffmpeg` and `ffprobe` are `/bin/false`, or a local
  fake yt-dlp that records its argv and never downloads;
- with `media: true`, extractors are replaced by
  `test/fixtures/fake-extractors.js` and files come from a loopback server in
  the test process. Hosts are `example.com` (never fetched), TEST-NET literals
  such as `192.0.2.10` (no DNS lookup) or `fake.test`.

No test needs a password, token or account from a real install; the values in
the tests are dummies.

## Known gaps (`todo`)

`test/known-gaps.test.js` holds one test per open decision. Each asserts the
protection we would want and fails today, so `node:test` reports it as
`# TODO` and the run still exits 0. The current behaviour is pinned by an
ordinary test in the matching guard file, labelled "D<n> (current behaviour)".

When the owner decides:

- **fix it:** the `todo` test starts passing. Remove its `todo` option and
  delete the "current behaviour" test it replaces.
- **keep it:** delete the `todo` test and keep the "current behaviour" test.

## Adding a guard test

1. Find the contract in `CLAUDE.md` or the code (`rg -n`), not by guessing.
2. Use `boot(t, { ... })` from `test/helpers/guard-server.js`; seed state with
   `seed(dataDir)`.
3. Assert exact status codes and bodies. A bare `status === 400` can pass for
   the wrong reason; match the error text too.
4. Prove the test can fail: break the code locally (one line), run the test,
   see it fail, revert.
