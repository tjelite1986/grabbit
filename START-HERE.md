# START HERE

Quickstart for a new developer (human or AI). Read this page first; it points
to the rest. Rules that must never be broken live in `CLAUDE.md` (always loaded
for Claude sessions). This file is documentation only and changes no behaviour.

Facts below were checked against commit `73547d3`. Line numbers drift, so
search by symbol name.

## What Grabbit is

One Node.js (Express) process, `server.js`, serving a vanilla-JS front end.
Downloads run in child processes (yt-dlp, gallery-dl, ffmpeg, python/mutagen).
State is JSON and SQLite files in `DATA_DIR`. Media lives in mounted folders.
TikShortis and Elitogram are separate apps reached through gateways.

## Minimal commands

```bash
npm ci                                   # needs network; skip in offline sandboxes
npm start                                # node server.js, port 3000, data in ./data
node --test test/                        # whole suite (npm test)
node --test test/smart-routing.test.js   # one focused file
```

Without `DATA_DIR` the server uses `./data` and `./downloads` (both gitignored).
Never point a test at a real data directory. See `documentation/runtime.md`
for Node versions and `documentation/storage-map.md` for what is in `DATA_DIR`.

## Entry points

| What | Where |
|------|-------|
| Server, routes, job engine | `server.js` (about 10k lines; never read whole, see `documentation/claude-workflow.md`) |
| Hub (start page, `/`) | `public/hub/index.html`, `hub.js`, `hub.css`, plus `dupes/`, `social/`, `tik/` |
| Classic UI (`/classic/`) | `public/index.html` (about 5k lines, vanilla SPA) |
| Service worker, PWA manifest | `public/sw.js`, `public/manifest.webmanifest` |
| Site extractors | `extractors/index.js` (registry) and one file per site |
| Container | `Dockerfile` (the image decides the runtime) |

## Where to change what

See `documentation/feature-map.md` for the full table. Short version:

- New or broken site: `extractors/<site>.js`, registered in `extractors/index.js`.
- Where a download is saved (route/folder): `smart-routing.js` for decisions,
  `server.js` `smartRoute()` and the destination constants for folders.
- General vs 18+ decisions: `audience.js` (pure), called by `server.js` before
  every write into an app folder.
- Tags a source supplied: `source-meta.js`. Owner tags: `item-store.js`.
- Duplicate Manager: `dupe-*.js`, UI in `public/hub/dupes/`.
- State file safety: `writeJsonAtomic()`, `readJsonState()`, `STATE_FILES` in `server.js`.

## Routing terminology (do not mix these)

- **`smart-routing.js`**: pure functions. Decides the destination of a video
  being downloaded now (orientation, source class, 18+ override). Exports
  `decideRoute`, `suggestionForSites`, `SOURCE_CLASSES`, `REVIEW_FOLDER`.
- **`source-meta.js`**: what a source said about an item (site tags, categories,
  caption hashtags). Metadata only. It never decides a destination.
- **`routing.jsonl`**: the append-only log in `DATA_DIR` of each routing
  decision, written by `logRoutingDecision()` in `server.js`. A log, not
  configuration; rotated at 5 MB to `routing.jsonl.1`.
- **Routes (`route`)**: the outcome of `decideRoute` stored on the job.
- **Folders**: directories on disk (`VIDEOS_DIR`, `ADULTS_DIR`, `PHOTOS_DIR`,
  the `review` folder, app import folders). `GET /api/folders` lists them.
  Routing chooses a folder; it does not create audiences.
- **HTTP routes** (`app.get('/api/...')`) are unrelated to smart routing. Say
  "API route" for those.

## General vs 18+ safety

- Three audiences: general, adult, unknown. Unknown is never treated as general.
- Adult always wins over general. Review material is never imported by a
  general app.
- `audience.js` gives the verdict; `server.js` calls it read-only for routing
  (`audienceVerdict(..., { readOnly: true })`) and again at write time. Routing
  suggests, the gate decides. A routing change must never bypass the gate.
- Adult-site detection is `isAdultSite()` in `audience.js`.
- Tests: `test/audience*.test.js`, `test/adult-separation.test.js`,
  `test/smart-routing.test.js`. Run them after any routing or audience change.
- Keep examples and docs free of real domains, host paths and accounts.

## Retained entry paths

`/classic/` (the original UI, `public/index.html`), `/share` (PWA share
target, served by the same file) and the old `?tab=` / `?action=` deep links
are kept on purpose; installed apps and push notifications still use them.
`/` serves the hub and redirects old deep links to `/classic/`.

## Deployment boundaries

- Self-hosted Docker images behind a reverse proxy. A cloud or sandbox session
  has no host, live data, `.env` or container logs. Deliver a branch and say
  how to verify live; do not claim production works.
- Do not change the Dockerfile, CI, compose files or secrets as a side effect
  of a code or documentation task.
- `docs/` is local-only and gitignored. `documentation/` is tracked.

## Document index

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Invariants and lessons learned (authoritative rules) |
| `documentation/feature-map.md` | Feature to file map, tests |
| `documentation/storage-map.md` | `DATA_DIR` stores, owner, backup, rollback |
| `documentation/runtime.md` | Node version truth, tools, discrepancies |
| `documentation/claude-workflow.md` | Token-efficient working method |
| `documentation/architecture.md`, `configuration.md`, `installation.md`, `user-guide.md` | Product docs |
