#!/usr/bin/env bash
#
# make-demo-gif.sh — compress a recorded demo video into the GIF used in the README.
#
# Pairs with scripts/record-demo.py (that one records, this one converts). By default it reads the newest
# clip in recordings/ and writes docs/assets/demo.gif — the one the README's "Demo" section references.
#
# Usage:
#   scripts/make-demo-gif.sh                          # newest clip in recordings → docs/assets/demo.gif
#   scripts/make-demo-gif.sh recordings/xxx.mp4       # specify input
#   scripts/make-demo-gif.sh in.mp4 out.gif 12 900 128  # input output fps width colors
#
# Three steps (all so the text in the README is readable and the file stays small):
#   1) cropdetect auto-detects the window and crops the black border around the recording (a full
#      1920×1080 capture where the window only occupies a corner);
#   2) palettegen builds a palette from the whole clip's color statistics (GIF has only 256 colors;
#      without this you get banding);
#   3) paletteuse converts the video to a GIF with that palette, bayer dithering (friendliest to UI text
#      and smaller than sierra).
#
# Depends on: ffmpeg (with ffprobe).
set -euo pipefail

cd "$(dirname "$0")/.."

IN="${1:-}"
OUT="${2:-docs/assets/demo.gif}"
FPS="${3:-15}"
WIDTH="${4:-1000}"
COLORS="${5:-256}"

# No input given → pick the newest clip in recordings/
if [ -z "$IN" ]; then
  IN="$(ls -t recordings/*.mp4 recordings/*.mkv recordings/*.webm 2>/dev/null | head -1 || true)"
fi
if [ -z "$IN" ] || [ ! -f "$IN" ]; then
  echo "No input video found. Record one first: scripts/record-demo.py -d 30" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
PAL="$(mktemp -t wg-palette-XXXXXX.png)"
trap 'rm -f "$PAL"' EXIT

# 1) Crop the black border: run cropdetect on the 2–5s stretch (window already stable) and take the last crop
CROP="$(ffmpeg -v info -ss 2 -t 3 -i "$IN" -vf cropdetect=24:2:0 -f null - 2>&1 \
  | grep -o 'crop=[0-9:]*' | tail -1 || true)"
if [ -z "$CROP" ]; then
  echo "cropdetect found no crop region; converting the full frame (the GIF will be larger for a full-screen recording)" >&2
  CROP="crop=iw:ih:0:0"
fi
echo "[1/3] crop: $CROP"

VF="fps=${FPS},${CROP},scale=${WIDTH}:-1:flags=lanczos"

echo "[2/3] generating palette (${COLORS} colors)…"
ffmpeg -v error -i "$IN" -vf "${VF},palettegen=max_colors=${COLORS}:stats_mode=diff" -y "$PAL"

echo "[3/3] converting to GIF → $OUT"
ffmpeg -v error -i "$IN" -i "$PAL" \
  -lavfi "${VF}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -y "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "done: $OUT ($SIZE)"
echo "Just commit it — this is the path the README's \"Demo\" section references."
