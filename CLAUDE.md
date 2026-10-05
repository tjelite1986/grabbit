# grabbit — Claude Code Instructions

## Working rules (every session, local or cloud)

- **Language:** everything written to a file is English: code comments, UI
  strings, API error messages, log output, README, JSON descriptions, commit
  messages. Chat with the owner in Swedish. No emojis unless asked.
- **`docs/` is local-only.** It is a scratch area between the owner and Claude,
  gitignored on purpose. Never commit it and never `git add -f` it. A cloud
  session will not see it; ask the owner to paste what you need.
- **No secrets in git:** `.env`, `.env.*`, dated backups like `.env.bak-*`,
  keys and tokens. Read `git status` before every commit.
- **Target platform:** the owner self-hosts on a Raspberry Pi (linux/arm64,
  Node 20) and an x86 Linux box, as Docker images behind Traefik. Code must
  build and run on linux/arm64 with Node 20. Check that any new native
  dependency ships arm64 builds.
- **Cloud sessions cannot reach production:** no host, no live database, no
  `.env`, no container logs. Deliver work as a branch and a PR whose
  description says how to verify it live. Deploy and live verification are
  done by the owner on the host. Do not claim something works in production.
- **Data safety:** never blanket-`DELETE` or `rm` a database or data directory
  to clean up after a test; remove only what the test created.
- **Keep diffs about the change:** do not reformat code you are not otherwise
  touching. Run `prettier --check` before `prettier --write` on an older file.
- **Archive, don't delete:** don't delete branches; tag them `archive/<name>`
  first.

## Lessons learned

Things that broke before or decisions not to undo. Each rule has its reason.

### Contracts with callers and deployments
- **Co-hosted apps call the synchronous `GET /api/download` (`device=0`, JSON) and `GET /api/download-all` (SSE) over the internal network.** Keep their shape and behaviour. The background job system (`/api/jobs/*`) is additive and used only by the web UI.
- **Internal traffic is recognised only by a secret.** The caller must send `X-Grabbit-Token` matching `GRABBIT_INTERNAL_TOKEN`. Never gate on a header being absent: a missing `X-Forwarded-Host` once counted as "internal", and every install that published port 3000 ran wide open.
- **`SameSite=Lax` cookies ride cross-site top-level navigations.** `/api/*` therefore rejects `Sec-Fetch-Site: cross-site` and any `Origin` that doesn't match. A new GET with side effects must stay behind that check.
- **Resolve and download failures return 422, never 5xx.** Why: Cloudflare replaces a 5xx body with its own HTML page, and the frontend then fails with "Unexpected token '<'".
- **The brand is "Grabbit" in prose and visible UI, and `grabbit` in every identifier.** Never rename `grabbit-auth-v1` (the cookie HMAC salt, which would log everyone out), the `grabbit.*` localStorage keys (which would reset saved settings), `X-Grabbit-Token`, or the `GRABBIT_*` env vars.
- **Shorts destinations (`ELITE_ROOT`, `TIKSHORTIS_ROOT`, `ELITE_POSTS_ROOT`) are opt-in, and unset means the channel does not exist.** The `ELITE` names stay for compose compatibility even though those libraries moved to other apps. Never default them to container paths.
- **The repo is public.** Examples and docs use `example.com` and `/path/to/...`, never a real domain, host path or account.

### Security
- **Every submitted URL goes through `extractors.resolve()` / `resolveProfile()` → `assertPublicUrl()` (`url-guard.js`).** Direct fetches use `safeFetch()`, which follows redirects by hand and re-checks each hop. Two ranges are deliberately not blocked:
  - `::ffff:0:0/96`, because it covers every public IPv4 address. Unwrap mapped addresses and check them as IPv4 instead.
  - `198.18.0.0/15`, because Fake-IP proxies resolve real hosts into it.
