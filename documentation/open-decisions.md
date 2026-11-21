# Open decisions (D1-D4)

Four pre-existing discrepancies found by the structure audit and re-checked at
this commit (base `73547d3` plus the Phase 0 documentation commits). They are
**owner decisions, not fixes**: nothing here was changed. Line numbers drift,
so search by symbol.

| Ref | Area | Short question |
|-----|------|----------------|
| D1 | Registry recovery | Refuse to write a rebuilt registry over a damaged one? |
| D2 | Extractor fetches | Migrate extractors to `safeFetch()` or document the exception? |
| D3 | `route=smart` | Exclude the internal principal, or amend the spec? |
| D4 | Routing log | Record a history row for save-only early returns? |

## D1. Registry rebuilt from capped history after corruption

- `readJsonState()` (`server.js:647`) returns the same `fallback` for a missing
  file and for an unparseable file with no usable snapshot. It tries only the
  newest nonempty snapshot (`newestSnapshot()`, `server.js:626`); if that one
  does not parse it does not try an older day.
- `readDownloaded()` (`server.js:809`) treats that result as "nothing on disk",
  seeds the registry from `readHistory()` (at most `HISTORY_MAX` = 200 rows,
  `server.js:513`) and writes it with `writeJsonAtomic()` (`server.js:606`).
- The quarantine rename in `readJsonState()` is best effort (empty `catch`,
  `server.js:~662`). If it fails, the damaged original is still in place and
  the seeded write replaces it. That is contrary to the `CLAUDE.md` rule "Never
  write a degraded reconstruction back over the original."
- Effect: a corrupt registry with no usable snapshot becomes a 200-row floor;
  older downloads look new and may re-download.
- Decision for the owner: distinguish "missing" from "unrecoverable" in
  `readJsonState()` and make `readDownloaded()` refuse to write (and fail
  loudly) in the unrecoverable case?

## D2. Extractors use plain `fetch`, not `safeFetch`

- Eight extractor files call `fetch(`: `erome`, `imagefap`, `nuditok`,
  `onlytik`, `reddclips`, `redgifs`, `tikporn`, `xxxfollow`. None calls
  `safeFetch`. Check: `rg -n "\bfetch\(" extractors/` and
  `rg -n "safeFetch" extractors/` (second command prints nothing).
- The submitted URL is checked by `assertPublicUrl()` in
  `extractors/index.js`, but redirect hops of these fetches are not re-checked
  the way `safeFetch()` in `url-guard.js` does.
- `CLAUDE.md` says direct fetches use `safeFetch()`.
- Decision for the owner: migrate the eight files, or document the exception
  (for example "fixed API hosts, redirects not followed")?

## D3. `route=smart` admits the internal principal

- The opt-in check is `who.audience !== 'admin'` (`server.js:8615`).
  `gda.INTERNAL` has `audience: 'admin'` (`gda.js:418`) and `principalOf()`
  returns it for a valid internal header (`server.js:1421-1423`).
- So a co-hosted caller presenting `X-Grabbit-Token` can request smart routing
  on `/api/jobs/start`. The spec says "owner web UI jobs" only. The
  synchronous `/api/download*` endpoints are unaffected.
- Decision for the owner: also require `who.kind !== 'internal'`, or amend the
  spec to allow internal callers?

## D4. Smart Routing decision without a history row

- `smartRoute()` logs the decision to `routing.jsonl` before dispatch
  (`logRoutingDecision()` call at `server.js:~7882`, invoked from `server.js:~7935`).
- Save-only early returns (for example "already imported", `server.js:~7351`;
  an already imported or queued Shorts item; an existing server file) skip
  `recordJobHistory()` (`server.js:7731`). The log then shows a decision the
  history does not.
- Decision for the owner: treat as a separate fix job, and if so decide
  whether the history row should say "skipped (already present)".

## Other observations (not D1-D4)

| Ref | Observation | Decision needed |
|-----|-------------|-----------------|
| O1 | Node: `CLAUDE.md` and the Dockerfile disagreed. See `documentation/runtime.md`. | Decide when Node 20 support may end, and whether to add `engines`. |
| O2 | `README.md` says 49 test files; `test/` has 50 files plus `fixtures/`. | Update the count or drop the number. |
| O3 | `package.json` has no `engines`; no CI workflow is tracked in this checkout. | Decide whether to pin. |
