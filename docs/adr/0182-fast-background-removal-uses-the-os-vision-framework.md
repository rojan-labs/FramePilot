# ADR 0182 — Fast background removal uses the OS vision framework; the models become "Best"

- **Status:** Accepted. The maintainer asked for the structural change on 2026-09-21 ("even if we
  have to do structural changes … implement everything end to end"), recorded per CLAUDE.md §5.
- **Date:** 2026-09-21
- **Relates to:** ADR 0114 (capability packs), ADR 0179 (Smart Mask packs); plan
  [`13-SPEED-AND-PRODUCTION-READINESS.md`](../../plan/background-removal-ai/13-SPEED-AND-PRODUCTION-READINESS.md).

## Context

_Remove background_ on a 50-second 1080p talking-head clip ran for more than five hours without
finishing one 300-frame window. Nothing was broken: the pack runs SAM 2.1 Large and BiRefNet-HR on
the CPU, and BR0.7 had measured ≈ 520 compute-seconds per footage-second. Measured on the same
M1 Pro for this decision:

| Path                                                                              | Per 1080p frame          |
| --------------------------------------------------------------------------------- | ------------------------ |
| The shipped pipeline, CPU                                                         | 17–40 s                  |
| Same models on the GPU (PyTorch MPS, fp16): SAM-L encoder / BiRefNet 768² / 1024² | 0.92 s / 0.83 s / 2.37 s |
| Apple Vision `VNGenerateForegroundInstanceMaskRequest` + scaled matte, via a pipe | 0.035–0.06 s             |

Even on the GPU the models cost 2–3 s per frame (an hour for that clip). No GPU port of these
models makes background removal feel like an editor's tool. MatAnyone 2 (NTU S-Lab,
non-commercial) and Robust Video Matting (GPL-3.0) are not usable.

## Decision

1. **Two engines behind one capability.** `subject.matte` takes an optional `quality`:
   `fast` = Apple's Vision framework, `best` = the existing models, unchanged. The host defaults to
   `fast` wherever it can run and never sends the field to a pack older than 1.1.0 (its strict
   parser would refuse it). Off macOS `fast` resolves to `best`; a Fast request the worker cannot
   serve is a typed refusal, never a silent fall back to an hours-long job.
2. **Vision runs in a small native helper inside the pack** (`workers/smart-mask/native/vision-matte`,
   one Swift file, no third-party code), driven by the Python worker over stdin/stdout. It is built
   by the pack build, so it is hashed, signed and notarized with the payload. It adds no runtime
   dependency, no weights and no licence: Vision is an OS API.
3. **Everything after the estimate is shared**: the editor's locks and brush strokes, band-only
   stabilisation, the image-based checks and review ranges, foreground colour, FFV1 encode,
   per-window checkpoints, `frames.json`, host verification. A Fast matte is the same artifact.
4. **What Vision gets wrong is fixed with evidence, not shape.** It fuses background objects into
   the subject's instance (a lamp beside the presenter: in 28.5% of frames, switching 150 times in
   50 s). A sparse survey of the whole job finds regions that are only sometimes taken, look the
   same taken or not, and switch as a whole; the region floods across the same object in the
   background picture; a frame drops those pixels only while they look like that background. On
   the maintainer's clip: fused in 405 frames → 0, and no pixel removed anywhere else. Cutting by
   shape (erode, keep what touches the person) was tried and removed: blocky, and it corrupted
   the evidence.
5. **The CPU stages were rebuilt for the Fast path**, because at 50 ms per estimate they were the
   job: flow-free stabilisation in the band's box (1.9 s → 0.05 s per frame), Blur-Fusion
   foreground colour (1.6 s → 0.07 s), checks at half size on four threads (0.23 s → 0.06 s).
6. **Whole-job progress is part of the protocol** (`overallCompleted`/`overallTotal`, additive,
   sent only to a host that sent `quality`), and the host measures the job's ETA from this run's
   frame rate. `completed`/`total` stay what they always were: one phase of one window.
7. **Pause is real.** The scheduler asks the running job to suspend (user pause, export); the
   matte service stops the worker and **releases** its staging instead of discarding it; the same
   intent then resumes from the finished windows. Pre-emption by a higher-priority job still
   waits for a checkpoint: killing an hours-long Best window for a click would cost more than it
   saves.

## Consequences

- The maintainer's clip: **8–17 h → 7.5 min** (3.3 frames/s end to end, 1080p30, M1 Pro), and a
  restart or a pause loses at most one 240-frame window (~1 min).
- Fast is macOS-only. Windows keeps Best until a second Fast engine exists (SP4, blocked on MO-9
  hardware); the seam (`PipelineConfig.engine`) is where it goes.
- Fast follows the main subject or the clicked/boxed one by instance overlap. It has no exclude
  clicks and no per-frame model consensus, so its review flags are the image-based checks only.
  Hair-level alpha on hard backgrounds remains Best's job; the Speed choice says so.
- **Fast against the 06 per-frame gates** (`eval/fast_gates.py`, report
  `reports/smart-mask/2026-09-22-fast-darwin-arm64.json`, construction-true fixtures): 2 of 10
  categories pass (hair on a busy background, product); crowded scenes, low light, a twin and
  leave/re-enter fail, because Vision answers "what is foreground", not "which of it was boxed".
  Fast is therefore the engine for **one clear subject**, and says so in the Inspector. It must
  not look finished when it is wrong: a seeded matte with more than 30% of its area outside the
  editor's box sends every frame to review, which took error-detection recall from 55% to 94%
  (gate: 99.5%, **not met**; the misses are borderline edge frames). The run also found a crash
  (an invented check code) the first time Vision found no subject — fixed, with a test. A region
  follower that cuts fused neighbours away was tried and reverted: it rescued the fused cases
  and regressed fast motion, similar colour and re-entry.
- A fast matte has its own cache key (`quality: 'fast'`); every matte made before this keeps its key.
