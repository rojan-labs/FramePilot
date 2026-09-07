#!/usr/bin/env bash
# Dev-only: builds the Visual Describe worker locally and registers it into the desktop
# app's Capability Pack store, so tier 2 of the shot ledger (structured per-shot
# descriptions from a small local VLM under llama.cpp) is testable end to end without a
# signed catalog (ADR 0114, ADR 0175).
#
# THIS SCRIPT CANNOT SUCCEED YET, AND SAYS SO RATHER THAN PRETENDING.
#
# No model weight and no llama.cpp binary has been fetched for this pack, so
# `pack/models.lock.toml` still carries placeholder digests and `tools/fetch_models.py
# --check` fails by design. The steps below are the real ones; the fetch is the only
# missing piece, and it is gated on the licence verification recorded in
# workers/visual-describe/LICENSES.md (the SmolVLM2 GGUF QUANTISATION and mmproj export,
# and the llama.cpp RELEASE artifact — not just their upstream repositories).
#
# Gated the same way the other packs are: FRAMEPILOT_DEV_PACK_REGISTRATION=1 is set only
# for the registration call itself. Never set that env var in a packaged build.
#
# See also scripts/dev-register-visual-embed.sh, dev-register-subject-intelligence.sh
# and dev-register-tracking-lite.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/visual-describe"
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

echo "Syncing workers/visual-describe (with the cv extra)..." >&2
(cd "$WORKER_DIR" && uv sync --extra cv --no-dev --locked)

echo "Fetching pinned weights + llama.cpp runtime (verified against models.lock.toml)..." >&2
if ! (cd "$WORKER_DIR" && .venv/bin/python3 tools/fetch_models.py); then
  cat >&2 <<'MSG'

The weights are not pinned yet, so this pack cannot be registered.

To make it live:
  1. Verify each licence in workers/visual-describe/LICENSES.md — in particular the
     SmolVLM2 GGUF quantisation and mmproj export (not only the upstream model
     card), and the llama.cpp release artifact you download.
  2. cd workers/visual-describe && .venv/bin/python3 tools/fetch_models.py --record
  3. Copy the recorded digests into src/framepilot_visual_describe/models.py — that
     copy is the one the signed wheel enforces at load time.
  4. Re-run this script.
MSG
  exit 1
fi

STAGE="$(mktemp -d -t visual-describe-payload)"
INPUT_JSON="$(mktemp -t visual-describe-register).json"
RESULT_JSON="$(mktemp -t visual-describe-register-result).json"
trap 'rm -rf "$STAGE" "$INPUT_JSON" "$RESULT_JSON"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/models"
cp "$WORKER_DIR/.venv/bin/framepilot-visual-describe" "$STAGE/bin/"
cp "$WORKER_DIR"/models/* "$STAGE/models/"

STORE_ROOT="${FRAMEPILOT_DEV_STORE_ROOT:-$HOME/Library/Application Support/@framepilot/desktop/capability-packs}"

cat > "$INPUT_JSON" <<JSON
{
  "packId": "framepilot.visual-describe",
  "version": "1.0.0",
  "payloadRoot": "$STAGE",
  "entrypoint": "bin/framepilot-visual-describe",
  "capabilities": ["visual.describe"],
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

  FRAMEPILOT_PACK_VISUAL_EMBED='{"packId":"framepilot.visual-describe","version":"1.0.0",
    "releaseDigest":"<sha256 from the register-local result>",
    "entrypoint":"<store>/.../bin/framepilot-visual-describe",
    "capabilities":["visual.describe"],
    "root":"<store>/...","cache":"<writable dir>"}'

Note: the .venv this pack's bin/ shim points to must stay in place
(workers/visual-describe/.venv) — its shebang references it directly.
MSG
