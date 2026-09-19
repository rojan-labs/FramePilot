#!/usr/bin/env bash
# BR7.4 (CI only): export the pack's ONNX graphs on the eval runner, from the pinned checkpoints.
#
# The graphs are derived files that never leave the pack build machine, so the dispatch-only
# eval workflow rebuilds them exactly as the pack build does: the pinned upstream code commits
# (spike/common.py PINS), the pinned checkpoints verified by sha256 (tools/fetch_models.py
# --sources), the spike's locked PyTorch environment, and the same export scripts. Output:
#
#   <out>/<every file models.py pins, BiRefNet at the tiles asked for>
#   <out>/birefnet_hr_matting_2048.fp32.onnx   the fp32 reference graph for the 06 band gate
#
# Whether each file is byte-identical to its darwin pin is recorded afterwards by
# eval/ci_graphs.py; nothing here is ever committed.
#
#   eval/ci_export_graphs.sh <out-dir> [tile ...]      (run from workers/smart-mask)
#
# scripts/dev-register-smart-mask.sh reuses it on a developer Mac with
# SMART_MASK_EXPORT_WATCHDOG=1: every export then runs under spike/watchdog.py, which kills
# it (and fails this script) before it can take a 16 GB machine down (README). The watchdog
# measures with macOS tools, so the linux CI runner runs the exports directly.
set -euo pipefail

OUT="${1:?usage: ci_export_graphs.sh <out-dir> [tile ...]}"
shift
TILES=("${@:-2048 1024}")
read -r -a TILES <<<"${TILES[*]}"
PACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$PACK/.cache"
UPSTREAM="$CACHE/upstream"
SAM2_COMMIT="2b90b9f5ceec907a1c18123530e92e794ad901a4"
BIREFNET_REVISION="5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"
mkdir -p "$OUT" "$UPSTREAM" "$CACHE/onnx"
OUT="$(cd "$OUT" && pwd)"

# Upstream code at the pinned commits (weights come separately, verified by digest).
if [[ ! -d "$UPSTREAM/sam2/.git" ]]; then
  git clone --quiet --filter=blob:none https://github.com/facebookresearch/sam2 "$UPSTREAM/sam2"
fi
git -C "$UPSTREAM/sam2" checkout --quiet "$SAM2_COMMIT"
if [[ ! -d "$UPSTREAM/BiRefNet_HR-matting/.git" ]]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone --quiet https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting \
    "$UPSTREAM/BiRefNet_HR-matting"
fi
GIT_LFS_SKIP_SMUDGE=1 git -C "$UPSTREAM/BiRefNet_HR-matting" checkout --quiet "$BIREFNET_REVISION"
ln -sfn BiRefNet_HR-matting "$UPSTREAM/birefnet_hr"

# The spike's locked environment (PyTorch lives only here, never in the pack).
(cd "$PACK/spike" && uv sync --locked --python 3.12 --quiet)
PY="$PACK/spike/.venv/bin/python"

# One export job, from the spike directory. Output goes to the watchdog log in local mode.
run_export() {
  if [[ "${SMART_MASK_EXPORT_WATCHDOG:-}" == "1" ]]; then
    # 10 GiB: the 768/1024 BiRefNet exports peaked at 7.5 GiB footprint on an M1 Pro.
    "$PY" watchdog.py --log "$CACHE/export.log" --max-footprint-gib 10 -- "$*"
  else
    "$PY" "$@"
  fi
}

# Pinned checkpoints, verified by sha256 against pack/models.lock.toml.
"$PY" "$PACK/tools/fetch_models.py" --sources
ln -sfn model.safetensors "$CACHE/weights/birefnet_hr_matting.safetensors"

cd "$PACK/spike"
for module in image_encoder decoder_multi_n1 memory_attention memory_encoder; do
  echo "::group::export SAM $module"
  run_export export_sam.py --module "$module" >/dev/null
  echo "::endgroup::"
done
for part in decoder_points decoder_mask constants; do
  echo "::group::export $part"
  run_export ../tools/export_onnx.py --part "$part"
  echo "::endgroup::"
done
for tile in "${TILES[@]}"; do
  echo "::group::export BiRefNet $tile"
  run_export export_birefnet.py --size "$tile" >/dev/null
  mv "$CACHE/onnx/birefnet_hr_matting_${tile}.fp16s.onnx" "$OUT/"
  if [[ "$tile" == "2048" ]]; then
    mv "$CACHE/onnx/birefnet_hr_matting_2048.fp32.onnx" "$OUT/"
  else
    rm -f "$CACHE/onnx/birefnet_hr_matting_${tile}.fp32.onnx"
  fi
  echo "::endgroup::"
done
for file in sam21l_image_encoder.fp32.onnx sam21l_decoder_multi_n1.fp32.onnx \
  sam21l_decoder_points.fp32.onnx sam21l_decoder_mask.fp32.onnx sam21l_memory_attention.fp32.onnx \
  sam21l_memory_encoder.fp32.onnx sam21l_constants.npz; do
  mv "$CACHE/onnx/$file" "$OUT/"
done
ls -la "$OUT"
