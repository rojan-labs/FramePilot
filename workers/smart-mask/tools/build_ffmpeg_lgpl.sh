#!/usr/bin/env bash
# Build the LGPL-only ffmpeg + ffprobe the Smart Mask pack ships in bin/ (plan 02).
#
# Why a source build: PyAV wheels bundle libx264/libx265 (GPL), and common macOS binaries
# (Homebrew, evermeet) are configured with --enable-gpl. This recipe enables nothing GPL or
# nonfree and only what the pack needs: decoders for camera/editor formats, the FFV1 codec,
# libvpx (BSD) for VP9 previews, matroska/webm muxing, the scale filter.
#
#   tools/build_ffmpeg_lgpl.sh <output-dir>
#
# The pinned source tarball is verified by sha256 before anything is built. The result is
# checked by media.assess_ffmpeg_build and by tools/generate_sbom.py --check.
set -euo pipefail

VERSION="7.1.1"
SHA256="733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
OUT="${1:?usage: build_ffmpeg_lgpl.sh <output-dir>}"
WORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.cache/ffmpeg-lgpl"
mkdir -p "$WORK" "$OUT"
OUT="$(cd "$OUT" && pwd)"
cd "$WORK"
[[ -f "ffmpeg-$VERSION.tar.xz" ]] || curl -sSLo "ffmpeg-$VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
echo "$SHA256  ffmpeg-$VERSION.tar.xz" | shasum -a 256 -c -
rm -rf "ffmpeg-$VERSION" && tar xf "ffmpeg-$VERSION.tar.xz"
cd "ffmpeg-$VERSION"
./configure \
  --prefix="$WORK/install" \
  --disable-gpl --disable-nonfree --disable-version3 \
  --disable-autodetect --enable-videotoolbox --enable-zlib \
  --disable-doc --disable-network --disable-ffplay --disable-devices \
  --disable-shared --enable-static \
  --enable-libvpx \
  --disable-encoders --enable-encoder=ffv1,libvpx_vp9,rawvideo,png \
  --disable-muxers --enable-muxer=matroska,webm,rawvideo,image2,null \
  --disable-filters --enable-filter=scale,format,null,settb,setpts,setsar,transpose,hflip,vflip,rotate,aresample,anull
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
cp ffmpeg ffprobe "$OUT/"
"$OUT/ffmpeg" -hide_banner -L | head -3
