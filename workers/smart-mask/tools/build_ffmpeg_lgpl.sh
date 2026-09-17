#!/usr/bin/env bash
# Build the LGPL-only ffmpeg + ffprobe the Smart Mask pack ships in bin/ (plan 02).
#
# Why a source build: PyAV wheels bundle libx264/libx265 (GPL), and common macOS binaries
# (Homebrew, evermeet) are configured with --enable-gpl. This recipe enables nothing GPL or
# nonfree and only what the pack needs: decoders for camera/editor formats, the FFV1 codec,
# libvpx (BSD-3-Clause, built statically here) for VP9 previews, matroska/webm muxing, the
# scale filter family. The binaries depend on system libraries only, so the pack stays
# standalone (scripts/build-capability-pack.sh asserts it).
#
#   tools/build_ffmpeg_lgpl.sh <output-dir>
#
# Both source tarballs are verified by sha256 before anything is built. The result is checked
# by media.assess_ffmpeg_build (health check) and tools/generate_sbom.py --check.
set -euo pipefail

FFMPEG_VERSION="7.1.1"
FFMPEG_SHA256="733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"
VPX_VERSION="1.15.2"
VPX_SHA256="26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa"
OUT="${1:?usage: build_ffmpeg_lgpl.sh <output-dir>}"
WORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.cache/ffmpeg-lgpl"
mkdir -p "$WORK" "$OUT"
OUT="$(cd "$OUT" && pwd)"
PREFIX="$WORK/install"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
cd "$WORK"

[[ -f "libvpx-$VPX_VERSION.tar.gz" ]] || curl -sSLo "libvpx-$VPX_VERSION.tar.gz" "https://github.com/webmproject/libvpx/archive/refs/tags/v$VPX_VERSION.tar.gz"
echo "$VPX_SHA256  libvpx-$VPX_VERSION.tar.gz" | shasum -a 256 -c -
rm -rf "libvpx-$VPX_VERSION" && tar xzf "libvpx-$VPX_VERSION.tar.gz"
(cd "libvpx-$VPX_VERSION" && ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-examples \
  --disable-tools --disable-docs --disable-unit-tests --enable-vp9 --enable-pic && make -j"$JOBS" && make install)

[[ -f "ffmpeg-$FFMPEG_VERSION.tar.xz" ]] || curl -sSLo "ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
echo "$FFMPEG_SHA256  ffmpeg-$FFMPEG_VERSION.tar.xz" | shasum -a 256 -c -
rm -rf "ffmpeg-$FFMPEG_VERSION" && tar xf "ffmpeg-$FFMPEG_VERSION.tar.xz"
cd "ffmpeg-$FFMPEG_VERSION"
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure \
  --prefix="$PREFIX" --pkg-config-flags="--static" \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" \
  --disable-gpl --disable-nonfree --disable-version3 \
  --disable-autodetect --enable-videotoolbox --enable-zlib \
  --disable-doc --disable-network --disable-ffplay --disable-devices \
  --disable-shared --enable-static \
  --enable-libvpx \
  --disable-encoders --enable-encoder=ffv1,libvpx_vp9,rawvideo,png \
  --disable-muxers --enable-muxer=matroska,webm,rawvideo,image2,null \
  --disable-filters --enable-filter=scale,format,null,settb,setpts,setsar,transpose,hflip,vflip,rotate,aresample,anull
make -j"$JOBS"
cp ffmpeg ffprobe "$OUT/"
"$OUT/ffmpeg" -hide_banner -L | head -3
if command -v otool >/dev/null && otool -L "$OUT/ffmpeg" | grep -E "/opt/homebrew|/usr/local" ; then
  echo "FAIL: ffmpeg links a non-system library" >&2
  exit 1
fi
