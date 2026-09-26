# PX5 budgets: measured numbers

Budgets from [`09`](./09-PREVIEW-EXPORT-PARITY.md) ("PX5 — performance evidence") and
[`06`](./06-PRECISION-AND-EVAL.md) ("Production budgets"). Measured 2026-09-18. **No budget was
lowered.** Without the matte the preview budgets hold; with it they missed until PX5.3; the export
budget missed narrowly until PX5.4 and holds since, on CI's windows and on the whole 3-minute row
(PX5.11: 1.32× wall, 1.31× CPU).

## Verdicts

Scale row = a 3-minute 4K timeline, 4 picture layers + text + a decontaminating 4K matte.
"Desktop path" = the monitor plays the 540p proxies `media/derive.py` makes (what the desktop app
does); the matte is always the 4K artifact.

| Budget                                                         | Measured (M1 Pro, real GPU)                                                                                                                                  | Verdict                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Playback ≤ 1% dropped frames, Scale row **without** the matte  | 1 / 600 (0.17%); 0–0.17% with an animated 200-vertex path or a key + finesse on top                                                                          | **holds**                                        |
| Playback ≤ 1% dropped frames, Scale row **with** the 4K matte  | 600 / 601 (99.8%) before PX5.3; **1 / 601 (0.17%)** after, with the matte's monitor tier                                                                     | **holds** since PX5.3 (tier needed; see "PX5.3") |
| Seek-to-present ≤ 100 ms p95, without the matte                | 35.7 ms (56.3 ms with the path, 50.2 ms with key + finesse)                                                                                                  | **holds**                                        |
| Seek-to-present ≤ 100 ms p95, with the 4K matte                | 617 ms (p50 592 ms) before PX5.3; **49.9–52.5 ms** (p50 37 ms) after                                                                                         | **holds** since PX5.3                            |
| Memory bounded by the decoder pool                             | live decoders peak 6 of 6; picture cache peak 401–407 MB (676 MB with the matte)                                                                             | **bounded**, above the nominal 384 MB (below)    |
| Export with masks + 4K matte ≤ 1.5× without (P13)              | 1.98× before; 1.49× here / 1.56× CI after PX5.2; after PX5.4 **1.32–1.45×** on the CI runner (4 s windows); **full row 1.32× wall / 1.31× CPU** (PX5.11, CI) | **holds** on the whole row, on CI (PX5.11)       |
| Desktop path **without proxies** (4K originals in the monitor) | 603 / 604 dropped; seek p95 161 ms                                                                                                                           | misses; the desktop app does not take this path  |

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
  - _The whole 3-minute export on this machine._ PX5.4 tried it once under the watchdog: aborted
    after 58 s (system swap +1.08 GiB at a 5 GiB footprint, other agents' jobs running). A 60 s
    and a 20 s window were aborted the same way. The whole row was measured on a CI runner
    instead (PX5.11, below); there is still no M-series number for it.
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
  with the whole finesse chain), `scale-key-nofinesse`, and `scale-elements` (20 sticker layers
  in a grid under the title, five outlined and five turning: the elements budget of
  `plan/elements/02-UX-SPEC.md` §9, EL6b). The stickers are the curated files every build ships,
  copied beside the sources.

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

### Every project frame is composited twice on a 60 Hz display (fixed in PX5.5, below)

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

### PX5.4 — the two exact cuts, and the stack's tail

Three commits, each byte-identical to the code it replaces (no budget lowered, no tolerance
widened, no dependency):

