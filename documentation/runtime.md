# Runtime

Which Node.js Grabbit runs on. Verified against commit `73547d3`.

## The truth

| Source | Says |
|--------|------|
| Production container (owner-reported, `RELEASE_SHA` 73547d3) | `node -v` prints **v22.23.5**. Verified by the owner on the running container. |
| `Dockerfile` | `FROM node:22-slim`. Its comment says yt-dlp needs Node 22+ as its JS runtime for YouTube challenges, and `/etc/yt-dlp.conf` sets `--js-runtimes node`. |
| `README.md`, `documentation/installation.md` | Node.js 22 or newer. |
| `package.json` | No `engines` field. |
| CI | No workflow files are tracked in this checkout (`git ls-files .github` is empty), so no CI Node version is known. |
| `CLAUDE.md` ("Target platform") | Says Node 20 at this commit. A corrected wording is proposed in `documentation/claude-md-round2.patch` (see the job report); until it is applied the statement is out of date. |
| Tooling sandbox used for documentation jobs | `node -v` prints v20.20.2. A tooling sandbox, not the deployed runtime. |

Both facts hold:

1. **The deployed runtime is Node 22** (image and running production
   container, linux/arm64 on a Raspberry Pi and x86 Linux behind a reverse
   proxy).
2. **Code must also keep running on Node 20 until the owner decides
   otherwise.** This keeps the `CLAUDE.md` rule in force. Do not use APIs newer
   than Node 20 without checking both versions.

This documentation job does not change the Dockerfile.

Practical consequences:

- Tests may run in a Node 20 sandbox. A green run there says nothing about
  Node 22. The unit suite was only partly run on Node 20 in this job.
- Any new native dependency must ship linux/arm64 builds (`better-sqlite3`
  and optional `onnxruntime-node` are the existing ones).

## External tools

Provided by the image (see `Dockerfile`):

- yt-dlp, installed as `yt-dlp[default]` **unpinned**: the version is whatever
  pip resolves at build time, and the pip layer is cached. Reproduce a site
  failure with a current yt-dlp before changing extractor code.
- gallery-dl and curl_cffi, installed unconditionally, plus mutagen.
- ffmpeg and ffprobe, and Python 3.

Outside Docker (`documentation/installation.md`) the tools are installed by
hand and some may be left out. Override binaries with `YTDLP_BIN`,
`FFMPEG_BIN`, `FFPROBE_BIN`, `PYTHON_BIN`. See `documentation/configuration.md`.

## Decisions

Open owner decisions, including the Node follow-up (O1), are in
`documentation/open-decisions.md`.
