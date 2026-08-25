#!/usr/bin/env bash
# Dev-only: builds the Tracking Lite worker locally and registers it into the
# desktop app's Capability Pack store, so `tracking_mask.automatic_subject_track`
# (subject="object"/"bounding_box") is testable end to end without a signed
# catalog (ADR 0114).
#
# Gated the same way the underlying tool is gated: this script sets
# FRAMEPILOT_DEV_PACK_REGISTRATION=1 only for the registration call itself.
# Never set that env var in a packaged build.
#
# See also scripts/dev-register-subject-intelligence.sh for the companion
# face/person/object detection + segmentation pack.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/tracking-lite"
CLI="$REPO_ROOT/packages/capability-packs/dist/node/release-cli.js"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only supports macOS (darwin) today." >&2
  exit 1
fi
ARCH="arm64"
[[ "$(uname -m)" == "x86_64" ]] && ARCH="x64"

if [[ ! -f "$CLI" ]]; then
  echo "Building @framepilot/capability-packs..." >&2
  (cd "$REPO_ROOT/packages/capability-packs" && pnpm build)
fi

echo "Syncing workers/tracking-lite (with the cv extra, for a real OpenCV backend)..." >&2
(cd "$WORKER_DIR" && uv sync --extra cv --no-dev --locked)

STORE_ROOT="${FRAMEPILOT_DEV_STORE_ROOT:-$HOME/Library/Application Support/@framepilot/desktop/capability-packs}"
INPUT_JSON="$(mktemp -t tracking-lite-register).json"
RESULT_JSON="$(mktemp -t tracking-lite-register-result).json"
trap 'rm -f "$INPUT_JSON" "$RESULT_JSON"' EXIT

cat > "$INPUT_JSON" <<JSON
{
  "packId": "framepilot.tracking-lite",
  "version": "1.0.0",
  "payloadRoot": "$WORKER_DIR/.venv",
  "entrypoint": "bin/framepilot-tracking-lite",
  "capabilities": ["tracking.point", "tracking.region", "tracking.planar"],
  "licenses": ["MIT"],
  "os": "darwin",
  "arch": "$ARCH"
}
JSON

echo "Registering into: $STORE_ROOT" >&2
FRAMEPILOT_DEV_PACK_REGISTRATION=1 node "$CLI" register-local "$INPUT_JSON" "$STORE_ROOT" "$RESULT_JSON"

echo
echo "Done. Launch the desktop app (pnpm desktop:dev) and ask the AI to track a" >&2
echo "subject — no capability-pack env vars are needed to run the app itself." >&2
echo "Note: the .venv this pack points to must stay in place (workers/tracking-lite/.venv);" >&2
echo "its launcher script's shebang references it directly, it is not vendored." >&2