- **Accepted residual risk: child processes (yt-dlp, ffmpeg) resolve hosts themselves.** A network egress filter was proposed and declined, so don't re-propose it.
- **Extractor `match()` must compare the parsed `new URL().hostname` (exact or subdomain), never a substring.** Why: a substring test let `https://attacker/imagefap.com/...` steer the server and gallery-dl at another host. Always pass `--` before the user URL in yt-dlp and gallery-dl argv.
- **Extra yt-dlp args go through an allowlist only (`ALLOWED_ARGS`: long flags with an arity check).** Short flags, unknown flags and stray positionals (which would become extra URLs) return 400. A denylist was bypassed by `-P/tmp`, `--exec` and `--ppa`, so never switch back to one.
- **`sanitizeRules()` validates every rule field server-side against its enum, because rule values replay into download params.** Regexes are compile-checked. The rules engine stays deterministic, with no AI and no external services: zero cost for self-hosters is a requirement.
- **In `public/index.html`, site-supplied URLs reach `style` and `href` only through `cssUrl()` and `safeHref()`.**

### Names, dedup and the downloaded registry
- **The file name is the dedup key** (`safeCreator_-_safeTitle`), and importers skip a name they already have without saying so. Every title an extractor generates must end in a stable site id (post id or media id). Multi-item posts also need their position. Put the clean caption in `description`. Measure collisions by resolving a real profile, not by reasoning about it.
- **Never take the creator from `<title>` or `og:title` when the page renders an uploader link.** SEO titles carry the item's own caption: erome clips once landed under profiles named after their captions, and redgifs' `<title>` is literally "RedGifs".
- **Filesystem limits count BYTES per path segment.** Use `clampBytes()`, which cuts on a code-point boundary. In yt-dlp output templates, cap every site-supplied field (`%(section_title).40s`) and leave about 32 bytes for `.part`, `.f<id>` and similar suffixes.
- **Sanitize only what a path cannot hold, and keep `\p{L}\p{N}`.** A many-to-one ASCII sanitizer turns distinct titles into "duplicates".
- **In the registry, a site-native id key (`id:<site>:<id>`, normalised in `extractors/index.js` `withMediaId`) is authoritative.** Fall back to the URL key only when that URL contains the media id. Why: a shared profile URL as `sourceUrl` once flagged every clip of a creator as downloaded. When dedup misbehaves, compare the site slugs first, because different code paths write `youtube` and `music.youtube.com`.
- **Don't parse ids out of URL slugs** (nuditok slugs carry a truncated id). Use what the extractor's `resolve()` returns. `enrich(job)` may fill fields but must never change identity fields.
- **The server caches `downloaded.json` in memory**, so an external edit to it gets overwritten. Change state through the API.

### Writing files safely
- **State files are written with `writeJsonAtomic()` (temp file in the same dir, fsync, rename) and read with `readJsonState()`.** A missing file means a fresh install. A file that exists but doesn't parse is damage: quarantine it as `.corrupt-<stamp>` and restore from a snapshot. Never write a degraded reconstruction back over the original (a corrupt registry was once "rebuilt" from the 200-row history). Add new state files to `STATE_FILES` so they get daily snapshots.
- **`writeJsonAtomic()` is synchronous, and its temp name is per process (`.tmp-<pid>`).** If you make it async, queue the writes per file and give each write its own temp name. Why: two writers sharing one temp path end in ENOENT on the second rename.
- **Moving across mounts:** copy to `.<name>.part` in the target dir, mutate the copy, rename it, and unlink the source last (`dropWork()` cleans up on failure). Why: `rename` throws EXDEV across mounts, and tagging before the move left a file retagged but not moved.
- **ffmpeg writing to a `.part` path needs an explicit `-f <format>`.** Without it the muxer fails and `fallbackCopy()` silently copies the raw source, losing metadata and faststart. Check the output with ffprobe, not the exit code.
- **Concurrency:** `MAX_ACTIVE_JOBS` is 2, so keep `withBookFolderLock` around audiobook part-number reservation. Every yt-dlp spawn gets a temp copy of its cookie file (`cookieArgs`), because yt-dlp rewrites the file and parallel jobs would corrupt it.

