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

Each optional folder comes as a pair with its volume line and its
environment line in the Compose file below. Leave out all three when you skip
the folder.

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
sudo chown -R 1000:1000 data downloads
# and music / audiobooks if you created them
```

## 4. Secrets (.env)

Create `.env` in the same folder. Docker Compose reads it automatically for
the `${...}` values in the Compose file. The repository's `.gitignore` and
`.dockerignore` exclude it, so it is neither committed nor copied into the
image.

Generate the password instead of typing one. The server accepts any
non-empty value:

```bash
printf 'GRABBIT_PASSWORD=%s\n' "$(openssl rand -hex 16)" > .env
```

Then add the optional values you need:

```dotenv
# Required. The server refuses to start without a password.
GRABBIT_PASSWORD=<generated above>
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

Generate strong values with `openssl rand -hex 32`.

## 5. Compose file

Save as `docker-compose.yml`:

```yaml
services:
  grabbit:
    build: .                       # build the image from this folder
    container_name: grabbit
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"      # this machine only; remove when a reverse proxy fronts Grabbit
    # user: "1000:1000"            # see Permissions above
    environment:
      - GRABBIT_PASSWORD=${GRABBIT_PASSWORD}
      - GRABBIT_SECRET=${GRABBIT_SECRET}
      - GRABBIT_INTERNAL_TOKEN=${GRABBIT_INTERNAL_TOKEN}
      - GRABBIT_VAPID_PUBLIC=${GRABBIT_VAPID_PUBLIC}
      - GRABBIT_VAPID_PRIVATE=${GRABBIT_VAPID_PRIVATE}
      - GRABBIT_VAPID_SUBJECT=${GRABBIT_VAPID_SUBJECT}
      - NAVIDROME_MUSIC_DIR=/music   # pair: remove with the ./music volume
      - AUDIOBOOKS_DIR=/audiobooks   # pair: remove with the ./audiobooks volume
      - MAX_ACTIVE_JOBS=2
      - TZ=Etc/UTC                   # your time zone
    volumes:
      - ./data:/data
      - ./downloads:/downloads
      - ./music:/music             # optional pair, see above
      - ./audiobooks:/audiobooks   # optional pair, see above
```

The image already sets `DATA_DIR=/data` and `DOWNLOAD_DIR=/downloads`. Every
other setting is in the [configuration reference](configuration.md).

## 6. Start and update

```bash
docker compose up -d --build
docker logs -f grabbit
```

### Signing in

> [!WARNING]
> The login cookie is always marked `Secure`. Browsers store such a cookie
> only over HTTPS or on `http://localhost`, so **signing in over plain HTTP to
> a LAN address such as `http://192.168.1.10:3000` does not work**: the login
> page accepts the password and then shows the login page again.

- **On the Grabbit machine itself:** open `http://localhost:3000`.
- **From another computer, for a first test:** forward the port over SSH,
  `ssh -L 3000:localhost:3000 you@your-server`, then open
  `http://localhost:3000` on your own computer.
