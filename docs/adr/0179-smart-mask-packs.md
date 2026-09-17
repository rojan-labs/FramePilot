# ADR 0179 — Smart Mask ships as one pack: SAM 2.1 Hiera-L + BiRefNet_HR-matting on onnxruntime

- **Status:** Accepted for the model and runtime choice; the per-EP enablement and the minimum
  hardware are **pending maintainer decisions** recorded in BR0-FINDINGS.
- **Date:** 2026-09-17
- **Relates to:** ADR 0114 (heavy capabilities ship as on-demand packs), ADR 0176 (local
  perception ships as packs), ADR 0178 (the mask stack; `matte` layers consume this pack).
- **Plan:** [`plan/background-removal-ai/02-WORKER-PACK.md`](../../plan/background-removal-ai/02-WORKER-PACK.md),
  evidence in [`BR0-FINDINGS.md`](../../plan/background-removal-ai/BR0-FINDINGS.md).

## Context

Background removal, AI Object and AI Brush need a video segmenter that follows one subject
through time and a matting model that gives fractional alpha on hair, blur and translucency.
Subject Intelligence (42 MB, OpenCV DNN only) was kept small on purpose; folding a ~1 GB
matting stack into it would make every face-detection user download it (ADR 0176 already
rejected "one pack for everything"). The models were chosen in 02 from current licences; BR0
exported them, measured parity per execution provider, prototyped consensus and verification,
and measured size, throughput and memory on a 16 GB Apple M1 Pro.

## Decision

1. **One on-demand pack, `framepilot.smart-mask`, two models.**
   - **SAM 2.1 Hiera-Large** (Apache-2.0, facebookresearch/sam2 @ `2b90b9f5`): video
     segmentation and tracking, exported as four ONNX modules (image encoder; prompt encoder +
     mask decoder + object pointer; memory attention; memory encoder). The upstream orchestration
     (memory bank selection, temporal encodings) is small arithmetic that the worker reimplements.
   - **BiRefNet_HR-matting** (MIT, ZhengPeng7/BiRefNet_HR-matting @ `5d6b6f8a`): edge refinement
     and alpha matting in the unknown band, guided by the SAM consensus.
   - No text-grounding model in v1. Faces reuse YuNet/SFace; optical flow is OpenCV DIS.
2. **Exports that are identical maths, not approximations.** SAM 2.1's complex rotary encoding
   is rewritten as real-valued cos/sin (max |Δ| 4.8e-7 vs upstream); memory attention takes a
   static, padded memory (7 slots × 4096 tokens + 64 pointer tokens) with a key mask so shapes
   are static. BiRefNet's `deform_conv2d` exports to the standard ONNX `DeformConv` (opset 19)
   through the dynamo exporter, which traces with fake tensors (the TorchScript tracer needs a
   real 2048² forward, about 27 GB).
3. **One runtime: onnxruntime.** Chain per model: macOS → CoreML EP (MLProgram, static shapes)
   → CPU EP; Windows 11 24H2+ → Windows ML → DirectML → CPU; Windows 10 → DirectML → CPU.
4. **Parity disables, by rule.** Every (model, module, EP, precision) must match the PyTorch
   reference on the parity set (SAM per-frame IoU ≥ 0.999; BiRefNet band mean |Δα| ≤ 1/255 and
   max ≤ 4/255). A pair that fails, cannot be built, or does not fit the memory budget is disabled
   and the next EP is used; the EP actually used is recorded in every result. BR0 outcomes on
   Apple M1 Pro 16 GB:
   - SAM 2.1 CPU EP fp32: **pass** (min per-frame IoU 0.99954).
   - SAM 2.1 CPU EP fp16-stored/fp32-computed: **fail** (min 0.99832) → SAM ships **fp32**.
   - SAM 2.1 CoreML EP: memory attention needs an 8.4 GB footprint (CPU: 2.4 GB) and is slower;
     `decoder_single_n2` (box / multi-point prompts) cannot be built by Core ML; the image
     encoder builds (422 s first-run preparation) but its video-path parity was not measurable
     inside the machine's memory budget → **disabled on this hardware class**.
   - BiRefNet_HR-matting CPU EP, fp32 and fp16-stored: **pass** at 768² vs PyTorch.
   - BiRefNet_HR-matting at its trained 2048²: CPU EP footprint above 12 GB, CoreML EP not
     buildable inside the budget → **not measured on 16 GB**; see Consequences.
   - Windows ML / DirectML rows: not measured (no Windows GPU machine; MO-9). The parity scripts
     run unchanged there.
5. **Stored fp16, computed fp32, only where parity holds.** Per model, not per file: SAM fails
   the gate as fp16-stored and ships fp32; BiRefNet passes and may ship fp16-stored.
6. **One quality level.** No fast mode. A model or EP that cannot deliver the reference result
   is disabled, never approximated.

## Rejected (from 02, re-confirmed 2026-09-16)

| Option | Reason |
| --- | --- |
| MatAnyone 2 / MatAnyone / other S-Lab models | NTU S-Lab License 1.0, non-commercial |
| BRIA RMBG-1.4 / RMBG-2.0 | Non-commercial |
| Robust Video Matting | GPL-3.0 (strong copyleft; SBOM gate) |
| Ultralytics YOLO-seg | AGPL-3.0 |
| ViTMatte | Composition-1k / Distinctions-646 training-data terms; superseded by BiRefNet_HR-matting |
| SAM 3.1, Grounding DINO, OWLv2 | 0.6–3.4 GB extra for text grounding the click path covers; SAM 3.1 gated |
| Folding into Subject Intelligence | Every face-detection user would download ~1 GB (ADR 0176) |
| Two matting models (ViTMatte + classical fallback) | Two estimates that can disagree; one model does both jobs |

## Consequences

- **Licence finding (open).** BR0 could not find the "DIS5K training data is commercially
  usable" statement 02 relied on. At the pinned commits the BiRefNet model zoo lists matting
  training sets that include P3M-10k, AM-2k and Distinctions-646, the last being the dataset 02
  gave as the reason to reject ViTMatte. The code licence (MIT) is verified; the training-data
  terms are not. The pack must not ship until the maintainer resolves this (BR0-FINDINGS).
- **Hardware.** On a 16 GB Apple Silicon Mac, the delivered-pixel path runs on the CPU EP only,
  and BiRefNet at 2048² does not fit beside a normal workload. The planned "Apple Silicon 16 GB"
  floor is not supported by the measurements; the published minimum hardware is a maintainer
  decision informed by BR0-FINDINGS.
- **Pack size.** fp32 SAM (≈ 0.92 GB of ONNX) + fp16-stored BiRefNet (≈ 0.45 GB) + runtime
  (≈ 0.1 GB) ≈ 1.47 GB, above the 1.05 GB target, because SAM failed the fp16-stored gate.
- **Verification is a gate, not a promise.** The verify stage's error-detection recall and
  review load on the construction-true pilot set are in BR0-FINDINGS; the human-labelled set
  (MO-8) is still required before the pack can claim "Verified".
