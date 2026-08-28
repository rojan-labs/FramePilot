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
