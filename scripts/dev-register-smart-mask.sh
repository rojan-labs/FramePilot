#!/usr/bin/env bash
# Dev-only: builds the Smart Mask worker locally and registers it into the desktop app's
# Capability Pack store, so background removal (`subject.matte`) and interactive
# segmentation (`subject.segment_frame`) are testable end to end without a signed catalog
# (ADR 0114, ADR 0179).
#
# Two things a developer must provide, because neither can be downloaded ready-made:
#
# 1. The ONNX graphs (~1.4 GB). They are DERIVED from the pinned SAM 2.1 / BiRefNet
#    checkpoints by workers/smart-mask/tools/export_onnx.py (PyTorch, build time only) and
#    must hash to pack/models.lock.toml. Point SMART_MASK_MODELS_FROM at the directory
#    holding them (default: workers/smart-mask/.cache/onnx, where the BR0 spike wrote them).
# 2. An LGPL-only ffmpeg + ffprobe (SMART_MASK_FFMPEG_DIR). The worker's health check refuses
#    a GPL or nonfree build inside a pack (plan 02); Homebrew's ffmpeg is GPL and is refused.
#    Build one with --disable-gpl --disable-nonfree, or use a vendor LGPL build.
#
# Memory: registration only hashes the weights; no model is loaded. Using the pack from the
# desktop app loads SAM (~6 GB) and BiRefNet (3.8-6.9 GB) one at a time.
#
# Gated like the other packs: FRAMEPILOT_DEV_PACK_REGISTRATION=1 is set only for the
# registration call itself. Never set it in a packaged build.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/smart-mask"
CLI="$REPO_ROOT/packages/capability-packs/dist/node/release-cli.js"
MODELS_FROM="${SMART_MASK_MODELS_FROM:-$WORKER_DIR/.cache/onnx}"
FFMPEG_DIR="${SMART_MASK_FFMPEG_DIR:-}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only supports macOS (darwin) today." >&2
  exit 1
fi
ARCH="arm64"
[[ "$(uname -m)" == "x86_64" ]] && ARCH="x64"
if [[ "$ARCH" != "arm64" ]]; then
  echo "Smart Mask does not support Intel Macs (plan 02 minimum hardware)." >&2
  exit 1
fi
if [[ -z "$FFMPEG_DIR" || ! -x "$FFMPEG_DIR/ffmpeg" || ! -x "$FFMPEG_DIR/ffprobe" ]]; then
  echo "Set SMART_MASK_FFMPEG_DIR to a directory holding an LGPL-only ffmpeg and ffprobe." >&2
  echo "The pack's health check refuses GPL/nonfree builds (e.g. Homebrew's)." >&2
  exit 1
fi

if [[ ! -f "$CLI" ]]; then
  echo "Building @framepilot/capability-packs..." >&2
  (cd "$REPO_ROOT/packages/capability-packs" && pnpm build)
fi

echo "Syncing workers/smart-mask (with the cv extra)..." >&2
(cd "$WORKER_DIR" && uv sync --extra cv --no-dev --locked)

echo "Verifying the ffmpeg build is LGPL-only..." >&2
(cd "$WORKER_DIR" && FRAMEPILOT_SMART_MASK_FFMPEG="$FFMPEG_DIR/ffmpeg" FRAMEPILOT_SMART_MASK_FFPROBE="$FFMPEG_DIR/ffprobe" \
  .venv/bin/python -c "from framepilot_smart_mask.media import verify_tools; print(verify_tools()[2])")

echo "Copying verified model graphs from $MODELS_FROM..." >&2
(cd "$WORKER_DIR" && .venv/bin/python tools/fetch_models.py --from "$MODELS_FROM")

STAGE="$(mktemp -d -t smart-mask-payload)"
INPUT_JSON="$(mktemp -t smart-mask-register).json"
RESULT_JSON="$(mktemp -t smart-mask-register-result).json"
trap 'rm -rf "$STAGE" "$INPUT_JSON" "$RESULT_JSON"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/models"
cp "$WORKER_DIR/.venv/bin/framepilot-smart-mask" "$STAGE/bin/"
cp "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe" "$STAGE/bin/"
# Hard links keep the 1.4 GB of graphs from being duplicated in the temporary stage.
ln "$WORKER_DIR"/models/*.onnx "$WORKER_DIR"/models/*.npz "$STAGE/models/" 2>/dev/null \
  || cp "$WORKER_DIR"/models/*.onnx "$WORKER_DIR"/models/*.npz "$STAGE/models/"

STORE_ROOT="${FRAMEPILOT_DEV_STORE_ROOT:-$HOME/Library/Application Support/@framepilot/desktop/capability-packs}"
cat > "$INPUT_JSON" <<JSON
{
  "packId": "framepilot.smart-mask",
  "version": "1.0.0",
  "payloadRoot": "$STAGE",
  "entrypoint": "bin/framepilot-smart-mask",
  "capabilities": ["subject.matte", "subject.segment_frame"],
  "licenses": ["Apache-2.0", "MIT", "LGPL-2.1-or-later"],
  "os": "darwin",
  "arch": "$ARCH"
}
JSON

echo "Registering into: $STORE_ROOT (the health check hashes every model file)" >&2
FRAMEPILOT_DEV_PACK_REGISTRATION=1 node "$CLI" register-local "$INPUT_JSON" "$STORE_ROOT" "$RESULT_JSON"

echo
echo "Done. Launch the desktop app (pnpm desktop:dev) and use Remove background on a clip." >&2
echo "Note: the .venv this pack's bin/ shim points to must stay in place" >&2
echo "(workers/smart-mask/.venv) — its shebang references it directly." >&2
