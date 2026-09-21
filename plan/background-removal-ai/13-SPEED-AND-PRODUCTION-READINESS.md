# 13 · Speed and production readiness (2026-09-21)

Triggered by a maintainer report: _Remove background_ on a 52-second 1080p clip ran for more than
five hours without finishing a step, the Jobs panel showed a full bar beside the word "prepare",
and the clip was processed as one piece.

Status: **SP0–SP3 shipped** (ADR 0182). The maintainer asked for the structural change on
2026-09-21. The spike changed the plan: see "F. What the spike found" — the GPU does not rescue
these models, Apple Vision does. SP5 measured (section G): Fast is a one-clear-subject engine. Open: SP4 (Windows).

## A. What actually happened (measured on the live job)

| Fact                                                             | Evidence                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clip: 1920×1080, 30 fps, 51.8 s = 1,553 frames, no prompts       | `capability-pack-jobs.json`, `scratch/window-0.u8` = 300 × 6.2 MB                                                                                                                                                                                 |
| The worker runs on the **CPU only**                              | ORT CPU EP; the CoreML EP was disabled in BR0 (SAM-L fp32 does not build as a set, 16 GB footprint)                                                                                                                                               |
| Stage 1 of ~10 (SAM image encoding) ran at **≈ 6–7 s per frame** | ~96 embeddings after 11.8 min of wall time at 4 busy cores                                                                                                                                                                                        |
| The plan already predicted this                                  | BR0.7: **≈ 520 compute-seconds per footage-second** at 1080p30 with 1024² matting, ≈ 1,210 at 2048² ("≈ 20 h per footage minute"). For this clip: **7.5–17 h**, before up to three self-correction rounds. The host's job timeout ceiling is 24 h |
| A restart throws away up to ~100 minutes                         | Checkpoints exist only per 300-frame window, and stages run breadth-first across the window (encode all 300 → track all → matte all → …). The journal showed `finishedWindows: []` after the restart: everything before it was lost               |
| The host treats the clip as **one unit**                         | `matte-ipc.ts` calls `checkpoint()` once, before the worker starts, and `finishWindow(0)` once, at the end. So **Pause does nothing** for hours, the export pause never engages, and nothing is committed until the whole clip is done            |
| The bar and the ETA were wrong                                   | The bar drew one phase's counter (`prepare 1/1` = 100%); `withEta` divided the whole job's elapsed time by one phase's counter; `prepare` had no label                                                                                            |

So this is not a hang. It is an accuracy-first research pipeline (SAM 2.1 **Large** fp32 → BiRefNet-HR
→ consensus → K=3 self-correction → stabilise → verify), on the CPU, shipped as the only path.
`08-DEFERRED-AND-RISKS` rated "throughput too slow" High and answered it with "an honest ETA",
which is not a product answer: Final Cut's Magnetic Mask and Resolve's Magic Mask 2 do the same
user task in roughly clip-length time on the same Macs.

## B. SP0 — shipped in this change (no new dependency, no protocol change)

- Panel: a labelled **current step** ("Finding the subject · 71 of 300") with its own bar and
  "about N min left in this step"; uncounted steps (model loading) sweep instead of showing 0/100%;
  the row says how long the job has run; every phase has an editor-facing name.
- Pause on a running job says **"Pausing after this step"** and disables the button, instead of
  silently doing nothing (`pausePending` on the job wire).
- Host: the step ETA is measured from the start of the phase and restarts per window
  (`createPhaseEta`).

What SP0 deliberately does **not** claim: whole-job progress. The worker does not report it, and
faking it from one phase's counter is the bug being fixed. It arrives with SP2.

## C. Research: what fast and precise looks like in 2026

