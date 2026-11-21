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
node --test test/smart-routing.test.js   # one focused file
node --test test/                        # whole suite (npm test)
```

Run the app locally with a password you know and disposable storage (never a
real `DATA_DIR`). Bash only (`read -s`). Run `npm ci` first; downloads also
need yt-dlp and ffmpeg on `PATH` (see "Running without Docker" in
[`documentation/installation.md`](documentation/installation.md#running-without-docker)).

```bash
(
  set +x   # never trace: the password would be printed
  set -eu
  npm ci
  read -rsp 'Choose a Grabbit password: ' pw; echo
  [ -n "$pw" ] || { echo 'Empty password, not starting.' >&2; exit 1; }
  scratch="$(mktemp -d)"
  mkdir -p "$scratch/data" "$scratch/downloads"
  echo "Disposable data in $scratch (deleting it deletes everything in it)"
  # Drop every inherited variable (destination overrides, *_ROOT import roots,
  # GRABBIT_AUTH_DISABLED, ...) except PATH and HOME.
  for v in $(compgen -e); do
    case "$v" in PATH|HOME) ;; *) unset "$v";; esac   # a failed unset stops it
  done
  export GRABBIT_PASSWORD="$pw" PORT=3000 \
    DATA_DIR="$scratch/data" DOWNLOAD_DIR="$scratch/downloads"
  exec npm start
)
```

Any failed step stops the subshell before the server starts. Sign in at
`http://localhost:3000` with the password you typed. With every override
cleared, all server folders (`videos`, `mp3`, `adults`, `photos`, music and
audiobooks) default to children of `DOWNLOAD_DIR`, and the Shorts, posts and
import channels stay off.

