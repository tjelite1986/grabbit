# Feature map

Where each feature lives. Verified against commit `73547d3`. Search by symbol,
not by line number. "Test" names are files in `test/`.

## Core

| Feature | Files | Tests |
|---------|-------|-------|
| HTTP server, auth, cross-site checks, job engine, history, watcher | `server.js` | `contract.test.js`, `social-static.test.js` |
| Site extractors (resolve, profile listing) | `extractors/index.js`, `extractors/<site>.js`, `extractors/util.js` | `facebook-title-id.test.js`, `source-tags-generic.test.js` |
| URL safety (public-address guard, safe fetch) | `url-guard.js` | `contract.test.js` |
| Cookies for yt-dlp | `cookies.js` | |
| Retry queue (retryable upstream failures) | `retry-queue.js`, `retry-queue.json` | `retry-queue.test.js` |
| Premium fallback (YouTube Music) | `premium-fallback.js` | |
| Safe cross-mount copy | `safe-copy.js` | `safe-copy.test.js` |
| Release SHA | `release.js` | `release.test.js` |
| Per-app API access (`/api/v1`) | `gda.js`, `gda-admin.js` | `gda.test.js` |

## Classification and routing

| Feature | Files | Tests |
|---------|-------|-------|
| Audience gate (general / adult / unknown) | `audience.js` | `audience.test.js`, `audience-gate.test.js`, `adult-separation.test.js` |
| Smart Video Routing (destination decision) | `smart-routing.js`, `smartRoute()` in `server.js` | `smart-routing.test.js` |
| Source tags and hashtags | `source-meta.js` | `item-meta.test.js`, `source-tags-generic.test.js` |
| Routing decision log | `logRoutingDecision()` in `server.js`, `DATA_DIR/routing.jsonl` | |
| Creator profiles | `profiles.js` | `profiles.test.js` |
| Item and delivery store (SQLite) | `item-store.js`, `item-meta.js` | `item-store.test.js`, `item-meta.test.js` |

`smart-routing.js` decides destinations. `source-meta.js` only records what a
source said. `routing.jsonl` is a log. Folders are directories. Do not merge
these concepts (see `START-HERE.md`).

## Hub, apps and gateways

| Feature | Files | Tests |
|---------|-------|-------|
| Hub dashboard counts | `hub.js`, `public/hub/` | `hub.test.js`, `hub-default.test.js` |
| Module registry (on/off per section) | `modules.js` | `tik-modules.test.js` |
| TikShortis gateway and embed | `tikshortis-gateway.js`, `tikshortis-embed.js`, `public/hub/tik/` | `tik-gateway.test.js`, `tik-server.test.js`, `tikshortis-embed.test.js`, `tik-player-static.test.js` |
| Social & Photos (Elitogram) gateway | `egram-gateway.js`, `public/hub/social/` | `egram-gateway.test.js`, `egram-server.test.js` |
| Posts publishing | `posts-publish.js` | `posts-publish.test.js` |
| Platform drop / import folders | `platform-drop.js` | `platform-drop.test.js` |
| Instagram inbox | `inbox.js` | `inbox.test.js`, `inbox-e2e.test.js` |
| Libraries for other apps | `adshortis-library.js`, `adflix-library.js`, `library.js` | `adshortis-library.test.js`, `adflix-library.test.js`, `library.test.js`, `library-downgrade.test.js` |
| Media viewer | `media-viewer.js` | `media-viewer.test.js`, `local-thumbs.test.js` |

## Duplicate Manager

Files `dupe-*.js` (service, scan, store, analyzer, trash, adapters, routes,
media, photo, video, phash, ai, classify, group, quality), UI in
`public/hub/dupes/`. Tests are `test/dupe-*.test.js` and `meta-dupes-e2e.test.js`.
Data: `dupes.db`, `dupe-trash/`, `dupe-thumbs/`, `models/`.

## Front ends

| Surface | Path |
|---------|------|
| Hub (`/`) | `public/hub/index.html`, `hub.js`, `hub.css` |
| Classic (`/classic/`) | `public/index.html` |
| Share target (`/share`) | serves `public/index.html` |
| Service worker | `public/sw.js` (must never intercept `/api/` or `/login`) |

## API surface (prefix counts from `server.js`)

`/api/hub/*` (most routes), `/api/library`, `/api/playlists`, `/api/music`,
`/api/jobs/*`, `/api/v1/*` (GDA), `/api/retry`, `/api/templates`, `/api/push`,
`/api/health`, `/api/cookies`, `/api/tik`, `/api/egram`, `/api/rules`,
`/api/history`, `/api/downloaded`, `/api/resolve`, `/api/profile`,
`/api/download` and `/api/download-all` (synchronous contracts for co-hosted
callers, keep their shape), `/api/thumb`, `/api/media`, `/api/folders`,
`/api/creators-classify`, `/api/config`, `/api/sites`, `/api/search`.
List live routes with: `rg -n "app\.(get|post|put|delete|patch)\(" server.js`.
