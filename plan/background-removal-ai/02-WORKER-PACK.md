# 02 — The worker pack: `framepilot.smart-mask` (one pack, two models, about 1 GB)

## Why a new pack, not a `subject-intelligence` 1.1

`subject-intelligence` was chosen deliberately small: ~42 MiB, OpenCV `dnn` only, "no second ML
runtime" (`pack/models.lock.toml` header). A matting pipeline needs onnxruntime and hundreds of
megabytes of weights. Folding it in would make every face-detection user download a matting
model. ADR 0176 already rejected "one pack for everything" for the same reason. The new pack
uses onnxruntime, which `visual-embed` already ships, so the platform gains no new runtime.

`subject-intelligence` stays as the **auto-prompt source** (`subject.detect`). If it is not
installed, the Inspector asks for a click instead of requiring a second download.

## Precision is the design goal, not a tuning pass

The pipeline trades compute for accuracy everywhere the two conflict. There is one quality
level, the most accurate one; there is no "fast mode" that quietly ships worse edges. The
design aims at a result where **every frame is either verified correct by the pipeline's own
cross-checks, or put in front of the editor to confirm or fix**. Four mechanisms get there:

1. **The largest models that pass the licence gate**, at full source resolution where it matters.
2. **Independent estimates that must agree.** Pixels and frames where they disagree are exactly
   the ones that get more work, or get flagged.
3. **A self-correction loop** that re-prompts the segmenter from its own high-confidence frames
   before any frame reaches the editor.
4. **Editor corrections as hard constraints.** A frame the editor fixed or approved is never
   overwritten by propagation.

## Pipeline (per request)

| Stage                | What                                                                                                                                                                                                                                                                                                                                                                     | Precision role                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Decode            | Full-resolution decode of the clip's source range with pts via PyAV/ffmpeg, never `cv2.VideoCapture`. `frames.json` = `{version, timeBase, originPts, firstFrame, pts}` (docs/api/timeline-schema.md, "Matte masks"). Frames are turned and stretched to DISPLAY space (rotation applied, pixel aspect ratio applied, size `floor(display + 0.5)`) before segmentation, so every output is display space (BR2.6). Colour converted with the same matrix and range the engine uses.                                                                                                                                                                          | Frame identity and colour agree with the export ([`03`](./03-PROTOCOL-AND-HOST.md#frame-identity)).                                                            |
| 2. Prompts           | Points (include/exclude), boxes, **correction masks** (editor brush strokes, full-res PNG) and **locked frames** (editor-approved alpha). Auto mode uses the host's `subject.detect` box.                                                                                                                                                                                | Editor input is data the pipeline must honour, not a hint.                                                                                                     |
| 3. Segment ×2        | **SAM 2.1 Hiera-Large** video predictor (image encoder, prompt decoder, memory encoder, memory attention), fp32, run **forward and backward** from every prompt and locked frame, memory bank seeded with locked frames.                                                                                                                                                 | Two independent temporal estimates per frame.                                                                                                                  |
| 4. Refine + alpha    | **BiRefNet_HR-matting** (trained at 2048² for matting with transparency) on a padded crop around the subject, tiled with overlap above 2048², guided by the SAM consensus so it cannot switch subjects. It produces **fractional alpha**, not a binary mask.                                                                                                             | Recovers hair, fine structure and soft edges the SAM decoder's resolution cannot.                                                                              |
| 5. Consensus         | Per pixel: forward SAM, backward SAM, BiRefNet and the flow-warped previous frame's alpha. Unanimous pixels are fixed at 0 or 1; disagreement pixels form the **unknown band**. Per frame: a disagreement score.                                                                                                                                                         | Turns "the model is unsure" into a measured region and a measured frame score.                                                                                 |
| 6. Self-correct      | Frames whose score crosses the threshold are re-segmented with **auto-generated prompts** (positive and negative points sampled from the consensus of the nearest high-confidence frames on both sides), for up to `K=3` rounds. Frames still failing are flagged.                                                                                                       | Most drift and subject-swap errors are fixed before the editor sees them.                                                                                      |
| 7. Band alpha        | Inside the unknown band, alpha comes from BiRefNet_HR-matting run again at **full source resolution** on tiles centred on the band, blended with overlap. Outside the band, consensus values are exact 0 or 1.                                                                                                                                                           | Real fractional alpha for hair, motion blur and translucency, from the same model that refined the edge, so there is no second matting model to disagree with. |
| 8. Foreground colour | Estimate the true foreground colour in the band (multi-level foreground estimation, an MIT-licensed numpy algorithm; no model) so edges carry the subject's colour, not the old background's.                                                                                                                                                                            | Removes the halo or colour fringe that shows once something new is behind the subject.                                                                         |
| 9. Stabilise         | Temporal smoothing of alpha **in the band only**, flow-guided, bounded so no pixel that stage 5 fixed and no locked frame changes.                                                                                                                                                                                                                                       | Kills edge shimmer without smearing motion.                                                                                                                    |
| 10. Verify           | Independent per-frame checks: (a) alpha re-warped by optical flow from both neighbours, compared with this frame's; (b) connected-component audit (new islands or holes vs neighbours); (c) edge alignment of the alpha gradient against image gradients in the band; (d) subject area and centroid continuity. Any check failing → `needsReview` range with the reason. | "Unsure" becomes a list the editor can clear, not a defect they find after export.                                                                             |
| 11. Encode           | `matte.mkv` FFV1 gray 8-bit and `foreground.mkv` FFV1 (band pixels only, zero elsewhere, which compresses to near nothing) at source resolution, lossless; `preview.webm` + `foreground.preview.webm` VP9 at proxy resolution; `frames.json`; `report.json` (per-frame scores, check results, rounds used).                                                              | A lossless master for export and a small proxy for the monitor.                                                                                                |

