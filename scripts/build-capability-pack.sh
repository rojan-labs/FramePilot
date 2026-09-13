#!/usr/bin/env bash
# Build a RELOCATABLE Capability Pack artifact — the step ADR 0114's distribution
# model assumed and nothing in this repo performed.
#
# `pack/manifest.toml` says "the build embeds a self-contained interpreter so the
# worker never depends on a user's Python", and the signed catalog record is
# "generated FROM this manifest plus the artifact hash produced by the build job".
# There was no such job. The only way a pack reached a machine was
# `dev-register-*.sh`, whose own closing note says it plainly:
#
#   "the .venv this pack points to must stay in place ...
#    its launcher script's shebang references it directly, it is not vendored."
#
# So every pack-backed capability — tracking, subject detect/segment, visual
# embed/describe — worked only on a machine holding this repo at that path.
#
# Two things make the payload standalone, and this script asserts BOTH rather than
# trusting them, because either one silently regressing puts the absolute path back:
#
#   1. `uv venv --relocatable` — console scripts get a `#!/bin/sh` wrapper that
#      resolves the interpreter next to themselves, instead of a shebang naming a
#      build-machine path.
#   2. The interpreter symlinks in `bin/` are replaced by real files. `uv` links
#      them to its managed CPython, which is not present on a user's machine.
#
# What this deliberately does NOT do: sign, notarize, or publish. Those need an
# Apple Developer ID, notarization credentials and a distribution decision, none of
# which belong in a script in the tree. This emits the unsigned artifact and the
# digest those steps consume.
set -euo pipefail

PACK="${1:-}"
if [[ -z "$PACK" ]]; then
  echo "usage: $0 <tracking-lite|subject-intelligence|visual-embed|visual-describe> [outdir]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/$PACK"
MANIFEST="$WORKER_DIR/pack/manifest.toml"
[[ -f "$MANIFEST" ]] || { echo "No pack manifest at $MANIFEST" >&2; exit 2; }

OUT_ROOT="${2:-$REPO_ROOT/dist/capability-packs}"
BUILD_DIR="$OUT_ROOT/$PACK"
PAYLOAD="$BUILD_DIR/payload"

# The manifest is the authority for identity; never restate these in the script.
manifest_value() { sed -n "s/^$1 = \"\\(.*\\)\"/\\1/p" "$MANIFEST" | head -1; }
PACK_ID="$(manifest_value id)"
VERSION="$(manifest_value version)"
PY_VERSION="$(manifest_value python_version)"
ENTRYPOINT="$(sed -n 's/^entrypoint = "\(.*\)"/\1/p' "$MANIFEST" | head -1)"
CAPABILITIES="$(sed -n 's/^capabilities = \(.*\)/\1/p' "$MANIFEST" | head -1)"

case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "Unsupported OS" >&2; exit 1 ;; esac
ARCH=arm64; [[ "$(uname -m)" == "x86_64" ]] && ARCH=x64

echo "Building $PACK_ID $VERSION for $OS-$ARCH" >&2
rm -rf "$BUILD_DIR"; mkdir -p "$PAYLOAD"

# (1) Relocatable, and resolved from the lock so the artifact matches the SBOM.
uv venv --relocatable --python "$PY_VERSION" "$PAYLOAD" >&2
(cd "$WORKER_DIR" && UV_PROJECT_ENVIRONMENT="$PAYLOAD" uv sync --extra cv --no-dev --locked >&2)

# (2) Vendor the WORKER ITSELF. `uv sync` installs the project editable — a `.pth`
# holding `<repo>/workers/<pack>/src` — so the payload carried the dependency tree but
# read its own source out of the repo. The first draft of this script asserted only over
# `bin/` and passed a payload that would have imported nothing on any other machine.
uv pip install --python "$PAYLOAD/bin/python" --no-deps --reinstall "$WORKER_DIR" >&2
# PEP 610 provenance naming the build directory. Optional metadata, nothing imports it,
# and it is the one remaining place a build path rides into a shipped artifact.
find "$PAYLOAD" -name direct_url.json -delete

# (3) Vendor the interpreter: uv links to its managed CPython, absent on a user's machine.
for link in "$PAYLOAD"/bin/python*; do
  [[ -L "$link" ]] || continue
  target="$(cd "$(dirname "$link")" && readlink -f "$(basename "$link")")"
  rm "$link"; cp "$target" "$link"; chmod +x "$link"
done

# ASSERT standalone, over the WHOLE payload. A pack that names a build path is the bug
# this script exists to end, and it fails at the user's machine, not here.
if grep -rIl "$REPO_ROOT" "$PAYLOAD" 2>/dev/null | grep -q .; then
  echo "FAIL: the built payload still references $REPO_ROOT:" >&2
  grep -rIl "$REPO_ROOT" "$PAYLOAD" >&2
  exit 1
