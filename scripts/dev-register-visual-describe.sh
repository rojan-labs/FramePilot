#!/usr/bin/env bash
# Dev-only: builds the Visual Describe worker locally and registers it into the desktop
# app's Capability Pack store, so tier 2 of the shot ledger (structured per-shot
# descriptions from a small local VLM under llama.cpp) is testable end to end without a
# signed catalog (ADR 0114, ADR 0175).
#
# The weights and the llama.cpp runtime are pinned and this script registers the pack.
# The first run downloads ~2.6 GiB into workers/visual-describe/models/ and verifies
# every file against pack/models.lock.toml; later runs re-hash what is already there.
#
# The runtime arrives as ONE release tarball, pinned by a single digest, out of which the
# CLI and the nine dylibs it links against are extracted and pinned individually. The
# unversioned `libfoo.0.dylib` names the loader asks for are recreated as symlinks — the
# CLI's only RPATH is `@loader_path`, so they must all be siblings in models/.
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

An artifact did not match its pin, so this pack was not registered.

That is the pin doing its job: the message above names the file and both digests.
Either a download was interrupted (delete the file in workers/visual-describe/models/
and re-run), or the bytes upstream are not the ones that were approved — which is a
licence and provenance question, not something to re-record away.

To move to a NEW pinned release or revision, deliberately:
  1. Re-verify the licences in workers/visual-describe/LICENSES.md for the new
     artifacts — the GGUF quantisation and mmproj export, and the LICENSE inside the
     llama.cpp release tarball, not just their upstream repositories.
  2. cd workers/visual-describe && .venv/bin/python3 tools/fetch_models.py --record
     (this resolves any PENDING release/revision and rewrites every digest).
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
