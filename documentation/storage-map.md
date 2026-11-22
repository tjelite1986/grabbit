# Storage map

Everything Grabbit remembers lives under `DATA_DIR` (`/data` in the image,
`./data` outside Docker). Verified against commit `73547d3` by grepping
`path.join(DATA_DIR, ...)`. This file lists names and roles only; it holds no
paths from a real host and no secret values. Media directories are
configured independently of `DATA_DIR` (see `documentation/configuration.md`).

Rules that apply to all of it are in `CLAUDE.md` ("Writing files safely"):
write with `writeJsonAtomic()`, read with `readJsonState()`, quarantine
unparseable files as `.corrupt-<stamp>`, never write a rebuilt copy over the
original, and change state through the API because the server caches it.
`writeJsonAtomic()` writes a temp file in the same directory, fsyncs it, then
renames it over the target, so a process crash leaves either the old or the
new file, never a half-written one. The parent directory is not fsynced after
the rename, so the rename itself is not guaranteed to survive a power loss
(the old file can come back).

## Snapshotted JSON state (`STATE_FILES` in `server.js`)

Daily snapshots go to `DATA_DIR/backups/<YYYY-MM-DD>/`. `/api/health` reports
them.

- `STATE_BACKUP_DAYS` (default 7) counts dated folders, not calendar days; the
  oldest folders beyond the count are pruned. `0` disables snapshots.
- A day that already has a folder is skipped, so the snapshot is the state as
  of the first start that day, not of the end of the day.
- `items.db` and `dupes.db` are also copied into the dated folder, best effort
  (consistent SQLite `VACUUM INTO` copy; a failure is only logged).

| File | Owner (code) | Holds |
|------|--------------|-------|
| `downloaded.json` | `server.js` | Dedup registry (most important) |
| `music.json` | `server.js` | Music library index |
| `history.json` | `server.js` | Up to 200 recent records (finished or failed jobs, including synchronous activity) |
| `playlists.json` | `server.js` | Watched playlists |
| `rules.json` | `server.js` (`sanitizeRules`) | Download rules |
| `templates.json` | `server.js` | Output templates |
| `scheduled.json` | `server.js` | Scheduled downloads |
| `retry-queue.json` | `server.js`, `retry-queue.js` | Retryable failures with backoff |
| `genres.json` | `server.js` | Genre vocabulary |
| `push-subscriptions.json` | `server.js` | Web Push subscriptions (sensitive) |
| `gda-clients.json` | `gda.js` (registry read/write), `gda-admin.js` (CLI) | Per-app API clients (sensitive) |
| `profiles.json` | `profiles.js`, `server.js` | Creator profiles |
| `inbox-settings.json` | `server.js`, `inbox.js` | Inbox settings |
| `thumb-index.json` | `thumb-index.js`, `server.js` | Thumbnail provenance: which entries, jobs, items or previews each cached picture belongs to. `/api/thumb` serves or fetches only an indexed picture, to a view its strictest provenance allows. |

## Other stores (not in `STATE_FILES`)

| Path | Owner | Notes |
|------|-------|-------|
| `items.db` | `item-store.js` | SQLite (WAL). Migrations copy the DB first (`VACUUM INTO`). A newer DB than the code is refused. |
| `dupes.db` | `dupe-store.js` | SQLite for the Duplicate Manager |
| `dupe-trash/` | `dupe-trash.js` | Duplicates set aside, restorable |
| `dupe-thumbs/` | `dupe-routes.js` | Regenerable thumbnail cache |
| `thumbs/`, `covers/` | `server.js` | Regenerable caches. In `thumbs/`, `<sha1>.<ext>` is a picture fetched from its site URL, `keep-<tag>-<sha1>.<ext>` one made again from an entry's own file, and `f-<sha1>.<ext>` a frame Grabbit took for one entry. The first start with `thumb-index.json` moved every older file into `thumbs/quarantine-<stamp>/`; those files are never served and can be deleted by hand. |
| `models/` | `dupe-ai.js` | Optional AI model files |
| `routing.jsonl` (+ `.1`) | `server.js` (`logRoutingDecision()`) | Smart Routing log. Best effort (a write failure is only a warning). Holds source URLs and creator names: **treat as sensitive**. A logged decision can lack a history row (open decision D4). |
| `server.log` (+ `.1`) | `server.js` | Server log |
| `cookies/` | `cookies.js` | yt-dlp cookie files (sensitive). Defaults to `/data/cookies` unless configured, so set it explicitly outside Docker. |
| `egram-seal.key` | `server.js` (`egramSealSecret()`) | Session sealing key (sensitive). Created only when the native Elitogram gateway initialises, neither `GRABBIT_SECRET` nor a password is set, and the file does not exist. |
| `inbox/` | `server.js`, `inbox.js` | `staged/` staged files, `redrops/`, and `shadow.jsonl` (shadow log) |
| `backups/` | `server.js` | Dated snapshot folders |

