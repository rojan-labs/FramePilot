# PX5 budgets: measured numbers

Budgets from [`09`](./09-PREVIEW-EXPORT-PARITY.md) ("PX5 — performance evidence") and
[`06`](./06-PRECISION-AND-EVAL.md) ("Production budgets"). Measured 2026-09-18. **No budget was
lowered.** Without the matte the preview budgets hold; with it they miss, and the export budget
misses narrowly; the misses are recorded with the hot path and what would fix them.

## Verdicts

Scale row = a 3-minute 4K timeline, 4 picture layers + text + a decontaminating 4K matte.
"Desktop path" = the monitor plays the 540p proxies `media/derive.py` makes (what the desktop app
does); the matte is always the 4K artifact.

| Budget                                                         | Measured (M1 Pro, real GPU)                                                              | Verdict                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Playback ≤ 1% dropped frames, Scale row **without** the matte  | 1 / 600 (0.17%); 0–0.17% with an animated 200-vertex path or a key + finesse on top      | **holds**                                             |
| Playback ≤ 1% dropped frames, Scale row **with** the 4K matte  | 600 / 601 (99.8%) before PX5.3; **1 / 601 (0.17%)** after, with the matte's monitor tier | **holds** since PX5.3 (tier needed; see "PX5.3")      |
| Seek-to-present ≤ 100 ms p95, without the matte                | 35.7 ms (56.3 ms with the path, 50.2 ms with key + finesse)                              | **holds**                                             |
| Seek-to-present ≤ 100 ms p95, with the 4K matte                | 617 ms (p50 592 ms) before PX5.3; **49.9–52.5 ms** (p50 37 ms) after                     | **holds** since PX5.3                                 |
| Memory bounded by the decoder pool                             | live decoders peak 6 of 6; picture cache peak 401–407 MB (676 MB with the matte)         | **bounded**, above the nominal 384 MB (below)         |
| Export with masks + 4K matte ≤ 1.5× without (P13)              | 1.98× before; after the optimisation below **1.49×** here and **1.56×** on the CI runner | **misses narrowly** (at the line here, over it on CI) |
| Desktop path **without proxies** (4K originals in the monitor) | 603 / 604 dropped; seek p95 161 ms                                                       | misses; the desktop app does not take this path       |

## What is measured where, and what is not