| Commit                 | What                                                                                                                                                                                                                                                                                                                                                                   | Proof of equality                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `a676977c`             | `decontaminate` at source size is a **selection**: where the band weight is 1 the definition is `picture + (fg − picture·1)`, the `uint8` foreground exactly; where it is 0 the picture. The band's own pixels are copied by flat index (26–31 → 5 ms per 4K frame, quiet). `apply_clean_levels` writes its four ufuncs into one array; `edge_shift` divides in place. | the 39 `test_matte_decontaminate_exact.py` cases now run the selection against `decontaminate_dense`; `test_matte_clean_levels_exact.py`: bit-for-bit (`tobytes`) on 0, −0.0, 1, subnormals, ±inf, NaN, strided views, float32, 9 level pairs; one plane allocated |
| `fb1df9c5`             | the stack's tail: `combine` (add/subtract/difference) and `quantize_alpha` clamp and scale in one working array (35–47 ms per 4K frame for the tail, quiet)                                                                                                                                                                                                            | `test_mask_stack_tail_exact.py`: bit-for-bit against the verbatim expressions, six modes, float64 and float32, the quantisation ties; rasteriser vectors, stack vectors and render goldens unchanged                                                               |
| `90036351`, `d830f426` | the ratio script records each arm's CPU seconds and load, and prints each arm when it lands                                                                                                                                                                                                                                                                            | measurement only                                                                                                                                                                                                                                                   |

**The matte pass, interleaved in one process on a real frame** (source frame 100 of `scale-d`, its
4K matte and foreground; old and new alternated 15 times; the picture and the alpha asserted
byte-identical): **249 → 120 ms p50 per 4K frame** (fastest 79 → 52 ms). The machine's load was
~170 during it (other agents), which is why the p50s are far above the fastest; the interleaving
is what makes the two comparable. The two FFV1 reads per frame are not in this number and did not
change.

**The export ratio.**

| Where                     | Engine                          | Window       | Plain  | With the matte | Ratio (wall) | Ratio (CPU) |
| ------------------------- | ------------------------------- | ------------ | ------ | -------------- | ------------ | ----------- |
| CI runner (PX5.2, before) | `decontaminate` boxed           | 4 s (120 fr) | 92.9 s | 144.6 s        | 1.56×        |             |
| CI run 35353756815        | `5a0c795a` (first cuts)         | 4 s          | 83.2 s | 109.9 s        | **1.32×**    |             |
| CI run 35357453091        | `fce9ea0c` (+ MK9, same cuts)   | 4 s          | 77.4 s | 112.3 s        | **1.45×**    | 1.26×       |
| CI run 35366379149        | `b361595d` (+ the stack's tail) | 4 s          | 78.7 s | 106.1 s        | **1.35×**    | 1.20×       |

The first two CI runs share the matte path and differ by 0.13 because the plain arm moved 7%
(83.2 vs 77.4 s): the runner's noise is that size, so read the three as a range, not a trend.
CPU time is steadier (1.26× and 1.20×).

**Locally the ratio could not be measured today.** The full row, a 60 s and a 20 s window were each
aborted by the watchdog (swap growth, above). At 6 s, three of seven attempts completed, all at
load 10–25 with other agents' jobs running: before (`fa9cb2d8`) 1.54× and 0.87× wall (1.35×,
1.10× CPU), after (`5a0c795a`) 1.71× and 1.65× wall (1.51×, 1.21× CPU). A plain arm running
identical code took 138–436 s of wall and 165–252 s of CPU across attempts, and one matte arm
finished faster than its plain arm: these numbers cannot resolve a 10% change either way, so they
are recorded and not used. PX5.2's 1.49× (the same code as "before", 6 s, a quieter machine) is
the last trustworthy local number.

