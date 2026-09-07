#!/usr/bin/env bash
# Dev-only: builds the Visual Embed worker locally and registers it into the desktop
# app's Capability Pack store, so tier 1 of the shot ledger (local shot embeddings,
# zero-shot labels, face identity) is testable end to end without a signed catalog
# (ADR 0114, ADR 0175).
#
# THIS SCRIPT CANNOT SUCCEED YET, AND SAYS SO RATHER THAN PRETENDING.
#
# No model weight has been fetched for this pack, so `pack/models.lock.toml` still
# carries placeholder digests and `tools/fetch_models.py --check` fails by design. The
# steps below are the real ones; the fetch is the only missing piece, and it is gated on
# the licence verification recorded in workers/visual-embed/LICENSES.md (the SigLIP 2
# ONNX EXPORT's licence, and SFace's at the pinned OpenCV Zoo commit).
#
# Gated the same way the other packs are: FRAMEPILOT_DEV_PACK_REGISTRATION=1 is set only
# for the registration call itself. Never set that env var in a packaged build.
#
# See also scripts/dev-register-subject-intelligence.sh and
# scripts/dev-register-tracking-lite.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/visual-embed"
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

echo "Syncing workers/visual-embed (with the cv extra)..." >&2
(cd "$WORKER_DIR" && uv sync --extra cv --no-dev --locked)

echo "Fetching pinned model weights (verified against pack/models.lock.toml)..." >&2
if ! (cd "$WORKER_DIR" && .venv/bin/python3 tools/fetch_models.py); then
  cat >&2 <<'MSG'

The weights are not pinned yet, so this pack cannot be registered.

To make it live:
  1. Verify each licence in workers/visual-embed/LICENSES.md — in particular the
     SigLIP 2 ONNX EXPORT (not only the upstream model card) and SFace at the
     pinned OpenCV Zoo commit.
  2. cd workers/visual-embed && .venv/bin/python3 tools/fetch_models.py --record
  3. Copy the recorded digests into src/framepilot_visual_embed/models.py — that
     copy is the one the signed wheel enforces at load time.
  4. Re-run this script.
MSG
  exit 1
fi

STAGE="$(mktemp -d -t visual-embed-payload)"
INPUT_JSON="$(mktemp -t visual-embed-register).json"
RESULT_JSON="$(mktemp -t visual-embed-register-result).json"
trap 'rm -rf "$STAGE" "$INPUT_JSON" "$RESULT_JSON"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/models"
cp "$WORKER_DIR/.venv/bin/framepilot-visual-embed" "$STAGE/bin/"
cp "$WORKER_DIR"/models/* "$STAGE/models/"

STORE_ROOT="${FRAMEPILOT_DEV_STORE_ROOT:-$HOME/Library/Application Support/@framepilot/desktop/capability-packs}"

cat > "$INPUT_JSON" <<JSON
{
  "packId": "framepilot.visual-embed",
  "version": "1.0.0",
  "payloadRoot": "$STAGE",
  "entrypoint": "bin/framepilot-visual-embed",
  "capabilities": ["visual.embed", "visual.text"],
  "licenses": ["Apache-2.0", "MIT"],
  "os": "darwin",
  "arch": "$ARCH"
}
JSON

echo "Registering into: $STORE_ROOT" >&2
FRAMEPILOT_DEV_PACK_REGISTRATION=1 node "$CLI" register-local "$INPUT_JSON" "$STORE_ROOT" "$RESULT_JSON"

cat >&2 <<'MSG'

Done. The desktop host passes the installed pack to the sidecar on each
/brain/visual/index call; for a sidecar-only test, export the handle directly:

  FRAMEPILOT_PACK_VISUAL_EMBED='{"packId":"framepilot.visual-embed","version":"1.0.0",
    "releaseDigest":"<sha256 from the register-local result>",
    "entrypoint":"<store>/.../bin/framepilot-visual-embed",
    "capabilities":["visual.embed","visual.text"],
    "root":"<store>/...","cache":"<writable dir>"}'

Note: the .venv this pack's bin/ shim points to must stay in place
(workers/visual-embed/.venv) — its shebang references it directly.
MSG
