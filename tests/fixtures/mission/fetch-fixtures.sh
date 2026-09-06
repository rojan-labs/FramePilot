#!/usr/bin/env bash
# Copy real media into tests/fixtures/mission and record checksums (plan/system-mission P0).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${MISSION_MEDIA_DIR:-$HOME/Downloads}"
cp_if() { [ -f "$2" ] || cp "$SRC/$1" "$2"; }
mkdir -p "$HERE/broll" "$HERE/photos" "$HERE/music" "$HERE/ref"
cp_if "raw skating.mp4" "$HERE/speech-9min.mp4"
cp_if "Just How Hard Is It to Win the World Cup_.mp4" "$HERE/speech-9min-b.mp4"
cp_if "ultraship_loads_responsiveness.mp4" "$HERE/talk-1080p-98s.mp4"
cp_if "IMG_9005.mov" "$HERE/camera-4k60-40s.mov"
cp_if "IMG_9606.MOV" "$HERE/broll/b1-4k30-22s.mov"
cp_if "IMG_9254.MOV" "$HERE/broll/b2-4k60-9s.mov"
cp_if "IMG_8693.MOV" "$HERE/broll/b3-1080p60-15s.mov"
cp_if "ISOM_Batch1_Assignment1.mp4" "$HERE/broll/b4-1080p-50s.mp4"
cp_if "project_landspace_nature.mp4" "$HERE/vertical-30s.mp4"
cp_if "Edited.mp4" "$HERE/ref/fast-cut-vertical.mp4"
cp_if "IMG_9606.MOV" "$HERE/ref/slow-cinematic-4k.mov"
cp_if "ultraship_loads_responsiveness.mp4" "$HERE/ref/caption-talk.mp4"
# speech-9min-c: speech-9min-b's narration with real pauses cut into it.
#
# WHY this file is generated rather than fetched. Measuring silence removal and measuring
# transcript-grounded selection need one recording that has BOTH real words and real dead
# air, and no fetched fixture has both: `speech-9min.mp4` has 203 silent gaps and a 92%
# hallucinated transcript, while `speech-9min-b.mp4` has real narration and — at -30, -40
# and -50 dB alike — not one silent gap, because a music bed runs under it end to end. A
# case on either is scoring an agent against a fixture defect.
#
# The cut points are the sentence boundaries of speech-9min-b's transcript, thinned to a
# 2 s minimum spacing (116 of its 122), each taken at the midpoint of the gap between the
# sentence's last word and the next word's start — so no pause is spliced into a word.
# Video freezes on the last frame across each pause and the audio is true digital silence,
# which `silencedetect` finds at the engine's defaults (-30 dB / 0.5 s). Pause lengths
# cycle 0.8/1.6/2.4 s: +185 s over the source, 116 removable gaps, ~11.9 min total.
#
# Like the music below this is ffmpeg output, so its checksum tracks the local encoder —
# regenerate it and `manifest.json` together rather than expecting the byte-identical file.
FP_PAUSE_CUTS="5.25 15.41 21.9 25.33 32.38 38.69 47.02 49.9 55.97 65.1 72.46 75.18 82.88 88.86 92.3 97.74 103.9 108.22 112.125 115.97 120.22 122.78 127.42 133.815 137.98 142.22 144.46 148.3 154.38 156.62 160.14 165.82 169.56 173.98 177.98 182.86 186.7 191.58 196.285 200.93 205.18 207.42 210.94 215.5 220.675 225.58 231.26 233.57 239.09 246.7 251.26 257.26 259.65 263.26 265.5 269.82 274.78 278.775 282.38 286.45 291.89 295.42 301.73 305.26 314.3 317.74 321.735 324.22 329.18 331.73 335.735 338.22 340.94 347.42 351.325 354.86 360.14 363.88 367.02 371.42 375.155 379.66 386.46 389.74 393.58 398.38 406.11 409.57 412.53 419.01 423.82 426.86 429.5 433.74 437.015 440.54 443.5 447.485 453.84 460.77 465.58 469.72 473.645 479.485 483.405 490.055 494.14 498.045 501.41 504.22 506.54 509.845 514.86 517.02 520.45 525.33"
if [ ! -f "$HERE/speech-9min-c.mp4" ]; then
  SEGDIR="$(mktemp -d)"; : > "$SEGDIR/list.txt"; gaps=(0.8 1.6 2.4); i=0; prev=0
  for c in $FP_PAUSE_CUTS; do
    g=${gaps[$((i % 3))]}
    ffmpeg -v error -y -ss "$prev" -to "$c" -i "$HERE/speech-9min-b.mp4" \
      -vf "tpad=stop_mode=clone:stop_duration=$g" -af "apad=pad_dur=$g" \
      -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r 30000/1001 \
      -c:a aac -b:a 96k -ar 44100 -ac 2 "$SEGDIR/seg$(printf %03d $i).mp4"
    echo "file 'seg$(printf %03d $i).mp4'" >> "$SEGDIR/list.txt"
    prev="$c"; i=$((i+1))
  done
  ffmpeg -v error -y -ss "$prev" -i "$HERE/speech-9min-b.mp4" \
    -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r 30000/1001 \
    -c:a aac -b:a 96k -ar 44100 -ac 2 "$SEGDIR/seg$(printf %03d $i).mp4"
  echo "file 'seg$(printf %03d $i).mp4'" >> "$SEGDIR/list.txt"
  ffmpeg -v error -y -f concat -safe 0 -i "$SEGDIR/list.txt" -c copy "$HERE/speech-9min-c.mp4"
  rm -rf "$SEGDIR"