### Downloads and extractors
- **Long downloads run as background jobs.** `/api/jobs/start` returns a job id at once, progress streams over SSE, and the finished file is pulled after. Why: synchronous responses died at the proxy after about 100 s.
- **Failures:** `failJob()` persists them to history and never calls `markDownloaded()`, so playlists keep offering the item. The playlist watcher gives up after `MAX_WATCH_FAILURES`. Upstream 404/403/429/5xx is marked `retryable` and parked in `retry-queue.json` with backoff (new uploads 404 until the CDN finishes encoding). Permanent errors fail fast.
- **`isFatalProbeError()` decides whether a failed metadata probe means the download will fail too.** Don't print "may still work" for parse refusals, private videos or login walls.
- **When one site suddenly fails, suspect a stale yt-dlp first.** The image pins yt-dlp at build time, and the pip layer caches. Reproduce with a current yt-dlp before changing extractor code.
- **Hotlink protection:** some CDNs return 403 for a foreign `Referer`. Thumbnails go through `/api/thumb` (site Referer, then none), and previews go through `/api/media`, which forwards `Range` and mirrors 206/`Content-Range`. erome videos need the erome Referer.
- **redgifs: always fetch `urls.hd`.** The `-silent` and `-mobile` variants have no audio, and `hasAudio` under-reports, so treat it as advisory. The temporary token is bound to IP and User-Agent, so send the same UA on every call.
- **reddclips: every post URL claims `isProfile`, and `resolveProfile` throws for single-media posts so the UI falls back to `/api/resolve`.** A listing reports `creator: null`, because the batch creator field overrides every item.

### Music metadata and the library
- **Never send a raw video title to iTunes or Deezer.** Use `parseTrackTitle()` first:
  - Drop noise brackets and keep version brackets.
  - Split only on a spaced dash, so names like Jay-Z survive.
  - Then use `musicMetaLookup()` → `artistCatalogue()`.
- **Only `full` and `close` verdicts from `candidateMatch()` fill fields automatically.** Don't loosen title matching without the artist gate, or someone else's song ends up in the tags.
- **Keep the match surface apart from the write surface.** `matchNames[]` is for matching only. `artists[]` is written to tags, folders and the UI. Never widen a written field to make a match succeed. `foldName()` is for comparison only: mapping `ǫ`→q is fine there but wrong in a tag, so written names go through `plainName()`. Lookalike tables run before NFKD, because NFKD does not fold small capitals.
- **Genre NAMES are resolved by the exact tables (`GENRE_NORMALIZE`, `GENRE_VOCABULARY`).** Substring reading is only for free-text tag lines; it once turned "Indie Pop" into "Indie" and "R&B/Soul" into "Soul". Gate bulk genre writes on the vocabulary the library already uses.
- **`/api/music/edit` is not a partial update.** It recomputes the library path from artist + album + year + title (`musicLibraryTarget()`), so an omitted field moves the file. Echo every existing field back. Never test it against a real track.
- **Prefer `release_date` over `release_year`, and drop years outside 1900..next year** (YouTube Music has returned 1674). mutagen's mp3/m4a easy-tag maps silently skip `releasetype`. Opus keeps its tags on the stream (`ffprobe -show_entries stream_tags`), not the format.

### Web UI (`public/index.html`, vanilla SPA)
- **The service worker must never intercept `/api/` or `/login`.** The SSE job stream and the auth redirect break if it does.
- **Card thumbnails are `background-image` divs marked `data-media-bg="1"`, and the privacy blur targets that attribute.** Keep it when changing card rendering. Don't add tap-outside-to-dismiss to the privacy panel, because it makes partial-selection blur impossible.
