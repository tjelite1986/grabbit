#!/usr/bin/env bash
# Generates harmless test media (ffmpeg test patterns) for the Smart Duplicate
# Manager's engine tests, accuracy checks and screenshots.
# Usage: scripts/dupes-fixtures.sh <new target dir>
set -euo pipefail
T="${1:?target dir}"
mkdir -p "$T/photos" "$T/videos" "$T/tik/main/creator" "$T/egram/_thumbs/01" "$T/egram/creator" "$T/tmp"
f() { ffmpeg -nostdin -v error -y "$@"; }
# Photos: an original, an exact copy, resized, recompressed, cropped, rotated,
# colour-shifted, converted, and a different shot of the same scene.
f -f lavfi -i "testsrc2=size=1600x1200:rate=1" -frames:v 1 -q:v 2 "$T/photos/original.jpg"
cp "$T/photos/original.jpg" "$T/photos/original-copy.jpg"
f -i "$T/photos/original.jpg" -vf scale=800:600 -q:v 2 "$T/photos/resized.jpg"
f -i "$T/photos/original.jpg" -q:v 25 "$T/photos/recompressed.jpg"
f -i "$T/photos/original.jpg" -vf "crop=1500:1130:50:35" -q:v 3 "$T/photos/cropped.jpg"
f -i "$T/photos/original.jpg" -vf "transpose=1" -q:v 3 "$T/photos/rotated.jpg"
f -i "$T/photos/original.jpg" -vf "eq=brightness=0.06:saturation=1.3" -q:v 3 "$T/photos/brighter.jpg"
f -i "$T/photos/original.jpg" "$T/photos/converted.png"
f -f lavfi -i "testsrc2=size=1600x1200:rate=25" -ss 7 -frames:v 1 -q:v 2 "$T/photos/same-shoot-other-frame.jpg"
f -f lavfi -i "mandelbrot=size=1200x900:rate=1" -frames:v 1 -q:v 2 "$T/photos/unrelated.jpg"
# Videos: an original, an exact copy, re-encodes, a clip, and a video that
# shares only its intro.
f -f lavfi -i "testsrc2=size=1280x720:rate=25" -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 40 -c:v libx264 -preset veryfast -g 25 -c:a aac -shortest "$T/videos/original.mp4"
cp "$T/videos/original.mp4" "$T/videos/original-copy.mp4"
f -i "$T/videos/original.mp4" -vf scale=640:360 -c:v libx264 -preset veryfast -crf 30 -g 30 -c:a aac -b:a 64k "$T/videos/reencoded-360p.mp4"
f -i "$T/videos/original.mp4" -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 -g 50 -c:a libopus "$T/videos/converted.webm"
f -ss 12 -i "$T/videos/original.mp4" -t 12 -c:v libx264 -preset veryfast -g 25 -c:a aac "$T/videos/clip-12s.mp4"
f -f lavfi -i "testsrc2=size=1280x720:rate=25" -t 6 -c:v libx264 -preset veryfast -g 25 "$T/tmp/intro.mp4"
f -f lavfi -i "mandelbrot=size=1280x720:rate=25" -t 34 -c:v libx264 -preset veryfast -g 25 "$T/tmp/rest.mp4"
printf "file '%s'\nfile '%s'\n" "$T/tmp/intro.mp4" "$T/tmp/rest.mp4" > "$T/tmp/list.txt"
f -f concat -safe 0 -i "$T/tmp/list.txt" -c copy "$T/videos/same-intro-other-video.mp4"
rm -f "$T/tmp/intro.mp4" "$T/tmp/rest.mp4" "$T/tmp/list.txt"
rmdir "$T/tmp"
# An app library: two identical clips (two posts) with their posters.
f -f lavfi -i "smptehdbars=size=720x1280:rate=25" -f lavfi -i "sine=frequency=330" -t 8 -c:v libx264 -preset veryfast -c:a aac -shortest "$T/tik/main/creator/clip-a.web.mp4"
cp "$T/tik/main/creator/clip-a.web.mp4" "$T/tik/main/creator/clip-b.web.mp4"
f -i "$T/tik/main/creator/clip-a.web.mp4" -frames:v 1 "$T/tik/main/creator/poster-a.jpg"
cp "$T/tik/main/creator/poster-a.jpg" "$T/tik/main/creator/poster-b.jpg"
# Generated thumbnails, old and new naming.
f -i "$T/photos/original.jpg" -vf scale=480:-1 "$T/egram/_thumbs/01/m101_480.webp"
cp "$T/egram/_thumbs/01/m101_480.webp" "$T/egram/_thumbs/01/m101-abcdef012345_480.webp"
cp "$T/photos/unrelated.jpg" "$T/egram/creator/post_1.jpg"
echo "fixtures in $T"
