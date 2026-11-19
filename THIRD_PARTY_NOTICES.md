# Third-party notices

Grabbit is released under the [MIT License](LICENSE). It builds on the work
listed below. This file is the attribution that `dupe-ai.js` refers to.

## Adapted code

### photo-duplicate-finder-ai

The AI Photo Engine (`dupe-ai.js`) adapts the model catalogue and file sizes,
the image preprocessing (short side to 256 bicubic, centre crop 224, ImageNet
mean/std), the L2-normalised CLS embeddings, the per-model similarity
thresholds and their sensitivity span from
[photo-duplicate-finder-ai](https://github.com/nikweel/photo-duplicate-finder-ai).

```text
MIT License

Copyright (c) 2026 Nikolay Fedotov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Models (downloaded on request, not shipped in this repository)

| Model | Licence | Source |
|---|---|---|
| DINOv2 small / base / large, ONNX export | Apache-2.0 (DINOv2, Meta Platforms) | ONNX files published by photo-duplicate-finder-ai, release `v0.1` |

The model file is fetched only when the owner presses **Get model** in
Duplicates → Settings, and its size and SHA-256 are checked before use.

## npm dependencies

| Package | Licence |
|---|---|
| [express](https://github.com/expressjs/express) | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT |
| [web-push](https://github.com/web-push-libs/web-push) | MPL-2.0 |
| [html-to-image](https://github.com/bubkoo/html-to-image) | MIT |
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) (optional) | MIT |

## Programs installed in the Docker image

These run as separate programs (child processes). They are installed by the
`Dockerfile` from Debian and PyPI and keep their own licences.

| Program | Licence |
|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense |
| [FFmpeg](https://ffmpeg.org/) (Debian build) | LGPL-2.1+ / GPL-2.0+ depending on build options |
| [gallery-dl](https://github.com/mikf/gallery-dl) | GPL-2.0 |
| [mutagen](https://github.com/quodlibet/mutagen) | GPL-2.0+ |
| [curl_cffi](https://github.com/lexiforest/curl_cffi) | MIT |
| [Node.js](https://nodejs.org/) | MIT |
| [Python](https://www.python.org/) | PSF License |

## Documentation assets

The README banner (`assets/brand/`) embeds small subsets of
[Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) and
[Inter](https://github.com/rsms/inter), both under the SIL Open Font
License 1.1. The mascot is Grabbit's own (`public/logo.svg`).
