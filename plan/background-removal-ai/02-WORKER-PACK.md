# 02 — The worker pack: `framepilot.background-removal`

## Why a new pack, not a `subject-intelligence` 1.1

`subject-intelligence` was chosen deliberately small: ~42 MiB, OpenCV `dnn` only, "no second ML
runtime" (`pack/models.lock.toml` header). A matting pipeline needs onnxruntime and hundreds of
megabytes of weights. Folding it in would make every face-detection user download a matting
model. ADR 0176 already rejected "one pack for everything" for the same reason. The new pack
uses onnxruntime, which `visual-embed` already ships, so the platform gains no new runtime.

`subject-intelligence` stays as the **auto-prompt source**: `subject.detect` finds the main
person or object when the editor does not click. If it is not installed, the Inspector asks for
a click instead of requiring a second download.

## Pipeline (per request)

| Stage        | What                                                                                                                                                                                  | Why it matters for precision                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Decode    | Decode the clip's source range with pts via PyAV or an ffmpeg pipe, **not** `cv2.VideoCapture`. Record `frames.json` = `[pts]`.                                                       | Frame identity must match the engine's decode (see [`03`](./03-PROTOCOL-AND-HOST.md#frame-identity)). |
| 2. Prompt    | Prompts from the host: points (include/exclude), boxes, and correction frames. Auto mode uses a box from `subject.detect`, run by the host beforehand.                                | Works on any subject kind, not just people.                                                           |
| 3. Segment   | **SAM 2.1** video predictor: image encoder + memory attention propagate the prompted object forward and backward through the range.                                                   | Memory across frames removes most boundary flicker. Corrections on frame _k_ re-propagate from _k_.   |
| 4. Refine    | **BiRefNet** (high-resolution dichotomous segmentation) run on a padded crop around the SAM mask. The result is fused with the SAM mask as a guide, so BiRefNet cannot swap subjects. | SAM's mask decoder is low-resolution. BiRefNet recovers fine structure at 1024² crop resolution.      |
| 5. Matte     | Build a trimap from the refined mask (erode = sure foreground, dilate = sure background, band = unknown) and run an **alpha-matting model** on the band only.                         | Hair and semi-transparent edges get real fractional alpha, not a hard or blurred cut.                 |
| 6. Stabilise | Temporal smoothing of alpha in the unknown band only, guided by optical flow (`cv2.calcOpticalFlowFarneback`) and bounded so it never moves a confident pixel.                        | Removes residual edge shimmer without smearing motion.                                                |
| 7. Score     | Per-frame confidence: SAM IoU prediction, band-area ratio, and frame-to-frame alpha change. Emit `lowConfidence: [{startPts, endPts, reason}]`.                                       | Tells the editor where to look (principle 3 in the README).                                           |
| 8. Encode    | Master: FFV1 `gray` 8-bit in MKV at source resolution, lossless. Preview: VP9 `gray` in WebM at proxy resolution. Write `frames.json` and `manifest.json` (dims, pts, digests).       | Lossless master for export precision; a small, decodable proxy for the monitor.                       |

Full-resolution refinement at 4K is expensive. Stage 4 and 5 run at `min(source, 2160p)` on the
crop around the subject, never on the full frame, and the alpha is upsampled with a guided filter
against the full-resolution luma (`cv2.ximgproc.guidedFilter`, already in the pinned OpenCV
contrib wheel).

## Candidate models and licence gate (verified in BR0, not assumed here)

Licences change and my knowledge of them has a cutoff. Every row is re-checked at BR0 against
the upstream licence file at a pinned commit and recorded in `pack/models.lock.toml` +
`LICENSES.md`, the same way `subject-intelligence` records its models.

| Role               | Candidate                                     | Licence (to verify)                                                | Status                                                                                                              |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Video segmentation | SAM 2.1 (Hiera-S / Hiera-B+)                  | Apache-2.0 (code + checkpoints)                                    | **Primary.** Risk: ONNX export of memory attention (BR0).                                                           |
| Refinement         | BiRefNet (general / HR variants)              | MIT                                                                | **Primary.** Check training-data terms on the chosen checkpoint.                                                    |
| Alpha matting      | ViTMatte (ViT-S)                              | MIT code; **weights trained on Composition-1k / Distinctions-646** | **Open question.** Dataset terms may restrict commercial use of derived weights. BR0 decides.                       |
| Alpha matting alt. | Classical closed-form / guided-filter matting | n/a (algorithm, OpenCV)                                            | **Fallback** if no matting checkpoint passes the licence gate. Lower hair quality, which is measured and disclosed. |
| Rejected           | BRIA RMBG-1.4 / RMBG-2.0                      | Non-commercial (CC BY-NC-family)                                   | Rejected on licence, not on accuracy.                                                                               |
| Rejected           | Robust Video Matting                          | GPL-3.0                                                            | Strong copyleft; the SBOM gate rejects it (maintainer policy, 2026-08-25).                                          |
| Rejected           | MatAnyone and other S-Lab-licence models      | Non-commercial                                                     | Rejected on licence.                                                                                                |
| Rejected           | Ultralytics YOLO-seg                          | AGPL-3.0                                                           | Already rejected for `subject-intelligence`.                                                                        |

## Runtime

- `onnxruntime` with the CoreML EP on darwin-arm64 and the DirectML EP on win32-x64, CPU as the
  last resort. The pack records which EP ran in the result, and slow CPU runs are disclosed in
  the ETA before the job starts.
- Record the known `visual-embed` finding up front: CoreML refused batch > 1. Stage 3 is batch 1
  anyway, and stage 4/5 batch sizes are measured in BR0, not assumed.
- Memory: SAM 2 memory bank is bounded (N most recent + prompted frames). Long clips are
  processed in overlapping windows (e.g. 300 frames, 30 overlap) with the overlap cross-faded
  in the band only, so a 10-minute clip never holds all frames in memory.
- `manifest.toml`: `capabilities = ["subject.matte"]`, `network = "disabled"`,
  `max_unpacked_mib` set from the measured BR0 artifact, not guessed.

## BR0 — the spike that decides whether this plan stands

Nothing past BR0 starts until these are answered with numbers in `plan/background-removal-ai/BR0-FINDINGS.md`:

1. **ONNX export of SAM 2.1 video propagation** (encoder, prompt decoder, memory encoder,
   memory attention) runs on CoreML and DirectML and matches PyTorch within IoU ≥ 0.995 on 3
   fixture clips.
   - **Fallback if it does not:** SAM 2.1 _image_ mode per keyframe (every N frames) plus
     BiRefNet per frame, plus flow-guided propagation between keyframes. Flicker is measured
     against the primary pipeline. If the fallback misses the gate in [`06`](./06-PRECISION-AND-EVAL.md),
     the plan returns to the maintainer rather than shipping a flickering matte.
2. **Licences** for every checkpoint in the table above, including training-data terms.
3. **Throughput** on an M-series Mac and a mid-range Windows GPU for 1080p30 and 4K30: seconds
   of compute per second of footage. Target: ≤ 3× real-time for 1080p on Apple Silicon. If the
   measured figure is worse, the Inspector shows an honest ETA; the target is not quietly lowered.
4. **Artifact size** of the pack (weights + runtime) → sets `max_unpacked_mib` and the consent copy.
5. **Master matte size** for 1 min of 4K FFV1 gray → sets the storage warning threshold in the UI.

## Worker structure (mirrors `subject-intelligence`)

```
workers/background-removal/
  pyproject.toml, uv.lock, README.md, LICENSES.md
  pack/manifest.toml, pack/models.lock.toml, pack/sbom/
  tools/fetch_models.py, tools/generate_sbom.py, tools/export_onnx.py (build-time only)
  src/framepilot_background_removal/
    __main__.py  protocol.py  runtime.py  policy.py  sandbox.py  models.py
    decode.py  prompts.py  segment.py  refine.py  matting.py  stabilise.py
    confidence.py  encode.py  backend.py (injectable seam for unit tests)
  tests/ (unit with fakes; `decoded_media` marker for real weights + real media)
scripts/dev-register-background-removal.sh  (added to scripts/dev-register-all-packs.sh)
```

`tools/export_onnx.py` needs PyTorch **at pack build time only**. PyTorch never ships in the pack
and is never a repo dependency outside that tool's isolated environment.
