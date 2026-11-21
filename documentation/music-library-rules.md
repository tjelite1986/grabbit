# Music metadata and the library rules

Moved verbatim from `CLAUDE.md` (section "Music metadata and the library"). These rules are binding; `CLAUDE.md` links here.

- **Never send a raw video title to iTunes or Deezer.** Use `parseTrackTitle()` first:
  - Drop noise brackets and keep version brackets.
  - Split only on a spaced dash, so names like Jay-Z survive.
  - Then use `musicMetaLookup()` → `artistCatalogue()`.
- **Only `full` and `close` verdicts from `candidateMatch()` fill fields automatically.** Don't loosen title matching without the artist gate, or someone else's song ends up in the tags.
- **Keep the match surface apart from the write surface.** `matchNames[]` is for matching only. `artists[]` is written to tags, folders and the UI. Never widen a written field to make a match succeed. `foldName()` is for comparison only: mapping `ǫ`→q is fine there but wrong in a tag, so written names go through `plainName()`. Lookalike tables run before NFKD, because NFKD does not fold small capitals.
- **Genre NAMES are resolved by the exact tables (`GENRE_NORMALIZE`, `GENRE_VOCABULARY`).** Substring reading is only for free-text tag lines; it once turned "Indie Pop" into "Indie" and "R&B/Soul" into "Soul". Gate bulk genre writes on the vocabulary the library already uses.
- **`/api/music/edit` is not a partial update.** It recomputes the library path from artist + album + year + title (`musicLibraryTarget()`), so an omitted field moves the file. Echo every existing field back. Never test it against a real track.
- **Prefer `release_date` over `release_year`, and drop years outside 1900..next year** (YouTube Music has returned 1674). mutagen's mp3/m4a easy-tag maps silently skip `releasetype`. Opus keeps its tags on the stream (`ffprobe -show_entries stream_tags`), not the format.
