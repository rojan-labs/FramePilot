#!/usr/bin/env bash
# Regenerate the real-texture plates from the mission b-roll (MK7.5).
#
# The mission media is not committed (tests/fixtures/mission/fetch-fixtures.sh); these three
# stills are small, people-free crops of it, committed so the real-texture tracking gates run on
# every pack runner. Each crop was chosen to hold no person, face or plate. ffmpeg auto-rotates
# the portrait phone clips, so the crop coordinates are in the displayed (portrait) frame.
set -euo pipefail
MEDIA="${MISSION_MEDIA_DIR:-$(git rev-parse --show-toplevel)/tests/fixtures/mission}/broll"
OUT="$(cd "$(dirname "$0")" && pwd)"
plate() { # name clip seconds crop scale
  ffmpeg -v error -y -ss "$3" -i "$MEDIA/$2" -frames:v 1 \
    -vf "crop=$4,scale=$5:flags=area" -q:v 3 "$OUT/$1.jpg"
}
plate hillside b1-4k30-22s.mov 2 2160:1215:0:2500 1600:900     # sunlit foliage on a slope
plate forest   b2-4k60-9s.mov  6 1280:720:880:360 1280:720     # trees and a trunk, right of the pole
plate night    b3-1080p60-15s.mov 2 1080:608:0:1250 1080:608   # low-light road edge, pavement, bench
( cd "$OUT" && shasum -a 256 ./*.jpg > SHA256SUMS )
