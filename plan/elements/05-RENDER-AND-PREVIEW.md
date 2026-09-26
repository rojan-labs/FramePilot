# 05 — Render and preview

The render engine (Python, MoviePy + FFmpeg + Pillow) is the authority; the program monitor (the
layer compositor driven by `framePlanAt`) must show what it will produce. Every change here lands in
**three** places at once — the export compiler, the two frame plans, and the monitor — and is proven
by the PX4 pixel oracle. MoviePy is never used for preview (AGENTS.md §2).

---

## 1. Stills and titles join the picture pipeline (EL2a, EL2b)

### 1.1 What changes, and when

Today (00 §3 G1, G6, G11) a still gets grade + placement and a title gets placement. The work is
split so each half lands with a consumer (scope review, change 5):

| Stage                                                 | Video today        | Still today | Title today | EL2a               | EL2b                                                                                     |
| ----------------------------------------------------- | ------------------ | ----------- | ----------- | ------------------ | ---------------------------------------------------------------------------------------- |
| crop                                                  | ✓                  | ✗ (G11)     | n/a         | **stills**         | —                                                                                        |
| opacity keyframes × fade/dissolve envelope            | ✓ (`_attach_mask`) | ✗           | ✗           | **stills, titles** | —                                                                                        |
| own alpha multiplied, never replaced                  | n/a                | —           | —           | **stills, titles** | —                                                                                        |
| a title's `inAnimation`/`outAnimation` presets        | n/a                | n/a         | ✗ (G6)      | **titles**         | —                                                                                        |
| colour grade / LUT / blur                             | ✓                  | ✓           | ✗           | —                  | titles: blur                                                                             |
| mask stack (alpha targets)                            | ✓                  | ✗           | ✗           | —                  | **stills, titles** (with EL6b)                                                           |
| edge styles (outline / glow / shadow)                 | ✓                  | ✗           | ✗           | —                  | **stills, titles** — reading the layer's own alpha when it has no mask stack (with EL6b) |
| catalogue + geometry transitions (zoom, slide, wipe…) | ✓                  | ✗           | ✗           | —                  | **stills, titles** (with EL7)                                                            |
| blend mode                                            | ✓                  | ✓           | ✓           | —                  | —                                                                                        |

### 1.2 Engine (`render/compiler.py`)

- **EL2a:** `_compile_image_clip` applies the crop and goes through `_attach_mask` (opacity ×
  fade envelope); `_compile_text_clip` goes through `_attach_mask` and applies the title's own
  In/Out envelope (fade = opacity ramp; slide up/down = a y-offset ramp; pop = a scale ramp — the
  math of `apps/web-editor/src/editor/textOverlay.ts` `animationProgress`/`animationTransform`,
  ported once to Python).
- **The one real trap: own alpha.** A PNG/WebP sticker and a text raster already carry an alpha mask
  (`ImageClip(…, transparent=True)`). `_attach_mask` today _replaces_ a clip's mask (`with_mask`).
  For these layers it must **multiply** the existing mask by opacity × envelope (× mask-stack alpha
  in EL2b), or every sticker becomes an opaque square the moment it fades. Unit-tested on a
  half-transparent pixel, and an oracle row (`stills/alpha-times-opacity`).
