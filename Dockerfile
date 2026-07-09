FROM node:18-slim

# yt-dlp (generic video fallback) needs python3 + ffmpeg for merging;
# gallery-dl powers image-gallery extractors (e.g. imagefap).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp curl_cffi gallery-dl \
  && rm -rf /var/lib/apt/lists/*

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
