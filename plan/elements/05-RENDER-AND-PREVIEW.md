# 05 — Render and preview

The render engine (Python, MoviePy + FFmpeg + Pillow) is the authority; the program monitor (the
layer compositor driven by `framePlanAt`) must show what it will produce. Every change here lands in
**three** places at once — the export compiler, the two frame plans, and the monitor — and is proven
by the PX4 pixel oracle. MoviePy is never used for preview (AGENTS.md §2).

---

## 1. EL2 — Stills and text join the full picture pipeline

### 1.1 What changes

Today (00 §3 G1) a still gets grade + placement and a title gets placement. After EL2 both go
through the same stages as video, in the same order:

| Stage                                 | Video today        | Still today | Text today | After EL2 (all three)                                           |
| ------------------------------------- | ------------------ | ----------- | ---------- | --------------------------------------------------------------- |
| crop                                  | ✓                  | ✗           | n/a        | ✓ (text: n/a)                                                   |
| colour grade / LUT / blur             | ✓                  | ✓           | ✗          | ✓ (text: blur only)                                             |
| mask stack (alpha targets)            | ✓                  | ✗           | ✗          | ✓                                                               |
| opacity keyframes × fade envelope     | ✓ (`_attach_mask`) | ✗           | ✗          | ✓                                                               |
| edge styles (outline / glow / shadow) | ✓                  | ✗           | ✗          | ✓ — reading the layer's **own alpha** when it has no mask stack |
| catalogue transition passes           | ✓                  | ✗           | ✗          | ✓                                                               |
| geometry transitions (zoom / slide)   | ✓                  | ✗           | ✗          | ✓                                                               |
| blend mode                            | ✓                  | ✓           | ✓          | ✓                                                               |

### 1.2 Engine (`render/compiler.py`)

- `_compile_image_clip` becomes the video path minus decoding: `ImageClip(path)` →
  `_apply_crop` → `_apply_color_grade` → masks → `_attach_mask` → edge styles →
  `_apply_catalog_transition` → `_place_video_clip(source, clip, target, transition)`.
- `_compile_text_clip` gains `_attach_mask` (opacity × transition alpha), catalogue transitions and
  edge styles, placed with `fit_to_frame=False` as now.
- **The one real trap: intrinsic alpha.** A PNG/WebP sticker and a text raster already carry an
  alpha mask (`ImageClip(…, transparent=True)`). `_attach_mask` today _replaces_ a clip's mask
  (`with_mask`). For these layers it must **multiply** the existing mask by opacity × transition ×
  mask-stack alpha, or every sticker becomes an opaque square the moment it fades. Unit-tested on a
  half-transparent pixel, and an oracle row (`stills/alpha-times-opacity`).
- Edge styles (`render/edge_styles.py`) read "the clip's alpha-target mask stack". With no stack,
  the cut-out becomes the layer's own alpha ≥ ½ — the same rule, a different source. Stickers ship
  with a transparent margin (03 §3: 12% on each side) so an outline or shadow is not clipped at the
  image edge ("styles draw inside the clip's picture bounds").

### 1.3 Frame plans (`render/frame_plan.py`, `editor-core/src/frame-plan.ts`)

- `_image_layer` / `imageLayer` carry `crop`, `opacity` (`layer_opacity_at`), `mask`,
  `transitions` and `edge_styles` exactly as `_video_layer` does; the geometry honours the crop and
  the transition.
- `_text_layer` / `textLayer` carry `opacity` and `transitions`.
- The docstring's "Quirks of today's export … a still image ignores its crop and opacity keyframes"
  is deleted with the quirk, and `frame-plan.ts:914`'s comment with it.
- `tests/fixtures/frame-plan/*.json` regenerate; the vector tests are the proof the runtimes agree.

### 1.4 Monitor (`preview/engine/layer-compositor.ts`, `layer-preview-engine.ts`)

The compositor already applies opacity, masks, transitions and edge styles to video layers; the
image and text branches (`layer-preview-engine.ts:1010` onward) route through the same passes, with the
same "multiply intrinsic alpha" rule.

### 1.5 Existing projects

