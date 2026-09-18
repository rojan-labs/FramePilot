# Masks on the program monitor

How the desktop program monitor draws a clip's mask stack, why it matches the export byte for
byte, and how to change it without breaking that. Decision record: ADR 0178 (MK3 amendment).

## What draws what

| Piece                                                                            | File                                                         | Mirrors                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Shape rasteriser (flatten, Q16.16 coverage, distance feather, combine, quantise) | `apps/web-editor/src/preview/masks/mask-raster.ts`           | `engine/python/framepilot_engine/render/mask_raster.py`   |
| `gaussian-legacy` masks (Pillow draw + `GaussianBlur`)                           | `preview/masks/legacy-mask.ts`                               | `render/masks.py#rasterize_mask`                          |
| Stack evaluation (source clock, crop, legacy spec, refusals, raster cache)       | `preview/masks/mask-stack.ts`                                | `render/mask_stack.py`                                    |
| GPU pass (alpha cut, effect-target mix, debug views)                             | `preview/engine/layer-compositor.ts`, `gl/raster-shaders.ts` | `compiler.py#_attach_mask`, `_masked_effect`              |
| Frame-space stacks on an adjustment lane (MK5.2)                                 | `preview/masks/frame-masks.ts`                               | `render/frame_masks.py`                                   |
| Adjustment-lane mask mix (any catalog kind, in the finish pass)                  | `preview/engine/gl/frame-effects.ts`                         | `render/frame_effects.py#apply_layer_to_frame`            |
| Legacy canvas and DOM monitors                                                   | `preview/masks/mask-canvas.ts`                               | the same raster, scaled by the browser (approximate edge) |

The compositor rasterises a stack at the cropped picture's decoded size, the size the export
attaches the mask at, then uploads it as an 8-bit texture. Static stacks are cached by the clip's
semantic identity and size; animated ones by source time.

An **adjustment lane's** mask is a different owner with the same pixels (MK5.2). It has no asset,
no crop and no speed, so its geometry is output-frame pixels mapped by the identity and its clock
is seconds from the layer's `start` (`space: 'frame'`). Both sides reach the shared evaluator
through a stand-in owner whose "media size" is the frame itself, so the rasteriser, the combine
modes and the single quantisation are the same code the clip path runs. The alpha then mixes the
layer's fully-affected frame back toward the untouched one — after the intensity mix and before
the clip, on both sides — which is what limits any of the 40 catalog render kinds to a region.
`tests/fixtures/mask-raster/frame-layers.json` pins the two implementations float64-byte-exact,
and the `effects/effect-kinds-masked` oracle case exercises every kind with a mask in CI.

## Split, mirror band and gradient (MK8.1)

The analytic kinds are a distance to a line or a centre, so they need no path, no flattening and
no coverage sweep. `analytic_alpha` (`render/mask_raster.py`) and `analyticAlpha`
(`preview/masks/mask-raster.ts`) evaluate them per pixel centre with the same expressions in the
same order, under the same determinism rules as the shapes (float64, elementwise, `sqrt` only,
the shipped falloff table):

- **Mapping.** Geometry is in source pixels like every mask; the origin (or start/end) maps
  through the clip's crop onto the raster, and the line's normal is taken in RASTER space
  (`(-sin·scaleY, cos·scaleX)`, normalised once), so an unevenly scaled raster still gets a
  straight edge at the right place. Lengths scale by `min(scaleX, scaleY)` like a shape's
  feathers.
- **Split (`linear`).** Keeps the side on the LEFT of the line's direction of travel (angle 0 =
  left to right, keeps the part above). A hard edge is the **exact area** of the pixel square on
  the kept side: projected onto the unit normal, the square is two uniform widths `|nx|` and
  `|ny|`, whose sum has a trapezoid CDF (`_footprint_cdf`: `+ - * /` only). Expansion shifts the
  line; softness joins each feather side by half (`w_i + s/2`, `w_o + s/2`) and the soft edge is
  the shapes' distance feather.
- **Mirror band (`band`).** `widthPx` centred on the line; the hard band is the difference of two
  exact half-plane areas, and a soft one feathers `|t| - width/2`.
