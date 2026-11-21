# Runtime

Which Node.js Grabbit runs on, and where the repository's statements disagree.
Verified against commit `73547d3`.

## The truth

| Source | Says |
|--------|------|
| `Dockerfile` | `FROM node:22-slim`. Its comment says yt-dlp needs Node 22+ as its JS runtime for YouTube challenges, and `/etc/yt-dlp.conf` sets `--js-runtimes node`. |
| `README.md`, `documentation/installation.md` | Node.js 22 or newer. |
| `package.json` | No `engines` field. |
| CI | No workflow files are tracked in this checkout (`git ls-files .github` is empty), so no CI Node version is known. |
| `CLAUDE.md` ("Target platform") | Says Node 20. **Out of date.** |
| Sandbox used for this documentation job | `node -v` printed v20.20.2. This is a tooling sandbox, not the deployed runtime. |

**Deployed runtime is Node 22**, because the image is what runs in
production (linux/arm64 on a Raspberry Pi and x86 Linux, behind a reverse
proxy). The "Node 20" statement in `CLAUDE.md` describes an older target and
does not match the Dockerfile. This job changes neither (documentation only,
no Dockerfile change). Whether to correct `CLAUDE.md` is listed below as a
follow-up decision.

Practical consequences:

- Code must run on Node 22 on linux/arm64. Code that also runs on Node 20 is
  safer, because tests in a Node 20 sandbox still pass. Do not rely on APIs
  newer than Node 20 without checking both.
- The unit suite ran green on Node 20 for the files tried in this job
  (`smart-routing`, `audience`). That is not a statement about Node 22.
- Any new native dependency must ship linux/arm64 builds (`better-sqlite3`
  and optional `onnxruntime-node` are the existing ones).

## External tools

Provided by the image: yt-dlp (pinned at build time, pip layer cached),
ffmpeg and ffprobe, Python 3 with mutagen, and optionally gallery-dl and
curl_cffi. Override binaries with `YTDLP_BIN`, `FFMPEG_BIN`, `FFPROBE_BIN`,
`PYTHON_BIN`. See `documentation/configuration.md`.

## Follow-up decisions (not fixed here)

The prior audit's discrepancies D1-D4 were in a report this job could not
read (the Bridge2 report was not available in the worktree). So the mapping
below is NOT confirmed to match the audit's D1-D4 numbering. These are the
mismatches observed independently in this job, for the Boss to match against
the report. None was changed.

| Ref | Observation | Decision needed |
|-----|-------------|-----------------|
| O1 | `CLAUDE.md` says Node 20; the Dockerfile, README and install guide say Node 22. | Correct `CLAUDE.md`, or add an `engines` field. |
| O2 | `README.md` says the suite has 49 test files; `test/` has 50. | Update the README count, or drop the number. |
| O3 | `package.json` has no `engines` and no CI workflow is tracked. | Decide whether to pin. |

If the audit's D1-D4 differ from O1-O3, treat the audit as authoritative and
replace this table.
