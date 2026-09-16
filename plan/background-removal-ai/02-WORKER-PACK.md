# 02 — The worker pack: `framepilot.background-removal`

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

| Stage                | What                                                                                                                                                                                                                                                                                                                                                                     | Precision role                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1. Decode            | Full-resolution decode of the clip's source range with pts via PyAV/ffmpeg, never `cv2.VideoCapture`. `frames.json` = `[pts]`. Colour converted with the same matrix and range the engine uses.                                                                                                                                                                          | Frame identity and colour agree with the export ([`03`](./03-PROTOCOL-AND-HOST.md#frame-identity)). |
| 2. Prompts           | Points (include/exclude), boxes, **correction masks** (editor brush strokes, full-res PNG) and **locked frames** (editor-approved alpha). Auto mode uses the host's `subject.detect` box.                                                                                                                                                                                | Editor input is data the pipeline must honour, not a hint.                                          |
| 3. Segment ×2        | **SAM 2.1 Hiera-L** video propagation run **forward and backward** from every prompt and locked frame, memory bank seeded with locked frames.                                                                                                                                                                                                                            | Two independent temporal estimates per frame.                                                       |
| 4. Refine            | **BiRefNet HR** on a padded crop around the subject at up to 2048² (tiled beyond that), guided by the SAM consensus so it cannot switch subjects.                                                                                                                                                                                                                        | Recovers fine structure the SAM decoder's resolution cannot.                                        |
| 5. Consensus         | Per pixel: forward SAM, backward SAM, BiRefNet and the flow-warped previous frame's alpha. Unanimous pixels are fixed at 0 or 1; disagreement pixels form the **unknown band**. Per frame: a disagreement score.                                                                                                                                                         | Turns "the model is unsure" into a measured region and a measured frame score.                      |
| 6. Self-correct      | Frames whose score crosses the threshold are re-segmented with **auto-generated prompts** (positive and negative points sampled from the consensus of the nearest high-confidence frames on both sides), for up to `K=3` rounds. Frames still failing are flagged.                                                                                                       | Most drift and subject-swap errors are fixed before the editor sees them.                           |
| 7. Matte             | Alpha matting on the unknown band only, at **full source resolution** (tiled with overlap), from a trimap built from the consensus.                                                                                                                                                                                                                                      | Real fractional alpha for hair, motion blur and translucency.                                       |
| 8. Foreground colour | Estimate the true foreground colour in the band (multi-level foreground estimation, an MIT-licensed numpy algorithm; no model) so edges carry the subject's colour, not the old background's.                                                                                                                                                                            | Removes the halo or colour fringe that shows once something new is behind the subject.              |
| 9. Stabilise         | Temporal smoothing of alpha **in the band only**, flow-guided, bounded so no pixel that stage 5 fixed and no locked frame changes.                                                                                                                                                                                                                                       | Kills edge shimmer without smearing motion.                                                         |
| 10. Verify           | Independent per-frame checks: (a) alpha re-warped by optical flow from both neighbours, compared with this frame's; (b) connected-component audit (new islands or holes vs neighbours); (c) edge alignment of the alpha gradient against image gradients in the band; (d) subject area and centroid continuity. Any check failing → `needsReview` range with the reason. | "Unsure" becomes a list the editor can clear, not a defect they find after export.                  |
| 11. Encode           | `matte.mkv` FFV1 gray 8-bit and `foreground.mkv` FFV1 (band pixels only, zero elsewhere, which compresses to near nothing) at source resolution, lossless; `preview.webm` + `foreground.preview.webm` VP9 at proxy resolution; `frames.json`; `report.json` (per-frame scores, check results, rounds used).                                                              | A lossless master for export and a small proxy for the monitor.                                     |

Alpha is never produced below source resolution. 4K footage gets a 4K matte.

## Candidate models and licence gate (verified in BR0, not assumed here)

Licences change and my knowledge of them has a cutoff. Every row is re-checked at BR0 against
the upstream licence file at a pinned commit, including **training-data terms**, and recorded in
`pack/models.lock.toml` + `LICENSES.md` the way `subject-intelligence` records its models.

