#!/usr/bin/env bash
# Build a RELOCATABLE Capability Pack artifact — the step ADR 0114's distribution
# model assumed and nothing in this repo performed.
#
# `pack/manifest.toml` says "the build embeds a self-contained interpreter so the
# worker never depends on a user's Python", and the signed catalog record is
# "generated FROM this manifest plus the artifact hash produced by the build job".
# The only way a pack reached a machine was `dev-register-*.sh`, whose launcher
# references this repository's `.venv` directly.
#
# What makes the payload standalone, and this script asserts EACH rather than trusting
# it, because any one silently regressing puts a build-machine path back:
#
#   1. `uv venv --relocatable` — console scripts get a `#!/bin/sh` wrapper that
#      resolves the interpreter next to themselves. The ENTRYPOINT's wrapper is then
#      replaced by a compiled launcher doing the same (`install_native_launcher`), because
#      a shell script's signature does not survive the host's ZIP install.
#   2. The interpreter is a real file, not uv's symlink to its managed CPython.
#   3. The STANDARD LIBRARY is inside the payload and `pyvenv.cfg` is gone. A venv's
#      `pyvenv.cfg` names `home = <build machine's CPython>/bin`, and the stdlib lives
#      there, not in the venv. The first version of this script vendored the binary but
#      not the stdlib; its health check passed only because the build machine still had
#      that CPython. Moved to a machine without it, the payload died on
#      `ModuleNotFoundError: No module named 'encodings'`. Without `pyvenv.cfg` the
#      (statically linked, python-build-standalone) interpreter finds its prefix from
#      its own location via the `lib/pythonX.Y/os.py` landmark.
#
# Stages, so a release job can code-sign between building and archiving (signing
# rewrites Mach-O files, so it must happen before the digest and the archive exist):
#
#   --stage payload   build + vendor + assert standalone + pinned models + health check
#   --stage finalize  health-check the (possibly signed) payload again, enforce the size
#                     cap, compute the content digest, write the .zip and the receipt
#   --stage all       both (default)
#
# The archive is a ZIP because that is the only multi-file format the installer
# (`packages/capability-packs/src/node/extractor.ts`) accepts; it rejects symbolic links,
# so the payload contains none.
#
# What this deliberately does NOT do: sign, notarize, or publish. Those need an Apple
# Developer ID, notarization credentials and a distribution decision; see
# `.github/workflows/capability-pack-release.yml`.
set -euo pipefail

usage() {
  echo "usage: $0 <tracking-lite|subject-intelligence|visual-embed|visual-describe> [outdir] [--stage all|payload|finalize]" >&2
  exit 2
}

PACK=""
OUT_ROOT=""
STAGE="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) STAGE="${2:-}"; shift 2 ;;
    -*) usage ;;
    *) if [[ -z "$PACK" ]]; then PACK="$1"; elif [[ -z "$OUT_ROOT" ]]; then OUT_ROOT="$1"; else usage; fi; shift ;;
  esac
done
[[ -n "$PACK" ]] || usage
case "$STAGE" in all|payload|finalize) ;; *) usage ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/workers/$PACK"
MANIFEST="$WORKER_DIR/pack/manifest.toml"
MODELS_LOCK="$WORKER_DIR/pack/models.lock.toml"
[[ -f "$MANIFEST" ]] || { echo "No pack manifest at $MANIFEST" >&2; exit 2; }

OUT_ROOT="${OUT_ROOT:-$REPO_ROOT/dist/capability-packs}"
BUILD_DIR="$OUT_ROOT/$PACK"
PAYLOAD="$BUILD_DIR/payload"

# The manifest is the authority for identity; never restate these in the script.
manifest_value() { sed -n "s/^$1 = \"\\(.*\\)\"/\\1/p" "$MANIFEST" | head -1; }
PACK_ID="$(manifest_value id)"
VERSION="$(manifest_value version)"
PY_VERSION="$(manifest_value python_version)"
ENTRYPOINT="$(sed -n 's/^entrypoint = "\(.*\)"/\1/p' "$MANIFEST" | head -1)"
CAPABILITIES="$(sed -n 's/^capabilities = \(.*\)/\1/p' "$MANIFEST" | head -1)"
MAX_MIB="$(sed -n 's/^max_unpacked_mib = \([0-9]*\)/\1/p' "$MANIFEST" | head -1)"

