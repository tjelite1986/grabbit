# Grabbit Structure Phase 2 - Slice 1 report

Base: ade60e06d1fe6f85e22fcc23d460ccf7cdcec6fd (verified present in the runner repo; tree equals Phase 1 2f03b73).
Code HEAD: 11da224fc116e3d20bfc58d5383926be3794a3c5 on mecloud/j6651b51dce0e425f (round 1, committed by the runner; contains all code changes).
Round 2 changes only this report (the runner commits it; its hash is not known at writing time). No code changed in round 2. No merge, push, pull, rebase or deploy was done.
Other worktrees (grabbit-wt*, j4830f47053b04bc5) were listed only and not touched.

## Selection
Extracted the file-name sanitizers `clampBytes`, `safeCreator`, `safeTitle`, `safeMusicPart` from server.js into `name-safety.js`.
Why: pure string functions, no I/O, no state, no module dependencies (only the global Buffer), contiguous in server.js, not on the
download/auth/SSE/yt-dlp paths. They are the dedup-key spelling, so exact behaviour matters; text was moved verbatim.

## Dependency graph
- name-safety.js: requires nothing. Exports { clampBytes, safeCreator, safeTitle, safeMusicPart }.
- server.js: requires ./name-safety (placed right after ./safe-copy, with the other local requires, before any use).
- Callers inside server.js (musicLibraryTarget, audiobookDir, audiobookFileName, importer/drop naming, etc.) are unchanged.
- No cycle: name-safety.js does not import server.js.
- Function declarations were hoisted before; they are now `const` bindings from a require at the top of the file. All uses
  are inside functions or later top-level code, after line ~39, so startup order is unaffected.

## Files
- added: name-safety.js, reports/grabbit/structure-phase2/slice1-report.md
- modified: server.js (-65 lines, +1 require line)
- No test files changed.

## Verification
- Round 2 re-run (Node v20.20.2): `node --test test/guard-*.test.js` -> tests 92, pass 92, fail 0, skipped 0, todo 0.
  `npm test` (= node --test test/) -> tests 820, pass 814, fail 0, skipped 1, todo 5. No differences from baseline.
- Diff base..11da224 touches only name-safety.js (new), server.js (4 functions removed, 1 require added) and this report.
- Every line removed from server.js is present verbatim in name-safety.js (diff check, no unmatched lines).
- node --test test/guard-*.test.js: 92 tests, 92 pass.
- npm test on Node v20.20.2: 820 tests, 814 pass, 0 fail, 1 skip, 5 TODO (identical to baseline; known-gaps D1-D4 TODOs untouched,
  known-gaps.test.js runs as part of npm test).
- Behaviour before/after: identical by construction (verbatim move); HTTP status/body/headers, auth, SSE, SSRF, job/storage
  semantics untouched; /api/download and /api/download-all not touched.

## Pre-existing limitations (not modified)
- npm test is not compatible with Node 22.
- ffmpeg image failures exist at baseline.

## Reviews
Reviewed commit: 11da224. Verdicts below are as relayed in the round 1 review feedback (2026-11-21); this job has no direct
access to the reviewers and did not observe the review output itself.
- Codex (independent, automatic): PASS. One minor finding: this report was stale (described the work as uncommitted and reviews as
  unavailable). Resolved in round 2 by this rewrite.
- Hermes (independent): PASS.
Round 2 only edits this report; automatic Codex and Hermes re-review of the final round commit is requested from the runner/project lead.

## Remaining risks
- Minor: function declarations became const bindings (TDZ only matters if used before the require line; none are).
- Runner test recognition: the runner configuration cannot be changed from inside this job. package.json already has
  "test": "node --test test/" (unchanged). Whether the runner recognises it as the test command is UNPROVEN from here; the logs
  below are from running it manually.

## Next recommended slice
The pure parse/format helpers (parseQuality, parseAudioQuality, parseContainer, parseSponsor, sponsorArgs, parseSections,
audioMime, videoMime, parseAt; server.js ~343-495). Treat parseExtraArgs / ALLOWED_ARGS separately (security allowlist) with
guard-ytdlp-args as the gate. Do not start automatically; wait for Boss review.
