# PX0 inventory — what the desktop program monitor draws today

> Task PX0.2 of [`07-TASKS-AND-EVIDENCE.md`](./07-TASKS-AND-EVIDENCE.md); spec in
> [`09-PREVIEW-EXPORT-PARITY.md`](./09-PREVIEW-EXPORT-PARITY.md). Measured 2026-09-16.

## How this table is produced

Nothing in the table below is written by hand. `apps/web-editor/src/preview/px0-inventory.test.ts`
loads every case in [`tests/fixtures/frame-plan/`](../../tests/fixtures/frame-plan/) and:

1. runs the real renderer gates on it: `webCodecsPreviewEligible` from `editor/selectors.ts`
   (the one `components/Editor.tsx` uses to mount `WebCodecsPreviewPlayer` instead of the DOM
   `PreviewPlayer`), its base in `selectors-base.ts`, and `canvasPreviewEligible` (the gate
   inside the WebCodecs player that turns segments, overlays and captions off);
2. derives the export's frame at every sample time with `framePlanAt`, which is pinned to the
   engine's `render/frame_plan.py` by the PX1.3 parity vectors;
3. reports each fact of the export plan that the selected renderer is known, from its code, to
   draw differently. Every sentence names the code responsible.

The test fails when this table and the code disagree. When a gate or a fixture changes, the
failure's diff is the new table: paste it between the markers.

**Renderer column values.** `WebCodecs canvas` and `DOM PreviewPlayer` are the two program
monitors. `WebCodecs, overlays disabled` (the WebCodecs player mounted with its canvas gate
closed) cannot happen on the desktop program monitor today, because `webCodecsPreviewEligible`
implies `canvasPreviewEligible`; the test asserts that. `blank` is a timeline with nothing
drawable; no matrix case is one.

**Pixel column.** Read by the test from `tests/e2e/fixtures/preview-parity-baseline.json`, which
is regenerated only from the CI run of the PX4 oracle (`preview-parity-oracle` job, artifact
`preview-parity-results`); see [`PX4-BASELINE.md`](./PX4-BASELINE.md). `not read back (DOM renderer)`
means the oracle recorded the case as a `renderer: DOM` failure and could not read a canvas.

## Findings the derivation surfaced

- **Any text overlay or caption routes the desktop monitor to the DOM player.** The
  decoded-audio admission override in `editor/selectors.ts` treats a clip whose asset is
  unknown as video with no duration, and the synthetic `__text__`/`__caption__` ids are exactly
  that. So `text-above`, `text-below`, `text-transform` and `captions-burn-off` pass every
  compositing gate and still get the one-clip DOM player. The P3b "overlays on the canvas" work
  is unreachable on the desktop for any timeline that has text.
- **A speed ramp is admitted to the canvas.** `canvasPreviewEligible` checks `clip.speed` only,
  so a `speedRamp` clip passes (`time/speed-ramp`), and nothing on the canvas path integrates the
  ramp: its source frames cannot follow the export's.
- **Stacks are canvas-eligible only when the front clip hides the rest** (ADR 0169/0170). Every
  stack with a smaller, masked, blended, keyframed or translucent front layer is on the DOM
  player, which draws one clip. That is the whole alpha, blend and picture-in-picture half of
  the matrix, plus the same-asset stack that "text behind a subject" needs.
- **Text z-order** differs whenever the export puts text under a picture: both players paint
  overlays above all pictures.
- **Transition under-layers** differ in both players: the export plays the neighbour's handle
  past the cut (`underlay_material`), the preview holds a frame of the previous shot.
- **Export quirks the plan records rather than hides:** a still image ignores its crop and
  opacity keyframes; burned captions composite above every track in caption-track _list_
  order; effect layers apply to the finished frame whatever their lane position. PX2 has to
  decide, per quirk, whether the preview copies it or the export is fixed (with a golden
  update). Neither may happen silently.

## Matrix rows not expressible in schema v21

These rows need source properties the project does not carry, or real media. They move to
PX4 fixtures with media rather than being faked here.

