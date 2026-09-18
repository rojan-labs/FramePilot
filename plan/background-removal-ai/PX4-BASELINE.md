# PX4 baseline — the parity oracle against today's preview

> Task PX4.3 of [`07-TASKS-AND-EVIDENCE.md`](./07-TASKS-AND-EVIDENCE.md); oracle spec in
> [`09-PREVIEW-EXPORT-PARITY.md`](./09-PREVIEW-EXPORT-PARITY.md) ("PX4 — the pixel parity oracle").

**Source:** CI only. Workflow `CI`, job `preview-parity-oracle`, run
[35353756815](https://github.com/rojan-labs/FramePilot/actions/runs/35353756815) at `5a0c795a`
(Google Chrome, ubuntu-latest, SwiftShader CPU GL), artifact `preview-parity-results`. This file and
`tests/e2e/fixtures/preview-parity-baseline.json` were generated from that artifact with
`node tests/e2e/scripts/px4-baseline.mjs [--write-baseline]`. Nothing here was run locally: a local
full run exhausted a workstation's memory, and the harness documents that it is CI-only. The
first baseline (run 35140382484 at `700f4e7d`, today's preview before PX2) listed 42 failing
cases; the layer compositor (PX2) brought it to 2, the exact mask stack pass (MK3) to 1, and the
matte pass (BR5) to none. MK5.2 added `effects/effect-kinds-masked` — every catalog render kind
limited by a frame-space mask — and it landed passing (249/249 checks in run 35295665259), above
the unmasked case it mirrors.

**Gates (unchanged from 09, tightened only):** PSNR ≥ 40 dB whole frame; max per-channel error ≤
8/255 on ≥ 99.5% of pixels; sentinel layer colours exact (same visible set, no pixel that is solidly
one layer in both frames showing a different layer); presented source pts per picture layer ==
frame plan, back to front. A timeline the desktop monitor routes to the DOM `PreviewPlayer` is a
`renderer: DOM` failure and is not read back (its other checks fail with that reason).

**How CI stays honest:** every failing check below is a `test.fail()` in
`preview-parity-oracle.spec.ts`, keyed off the baseline JSON. A listed check that starts passing
fails the job ("expected to fail, but passed"), so the list can only shrink as PX2 lands; a check
that newly fails is not listed and fails the job.

## Summary

- **68 cases. All 68 pass every check** (renderer, pixels, sentinel and pts). Every case renders on
  the layer compositor; no case is routed to the DOM player (ADR 0180). The baseline JSON's `cases`
  map is empty, so any newly failing check fails the job. PX5.10 regenerated this file, the JSON
  and the PX0 inventory's pixel column from run 35353756815: the nine rows added since the last
  regeneration now show as measured — PX5.6's `alpha/key-alone` (73.66 dB: the despill sample),
  `key-shape-stack` and `key-finesse` (inf), MK8.1's `analytic-split-band` and `analytic-gradient`
  (inf), MK8.2's `layer-text-alpha` and `layer-luma-channels` (inf) and `layer-transformed-target`
  (95.39 dB) — and `matte-decontaminate` reads 97.78 dB (it draws from its monitor tier since
  PX5.3; inf when it drew from the masters).
- **The eight matte rows pass (BR5).** `alpha/matte-edge-modes`, `matte-decontaminate`,
  `matte-shape-stack`, `matte-speed`, `matte-vfr`, `matte-display-space` and `matte-progressive`
  are bit-identical to the export: PSNR inf, 100% within 8/255, 0 sentinel disagreements, presented
  source pts equal to the frame plan. `alpha/matte-text-behind-subject` is 53.68 dB and 100% within
  8/255 at every sample — the residual is the burned text raster, not the matte, and it is the same
  order as the other text rows.
  - `matte-progressive` samples both sides of the boundary: at t=0.5 the preview's truncated copy
    holds the frame and draws it exactly; at t=3.0 it does not, so the layer is left out and the
    monitor says the range is still processing — which is what the export renders for that sample
    (the matte disabled), hence inf there too.
  - What was wrong: every artifact refused to open with `matte_unreadable`. The artifacts are
    encoded in CI by the runner's ffmpeg, which writes an `ffv1` track as `V_MS/VFW/FOURCC` rather
    than the native `V_FFV1` CodecID a newer ffmpeg writes; the checked-in decoder fixtures came
    from a newer ffmpeg, so only the oracle saw it (BR5.5).
- **Mask rows pass bit-identically (MK3):** `alpha/mask-shapes` (was 10.21 dB), `alpha/mask-modes`,
  `alpha/mask-edges`, `alpha/mask-effect-target` and `alpha/mask-legacy`: every sample PSNR inf,
  100% within 8/255, 0 sentinel disagreements.
- **Text rows pass** (`text-only`, `text-transform`, `caption-track-order` were 37.0-39.8 dB): on
  the desktop the monitor draws text and captions from the engine's own Pillow rasters
  (`POST /preview/text-raster` through the bridge; the oracle starts a sidecar and stands in for
  the bridge method). Without an engine the canvas fallback is used and the monitor says
  "Preview text approximate".
- **PX0.3 colour:** the compositor's shader path (canvas2d column) max error 0 for all four
  encodings. The harness's separate Chromium `VideoFrame`->WebGL texture measurement stays at 9/255
  for BT.709 limited range (listed as `colour.bt709-limited: [webgl]`, the one entry left in the
  baseline); the compositor does not use that path.

## Per case

| Case                                     | Renderer  | Samples | Min PSNR (dB) | Min % within 8/255 | Failing checks | First failure per check |
| ---------------------------------------- | --------- | ------- | ------------- | ------------------ | -------------- | ----------------------- |
| `alpha/analytic-gradient`                | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/analytic-split-band`              | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `alpha/key-alone`                        | WebCodecs | 2       | 73.66         | 100.000            | none           |                         |
| `alpha/key-finesse`                      | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `alpha/key-shape-stack`                  | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `alpha/layer-luma-channels`              | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/layer-text-alpha`                 | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `alpha/layer-transformed-target`         | WebCodecs | 2       | 95.39         | 100.000            | none           |                         |
| `alpha/mask-edges`                       | WebCodecs | 4       | inf           | 100.000            | none           |                         |
| `alpha/mask-effect-target`               | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `alpha/mask-legacy`                      | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `alpha/mask-modes`                       | WebCodecs | 6       | inf           | 100.000            | none           |                         |
| `alpha/mask-shapes`                      | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/matte-decontaminate`              | WebCodecs | 2       | 97.78         | 100.000            | none           |                         |
| `alpha/matte-display-space`              | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/matte-edge-modes`                 | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/matte-progressive`                | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/matte-shape-stack`                | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/matte-speed`                      | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `alpha/matte-text-behind-subject`        | WebCodecs | 3       | 53.68         | 100.000            | none           |                         |
| `alpha/matte-vfr`                        | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `alpha/opacity-keyframes`                | WebCodecs | 3       | 71.94         | 100.000            | none           |                         |
| `colour/blend-modes`                     | WebCodecs | 11      | 75.31         | 100.000            | none           |                         |
| `colour/grade`                           | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `colour/lut`                             | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `effects/effect-kinds`                   | WebCodecs | 41      | 60.19         | 100.000            | none           |                         |
| `effects/effect-kinds-masked`            | WebCodecs | 41      | 68.52         | 100.000            | none           |                         |
| `effects/effect-layer-between`           | WebCodecs | 1       | 64.77         | 100.000            | none           |                         |
| `geometry/anamorphic-pixel-aspect`       | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `geometry/crop`                          | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `geometry/fit-landscape-in-portrait`     | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `geometry/fit-mixed-aspects`             | WebCodecs | 3       | 78.25         | 100.000            | none           |                         |
| `geometry/fit-portrait-in-landscape`     | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `geometry/image-png`                     | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `geometry/rotated-anamorphic`            | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `geometry/rotation-metadata`             | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `geometry/transform-keyframes`           | WebCodecs | 5       | 79.11         | 100.000            | none           |                         |
| `layering/gaps-between-layers`           | WebCodecs | 6       | inf           | 100.000            | none           |                         |
| `layering/hidden-track`                  | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `layering/layers-1`                      | WebCodecs | 4       | inf           | 100.000            | none           |                         |
| `layering/layers-2`                      | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `layering/layers-3`                      | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `layering/layers-5`                      | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `layering/same-asset-stack`              | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `layering/unproxied-original`            | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `text/caption-track-order`               | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `text/captions-burn-off`                 | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `text/text-above`                        | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `text/text-below`                        | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `text/text-between`                      | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `text/text-only`                         | WebCodecs | 1       | inf           | 100.000            | none           |                         |
| `text/text-transform`                    | WebCodecs | 3       | 101.09        | 100.000            | none           |                         |
| `time/mixed-frame-rates`                 | WebCodecs | 3       | 88.52         | 100.000            | none           |                         |
| `time/reverse-1x`                        | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `time/reverse-2x`                        | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `time/speed-0.25x`                       | WebCodecs | 4       | inf           | 100.000            | none           |                         |
| `time/speed-0.5x`                        | WebCodecs | 4       | inf           | 100.000            | none           |                         |
| `time/speed-2x`                          | WebCodecs | 4       | inf           | 100.000            | none           |                         |
| `time/speed-4x`                          | WebCodecs | 4       | inf           | 100.000            | none           |                         |
| `time/speed-freeze`                      | WebCodecs | 2       | inf           | 100.000            | none           |                         |
| `time/speed-ramp`                        | WebCodecs | 3       | inf           | 100.000            | none           |                         |
| `time/trims-non-keyframe`                | WebCodecs | 4       | inf           | 100.000            | none           |                         |
| `time/variable-frame-rate`               | WebCodecs | 5       | 78.39         | 100.000            | none           |                         |
| `transitions/transitions-alignment`      | WebCodecs | 8       | 75.45         | 100.000            | none           |                         |
| `transitions/transitions-catalog`        | WebCodecs | 28      | 59.91         | 99.922             | none           |                         |
| `transitions/transitions-legacy`         | WebCodecs | 7       | 75.42         | 100.000            | none           |                         |
| `transitions/transitions-over-stack`     | WebCodecs | 3       | 76.65         | 100.000            | none           |                         |
| `transitions/transitions-underlay-edges` | WebCodecs | 2       | 75.10         | 100.000            | none           |                         |

## PX0.3 colour patches

| Encoding      | Patch                 | Authored      | Engine              | Preview canvas2d    | WebGL texture                                                                                                                                                                                       | max err canvas2d | max err webgl |
| ------------- | --------------------- | ------------- | ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------- |
| bt601-limited | white75               | 191, 191, 191 | 190.0, 190.0, 190.0 | 190.0, 190.0, 190.0 | 191.0, 191.0, 191.0                                                                                                                                                                                 | 0.0              | 1.0           |
| bt601-limited | yellow75              | 191, 191, 0   | 188.0, 189.0, 0.0   | 188.0, 189.0, 0.0   | 190.0, 191.0, 1.0                                                                                                                                                                                   | 0.0              | 2.0           |
| bt601-limited | cyan75                | 0, 191, 191   | 0.0, 190.0, 189.0   | 0.0, 190.0, 189.0   | 0.0, 191.0, 190.0                                                                                                                                                                                   | 0.0              | 1.0           |
| bt601-limited | green75               | 0, 191, 0     | 0.0, 188.0, 0.0     | 0.0, 188.0, 0.0     | 0.0, 190.0, 0.0                                                                                                                                                                                     | 0.0              | 2.0           |
| bt601-limited | magenta75             | 191, 0, 191   | 190.0, 0.0, 191.0   | 190.0, 0.0, 191.0   | 191.0, 0.0, 191.0                                                                                                                                                                                   | 0.0              | 1.0           |
| bt601-limited | red75                 | 191, 0, 0     | 191.0, 0.0, 0.0     | 191.0, 0.0, 0.0     | 191.0, 0.0, 0.0                                                                                                                                                                                     | 0.0              | 0.0           |
| bt601-limited | blue75                | 0, 0, 191     | 0.0, 0.0, 191.0     | 0.0, 0.0, 191.0     | 0.0, 1.0, 190.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt601-limited | red100                | 255, 0, 0     | 253.0, 0.0, 0.0     | 253.0, 0.0, 0.0     | 254.0, 0.0, 0.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt601-limited | grey50                | 128, 128, 128 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt601-limited | skin                  | 224, 172, 140 | 222.0, 170.0, 138.0 | 222.0, 170.0, 138.0 | 224.0, 172.0, 140.0                                                                                                                                                                                 | 0.0              | 2.0           |
| bt601-limited | nearBlack             | 16, 16, 16    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0                                                                                                                                                                                    | 0.0              | 0.0           |
| bt601-limited | nearWhite             | 235, 235, 235 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt601-limited | _Chromium colorSpace_ |               |                     |                     | {"fullRange":false,"matrix":"smpte170m","primaries":"smpte170m","transfer":"smpte170m","glRenderer":"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"} |                  |               |
| bt601-full    | white75               | 191, 191, 191 | 191.0, 191.0, 191.0 | 191.0, 191.0, 191.0 | 191.0, 191.0, 191.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt601-full    | yellow75              | 191, 191, 0   | 190.0, 190.0, 0.0   | 190.0, 190.0, 0.0   | 190.0, 191.0, 1.0                                                                                                                                                                                   | 0.0              | 1.0           |
| bt601-full    | cyan75                | 0, 191, 191   | 0.0, 189.0, 190.0   | 0.0, 189.0, 190.0   | 0.0, 191.0, 190.0                                                                                                                                                                                   | 0.0              | 2.0           |
| bt601-full    | green75               | 0, 191, 0     | 0.0, 190.0, 0.0     | 0.0, 190.0, 0.0     | 0.0, 191.0, 1.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt601-full    | magenta75             | 191, 0, 191   | 191.0, 0.0, 190.0   | 191.0, 0.0, 190.0   | 191.0, 0.0, 190.0                                                                                                                                                                                   | 0.0              | 0.0           |
| bt601-full    | red75                 | 191, 0, 0     | 190.0, 0.0, 0.0     | 190.0, 0.0, 0.0     | 191.0, 0.0, 0.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt601-full    | blue75                | 0, 0, 191     | 0.0, 0.0, 190.0     | 0.0, 0.0, 190.0     | 1.0, 0.0, 190.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt601-full    | red100                | 255, 0, 0     | 254.0, 0.0, 0.0     | 254.0, 0.0, 0.0     | 255.0, 0.0, 0.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt601-full    | grey50                | 128, 128, 128 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt601-full    | skin                  | 224, 172, 140 | 224.0, 171.0, 139.0 | 224.0, 171.0, 139.0 | 225.0, 172.0, 140.0                                                                                                                                                                                 | 0.0              | 1.0           |
| bt601-full    | nearBlack             | 16, 16, 16    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0                                                                                                                                                                                    | 0.0              | 0.0           |
| bt601-full    | nearWhite             | 235, 235, 235 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt601-full    | _Chromium colorSpace_ |               |                     |                     | {"fullRange":true,"matrix":"smpte170m","primaries":"smpte170m","transfer":"smpte170m","glRenderer":"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"}  |                  |               |
| bt709-limited | white75               | 191, 191, 191 | 190.0, 190.0, 190.0 | 190.0, 190.0, 190.0 | 191.0, 191.0, 191.0                                                                                                                                                                                 | 0.0              | 1.0           |
| bt709-limited | yellow75              | 191, 191, 0   | 190.0, 188.0, 0.0   | 190.0, 188.0, 0.0   | 191.0, 191.0, 9.0                                                                                                                                                                                   | 0.0              | 9.0           |
| bt709-limited | cyan75                | 0, 191, 191   | 0.0, 189.0, 190.0   | 0.0, 189.0, 190.0   | 0.0, 191.0, 188.0                                                                                                                                                                                   | 0.0              | 2.0           |
| bt709-limited | green75               | 0, 191, 0     | 0.0, 189.0, 0.0     | 0.0, 189.0, 0.0     | 0.0, 191.0, 6.0                                                                                                                                                                                     | 0.0              | 6.0           |
| bt709-limited | magenta75             | 191, 0, 191   | 190.0, 0.0, 191.0   | 190.0, 0.0, 191.0   | 191.0, 0.0, 185.0                                                                                                                                                                                   | 0.0              | 6.0           |
| bt709-limited | red75                 | 191, 0, 0     | 190.0, 0.0, 0.0     | 190.0, 0.0, 0.0     | 192.0, 0.0, 3.0                                                                                                                                                                                     | 0.0              | 3.0           |
| bt709-limited | blue75                | 0, 0, 191     | 0.0, 0.0, 190.0     | 0.0, 0.0, 190.0     | 0.0, 0.0, 182.0                                                                                                                                                                                     | 0.0              | 8.0           |
| bt709-limited | red100                | 255, 0, 0     | 254.0, 0.0, 0.0     | 254.0, 0.0, 0.0     | 255.0, 1.0, 3.0                                                                                                                                                                                     | 0.0              | 3.0           |
| bt709-limited | grey50                | 128, 128, 128 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt709-limited | skin                  | 224, 172, 140 | 223.0, 171.0, 139.0 | 223.0, 171.0, 139.0 | 224.0, 172.0, 142.0                                                                                                                                                                                 | 0.0              | 3.0           |
| bt709-limited | nearBlack             | 16, 16, 16    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0                                                                                                                                                                                    | 0.0              | 0.0           |
| bt709-limited | nearWhite             | 235, 235, 235 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt709-limited | _Chromium colorSpace_ |               |                     |                     | {"fullRange":false,"matrix":"bt709","primaries":"bt709","transfer":"bt709","glRenderer":"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"}             |                  |               |
| bt709-full    | white75               | 191, 191, 191 | 191.0, 191.0, 191.0 | 191.0, 191.0, 191.0 | 191.0, 191.0, 191.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt709-full    | yellow75              | 191, 191, 0   | 191.0, 189.0, 0.0   | 191.0, 189.0, 0.0   | 191.0, 191.0, 0.0                                                                                                                                                                                   | 0.0              | 2.0           |
| bt709-full    | cyan75                | 0, 191, 191   | 0.0, 189.0, 190.0   | 0.0, 189.0, 190.0   | 0.0, 190.0, 191.0                                                                                                                                                                                   | 0.0              | 1.0           |
| bt709-full    | green75               | 0, 191, 0     | 0.0, 190.0, 0.0     | 0.0, 190.0, 0.0     | 0.0, 192.0, 0.0                                                                                                                                                                                     | 0.0              | 2.0           |
| bt709-full    | magenta75             | 191, 0, 191   | 191.0, 0.0, 191.0   | 191.0, 0.0, 191.0   | 191.0, 0.0, 192.0                                                                                                                                                                                   | 0.0              | 1.0           |
| bt709-full    | red75                 | 191, 0, 0     | 190.0, 0.0, 0.0     | 190.0, 0.0, 0.0     | 191.0, 1.0, 0.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt709-full    | blue75                | 0, 0, 191     | 0.0, 0.0, 190.0     | 0.0, 0.0, 190.0     | 0.0, 0.0, 191.0                                                                                                                                                                                     | 0.0              | 1.0           |
| bt709-full    | red100                | 255, 0, 0     | 254.0, 0.0, 0.0     | 254.0, 0.0, 0.0     | 254.0, 0.0, 0.0                                                                                                                                                                                     | 0.0              | 0.0           |
| bt709-full    | grey50                | 128, 128, 128 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0 | 128.0, 128.0, 128.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt709-full    | skin                  | 224, 172, 140 | 223.0, 172.0, 140.0 | 223.0, 172.0, 140.0 | 224.0, 172.0, 140.0                                                                                                                                                                                 | 0.0              | 1.0           |
| bt709-full    | nearBlack             | 16, 16, 16    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0    | 16.0, 16.0, 16.0                                                                                                                                                                                    | 0.0              | 0.0           |
| bt709-full    | nearWhite             | 235, 235, 235 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0 | 235.0, 235.0, 235.0                                                                                                                                                                                 | 0.0              | 0.0           |
| bt709-full    | _Chromium colorSpace_ |               |                     |                     | {"fullRange":true,"matrix":"bt709","primaries":"bt709","transfer":"bt709","glRenderer":"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"}              |                  |               |
