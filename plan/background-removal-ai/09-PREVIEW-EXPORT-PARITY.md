# 09 — Preview renders what the export renders (the core fix)

> **Why this is in this plan:** background removal is useless in a monitor that cannot draw
> a cut-out over other layers, and "text behind a person" (video → text → matted copy of the
> same video) is the most common thing people make with it. The narrow BR5a/BR5b relations
> that an earlier draft of this plan proposed are **withdrawn**. They would have added a
> third special case to an eligibility gate that is itself the root cause. This file replaces
> them with the root fix, and it benefits every multi-layer edit, not just mattes.
>
> **Relationship to [`plan/PREVIEW-WEBCODECS-COMPOSITOR.md`](../PREVIEW-WEBCODECS-COMPOSITOR.md):**
> that plan built the decode, clock and single-layer compositor (P0–P6) and still carries the
> open items this phase closes: the automated visual-diff harness (P3), speed ramps, and
> decoder-pool LRU (P4). Those items move here and are marked there as superseded, pointing to PX.

## The rule

**The preview may be lower resolution or drop frames under load. It may never show different
content from the export.** Same layers, same order, same source frame, same geometry, same
alpha, same colour pipeline, within a stated numeric tolerance. When it cannot keep up, it
shows the right picture late. It never shows a wrong picture on time.

## Root cause (audited 2026-09-16 at `8889d605`)

1. **Two renderers, chosen by a gate.** `Editor.tsx:545` picks `WebCodecsPreviewPlayer` only if
   `webCodecsPreviewEligible`, otherwise the legacy DOM `PreviewPlayer` (a `<video>` pool that
   shows **one clip at a time** and draws text on top). Inside the WebCodecs player,
   `canvasPreviewEligible` (`selectors-base.ts:351`) turns off segments, overlays **and captions**
   when the timeline is not eligible (`WebCodecsPreviewPlayer.tsx:149-325`).
2. **The canvas model is a flat EDL.** `pictureSegments` flattens all tracks into one picture per
   instant (header of `webcodecs-preview-engine.ts`: "no overlapping picture clips"). Overlap is
   admitted only when the front clip hides everything behind it (ADR 0169/0170): a correct
   relation, but one that exists to avoid compositing, not to do it.
3. **Text and captions ignore z-order.** `drawOverlays` (`webcodecs-preview-engine.ts:684`) paints
   every text overlay after all pictures. The export composites `kind == "text"` clips **in their
   track's position** (`render/compiler.py:1138-1148`). Text on a middle track is behind the top
   track in the export and in front of it in the monitor.
4. **Speed.** Any non-1× clip makes the timeline ineligible (the speed-ramp item is still open in P4).
5. **Unproxied originals** route to the DOM player because the demuxer loads the whole file into
   memory (`webCodecsPreviewEligible` doc comment).
6. **No parity oracle.** `effects/parity.test.ts` and `transitions/parity.test.ts` pin contracts
   (shader per kind, parameter order, noise clock), and their header says so: "The actual pixel
   comparison belongs to a golden-media test with a real GL context." That test does not exist.
   Every past divergence (masks never drawn, captions, letterbox bars) was found by a person
   looking at the monitor.

## Target architecture

```
timeline + assets + t ──► framePlanAt()  (pure TS)  ◄── parity vectors ──►  frame_plan_at()  (pure Python, compiler)
                              │
                              ▼
                  ordered Layer[] (back → front), each:
                  { kind: picture|text|caption|solid,
                    source: { assetId, sourcePts } | raster params,
                    crop, matte{artifact, pts, edgeShift, feather, invert}, mask, grade, effects[],
                    transform, opacity, blendMode, transition{role, progress, underlay?} }
                              │
                              ▼
            LayerCompositor (WebGL2): per layer → FBO: decode/raster → crop → matte → mask →
            grade → effects → transform/fit → premultiplied alpha → blend onto accumulator in order
                              │
                              ▼
                        present on the audio-master clock
```

### PX1 — one frame description, two implementations, one test suite

- `packages/editor-core/src/frame-plan.ts`: `framePlanAt(timeline, assets, projectTime, resolution)`
  → `FramePlan` (layers back→front, plus the canvas background). It is pure, with no DOM and no
  decoding. It owns track order and hidden/solo tracks, clip activity at `t`, output-time →
  source-time mapping (constant speed **and** `speedRamp` integration), keyframe evaluation,
  transition underlays, fit/letterbox, and text/caption placement in track order.
- `engine/.../render/frame_plan.py`: `frame_plan_at(project, t)`, extracted from what
  `compile_timeline` already decides, so the compiler **consumes** it rather than a second copy
  of the logic being written beside it. This is a refactor of the compiler's decision half
  only. Pixel work stays in MoviePy.
- **Parity vectors:** `tests/fixtures/frame-plan/*.json` are timelines covering the feature matrix
  below, each with sampled times. A Python test writes `expected` plans, and a TS test asserts
  `framePlanAt` equals them field by field (floats to 1e-6, source pts exact). A drift test fails
  if either side changes without regenerating. This is the `captionStyle.ts ↔ captions.py` pattern,
  and it catches ordering, timing and geometry drift with no GPU.

### PX2 — an N-layer compositor replaces the flat EDL

- `apps/web-editor/src/preview/engine/layer-compositor.ts`: WebGL2 with one FBO per active layer
  from a pool and premultiplied alpha throughout. Blend modes are implemented as shaders mirroring
  `render/blend.py` (the canvas `globalCompositeOperation` approximations are removed).
  `GlEffectChain`, `GlTransitionChain` and `clip-mask.ts` become per-layer passes in the one pipeline.