| Role                             | Candidate                                                                                       | Licence (to verify)                                            | Status                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Video segmentation               | SAM 2.1 Hiera-L (Hiera-B+ measured as a comparison only)                                        | Apache-2.0                                                     | **Primary.** Risk: ONNX export of memory attention (BR0).                                                         |
| Refinement                       | BiRefNet HR / HR-matting variants                                                               | MIT                                                            | **Primary.** Check training-data terms of the chosen checkpoint.                                                  |
| Alpha matting                    | ViTMatte (largest variant that passes)                                                          | MIT code; weights trained on Composition-1k / Distinctions-646 | **Open.** Dataset terms may bar commercial use of derived weights. BR0 decides.                                   |
| Alpha matting alt.               | Classical closed-form matting on the band                                                       | n/a (algorithm)                                                | **Fallback.** Measured against the gates in `06`; if it misses the hair gate, the plan returns to the maintainer. |
| Foreground colour                | Multi-level foreground estimation                                                               | MIT (algorithm, numpy)                                         | Primary. No weights.                                                                                              |
| Optical flow (verify, stabilise) | OpenCV DIS / Farneback; a learned flow model only if BR0 shows the classical checks miss errors | BSD/Apache (OpenCV)                                            | Primary.                                                                                                          |
| Rejected                         | BRIA RMBG-1.4 / RMBG-2.0                                                                        | Non-commercial                                                 | Rejected on licence, not on accuracy.                                                                             |
| Rejected                         | Robust Video Matting                                                                            | GPL-3.0                                                        | Strong copyleft; the SBOM gate rejects it.                                                                        |
| Rejected                         | MatAnyone and other S-Lab-licence models                                                        | Non-commercial                                                 | Rejected on licence.                                                                                              |
| Rejected                         | Ultralytics YOLO-seg                                                                            | AGPL-3.0                                                       | Already rejected for `subject-intelligence`.                                                                      |

**If a strictly better model appears under a permissive licence**, swapping it in is a
`models.lock.toml` change plus a re-run of the `06` eval. The pipeline stages do not change.

## Runtime

- `onnxruntime` with the CoreML EP (darwin-arm64) and DirectML EP (win32-x64). The result records
  the EP. **A CPU fallback runs the same models at the same precision**; it is slower, not worse.
  The ETA says so.
- The known `visual-embed` CoreML finding (batch > 1 refused) is recorded up front. Batch sizes
  are measured in BR0.
- Long clips are processed in overlapping windows (e.g. 300 frames, 60 overlap). Overlaps go
  through stage 5 consensus like any other pair of estimates, so a window seam is verified, not
  cross-faded blindly.
- `manifest.toml`: `capabilities = ["subject.matte"]`, `network = "disabled"`, and
  `max_unpacked_mib` from the measured BR0 artifact.

## BR0 — the spike that decides whether this plan stands

Nothing past BR0 starts until these are answered with numbers in `BR0-FINDINGS.md`:

1. **ONNX export of SAM 2.1 Hiera-L video propagation** on CoreML and DirectML matches PyTorch
   within IoU ≥ 0.999 on 3 clips.
   - **Fallback:** SAM 2.1 image mode on dense keyframes + BiRefNet per frame + flow propagation.
     It goes through the same consensus, self-correction and verification stages and must pass
     the same gates. It is not a lower bar.
2. **Licences**, including training data, for every checkpoint.
3. **Error-detection recall:** on the labelled set, the stage 10 checks catch ≥ 99% of frames
   whose IoU < 0.98 (measured on the fallback and primary pipelines). This number is the heart
   of the precision claim; if it misses, stage 10 is redesigned before anything else is built.
4. **Throughput** (1080p30, 4K30 × EP) with the full pipeline. No target is traded for speed;
   the figure sets the ETA copy and the long-job confirmation.
5. **Pack size** and **matte + foreground storage** per minute at 1080p and 4K.

## Worker structure (mirrors `subject-intelligence`)

```
workers/background-removal/
  pyproject.toml, uv.lock, README.md, LICENSES.md
  pack/manifest.toml, pack/models.lock.toml, pack/sbom/
  tools/fetch_models.py, tools/generate_sbom.py, tools/export_onnx.py (build-time only)
  src/framepilot_background_removal/
    __main__.py protocol.py runtime.py policy.py sandbox.py models.py
    decode.py prompts.py segment.py refine.py consensus.py self_correct.py
    matting.py foreground.py stabilise.py verify.py encode.py report.py
    backend.py (injectable seam for unit tests)
  eval/run_eval.py
  tests/ (unit with fakes; `decoded_media` marker for real weights + real media)
scripts/dev-register-background-removal.sh (added to scripts/dev-register-all-packs.sh)
```

`tools/export_onnx.py` needs PyTorch **at pack build time only**. PyTorch never ships in the pack.