Alpha is never produced below source resolution. 4K footage gets a 4K matte.

## Model choices (decided 2026-09-16 from current sources; BR0 verifies, it does not choose)

| Role                                                            | **Chosen**                                                                                                                                                                                                                                                                                | Licence (verified 2026-09-16)                                                       | Why this one                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video segmentation and tracking (clicks, boxes, brushes, locks) | **SAM 2.1 Hiera-Large**, fp32                                                                                                                                                                                                                                                             | Apache-2.0 (code and checkpoints)                                                   | A permissive standard licence; 224M parameters, so it fits beside the refiner in 16 GB; community video exports **with** the memory modules already exist and were validated against PyTorch (worst per-frame IoU 0.9967 on the tiny variant), so the export path is proven, not hoped for                 |
| Edge refinement **and** alpha matting                           | **BiRefNet_HR-matting**, fp32                                                                                                                                                                                                                                                             | MIT; trained on DIS5K training data, which the authors state is usable commercially | Trained at 2048² for matting with transparency, so one model gives both high-resolution edges and fractional alpha. Replaces the ViTMatte + classical-fallback pair: ViTMatte's Composition-1k/Distinctions-646 training data is a licence risk, and one model is more reliable than two that can disagree |
| Text → objects for AI masking ("the red car")                   | **No extra model in v1.** Host-side resolution from Subject Intelligence detections (faces, people, 80 object classes; 42 MB, already built), re-ranked by SigLIP text similarity when `visual-embed` is installed; anything outside that vocabulary ("the sky") asks the editor to click | —                                                                                   | Avoids an 848M-parameter download and a gated checkpoint for a convenience feature. The click path gives the same matte precision; the only cost is one click for out-of-vocabulary targets, and the AI asks instead of guessing                                                                           |
| Foreground colour                                               | Multi-level foreground estimation                                                                                                                                                                                                                                                         | MIT (algorithm, numpy)                                                              | Deterministic, no weights                                                                                                                                                                                                                                                                                  |
| Optical flow (consensus, stabilise, verify)                     | **OpenCV DIS** (dense inverse search), fixed preset                                                                                                                                                                                                                                       | Apache-2.0 (OpenCV 4.5+)                                                            | Deterministic and fast; the verify stage needs a stable reference, not a learned model that can hallucinate motion                                                                                                                                                                                         |
| Faces and identity                                              | YuNet + SFace (existing Subject Intelligence / visual-embed)                                                                                                                                                                                                                              | MIT / Apache-2.0                                                                    | Already audited and shipped                                                                                                                                                                                                                                                                                |