- **Gradient.** Opaque at the start, clear at the end: linear projects the pixel centre onto the
  start→end axis, radial measures the distance from the start (in SOURCE units, so it stays round
  when the raster is scaled unevenly) over the start–end length; either goes through the `curve`
  falloff. A gradient has no edge, so expansion and feathers on one are refused (validator,
  export and monitor), and one with no length draws nothing.

A hard split or band is certified against exact polygon clipping (error ≤ 1e-9) and a 256×256
supersampled reference (≤ 1/255) in `test_mask_raster_vectors.py`; the soft split against the
analytic distance feather (≤ 1/255).

## Track mattes and text as a mask (MK8.2)

A `layer` mask cuts a clip by another picture. The source — one clip, or every picture on a track
— is marked `matteOnly` in the frame plan on both sides and is never composited itself; it is
rendered only for the matte:

| Step                                                                  | Engine (`render/layer_mattes.py`, `compiler.py`)                                         | Monitor                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Which layers are the source                                           | `layer_matte_sources` in `frame_plan.py`; the compile hands them to `LayerMatteResolver` | `withTrackMattes` (`engine/track-mattes.ts`) takes them out of the frame's layer list   |
| The source frame                                                      | `CompositeVideoClip(layers, size)`, no background: straight RGB + alpha                  | `matteSourceFrame`: the same layers, the same passes, composited on a transparent frame |
| Where the clip's pixels land                                          | `picture_placement_at` (MoviePy's truncated resize and paste, PIL's rotation)            | the layer's own raster step (`resize`, `rotation`, `x`, `y`)                            |
| Channel at the landed pixel (nearest), inverted after sampling        | `sampled_channel`                                                                        | `MASK_LAYER_FRAGMENT` (`masks/layer-mattes.ts`)                                         |
| Finesse, then invert and opacity; combined in the stack like any mask | `apply_finesse` → `layer_alpha`                                                          | the key's finesse passes and tail (`gl/alpha-passes.ts`)                                |

The CPU mapping is byte-exact: `layerMatteAlpha` reproduces the engine's float64 channel on every
placement and channel of `tests/fixtures/mask-raster/layer.json` (identity, offset off the frame,
up- and down-scaled, rotated 30° and 90°). The shader is float32, so the monitor's track mattes are
judged by the PX4 oracle's `alpha/layer-*` rows at the unchanged gates. A track matte whose source
has its own track matte is followed (four levels; loops are refused by the validator and the
export). The DOM fallback monitor draws a track-matted clip uncut, as it does a key: the layer
compositor is the path.

## The key mask, and why its gate is 1/255

Every other kind is rastered from geometry on the CPU, identically on both sides. A `key` is not:
it reads the PICTURE, so its alpha changes every frame, the raster cache buys nothing, and a
per-frame read-back of a 4K picture into JavaScript would cost more than the whole composite. The
preview therefore runs the qualifier as a fragment shader over the decoded RGB the compositor
already holds — RGB that PX2.7 produced with the export's own colour matrix and range, which is
what makes both sides qualify the same numbers.

A fragment shader is float32 with no control over the order inside a `length()` or a division, so
byte-equality is not available. Every formula is written to be evaluated the same way in both
languages — polynomials, one `sqrt`, no tables, no `pow` — and the residual is float32 rounding.
The plan's gate is therefore **engine vs preview keyed alpha ≤ 1/255 on colour charts in BT.601
and BT.709, full and limited range** (`06`), measured two ways:

| Where                                     | What it measures                 | How                                                                                          |
| ----------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `preview/masks/key-mask.test.ts`          | the CPU twin the eyedropper uses | float64, against `tests/fixtures/mask-key/charts.json` — **exact**, not within 1/255         |
| `tests/e2e/specs/mask-key-parity.spec.ts` | the shader the monitor runs      | the shipped GLSL on a real GPU, read back through the same quantise pass the compositor uses |

The charts are not arbitrary RGB. Each patch was taken to Y'CbCr in that encoding, quantised to
8 bits as a decoded frame is, and brought back — so they are colours that actually come out of a
decoder, including the ones limited range cannot represent.