- **Real hardware, this machine:** Apple M1 Pro, 16 GB, shared with other work, Chrome stable on
  ANGLE/Metal, Node 24.13, ffmpeg 8.1. Every number in this file is from here unless a row says
  CI. One run at a time under a footprint watchdog (8 GiB cap, start at ≥ 40% free, abort on
  > 1 GiB swap growth). The first attempt was aborted by that watchdog 8 seconds in (system swap
  > grew 1.04 GiB while another agent's tests ran); it was re-run once memory was free. Each
  > playback number is ONE 20-second run, not a distribution.
- **CI (GitHub runner, no GPU, SwiftShader CPU GL):** the `preview-perf` job runs the same spec
  and gates on **invariants only**. Its timings are logged to the job summary and must not be
  read as budget evidence in either direction.
- **Not measured, and why:**
  - _"An M-series Mac" as a class._ One M1 Pro is one machine. No M1 (8 GB, 7-core GPU), M2/M3/M4
    or Intel/Windows number exists. The "holds" verdicts are for this machine only.
  - _The packaged desktop app._ The spec drives the web editor in Chrome against the dev server
    (unminified React, the same engine code). Electron's `fp-media://` reads, the production
    bundle and a retina monitor were not measured. The canvas is 1280×720 in both.
  - _Camera footage._ The fixture is synthetic (`testsrc2`), 13–18 Mb/s at 4K. Hardware decode
    barely cares; a software decoder does. FFV1 cost is per pixel, but the matte here is a disc
    and the foreground a flat colour, which is FFV1's best case.
  - _Cold storage._ The pts probe and every file read ran on files just written (page cache).
  - _The whole 3-minute export._ The ratio is from a 6-second window (180 4K frames) of a
    timeline that is uniform by construction; the full row is ~40 min + ~60 min on this machine.
  - _Long playback._ 20 seconds per run. A leak that needs minutes would not show; the GL pools
    and cache are asserted flat between the 10 s and 20 s marks only.

## The fixture (PX5.1)

`pnpm px5:fixture` (`engine/python/tests/px5_scale_fixture.py`) writes, into the gitignored
`tests/e2e/.tmp-px5-scale/` (1.6 GB, 22 s to generate, one ffmpeg at a time, no audio, nothing
committed):

- four **different** 3840×2160 30 fps H.264 sources, GOP 15, no B-frames, 250–410 MB each, and
  their 540p proxies with `media/derive.py`'s arguments. Each encodes one 12-second period and
  stream-copies it to length.
- a 4K matte artifact to the `render/mattes.py` contract (intra-only FFV1 `matte.mkv` +
  `foreground.mkv` + `frames.json`), 5,400 frames.
- the timeline and its A/B variants. `scale` is the row. Every other variant is `scale-plain`
  (no masks) plus exactly one feature, so its difference from `scale-plain` is that feature:
  `scale-path` / `scale-path-full` (animated feathered 200-vertex path), `scale-key` (key mask
  with the whole finesse chain), `scale-key-nofinesse`.

## The instrument (PX5.1)

`apps/web-editor/src/preview/engine/preview-telemetry.ts`, owned by `LayerPreviewEngine` and read
through `debugTelemetry()`. The spec (`tests/e2e/specs/preview-scale-perf.spec.ts`) reads only
this; nothing times the page from outside.

- `frameInterval`, `composite` (ticks that drew), `seekToPresent`, `exactComposite` (the
  composite inside a seek, read back, so it includes the GPU), `maskRaster`, `keyStack`, `decode`.
- **Dropped frames are counted, not timed:** the project frame index due on each tick against the
  last index presented. Unit-tested exactly (`preview-telemetry.test.ts`).
- Gauges with peaks: picture cache bytes, GL pool bytes and textures (`GlResources.poolBytes`),
  live decoders (asked of the decode worker, where the pool lives).
- `gpuSync` (measurement mode): a one-pixel read-back per playback composite. `gl.finish()` was
  tried first and returned in 0.0 ms with a dozen float passes queued, so it measures nothing
  under Chrome's command buffer.

## Scale row in the editor — M1 Pro, Chrome, ANGLE Metal

20 s of playback through the real transport, 24 fixed seeks, 12 single-frame steps. Times in ms.

| Variant (desktop path)      | Dropped         | Frame interval p95 | Composite p50 / p95      | Seek p50 / p95 | One full-res composite (step p50) | Cache peak | GL pools | Decoders |
| --------------------------- | --------------- | ------------------ | ------------------------ | -------------- | --------------------------------- | ---------- | -------- | -------- |
| `scale-plain`               | 1/600 (0.17%)   | 17.5               | 0.3 / 0.5 (submission)   | 25.5 / 35.7    | 7.0                               | 401 MB     | 51 MB    | 4        |
| `scale-path`                | 0/606 (0%)      | 21.4               | 15.2 / 16.5              | 41.4 / 51.9    | 20.6                              | 407 MB     | 53 MB    | 4        |
| `scale-path-full`           | 1/606 (0.17%)   | 21.5               | 15.3 / 16.5              | 41.7 / 56.3    | 20.7                              | 407 MB     | 53 MB    | 4        |
| `scale-key-nofinesse`       | 0/602 (0%)      | 17.4               | 6.4 / 9.0 (GPU sync)     | 26.1 / 34.6    | 7.5                               | 395 MB     | 87 MB    | 4        |
| `scale-key`                 | 1/608 (0.16%)   | 19.8               | 13.8 / 14.8 (GPU sync)   | 34.6 / 50.2    | 14.8                              | 407 MB     | 190 MB   | 4        |
| **`scale`** (4K matte)      | 600/601 (99.8%) | 17.5               | 478 (one composite drew) | 592 / 617      | **452**                           | 676 MB     | 55 MB    | 6        |
| `scale-plain`, 4K originals | 603/604 (99.8%) | 17.6               | 17.2                     | 122 / 161      | 26.9                              | 759 MB     | 199 MB   | 4        |

Load shedding never stepped (render scale stayed 1) in any run, and no run removed a layer.

### An animated 200-vertex path: 16 ms p95 on the main thread, no frames lost

The exact CPU rasteriser runs inside every composite for an animated mask (a cache miss per
frame). Rastered at the decoded picture's size, which on the desktop path is the 960×540 proxy:
**14.9 ms p50 / 16.0 p95 / 18.1 max**, playback 0–1 dropped of 606. It takes half the frame and
loses none, so **it was not moved to a worker**: the move is only worth its risk when it costs
frames. The Node numbers (`mask-raster.perf.test.ts`) say when it would:

| Raster size                                 | Hard edge p50 / p95 | Feathered (8 in, 24 out) p50 / p95     |
| ------------------------------------------- | ------------------- | -------------------------------------- |
| 640×360 (load-shed 0.5)                     | 5.2 / 7.0           | 10.7 / 14.7                            |
| 960×540 (540p proxy: the desktop path)      | 9.0 / 16.2          | 20.8 / 71.1                            |
| 1280×720 (monitor canvas, unproxied source) | 13.7 / 21.2         | **38.0 / 39.2** — over a 33.3 ms frame |
| 3840×2160 (the export-equivalent raster)    | 108 / 117           | 273 / 279                              |

So a feathered animated path on an **unproxied** clip would cost frames. The desktop app proxies
first; if that stops being true, the worker is the fix, with the same module on both threads so
the vectors stay byte-equal. Not measured: two animated paths in one frame, which by addition
(2 × 15 ms) would sit at the limit.

### A key's finesse chain: 7.4 ms of GPU per frame, +103 MB of pooled float targets

`scale-key` vs `scale-key-nofinesse`, GPU sync on: composite 13.8 vs 6.4 ms p50 (14.8 vs 9.0 p95),
and 14.8 vs 7.5 ms for a full-resolution paused composite. Playback holds (1/608). The cost that
matters is memory: the chain's pooled RGBA32F targets take the GL pools from 87 MB to **190 MB**
(51 MB with no key at all). It is flat once allocated (asserted), but the pool never shrinks
before the engine is disposed, and the telemetry counts storage by format, not what the driver
really commits.

### The 4K matte: the monitor freezes, and it is CPU float64 work, not the compositor

`scale` differs from `scale-plain` by one decontaminating matte. With it, playback presents one
frame in 20 seconds and a seek takes 0.6 s. The frame interval stays at 16.7 ms: the main thread
is idle between composites, because the frames never arrive in time. Two separate costs, both
many times a 33.3 ms frame:

| Where                                    | Cost per matte frame                                     | How measured                                               |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| Decode worker: `matte.mkv` (4K gray)     | 32.3 ms p50 / 34.8 p95                                   | `matte-decode.perf.test.ts`, the real `MatteDecodeSession` |
| Decode worker: `foreground.mkv` (4K RGB) | 69.4 ms p50 / 83.3 p95 (a flat colour: FFV1's best case) | same                                                       |
| Main thread: `matteFrameAlpha`           | 170 ms (Node); 115–131 ms `maskRaster` in Chrome         | `matte-composite.perf.test.ts`; telemetry                  |
| Main thread: `decontaminate`             | 324 ms (Node)                                            | same                                                       |
| Main thread: the whole composite         | **452 ms p50** (step), 478 ms during playback            | telemetry `exactComposite` / `composite`                   |

The FFV1 decoder is pure TypeScript and single-threaded in the one decode worker, so it also
starves picture decode: a picture decode window goes from 58 ms to **1,566 ms** p50. And because
every decoded frame is already stale when it arrives, the monitor does not slow down, it stops.
The picture cache peaks at 676 MB (one 4K matte frame pair is 41 MB, and decode-ahead pins 13).

**What it would take.** Not a worker: ~550 ms of CPU per frame needs 17 cores to reach 30 fps.
The matte passes (resample to the frame, clean levels, decontaminate) have to run on the GPU the
way MK6 moved the key stack there — float targets, quantise once — and be judged by the PX4
oracle's thresholds, since float32 on a GPU cannot be byte-equal to the export's float64. Or the
monitor needs a matte tier at its own resolution that passes those thresholds (BR5 measured a
540p VP9 matte at 32.4 dB and rejected it; no other tier is measured in this file).
Frame-parallel FFV1 decode (the files are intra-only) would fix the decode side alone. Until
then, a clip with a 4K matte cannot be played in the monitor; it can be scrubbed at ~0.6 s a
frame. This is a product decision, so nothing here changes it.

### Every project frame is composited twice on a 60 Hz display

`composite` has ~1,200 samples for ~600 project frames: the plan is evaluated at the audio clock's
continuous time on each animation frame, the layers' `localTime` differs between the two ticks of
one project frame, so the "unchanged" signature never matches and an animated mask is rastered on
both (1,064 rasters in 20 s). Quantising playback time to the project frame grid would halve that
work and present exactly the instants the export renders — but it changes what a 60 fps source
looks like in a 30 fps project's monitor, so it is handed over, not done.

## The same spec on CI (no GPU) — invariants pass, timings are not evidence

Run 35318861767, job `Preview performance evidence (PX5)`, ubuntu runner, Chrome on SwiftShader
(`ANGLE Vulkan, SwiftShader Device (Subzero)`), 15 s of playback, 12 seeks. All seven variants
**passed the invariants**: decoders ≤ 6, cache within budget + pinned, GL pools flat when the
render scale did not move, every seek presented, and four layers presented while load shedding
had dropped the render scale to 0.5 — the one place "shedding never removes a layer" was
actually exercised, because the M1 never shed.

| Variant (CI, CPU GL)        | Dropped         | Lowest render scale | Composite p50 | Seek p95 |
| --------------------------- | --------------- | ------------------- | ------------- | -------- |
| `scale-plain`               | 431/492 (87.6%) | 0.5                 | 207 ms        | 453 ms   |
| `scale-path`                | 430/480 (89.6%) | 0.5                 | 248 ms        | 495 ms   |
| `scale-key-nofinesse`       | 440/491 (89.6%) | 0.5                 | 255 ms        | 491 ms   |
| `scale-key`                 | 729/736 (99.1%) | 1                   | 3,421 ms      | 3,515 ms |
| `scale` (4K matte)          | 467/468 (99.8%) | 1                   | 1,102 ms      | 1,968 ms |
| `scale-plain`, 4K originals | 455/456 (99.8%) | 1                   | 2,225 ms      | 2,501 ms |

A software rasteriser composites the plain row in 0.2 s and a key's float passes in 3.4 s. That
is why no timing is gated on CI: these numbers describe the runner. CPU-side measurements on the
same runner (x86-64, Node 22): feathered 200-vertex path 33.8 ms at 960×540 and 54.4 ms at
1280×720 (M1: 20.8 / 38.0); 4K matte frame decode 41.6 ms and foreground 76.2 ms (M1: 32.3 /
69.4); `matteFrameAlpha` 196 ms and `decontaminate` 439 ms (M1: 170 / 324); pts probe 0.78 s on
the 3.9 GB file and 1.02 s on the two-hour file. Note `scale-key` did not shed on CI: a frame
that takes 3.4 s presents too rarely for the 8-tick shed rule to trip.

## Memory: bounded, and what the bound really is

- **Live decoders:** never above the pool's cap (6) in any run; `decoder-pool.test.ts` holds 40
  sources visited round-robin at the cap and proves the peak cannot hide an overshoot.
- **Picture cache:** `CACHE_BUDGET_BYTES` is 384 MB, but eviction cannot take what decode-ahead
  pins (13 project frames × every layer, plus an 8-frame window in flight per source). Measured
  peaks: 401–407 MB on proxies, 676 MB with a 4K matte, 759 MB on 4K originals. The spec asserts
  the real bound: budget + 21 frames × (pictures + matte pairs). It is a function of the
  timeline, not of how long it plays.
- **GL pools:** 51–199 MB, flat between the 10 s and 20 s marks (asserted). They are keyed by
  size and never shrink, and a render-scale step adds a second set.
- Peak process-tree footprint during a run (Playwright + Vite + Chrome): 2.9–3.8 GiB, 4.6 GiB on
  4K originals.

## Export with masks and a 4K matte ≤ 1.5× without (P13)

`pnpm px5:export-ratio` (`engine/python/tests/px5_export_ratio.py`): `scale` and `scale-plain`
through the real `export_video` at 3840×2160 (`h264_videotoolbox`), one export per process,
under the spike watchdog (peak footprint 7.4 GiB of the 8 GiB cap).

| Version                                | Window       | Plain   | With the 4K matte | Ratio     |
| -------------------------------------- | ------------ | ------- | ----------------- | --------- |
| Before                                 | 2 s (60 fr)  | 29.8 s  | 51.5 s            | 1.73×     |
| Before                                 | 6 s (180 fr) | 79.9 s  | 158.3 s           | **1.98×** |
| Before, per frame from the two windows |              | 0.418 s | 0.890 s           | 2.13×     |
| **After** (boxed `decontaminate`)      | 6 s (180 fr) | 86.7 s  | 129.0 s           | **1.49×** |

cProfile named the hot function: `render/matte_edges.py` `decontaminate`, **227 ms of every 4K
frame** — four frame-sized float64 arrays built to change a thin edge band. Where the band weight
and colour are zero the formula is `picture + (0 − picture·0)`, the picture exactly, so the
arithmetic now runs inside the box holding the band (taken on the band itself at source size,
on the resampled planes otherwise): **65 ms** per frame. The dense form stays as
`decontaminate_dense`, the definition. Same bytes: 38 cases against it
(`tests/test_matte_decontaminate_exact.py`) and the 79 existing matte golden, alignment and
frame-hash tests pass unchanged.

On the CI runner (Linux x86-64, software x264, 4-second window = 120 frames, after the
optimisation): plain 92.9 s, with the matte 144.6 s, **1.56×** — over the budget.

**Honest verdict:** the budget is not met. 1.49× here is at the line, not inside it, and CI is
over it. The plain run moved 8% between the two
measurements on this shared machine, and a matte whose band box covers most of the frame (a
subject filling the shot) gains less than this disc (its box is 22% of the frame). What is left
per frame: the stack's matte alpha ~51 ms (`apply_clean_levels` 28 ms), two FFV1 reads ~46 ms.
The preview's TypeScript twin was not changed; its cost is the resample, not the mix.

## The BR2.5 pts probe on large files

`pnpm px5:pts-probe`: `video_timing` demuxes every video packet once per export, then caches by
path, size and mtime. Generated by stream-copying one encoded period; deleted after measuring.

| File                                            | Packets    | First call  | Cached |
| ----------------------------------------------- | ---------- | ----------- | ------ |
| 3.90 GB, 5 min, 1080p at 100 Mb/s (camera-like) | 9,000      | 1.05 s      | 1.2 ms |
| 0.46 GB, 2 h, 320×180                           | 216,000    | 0.72 s      | 0.1 ms |
| Scale fixture, 4 × 4K sources (in the export)   | 5,400 each | 0.18 s each |        |

Warm storage (the page cache cannot be dropped without root): a cold multi-GB file adds the
disk's sequential read of the whole file, because ffprobe reads every packet's payload.

## Regression guards

| Guard                                                                         | What it asserts                                                                                                        | Flake-proof because                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `preview-telemetry.test.ts` (every run)                                       | dropped-frame ledger, percentiles, gauge peaks                                                                         | pure arithmetic on a tick sequence                                                |
| `decoder-pool.test.ts` (every run)                                            | 40 sources round-robin never exceed the cap; the peak records a forced overshoot                                       | operation counts                                                                  |
| `test_matte_decontaminate_exact.py` (every run)                               | boxed = dense bytes (38 cases); never one frame-sized float64 RGB plane for a small band                               | `tracemalloc` sizes are the algorithm's                                           |
| `preview-scale-perf.spec.ts`, CI `preview-perf` job (`FRAMEPILOT_RUN_PERF=1`) | decoders ≤ cap, cache ≤ budget + pinned, GL pools flat when steady, 4 layers presented under load, every seek presents | invariants; no timing is gated on CI                                              |
| same spec with `PX5_ASSERT=budgets` (real hardware, `px5-local-run.py`)       | dropped ≤ 1%, seek-to-present p95 ≤ 100 ms — the budgets, unrounded                                                    | margin on this machine: 0.17% vs 1%, 36–56 ms vs 100 ms; only meaningful on a GPU |
| `*.perf.test.ts` (CI `preview-perf`, logged)                                  | mask raster, 4K matte decode, matte main-thread cost                                                                   | reported, not gated                                                               |

The budget assertion is deliberately **not** run on CI: a SwiftShader runner would fail it for
reasons that say nothing about the product, and a guard that is red for the wrong reason gets
turned off. `scale/proxy` failed it on real hardware before PX5.3 and passes it since (with the
matte's monitor tier present; without it, it still fails on dropped frames).

## Handed to the optimiser (precise targets)

1. **Matte in the monitor** — DONE in PX5.3 (below), except the desktop app's tier trigger.
   Was: 452 ms per composite on the main thread (`matteFrameAlpha` 170 ms,
   `decontaminate` 324 ms in Node at 4K → 960×540) plus 101 ms of single-threaded FFV1 decode per
   frame. Target: a composite with a 4K matte ≤ 25 ms (the load-shed threshold) and ≤ 33 ms of
   decode per frame. Judge with the PX4 oracle; the guard is `scale/proxy` with `PX5_ASSERT=budgets`.
2. **Two composites per project frame at 60 Hz** — quantise playback time to the frame grid.
   Halves `maskRaster` and `composite` samples per second. Needs a maintainer decision (above).
3. **GL pools never shrink** — 190 MB after a key with finesse. Release targets of a size not
   used for N frames. Guard: the `glPoolBytes` gauge.
4. **Export, the last 5–10%** — two more exact cuts, neither taken here: at source size mix only
   the band's own pixels (boolean index) instead of its box (~30 → ~2 ms; the disc's band is 1%
   of the frame, its box 22%), and
   `apply_clean_levels` is dense at 4K (28 ms/frame); the same exact-box
   argument applies outside the band, where alpha is exactly 0 or 1.

## PX5.3 — a 4K matte plays

M1 Pro, Chrome, ANGLE/Metal, `scale/proxy` (the desktop path), measured 2026-09-18 on the same
shared machine as above, one 20-second run per line, `px5-local-run.py` under the watchdog. No
budget was lowered, no tolerance widened, no dependency added. Each line adds one group of
commits to the one before, so its difference is that group's.

| After                                                               | Dropped           | Seek p50 / p95 | Playback composite p50 / p95 | One full-res composite | Matte decode p50 / p95 | Picture decode p50 | Footprint |
| ------------------------------------------------------------------- | ----------------- | -------------- | ---------------------------- | ---------------------- | ---------------------- | ------------------ | --------- |
| Before PX5.3 (above)                                                | 600/601 (99.8%)   | 592 / 617      | 478 (one drew)               | 452                    | 101 per frame, serial  | 1,566              | 3.78 GiB  |
| GPU matte pass; matte decode pool (`f0addf60`, `2d0d5227`)          | 535/603 (88.7%)   | 129 / 147      | 13.5 / 26.0                  | 28.7                   | 1,356 / 7,605 (queued) | 62                 | 6.11 GiB  |
| GL program-order fix, texture recycling, ranked queue               | 293/607 (48.3%)   | 125 / 135      | 14.4 / 27.5                  | 27.1                   | 406 / 497              | 105                | 5.11 GiB  |
| Monitor tier, FFV1 block copies                                     | 68/602 (11.3%)    | 102 / 157      | 0.7 / 2.4                    | 14.3                   | 22.9 / 225             | 95                 | 4.56 GiB  |
| Seek overlap, workers pre-open, pointwise chain fused into resample | 2/602 (0.33%)     | 42 / 108       | 0.7 / 2.0                    | 11.5                   | 21.1 / 36.6            | 73                 | 4.44 GiB  |
| **Cues-only index, artifacts opened at project load (final)**       | **1/601 (0.17%)** | **37 / 49.9**  | **0.7 / 2.1**                | **11.0**               | **21.8 / 34.3**        | 85                 | 3.71 GiB  |

The final code, again: 1/601 and seek p95 52.5 ms, then three runs with `--budgets` (both
budgets asserted) that passed. Composite times in playback are submission (GPU sync off); the
one full-resolution composite is read back, so it includes the GPU. Gauges at the final line:
picture cache peak 440 MB (676 before: a tier frame is 4 MB where a 4K foreground was 25 MB),
GL pools 191 MB (55 before: two matte frames' textures and their recycled spares, the 960x2160
across target, the stack's float accumulators), picture decoders 4 (mattes no longer share
their pool).

**What each piece is, and what it cost the main thread** (details in the guides and commits):

- **GPU matte pass** (`gl/matte-pass.ts`, `matte-shaders.ts`, `alpha-passes.ts`): the export's
  chain as float passes into the stack's float accumulator, quantised once; decontamination
  folded into the horizontal resample. No per-pixel float64 on the main thread in playback: the
  float64 twin runs only for a radius past a shader bound or a GPU without float targets
  (`maskRaster` stays at 0 samples on the row).
- **The monitor tier** (`render/matte_tier.py`, ADR 0181): the export's decontamination planes at
  the decoded size, made once with the engine's resample (`resample_limited`: value for value,
  884 → 84 ms per 4K frame), 16-bit, stored as byte planes in intra-only FFV1. Decodes in
  14.5 ms at 960x540 where the 4K foreground takes 38.5 ms. **Made where:** by the host, beside
  the artifact — not by the pack (schema-enumerated file names, no engine resample in the pack,
  no knowledge of the monitor's size; see the ADR). The Scale fixture and the PX4 generator make
  it; the desktop app does not yet (needs a sidecar route: maintainer decision).
- **Decode** (`decode/matte-decode-pool.ts`): mattes on their own workers (half the cores, 1–4),
  frame-parallel for intra-only files, one frame per worker at a time, nearest-wanted first, a
  frame the playhead passed dropped while it waits. FFV1 runs and rows copied in blocks
  (byte-exact): 4K matte 32.0 → 17.4 ms, 4K foreground 72.1 → 37.1 ms (`matte-decode.perf.test.ts`).
  A Cues-indexed file opens from its Cues alone: 149 MB in 571 reads → 0.6 MB in 3 reads, 5 ms.
  WASM was not needed.
- **A bug found on the way:** `LayerCompositor.alpha()` set half its uniforms, then built the
  mask stack (which on the GPU binds its own programs), then drew with the last of them. Every
  alpha-target stack built on the GPU was drawn wrong — a key's since MK6.1, unseen because no
  PX4 row carries a key. The spec now fails on any WebGL error.

**Also fixed (asked of PX5.3 while it ran): the MK4.6 pointer budget.** `mask-tools.spec.ts`'s
`work` p95 (handler entry to the overlay's layout effect, budget 16 ms) had risen from 6.3–8.8 ms
at MK4.6 to 15.3–17.1 ms on CI, before PX5.3 as well as during it. The cause was a render storm:
BR6.6 made `Editor` and `Inspector` read `reviewRequest` through the whole-store mask-tools hook,
so both re-rendered on every drag move. `useMaskToolValue` subscribes to the one value; E2E smoke
at `c4bcd41a` (run 35334743544): `work` p95 **9.0 ms**, first attempt, 99 passed, none flaky. The
monitor's own `offsetWidth` read during render (also per move) was moved to a layout effect +
ResizeObserver first; alone it did not move the number (17.1 / 15.8 ms, run 35332742842).

**Attribution: the tier is needed for the dropped-frame budget on this machine.** The final code
with the tier withheld (`PX5_TIER=0`, masters only): 51/609 (8.4%) dropped, seek 75.2 / 90.6 ms,
composite 13.6 / 27.5 ms, matte decode 49.3 / 96.9 ms, picture decode 232 ms p50, footprint
4.88 GiB. Seek holds without it; playback does not.

**No regression elsewhere** (final code): `scale-key` 1/607, seek 35.6 / 49.2 ms, composite 13.7
/ 14.6 ms, GL pools 199 MB (before: 1/608, 34.6 / 50.2, 13.8 / 14.8, 190 MB); `scale-plain`
0/601, seek 26.1 / 40.7 ms (before 1/600, 25.5 / 35.7).

**PX4 oracle, unchanged gates.** CI run 35324781183 (`4ab6f52f`: GPU pass, pool, program-order
fix): 59/59 rows pass; the eight matte rows as before — seven bit-identical (PSNR ∞, 100% within
8/255), text-behind-subject 53.68 dB / 100% (its burned text). They judged the GPU pass: CI's
SwiftShader has float targets (the same run's PX5 job recorded `matteStack` samples and no
`maskRaster`).

**Oracle on the tier.** CI run 35329323404 (`93e456f5`: everything above, the generator writing
each artifact's tier at the size the export decoded its picture at): 59/59 rows pass at the
unchanged gates. Each matte sample now records which path it drew (`sample.mattes`):
`matte-decontaminate` drew its decontaminating mask from the 1280x720 tier (97.78 dB and ∞,
100% within 8/255) and `matte-text-behind-subject` from its 1280x720 tier (53.68 dB, 100% — the
same figure as before, the burned text). `matte-shape-stack` has a 1920x1080 tier but drew from
the masters (∞): its planes were not decoded by the time its samples were drawn; the oracle's
media route ignores `Range`, so a file is fetched whole before its index opens — likely the
cause, not verified. The other five rows do not decontaminate, so they have no tier path.

**Honest limits.**

- One machine (M1 Pro, 16 GB, shared: load average 4–13 during runs), one run per line. The
  "holds" verdicts are for this machine; a slower CPU decodes the 4K alpha (17–19 ms a frame
  here) slower, and the alpha is still decoded at source size (see "not done").
- The fixture's matte is a flat-colour disc: FFV1's best case. Camera mattes and foregrounds
  decode slower; the tier's planes cost follows the band's length, not the frame's.
- One run of ten at the final code hung (a `page.evaluate` past the 260 s test timeout, normal
  memory). The same kind of hang happened before PX5.3 on `scale-path` (a variant with no matte,
  12:38, 623.7 s). Diagnosed in PX5.7 (below): the dev server hot-replaced the editor mid-run.
- The desktop app makes no tier yet, so on the desktop a matte runs the masters path: seek within
  budget, playback not (8.4% dropped here).

**Not done, and what it would take.**

- The desktop tier trigger: a sidecar route shaped like `/mattes/frame-hashes` and a host call
  after an artifact commits (ADR 0181). Needs the maintainer (sidecar contract).
- An alpha tier for a matte whose edge chain is the identity (the default soft matte): the
  resampled alpha is then exactly what the monitor needs, and the 4K alpha decode (17–19 ms a
  frame) would go. Not for `sharp` or any edge control, which act at source resolution.
- PX5.5 (two composites per project frame at 60 Hz) and PX5.4 (export ratio) are untouched.

## PX5.7 — the intermittent hang: the dev server replaced the editor mid-run

Diagnosed 2026-09-18 on the same M1 Pro. **Not the engine.** Playwright's `webServer` is Vite's
dev server, which watches the worktree, and this worktree is shared with other agents. An edit in
the editor's import graph during a run hot-updated `WebCodecsPreviewPlayer` (or, for a file only
the decode worker imports, reloaded the page), so the engine under the test was rebuilt mid-step.

**Evidence.** With the new step guard (below) the first watched `scale-path/proxy` run hung, and
the report named it: `telemetry.poolStats` open for 210 s in the engine that answered, the decode
worker silent (`worker: null`), no decode window open. The next run failed differently: playback
never started (`expectedFrames: 0`), and the console showed the app starting twice 13 s apart —
a reload. Then on demand, three times out of three: touching one source file 17-22 s into a
run (content unchanged) gave `expectedFrames: 0` (the fresh engine had only decoded frame 0),
`[vite] hot updated: /src/components/WebCodecsPreviewPlayer.tsx`, and, for
`decode/decoder-pool.ts`, a full reload. With the watcher off, the same touch mid-run: the run
passed (29.2 s). Five untouched runs before the change passed as well, which is the "one in ten":
it depends on whether someone saves a file during the 30 s.

The exact sub-path of the 210 s wait (which replaced module left a request with no worker to
answer it) was not reproduced on demand; the three outcomes that were share the cause.

**What changed.**

| Where                                | What                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e/scripts/px5-local-run.py` | starts the dev server itself with `FRAMEPILOT_VITE_NO_WATCH=1` (no watcher, no hot reload, `vite.config.ts`), watches its footprint too, refuses if port 5173 is taken |
| `preview-scale-perf.spec.ts`         | fails the moment the editor's code is replaced (`[vite] hot updated`, a navigation), naming it; `the editor kept the code it was opened with` is the first invariant   |
| same, every step                     | 25 s before the test timeout: writes `results/<variant>.hang.json` (open stages, worker report, traffic) and fails naming the stuck step                               |
| `engine/stage-tracker.ts` (new)      | every stage a seek, decode-ahead, playback start or telemetry read waits on; logs `preview stage stuck` after 10 s. Observes only: nothing is cancelled or timed out   |
| `decode/decode-worker.ts` `stages`   | each source's call: `queued` / `fetch` / `feed` / `await-output` / `flush` / `copy-planes`, age, decoder state and queue, copies in flight, calls waiting              |
| `decode/worker-client.ts`            | `debugStages(timeout)` (`null` = the worker did not answer) and the last 16 messages each way with their age                                                           |

Guards: `stage-tracker.test.ts` (a never-settling stage is named once, settled ones forgotten,
the outcome passes through) and `worker-client.test.ts` (the worker's report, and `null` from a
silent worker instead of a wait). The spec's replacement check was seen to fire on a watching
server (`PX5 step "telemetry after playback": the editor's code was replaced mid-run ([vite] hot
updated: …)`, 27.6 s instead of a timeout). CI starts its own dev server in a fresh checkout that
nothing edits, so it was never exposed.