**Verdict.** On CI's 4-second windows the budget holds (1.32–1.45× after PX5.4, 1.56× before).
The full 3-minute row was then measured on CI by PX5.11 (1.32× wall, 1.31× CPU; section below).
Locally it was **not measured**: it does not fit this 16 GB machine's watchdog budget
while other agents run (the matte export's footprint is 5-7 GiB, mostly MoviePy's per-clip 4K
readers). What would measure it: the row on a quiet machine or a dedicated runner (about 45 min
plain + 60 min matte here; CI's `preview-perf` job has a 60-minute limit and a 4 s window).
What would move the ratio further: the rest of `stack_alpha` (zeroed accumulator, `astype / 255`),
and the matte's two FFV1 reads (~45 ms per frame, a decode in ffmpeg).

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
| `test_matte_clean_levels_exact.py`, `test_mask_stack_tail_exact.py` (PX5.4)   | in-place clean levels, edge shift, combine and quantisation = the definitions, bit for bit; one plane allocated        | `tobytes` equality and `tracemalloc` sizes                                        |
| `test_export_frame_grid.py`, `project-frame.test.ts` (PX5.5)                  | the export reads `frame_plan_at(k / fps)`; playback presents that frame at every display tick inside frame `k`         | pure functions of the vectors                                                     |
| `preview-scale-perf.spec.ts` invariant (PX5.5)                                | composites ≤ ⌈1.1 × presented frames⌉ + render-scale steps                                                             | counts, not timings; the reverted code gives 1.5-1.7                              |
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
2. **Two composites per project frame at 60 Hz** — DONE in PX5.5 (below): playback plans at
   the project frame's own instant, the export's; one composite per presented frame.
3. **GL pools never shrink** — 190 MB after a key with finesse. Release targets of a size not
   used for N frames. Guard: the `glPoolBytes` gauge.
4. **Export, the last 5–10%** — DONE in PX5.4 (below), plus the stack's tail. Left: the rest
   of `stack_alpha` in `mask_stack.py` (a zeroed accumulator and the final `astype / 255` are
   still frame-sized float64 arrays per frame) and the whole-row measurement.

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
- An alpha tier for a matte whose edge chain is the identity (the default soft matte): DONE in
  PX5.8 (below). Not for `sharp` or any edge control, which act at source resolution.
- PX5.5 (two composites per project frame at 60 Hz) and PX5.4 (export ratio) are untouched.

## PX5.6 — oracle rows carrying a `key` mask

Three `alpha/key-*` cases (`tests/fixtures/frame-plan/alpha.json`), at the unchanged PX4 gates
(40 dB PSNR, 99.5% of pixels within 8/255, exact sentinels, exact pts). The keyed source is a
numpy picture (`key_picture` in `engine/python/tests/px4_parity_frames.py`: a green backdrop, a
soft-edged warm subject, one-pixel holes, 3x3 specks, a green-to-red sweep; blue fixed at 92 so no
pixel can read as a sentinel), stored as a lossless PNG and encoded to the asset's proxy like every
other asset. Not an image clip: the export ignores masks on stills (`_compile_image_clip`).

CI run 35337431818 (`b0de2027`), all 60 cases pass:

| Case                    | Sample | What it carries                                                         | PSNR (dB) | Within 8/255 | Max error |
| ----------------------- | ------ | ----------------------------------------------------------------------- | --------- | ------------ | --------- |
| `alpha/key-alone`       | 0.5 s  | an inverted HSL key                                                     | 112.55    | 100%         | 1         |
| `alpha/key-alone`       | 1.5 s  | the same key despilling green (limiter after the cut)                   | 73.66     | 99.99978%    | 19        |
| `alpha/key-shape-stack` | 0.5 s  | key ∩ feathered ellipse − feathered rectangle                           | ∞         | 100%         | 0         |
| `alpha/key-finesse`     | 0.5 s  | denoise, levels, open/close, shrink, blur, in/out ratio at opacity 0.85 | ∞         | 100%         | 0         |

The despill sample has 2 pixels of 921,600 over 8/255 (max 19); where they sit and why was not
examined, since the row passes its gates with a wide margin. CI's SwiftShader has float targets,
so these rows judged the GPU path (a key stack has no CPU path).

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

## PX5.8 — the tier's alpha plane: a soft matte stops decoding its 4K alpha

M1 Pro, Chrome, ANGLE/Metal, 2026-09-18, the same shared machine (load average 10-22 during
these runs: other agents' work). No budget lowered, no tolerance widened, no dependency.

**The rule, from the engine's maths.** `matte_alpha` runs edge shift, the finesse group and the
distance feather at SOURCE resolution, then `to_frame` (resample to the decoded size, crop,
resample to the frame), then invert and opacity. Each source step returns its input exactly
when: `edge_shift` - shift 0; `denoise`, `morph_open`, `morph_close`, `blur` - amount/radius
<= 0; `apply_clean_levels` - levels (0, 1) after `clean_levels`, so `edgeMode: 'sharp'` (0.25 /
0.75) never qualifies; `shrink_grow`, `in_out_ratio` - exactly 0; `distance_feather` - expansion
0 and both feathers (clamped at 0) 0. Then `matte_alpha` = `layer_alpha(to_frame(samples /
maximum))`, and `resample(samples / maximum)` at the decoded size is a plane the host makes once
(`source_chain_is_identity`, `alpha_plane` in `render/matte_tier.py`). Clean levels and
morphology are not linear and the feather redraws the 50 % contour at source resolution, so no
other control can move after the resample: those mattes keep the samples. The test shows the
exclusion is needed: for `sharp`, drawing from the plane moves alpha by more than 0.05.

**Exactness.** 16-bit rounding, at most half a step (1/131070) before the stack quantises once;
where the rule holds the alpha from the plane is `matte_alpha` within that half step
(`test_matte_alpha_tier.py`: 8-bit and 16-bit mattes, cropped and uncropped, inverted with
opacity, clamped feathers; `matte-edges.test.ts` for the TypeScript twin). The monitor uses the
plane only for a mask whose four scalar edge controls are not keyframed (so the rule holds at
every instant), only at the tier's decoded size, only when `alpha.mkv` opened as `tier.json`
says; the compositor applies the rule per instant as well.

**Per frame** (`matte-decode.perf.test.ts`, the real `MatteDecodeSession`, two runs):

| File                             | Size      | p50 ms    | p95 ms    |
| -------------------------------- | --------- | --------- | --------- |
| `matte.mkv` (the 4K samples)     | 3840x2160 | 19.6-20.1 | 25.7-32.5 |
| tier `alpha.mkv` (PX5.8)         | 960x1080  | **3.6**   | 3.8-4.6   |
| tier `planes.mkv` (PX5.3)        | 960x4320  | 16.0-16.1 | 17.9-18.9 |
| `foreground.mkv` (for reference) | 3840x2160 | 42.1-42.9 | 49.5-58.7 |

Making it: 24-34 ms per 4K frame for the Scale disc, 84 ms for a subject filling the frame (on
top of the planes'), one pass over the masters.

**The row.** The Scale row's own matte is `sharp`, so it is untouched by design. A new variant,
`scale-soft`, is the row with the matte at its default soft edge. Before/after on the SAME
fixture: `PX5_TIER_ALPHA=0` withholds only `alpha.mkv` (the monitor then decodes the samples, as
before PX5.8). Seven interleaved pairs, `px5-local-run.py scale-soft/proxy`, one 20-second run
each (pairs 6-7 later, at load 11-15, with `--budgets`: both "after" runs passed both budgets, one
"before" run failed the dropped-frame budget at 7/603):

| Run             | Dropped           | Seek p50 / p95     | Full-res composite p50 | Picture decode p50 | Matte decode p50 / p95 | Cache peak | GL pools   |
| --------------- | ----------------- | ------------------ | ---------------------- | ------------------ | ---------------------- | ---------- | ---------- |
| before 1        | 1/602             | 37.0 / 43.7        | 11.7                   | 78.9               | 21.2 / 36.0            | 420 MB     | 182 MB     |
| after 1         | 132/673           | 31.2 / 54.6        | 7.8                    | 51.3               | 20.4 / 304.9           | 406 MB     | 169 MB     |
| before 2        | 23/602            | 36.8 / 50.9        | 11.5                   | 91.4               | 24.2 / 363.6           | 425 MB     | 182 MB     |
| after 2         | 33/602            | 36.8 / 49.4        | 8.6                    | 52.5               | 20.4 / 236.4           | 404 MB     | 169 MB     |
| before 3        | 90/610            | 49.5 / 75.1        | 18.0                   | 102.5              | 24.9 / 287.1           | 419 MB     | 182 MB     |
| after 3         | 1/602             | 35.3 / 71.4        | 8.9                    | 66.2               | 20.7 / 45.2            | 407 MB     | 169 MB     |
| before 4        | 1/603             | 37.5 / 51.7        | 10.2                   | 90.3               | 22.0 / 55.1            | 420 MB     | 182 MB     |
| after 4         | 2/601             | 35.0 / 58.1        | 8.9                    | 73.0               | 20.4 / 67.0            | 407 MB     | 169 MB     |
| before 5        | 2/602             | 44.1 / 72.0        | 11.8                   | 100.2              | 24.9 / 85.2            | 419 MB     | 182 MB     |
| after 5         | 1/601             | 30.5 / 45.1        | 8.5                    | 59.5               | 20.5 / 27.7            | 407 MB     | 169 MB     |
| before 6        | 2/601             | 43.9 / 55.9        | 10.9                   | 94.1               | 22.4 / 150.3           | 413 MB     | 182 MB     |
| after 6         | 2/603             | 33.0 / 46.4        | 10.4                   | 79.8               | 21.2 / 110.1           | 407 MB     | 169 MB     |
| before 7        | 7/603             | 42.2 / 58.6        | 12.7                   | 105.7              | 27.0 / 193.6           | 424 MB     | 182 MB     |
| after 7         | 1/602             | 33.1 / 55.3        | 8.4                    | 59.9               | 20.3 / 36.6            | 405 MB     | 169 MB     |
| **median of 7** | before 2, after 2 | 42.2 vs 33.1 (p50) | **11.7 -> 8.6**        | **94.1 -> 59.9**   | **24.2 -> 20.4** (p50) | 420 -> 407 | 182 -> 169 |

Runs 3-5 recorded the path: `alphaFromTier: true` after, `false` before, the tier's planes in
both (runs 1-2 predate the field; their "before" arms logged the plane as withheld). What moved, and why: 16 ms of matte-worker CPU per frame is gone, so the picture
decoders wait less for cores (decode window p50 down a third); the composite no longer uploads
and resamples a 4K alpha (-3.1 ms per full-resolution composite, read back); the cache holds a
1 MB plane where the 8.3 MB samples were. What did not: dropped frames and seek p95 are the same
on both sides within this machine's noise - the drops that happened (23, 33, 90, 132 of ~600)
came with load spikes in both arms, and "after 1" ran 673 frames of clock in 20 s, a stall of the
whole page. Both were already inside budget at the PX5.3 final state on a quiet machine; the win
is headroom (worker CPU, decode latency), not a verdict change. Not measured: a slower machine,
where 16 ms of a 33 ms frame matters more; camera mattes (whose 4K samples decode slower than this
flat disc, so the saving is larger).

`scale/proxy` (the `sharp` row, unchanged path, `alphaFromTier: false`) in one run right after, at
load 19: 41/612 dropped, seek p95 46.6 ms - the budget miss is the load (the same code measured
1/602 at load ~10 an hour earlier, 17:09); re-measure on a quiet machine before quoting it.

**PX4 oracle, unchanged gates.** CI run 35341329629 (`09f7eb3d`): 65/65 cases pass (the 60 of
PX5.6 plus five MK8 rows another agent added meanwhile). Six samples in four rows drew their
alpha from the tier's alpha plane (`sample.mattes[].alphaFromTier`): `matte-speed` at 1.3 s and
3.1 s (∞), `matte-vfr` at 1.9 s (∞), `matte-progressive` at 0.5 s (∞), and the effect-target
matte of `matte-text-behind-subject` at 1 s and 2.5 s (53.68 dB, 100% within 8/255: the same
figure as before PX5.8, set by its burned text). The other qualifying samples drew from the
samples, equally within the gates: at `matte-speed` 0.4 s the tier had not loaded yet; at
`matte-vfr` 0.62 s, `matte-display-space` 3 s (a 404x720 tier) and `matte-shape-stack` 2.5 s
the reason was not examined. Every non-qualifying matte (`sharp`, edge shift, feather) kept the
samples, as it must. At the PX5.9 head (CI run 35344378923, `d28c421e`: the tier generator on the
hardened reads) the oracle is again 65/65 with the same six samples from the plane.

## PX5.9 — the desktop makes the tier: the route, end to end

The sidecar route the maintainer approved (MO-17), `POST /mattes/monitor-tier`, run for real on the
Scale fixture's artifact: a sidecar started with `FRAMEPILOT_PROJECTS_ROOT` = the fixture folder,
the fixture's own (cheaply looped) tier moved aside, and the request the host sends (the pinned
artifact, `proxies/scale-d.mp4`, rotation 0). M1 Pro, 2026-09-18, machine shared (load 10-27).

| Step                       | Result                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| First call                 | 200 `written`, 960x540 (measured from the proxy), 5,400 frames, alpha plane: **638 s**                          |
| Per 4K frame               | 118 ms (both masters decoded with the hardened options, planes + alpha, two encodes)                            |
| Budget it ran under        | 600 + 0.5 x 5,400 = 3,300 s (host timeout 3,360 s)                                                              |
| Peak memory                | sidecar ~0.6 GB + four ffmpeg (the 4K RGB decoder ~0.57 GB)                                                     |
| Second call                | 200 `current` in 0.08 s; nothing rewritten                                                                      |
| Against the fixture's tier | decoded pixels identical (framemd5 of 460 sampled frames of both files); files differ by 107 bytes of container |
| Left behind                | `matte-tiers/.staging/` empty                                                                                   |

Then the monitor on that route-made tier, `px5-local-run.py <variant>/proxy --budgets`: rounds 1-2
at load average 12-18, rounds 3-4 half an hour later at load 6-7:

| Run            | Dropped       | Seek p50 / p95 | Full-res composite p50 | Picture decode p50 | Path                             |
| -------------- | ------------- | -------------- | ---------------------- | ------------------ | -------------------------------- |
| `scale` 1      | 2/602 (0.33%) | 37.3 / 47.7    | 12.3                   | 77.8               | planes from the tier, 4K samples |
| `scale-soft` 1 | 26/600 (4.3%) | 29.8 / 45.9    | 7.7                    | 64.6               | planes + alpha plane             |
| `scale` 2      | 24/608 (3.9%) | 46.8 / 65.9    | 12.5                   | 105.9              | planes from the tier, 4K samples |
| `scale-soft` 2 | 42/601 (7.0%) | 31.8 / 38.6    | 8.2                    | 85.8               | planes + alpha plane             |
| `scale` 3      | 1/601 (0.17%) | 37.8 / 44.1    | 11.4                   | 69.8               | planes from the tier, 4K samples |
| `scale-soft` 3 | 1/601 (0.17%) | 30.9 / 46.2    | 8.2                    | 59.5               | planes + alpha plane             |
| `scale` 4      | 1/601 (0.17%) | 37.3 / 51.3    | 11.1                   | 85.9               | planes from the tier, 4K samples |
| `scale-soft` 4 | 2/601 (0.33%) | 31.9 / 48.7    | 7.6                    | 62.1               | planes + alpha plane             |

**Verdict, honestly.** The route works end to end and the monitor takes what it made (every run
recorded the tier; the soft matte's alpha from its plane). Seek-to-present holds its budget in all
eight runs (p95 38.6-65.9 ms against 100). Dropped frames held the 1% budget in all four runs at
load 6-7 (1/601, 1/601, 1/601, 2/601) and missed it in three of four at load 12-18, on both
variants, in bursts with the load spikes: on this shared machine that verdict depends on the
other work, not on the path.

Not measured: the packaged Electron app (the host call itself is covered by `matte.test.ts` and
`matte-media-inspector.tier.test.ts`; this run drove the route with the host's request by hand),
a camera-footage matte (a subject filling the frame costs about twice this disc per frame), and a
second artifact queued behind a running tier (the route answers 503 and the host retries for ~8
minutes, then gives up without a tier).

## PX5.5 — one composite per project frame, at the export's instant

**What the export does for a source whose rate is not the project's.** `export_video` composites
`t = k / fps` for every project frame `k` (`fps` = the project's unless the export settings name
another) and reads each layer's source frame at that instant: `reader_frame_index(video_source_time(
clip, k / fps - start))`, i.e. `int(sourceFps * sourceTime + 1e-5)` for a constant-rate source, by
pts for a variable-rate one (`compiler._export_source_frames`, which the matte alignment check
reads too). So a **60 fps source in a 30 fps project contributes every other frame** (the
`mixed-frame-rates` vector's clip `c2`, played from 1 s: source frames 60, 62, …, 178), a 24 fps
source repeats a frame every fourth project frame, and frame `k` is what the file shows from
`k / fps` to `(k + 1) / fps`. `test_export_frame_grid.py` pins that the export's list equals
`frame_plan_at(project, k / fps)`'s source frame for 60, 30 and 24 fps sources.

**What the monitor did.** Playback evaluated the plan at the audio clock's continuous time. With a
60 fps source it presented the 60 source frames the export skips (frame 61 at 1/60 s); and on a 60
Hz display the two ticks of one project frame had different layer `localTime`s, so the "unchanged"
signature never matched and every project frame was composited (and an animated mask rastered)
twice.

**What changed** (`5a0c795a`). The playback tick plans, presents and decodes ahead at
`projectFrameTime(t) = floor(t · fps + 1e-6) / fps` (`preview/clock/project-frame.ts`), the same
division the export performs; the telemetry's dropped-frame index uses the same helper, so the two
cannot disagree about which frame is due. The audio clock and the playhead stay continuous; a
paused seek keeps its exact time (the frame grab and the PX4 oracle compare arbitrary instants, so
the oracle is unaffected: 68/68 at run 35353756815). The legacy single-track
`WebCodecsPreviewEngine` (the monitor without the layer flag) was not changed. Judge:
`project-frame.test.ts` presents, at every 60 Hz and 144 Hz tick inside frame `k` and a tick a hair
before the next boundary, exactly the export's frames (60, 62, …, 178), and shows the old
continuous time naming frame 61.

**Measured** (`scale-path/proxy`: the row plus an animated feathered 200-vertex path, whose raster
runs inside every composite; M1 Pro, Chrome, ANGLE/Metal, `px5-local-run.py`, one 20-second run
each; "before" = the same tree with only the snap reverted; pairs run back to back):

| Run                   | Load  | Presented / expected | Dropped | Composites (= mask rasters) | Per presented frame | rAF ticks | Frame interval p50 |
| --------------------- | ----- | -------------------- | ------- | --------------------------- | ------------------- | --------- | ------------------ |
| recorded before PX5.5 | n/a   | 607 / 608            | 1       | 1,032                       | 1.70                | 1,035     | n/a (p95 21.4 ms)  |
| before 1              | 19    | 611 / 614            | 3       | 914                         | 1.50                | 919       | 21.6 ms            |
| after 1               | 16–21 | 654 / 658            | 4       | 653                         | 1.00                | 1,457     | 17.1 ms            |
| after 2               | 16    | 593 / 606            | 13      | 592                         | 1.00                | 1,152     | 18.8 ms            |
| before 2              | 11    | 603 / 609            | 6       | 944                         | 1.57                | 949       | 20.6 ms            |
| after 3               | 12    | 594 / 595            | 1       | 593                         | 1.00                | 1,200     | 17.5 ms            |

Composites per presented project frame: **1.50–1.70 → 1.00** in every run. The frame interval
shows the second effect: before, a 16 ms raster on every tick kept the main thread busy enough to
stretch the display's ticks to ~21 ms (46–48 Hz); after, the tick between two composites is free
and the display runs at 60 Hz. Dropped frames are within this shared machine's noise on both sides
(after 2's 13 came with a load spike; after 3 dropped 1). The paired runs share the working tree,
which held a peer's uncommitted preview edits (MK9) in both arms.

**Guard.** `preview-scale-perf.spec.ts` asserts, as an invariant on every machine,
`composites ≤ ⌈1.1 · presented⌉ + render-scale steps` (the slack covers a matte or text raster that
arrives after a frame first drew). It failed both "before" runs above (914 > 673, 944 > 664) and
passed every "after" run; on CI's seven completed variants of run 35353756815 it held (e.g.
`scale-plain` 59 composites for 60 presented frames).

## PX5.11 — the whole 3-minute row, on a CI runner

`.github/workflows/preview-perf-full.yml`, dispatch only (a path-filtered `pull_request` trigger
exists solely so GitHub registers the file from this branch; its job skips every PR run). It
generates the Scale fixture with `px5_scale_fixture.py` (2 min 43 s) and runs
`px5_export_ratio.py --window-seconds 180`: both arms through the real `export_video` at
3840×2160, 5,400 frames each, one export per process, `scale-plain` first. Timeout 330 minutes.

**Run [35369857493](https://github.com/rojan-labs/FramePilot/actions/runs/35369857493)**, head
`91b22dc3` (engine as of PX5.4's cuts; no engine change since), GitHub `ubuntu-latest`, Linux
x86-64, software `libx264` preset medium, the runner to itself (load average 4.5–4.6 after each
arm).

| Arm                     | Wall       | CPU (process tree) | Wall per frame | CPU per frame |
| ----------------------- | ---------- | ------------------ | -------------- | ------------- |
| `scale-plain` (no mask) | 3,386.4 s  | 5,816.9 s          | 627 ms         | 1,077 ms      |
| `scale` (4K matte)      | 4,476.4 s  | 7,628.8 s          | 829 ms         | 1,413 ms      |
| **Ratio**               | **1.322×** | **1.311×**         |                |               |

**Verdict: the budget (≤ 1.5×) holds on the whole row**, with 0.18 to spare, and the CPU ratio
agrees with the wall ratio. So the 4-second windows were not flattering it: the full row's wall
ratio sits at the low end of their 1.32–1.45× range. Its CPU ratio (1.31×) is above the windows'
1.20–1.26×, so per-frame matte work is a little heavier over the whole row than over its first
4 seconds (the windows' fixed per-export overhead, reading and preparing assets, dilutes it);
the window CPU numbers slightly understate the matte's cost.

What this is not: one run on one CI machine class, not a distribution and not an M-series Mac
(`h264_videotoolbox` there; the local 6 s windows were 1.49× before PX5.4). The matte costs
~200 ms of wall and ~340 ms of CPU per 4K frame here; what would move it further is unchanged
from PX5.4 (the rest of `stack_alpha`, and the matte's two FFV1 reads).

## PX5.10 — the parity baseline regenerated from CI

CI run 35353756815 at `5a0c795a` (the PX5.4 + PX5.5 head), job `Preview/export parity oracle
(PX4)`: **68/68 cases pass every check** at the unchanged gates. `px4-baseline.mjs
--write-baseline` over its `preview-parity-results` artifact rewrote
`tests/e2e/fixtures/preview-parity-baseline.json` (failing-case list still empty; the one colour
entry, Chromium's own BT.709-limited texture path at 9/255, still fails and stays listed),
`PX4-BASELINE.md` and the PX0 inventory's pixel column (`650efe54`). The nine rows added since the
previous regeneration now show as measured instead of "not measured (PX4.3)": `alpha/key-alone`
73.66 dB (the despill sample), `key-shape-stack` and `key-finesse` inf, `analytic-split-band` and
`analytic-gradient` inf, `layer-text-alpha` and `layer-luma-channels` inf,
`layer-transformed-target` 95.39 dB. `matte-decontaminate` reads 97.78 dB: it draws from its
monitor tier since PX5.3 (inf when it drew from the masters).

Then again from CI run 35366379149 at `b361595d` (every PX5.4 cut and PX5.5 in, plus MK9): **72/72
pass** at the unchanged gates, with mask vectors green on macOS, Windows and Linux in the same
run. The four rows MK9 added meanwhile are measured too: `alpha/frame-space-clip-mask` 90.76 dB,
`alpha/edge-styles-shape` 67.02 dB, `alpha/edge-styles-matte` 60.94 dB,
`effects/lane-mask-over-moving-picture` 76.85 dB, all 100% within 8/255. `matte-decontaminate`
drew from the masters in that run (inf) where the first drew from its tier (97.78 dB).
