# Mask rasteriser vectors (MK2.3)

Byte-exact expected alpha for the deterministic mask rasteriser
(`engine/python/framepilot_engine/render/mask_raster.py`), written by
`engine/python/tests/mask_raster_vectors.py` (`pnpm mask-raster:vectors`). Never edit by hand.

| file            | covers                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coverage.json` | hard shapes: exact Q16.16 area coverage (rectangles, roundness, rotation, ellipses, curved/concave/self-crossing paths, subpixel, off-frame, degenerate) |
| `feather.json`  | distance feather: inner/outer, the three falloffs, expansion, per-vertex feather                                                                         |
| `analytic.json` | MK8.1 split, mirror band and gradient (linear/radial): exact hard edges at any angle, softness, expansion, feathers, curves, stacks with shapes          |
| `stack.json`    | the six combine modes, a subtract-first stack, invert + opacity, three layers                                                                            |

Each case holds layers in source units of a 96x72 source (format in the generator's docstring)
and `expected[]`: base64 uint8 alpha, rows top to bottom, at 64x48, 40x30 and 23x17. The gaussian
falloff table both implementations read is
`engine/python/framepilot_engine/render/mask_falloff_gaussian.json` (float64 LE, base64).

`test_mask_raster_vectors.py` requires the engine to reproduce every byte (CI: Linux x64,
macOS arm64, Windows x64), and certifies coverage within 1/255 of a 256x256 supersampled
nonzero reference on every coverage case (and of exact clipping on the simple ones). Pixels
where a path crosses or overlaps itself use the exact per-cell slab sweep
(`exact_cell_coverage`), which the TypeScript preview rasteriser (MK3.1) must mirror.
