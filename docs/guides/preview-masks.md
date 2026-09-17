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
| Legacy canvas and DOM monitors                                                   | `preview/masks/mask-canvas.ts`                               | the same raster, scaled by the browser (approximate edge) |

The compositor rasterises a stack at the cropped picture's decoded size, the size the export
attaches the mask at, then uploads it as an 8-bit texture. Static stacks are cached by the clip's
semantic identity and size; animated ones by source time.

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
| `tests/fixtures/mask-raster/{coverage,feather,stack}.json`               | `mask-raster.test.ts` (and the engine) |
| `tests/fixtures/mask-raster/legacy.json`                                 | `legacy-mask.test.ts`                  |
| `tests/fixtures/mask-raster/stack-clips.json` (SHA-256 of float64 alpha) | `mask-stack.test.ts`                   |

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
drawn approximately and never silently skipped: `key` (MK6), `linear`/`band`/
`gradient`/`layer` (MK8), tracked masks (MK7), frame-space masks (MK9), plus project problems the
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
  before effects, on a CPU read-back of the cropped picture (float64 `rint`, like the export).
  `tests/fixtures/mask-raster/matte-clips.json` pins every float64 digest; `matte-edges.test.ts`
  asserts them.
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
  the oracle (whose artifacts CI's own ffmpeg writes) caught it. They
  run in the shared decode worker under the picture decoder pool, and decoded frames share the
  engine's byte-bounded picture cache. Cost: about 7 ms for a 1080p matte frame and 160 ms for a
  1080p RGB foreground frame on an M-series CPU (node); playback holds the previous picture when a
  matte frame is late, as it does for pictures.
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
