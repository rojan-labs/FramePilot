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

Kinds and settings the export refuses before rendering are refused on the monitor too, never
drawn approximately and never silently skipped: `matte` (BR5), `key` (MK6), `linear`/`band`/
`gradient`/`layer` (MK8), tracked masks (MK7), frame-space masks (MK9), plus project problems the
export also rejects (media never measured, an effect target that is not on the clip). The clip is
drawn unmasked and the monitor shows "Mask not previewed yet" with the reason as its tooltip.

## Mask views

With a masked clip selected, the monitor header shows **Mask view**: Off, Overlay (the whole
picture, what the mask removes tinted in the mask colour), Mask only (the stack alpha in grey) and
Checkerboard (the clip alone, cut out, over a checkerboard). Views only change the monitor; exports
and the oracle never see them.
