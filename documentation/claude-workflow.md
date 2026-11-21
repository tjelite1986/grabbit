# Claude workflow: cheap, bounded, verifiable

Goal: find the right code with the fewest tokens, change little, prove it.
`server.js` is about 10k lines and `public/index.html` about 5k. Reading either
whole costs tens of thousands of tokens and is never needed.

## 1. Orient

1. Read `START-HERE.md` (short), then the row you need in
   `documentation/feature-map.md`.
2. Read the `CLAUDE.md` section that matches the area. Its rules are binding.

## 2. Search first (rg-first)

```bash
rg -n "functionName|constName" server.js          # locate
rg -n "app\.(get|post)\('/api/jobs" server.js     # routes
rg -l "symbol" --glob '!node_modules' .            # which files
```

Then read a bounded window around the hit: 40 to 120 lines (Read with `offset`
and `limit`, or `sed -n 'A,Bp'`). Widen only if the window ends mid-function.
Never read `server.js` or `public/index.html` in full. Small modules
(`smart-routing.js`, `audience.js`, `source-meta.js`) are fine to read whole.

## 3. Change

- Minimal diff. Do not reformat untouched code (`prettier --check` before any
  `--write` on an old file).
- English in every file. Examples use `example.com` and `/path/to/...`.
- No secrets, no `docs/` in git.

## 4. Test, focused, keep the exit code

Run the test file for the area (see the feature map), not the whole suite
first:

```bash
node --test test/smart-routing.test.js; echo "exit=$?"
```

Do not pipe the runner into `tail`/`head` without preserving its status. A
pipe reports the last command's code and can hide a failure. Use one of:

```bash
node --test test/x.test.js > "$TMPDIR/t.log" 2>&1; rc=$?; tail -15 "$TMPDIR/t.log"; echo "exit=$rc"
set -o pipefail; node --test test/x.test.js 2>&1 | tail -15
```

Run the full suite (`node --test test/`) once before handoff when the change
touches shared code. Report failures verbatim, and say which tests were not run.

## 5. Short handoff

Four lines is enough: what changed (paths), why, test result with exit code,
open risks. Do not paste diffs or file contents the reviewer can read.

## 6. Cost and token measurement protocol

Savings are claimed only from captured usage, never estimated.

1. Pick a fixed task (for example "add a field to smart-routing and its test").
2. Run it twice from a clean session, once with the old workflow and once
   with this one, same model and settings.
3. Record per run: input tokens, output tokens, cache read/write tokens, tool
   call count, files read, and wall time. Take them from the session's usage
   report (`/cost` or the job's usage record), not from a guess.
4. Repeat at least 3 times per arm; report the median and the range.
5. Always-loaded context is measured separately: bytes of `CLAUDE.md` (and
   `START-HERE.md` if loaded) at the base and new commit. Bytes are exact;
   tokens are about bytes/4 for English and are only an estimate.

Until step 3 has been done, write "not measured".
