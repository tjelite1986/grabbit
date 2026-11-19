# Configuration reference

This page lists Grabbit's deployment settings, which are environment
variables. Preferences are made in the app instead: classic view defaults are
stored in the browser, and Duplicate Manager settings are stored on the
server. Every variable is optional unless it is marked **required**. Paths are
paths inside the container when you run Docker.

`<DL>` below means the value of `DOWNLOAD_DIR`.

## Server and paths

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` (`/data` in the image) | State: history, registry, `items.db`, `dupes.db`, cookies, models, Smart Trash, snapshots. **Back it up.** |
| `DOWNLOAD_DIR` | `./downloads` (`/downloads` in the image) | Root of the server library. |
| `VIDEOS_DOWNLOAD_DIR` | `<DL>/videos` | Videos. |
| `AUDIO_DOWNLOAD_DIR` | `<DL>/mp3` | Audio. |
| `PHOTOS_DOWNLOAD_DIR` | `<DL>/photos` | Photos. |
| `ADULTS_DOWNLOAD_DIR` | `<DL>/adults` | 18+ files in the server library. |
| `ADULTS_BY_UPLOADER` | off | `1` files 18+ saves in a subfolder per uploader. |
| `NAVIDROME_MUSIC_DIR` | `<DL>/navidrome` | Music library destination (point it at the folder your music server scans). |
| `NAVIDROME_KIDS_DIR` | `<DL>/navidrome-kids` | A second music library. |
| `AUDIOBOOKS_DIR` | `<DL>/audiobooks` | Audiobook library, one folder per book. |
| `MAX_ACTIVE_JOBS` | `2` | Downloads that run at the same time. The rest wait in the queue. |
| `CHILD_IDLE_SEC` | `600` | A child process with no output for this long is stopped. Values below 60 count as 60. |
| `CHILD_MAX_SEC` | `21600` | Hard limit for one child process. Values below 300 count as 300. |
| `STATE_BACKUP_DAYS` | `7` | Number of daily snapshot folders to keep. `0` turns snapshots off. |
| `TZ` | container default | Time zone for server logs and timestamps. Scheduled start times are entered in the browser's local time. |
| `HUB_BRAND` | `Media hub` | Subtitle under the logo in the hub. |
| `HUB_APP_LINKS` | empty | Extra sidebar links, `Name\|https://url,Name\|https://url`. |

## Authentication and access

| Variable | Default | Purpose |
|---|---|---|
| `GRABBIT_PASSWORD` | **required** | Password for the web interface. The server refuses to start without it, unless `GRABBIT_AUTH_DISABLED=1`. Any non-empty value is accepted, so generate one. |
| `GRABBIT_AUTH_DISABLED` | off | `1` allows starting with an empty password, which leaves the server open. With a password set, the gate stays on. Use it only on a machine that nobody else can reach. |
| `GRABBIT_SECRET` | the password | Signs the login cookie. Changing it signs everyone out. |
| `GRABBIT_INTERNAL_TOKEN` | empty | Shared secret for co-hosted apps. A request skips the password gate only when it sends this value in `X-Grabbit-Token` **and** has no `X-Forwarded-Host` header (so nothing that came through the reverse proxy qualifies). Empty means there is no bypass. The TikShortis and Social & Photos gateways never accept it. |
| `GRABBIT_TRUST_PROXY` | empty | Comma-separated value for Express `trust proxy`, for example the address of your reverse proxy. |
| `ALLOW_PRIVATE_ADDRESSES` | off | `1` lets download URLs point at private addresses. Leave it off unless you download from your own LAN. |