**Why two models and not one.** No single permissively licensed model does both jobs well. SAM 2.1
follows an object through time (memory across frames) but its mask is low resolution; BiRefNet_HR-matting
produces hair-accurate alpha at 2048² but has no notion of time or of _which_ object. Premiere Pro's Object
Masking (Sharp/Smooth modes) and Resolve's Magic Mask pair tracking with edge refinement for the same
reason. Removing either model would lose flicker-free tracking or hair-accurate edges.

**Download size (one pack, on demand only):**

| Part                                         | Size                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| SAM 2.1 Hiera-Large weights                  | ~450 MB stored as fp16 (898 MB as the fp32 checkpoint)                                              |
| BiRefNet_HR-matting weights                  | ~445 MB stored as fp16 (the published checkpoint is 444 MB)                                         |
| onnxruntime + OpenCV + FFmpeg (LGPL) runtime | ~150 MB, measured in BR0                                                                            |
| **Total**                                    | **≈ 1.05 GB**, downloaded only when the editor first uses background removal, AI Object or AI Brush |

**Stored fp16, computed fp32.** Weights are stored as fp16 to halve the download and are upcast to fp32 at
load, so every computation runs in fp32. This is allowed **only if** the upcast models pass the same parity
gate as the fp32 originals (per-frame IoU ≥ 0.999; band alpha ≤ 1/255 mean). If either fails, that model
ships fp32 and the download grows to match. Precision is never traded for size.

Everything else needs no model download: all manual masks, keys, split/mirror/gradient/track-matte masks,
and tracking (Tracking Lite, no weights). Face detection for AI requests uses Subject Intelligence (42 MB).

**Rejected, with the reason re-confirmed on 2026-09-16:**

| Model                                           | Reason                                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MatAnyone 2 (CVPR 2026)                         | NTU S-Lab License 1.0, non-commercial                                                                                                                                         |
| MatAnyone, other S-Lab models                   | Non-commercial                                                                                                                                                                |
| BRIA RMBG-1.4 / RMBG-2.0                        | Non-commercial                                                                                                                                                                |
| Robust Video Matting                            | GPL-3.0 (strong copyleft; SBOM gate)                                                                                                                                          |
| Ultralytics YOLO-seg                            | AGPL-3.0                                                                                                                                                                      |
| ViTMatte                                        | Training-data terms (Composition-1k / Distinctions-646); superseded by BiRefNet_HR-matting                                                                                    |
| SAM 3.1, Grounding DINO, OWLv2 (text grounding) | Deferred from v1: 0.6–3.4 GB extra for a convenience the click path already covers; SAM 3.1 is also gated. Revisit only if AM5 shows out-of-vocabulary asks are a real burden |

**Precision rules for the models:** the delivered-pixel path (SAM 2.1, BiRefNet_HR-matting) is fp32 end to
end, with no fp16, int8 or pruning. SAM 2.1's rotary position embedding uses complex tensors, which do
not export; it is rewritten with the real-valued cos/sin form, which is mathematically identical, and
parity-tested.

## Runtime (decided)

- **One model format:** fp32 ONNX (opset pinned) run by **onnxruntime**, the same runtime `visual-embed`
  ships. The same files run on both platforms, and parity is tested once per execution provider.
- **macOS (Apple Silicon):** CoreML EP in MLProgram format with static input shapes (fixed tile and crop
  sizes; CoreML is strict about dynamic dimensions), falling back per operator to the CPU EP.
- **Windows 11 24H2+:** **Windows ML**, which selects and keeps vendor EPs updated through Windows Update
  (TensorRT-RTX on NVIDIA RTX, OpenVINO on Intel, Vitis AI on AMD, DirectML otherwise).
  **Windows 10 / older 11:** the DirectML EP, which is in maintenance mode but supported and shipped with
  Windows. **CPU EP** everywhere as the last resort.
- **Correctness beats speed, as a rule rather than a judgement call:** each (model, EP) pair must match the
  PyTorch reference on the parity set (per-frame IoU ≥ 0.999 and mean absolute alpha difference ≤ 1/255 on
  the band). A pair that fails is **disabled for that model** and the next EP in the chain is used,
  ending at CPU. The chosen EP per model is recorded in every result.
