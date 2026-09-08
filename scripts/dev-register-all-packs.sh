#!/usr/bin/env bash
# Dev-only: register every locally buildable Capability Pack into the desktop
# app's store, so the pack-backed capabilities are testable end to end without a
# signed catalog (ADR 0114). See MANUAL_TESTING.md §22.
#
# This is a thin orchestrator over the per-pack scripts, which stay the place
# where each pack's own build steps live. It deliberately does NOT abort on the
# first failure: one pack failing to build is not a reason to leave the others
# unregistered, and you want every outcome in one pass.
#
# Every pack listed below is expected to register successfully, and a failure in
# any of them fails this script. There used to be a second BLOCKED_PACKS tier for
# the visual-understanding packs, whose weights were unfetched and whose scripts
# failed by design; both are pinned now, so the tier is gone rather than kept
# empty. If a pack ever needs it again, a failure that is "expected" is worth
# re-reading before it is re-encoded.
#
# First run of visual-embed and visual-describe downloads ~4.2 GiB between them.
#
# Registration is gated by FRAMEPILOT_DEV_PACK_REGISTRATION=1, which the
# per-pack scripts set only around the registration call. Never set it in a
# packaged build.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="${FRAMEPILOT_DEV_STORE_ROOT:-$HOME/Library/Application Support/@framepilot/desktop/capability-packs}"

# name:script pairs, in the order they should run.
PACKS=(
  "tracking-lite:dev-register-tracking-lite.sh"
  "subject-intelligence:dev-register-subject-intelligence.sh"
  "visual-embed:dev-register-visual-embed.sh"
  "visual-describe:dev-register-visual-describe.sh"
)

# Guard against drift: every per-pack script on disk must be listed above, or a
# new pack silently never gets registered by this orchestrator.
listed=" ${PACKS[*]} "
unlisted=()
for path in "$SCRIPT_DIR"/dev-register-*.sh; do
  base="$(basename "$path")"
  [[ "$base" == "dev-register-all-packs.sh" ]] && continue
  [[ "$listed" == *":$base "* ]] || unlisted+=("$base")
done
if [[ ${#unlisted[@]} -gt 0 ]]; then
  echo "!! Not listed in this script, so NOT registered: ${unlisted[*]}" >&2
  echo "   Add each to PACKS." >&2
  exit 1
fi

failed=()
succeeded=()

run_pack() {
  local entry="$1"
  local name="${entry%%:*}"
  local script="${entry#*:}"
  echo
  echo "=============================================================="
  echo "  Registering $name"
  echo "=============================================================="
  if bash "$SCRIPT_DIR/$script"; then
    succeeded+=("$name")
    return
  fi
  echo "!! $name failed to register (continuing)" >&2
  failed+=("$name")
}

for entry in "${PACKS[@]}"; do
  run_pack "$entry"
done

echo
echo "=============================================================="
echo "  Installed packs in the store"
echo "=============================================================="
# Read the store back rather than trusting the exit codes above: a pack is only
# usable if it is actually recorded installed AND healthy.
if [[ -f "$STORE_ROOT/index.json" ]]; then
  node -e "
    const records = require('$STORE_ROOT/index.json').records ?? [];
    if (records.length === 0) { console.log('(none)'); process.exit(0); }
    for (const r of records) {
      console.log([r.identity.id, r.identity.version, r.state, r.health.status].join('  '));
    }
  "
else
  echo "(no store index at $STORE_ROOT)"
fi

echo
if [[ ${#succeeded[@]} -gt 0 ]]; then
  echo "Registered: ${succeeded[*]}"
fi
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "FAILED: ${failed[*]}" >&2
  exit 1
fi

echo
echo "All packs registered. Launch the desktop app with 'pnpm desktop:dev' — no"
echo "capability-pack env vars are needed to run it; the store is read from disk."
echo "The registered payloads reference workers/*/.venv in this checkout, so"
echo "re-run this script if you rebuild or remove those virtualenvs."