fi
# 60 real photos
i=0; for f in "$SRC"/*.jpg "$SRC"/*.jpeg "$SRC"/*.JPG; do [ -f "$f" ] || continue; i=$((i+1)); [ $i -le 60 ] || break; cp -n "$f" "$HERE/photos/p$(printf %02d $i).jpg" 2>/dev/null || true; done
# reference images: first 6 pngs/jpgs by role name
j=0; for role in logo mood thumbnail character colorchart design; do j=$((j+1)); src=$(ls "$SRC"/*.png 2>/dev/null | sed -n "${j}p"); [ -n "$src" ] && cp -n "$src" "$HERE/ref/$role.png" 2>/dev/null || true; done
# deterministic music: click + bass, 100 BPM (30 s) and a 128→140 BPM ramp (30 s)
[ -f "$HERE/music/beat-100bpm.wav" ] || ffmpeg -v error -f lavfi -i "sine=frequency=60:beep_factor=8:duration=30" -f lavfi -i "sine=frequency=1000:duration=30" -filter_complex "[1]volume='if(lt(mod(t,0.6),0.05),1,0)':eval=frame[c];[0][c]amix=inputs=2" -ar 44100 -ac 2 "$HERE/music/beat-100bpm.wav"
[ -f "$HERE/music/beat-ramp.wav" ] || ffmpeg -v error -f lavfi -i "sine=frequency=55:duration=30" -f lavfi -i "sine=frequency=900:duration=30" -filter_complex "[1]volume='if(lt(mod(t,0.46875-0.04*t/30),0.05),1,0)':eval=frame[c];[0][c]amix=inputs=2" -ar 44100 -ac 2 "$HERE/music/beat-ramp.wav"
# manifest
( cd "$HERE" && find . -type f \( -name '*.mp4' -o -name '*.mov' -o -name '*.wav' -o -name '*.jpg' -o -name '*.png' \) | sort | while read -r f; do printf '{"file":"%s","sha256":"%s","bytes":%s}\n' "${f#./}" "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$(stat -f%z "$f")"; done | jq -s '{generatedAt: (now|todate), files: .}' > manifest.json )
echo "fixtures ready: $(jq '.files|length' "$HERE/manifest.json") files"