Bare `npm start` with no password exits ("refusing to start an ungated
service"), unless auth is explicitly disabled. **Never disable auth as a
workaround**: the listener binds all interfaces (`0.0.0.0:3000`), so anyone
on the network can reach it; on a shared network block port 3000 with a
firewall (see the same installation section). Use the password start above, as in the local
install section of
[`documentation/installation.md`](documentation/installation.md), with an
explicit disposable `DATA_DIR` and `DOWNLOAD_DIR`. The cookie store defaults to
`/data/cookies` unless `DATA_DIR` is set; see that guide. See
`documentation/runtime.md` for Node versions (production runs Node 22; code
must also build and run on Node 20) and
`documentation/storage-map.md` for what is in `DATA_DIR`.

## Entry points

| What | Where |
|------|-------|
| Server, routes, job engine | `server.js` (about 10k lines; never read whole, see `documentation/claude-workflow.md`) |
| Hub (start page, `/`) | `public/hub/index.html`, `public/hub/hub.js` (browser), `public/hub/hub.css`, plus `public/hub/dupes/`, `social/`, `tik/`. Root `hub.js` is server-side (dashboard counts), not the browser file |
| Classic UI (`/classic/`) | `public/index.html` (about 5k lines, vanilla SPA) |
| Service worker, PWA manifest | `public/sw.js`, `public/manifest.webmanifest` |
| Site extractors | `extractors/index.js` (auto-loads every `.js` file in `extractors/` except `index.js`, `generic.js`, `util.js`) and one file per site |
| Container | `Dockerfile` (the image decides the runtime) |

## Where to change what

See `documentation/feature-map.md` for the full table. Short version:

- New or broken site: `extractors/<site>.js`. `extractors/index.js` requires
  every `.js` file in the folder except `index.js`, `generic.js` and `util.js`,
  so there is nothing to register. A helper `.js` placed there is loaded as an
  extractor too; put shared code in `util.js`. Then:
  - An adult site must also be added to `ADULT_SITE_DOMAINS` (hostnames) and
    `ADULT_SITE_SLUGS` (slugs) in `audience.js`. Leaving it out removes
    automatic adult-site detection: `classify()` in `audience.js` can then
    return "unknown" (or adult/general through other signals, such as a
    matching creator profile), and `classifySource()` in `smart-routing.js`
    gives an unlisted source the class "review" (the Review folder) unless 18+
    precedence applies. Unknown is never treated as general, but an 18+ clip
    should not depend on that. Check the new site (should print `true`):
    `node -e "console.log(require('./audience').isAdultSite('https://www.example.com/x'))"`
    (replace the URL with one from the new site; `isAdultSite()` also accepts a
    site slug).
  - New direct fetches use `safeFetch()` from `url-guard.js`. Eight existing
    extractors use plain `fetch` (open decision D2).
  - Add a test `test/<site>-<topic>.test.js`. Use
    `test/facebook-title-id.test.js` or `test/source-tags-generic.test.js` as
    the template: they replace yt-dlp with a fake binary (`YTDLP_BIN`) in a
    temp dir, so no network is used. Run only that file:
    `node --test test/<site>-<topic>.test.js`.
- Where a download is saved (route/folder): `smart-routing.js` for decisions,
  `server.js` `smartRoute()` and the destination constants for folders.
- General vs 18+ decisions: `audience.js` (pure), called by `server.js` before
  every write into an app folder.
- Tags a source supplied: `source-meta.js`. Owner tags: `item-meta.js` (stored via `item-store.js`).
- Duplicate Manager: `dupe-*.js`, UI in `public/hub/dupes/`.
- State file safety: `writeJsonAtomic()`, `readJsonState()`, `STATE_FILES` in `server.js`.
  Per-app API client registry I/O is owned by `gda.js` (with `gda-admin.js`).
- Audio and music tags: Python with mutagen, called from `server.js`.

## Routing terminology (do not mix these)

- **`smart-routing.js`**: pure functions. Decides the destination of a video
  being downloaded now. It is intended for eligible video jobs the owner's web
  UI starts on `/api/jobs/start` with `route=smart` (opt-in). The check admits
  any principal with the admin audience, so a co-hosted caller using the
  internal token can currently request it too (open decision D3 in
  `documentation/open-decisions.md`). Synchronous `/api/download*` and
  `/api/v1` jobs never take it. Decision order: 18+ first (adult source class or
  adult audience), then the hard-coded `SOURCE_CLASSES` table (an unknown source
  goes to review), then orientation. Portrait rule: a portrait video from a
  General source goes to Shorts only if a main Shorts library exists and the
  audience gate for that channel judges the item General without refusing it
  (a by-hand General item classification, or a creator matching a
  hand-classified General profile); otherwise it goes to Review (a portrait 18+ video goes
  to 18+ Shorts if that library takes it, else to the 18+ library). Shorts
  destinations only count when `ELITE_ENABLED` and `shortsUnavailable()` allow
  them. `ELITE_ENABLED` is true when any Shorts channel root
  (`TIKSHORTIS_ROOT`, `ELITE_ROOT`, `PLATFORM_IMPORT_ROOT`; an 18+ root
  blocked for overlap does not count) or a posts import folder is configured.
  With it off, `smartRoute()`
  sees no Shorts library, so General portrait videos go to Review and 18+ ones
  to the adults folder; outside smart routing, `parseDest()` turns
  `elite` into the `server` library (explicit `server`, `navidrome` and
  `audiobooks` requests are kept) and `parseImportDest()` always returns
  `server`. The exports
  (`decideRoute`, `suggestionForSites`, `SOURCE_CLASSES`, `REVIEW_FOLDER`, ...)
  are a selection; read the file (it is small) for the rest.
- **`source-meta.js`**: what a source said about an item (site tags, categories,
  caption hashtags). Metadata only. It never decides a destination.
- **`routing.jsonl`**: the append-only log in `DATA_DIR` of each routing
  decision, written by `logRoutingDecision()` in `server.js`. A log, not
  configuration; rotated at 5 MiB to `routing.jsonl.1`. Fields: `at`, `jobId`,
  `sourceUrl`, `site`, `mediaId`, `creator`, `width`, `height`, then the
  decision (`route`, `orientation`, `source`, `sourceClass`, `audience`, `dest`,
  `channel`, `folder`, `reasons`). Sensitive: it holds URLs and creator data.
  It can show a decision with no matching history row (open decision D4).
- **Routes (`route`)**: the outcome of `decideRoute`. `job.route` is a decision
  object (the same fields as above), not a string.
- **Folders**: directories on disk (`VIDEOS_DIR`, `ADULTS_DIR`, `PHOTOS_DIR`,
  the `review` folder, app import folders). `GET /api/folders` lists the
  built-in names (`videos`, `adults`, `photos`) plus visible immediate children
  of `DOWNLOAD_DIR`, not every mount. Routing chooses a folder; it does not
  create audiences. Guarded writes go through `assertDeliverable()`.
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
- Tests: `test/audience.test.js`, `test/audience-gate.test.js`,
  `test/adult-separation.test.js`, `test/smart-routing.test.js`. Run them after
  any routing or audience change, for example:
  `node --test test/audience.test.js test/audience-gate.test.js test/adult-separation.test.js test/smart-routing.test.js`
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
- Open owner decisions (D1-D4) are listed in `documentation/open-decisions.md`.
- Do not change the Dockerfile, CI, compose files or secrets as a side effect
  of a code or documentation task.
- `docs/` is local-only and gitignored. `documentation/` is tracked.

## Document index

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Invariants and lessons learned (authoritative rules) |
| `documentation/feature-map.md` | Feature to file map, tests |
| `documentation/storage-map.md` | `DATA_DIR` stores, owner, backup, rollback |
| `documentation/runtime.md` | Node version truth, external tools |
| `documentation/open-decisions.md` | D1-D4 and other open owner decisions (not fixes) |
| `documentation/music-library-rules.md` | Music and library rules (moved from `CLAUDE.md`) |
| `documentation/claude-workflow.md` | Token-efficient working method |
| `documentation/test-contracts.md` | Guard tests: what they protect, how to run them, known gaps |
| `documentation/architecture.md`, `configuration.md`, `installation.md`, `user-guide.md` | Product docs |