- **EL2b:** masks, edge styles and catalogue/geometry transitions for stills and titles, in the same
  order the video path applies them. Edge styles (`render/edge_styles.py`) read "the clip's
  alpha-target mask stack"; with no stack, the cut-out becomes the layer's own alpha ≥ ½ — the same
  rule, a different source. Stickers ship with a transparent margin (03 §3: 12% on each side) so an
  outline or shadow is not clipped at the image edge ("styles draw inside the clip's picture
  bounds").

### 1.3 Frame plans (`render/frame_plan.py`, `editor-core/src/frame-plan.ts`)

- **EL2a:** `_image_layer` / `imageLayer` carry `crop` and `opacity` (`layer_opacity_at`) and their
  geometry honours the crop; `_text_layer` / `textLayer` carry `opacity` and the In/Out envelope's
  scale and offset. **EL2b:** both carry `mask`, `transitions` and `edge_styles` exactly as
  `_video_layer` does.
- The docstring's "Quirks of today's export … a still image ignores its crop and opacity keyframes"
  and `frame-plan.ts:914`'s comment go with the quirks they describe.
- `tests/fixtures/frame-plan/*.json` regenerate; the vector tests are the proof the runtimes agree.

### 1.4 Monitor (`preview/engine/layer-compositor.ts`, `layer-preview-engine.ts`)

The compositor already applies opacity, masks, transitions and edge styles to video layers; the
image and text branches (`layer-preview-engine.ts:1010` onward; titles at `:864-894`) route through
the same passes, with the same own-alpha rule.

### 1.5 Existing projects

A photo or title that already carries an opacity keyframe, a crop, a fade or an In/Out preset will
now **show and export it** — the control that did nothing starts working, and a reframed photo stops
showing the footage behind it through bars. That is a behaviour change, not a regression; it is
listed under **Fixed** in the changelog and in the ADR ("A still is a picture layer like any
other"). Engine golden renders that contain such stills or titles are regenerated in the same change
(AGENTS.md §8: no render change without a golden update).

---

## 2. Shapes (EL4a, EL5)

### 2.1 Geometry — the engine's, and only the engine's

`render/shape_geometry.py`:

1. Resolve the frame: box `(x, y, width, height)` or segment `(x1, y1, x2, y2)` → output pixels
   (percent-of-axis for position, percent-of-frame-height for size and stroke, 03 §1.4).
2. Run the generator (EL4a: rect with corner radius, ellipse, line/arrow segment; EL5: polygon,
   star, ring, bubble, corners, curved arrow, path) with the clip's knobs → a path of `M L C Q Z`
   in output pixels.
3. Flatten curves by adaptive subdivision to ¼ px at the supersampled scale; emit polygons (with the
   fill rule each generator declares — a ring is even-odd) and polylines (strokes and caps).

**No second implementation to keep in agreement.** The frame plans carry a shape layer's **bounds**
computed from its params (the box, or the endpoints' box, grown by stroke and cap) — plain arithmetic,
pinned by the frame-plan vectors — which is all the monitor needs for placement, hit-testing and
handles. TypeScript draws shapes only as panel tiles (§2.4). The earlier idea of a 1e-6 TS↔Python
geometry fixture was dropped by the scope review (change 4): it had no consumer once the engine is
the only rasteriser.

### 2.2 Raster

`render/shape_raster.py` (Pillow, no new dependency):

- Canvas = the shape's bounds + stroke + caps, at **4× supersampling** (capped so the supersampled
  raster never exceeds 8192 px on a side).
- Fill: `ImageDraw.polygon` per sub-path with the declared fill rule.
- Stroke: centred; `ImageDraw.line(…, joint="curve")` along the flattened outline, round caps as
  discs; dashed = arc-length segments of 3w on / 2w off; dotted = discs every 2w; arrow caps =
  triangles oriented on the end tangent.
- Downsample with `Image.reduce(4)` (box filter — deterministic, no resampler ambiguity).
- Output: straight RGBA + the raster's centre in frame pixels.
- Budget: a 1080p shape raster ≤ 15 ms, 4K ≤ 50 ms (measured properly in EL0 spike A). A rough
  pre-spike on 2026-09-26 (engine Pillow 12.3, Apple Silicon): a translucent, stroked rounded
  "highlight box" 60% × 30% of frame height, 4× supersampled, took **6.9 ms at 1080p and 26.5 ms
  at 4K** — inside the budget before any optimisation.

**Compile:** `_compile_shape_clip` mirrors `_compile_text_clip` with the EL2a pipeline:
`ImageClip(raster, transparent=True)`, `fit_to_frame=False`, centred at the raster's centre plus the
clip's `x`/`y` keyframes, through `_attach_mask` (own alpha × opacity).

**Frame plan:** a new layer kind **`shape`** in both runtimes (JSON-identical): anchor, scale,
rotation, opacity, blend and bounds (EL2b adds mask, transitions, edge styles as for stills).

### 2.3 The monitor draws the engine's pixels

- The existing raster route takes a third kind: `POST /preview/text-raster` with `kind: 'shape'`
  and the shape's params (`service.py` `PreviewTextRasterRequest.kind:
Literal["text","caption","shape"]`; `shared-types` `PreviewTextRasterRequest.kind`). Extending
  the route keeps one cache, one bridge call, one failure mode.
- `engine-text-rasters.ts` keys the cache by what changes pixels (params, frame size) and never by
  transform, so a shape that moves, scales, rotates or fades is not re-rasterised per frame.
- **No engine (browser build):** deferred to EL11 — desktop is product focus #1. When it lands it is
  a canvas `Path2D` raster labelled "Preview approximate" (ADR 0180 decision 4), never silent.

### 2.4 Panel tiles

Inline SVG from a small UI-only TS path helper at tile size — never used for the monitor or export.

### 2.5 Numbered badges (EL5)

A badge is a shape with a `label`: the engine draws the shape, then the label with the title
rasteriser (`text_overlay.rasterize_text_overlay`) centred in the box, fitted to 60% of the box
height, into the same raster. One raster, one layer, one oracle row per badge style.

### 2.6 Icons (EL5)

Lucide icons are `path` shapes with `stroke` style and round caps (03 §1.2). They need nothing the
rasteriser does not already do.

---

## 3. Stickers (EL6a, EL6b)

After EL2a a static sticker is a still through the pipeline; nothing sticker-specific exists in the
renderer. EL6a adds oracle rows (at rest, scaled + rotated, fading). EL6b brings EL2b's edge styles
and masks with their first consumer — the Inspector's Outline and Shadow — plus rows for outline +
shadow and a masked sticker. The "Enlarged beyond its sharp size" hint is computed from the frame
plan's displayed size against the sticker's pixel size at the export resolution — no renderer
change.

---

## 4. Animated stickers (EL10)

### 4.1 Model

`image` asset + `AssetMedia.animation` (schema v26): frame count, per-frame durations, loop length.
An animated sticker **loops from the clip's start** for the clip's length; speed and reverse are not
offered (deferred).

### 4.2 Timing — one function, two runtimes

`animatedFrameIndex(clipLocalSeconds, frameDurationsMs)` → `bisect(cumulative, t mod loop)`, in
`editor-core` and the engine, pinned by `tests/fixtures/frame-plan/animated.json` (frame
boundaries, loop wrap, zero-duration frames treated as the WebP spec says). Durations are not
uniform — Noto's `1f600` holds its first frame 90 ms and the rest 30 ms — so the index is a lookup,
never `t × fps`; Pillow only reports a frame's duration after `seek()` **and** `load()`. The frame
plan's `source.frame` carries the index.

### 4.3 Decode

- **Export:** an `AnimatedImageClip` (a MoviePy `VideoClip` whose frame and mask functions read
  Pillow frames by index). Frames decode lazily into a small LRU at the **displayed** size (bounded
  memory: a 512 × 512 × 48-frame sticker is ≈ 50 MB decoded at full size, ≈ 20 MB at a 324 px
  display). Pillow's libwebp decodes Noto's files today (verified, 00 §4).
- **Monitor:** WebCodecs `ImageDecoder` (`image/webp`) decodes frames to `ImageBitmap`s at the
  displayed size once per load; the same index function picks the frame. Where `ImageDecoder` is
  absent the first frame is shown and the monitor says "Preview approximate". Spike B (EL10.0)
  compares the two decoders frame by frame before any of this is built.
- **Classification:** element stickers are `image` because the catalogue says so. The probe's rule
  that animated containers are video (`media/probe.py:39-40`) is **unchanged** for user imports
  (deferred, 11 §2).

### 4.4 Parity

Both runtimes decode the same file with libwebp. Oracle rows sample an animated sticker at frame
boundaries ±1 ms and across the loop wrap; the gates are the PX4 gates, unchanged.

---

## 5. Animation (EL7)

- **In / Out** are **layer transitions** — the existing `add_layer_transition` op and catalogue
  passes — so, once EL2b lets stills, titles and shapes take transitions, there is nothing new to
  render. **Found in EL7:** on an exit both renderers kept only the kind's reveal mask, which for a
  slide or zoom is the whole frame at once, so a moving exit vanished. A layer's own exit whose
  kind is not in `TRANSITION_EXIT_BY_MASK` now plays its entrance backwards in time (the frame
  plan's `reversed`, `eased` at `1 − p`), in the compiler and the monitor alike (ADR 0192).
- **Loop** is **keyframes**, generated by an `editor-core` builder (`loop-motion.ts`) the way
  `track-follow.ts` plans follow keyframes: pulse, float, wiggle, bounce, spin, blink over the clip's
  span. The transform pipeline already renders keyframed scale, x, y, rotation and opacity for every
  layer kind after EL2a, so there is no new effect type, no evaluator in two runtimes, and no schema
  bump (scope review, change 6). The trade-off — a loop does not follow a later extension of its clip
  until it is re-applied — is stated in the ADR and flagged by the critic.
- **`drawOn`** (a stroke writing itself on) is **deferred** (11 §2). If it returns, the raster
  route's existing time-varying contract (`frame_time` → `animated: true`, which animated styled
  captions use today) carries it with no new mechanism.

---

## 6. Render validation (PRD §9.4)

`validation/render_validation.py` gains two checks, run after every render:

- **Element files present** — every visible sticker clip's file exists and matches its recorded
  size; a missing file is a typed failure naming the sticker, not a black frame.
- **Element layers contribute** — at one sampled frame inside each visible element clip, the
  element's raster has non-zero alpha where the plan says it is (catches a shape that draws nothing
  and a sticker placed entirely off-frame).

---

## 7. Performance

| Surface                                                                       | Budget                                                      | Where measured                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| Monitor, 4K footage + 20 element layers (10 stickers, 10 shapes, 3 animating) | ≤ 1% dropped frames, seek-to-present ≤ 100 ms (PX5 budgets) | `tests/e2e` perf spec, Scale row + elements |
| Shape raster (engine)                                                         | 1080p ≤ 15 ms, 4K ≤ 50 ms                                   | pytest benchmark (non-flaky, median of 20)  |
| Export time with 20 element layers                                            | ≤ 1.3× the same timeline without them                       | PX5.11-style dispatch workflow              |
| Animated sticker decode (monitor)                                             | ≤ 150 ms first frame, no main-thread jank                   | perf spec                                   |

Raster caches follow the text-raster rules (bounded entries, keyed by pixel-affecting params).

**As measured (release-gate review, 2026-09-26).** The monitor row's CI fixture (`scale-elements`)
is 20 stickers, 5 of them turning and 5 outlined, rather than 10 stickers and 10 shapes: a shape
reaches the monitor as an engine raster composited exactly like a sticker's texture, and the
`preview-perf` job runs without the sidecar that draws shape rasters. CI holds the invariants
(every layer drawn, one composite per frame, bounded caches, flat GPU pools) on a software GPU; the
budget itself is run D on an M-series Mac, which should also record peak GPU memory and composite
p95. The export ratio is logged by `px5_export_ratio.py` (`scale-elements` against `scale-plain`)
in CI and measured on real footage in run D. The animated-sticker decode budget belongs to EL10's
Definition of Done and is not claimed while EL10 waits on its licence read.

---

## 8. Oracle rows to add (PX4, `preview-parity-oracle.spec.ts`)

- **EL2a:** `stills/opacity-keyframes`, `stills/fade-in`, `stills/crop-cover`,
  `stills/alpha-times-opacity`, `text/opacity`, `text/in-fade`, `text/in-slide-up`, `text/out-pop`.
- **EL2b:** `stills/mask-ellipse`, `stills/edge-outline`, `stills/zoom-in`, `text/slide-in`.
- **EL4a:** `shapes/highlight-box`, `shapes/marker-over-video`, `shapes/ellipse-rotated`,
  `shapes/arrow-segment`.
- **EL5:** `shapes/box-stroke-dashed`, `shapes/star-knobs`, `shapes/curved-arrow`,
  `shapes/bubble-tail`, `shapes/ring-evenodd`, `shapes/badge-label`, `shapes/icon-stroke`,
  `shapes/blend-multiply`.
- **EL6a:** `stickers/rest`, `stickers/scaled-rotated`, `stickers/fading`.
- **EL6b:** `stickers/outline-shadow`, `stickers/masked`.
- **EL7:** `loop/pulse`, `loop/wiggle`, `stickers/in-pop`, `shapes/out-slide`.
- **EL10:** `stickers/animated-boundaries`, `stickers/animated-loop-wrap`.

Every row is added **passing**; the baseline JSON stays empty (a failing row is a bug, not a
listing).

**Last updated:** 2026-09-26