| Option                                                                                                      | Speed evidence                                                  | Quality                                                    | Licence                                      | Verdict                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Current (SAM 2.1-L fp32 + BiRefNet-HR, ORT CPU)                                                             | 17–40 s/frame measured here                                     | Best of the set (06 gates)                                 | Apache / MIT (MO-11 open on HR-matting data) | Keep as opt-in **Best**, never the default                                                                                  |
| SAM 2.1 via **Core ML directly** (coremltools fp16, static 1024²)                                           | Encoder ≈ 310 ms on CPU+GPU vs 5.2 s here; does not fit the ANE | Same model family                                          | Apache-2.0                                   | Strong candidate for the tracker. BR0 tested only the **ORT CoreML EP on fp32 Large**, which is the slow way to use Core ML |
| **EdgeTAM** (Meta, CVPR 2025)                                                                               | 16 fps on an iPhone 15 Pro Max via Core ML, 22× SAM 2           | On par with SAM 2 on video benchmarks                      | Apache-2.0                                   | Best tracker candidate for the **Fast** tier                                                                                |
| BiRefNet (lite / dynamic / matting), fp16 on GPU, **subject crop only**                                     | 17 fps at 1024² fp16 on an RTX 4090; M-series to be measured    | Hair-level alpha                                           | MIT                                          | Keep as the matting model; stop running it on full frames at fp32 on the CPU                                                |
| MatAnyone 2 (CVPR 2026)                                                                                     | 30 fps on the ANE (A18)                                         | State-of-the-art human video matting                       | **NTU S-Lab, non-commercial**                | Not usable                                                                                                                  |
| Robust Video Matting                                                                                        | 4K 76 fps on a 1080 Ti                                          | Good, people only                                          | **GPL-3.0**                                  | Not usable                                                                                                                  |
| Apple Vision (`VNGeneratePersonSegmentationRequest` `.accurate`, `VNGenerateForegroundInstanceMaskRequest`) | 60 fps on M1                                                    | Good soft matte; people / salient subject only, no prompts | OS API                                       | Zero-model **instant draft** on macOS, via a small signed Swift helper                                                      |

## D. Recommendation: three structural changes

1. **Get off the CPU.** macOS: Core ML models converted with coremltools (fp16, static shapes,
   CPU+GPU), loaded by the worker; Windows: ORT DirectML/WinML fp16. This alone is worth ~10–20×
   on the tracker. New dependency (`coremltools` at build time, a Core ML runner at run time) →
   maintainer approval + licence scan.
2. **Two tiers, fast by default.**
   - **Fast** (default): EdgeTAM or SAM 2.1 base+ tracker → BiRefNet on the subject crop, in the
     edge band, fp16 on the GPU → the existing CPU stabilise + verify. No consensus, no
     self-correction. Planning target (to be **measured**, not promised): ≥ 5 fps at 1080p on an
     M1 Pro, i.e. the 52 s clip in about five minutes instead of 8–17 hours.
   - **Best** (opt-in, and automatic only on the ranges `verify` flags for review): today's
     consensus + self-correction, on the GPU. Precision is spent where the checks say it is
     needed, not on all 1,553 frames.
   - Optional macOS **draft in seconds** from Apple Vision while Fast runs.
3. **Chunks are the unit of work, host-visible.** Split at shot cuts into 2–4 s chunks
   (60–120 frames, overlap kept for temporal continuity); run each chunk depth-first
   (decode → … → encode) and **commit it to the artifact when it finishes** (BR5 preview already
   draws unprocessed ranges as "Processing"); `checkpoint()` between chunks so Pause, export pause
   and pre-emption work within seconds; chunk nearest the playhead first; journal per chunk so a
   restart loses at most one chunk. Whole-job progress becomes `frames done / total` with an ETA
   from measured frames per second — additive `overall` fields on the worker progress line, gated
   on pack version because the host schema is `.strict()`.

Cheap wins available inside the current stack, if D.1 is delayed: SAM-L → base+ (encoder ≈ 3–4×
faster on CPU), skip self-correction unless `verify` flags the window, BiRefNet at 768² on the
subject crop, window 300 → 90 frames.

## E. Tasks

- [x] **SP0** Honest Jobs panel + per-step ETA + pause-pending.
- [x] **SP1 — spike.** Measured on the maintainer's clip, M1 Pro, one heavy job at a time
      (section F). Decided: Apple Vision for Fast; no new runtime dependency, no new weights.
- [x] **SP2** Pause/export suspend the worker and resume from finished windows; whole-job
      progress (`overallCompleted`/`overallTotal`) and a job ETA from this run's frame rate;
      Fast windows of 240 frames so a restart loses ≤ ~1 min. _Not done, deferred on purpose:_
      committing finished parts to the project while the job runs, and playhead-first ordering —
      at 7.5 minutes per clip the striped "processing" band is enough; revisit for long clips.