- Text and captions are rasterised into their own layer textures, cached by a semantic signature
  (`semantic-signature.ts`) and composited **at their track position**. `drawOverlays` and the
  separate `WebCodecsCaptionLayer` DOM layer are deleted once parity passes.
- **Decode sharing:** layers that reference the same asset at the same source pts share one
  decoded `VideoFrame` (text-behind-subject decodes once and draws twice). Otherwise there is a
  bounded decoder pool with LRU + reconfigure (the P4 item), sized by measurement.
- **Speed and ramps:** source pts come from the frame plan. The frame ring is indexed by source
  pts, so a ramp is a lookup, not a special path.
- **Unproxied originals (desktop):** range-read streaming demux (fetch sample tables from `moov`,
  read samples by byte range through `fp-media://`), so no timeline is routed away from the
  compositor. While a proxy is still being generated, preview reads the original at reduced
  decode resolution: correct content, lower cost.
- **Colour pipeline:** match the engine's YUV→RGB matrix and range (BT.601 vs BT.709, limited vs
  full, as ffmpeg/MoviePy apply them) in the shader. Chromium's default `VideoFrame` → texture
  conversion is **not assumed** to match. PX0 measures it, and a mismatch is fixed in the shader,
  not in the tolerance.
- **Load shedding without lying:** under budget pressure the compositor first lowers layer render
  resolution, then drops presentation frames on the clock. It never skips a layer, a matte, an
  effect or a transition. A small "Preview reduced" indicator shows when it degrades.

### PX3 — delete the gates

- Remove `canvasPreviewEligible`, `webCodecsPreviewEligible`, the ADR 0169/0170 hiding relation
  as a _gate_, and the DOM `PreviewPlayer` from the desktop program monitor. Everything it did that
  is still needed (on-canvas transform, select-hit, captions editing affordances) already lives on
  the WebCodecs player or moves to it. An ADR supersedes 0169/0170's gating role; their geometry
  facts stay true and become test cases.
- The browser build keeps whatever it can decode, and a missing capability shows a visible
  "Preview unavailable for this timeline in the browser" rather than a wrong picture. Browser
  parity is deferred; the desktop is product focus #1.

## Feature matrix (every row is a parity vector **and** a pixel case)

| Area        | Cases                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Layering    | 1, 2, 3, 5 picture layers; hidden and soloed tracks; same-asset stack; gaps between layers                              |
| Text        | text below, between and above pictures; caption track order; burn-in on/off as the export sets it                       |
| Alpha       | matte (BR), shape masks, matte × mask, invert, opacity keyframes, letterboxed sources over other layers, PNG with alpha |
| Geometry    | transform keyframes, crop, fit/letterbox across aspects, rotation metadata                                              |
| Time        | constant speed 0.25×–4×, speed ramps, reverse if supported, trims at non-keyframes, VFR source, edit-list source        |
| Colour      | grade, LUTs, blend modes over non-opaque layers, BT.601/709, full/limited range                                         |
| Effects     | every `EFFECT_CATALOG` kind; effect layers (schema v13)                                                                 |
| Transitions | every `TRANSITION_CATALOG` kind, over stacked layers                                                                    |
| Scale       | a 3-minute 4K timeline with 4 layers + text + a matte, played end to end on desktop hardware                            |

## PX4 — the pixel parity oracle

- **Ground truth:** `render/frame_grab.py` already composites one frame through `compile_timeline`,
  the export path. PX4 adds a lossless, full-resolution mode (PNG, no downscale) for tests.
- **Harness:** a Playwright desktop test (real Chromium, GPU where available, as the existing
  `preview-webcodecs-p3.spec.ts` does) loads each matrix timeline, seeks the WebCodecs player to
  each sampled time, waits for the presented frame, reads the canvas back, and compares it with
  the engine frame at the same resolution. The source media are proxies with the engine rendering
  from the same proxies, so codec loss is identical on both sides.
- **Metrics and thresholds (initial; tightened, never loosened, as fixes land):** PSNR ≥ 40 dB
  whole frame; max per-channel error ≤ 8/255 on ≥ 99.5% of pixels; **layer-order and
  content checks exact**. Each case also renders a "sentinel" colour per layer so a missing,
  extra or misordered layer is detected by colour, independent of the PSNR.
- **Frame identity:** the preview reports the source pts it presented per layer, and the test
  asserts it equals the frame plan's pts. Off-by-one is a failure, not a tolerance.
- **CI:** matrix cases run on the PR (CPU GL fallback allowed, thresholds the same). A failure
  uploads the preview frame, engine frame and diff heat map as artifacts.

## PX5 — performance evidence (performance-monitor owns the budget)

- Budgets on an M-series Mac for the Scale row: playback holds the project frame rate at the
  preview's default resolution with ≤ 1% dropped frames; seek-to-present ≤ 100 ms; memory bounded
  by the decoder pool size. Measured before and after; no "should be faster" claims.
- A non-flaky regression guard (frame-time percentiles from the engine's own telemetry, not wall
  clock in CI).

## Order and DoD

`PX0 inventory (measure every matrix row today: which renderer, what differs, screenshots) →
PX1 frame plan + vectors → PX4 oracle (run against today's preview, record the failures) →
PX2 compositor until the oracle passes → PX3 delete gates → PX5 perf`

The oracle comes **before** the compositor on purpose. Parity work is judged by the harness, not
by eye. **Done when** every matrix row passes PX4 on desktop, both gates and the DOM program
monitor are deleted, and PX5 budgets hold. BR5 (matte in the preview) becomes a matrix row plus
the matte decode pass. It needs no relation of its own.