A photo or title that already carries an opacity keyframe, a crop or a transition will now **show
and export it** — the control that did nothing starts working. That is a behaviour change, not a
regression; it is listed under **Fixed** in the changelog and in the ADR ("a still is a picture
layer like any other"). Engine golden renders that contain such stills are regenerated in the same
change (AGENTS.md §8: no render change without a golden update).

---

## 2. Shapes (EL4, EL5)

### 2.1 Geometry — one definition per runtime, pinned together

`editor-core/src/shapes/geometry.ts` and `render/shape_geometry.py`:

1. Resolve the frame: box `(x, y, width, height)` or segment `(x1, y1, x2, y2)` → output pixels
   (percent-of-axis for position, percent-of-frame-height for size and stroke, 03 §1.4).
2. Run the generator (rect, ellipse, polygon, star, ring, bubble, corners, line, arrow,
   curved-arrow, path) with the clip's knobs → a path of `M L C Q Z` in output pixels.
3. Flatten curves with the **same** adaptive subdivision and tolerance (¼ px at the supersampled
   scale) in both runtimes; emit polygons (with the fill rule each generator declares — a ring is
   even-odd) and polylines (for strokes and caps).

`tests/fixtures/shapes/geometry.json` — for every catalogue shape and preset, at three frame sizes,
the flattened points to 1e-6 — is read by a vitest and a pytest. The catalogue drift test fails if
a shape exists without vectors.

### 2.2 Raster — the engine draws, everywhere it can

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
  pre-spike on 2026-09-26 (engine Pillow, Apple Silicon): a translucent, stroked rounded
  "highlight box" 60% × 30% of frame height, 4× supersampled, took **6.9 ms at 1080p and 26.5 ms at
  4K** — inside the budget before any optimisation.

**Compile:** `_compile_shape_clip` mirrors `_compile_text_clip` (+ the EL2 pipeline):
`ImageClip(raster, transparent=True)`, `fit_to_frame=False`, centred at the raster's centre plus the
clip's `x`/`y` keyframes.

**Frame plan:** a new layer kind **`shape`** in both runtimes (JSON-identical): anchor, scale,
rotation, opacity, transitions, blend, mask, edge styles, and — unlike text — the exact **bounds**
in frame pixels (shapes have no font metrics, so the plan can carry them; the monitor uses them for
hit-testing and handles).

### 2.3 The monitor draws the engine's pixels

- The existing raster route takes a third kind: `POST /preview/text-raster` with
  `kind: 'shape'` and the shape's params (`service.py` `PreviewTextRasterRequest.kind:
Literal["text","caption","shape"]`; `shared-types` `PreviewTextRasterRequest.kind`). Extending the
  route keeps one cache, one bridge call, one failure mode.
- `engine-text-rasters.ts` keys the cache by what changes pixels (params, frame size) and never by
  transform, so a shape that moves, scales, rotates or fades is not re-rasterised per frame.
- **Browser build / engine unavailable:** `preview/engine/shape-raster.ts` draws the same geometry
  with `Path2D`, `setLineDash` and `lineCap`, and the monitor says "Preview approximate" — ADR 0180
  decision 4, as for titles. Never silent.

### 2.4 Panel tiles

Inline SVG built from the TS geometry at tile size — UI only, never used for the monitor or export.

### 2.5 Numbered badges (EL5)

A badge is a shape with a `label`: the engine draws the shape, then the label with the title
rasteriser (`text_overlay.rasterize_text_overlay`) centred in the box, fitted to 60% of the box
height, into the same raster. One raster, one layer, one oracle row per badge style.

### 2.6 Icons (EL5)

Lucide icons are `path` shapes with `stroke` style and round caps (03 §1.2). They need nothing the
rasteriser does not already do; they add ~1,600 vectors to the geometry fixture (sampled, not all,
to keep the fixture small: every icon's point count and bounds, and full points for 50).

---

## 3. Stickers (EL6)

After EL2 a static sticker is a still through the full pipeline; nothing sticker-specific exists
in the renderer. What EL6 adds:

- Oracle rows: sticker at rest, scaled + rotated, fading in, with outline, with shadow, masked,
  blended (`screen`), over a transition cut.
- The "Enlarged beyond its sharp size" hint is computed from the frame plan's displayed size
  against the sticker's pixel size at the export resolution — no renderer change.

---

## 4. Animated stickers (EL10)

### 4.1 Model

`image` asset + `AssetMedia.animation` (v27): frame count, per-frame durations, loop length. An
animated sticker **loops from the clip's start** for the clip's length; speed and reverse are not
offered (deferred).

### 4.2 Timing — one function, two runtimes

`animatedFrameIndex(clipLocalSeconds, frameDurationsMs)` → `bisect(cumulative, t mod loop)`, in
`editor-core` and the engine, pinned by `tests/fixtures/frame-plan/animated.json` (frame
boundaries, loop wrap, zero-duration frames treated as the WebP spec says). Durations are not
uniform — Noto's `1f600` holds its first frame 90 ms and the rest 30 ms — so the index is a
lookup, never `t × fps`; Pillow only reports a frame's duration after `seek()` **and** `load()`.
The frame plan's
`source.frame` carries the index.

### 4.3 Decode

- **Export:** an `AnimatedImageClip` (a MoviePy `VideoClip` whose frame and mask functions read
  Pillow frames by index). Frames decode lazily into a small LRU at the **displayed** size
  (bounded memory: a 512 × 512 × 48-frame sticker is ≈ 50 MB decoded at full size, ≈ 20 MB at a
  324 px display). Pillow's libwebp decodes Noto's files today (verified, 00 §4).
- **Monitor:** WebCodecs `ImageDecoder` (`image/webp`) decodes frames to `ImageBitmap`s at the
  displayed size once per load; the same index function picks the frame. Where `ImageDecoder` is
  absent the first frame is shown and the monitor says "Preview approximate".
- **Classification:** element stickers are `image` because the catalogue says so. The probe's rule
  that animated containers are video (`media/probe.py:39-40`) is **unchanged** for user imports in
  this programme (deferred, 11 §2).

### 4.4 Parity

Both runtimes decode the same file with libwebp. Oracle rows sample an animated sticker at frame
boundaries ±1 ms and across the loop wrap; the gates are the PX4 gates, unchanged.

---

## 5. Loop motion (EL7)

In and Out are **layer transitions** (existing op, existing catalogue passes) — nothing new to
render once EL2 lands. **Loop** is new: a declarative effect `loop_motion` `{ preset, period,
amount }` evaluated as a transform contribution (scale, x, y, rotation, opacity) in both frame plans
and the compiler, like a transition's geometry contribution. Presets: pulse, breathe, float,
bounce, wiggle, swing, spin, blink, heartbeat, shake. Pinned by
`tests/fixtures/frame-plan/loop-motion.json`. It composes _after_ keyframes and _before_ the
transition envelope, the order a transition's geometry already composes in.

`drawOn` (stroke write-on for arrows, underlines, circles) is an effect-param keyframe on the shape
effect. The raster route already serves rasters that change with time: since the 2026-09-25
caption amendment it takes `frame_time` and answers `animated: true`, and the monitor re-requests
such rasters per frame (styled, animated captions ride this today). A shape with a `drawOn`
keyframe uses the same contract — no new mechanism. EL0 spike A measures whether the per-frame
round trip holds the PX5 budget for a stroked shape; if it does not, the monitor draws `drawOn`
from the engine's full raster with a dash-offset mask computed from the same arc-length table, and
the oracle proves it.

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

---

## 8. Oracle rows to add (PX4, `preview-parity-oracle.spec.ts`)

EL2: `stills/opacity-keyframes`, `stills/fade-in`, `stills/zoom-in`, `stills/crop`,
`stills/mask-ellipse`, `stills/alpha-times-opacity`, `stills/edge-outline`, `text/opacity`,
`text/fade-in`, `text/slide-in`.
EL4/EL5: `shapes/box-fill`, `shapes/box-stroke-dashed`, `shapes/ellipse-rotated`,
`shapes/star-knobs`, `shapes/arrow-segment`, `shapes/curved-arrow`, `shapes/bubble-tail`,
`shapes/ring-evenodd`, `shapes/highlight-translucent-over-video`, `shapes/badge-label`,
`shapes/icon-stroke`, `shapes/blend-multiply`.
EL6: `stickers/rest`, `stickers/scaled-rotated`, `stickers/outline-shadow`, `stickers/masked`,
`stickers/over-transition`.
EL7: `loop/pulse`, `loop/wiggle`, `shapes/draw-on`.
EL10: `stickers/animated-boundaries`, `stickers/animated-loop-wrap`.

Every row is added **passing**; the baseline JSON stays empty (a failing row is a bug, not a listing).

**Last updated:** 2026-09-26
