#!/usr/bin/env bash
# Dev-only: builds the Smart Mask worker locally and registers it into the desktop app's
# Capability Pack store, so background removal (`subject.matte`) and interactive
# segmentation (`subject.segment_frame`) are testable end to end without a signed catalog
# (ADR 0114, ADR 0179).
#
# Two things the pack needs that nobody publishes ready-made. Both are provisioned here on
# first run and cached, so no environment variables are required:
#
# 1. An LGPL-only ffmpeg + ffprobe. The worker's health check refuses a GPL or nonfree build
#    inside a pack (plan 02), and Homebrew's ffmpeg is GPL. Built from source by
#    workers/smart-mask/tools/build_ffmpeg_lgpl.sh into .cache/ffmpeg-lgpl/bin (~10 min once;
#    needs the Xcode command line tools and pkg-config). SMART_MASK_FFMPEG_DIR points at your
#    own LGPL build instead.
# 2. The ONNX graphs (~1.4 GB), DERIVED from the pinned SAM 2.1 / BiRefNet checkpoints and
#    required to hash to pack/models.lock.toml. Exported by eval/ci_export_graphs.sh (the same
#    recipe CI uses; its exports are byte-identical to the pins), one after another with no
#    memory gate (each peaks at ~7.5 GB), then copied into workers/smart-mask/models/. First run downloads ~1.3 GB of
#    checkpoints plus a PyTorch build environment and needs ~8 GB of free disk. Once models/
#    verifies, later runs skip all of this. SMART_MASK_MODELS_FROM points at a directory of
#    already-exported graphs instead.
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
MODELS_DIR="$WORKER_DIR/models"
FFMPEG_DIR="${SMART_MASK_FFMPEG_DIR:-$WORKER_DIR/.cache/ffmpeg-lgpl/bin}"

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
if [[ ! -x "$FFMPEG_DIR/ffmpeg" || ! -x "$FFMPEG_DIR/ffprobe" ]]; then
  if [[ -n "${SMART_MASK_FFMPEG_DIR:-}" ]]; then
    echo "SMART_MASK_FFMPEG_DIR=$FFMPEG_DIR has no executable ffmpeg and ffprobe." >&2
    exit 1
  fi
  echo "Building an LGPL-only ffmpeg into $FFMPEG_DIR (one time, ~10 min)..." >&2
  bash "$WORKER_DIR/tools/build_ffmpeg_lgpl.sh" "$FFMPEG_DIR"
fi

if [[ ! -f "$CLI" ]]; then
  echo "Building @framepilot/capability-packs..." >&2
  # With its workspace dependencies: a fresh checkout has no shared-types dist either.
  (cd "$REPO_ROOT" && pnpm --filter "@framepilot/capability-packs..." build)
fi

echo "Syncing workers/smart-mask (with the cv extra)..." >&2
(cd "$WORKER_DIR" && uv sync --extra cv --no-dev --locked)

echo "Verifying the ffmpeg build is LGPL-only..." >&2
(cd "$WORKER_DIR" && FRAMEPILOT_SMART_MASK_FFMPEG="$FFMPEG_DIR/ffmpeg" FRAMEPILOT_SMART_MASK_FFPROBE="$FFMPEG_DIR/ffprobe" \
  .venv/bin/python -c "from framepilot_smart_mask.media import verify_tools; print(verify_tools()[2])")

fetch_models() { (cd "$WORKER_DIR" && .venv/bin/python tools/fetch_models.py "$@"); }

if fetch_models --check >/dev/null; then
  echo "Model graphs in $MODELS_DIR already match their pins." >&2
elif [[ -n "${SMART_MASK_MODELS_FROM:-}" ]]; then
  echo "Copying verified model graphs from $SMART_MASK_MODELS_FROM..." >&2
  fetch_models --from "$SMART_MASK_MODELS_FROM"
else
  EXPORT_DIR="$WORKER_DIR/.cache/graphs"
  echo "Exporting the model graphs from the pinned checkpoints into $EXPORT_DIR." >&2
  (cd "$WORKER_DIR" && bash eval/ci_export_graphs.sh "$EXPORT_DIR" 2048 1024 768)
  fetch_models --from "$EXPORT_DIR"
  # models/ now holds the verified copies and is what later runs check; the export directory
  # (with the eval-only fp32 reference graph) would only duplicate ~2.6 GB.
  rm -rf "$EXPORT_DIR"
fi

STAGE="$(mktemp -d -t smart-mask-payload)"
INPUT_JSON="$(mktemp -t smart-mask-register).json"
RESULT_JSON="$(mktemp -t smart-mask-register-result).json"
trap 'rm -rf "$STAGE" "$INPUT_JSON" "$RESULT_JSON"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/models"
cp "$WORKER_DIR/.venv/bin/framepilot-smart-mask" "$STAGE/bin/"
cp "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe" "$STAGE/bin/"
# The Fast engine's native helper (plan 13): Apple Vision, driven by the worker over a pipe.
echo "Building the Vision helper (Fast background removal)..." >&2
bash "$WORKER_DIR/native/vision-matte/build.sh"
cp "$WORKER_DIR/native/vision-matte/build/fp-vision-matte" "$STAGE/bin/"
# Hard links keep the 1.4 GB of graphs from being duplicated in the temporary stage.
ln "$MODELS_DIR"/*.onnx "$MODELS_DIR"/*.npz "$STAGE/models/" 2>/dev/null \
  || cp "$MODELS_DIR"/*.onnx "$MODELS_DIR"/*.npz "$STAGE/models/"

STORE_ROOT="${FRAMEPILOT_DEV_STORE_ROOT:-$HOME/Library/Application Support/@framepilot/desktop/capability-packs}"
cat > "$INPUT_JSON" <<JSON
{
  "packId": "framepilot.smart-mask",
  "version": "1.1.0",
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