A stack that holds a key is combined on the GPU (one float accumulator, quantised once at the
end, as `stack_alpha` quantises once) into `R8UI`, which is the format an uploaded CPU raster
lands in — so the alpha cut, the effect mix and the debug views never learn where the coverage
came from. Stacks without a key keep the byte-exact CPU path untouched.

**Whole frames with a key** are judged by the PX4 oracle's `alpha/key-*` rows (PX5.6): a key
alone (and one that despills), a key intersected and subtracted with shapes, and a key through
the whole finesse chain at partial opacity, at the unchanged 40 dB / 99.5 % gates. Until then no
row carried a key, which is how a key drawn with the wrong GPU program (MK6.1 to PX5.3) went
unseen. The source they key is a picture made by numpy (`key_picture` in
`engine/python/tests/px4_parity_frames.py`: a green backdrop, a soft-edged subject, holes,
specks and a green-to-red sweep), stored as a lossless PNG and encoded like every other asset,
so both sides key the same decoded pixels.

**What a key costs the monitor, unmeasured so far:** the qualifier is one pass, but the finesse
chain is not — morph open and close are two disc passes each, shrink/grow one, and the blur is
six separable box passes. Each writes a float target the size of the frame, and `GlResources`
pools them by size, so a key with the whole chain holds on the order of a dozen `RGBA32F` targets
(≈ 8 MB each at 1080p, ≈ 33 MB at 4K) for as long as it is on screen. The pool does not grow past
that, and a key without finesse costs one pass. No playback budget has been measured for this
path; PX5 owns that number.

**The one asymmetry, recorded rather than hidden:** a key's finesse morphology runs as shader
passes, and a disc of radius `r` costs `(2r+1)²` fetches, so the pass is bounded at 16 px (1089
fetches at the limit). Above that the monitor refuses with a remedy while the export renders any
radius. Whether real footage ever asks for more than 16 px has not been measured; the cap is a
stated limit, not a justified one. A matte's finesse runs on the CPU on both sides and is
byte-exact at any radius.

## Why it is byte-exact, and the rules that keep it so

The TypeScript follows the engine's determinism rules: float64 only, plain indexed loops, integer
Q16.16 accumulation, the same flattening recursion order, the shipped gaussian falloff table, no
`Math.hypot`/`exp`/`pow` per pixel, round-half-even quantisation, and every expression written in
the engine's evaluation order. Do not "simplify" an expression: `a + (b - a) * t` and
`a * (1 - t) + b * t` differ in the last bit.

The legacy port emulates Pillow's C `float` arithmetic with `Math.fround`. Pillow's macOS arm64
wheels fuse multiply-add, so `setPillowFloatContraction` follows the host (set from client hints
at engine start). Both modes are tested.

## Vectors

| File                                                                     | Asserted by                            |
| ------------------------------------------------------------------------ | -------------------------------------- |
| `tests/fixtures/mask-raster/{coverage,feather,analytic,stack}.json`      | `mask-raster.test.ts` (and the engine) |
| `tests/fixtures/mask-raster/legacy.json`                                 | `legacy-mask.test.ts`                  |
| `tests/fixtures/mask-raster/stack-clips.json` (SHA-256 of float64 alpha) | `mask-stack.test.ts`                   |
| `tests/fixtures/mask-raster/layer.json` (track matte mapping, MK8.2)     | `layer-mattes.test.ts`                 |

Regenerate after a deliberate engine change with `pnpm mask-raster:vectors`; the engine's
`test_mask_raster_vectors.py` and `test_mask_stack_vectors.py` fail when the stored files drift.
CI runs the TypeScript vectors in `node-quality` (Linux) and in `mask-raster-vectors` on macOS
arm64 and Windows x64. Pixel parity of whole frames is the PX4 oracle's `alpha/mask-*` rows.

## What the monitor refuses