- [x] **SP3** Fast is the default on macOS; Best is the opt-in Speed choice. _Deferred:_ running
      Best automatically on the ranges Fast flags for review (needs a partial re-run seeded from
      a Fast matte; the pipeline's `previousArtifact` path is the place).
- [ ] **SP4** Windows path (DirectML) — blocked on MO-9 hardware.
- [ ] **SP5** Release gate: a 60 s 1080p clip finishes Fast in ≤ 10 min on the hardware floor and
      passes the 06 gates chosen for Fast; desktop-scale media, not fixtures.

Deferred on purpose: multi-subject instance mattes, cloud offload, 4K-native matting.

## F. What the spike found (2026-09-21, M1 Pro, the maintainer's 1080p30 clip)

| Option                                               | Per frame        | Verdict                                                         |
| ---------------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| Shipped pipeline, CPU                                | 17–40 s          | Best only                                                       |
| SAM 2.1-L image encoder, PyTorch MPS fp16 / fp32     | 0.92 s / 1.03 s  | A GPU port is ~6× faster and still an hour per clip             |
| BiRefNet-HR, MPS fp16, 768² / 1024²                  | 0.83 s / 2.37 s  | same                                                            |
| Vision person matte (`.accurate`)                    | 0.087 s          | People only; drops the held microphone                          |
| **Vision foreground instance + scaled matte, piped** | **0.035–0.06 s** | Chosen: keeps what the subject holds, soft matte at source size |

End to end through the real pipeline (decode → survey → Vision → gates → stabilise → checks →
foreground → encode, all six artifact files): **1,492 frames in 451 s = 3.3 frames/s**, against
8–17 hours. Where the time goes now: Vision + gates 40%, foreground colour 20%, stabilise 14%,
checks 12%, encode 10%. Every CPU stage had to be rebuilt for this path; at full size with optical
flow they cost 3.7 s per frame, 60× the estimate they wrapped.

The defect worth recording: Vision fused a background lamp into the presenter's instance in 405 of
1,492 frames. Fixed by evidence gathered over a sparse survey of the whole clip (ADR 0182 §4):
0 frames with the lamp afterwards, and no pixel removed outside that object. Two wrong turns on
the way, kept here so nobody repeats them: per-pixel gating cut a hole in a black microphone over a
black monitor (colour says nothing dark on dark — the region must switch as a whole); and a colour
model averaged over all frames matched the microphone where the microphone usually sits (the model
must be the pixel's colour when it is NOT in the matte).

## Sources

- EdgeTAM: <https://github.com/facebookresearch/EdgeTAM>, <https://arxiv.org/abs/2501.07256>
- MatAnyone 2 (licence): <https://github.com/pq-yang/MatAnyone2>
- Robust Video Matting (GPL-3.0): <https://github.com/PeterL1n/RobustVideoMatting>
- BiRefNet: <https://github.com/ZhengPeng7/BiRefNet>
- SAM 2 on Core ML: <https://github.com/alexhaugland/segment-anything-2-coreml>
- Apple Vision: <https://developer.apple.com/documentation/vision/vngeneratepersonsegmentationrequest>,
  <https://developer.apple.com/documentation/vision/vngenerateforegroundinstancemaskrequest>
- Masking speed across editors: <https://larryjordan.com/articles/compare-ai-assisted-masking-in-final-cut-premiere-resolve/>

## G. SP5 — Fast against the 06 per-frame gates (2026-09-22)

`workers/smart-mask/eval/fast_gates.py`, scored split, construction-true fixtures, M1 Pro.

| Category                                          | mean IoU | BF@2px | wrong frames | caught |
| ------------------------------------------------- | -------- | ------ | ------------ | ------ |
| hair_busy                                         | 0.994    | 0.958  | 10 / 32      | 0      |
| product_table                                     | 0.987    | 0.999  | 0 / 32       | –      |
| fast_motion                                       | 0.941    | 0.762  | 32           | 27     |
| similar_colour                                    | 0.940    | 0.805  | 32           | 32     |
| talking_head (film characters behind the subject) | 0.593    | 0.298  | 32           | 32     |
| walk_pan                                          | 0.504    | 0.445  | 32           | 32     |
| low_light                                         | 0.270    | 0.276  | 32           | 32     |
| twin_distractor                                   | 0.185    | 0.350  | 32           | 32     |
| crossing                                          | 0.138    | 0.139  | 32           | 32     |
| leave_reenter                                     | 0.013    | 0.014  | 32           | 32     |

Gates: mean IoU ≥ 0.98 in 2/10 categories ✗; error-detection recall 94.4% ✗ (gate 99.5%; was 54.9%
before the box-disagreement check); review load 78% ✗ (it is high BECAUSE the wrong clips are all
flagged — on the maintainer's real clip it is 1 frame in 300).

What this means: Fast is correct when Vision has one thing to call foreground and wrong when it
has several. The fixtures exaggerate this (their backgrounds are film stills full of characters,
and their subjects are rendered puppets Vision was never trained on), but two people in a shot is
a real case. The product answer shipped: the Inspector says what Fast is for, and a Fast matte
that does not fit the box it was given sends the whole clip to review. The engineering answer
(splitting a fused instance) is open: instance picking cannot do it, and the region follower that
can regressed three other categories.

- [x] **SP5** measured and recorded; Fast's scope stated in the product. Precision gates NOT met
      outside the one-clear-subject case.
- [ ] **SP6** split a fused instance (candidates: Vision person-instance masks for people, a
      light tracker as the region prior). Needs its own spike.