- Known: CoreML refused batch > 1 in `visual-embed`, so the pipeline is batch 1.
- Long clips are processed in overlapping windows (300 frames, 60 overlap). Overlaps go through consensus
  like any other pair of estimates, so a window seam is verified, not blended blindly.
- `manifest.toml`: `capabilities = ["subject.matte", "subject.segment_frame"]`; `network = "disabled"`; `max_unpacked_mib` from the measured
  artifact.

## Production requirements (from the audit in [`12`](./12-PARITY-AND-PRODUCTION-AUDIT.md))

- **Windows execution provider:** decided above (Windows ML → DirectML → CPU, per-model parity gate).
- **First-run model preparation** (CoreML compilation, EP graph optimisation) is its own progress phase,
  `prepare`, and its result is cached in the pack's data directory keyed by model digest + EP + OS
  version, so it runs once.
- **Interactive single-frame segmentation** (`subject.segment_frame`) keeps a warm worker process with
  the image encoder loaded and caches per-frame embeddings (LRU, bounded memory). Hover highlight and
  click-to-mask read from that cache. The full-clip `subject.matte` job reuses those embeddings.
- **Progressive output:** each processing window is encoded and verified as soon as it finishes, so the
  host can hand finished ranges to the preview while later windows run, and a crash or quit resumes from
  the last finished window.
- **Resource limits:** per-job memory ceiling (measured in BR0 per resolution), a wall-clock watchdog per
  window, and graceful fallback to CPU on GPU out-of-memory, reported in the result.
- **Minimum hardware** is published from BR0 measurements. The planned floor: Apple Silicon with 16 GB
  (8 GB supported with a slower CPU-offload notice); Windows x64 with a DX12-class GPU and 16 GB. Intel
  Macs are not supported by the Smart Mask pack, and the install warning says so before download.
- **FFmpeg inside the pack** (via PyAV or a bundled binary) must be an **LGPL-only** build. The build
  configuration is checked by `tools/generate_sbom.py --check` and recorded in `LICENSES.md`, because a
  GPL component would fail the licence policy.

## BR0 — verification build (it measures; it no longer chooses)

Every model and runtime above is decided. BR0 builds the reference harness and records numbers in
`BR0-FINDINGS.md`:

1. **Export and parity:** SAM 2.1 Hiera-L video modules (real-valued RoPE) and BiRefNet_HR-matting to
   ONNX, each as fp32 and as fp16-stored/fp32-computed. Parity against PyTorch per (model, EP) with the thresholds in Runtime.
   Pairs that fail are disabled by rule.
2. **Licence file review:** pinned-commit licence texts (Apache-2.0; MIT plus the DIS5K statement) into
   `LICENSES.md`.
3. **Error-detection recall** of the verify stage on the labelled pilot set (gate ≥ 99.5%). If it misses,
   the verify checks are improved before anything else is built; the models do not change.
4. **Throughput, memory and first-run preparation time** per EP at 1080p30 and 4K30, which set the ETA
   copy and the published minimum hardware.
5. **Pack size** (target ≈ 1.05 GB) and matte + foreground storage per minute.

## Worker structure (mirrors `subject-intelligence`)

```
workers/smart-mask/
  pyproject.toml, uv.lock, README.md, LICENSES.md
  pack/manifest.toml, pack/models.lock.toml, pack/sbom/
  tools/fetch_models.py, tools/generate_sbom.py, tools/export_onnx.py (build-time only)
  src/framepilot_smart_mask/
    __main__.py protocol.py runtime.py policy.py sandbox.py models.py
    decode.py prompts.py segment.py refine.py consensus.py self_correct.py
    matting.py foreground.py stabilise.py verify.py encode.py report.py
    backend.py (injectable seam for unit tests)
  eval/run_eval.py
  tests/ (unit with fakes; `decoded_media` marker for real weights + real media)
scripts/dev-register-smart-mask.sh (added to scripts/dev-register-all-packs.sh)
```

`tools/export_onnx.py` needs PyTorch **at pack build time only**. PyTorch never ships in the pack.
