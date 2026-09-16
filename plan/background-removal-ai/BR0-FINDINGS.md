# BR0 findings — Smart Mask verification build

> Status: **in progress** (sections marked _pending_ are still being measured).
> Machine: Apple M1 Pro, 16 GB, macOS 26 (Darwin 25.2), shared with other builds and a VM.
> Spike code: `workers/smart-mask/spike/` (isolated uv env, Python 3.12, torch 2.14.0,
> onnxruntime 1.30.0, onnx 1.22.0). Raw results: `workers/smart-mask/spike/results/*.json`.
> Weights, ONNX files and media live in the git-ignored `workers/smart-mask/.cache/`.

## Memory incidents (BR0.7 finding; sets the minimum-hardware floor)

1. **BiRefNet_HR-matting PyTorch trace at 2048².** The TorchScript exporter needs a real forward.
   Measured PyTorch CPU fp32 peak footprint: 3.1 GB at 512², 7.9 GB at 1024²; 2048² extrapolates
   to roughly 27 GB. The trace drove system swap from 21.6 to 37.5 GB before it was killed.
   Fix: the dynamo exporter (fake tensors) exports 2048² at a 2.7 GB peak.
2. **Concurrent spike jobs.** SAM parity and pilot rendering running together, beside other agents'
   builds, pushed the machine past 70 GB of swap and it shut down. Fix: one heavy job at a time.
3. **SAM 2.1 video path under the CoreML EP.** One run reached a **16 GB physical footprint**
   while its RSS read 4.6 GiB (compressed/swapped pages and Core ML/Metal allocations are not RSS),
   and swap reached 15.5 of 16 GB before the maintainer's coordinator killed it. The run was also
   thrashing at 64 s per frame. Fixes: `spike/watchdog.py` now sums the **physical footprint**
   (`top -stats mem`) over the job's process tree every 5 s, kills above 8 GB footprint or 6 GB
   system swap, and waits for swap below 6 GB before starting; ORT sessions run without the CPU
   arena or memory-pattern planning; the replaced PyTorch modules are dropped in ONNX runs.
   A configuration that cannot fit is recorded as "not measured: exceeds 8 GB local budget".

_Pending: per-module footprint on CPU and CoreML, and the configurations that fit._
