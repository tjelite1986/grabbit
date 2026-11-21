# Open decisions (D1-D4)

Four pre-existing discrepancies found by the structure audit and re-checked
against the application code of commit `73547d3`. They are
**owner decisions, not fixes**: nothing here was changed. Line numbers drift,
so search by symbol.

| Ref | Area | Short question |
|-----|------|----------------|
| D1 | Registry recovery | Refuse to write a rebuilt registry over a damaged one? |
| D2 | Extractor fetches | Migrate extractors to `safeFetch()` or document the exception? |
| D3 | `route=smart` | Exclude the internal principal, or amend the spec? |
| D4 | Routing log | Record a history row for save-only early returns? |

## D1. Registry rebuilt from capped history after corruption

- `readJsonState()` (`server.js:647`) returns the same `fallback` for any read
  error (missing or unreadable, `server.js:649-653`) and for an unparseable
  file with no usable snapshot. It tries only the
  newest nonempty snapshot (`newestSnapshot()`, `server.js:627`); if that one
  does not parse it does not try an older day.
- `readDownloaded()` (`server.js:809`) treats that result as "nothing on disk",
  seeds the registry from `readHistory()` (history writes keep at most
  `HISTORY_MAX` = 200 rows, `server.js:513`, `:765-770`; the read itself does
  not cap) and writes it with `writeJsonAtomic()` (`server.js:606`).
- The quarantine rename in `readJsonState()` is best effort (empty `catch`,
  `server.js:~662`). If it fails, the damaged original is still in place and
  the seeded write replaces it. That is contrary to the `CLAUDE.md` rule "Never
  write a degraded reconstruction back over the original."
- Effect: a corrupt registry with no usable snapshot becomes a floor built
  from whatever `history.json` holds (normally at most 200 rows, because
  writes cap it; fewer entries when history rows lack a URL);
  older downloads look new and may re-download.
- Decision for the owner: distinguish "missing" from "unrecoverable" in
  `readJsonState()` and make `readDownloaded()` refuse to write (and fail
  loudly) in the unrecoverable case?

## D2. Extractors use plain `fetch`, not `safeFetch`

- Eight extractor files call `fetch(`: `erome` (`extractors/erome.js:34`),
  `imagefap` (`:116`), `nuditok` (`:25`), `onlytik` (`:20`), `reddclips`
  (`:38`), `redgifs` (`:48`), `tikporn` (`:18`), `xxxfollow` (`:19`). None
  calls `safeFetch`. Check: `rg -n "\bfetch\(" extractors/` and
  `rg -n "safeFetch" extractors/` (second command prints nothing).
- The submitted URL is checked by `assertPublicUrl()` in
  `extractors/index.js` (`:97`, `:111`), but redirect hops of these fetches are not re-checked
  the way `safeFetch()` in `url-guard.js` does.
- `CLAUDE.md` says direct fetches use `safeFetch()`.
- Decision for the owner: migrate the eight files, or document an exception?
  Any exception would need its own per-call review; some calls fetch page URLs
  without an explicit redirect mode (for example `extractors/erome.js:34`,
  `extractors/imagefap.js:116`).

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
- Save-only early returns in the job path skip `recordJobHistory()`
  (`server.js:7731`): an already imported or queued Shorts item
  (`server.js:8014-8023`, returning before the Shorts history call at
  `server.js:8041`) and an existing server-library file with no device copy
  (`server.js:8073-8074`; the device case at `:8076-8077` does record
  history). The log then shows a decision the history does not.
- Decision for the owner: treat as a separate fix job, and if so decide
  whether the history row should say "skipped (already present)".

## Other observations (not D1-D4)

| Ref | Observation | Decision needed |
|-----|-------------|-----------------|
| O1 | Node: `CLAUDE.md` and the Dockerfile disagreed. See `documentation/runtime.md`. | Decide when Node 20 support may end, and whether to add `engines`. |
| O3 | `package.json` has no `engines`; no CI workflow is tracked in this checkout. | Decide whether to pin. |
| O4 | `writeJsonAtomic()` fsyncs the file but not the parent directory after the rename (see `documentation/storage-map.md`). | Decide whether state writes must survive a power loss; that needs a code change. |

Resolved: O2 (the `README.md` test-file count) now matches `test/` (50 files).