| Row                                                                                                 | Why not a timeline-only fixture                                                                                            | Where it is covered                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Layering: soloed tracks                                                                             | Solo is monitoring state (`effectiveMutedTrackIds`, H0.4) and audio-only; the project and the export have no picture solo. | Not a render row; no divergence to measure.    |
| Alpha: v22 mask stack (kinds × modes × invert × feather, mattes, tracked masks, layer/track mattes) | Schema v22 is landing in MK1 concurrently; today's plan carries the v21 first `mask` effect only.                          | MK rows extend these fixtures once MK1 merges. |
| Geometry: rotation metadata, anamorphic pixel aspect                                                | `Asset.media` has width/height only; rotation and SAR live in the file.                                                    | PX4 media fixtures.                            |
| Time: VFR source, edit-list source, interlaced source                                               | Container/stream properties of real media.                                                                                 | PX4 media fixtures.                            |
| Colour: BT.601/709, full/limited range                                                              | Needs encoded media and a real browser's `VideoFrame` → texture conversion.                                                | PX0.3 (below).                                 |
| Scale: 3-minute 4K, 4 layers + text + matte                                                         | A performance row.                                                                                                         | PX5.                                           |

## PX0.3 — Chromium colour conversion

Measured in CI by the PX4 harness (`preview-parity-oracle.spec.ts`, "PX0.3 colour conversion"), run
[35140382484](https://github.com/rojan-labs/FramePilot/actions/runs/35140382484) at `700f4e7d`:
Google Chrome on ubuntu-latest, **SwiftShader** (ANGLE Vulkan, CPU GL; no GPU). One 1280x720 H.264
clip per encoding, a 4x3 grid of RGB patches converted by ffmpeg with the stated matrix and range
and tagged to match (Chromium read the tags back exactly: `smpte170m`/`bt709`, `fullRange`
false/true). Engine = `frame_grab` lossless (MoviePy/ffmpeg rgb24). Preview canvas2d = the
WebCodecs program monitor's canvas (`drawImage(VideoFrame)`). WebGL = `texImage2D(VideoFrame)` of a
`<video>` frame, read back through a framebuffer. Values are the mean of each patch's central half.
Gate: max per-channel |preview − engine| ≤ 8/255 on every patch (the PX4 channel tolerance).

| Encoding       | Max err canvas2d | Max err WebGL | Worst patches (engine → preview)                                                                   | Gate     |
| -------------- | ---------------- | ------------- | -------------------------------------------------------------------------------------------------- | -------- |
| BT.601 limited | 2                | 2             | yellow75 188,189,0 → 190,191,1; green75 G 188 → 190; skin 222,170,138 → 224,172,140                | pass     |
| BT.601 full    | 2                | 2             | cyan75 G 189 → 191                                                                                 | pass     |
| BT.709 limited | **9**            | **9**         | yellow75 190,188,**0** → 191,191,**9**; blue75 B 190 → 182; green75 B 0 → 6; magenta75 B 191 → 185 | **fail** |
| BT.709 full    | 2                | 2             | yellow75 G 189 → 191; green75 G 190 → 192                                                          | pass     |

Findings, not tuned away:

- **BT.709 limited range, the encoding every preview proxy uses (`media/derive.py`), is the one that
  fails.** Chromium's conversion puts up to 9/255 on the blue channel of saturated colours
  (yellow, green, blue, magenta) where the engine's matches the authored RGB to within 2. The three
  other encodings agree within 2/255. The error sits in chroma to blue, so PX2.7 should check
  Chromium's limited-range BT.709 Cb scale/offset against ffmpeg's in the shader, not widen the gate.
- The 2D canvas and the WebGL texture upload produce identical numbers on SwiftShader: one
  conversion path, so a single shader fix covers both.
- Measured on SwiftShader only. A GPU (desktop) run can convert differently; the same test runs
  there unchanged, and a local GPU measurement stays a single-case, memory-capped exercise
  (spec header).
- Raw per-patch numbers: `px03-colour.json` in the run's `preview-parity-results` artifact and the
  colour table in [`PX4-BASELINE.md`](./PX4-BASELINE.md).

## Inventory

<!-- px0:inventory:start -->

**48 cases.** WebCodecs canvas: 21 · DOM PreviewPlayer: 27 · WebCodecs, overlays disabled: 0 · blank: 0

| Matrix row | Case | Today’s program monitor | Why (first gate that decided) | Known divergence vs export (derived) | Pixel diff vs `frame_grab` |
| --- | --- | --- | --- | --- | --- |
| Alpha: clip mask stack (v22 rectangle/ellipse/path, static and keyframed) | `alpha/mask-shapes` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)<br>clip mask: DOM draws the stack raster on the one visible clip only (maskRasterCssImage) | fails pixels, sentinel (min PSNR 10.21 dB, min 69.152% within 8/255) |
| Alpha: opacity keyframes | `alpha/opacity-keyframes` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation) | passes (min PSNR 71.94 dB, min 100% within 8/255) |
| Alpha: matte mask (BR2) read at the picture's decoded source frame | `alpha/matte-text-behind-subject` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)<br>text sits under a picture in the export; preview paints overlays above every picture (drawOverlays / DOM overlay div)<br>speed ramp: DOM maps element time 1:1, so source frames drift from the export<br>clip mask: DOM draws the stack raster on the one visible clip only (maskRasterCssImage) | fails pixels, sentinel (min PSNR 14.61 dB, min 39.531% within 8/255) |
| Colour: grade | `colour/grade` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Colour: LUT | `colour/lut` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Colour: blend modes over non-opaque layers | `colour/blend-modes` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation) | passes (min PSNR 75.31 dB, min 100% within 8/255) |
| Effects: every EFFECT_CATALOG kind (effect layers, schema v13) | `effects/effect-kinds` | WebCodecs canvas | all gates pass | effect layers: export applies them to the finished frame incl. burned captions; canvas pass runs after text but the caption DOM layer is not covered | passes (min PSNR 60.19 dB, min 100% within 8/255) |
| Effects: effect layer between picture tracks | `effects/effect-layer-between` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)<br>effect layers: export applies them to the finished frame; DOM overlay sits below text and captions (PreviewEffectOverlay) | passes (min PSNR 64.77 dB, min 100% within 8/255) |
| Geometry: transform keyframes | `geometry/transform-keyframes` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation) | passes (min PSNR 79.11 dB, min 100% within 8/255) |
| Geometry: crop | `geometry/crop` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Geometry: fit/letterbox (16:9 source, 9:16 frame) | `geometry/fit-landscape-in-portrait` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Geometry: portrait phone footage | `geometry/fit-portrait-in-landscape` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Geometry: fit across aspects | `geometry/fit-mixed-aspects` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR 78.25 dB, min 100% within 8/255) |
| Geometry: PNG still with keyframes and crop | `geometry/image-png` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)<br>still image: export ignores its crop and opacity keyframes (_compile_image_clip); preview crops it (crop-fill.ts) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Geometry: anamorphic pixel aspect ratio | `geometry/anamorphic-pixel-aspect` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Geometry: rotation metadata | `geometry/rotation-metadata` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Geometry: rotated anamorphic source | `geometry/rotated-anamorphic` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: 1 picture layer | `layering/layers-1` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: 2 picture layers | `layering/layers-2` | WebCodecs canvas | all gates pass | export stacks up to 2 pictures; flat EDL paints only the front clip, admitted only because it hides the rest (ADR 0169/0170) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: 3 picture layers | `layering/layers-3` | WebCodecs canvas | all gates pass | export stacks up to 3 pictures; flat EDL paints only the front clip, admitted only because it hides the rest (ADR 0169/0170) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: 5 picture layers | `layering/layers-5` | WebCodecs canvas | all gates pass | export stacks up to 5 pictures; flat EDL paints only the front clip, admitted only because it hides the rest (ADR 0169/0170) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: hidden track | `layering/hidden-track` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: same-asset stack | `layering/same-asset-stack` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: gaps between layers | `layering/gaps-between-layers` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Layering: unproxied original (desktop) | `layering/unproxied-original` | DOM PreviewPlayer | WebCodecs gate: unproxied video | unproxied original: routed to DOM because the WebCodecs demuxer loads whole files | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Text: above pictures | `text/text-above` | DOM PreviewPlayer | decoded-audio admission (selectors.ts): a clip whose asset has no duration — synthetic text/caption ids count — or over the PCM budget | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Text: between pictures | `text/text-between` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)<br>text sits under a picture in the export; preview paints overlays above every picture (drawOverlays / DOM overlay div) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Text: below pictures | `text/text-below` | DOM PreviewPlayer | decoded-audio admission (selectors.ts): a clip whose asset has no duration — synthetic text/caption ids count — or over the PCM budget | text sits under a picture in the export; preview paints overlays above every picture (drawOverlays / DOM overlay div) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Text: positioned and keyframed | `text/text-transform` | DOM PreviewPlayer | decoded-audio admission (selectors.ts): a clip whose asset has no duration — synthetic text/caption ids count — or over the PCM budget | none derived | passes (min PSNR 101.09 dB, min 100% within 8/255) |
| Text: caption track order (burn-in on) | `text/caption-track-order` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)<br>burned captions composite above everything in caption-track list order; preview draws them as a DOM layer in its own order | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Text: burn-in off | `text/captions-burn-off` | DOM PreviewPlayer | decoded-audio admission (selectors.ts): a clip whose asset has no duration — synthetic text/caption ids count — or over the PCM budget | export burns no captions (burn-in off); preview still draws caption clips | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Text: text with no picture | `text/text-only` | DOM PreviewPlayer | canvas gate: no picture clip | no picture clip: canvas gate refuses overlay-only timelines, DOM draws text on black | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: constant speed 0.25x | `time/speed-0.25x` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: constant speed 0.5x | `time/speed-0.5x` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: constant speed 2x | `time/speed-2x` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: constant speed 4x | `time/speed-4x` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: freeze frame (speed 0) | `time/speed-freeze` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: reverse 1x | `time/reverse-1x` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: reverse 2x | `time/reverse-2x` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: speed ramp | `time/speed-ramp` | WebCodecs canvas | all gates pass | speed ramp: the canvas gate checks only constant `speed`, so WebCodecs admits the clip and its source frames do not follow the ramp | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: trims at non-keyframes | `time/trims-non-keyframe` | WebCodecs canvas | all gates pass | none derived | passes (min PSNR Infinity dB, min 100% within 8/255) |
| Time: mixed frame rates on one timeline | `time/mixed-frame-rates` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation) | passes (min PSNR 88.52 dB, min 100% within 8/255) |
| Time: variable-frame-rate source (frame = last pts at or before the source time) | `time/variable-frame-rate` | DOM PreviewPlayer | canvas gate: speed ≠ 1 | retimed clip: DOM maps element time 1:1, so source frames drift from the export (H1.2h) | passes (min PSNR 78.39 dB, min 100% within 8/255) |
| Transitions: legacy kinds (start-aligned) | `transitions/transitions-legacy` | WebCodecs canvas | all gates pass | transition under-layer: export plays the neighbour's handle past its cut; preview reveals over a held frame of the previous shot | passes (min PSNR 75.42 dB, min 100% within 8/255) |
| Transitions: every TRANSITION_CATALOG render kind | `transitions/transitions-catalog` | WebCodecs canvas | all gates pass | transition under-layer: export plays the neighbour's handle past its cut; preview reveals over a held frame of the previous shot | passes (min PSNR 59.91 dB, min 99.922% within 8/255) |
| Transitions: centre/end alignment and a disabled cut | `transitions/transitions-alignment` | WebCodecs canvas | all gates pass | transition under-layer: export plays the neighbour's handle past its cut; preview reveals over a held frame of the previous shot | passes (min PSNR 75.45 dB, min 100% within 8/255) |
| Transitions: over stacked layers | `transitions/transitions-over-stack` | DOM PreviewPlayer | canvas gate: stacked pictures the front clip does not hide (ADR 0169/0170) | export stacks up to 2 pictures; DOM player shows only the front-most active clip (PreviewPlayer.tsx videoLocation)<br>transition under-layer: export plays the neighbour's handle past its cut; preview reveals over a held frame of the previous shot<br>catalog transition pass: DOM player only has the legacy envelopes (transition-envelope.ts), no GL transition chain | passes (min PSNR 76.65 dB, min 100% within 8/255) |
| Transitions: under-layer with no handle (held edge frame) | `transitions/transitions-underlay-edges` | WebCodecs canvas | all gates pass | transition under-layer: export plays the neighbour's handle past its cut; preview reveals over a held frame of the previous shot | passes (min PSNR 75.1 dB, min 100% within 8/255) |

<!-- px0:inventory:end --> |
