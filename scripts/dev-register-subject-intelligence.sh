#!/usr/bin/env bash
# Dev-only: builds the Subject Intelligence worker locally (downloads its
# pinned OpenCV Zoo weights) and registers it into the desktop app's
# Capability Pack store, so `detect_subjects` and
# `track_subject_automatically` (subject="silhouette") are testable end to
# end without a signed catalog (ADR 0114).
#
# Gated the same way the underlying tool is gated: this script sets
# FRAMEPILOT_DEV_PACK_REGISTRATION=1 only for the registration call itself.
# Never set that env var in a packaged build.
#
# Unlike Tracking Lite, this pack needs a `models/` directory sitting beside
# its entrypoint at install time (the worker resolves it from
# FRAMEPILOT_CAPABILITY_PACK_ROOT, which register-local points at the staged
# copy) — so the payload is a small staging directory, not the raw venv.
#
# See also scripts/dev-register-tracking-lite.sh for the companion
# point/region/planar tracking pack.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/subject-intelligence"
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

echo "Syncing workers/subject-intelligence (with the cv extra)..." >&2
(cd "$WORKER_DIR" && uv sync --extra cv --no-dev --locked)

echo "Fetching pinned model weights (verified against pack/models.lock.toml)..." >&2
(cd "$WORKER_DIR" && .venv/bin/python3 tools/fetch_models.py)

STAGE="$(mktemp -d -t subject-intelligence-payload)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/models"
cp "$WORKER_DIR/.venv/bin/framepilot-subject-intelligence" "$STAGE/bin/"
cp "$WORKER_DIR"/models/*.onnx "$STAGE/models/"

STORE_ROOT="${FRAMEPILOT_DEV_STORE_ROOT:-$HOME/Library/Application Support/@framepilot/desktop/capability-packs}"
INPUT_JSON="$(mktemp -t subject-intelligence-register).json"
RESULT_JSON="$(mktemp -t subject-intelligence-register-result).json"
trap 'rm -rf "$STAGE" "$INPUT_JSON" "$RESULT_JSON"' EXIT

cat > "$INPUT_JSON" <<JSON
{
  "packId": "framepilot.subject-intelligence",
  "version": "1.0.0",
  "payloadRoot": "$STAGE",
  "entrypoint": "bin/framepilot-subject-intelligence",
  "capabilities": ["subject.detect", "subject.segment"],
  "licenses": ["MIT", "Apache-2.0"],
  "os": "darwin",
  "arch": "$ARCH"
}
JSON

echo "Registering into: $STORE_ROOT" >&2
FRAMEPILOT_DEV_PACK_REGISTRATION=1 node "$CLI" register-local "$INPUT_JSON" "$STORE_ROOT" "$RESULT_JSON"

echo
echo "Done. Launch the desktop app (pnpm desktop:dev) and ask the AI to find" >&2
echo "faces/people/objects, or track a subject with subject=\"silhouette\"." >&2
echo "Note: the .venv this pack's bin/ shim points to must stay in place" >&2
echo "(workers/subject-intelligence/.venv) — its shebang references it directly." >&2
