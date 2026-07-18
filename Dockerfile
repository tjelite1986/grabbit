# node >= 22: also serves as yt-dlp's JS runtime for YouTube's JS challenges
# (extraction without one is deprecated and flaky; yt-dlp requires node 22+).
FROM node:22-slim

# yt-dlp (generic video fallback) needs python3 + ffmpeg for merging; the
# [default] extra bundles yt-dlp-ejs (YouTube JS challenge solver scripts);
# gallery-dl powers image-gallery extractors (e.g. imagefap); mutagen is
# yt-dlp's tag writer for embedding cover art into opus/ogg audio.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" curl_cffi gallery-dl mutagen \
  && rm -rf /var/lib/apt/lists/*

# Only deno is enabled as a JS runtime by default; point yt-dlp at node for
# every invocation (system-wide config).
RUN printf -- "--js-runtimes node\n" > /etc/yt-dlp.conf

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV SAVE_DIR=/data

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server.js"]