Both logs rotate the same way: when the existing file is larger than 5 MiB
before an append, it is renamed to `.1` (replacing an older `.1`) and a new
file starts.

## What happens when a state file does not parse

Precisely, from `readJsonState()`:

1. Any error reading the file (missing, but also unreadable) returns the
   fallback silently, exactly like a fresh install.
2. An unparseable file is renamed to `<name>.corrupt-<stamp>` (best effort;
   if the rename fails the original stays in place).
3. Only the **newest dated folder that holds a nonempty copy** of that file is
   tried (`newestSnapshot()`). That can be an older folder when newer ones lack
   the file. If that copy does not parse either, no older day is tried.
4. A snapshot that parses is written back to the original path with
   `writeJsonAtomic()` and logged as "restored from the snapshot of
   YYYY-MM-DD". It only counts as restored when that write succeeds; if the
   write fails, the server logs that the snapshot is damaged too and falls
   back. If the quarantine rename failed, this write replaces the damaged
   original.
5. With no usable snapshot the fallback is returned ("starting empty").

Exceptions:

- `downloaded.json`: when `readJsonState()` returns the fallback (any read
  error, or no usable snapshot) or a value that is not an object,
  `readDownloaded()` seeds the registry from `history.json` and writes it
  (best effort). History writes keep at most 200 rows (`HISTORY_MAX`), but the
  read does not cap it; rows without a URL add nothing, so the seed usually
  holds fewer entries. This is the open decision
  D1 in `documentation/open-decisions.md`; do not rely on it as recovery.
- `profiles.json` fails closed. After a failed recovery it writes
  `profiles.json.damaged` and refuses every read until the owner repairs the
  kept `.corrupt` file, removes the marker and restarts. The read-only path
  (`readProfilesReadOnly()`) never restores from a snapshot; it throws.
- `gda-clients.json` is read by `gda.js`, not `readJsonState()`. An unparseable
  file loads no app clients (the shared password still works) and is logged.
  It is not quarantined or restored.

## After a crash, check first

1. Before restarting, copy the damaged file and any `*.corrupt-*` copy to a
   safe place outside `DATA_DIR`. If the quarantine rename fails on the next
   start, the damaged original stays at its path, and it is replaced as soon
   as a write to that path succeeds: a restored snapshot, or for
   `downloaded.json` the registry `readDownloaded()` seeds from history (D1).
   A file that cannot be read at all is never quarantined and is replaced the
   same way.
2. `ls DATA_DIR/*.corrupt-* DATA_DIR/*.damaged` (any hit means damage was seen).
3. `server.log` (and `.1`): search for `did not parse`, `restored from the
   snapshot`, `no usable snapshot`, `snapshot failed`.
4. `routing.jsonl` (sensitive) for the last routing decisions, if the issue
   is about where a video went.
5. `GET /api/health` for snapshot status.

## Backup and rollback

- Preferred consistent backup: stop the container, then copy the whole
  `DATA_DIR`. Alternatively use the dated snapshot folders, whose SQLite
  copies are consistent. **Do not copy a live `items.db`, `dupes.db` or their
  `-wal`/`-shm` files as a backup**: a live copy can be inconsistent.
- Restore a JSON file by copying it from a `DATA_DIR/backups/YYYY-MM-DD/`
  folder with the container stopped. The newest folder may not hold the file,
  and automatic recovery may have used an older retained folder, so a restored
  copy can be several days old: registry entries added after that date are
  lost, and those items may download again. Check the date of the folder the
  file came from (for a manual restore, the folder you copied from; after
  automatic recovery, `server.log` names it: "restored from the snapshot of
  YYYY-MM-DD"), and before relying on a folder check that the expected SQLite
  copies (`items.db`, `dupes.db`) exist there, because those copies are best
  effort.
- After a restore, check: the container starts without `.corrupt-*` or
  `.damaged` messages in `server.log`; `/api/health` is ok; and a known
  downloaded URL is still reported as downloaded. Signed in, open
  `/api/resolve?url=<a URL you downloaded>` and check that the JSON field
  `downloaded` is `true` (this resolves the URL online through its extractor).
- Rolling back to an older image: `items.db` is refused if newer than the
  code. `scripts/library-downgrade-v6.js` only downgrades the item schema from
  v6 to v5 (covered by `test/library-downgrade.test.js`). Take a copy of
  `DATA_DIR` before upgrading.
- Never delete or blanket-clean `DATA_DIR` to tidy after a test; remove only
  files the test created.
- Media folders (`DOWNLOAD_DIR`, music, audiobooks, app import folders) are
  outside `DATA_DIR` and are not covered by snapshots.
