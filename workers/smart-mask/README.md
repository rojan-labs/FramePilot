# FramePilot Smart Mask Capability Pack

Background removal, AI Object and AI Brush for the desktop editor, shipped as a signed
on-demand Capability Pack (ADR 0114, ADR 0179). **Not** part of the base installer, not a
member of the root workspace, and never imported by `framepilot_engine`.

Capabilities: `subject.matte` (a lossless alpha matte + foreground colour for a clip range)
and `subject.segment_frame` (interactive single-frame masks against a warm worker).

## Models (decided in plan 02; evidence in BR0-FINDINGS)

| Role | Model | Licence | Ships as |
| --- | --- | --- | --- |
| Video segmentation and tracking | SAM 2.1 Hiera-Large, 5 ONNX graphs + orchestration constants | Apache-2.0 | fp32 (fp16-stored failed parity) |
| Edge refinement and alpha matting | BiRefNet_HR-matting, one static tile graph per size | MIT (training-data terms unverified, see LICENSES.md) | fp16-stored, fp32-computed |

Execution providers are enabled by parity evidence only (`models.py` `PARITY_TABLE`): today
SAM and BiRefNet both run on the **CPU EP**. CoreML is disabled for both on the measured
hardware; DirectML and Windows ML are unmeasured (MO-9) and therefore disabled.

## Pipeline

`decode → prompts → SAM forward + backward (windows of 300, 60 overlap, bounded memory bank)
→ BiRefNet refine (tiles) → consensus + unknown band → self-correction (K=3) → band alpha →
foreground colour → band-only stabilisation → verify → encode`. See
`plan/background-removal-ai/02-WORKER-PACK.md` for why each stage exists.

Decode and encode run through an **LGPL-only** `ffmpeg`/`ffprobe` binary in the pack's
`bin/`, not PyAV: every PyAV wheel checked bundles libx264/libx265 (GPL). Frames are decoded
with the engine's semantics (`-fps_mode passthrough`, autorotate, pixel aspect ratio applied,
rgb24 via `scale` bicubic), so `frames.json` pts and pixels agree with the export.

## Layout

```
pack/manifest.toml, pack/models.lock.toml, pack/sbom/
src/framepilot_smart_mask/   protocol, sandbox, runtime, models, pipeline stages
tools/                       fetch/verify models, SBOM + licence check, ONNX export (build time)
eval/                        construction-true pilot and the accuracy harness (BR3.15)
tests/                       unit suite with injected fakes; `decoded_media` = real weights
spike/                       BR0 verification spike (isolated env; PyTorch lives only there)
```

## Running

```bash
uv sync --extra cv --extra dev
uv run pytest tests/test_protocol.py        # one file at a time on a shared machine
```

Real-weight runs are opt-in and **must** run under `spike/watchdog.py` (8 GB physical
footprint cap, swap-growth abort, one heavy job at a time): the 16 GB development Mac shut
down twice during BR0.