The login cookie is always `Secure`, so sign-in needs HTTPS or
`http://localhost` (see [Signing in](installation.md#signing-in)). The login
page, static assets and `GET`/`HEAD /api/health/release` are not gated.

Per-app passwords and tokens (GDA) are managed with `node gda-admin.js`
(`list`, `add`, `password`, `token`, `revoke-token`, `revoke`, `targets`) and
stored in `DATA_DIR/gda-clients.json`.

## TikShortis

TikShortis is a separate application:
[tjelite1986/tikshortis](https://github.com/tjelite1986/tikshortis).

| Variable | Default | Purpose |
|---|---|---|
| `TIKSHORTIS_MODE` | unset | `native` shows the hub's own TikShortis pages. `embed` frames an existing TikShortis site. `off` hides it. Unset means `embed` when `TIKSHORTIS_EMBED_URL` is set and valid, otherwise off. An invalid setting falls back and logs a warning. |
| `TIKSHORTIS_API_URL` | empty | TikShortis API base URL, needed for `native`. |
| `TIKSHORTIS_EMBED_URL` | empty | HTTPS URL of the TikShortis site (or `http://localhost` / `http://127.0.0.1` for local use), needed for `embed`. That site must allow the hub in its `EMBED_FRAME_ANCESTORS`. |
| `TIKSHORTIS_ROOT` | unset | TikShortis library root. Enables the main shorts channel and lets the duplicate manager scan it. Unset means the main channel does not exist; `ELITE_ROOT` and `PLATFORM_IMPORT_ROOT` enable the other shorts channels on their own. |
| `SHORTS_MAX_DURATION` | `600` | Seconds. For a clip known to be longer, the classic download sheet switches the destination to the server library, a single API save to a shorts destination is refused, and a batch skips it. |

## Social & Photos (Elitogram)

Elitogram is a separate application:
[tjelite1986/elitogram](https://github.com/tjelite1986/elitogram).

| Variable | Default | Purpose |
|---|---|---|
| `EGRAM_MODE` | `off` | `native` shows Social & Photos. It needs `EGRAM_API_URL`, otherwise it stays off with a warning. |
| `EGRAM_API_URL` | empty | Elitogram API base URL. |
| `EGRAM_UPLOAD_MAX_MB` | `4096` | Largest upload passed through the gateway. |
| `POSTS_TO_EGRAM` | off | `1` sends downloaded images to Elitogram's import folder. |
| `EGRAM_IMPORT_DIR` | unset | Elitogram's import folder, used with `POSTS_TO_EGRAM=1`. |
| `EGRAM_LIBRARY_DIR` | unset | Elitogram's media folder, scanned read-only by the duplicate manager. Needed for the Elitogram duplicate adapter. |

## Smart Duplicate Manager

Most duplicate settings are made in the hub under **Duplicates → Settings**:
read limit, engines, AI model, sensitivity, threads, keep rule, trash
retention and prevention. These variables are server-side switches:

| Variable | Default | Purpose |
|---|---|---|
| `DUPES_SCAN` | on | `off` disables the scanner. |
| `DUPES_SCAN_MBPS` | `20` | Read limit in MB/s (1 to 500). The hub setting overrides it. |
| `DUPES_PHOTO` | on | `off` disables perceptual photo matching. |
| `DUPES_AI` | on | `off` disables the AI Photo Engine, even when a model is installed. When on, the engine still needs a model and the in-app **AI comparison** switch. |
| `DUPES_VIDEO` | on | `off` disables video fingerprinting. |
| `GRABBIT_DEDUPE_TOKEN_FILE` | unset | File with a shared key of at least 32 characters. Mount the same file into Grabbit and into TikShortis or Elitogram. An adapter also needs that app's API URL and library folder: `TIKSHORTIS_API_URL` + `TIKSHORTIS_ROOT`, or `EGRAM_API_URL` + `EGRAM_LIBRARY_DIR`. |

## Other integrations

| Variable | Default | Purpose |
|---|---|---|
| `WATCH_INTERVAL_MINUTES` | `360` | How often watched playlists are checked (at least 15). |
| `MAX_WATCH_FAILURES` | `3` | A track in a watched playlist is given up after this many failed attempts. The rest of the playlist keeps being watched. |
| `INBOX_DROP_DIR` | unset | Drop folder for the Inbox page. |
| `INBOX_MODE` | `off` | `off`, `shadow` or `on`. |
| `INBOX_SINCE` | unset | ISO date. Ignore inbox drops older than this. |
| `PLATFORM_IMPORT_ROOT` | unset | Import folder of a co-hosted platform app (destination). |
| `ELITE_ROOT` | unset | 18+ shorts library root (destination). The name is kept for compatibility. At startup Grabbit checks that its `18plus` folder shares no tree with the main shorts folder, the platform drop folder, the posts import folder or the Elitogram import folder; if it does, the 18+ channel is disabled and an error is logged. |
| `ELITE_POSTS_ROOT` | unset | Legacy photo posts destination. Posts go to `<ELITE_POSTS_ROOT>/_import`. |
| `ELITE_POSTS_IMPORT_DIR` | unset | Overrides `<ELITE_POSTS_ROOT>/_import` whenever the Elitogram import is inactive: `POSTS_TO_EGRAM` is off, or it is `1` without `EGRAM_IMPORT_DIR` (Grabbit then logs a warning). |
| `DROP_FORMAT_MAIN`, `DROP_FORMAT_18PLUS` | `legacy` | How clips dropped into the main and 18+ shorts channels are named. `legacy` is `<creator>_-_<title>.mp4` (`.web.mp4` for a web-optimised copy) with a `.md` caption; `brackets` is `<title> [@<creator>] [id=<media id>].mp4` with a `.json` sidecar, and leaves out the `[id=…]` part when the item has no usable media id. |
| `ADSHORTIS_LIBRARY`, `ADFLIX_LIBRARY` | unset | Mount points. When set, the hub lists the Adshortis 18+ and Adflix 18+ library viewers. |
| `ADSHORTIS_LIBRARY_DIR`, `PLATFORM_LIBRARY_DIR` | unset | Extra folders for the duplicate scan. |

## Notifications

| Variable | Default | Purpose |
|---|---|---|
| `GRABBIT_VAPID_PUBLIC` | empty | Web-push public key. Generate a pair with `npx web-push generate-vapid-keys`. |
| `GRABBIT_VAPID_PRIVATE` | empty | Web-push private key. |
| `GRABBIT_VAPID_SUBJECT` | built-in project address | Contact address for push services. When it is blank, Grabbit falls back to the project maintainer's address, so **set it to your own**, for example `mailto:you@example.com`. |

## External tools

| Variable | Default | Purpose |
|---|---|---|
| `YTDLP_BIN` | `yt-dlp` | yt-dlp executable. |
| `GALLERY_DL_BIN` | `gallery-dl` | gallery-dl executable. |
| `FFMPEG_BIN` | `ffmpeg` | ffmpeg executable. |
| `FFPROBE_BIN` | `ffprobe` | ffprobe executable. |
| `PYTHON_BIN` | `python3` | Python with mutagen, for audio tags. |

## Build-time

| Variable | Purpose |
|---|---|
| `RELEASE_SHA` (build arg, or runtime env) | Git commit the image was built from. Reported by `/api/health`. Only 40 lowercase hex characters are accepted. At runtime the variable is used only when the file below is missing or invalid. |
| `RELEASE_SHA_FILE` | Where the image keeps that value (`/app/RELEASE_SHA`). |
