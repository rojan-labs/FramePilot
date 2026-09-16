# 04 — Schema v22, operations, engine render, preview

## Why a new effect type

A fourth `mask` shape (`shape: 'matte'`) looks smaller but is wrong:

- The compiler and `clipMaskEffect` use the **first** mask. The editor's drawn garbage mask
  and the matte would fight over that slot.
- A drawn mask plus a matte is the professional workflow ("cut out the person, and also
  exclude that light stand"). Two effect types compose naturally:
  `alpha = matte(t) × shapeMask(t) × opacity`.
- Mask keyframes are timeline-relative and hit the `applySplit` effects-keyframe bug. A
  source-time matte has no keyframes, so it avoids that bug entirely.

## Schema v22 (`packages/timeline-schema` + Pydantic twin), needs MD-1

```ts
MatteEffectSchema = EffectBase.extend({
  type: z.literal('matte'),
  params: z.object({
    artifact: z.object({
      key: z.string().regex(/^[0-9a-f]{64}$/),          // cache key → .framepilot-derived/mattes/<key>/
      masterSha256: Sha256, previewSha256: Sha256, framesSha256: Sha256,
      width: PositiveInt, height: PositiveInt,
      coverage: z.object({ sourceStart: z.number(), sourceEnd: z.number() }).strict(),  // seconds, source time
      packId: z.string(), packVersion: z.string(), modelDigests: z.array(Sha256),
    }).strict(),
    prompts: z.array(MattePromptSchema),   // stored so a correction can re-run with the same inputs
    edgeShift: z.number().min(-1).max(1).default(0),     // fraction of FEATHER_UNIT: <0 choke, >0 spread
    feather: z.number().min(0).max(1).default(0),
    invert: z.boolean().default(false),                   // "remove subject, keep background"
    enabled: z.boolean().default(true),
  }).strict(),
})
```

- Migration v21 → v22 is a no-op data migration (no existing project has a matte), plus a
  version bump. It is registered in `migrations.ts` with a round-trip test and the Pydantic
  parity test. The engine's strict `SCHEMA_VERSION` equality means fixtures must import the
  constant, not hard-code 22.
- Validator rules: at most one `matte` per clip; only on video/image clips; the clip's
  `[sourceStart, sourceEnd]` within `coverage` (±½ frame), otherwise
  `matte_out_of_coverage` with the remedy "Update the background removal for the new range";
  artifact files present and matching digests on desktop (host-checked, see below).
- Constants (`FEATHER_UNIT`, edge-shift pixel scale) live in one shared module and are mirrored
  in Python with a parity test, following `captionStyle.ts ↔ captions.py`.

## Operations (`packages/editor-core`), each with `apply` + `invert`

| Op                                                      | Apply                                    | Invert                                                  |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `apply_matte { clipId, params }`                        | Add or replace the clip's `matte` effect | Restore the previous effect snapshot, or remove it      |
| `update_matte { clipId, edgeShift?, feather?, invert?, enabled? }` | Patch refine fields                     | Restore the previous values                             |
| `remove_matte { clipId }`                               | Remove it                                | Re-add the snapshot at its original effect index        |

If the existing generic effect ops already cover add, update and remove with snapshot inverses,
use them and add only the `matte` validator. Decide by reading `editor-core` at BR1 start; do not
build parallel ops. The patch-id rule holds: identity is operations only.

Artifact existence is not a pure-function check. The pure validator checks shape and coverage.
The desktop `validateProjectMedia` step (where missing media is already reported) checks files
and digests, so a reopened project with a deleted matte shows one clear issue on the clip.

## Engine render (`engine/python/framepilot_engine/render/mattes.py`, new)

- `MatteReader`: opens `matte.mkv` with ffmpeg as `gray` rawvideo, maps a source time to the
  frame via `frames.json` pts (bisect), and keeps a sequential read cursor plus a small LRU so a
  forward export decodes each matte frame once. It never loads the whole matte.
- Order inside the clip's picture pipeline, matching the preview exactly:
  `source → crop → matte (edgeShift, feather, invert) → × shape mask → × opacity → transform → composite`.
  The matte is applied at **source resolution before crop**, so crop and transform move the cut-out
  with the picture.
- Edge shift = greyscale erode/dilate with radius `|edgeShift| × FEATHER_UNIT × min(w,h)`;
  feather = Gaussian blur of alpha. PIL `MinFilter`/`MaxFilter`/`GaussianBlur` are already engine
  dependencies. The engine gains no new dependency.
- Refusals are typed and happen before rendering starts, not mid-export: missing file,
  digest mismatch, out of coverage, dimension mismatch against the asset.
- Tests: unit tests on synthetic mattes (a gradient, a hard disk, a 1-px line); a render golden
  with a fixture matte over a two-track timeline; VFR and edit-list pts fixtures; the
  speed-ramped clip maps output time → source time → matte frame.

## Preview (`apps/web-editor/src/preview`)

### BR5a — a matted clip alone (black behind)

- `clip-matte.ts`: resolve the matte for a clip at source time from `frames.json`, and
  decode `preview.webm` through the existing `DecodeWorkerClient` + `FrameRing` (one session
  per matte, the same as a source).
- Paint: draw the clip into its offscreen layer, convert the matte frame's luma to alpha
  (a WebGL pass in `GlEffectChain`: `alpha = luma`, then edge shift and feather as shader passes
  whose kernels mirror the engine's), composite `destination-in`, then apply the existing
  `paintClipMask`.
- `canvasPreviewEligible` admits a matted clip when nothing overlaps it (unchanged rule).

### BR5b — a matted clip over one lower clip (the real user outcome)

- A new admitted relation in `canvasPreviewEligible`: in an overlap, the front clip may be
  matted **if every clip behind it is full-frame opaque** and the stack is at most two picture
  layers. The rule stays a relation (ADR 0169/0170), written the same way.
- The engine paints the back segment, then the front layer composited with its matte. That
  means two decode sessions active at once, which the P2 engine already supports across cuts but
  not simultaneously. This is the only compositor extension this plan makes.
- Anything wider (three layers, a matted clip behind another translucent clip) stays
  ineligible and falls back with the existing "preview differs from export" affordance. It is
  listed in [`08`](./08-DEFERRED-AND-RISKS.md).

### Parity test

A headless test renders frames at 5 timestamps through the engine and through the canvas path
on the same fixture (matte + edge shift + feather + shape mask + crop + transform) and asserts
mean absolute alpha difference ≤ 2/255 away from edges and ≤ 8/255 in the edge band (the
preview proxy is lossy VP9 at proxy resolution). Frame alignment must be exact.