fi
for f in "$PAYLOAD"/bin/python*; do
  [[ -L "$f" ]] && { echo "FAIL: $f is still a symlink; the interpreter is not vendored." >&2; exit 1; }
done
if find "$PAYLOAD" -name '*editable*' | grep -q .; then
  echo "FAIL: an editable install survived; the worker source is not vendored." >&2
  find "$PAYLOAD" -name '*editable*' >&2
  exit 1
fi

# (4) Pinned model weights, for the packs that ship them. `fetch_models.py` verifies
# each download against `pack/models.lock.toml`, so the digests in the handshake are the
# pinned ones; the worker finds them at `$FRAMEPILOT_CAPABILITY_PACK_ROOT/models`, which
# the host sets to the install root (see `worker-client.ts`).
if [[ -f "$WORKER_DIR/tools/fetch_models.py" ]]; then
  echo "Fetching pinned model weights..." >&2
  (cd "$WORKER_DIR" && "$PAYLOAD/bin/python" tools/fetch_models.py >&2)
  mkdir -p "$PAYLOAD/models"
  cp "$WORKER_DIR"/models/* "$PAYLOAD/models/"
fi

# PROVE it, don't assert it: the worker's own health handshake, from the built payload.
# `PACK_ROOT` is the payload, exactly as the host will set it at the install location.
echo "Health check against the built payload..." >&2
FRAMEPILOT_CAPABILITY_PACK_ROOT="$PAYLOAD" \
FRAMEPILOT_CAPABILITY_PACK_HEALTH_CHECK=1 \
FRAMEPILOT_CAPABILITY_PACK_NETWORK=disabled \
FRAMEPILOT_CAPABILITY_PACK_ID="$PACK_ID" \
FRAMEPILOT_CAPABILITY_PACK_VERSION="$VERSION" \
FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST="$(printf '%064d' 0)" \
FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES="$(echo "$CAPABILITIES" | tr -d ' ')" \
  "$PAYLOAD/bin/$ENTRYPOINT" --framepilot-health-check >"$BUILD_DIR/handshake.json" 2>&1 || {
    echo "FAIL: the built payload does not pass its own health check:" >&2
    cat "$BUILD_DIR/handshake.json" >&2
    exit 1
  }

# The artifact digest the signed catalog record is generated from.
#
# Hashed over the CONTENT — every file's path and sha256, in sorted order — rather than
# over the tarball. A .tar.gz embeds mtimes, ownership and gzip metadata that differ by
# build machine and tar flavour (bsdtar here, GNU tar in CI), so digesting the archive
# would make the same inputs hash differently in the two places that must agree.
TARBALL="$BUILD_DIR/$PACK_ID-$VERSION-$OS-$ARCH.tar.gz"
ARTIFACT_DIGEST="$(cd "$PAYLOAD" && find . -type f -print0 | LC_ALL=C sort -z |
  xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
( cd "$PAYLOAD" && tar -czf "$TARBALL" . )

UNPACKED_MIB=$(( $(du -sk "$PAYLOAD" | cut -f1) / 1024 ))
MAX_MIB="$(sed -n 's/^max_unpacked_mib = \([0-9]*\)/\1/p' "$MANIFEST" | head -1)"
if [[ -n "$MAX_MIB" && "$UNPACKED_MIB" -gt "$MAX_MIB" ]]; then
  echo "FAIL: unpacked $UNPACKED_MIB MiB exceeds the manifest's max_unpacked_mib ($MAX_MIB)." >&2
  exit 1
fi

cat > "$BUILD_DIR/build-receipt.json" <<JSON
{
  "packId": "$PACK_ID",
  "version": "$VERSION",
  "os": "$OS",
  "arch": "$ARCH",
  "entrypoint": "bin/$ENTRYPOINT",
  "capabilities": $(echo "$CAPABILITIES" | tr -d ' '),
  "artifactDigest": "$ARTIFACT_DIGEST",
  "unpackedMib": $UNPACKED_MIB,
  "relocatable": true,
  "interpreterVendored": true,
  "signed": false,
  "notarized": false
}
JSON

echo >&2
echo "  artifact  $TARBALL" >&2
echo "  digest    $ARTIFACT_DIGEST" >&2
echo "  unpacked  $UNPACKED_MIB MiB (cap $MAX_MIB)" >&2
echo "  receipt   $BUILD_DIR/build-receipt.json" >&2
echo >&2
echo "UNSIGNED. Signing and notarization are the credentialed steps that consume" >&2
echo "this digest; see [platforms].signing in $MANIFEST." >&2
