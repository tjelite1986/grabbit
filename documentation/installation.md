# Installation

This guide installs Grabbit on its own first. TikShortis and Elitogram are
optional and come last.

There is **no published container image**. The Docker setup below builds the
image from this repository. The image bundles Node.js 22, yt-dlp, ffmpeg,
gallery-dl, curl_cffi and mutagen, so you install none of them on the host.
It builds on linux/arm64 (for example a Raspberry Pi 4 or 5) and linux/amd64.

- [1. Prerequisites](#1-prerequisites)
- [2. Get the code](#2-get-the-code)
- [3. Storage and volumes](#3-storage-and-volumes)
- [4. Secrets (.env)](#4-secrets-env)
- [5. Compose file](#5-compose-file)
- [6. Start and update](#6-start-and-update)
- [7. Reverse proxy](#7-reverse-proxy)
- [8. Optional integrations](#8-optional-integrations)
- [Running without Docker](#running-without-docker)

## 1. Prerequisites

Docker Engine with the Compose plugin:

```bash
docker --version
docker compose version
```

If `docker compose version` fails, install the plugin by following
[Docker's documentation](https://docs.docker.com/compose/install/).

## 2. Get the code

```bash
git clone https://github.com/tjelite1986/grabbit.git
cd grabbit
```

You run `docker compose` from this folder, because the image is built from it.

## 3. Storage and volumes

Create the host folders **before** the first start. Docker creates missing
bind-mount folders as `root`, which causes confusing write errors later.

```bash
# State (must persist) and the server library, split by type
mkdir -p data downloads/{videos,mp3,photos}
# Only if you use the music destination: the folder your music server scans
mkdir -p music
# Only if you use the audiobook destination
mkdir -p audiobooks
```

| Host folder | Container path | Holds |
|---|---|---|
| `data/` | `/data` | History, download registry, `items.db`, `dupes.db`, cookies, AI models, Smart Trash and daily snapshots. **Back this up.** |
| `downloads/` | `/downloads` | The server library, sorted into `videos/`, `mp3/`, `photos/` and, if you use it, `adults/`. |
| `music/` | `/music` | Optional music library. Make it the folder your music server already scans. |
| `audiobooks/` | `/audiobooks` | Optional audiobook library, one folder per book. |

**File systems.** The duplicate manager can only merge copies into hard
links when both are on the same file system. Smart Trash lives in
`/data/dupe-trash`. Moving a file there from another disk is a copy, so
reserve space on the `data` disk for what you put in the trash.

**Permissions.** The container runs as `root` by default, and the files it
creates belong to `root`. That is fine when other apps only read them. To own
the files as a normal user, give the folders to that user and add
`user: "1000:1000"` (your own `id -u`:`id -g`) to the service:

```bash
sudo chown -R 1000:1000 data downloads music audiobooks
```

## 4. Secrets (.env)

Create `.env` in the same folder:

```dotenv
# Required. The server refuses to start without a password.
GRABBIT_PASSWORD=change-me
# Optional: signs the login cookie. Changing it later signs everyone out.
GRABBIT_SECRET=
# Optional: only for co-hosted apps that call Grabbit's API directly.
# Empty means there is no bypass of the password gate.
GRABBIT_INTERNAL_TOKEN=
# Optional web-push notifications: npx web-push generate-vapid-keys
GRABBIT_VAPID_PUBLIC=
GRABBIT_VAPID_PRIVATE=
GRABBIT_VAPID_SUBJECT=mailto:you@example.com
```

Generate strong values with `openssl rand -hex 32`. Never commit `.env`.

## 5. Compose file

Save as `docker-compose.yml`:

```yaml
services:
  grabbit:
    build: .                       # build the image from this folder
    container_name: grabbit
    restart: unless-stopped
    ports:
      - "3000:3000"                # remove when a reverse proxy fronts Grabbit
    # user: "1000:1000"            # see Permissions above
    environment:
      - GRABBIT_PASSWORD=${GRABBIT_PASSWORD}
      - GRABBIT_SECRET=${GRABBIT_SECRET}
      - GRABBIT_INTERNAL_TOKEN=${GRABBIT_INTERNAL_TOKEN}
      - GRABBIT_VAPID_PUBLIC=${GRABBIT_VAPID_PUBLIC}
      - GRABBIT_VAPID_PRIVATE=${GRABBIT_VAPID_PRIVATE}
      - GRABBIT_VAPID_SUBJECT=${GRABBIT_VAPID_SUBJECT}
      - NAVIDROME_MUSIC_DIR=/music   # only with the music volume
      - AUDIOBOOKS_DIR=/audiobooks   # only with the audiobook volume
      - MAX_ACTIVE_JOBS=2
      - TZ=Etc/UTC                   # your time zone
    volumes:
      - ./data:/data
      - ./downloads:/downloads
      - ./music:/music
      - ./audiobooks:/audiobooks
```

The image already sets `DATA_DIR=/data` and `DOWNLOAD_DIR=/downloads`. Every
other setting is in the [configuration reference](configuration.md).

## 6. Start and update

```bash
docker compose up -d --build
docker logs -f grabbit
```

Open `http://<your-host>:3000` and sign in with `GRABBIT_PASSWORD`.

The source is copied into the image, so every update is a rebuild:

```bash
git pull
docker compose up -d --build
```

To pin the release identity that `/api/health` reports, pass the commit as a
build argument:

```yaml
    build:
      context: .
      args:
        RELEASE_SHA: ${RELEASE_SHA:-unknown}
```

```bash
RELEASE_SHA=$(git rev-parse HEAD) docker compose up -d --build
```

## 7. Reverse proxy

To expose Grabbit with HTTPS and a host name, remove `ports:` and join the
container to your proxy's network. A Traefik example:

```yaml
    networks:
      - proxy
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.grabbit.rule=Host(`grabbit.example.com`)"
      - "traefik.http.routers.grabbit.entrypoints=https"
      - "traefik.http.routers.grabbit.tls=true"
      - "traefik.http.services.grabbit.loadbalancer.server.port=3000"

networks:
  proxy:
    external: true
```

Caddy, nginx and other proxies work the same way: point them at port 3000. If
your proxy sets `X-Forwarded-For`, set `GRABBIT_TRUST_PROXY` to its address.

The password gate applies to every request, including requests from the
internal network. Only a request that carries `X-Grabbit-Token` matching
`GRABBIT_INTERNAL_TOKEN` skips it.

## 8. Optional integrations

Grabbit is complete without these. Each one is a **separate application**
that you install and run yourself, following its own README.

### TikShortis (native short-video pages)

1. Install [TikShortis](https://github.com/tjelite1986/tikshortis).
2. Make its API reachable from the Grabbit container, for example on a shared
   Docker network.
3. Add to the Grabbit service:

   ```yaml
      - TIKSHORTIS_MODE=native
      - TIKSHORTIS_API_URL=http://tikshortis:3000   # your TikShortis address
   ```

4. Restart, open **TikShortis** in the hub and sign in with your TikShortis
   account to link it.

To let Grabbit file finished shorts into TikShortis's library, also mount
that library and set `TIKSHORTIS_ROOT`.

### Elitogram (Social & Photos)

1. Install [Elitogram](https://github.com/tjelite1986/elitogram).
2. Add to the Grabbit service:

   ```yaml
      - EGRAM_MODE=native
      - EGRAM_API_URL=http://elitogram:3000         # your Elitogram address
   ```

3. Restart, open **Social & Photos** and sign in with your Elitogram account.

Optional: `POSTS_TO_EGRAM=1` with `EGRAM_IMPORT_DIR` drops downloaded images
into Elitogram's import folder. `EGRAM_LIBRARY_DIR` lets the duplicate
manager read Elitogram's media folder.

### Duplicate adapters

To let the duplicate manager ask TikShortis or Elitogram about shared copies,
create one file that holds a random key of at least 32 characters. Mount it
read-only into Grabbit and into the app, and point `GRABBIT_DEDUPE_TOKEN_FILE`
at it on both sides. A Compose `secret` works well for this.

### AI Photo Engine

Nothing to install for Docker: `onnxruntime-node` is part of the image when
its prebuilt binary supports your platform. Open **Duplicates → Settings**
and press **Get model** for the Light model (44 MB). The download comes from
GitHub and is checked against a pinned size and SHA-256.

## Running without Docker

Install Node.js 20 or newer (22 recommended), yt-dlp and ffmpeg. For music and
audiobook tags you also need Python 3 with mutagen
(`pip install mutagen`). For galleries and browser impersonation, add
gallery-dl and curl_cffi.

```bash
git clone https://github.com/tjelite1986/grabbit.git
cd grabbit
npm install
GRABBIT_PASSWORD=change-me npm start
```

Open `http://localhost:3000`. Files land in `./downloads` and state in
`./data`, unless you set `DOWNLOAD_DIR` and `DATA_DIR`. Press `Ctrl+C` to
stop.