case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "Unsupported OS (this script is POSIX-only; no Windows build exists)" >&2; exit 1 ;; esac
ARCH=arm64; [[ "$(uname -m)" == "x86_64" ]] && ARCH=x64
ARCHIVE="$BUILD_DIR/$PACK_ID-$VERSION-$OS-$ARCH.zip"

# Standard-library parts that cannot run, or are never used, inside a network-disabled,
# headless worker: GUI toolkits whose Tcl/Tk natives are not shipped, the bundled pip
# wheel, and the static-link config used only to compile extensions.
STDLIB_EXCLUDES=(site-packages idlelib tkinter turtledemo ensurepip test "config-$PY_VERSION-darwin" EXTERNALLY-MANAGED)

# APFS clonefile makes copying ~2.5 GiB of weights free on macOS; elsewhere, a plain copy.
copy_file() { cp -c "$1" "$2" 2>/dev/null || cp "$1" "$2"; }

payload_bytes() {
  "$PAYLOAD/bin/python" -c '
import os, sys
total = 0
for directory, _, files in os.walk(sys.argv[1]):
    for name in files:
        total += os.lstat(os.path.join(directory, name)).st_size
print(total)' "$PAYLOAD"
}

build_payload() {
  echo "Building $PACK_ID $VERSION payload for $OS-$ARCH" >&2
  rm -rf "$BUILD_DIR"; mkdir -p "$PAYLOAD"

  # (1) Relocatable, and resolved from the lock so the artifact matches the SBOM.
  uv venv --relocatable --python "$PY_VERSION" "$PAYLOAD" >&2
  (cd "$WORKER_DIR" && UV_PROJECT_ENVIRONMENT="$PAYLOAD" uv sync --extra cv --no-dev --locked >&2)

  # (2) Vendor the WORKER ITSELF. `uv sync` installs the project editable — a `.pth`
  # holding `<repo>/workers/<pack>/src`.
  uv pip install --python "$PAYLOAD/bin/python" --no-deps --reinstall "$WORKER_DIR" >&2
  # PEP 610 provenance naming the build directory; nothing imports it.
  find "$PAYLOAD" -name direct_url.json -delete

  # (3) Vendor the interpreter AND its standard library, then drop pyvenv.cfg (see header).
  local home_bin python_home stdlib
  home_bin="$(sed -n 's/^home = //p' "$PAYLOAD/pyvenv.cfg")"
  python_home="$(cd "$home_bin/.." && pwd -P)"
  stdlib="$python_home/lib/python$PY_VERSION"
  [[ -f "$stdlib/os.py" ]] || { echo "FAIL: no standard library at $stdlib" >&2; exit 1; }
  local interpreter
  interpreter="$(cd "$(dirname "$PAYLOAD/bin/python")" && readlink -f python)"
  # One interpreter file. `python3`/`python3.13` were two more 16.6 MiB copies of it
  # (links are not allowed in an artifact), and uv's wrappers exec `python`.
  rm -f "$PAYLOAD"/bin/python*
  cp "$interpreter" "$PAYLOAD/bin/python"; chmod 755 "$PAYLOAD/bin/python"
  for entry in "$stdlib"/* "$stdlib"/.[!.]*; do
    [[ -e "$entry" ]] || continue
    local name skip=0
    name="$(basename "$entry")"
    for excluded in "${STDLIB_EXCLUDES[@]}"; do [[ "$name" == "$excluded" ]] && skip=1; done
    [[ $skip -eq 1 ]] || cp -R "$entry" "$PAYLOAD/lib/python$PY_VERSION/"
  done
  rm -f "$PAYLOAD/pyvenv.cfg"
  # uv rewrites the build-time config (`_sysconfigdata`: BINDIR, LIBDEST, …) to its own
  # install directory, i.e. the build user's home. Nothing imports those values to locate
  # modules — the prefix comes from the interpreter's location — but shipping a build
  # machine's home path is the leak `assert_standalone` refuses. Restore the neutral
  # `/install` prefix python-build-standalone itself ships with.
  local sysconfigdata
  for sysconfigdata in "$PAYLOAD/lib/python$PY_VERSION"/_sysconfigdata*.py; do
    [[ -f "$sysconfigdata" ]] || continue
    PYTHON_HOME="$python_home" perl -0pi -e 's/\Q$ENV{PYTHON_HOME}\E/\/install/g' "$sysconfigdata"
  done

  # (4) Strip what never runs in a worker: shell activation scripts and every console
  # script except the entrypoint (fewer executables inside a signed artifact), uv's
  # cache marker, bytecode (compiled against build paths, and stale after extraction
  # anyway because the installer does not preserve source mtimes), and test suites
  # shipped inside wheels.
  find "$PAYLOAD/bin" -mindepth 1 ! -name python ! -name "$ENTRYPOINT" -delete
  rm -f "$PAYLOAD/CACHEDIR.TAG" "$PAYLOAD/.gitignore" "$PAYLOAD/.lock"
  find "$PAYLOAD" -type d -name __pycache__ -prune -exec rm -rf {} +
  find "$PAYLOAD/lib/python$PY_VERSION/site-packages" -type d -name tests -prune -exec rm -rf {} +

  install_native_launcher

  # (5) Pinned model weights, for the packs that ship them. `fetch_models.py` verifies
  # each file against `pack/models.lock.toml`. Only the PINNED set is copied: a
  # `models/` directory also holds build inputs — Visual Describe's 10.6 MiB runtime
  # tarball stays there once its members are extracted and pinned individually. The
  # `[archive.links]` aliases the runtime loads by name are copied as real files,
  # because an artifact may not contain links.
  if [[ -f "$WORKER_DIR/tools/fetch_models.py" ]]; then
    echo "Fetching pinned model weights..." >&2
    (cd "$WORKER_DIR" && "$PAYLOAD/bin/python" -B tools/fetch_models.py >&2)
    mkdir -p "$PAYLOAD/models"
    local pinned
    while IFS= read -r pinned; do
      [[ -n "$pinned" ]] || continue
      copy_file "$(cd "$WORKER_DIR/models" && readlink -f "$pinned")" "$PAYLOAD/models/$pinned"
    done < <("$PAYLOAD/bin/python" -B -c '
import sys, tomllib
lock = tomllib.load(open(sys.argv[1], "rb"))
for model in lock["model"]:
    print(model["file"])
for archive in lock.get("archive", []):
    for alias in archive.get("links", {}):
        print(alias)' "$MODELS_LOCK")
    chmod 755 "$PAYLOAD/models/"*.dylib "$PAYLOAD/models/llama-mtmd-cli" 2>/dev/null || true
  fi

  assert_standalone
}

# Replace uv's `#!/bin/sh` console-script wrapper with a compiled launcher that does the same
# thing (scripts/pack-launcher/launcher.c). WHY: a script's macOS code signature lives in
# extended attributes, which the host's ZIP install does not carry, so a signed wrapper
# arrives unsigned. A Mach-O embeds its signature. There is no shell-wrapper fallback: the
# only platform this script builds for release is darwin (Linux is a local-dev convenience
# the launcher also supports), and no Windows builder exists.
install_native_launcher() {
  local wrapper="$PAYLOAD/bin/$ENTRYPOINT" target module function
  target="$(sed -n 's/^from \([A-Za-z_][A-Za-z0-9_.]*\) import \([A-Za-z_][A-Za-z0-9_]*\)$/\1 \2/p' "$wrapper" | head -1)"
  module="${target% *}"; function="${target#* }"
  # Replicate the console script the WORKER declared, not a guess; an unparseable wrapper
  # means uv changed its format and the launcher would run something else.
  [[ -n "$target" && "$module" == "$(sed -n 's/^entrypoint_module = "\(.*\)"/\1/p' "$MANIFEST" | head -1)".* ]] || {
    echo "FAIL: cannot derive the console-script target from $wrapper (or it disagrees with entrypoint_module)" >&2
    exit 1
  }
  local config="$BUILD_DIR/launcher-config.h"
  printf '#define FP_PYTHON_CODE "import sys\\nfrom %s import %s\\nsys.exit(%s())"\n' \
    "$module" "$function" "$function" > "$config"
  rm -f "$wrapper"
  cc -Os -std=gnu11 -Wall -Wextra -Werror -include "$config" \
    "$REPO_ROOT/scripts/pack-launcher/launcher.c" -o "$wrapper" >&2
  chmod 755 "$wrapper"
  if [[ "$OS" == darwin ]] && ! file -b "$wrapper" | grep -q 'Mach-O'; then
    echo "FAIL: the entrypoint $wrapper is not a Mach-O executable" >&2
    exit 1
  fi
  echo "  launcher  bin/$ENTRYPOINT -> python -P -c 'from $module import $function'" >&2
}

assert_standalone() {
  # A pack that names a build path fails at the user's machine, not here.
  local leaks
  leaks="$(grep -rIlF -e "$REPO_ROOT" -e "$HOME/.local/share/uv" \
    -e "$(uv python dir 2>/dev/null || echo /nonexistent-uv-python-dir)" "$PAYLOAD" 2>/dev/null || true)"
  if [[ -n "$leaks" ]]; then
    echo "FAIL: the built payload still references a build-machine path (repo or uv CPython):" >&2
    echo "$leaks" >&2
    exit 1
  fi
  [[ ! -e "$PAYLOAD/pyvenv.cfg" ]] || { echo "FAIL: pyvenv.cfg survived; the stdlib would resolve outside the payload." >&2; exit 1; }
  if find "$PAYLOAD" -type l | grep -q .; then
    echo "FAIL: the payload contains symbolic links, which the installer rejects:" >&2
    find "$PAYLOAD" -type l >&2
    exit 1
  fi
  if find "$PAYLOAD" -name '*editable*' | grep -q .; then
    echo "FAIL: an editable install survived; the worker source is not vendored." >&2
    find "$PAYLOAD" -name '*editable*' >&2
    exit 1
  fi
}

# PROVE it, don't assert it. The payload is MOVED first, so any path resolved at build
# time is now wrong, and run with a scrubbed environment, so no PYTHONPATH/PYTHONHOME or
# user site can rescue it. Then: every import root must lie inside the moved payload,
# and the worker's own health handshake must pass from it.
RELOCATED_PROOF=""
# Put a moved payload back even when a failing check calls `exit`; a RETURN trap would not.
restore_payload() {
  if [[ -n "$RELOCATED_PROOF" && -d "$RELOCATED_PROOF" && ! -e "$PAYLOAD" ]]; then
    mv "$RELOCATED_PROOF" "$PAYLOAD"
  fi
  RELOCATED_PROOF=""
}
trap restore_payload EXIT

health_check() {
  local proof="$BUILD_DIR/relocated-proof"
  rm -rf "$proof"; mv "$PAYLOAD" "$proof"; RELOCATED_PROOF="$proof"
  echo "Relocation + health check against the built payload..." >&2
  env -i PATH=/usr/bin:/bin HOME="$BUILD_DIR" PYTHONDONTWRITEBYTECODE=1 \
    "$proof/bin/python" -c '
import os, sys, encodings
root = os.path.realpath(sys.argv[1])
outside = [p for p in [sys.prefix, sys.base_prefix, encodings.__file__, *sys.path]
           if p and not os.path.realpath(p).startswith(root + os.sep) and os.path.realpath(p) != root]
if outside:
    sys.exit(f"FAIL: import roots outside the payload: {outside}")
print(f"standalone: prefix={sys.prefix} stdlib={os.path.dirname(encodings.__file__)}", file=sys.stderr)
' "$proof"
  env -i PATH=/usr/bin:/bin HOME="$BUILD_DIR" PYTHONDONTWRITEBYTECODE=1 \
  FRAMEPILOT_CAPABILITY_PACK_ROOT="$proof" \
  FRAMEPILOT_CAPABILITY_PACK_HEALTH_CHECK=1 \
  FRAMEPILOT_CAPABILITY_PACK_NETWORK=disabled \
  FRAMEPILOT_CAPABILITY_PACK_ID="$PACK_ID" \
  FRAMEPILOT_CAPABILITY_PACK_VERSION="$VERSION" \
  FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST="$(printf '%064d' 0)" \
  FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES="$(echo "$CAPABILITIES" | tr -d ' ')" \
    "$proof/bin/$ENTRYPOINT" --framepilot-health-check \
    >"$BUILD_DIR/handshake.json" 2>"$BUILD_DIR/health-check.stderr" || {
      echo "FAIL: the built payload does not pass its own health check:" >&2
      cat "$BUILD_DIR/handshake.json" "$BUILD_DIR/health-check.stderr" >&2
      exit 1
    }
  grep -q '"type":"handshake"' "$BUILD_DIR/handshake.json" || {
    echo "FAIL: the health check exited 0 without a handshake:" >&2
    cat "$BUILD_DIR/handshake.json" >&2
    exit 1
  }
  restore_payload
  echo "  handshake $(head -c 160 "$BUILD_DIR/handshake.json")..." >&2
}

enforce_size_cap() {
  UNPACKED_BYTES="$(payload_bytes)"
  UNPACKED_MIB=$(( (UNPACKED_BYTES + 1048575) / 1048576 ))
  echo "  unpacked  $UNPACKED_MIB MiB ($UNPACKED_BYTES bytes, cap ${MAX_MIB:-none})" >&2
  if [[ -n "$MAX_MIB" && "$UNPACKED_MIB" -gt "$MAX_MIB" ]]; then
    echo "FAIL: unpacked $UNPACKED_MIB MiB exceeds the manifest's max_unpacked_mib ($MAX_MIB)." >&2
    exit 1
  fi
}

finalize() {
  [[ -x "$PAYLOAD/bin/python" ]] || { echo "No built payload at $PAYLOAD; run --stage payload first." >&2; exit 1; }
  assert_standalone
  enforce_size_cap

  # Hashed over the CONTENT — every file's path and sha256, in sorted order — rather than
  # over the archive, whose timestamps and compressor metadata differ by build machine.
  # The ARCHIVE's own sha256 is computed separately by `framepilot-pack prepare-artifact`
  # for the catalog record, because that is what the downloader verifies.
  ARTIFACT_DIGEST="$(cd "$PAYLOAD" && find . -type f -print0 | LC_ALL=C sort -z |
    xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
  rm -f "$ARCHIVE"
  # -D: no directory entries (the installer's allowlist is files). -X: no uid/gid extras.
  # Weights are already dense, so storing them instead of deflating saves minutes.
  (cd "$PAYLOAD" && zip -q -r -D -X -n .onnx:.gguf:.dylib:.so "$ARCHIVE" .)

  cat > "$BUILD_DIR/build-receipt.json" <<JSON
{
  "packId": "$PACK_ID",
  "version": "$VERSION",
  "os": "$OS",
  "arch": "$ARCH",
  "entrypoint": "bin/$ENTRYPOINT",
  "capabilities": $(echo "$CAPABILITIES" | tr -d ' '),
  "archive": "$(basename "$ARCHIVE")",
  "format": "zip",
  "contentDigest": "$ARTIFACT_DIGEST",
  "unpackedBytes": $UNPACKED_BYTES,
  "unpackedMib": $UNPACKED_MIB,
  "maxUnpackedMib": ${MAX_MIB:-null},
  "relocatable": true,
  "interpreterVendored": true,
  "stdlibVendored": true
}
JSON

  echo >&2
  echo "  artifact  $ARCHIVE" >&2
  echo "  content   $ARTIFACT_DIGEST" >&2
  echo "  receipt   $BUILD_DIR/build-receipt.json" >&2
  echo >&2
  echo "Signing state is NOT recorded here: the release job, which holds the credentials," >&2
  echo "is the only place that can truthfully say whether it signed; see [platforms].signing in $MANIFEST." >&2
}

case "$STAGE" in
  payload)  build_payload; health_check; enforce_size_cap ;;
  finalize) health_check; finalize ;;
  all)      build_payload; health_check; finalize ;;
esac
