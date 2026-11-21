# Grabbit Structure Phase 2 - Slice 1 report

Base: ade60e06d1fe6f85e22fcc23d460ccf7cdcec6fd (verified present in the runner repo; tree equals Phase 1 2f03b73).
HEAD: uncommitted working tree on mecloud/j6651b51dce0e425f; the runner commits. No merge, push, pull, rebase or deploy was done.
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
Independent Codex and Hermes reviews were NOT performed: this job has no access to those reviewers. Verdicts are therefore
pending; the project lead needs to request them on the actual diff (small: one new file plus one require line and a deletion).

## Remaining risks
- Minor: function declarations became const bindings (TDZ only matters if used before the require line; none are).
- Review gate unmet until Codex/Hermes verdicts are recorded.

## Next recommended slice
The pure parse/format helpers (parseQuality, parseAudioQuality, parseContainer, parseSponsor, sponsorArgs, parseSections,
audioMime, videoMime, parseAt; server.js ~343-495). Treat parseExtraArgs / ALLOWED_ARGS separately (security allowlist) with
guard-ytdlp-args as the gate. Do not start automatically; wait for Boss review.
