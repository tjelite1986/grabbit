# Architecture

Grabbit is one Node.js (Express) process with a vanilla-JavaScript web app.
Heavy work runs in child processes (yt-dlp, gallery-dl, ffmpeg, Python for
tags), state lives in `DATA_DIR`, and media lives in folders you mount.
TikShortis and Elitogram are **separate applications** with their own
databases; Grabbit talks to them through narrow gateways and stores none of
their data.

## Overview (implemented in 3.0.4)

```mermaid
flowchart LR
  subgraph Browser
    HUB["Hub web app<br/>public/hub/"]
    CLASSIC["Classic view<br/>/classic/"]
  end

  subgraph Grabbit["Grabbit server (Node.js + Express)"]
    AUTH["Password gate · same-origin checks<br/>GDA per-app access (/api/v1)"]
    DL["Download engine<br/>extractors/ · jobs + SSE · retry queue<br/>playlist watcher · scheduler"]
    GUARD["url-guard<br/>public-address check"]
    META["Item store + metadata<br/>creators · captions · tags"]
    SDM["Smart Duplicate Manager<br/>scanner · analyzer · Smart Trash"]
    TIKGW["TikShortis gateway<br/>/api/tik (allowlist)"]
    EGGW["Social & Photos gateway<br/>/api/egram (general scope only)"]
  end

  subgraph Tools["Child processes"]
    YTDLP["yt-dlp / gallery-dl"]
    FF["ffmpeg / ffprobe"]
    PY["python3 + mutagen"]
    ONNX["ONNX Runtime<br/>DINOv2 (optional)"]
  end

  subgraph Data["DATA_DIR"]
    JSON["State JSON<br/>atomic writes + daily snapshots"]
    ITEMS[("items.db")]
    DUPES[("dupes.db")]
    TRASH["dupe-trash/"]
  end

  subgraph Storage["Media storage (your volumes)"]
    LIB["Grabbit library<br/>videos · photos · audio"]
    MUSIC["Music / audiobook libraries"]
    APPROOT["App folders (opt-in)<br/>TIKSHORTIS_ROOT · EGRAM_IMPORT_DIR"]
  end

  subgraph Apps["Separate applications (optional)"]
    TIK["TikShortis backend"]
    EG["Elitogram backend"]
  end

  HUB --> AUTH
  CLASSIC --> AUTH
  AUTH --> DL & META & SDM & TIKGW & EGGW
  DL --> GUARD
  DL --> YTDLP & FF & PY
  DL --> LIB & MUSIC & APPROOT
  DL --> META
  META --> ITEMS
  DL --> JSON
  SDM --> FF & ONNX
  SDM --> DUPES & TRASH
  SDM -. "read-only scan" .-> LIB & MUSIC & APPROOT
  SDM -. "dedupe adapters" .-> TIK & EG
  TIKGW --> TIK
  EGGW --> EG
  APPROOT -. "imported by" .-> TIK & EG
```

## Components

| Component | Where | What it does |
|---|---|---|
| Hub web app | `public/hub/` | The 3.0 interface: Dashboard, Download, Queue & jobs, Media, Library, Profiles, Review, Inbox, Duplicates, Conversion, Metadata & tags, Distribution, Settings, plus TikShortis and Social & Photos when they are switched on. |
| Classic view | `public/index.html`, served at `/classic/` | The 2.x single-page app. Some download features (playlists, formats, scheduling, cookies, rules, notifications) are still configured here. |
| Download engine | `server.js`, `extractors/`, `premium-fallback.js`, `retry-queue.js` | Resolves links with site extractors and falls back to yt-dlp. Runs long downloads as background jobs with progress over Server-Sent Events, at most `MAX_ACTIVE_JOBS` at a time. |
| URL guard | `url-guard.js` | Every submitted URL must resolve to a public address. Direct fetches follow redirects by hand and re-check each hop. |
| Item store | `item-store.js`, `item-meta.js`, `source-meta.js` | SQLite (`items.db`, WAL) with one row per downloaded item: audience, creator, source record, tags and an edit log. |
| Profiles and audience | `profiles.js`, `audience.js` | Creator profiles with several platform accounts and aliases. Audience (general or 18+) is set by hand and only ever tightens. |
| Smart Duplicate Manager | `dupe-*.js`, `public/hub/dupes/` | Read-only scanner, photo/AI/video analysis, review UI, Smart Trash and restore. See the README section. |
| TikShortis gateway | `tikshortis-gateway.js`, `public/hub/tik/` | Native TikShortis pages. Requests pass a method and path allowlist to the TikShortis API; the TikShortis session is sealed in an HttpOnly cookie. |
| Social & Photos gateway | `egram-gateway.js`, `public/hub/social/` | Native pages over the Elitogram API. Every request carries a general-audience scope and answers are checked again against Grabbit's own 18+ profiles. |
| GDA (per-app access) | `gda.js`, `gda-admin.js` | Passwords or bearer tokens per co-hosted app, each tied to an audience, targets and operations (`/api/v1/*`). |
| Module registry | `modules.js` | One list of hub modules, their audience and their switch. Planned modules are listed but never served. |

## Separate applications

| Application | Repository | Needed for | Without it |
|---|---|---|---|
| TikShortis | [tjelite1986/tikshortis](https://github.com/tjelite1986/tikshortis) | The native TikShortis pages (`TIKSHORTIS_MODE=native`) or the framed view (`embed`) | The TikShortis menu entry is hidden and `/api/tik` is not mounted. |
| Elitogram | [tjelite1986/elitogram](https://github.com/tjelite1986/elitogram) | Social & Photos (`EGRAM_MODE=native`) | The Social & Photos menu entry is hidden. |

Both are installed and run on their own. Grabbit can also drop finished files
into their import folders (`TIKSHORTIS_ROOT`, `EGRAM_IMPORT_DIR` with
`POSTS_TO_EGRAM=1`), and the duplicate manager can ask them about shared
copies when both sides mount the same `GRABBIT_DEDUPE_TOKEN_FILE`.

## Outbound network traffic

Grabbit contacts:

- the sites you download from (through yt-dlp, gallery-dl and the extractors);
- iTunes Search and Deezer, for music metadata lookups;
- GitHub, once, when you press **Get model** for the AI Photo Engine;
- your browser's push service, if you enable web-push notifications;
- TikShortis and Elitogram, if you configure them.

The duplicate analysis itself runs on your server. No media is uploaded for
analysis.

## Planned, not built

These are listed in `modules.js` with `planned: true`. They have no menu
entry and no routes in 3.0.4.

| Module | Audience |
|---|---|
| Videos (native) | General |
| Movies & music | General |
| Home | General |
| Adshortis module and adult videos & photos | 18+, isolated from general modules by design |

The Conversion page lists the tools it found. Its conversion queue is marked
as planned.