Matte finesse other than clean black/white is refused like the export (MK6). A matte artifact the
export would refuse (missing file, a `frames.json` whose digest differs, a size or frame count that
does not match, a matte frame whose pts is not the picture's) draws the clip unmasked with the
export's own remedy sentence as the tooltip.

Kinds and settings the export refuses before rendering are refused on the monitor too, never
drawn approximately and never silently skipped: a gradient or a track matte with expansion or
feather set, tracked masks (MK7), frame-space masks (MK9), plus project problems the
export also rejects (media never measured, an effect target that is not on the clip). The clip is
drawn unmasked and the monitor shows "Mask not previewed yet" with the reason as its tooltip.

## Mask views

With a masked clip selected, the monitor header shows **Mask view**: Off, Overlay (the whole
picture, what the mask removes tinted in the mask colour), Mask only (the stack alpha in grey) and
Checkerboard (the clip alone, cut out, over a checkerboard), and Flagged (BR5.2: the overlay tinted
red and outlined on a frame that needs review, grey otherwise). Flagged frames come from the
artifact's `report.json` (read once, checked against the digest the mask pins; frames not verified
become ranges) plus the mask's own `review.flagged` ranges, minus `review.approved`. Views only
change the monitor; exports and the oracle never see them.

## Mattes (BR5)

A `matte` layer is drawn from its artifact (`<project folder>/.framepilot-derived/mattes/<key>/`,
read over `fp-media` on the desktop) in the same pass as every other kind:

- **Frame identity.** The matte frame is the one whose source frame is the picture's decoded
  source frame (`frames.json` `firstFrame` + index), exactly as `render/mattes.py` binds it; a
  speed ramp, reverse or VFR source changes the picture's frame and the matte follows. A frame
  outside the artifact is _unprocessed_: the layer is left out (as if disabled), the monitor says
  "Processing background removal", and no neighbouring frame is ever used. A frame whose pts does
  not belong to the picture's timestamp is refused as misaligned.
- **Math.** `masks/matte-edges.ts` ports `render/matte_edges.py` operation for operation: disc
  morphology for edge shift, clean levels (`edgeMode: 'sharp'` = 0.25/0.75), the distance feather
  on the matte's own 50 % contour, swscale's bicubic (B = 0, C = 0.6) to the size the picture was
  decoded at, the integer crop, then invert/opacity/mode. Decontamination runs after the crop and
  before effects (`rint` to bytes, like the export).
  `tests/fixtures/mask-raster/matte-clips.json` pins every float64 digest; `matte-edges.test.ts`
  asserts them.
- **Where it runs (PX5.3).** The monitor draws a matte with GPU passes
  (`preview/engine/gl/matte-pass.ts`, `matte-shaders.ts`), not that float64 twin: at 4K the twin
  cost 452 ms of main thread per composite and the monitor presented one frame in 20 seconds.
  The passes run the export's chain in the export's order - the decoded samples uploaded as the
  integers they are, edge shift, the finesse group (the SAME passes a key runs,
  `gl/alpha-passes.ts`), the distance feather, the bicubic with the engine's own float64-
  normalised taps, the crop, invert and opacity - into the stack's float accumulator, quantised
  once. A chain that reads no neighbour (clean levels and in/out ratio only: `edgeMode: 'sharp'`
  and the defaults) is applied per tap inside the horizontal resample, so no 4K float plane
  exists. float32 cannot be byte-equal to float64, so the PX4 oracle judges the result at its
  unchanged gates. A radius past a shader loop's bound, a plane past the GPU's texture limit or a
  GPU without float targets draws that layer with the float64 twin instead, so nothing is refused
  or clipped; the telemetry says which ran (`matteStack` vs `maskRaster`).
- **Monitor tier (PX5.3).** Decontamination needs only the band weight and the band-premultiplied
  foreground resampled to the picture's decoded size - and those depend on nothing the user can
  change on the mask. `render/matte_tier.py` makes them once, with the engine's own resample,
  into `.framepilot-derived/matte-tiers/<key>/` (beside the artifact, never in it: the artifact
  holds exactly what the host verified). `tier.json` names the masters' digests; the monitor uses
  a tier only when they equal the digests its mask pins and only where the picture was decoded at
  the tier's size, and decodes the foreground master everywhere else. Values are the float64
  resample rounded to 16 bits (at most half a step: 1/131070 of the weight, 1/514 of a colour
  level; no byte moves more than one level), stored as byte planes in one intra-only FFV1 frame.
  At 960x540 it decodes in 14.5 ms against 38.5 ms for the 4K foreground it replaces, and uploads
  4 MB instead of 25 MB. **Who makes it:** the PX5 Scale fixture and the PX4 oracle generator
  call `write_monitor_tier`; the desktop app does not yet (it needs a sidecar route and a host
  call after an artifact commits, which changes the sidecar contract and waits for the
  maintainer - see ADR 0181). Without a tier the monitor decodes the masters, correctly, slower.