- **For daily use:** put Grabbit behind an HTTPS reverse proxy
  ([section 7](#7-reverse-proxy)).

The Compose file above publishes port 3000 on `127.0.0.1` only, which matches
these options. On Docker Engine older than 28, hosts on the same network
segment can still reach a port published on `127.0.0.1`
([Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)),
so update Docker or firewall the port. Publishing it on every interface (`"3000:3000"`) makes the
login page reachable from your network without making sign-in work there.

The source is copied into the image, so every update is a rebuild:

```bash
git pull
docker compose up -d --build
```

To pin the release identity that `/api/health` reports, pass the commit as a
build argument:

```yaml
services:
  grabbit:
    # ...the settings from section 5 stay as they are...
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
services:
  grabbit:
    # ...the settings from section 5, without ports:...
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

Being on the internal network grants nothing. The password gate skips a
request only when `GRABBIT_INTERNAL_TOKEN` is set, the request carries the
same value in `X-Grabbit-Token`, **and** it has no `X-Forwarded-Host` header.
A request through a proxy that sets `X-Forwarded-Host` (Traefik, nginx and
Caddy configured as above do) therefore never qualifies. The login page, the
icons, manifest and service worker it needs, `GET`/`HEAD /api/health/release`
and `POST /logout` are public. See
[Authentication and access](configuration.md#authentication-and-access).

Configuration changes need `docker compose up -d`, which recreates the
container. `docker compose restart` keeps the old environment.

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

4. Run `docker compose up -d`, open **TikShortis** in the hub and sign in with your TikShortis
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

3. Run `docker compose up -d`, open **Social & Photos** and sign in with your Elitogram account.

Optional: `POSTS_TO_EGRAM=1` with `EGRAM_IMPORT_DIR` drops downloaded images
into Elitogram's import folder. `EGRAM_LIBRARY_DIR` lets the duplicate
manager read Elitogram's media folder.

### Duplicate adapters

To let the duplicate manager ask TikShortis or Elitogram about shared copies,
each adapter needs three things on the Grabbit side:

| Adapter | API address | Library mount | Shared key |
|---|---|---|---|
| TikShortis | `TIKSHORTIS_API_URL` | `TIKSHORTIS_ROOT` | `GRABBIT_DEDUPE_TOKEN_FILE` |
| Elitogram | `EGRAM_API_URL` | `EGRAM_LIBRARY_DIR` | `GRABBIT_DEDUPE_TOKEN_FILE` |

The key file holds a random key of at least 32 characters. Mount it read-only
into Grabbit and into the app, and point `GRABBIT_DEDUPE_TOKEN_FILE` at it on
both sides. A Compose `secret` works well for this. `EGRAM_IMPORT_DIR` is a
separate folder that the scanner reads as well; it does not connect the
adapter.

### AI Photo Engine

Nothing to install for Docker: `onnxruntime-node` is part of the image when
its prebuilt binary supports your platform. Open **Duplicates → Settings**
and press **Get model** for the Light model (44 MB). The download comes from
GitHub and is checked against a pinned size and SHA-256. Downloading the
model does not switch the engine on: turn on **AI comparison (DINOv2)** in the same
panel afterwards.

## Running without Docker

Install Node.js 22 or newer (the version the image uses, and the version
yt-dlp's YouTube challenge solver needs as its JavaScript runtime), ffmpeg,
and Python 3 with the `venv` module (on Debian and Ubuntu: `sudo apt install
python3 python3-venv ffmpeg`).

Many Linux distributions refuse a system-wide `pip install`, so put the Python
tools in a virtual environment inside the checkout:

```bash
git clone https://github.com/tjelite1986/grabbit.git
cd grabbit
python3 -m venv .venv
. .venv/bin/activate
pip install "yt-dlp[default]" mutagen gallery-dl curl_cffi
# yt-dlp only enables deno as a JavaScript runtime by default; use Node instead
mkdir -p ~/.config/yt-dlp && echo '--js-runtimes node' >> ~/.config/yt-dlp/config
npm install
```

`yt-dlp[default]` includes the YouTube challenge solver. mutagen is for music
and audiobook tags, gallery-dl for image galleries and curl_cffi for browser
impersonation; leave out the ones you do not need. See yt-dlp's
[EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS) for other setups.

Create a password and keep it, then start the server from the same shell, with
the virtual environment active so Grabbit finds the tools:

```bash
GRABBIT_PASSWORD="$(openssl rand -hex 16)"
echo "Your Grabbit password: $GRABBIT_PASSWORD"
mkdir -p data downloads
GRABBIT_PASSWORD="$GRABBIT_PASSWORD" DATA_DIR="$PWD/data" \
  DOWNLOAD_DIR="$PWD/downloads" npm start
```

Set `DATA_DIR` explicitly as shown: the server falls back to `./data`, but
the cookie store falls back to `/data/cookies`. Open `http://localhost:3000`
and sign in with the password you printed. Press `Ctrl+C` to stop.

The bare server listens on every interface (`0.0.0.0:3000`). If the machine is
on a shared network, block port 3000 with a firewall; an SSH forward (see
[Signing in](#signing-in)) is how you connect from another computer, but it
does not close the port.
