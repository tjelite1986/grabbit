# Feature map

Where each feature lives. Verified against commit `73547d3`. Search by symbol,
not by line number. "Test" names are files in `test/`.

## Core

| Feature | Files | Tests |
|---------|-------|-------|
| HTTP server, auth, cross-site checks, job engine, history, watcher | `server.js` | `contract.test.js`, `social-static.test.js`, `guard-http.test.js`, `guard-jobs.test.js`, `guard-storage.test.js` |
| Site extractors (resolve, profile listing) | `extractors/index.js`, `extractors/<site>.js`, `extractors/util.js`. URL rules: `CLAUDE.md` "Security" section; plain `fetch` in eight extractors is open decision D2 in `documentation/open-decisions.md` | `facebook-title-id.test.js`, `source-tags-generic.test.js` |
| URL safety (public-address guard, safe fetch) | `url-guard.js` | `guard-url.test.js`, `guard-http.test.js` |
| Cookies for yt-dlp | `cookies.js` | |
| Retry queue (retryable upstream failures) | `retry-queue.js`, `DATA_DIR/retry-queue.json` | `retry-queue.test.js` |
| Premium fallback (YouTube Music) | `premium-fallback.js` | |
| Safe cross-mount copy | `safe-copy.js` | `safe-copy.test.js` |
| Release SHA | `release.js` | `release.test.js` |
| Per-app API access (`/api/v1`) | `gda.js`, `gda-admin.js` | `gda.test.js` |
| Extra yt-dlp args allowlist (`ALLOWED_ARGS`, `parseExtraArgs`) | `server.js`: `ALLOWED_ARGS` and `parseExtraArgs()` (about line 395 and 423); callers are `POST /api/templates/save` (validates on save, about line 5374) and `GET /api/jobs/start` (`xargs` query, about line 8587). Find: `rg -n -e ALLOWED_ARGS -e parseExtraArgs server.js` . Binding rule: `CLAUDE.md` "Security" (allowlist only, never a denylist). The synchronous `/api/download` and `/api/download-all` contracts take no `xargs`, so an allowlist change does not affect them; `/api/jobs/start` strips `xargs` for app clients without the admin audience, but the internal principal keeps it | `guard-ytdlp-args.test.js` (dedicated, through HTTP); `contract.test.js` checks that an app client's `xargs` is dropped |

## Classification and routing

| Feature | Files | Tests |
|---------|-------|-------|
| Audience gate (general / adult / unknown) | `audience.js` | `audience.test.js`, `audience-gate.test.js`, `adult-separation.test.js` |
| Smart Video Routing (destination decision) | `smart-routing.js`, `smartRoute()` in `server.js` | `smart-routing.test.js` |
| Source tags and hashtags (what a source said; never decides a destination) | `source-meta.js` | `item-meta.test.js`, `source-tags-generic.test.js` |
| Routing decision log | `logRoutingDecision()` in `server.js`, `DATA_DIR/routing.jsonl` | |
| Creator profiles | `profiles.js` | `profiles.test.js` |
| Item and delivery store (SQLite); owner tags | `item-store.js`, `item-meta.js` | `item-store.test.js`, `item-meta.test.js` |

`smart-routing.js` decides destinations. `source-meta.js` only records what a
source said. `routing.jsonl` is a log. Folders are directories. Do not merge
these concepts (see `START-HERE.md`).

## Hub, apps and gateways

| Feature | Files | Tests |
|---------|-------|-------|
| Hub dashboard counts | `hub.js` (server side), `public/hub/` (browser) | `hub.test.js`, `hub-default.test.js` |
| Module registry (on/off per section) | `modules.js` | `tik-modules.test.js` |
| TikShortis gateway and embed | `tikshortis-gateway.js`, `tikshortis-embed.js`, `public/hub/tik/` | `tik-gateway.test.js`, `tik-server.test.js`, `tikshortis-embed.test.js`, `tik-player-static.test.js` |
| Social & Photos (Elitogram) gateway | `egram-gateway.js`, `public/hub/social/` | `egram-gateway.test.js`, `egram-server.test.js` |
| Posts publishing | `posts-publish.js` | `posts-publish.test.js` |
| Platform drop / import folders | `platform-drop.js` | `platform-drop.test.js` |
| Instagram inbox | `inbox.js` | `inbox.test.js`, `inbox-e2e.test.js` |
| Libraries for other apps | `adshortis-library.js`, `adflix-library.js`, `library.js` | `adshortis-library.test.js`, `adflix-library.test.js`, `library.test.js`, `library-downgrade.test.js` |
| Media viewer | `media-viewer.js` | `media-viewer.test.js`, `local-thumbs.test.js` |
| Audience gate on Grabbit's own surfaces (Media, history, dashboard, jobs, thumbnails) | `server.js` (`wantsAdultView`, `registryForView`, `viewOfJob`), `thumb-index.js` | `audience-view.test.js`, `audience-view-static.test.js`, `local-thumbs.test.js`, `thumb-index.test.js`, `audience-gate.test.js` |

## Duplicate Manager

Files `dupe-*.js` (service, scan, store, analyzer, trash, adapters, routes,
media, photo, video, phash, ai, classify, group, quality), UI in
`public/hub/dupes/`. Tests: `dupe-adapters.test.js`, `dupe-ai.test.js`,
`dupe-analyzer.test.js`, `dupe-classify.test.js`, `dupe-group.test.js`,
`dupe-media.test.js`, `dupe-phash.test.js`, `dupe-photo.test.js`,
`dupe-quality.test.js`, `dupe-routes.test.js`, `dupe-scan.test.js`,
`dupe-service.test.js`, `dupe-store.test.js`, `dupe-trash.test.js`,
`dupe-video.test.js` and `meta-dupes-e2e.test.js`.
Data: `dupes.db`, `dupe-trash/`, `dupe-thumbs/`, `models/`.

## Front ends

| Surface | Path |
|---------|------|
| Hub (`/`) | `public/hub/index.html`, `public/hub/hub.js`, `public/hub/hub.css` |
| Classic (`/classic/`) | `public/index.html` |
| Share target (`/share`) | serves `public/index.html` |
| Service worker | `public/sw.js` (must never intercept `/api/` or `/login`) |

## Selected prefix map (not a complete route list)

`/api/hub/*` (most routes), `/api/library`, `/api/playlists`, `/api/music`,
`/api/jobs/*`, `/api/v1/*` (GDA), `/api/retry`, `/api/templates`, `/api/push`,
`/api/health`, `/api/cookies`, `/api/tik`, `/api/egram`, `/api/rules`,
`/api/history`, `/api/downloaded`, `/api/resolve`, `/api/profile`,
`/api/download` and `/api/download-all` (synchronous contracts for co-hosted
callers, keep their shape), `/api/thumb`, `/api/media`, `/api/folders`,
`/api/egram/creators-classify`, `/api/config`, `/api/sites`, `/api/search`.

Route discovery needs both direct routes and mounts:

```bash
rg -n "app\.(get|post|put|delete|patch)\(" server.js
rg -n "app\.use\(['\"]/api" server.js     # Tik, Elitogram, Duplicate Manager, /api/v1
```

Tik (`/api/tik`), Elitogram (`/api/egram`) and the Duplicate Manager
(`/api/hub/dupes/v2`, `dupe-routes.js` `createRouter`) are mounted with
`app.use`, so many of their sub-routes do not appear in the first command.