- **Decoding: lossless masters, not the VP9 previews.** The pack also writes `preview.webm` and
  `foreground.preview.webm` (VP9, 540p by default, CRF 34). Measured against the export's
  composite on a hard-edged 1080p matte with one-pixel strands, the 540p VP9 matte gives 32.44 dB
  PSNR and 98.34 % of pixels within 8/255, below the oracle's 40 dB / 99.5 % gates (a smooth 64 px
  ramp passes at 69 dB, which is why a soft synthetic matte would hide the loss). Chromium also has
  no WebM demuxer or FFV1 decoder. So the monitor decodes `matte.mkv` and `foreground.mkv` itself:
  a Matroska index (`decode/matroska-demuxer.ts`, range reads, Cues or a cluster walk) and a port of
  FFmpeg's FFV1 decoder (`decode/ffv1/`), byte-exact against ffmpeg on the fixtures in
  `tests/fixtures/matte-ffv1` (v3/v4, Golomb and range coders, slices, CRCs, non-key frames).
  Matroska carries an FFV1 track either natively (`V_FFV1`) or wrapped in a Video-for-Windows
  header (`V_MS/VFW/FOURCC`, the FourCC then naming the codec and the global header following the
  `BITMAPINFOHEADER`) — which one is the muxer's choice, and FFmpeg only gained the native CodecID
  recently, so the same `ffv1` encode differs between ffmpeg versions. The export's reader is
  ffmpeg, which takes both, so the demuxer takes both; the checked-in fixtures are native, so only
  the oracle (whose artifacts CI's own ffmpeg writes) caught it. They decode on their own workers
  (PX5.3, `decode/matte-decode-pool.ts`: half the cores, one to four), never in the picture
  decoders' worker. An intra-only file (the pack's) is decoded frame-parallel and opened on every
  worker when it loads; each worker is given one frame at a time, the nearest one wanted
  (`MatteSource.want`), and a frame the playhead has passed is dropped while it waits (never counted
  as a failure). With Cues on every frame the index reads only the Cues; a frame's block header is
  parsed when the frame is read. Decoded frames share the engine's byte-bounded picture cache. Cost
  on an M1 Pro (node, the Scale row's 4K masters): a matte frame 17 ms and a flat-colour RGB
  foreground 37 ms since PX5.3 copies FFV1 runs and rows in blocks (32 and 72 ms before; camera
  footage costs more, FFV1 cost follows entropy); playback holds the previous picture when a matte
  frame is late, as it does for pictures.
- **Digests.** `frames.json` and `report.json` are hashed before parsing. The masters are not
  re-hashed by the monitor (a 4K foreground is gigabytes); desktop project-media validation and the
  export check them, and the monitor still checks their size, pixel format and frame count.
- **Oracle.** The PX4 `alpha/matte-*` rows: text behind subject, edge modes with edge shift,
  decontaminate on/off, matte × shape stack and an effect-target matte, speed ramp and reverse, VFR,
  rotated/anamorphic display space, and a progressive artifact (the preview reads a truncated copy;
  a sample past it is exported with the matte disabled). All eight pass at the unchanged gates:
  seven are bit-identical to the export (PSNR inf, 100 % within 8/255, no sentinel disagreement,
  presented source pts equal to the frame plan) and text-behind-subject is 53.68 dB / 100 %, the
  residual being its burned text raster. Numbers and the run:
  [`plan/background-removal-ai/PX4-BASELINE.md`](../../plan/background-removal-ai/PX4-BASELINE.md).
  A far-off sample records `debugPresentedMattes()` — per matte layer, the source frame asked for,
  the artifact's loaded range, and `ready` / `unprocessed` / `refused` with its code — because
  pixels alone cannot tell a refused artifact from one still being processed.
