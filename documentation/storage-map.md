# Storage map

Everything Grabbit remembers lives under `DATA_DIR` (`/data` in the image,
`./data` outside Docker). Verified against commit `73547d3` by grepping
`path.join(DATA_DIR, ...)`. This file lists names and roles only; it holds no
paths from a real host and no secret values.

Rules that apply to all of it are in `CLAUDE.md` ("Writing files safely"):
write with `writeJsonAtomic()`, read with `readJsonState()`, quarantine
unparseable files as `.corrupt-<stamp>`, never write a rebuilt copy over the
original, and change state through the API because the server caches it.

## Snapshotted JSON state (`STATE_FILES` in `server.js`)

Daily snapshots go to `DATA_DIR/backups/` and are kept `STATE_BACKUP_DAYS`
days (default 7). `/api/health` reports them.

| File | Owner (code) | Holds |
|------|--------------|-------|
| `downloaded.json` | `server.js` | Dedup registry (most important) |
| `music.json` | `server.js` | Music library index |
| `history.json` | `server.js` | Last 200 finished or failed jobs |
| `playlists.json` | `server.js` | Watched playlists |
| `rules.json` | `server.js` (`sanitizeRules`) | Download rules |
| `templates.json` | `server.js` | Output templates |
| `scheduled.json` | `server.js` | Scheduled downloads |
| `retry-queue.json` | `server.js`, `retry-queue.js` | Retryable failures with backoff |
| `genres.json` | `server.js` | Genre vocabulary |
| `push-subscriptions.json` | `server.js` | Web Push subscriptions (sensitive) |
| `gda-clients.json` | `gda-admin.js` | Per-app API clients (sensitive) |
| `profiles.json` | `profiles.js`, `server.js` | Creator profiles |
| `inbox-settings.json` | `server.js`, `inbox.js` | Inbox settings |

## Other stores (not in `STATE_FILES`)

| Path | Owner | Notes |
|------|-------|-------|
| `items.db` | `item-store.js` | SQLite (WAL). Migrations copy the DB first (`VACUUM INTO`). A newer DB than the code is refused. |
| `dupes.db` | `dupe-store.js` | SQLite for the Duplicate Manager |
| `dupe-trash/` | `dupe-trash.js` | Duplicates set aside, restorable |
| `dupe-thumbs/`, `thumbs/`, `covers/` | `server.js` | Regenerable caches |
| `models/` | `dupe-ai.js` | Optional AI model files |
| `routing.jsonl` (+ `.1`) | `server.js` | Routing decision log, rotated at 5 MB |
| `server.log` (+ rotation) | `server.js` | Server log |
| `cookies/` | `cookies.js` | yt-dlp cookie files (sensitive) |
| `egram-seal.key` | `server.js` | Session sealing key (sensitive). Only created when neither `GRABBIT_SECRET` nor a password is set (`egramSealSecret()`) |
| `inbox/` | `server.js`, `inbox.js` | Inbox staging |
| `backups/` | `server.js` | Daily snapshots of `STATE_FILES` |

## Backup and rollback

- Back up the whole `DATA_DIR` while the container is stopped, or rely on the
  daily snapshots for the JSON files only. SQLite files need a copy of the
  `-wal` and `-shm` files too, or a stopped container.
- Restore a JSON file by copying a snapshot from `backups/` back with the
  container stopped. The server restores from the newest snapshot itself when
  it finds a corrupt file.
- Rolling back to an older image: `items.db` is refused if newer than the code
  (`scripts/library-downgrade-v6.js` and `library-downgrade.test.js` cover the
  library downgrade). Take a copy of `DATA_DIR` before upgrading.
- Never delete or blanket-clean `DATA_DIR` to tidy after a test; remove only
  files the test created.
- Media folders (`DOWNLOAD_DIR`, music, audiobooks, app import folders) are
  outside `DATA_DIR` and are not covered by snapshots.
