#!/bin/sh
# BR0.2: sequential parity chain on this machine (one model in memory at a time).
# Usage: nohup ./run_parity_chain.sh [sam|birefnet|all] > ../.cache/parity_chain.log 2>&1 &
set -u
cd "$(dirname "$0")"
PY=.venv/bin/python
which="${1:-all}"
eps="cpu coreml"
[ "$(uname)" != "Darwin" ] && eps="cpu dml"
run() { echo "== $* $(date +%H:%M:%S)"; $PY -u "$@" 2>&1 | grep -E "^sintel|^True|^False|^pass|^FAIL|reference written|Traceback|Error" ; }
if [ "$which" = sam ] || [ "$which" = all ]; then
  run parity_sam.py --reference
  for ep in $eps; do for p in fp32 fp16s; do run parity_sam.py --ep $ep --precision $p; done; done
fi
if [ "$which" = birefnet ] || [ "$which" = all ]; then
  run parity_birefnet.py --reference
  for ep in $eps; do for p in fp32 fp16s; do run parity_birefnet.py --ep $ep --precision $p; done; done
fi
echo "== chain done $(date +%H:%M:%S)"
