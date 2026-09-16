# 04 — Schema v22, operations, engine render, preview

## Why a new effect type

A fourth `mask` shape (`shape: 'matte'`) looks smaller but is wrong:

- The compiler and `clipMaskEffect` use the **first** mask. The editor's drawn garbage mask and
  the matte would fight over that slot.
- A drawn mask plus a matte is the professional workflow ("cut out the person, and also exclude
  that light stand"). Two effect types compose: `alpha = matte(t) × shapeMask(t) × opacity`.
- Mask keyframes are timeline-relative and hit the `applySplit` effects-keyframe bug. A
  source-time matte has no keyframes, so it avoids that bug entirely.

## Schema v22 (`packages/timeline-schema` + Pydantic twin), needs MD-1

```ts
MatteEffectSchema = EffectBase.extend({
  type: z.literal('matte'),
  params: z
    .object({
      artifact: z
        .object({
          key: z.string().regex(/^[0-9a-f]{64}$/), // → .framepilot-derived/mattes/<key>/
          files: z.array(z.object({ name: MatteFileName, sha256: Sha256 }).strict()),
          width: PositiveInt,
          height: PositiveInt,
          coverage: z.object({ sourceStart: z.number(), sourceEnd: z.number() }).strict(), // source seconds
          packId: z.string(),
          packVersion: z.string(),
          modelDigests: z.array(Sha256),
        })
        .strict(),
      prompts: z.array(MattePromptRefSchema), // points/boxes inline; brush/lock by input file sha256
      review: z
        .object({
          flagged: z.array(PtsRangeSchema), // from the worker, minus what the editor resolved
          approved: z.array(PtsRangeSchema), // editor confirmed as correct without changes
        })
        .strict(),
      edgeShift: z.number().min(-1).max(1).default(0), // fraction of EDGE_UNIT: <0 choke, >0 spread
      feather: z.number().min(0).max(1).default(0),
      decontaminate: z.boolean().default(true), // use foreground colour in the band
      invert: z.boolean().default(false),
      enabled: z.boolean().default(true),
    })
    .strict(),
});
```

- `edgeShift` and `feather` default to **0**: the delivered matte is already the precise one, and
  these exist for creative looks, not as a repair tool. The Inspector labels them that way.
- Migration v21 → v22 is a no-op data migration (no existing project has a matte), plus a version
  bump, registered in `migrations.ts` with a round-trip test and the Pydantic parity test. Fixtures
  import `SCHEMA_VERSION`; they never hard-code 22.
- Validator rules: at most one `matte` per clip; video/image clips only; the clip's source range
  within `coverage` (±½ frame), otherwise `matte_out_of_coverage` with the remedy "Update the
  background removal for the new range"; `review.approved` ⊆ coverage.
- Constants (`EDGE_UNIT`, filter kernels) live in one shared module mirrored in Python with a
  parity test (the `captionStyle.ts ↔ captions.py` pattern).

## Operations (`packages/editor-core`), each with `apply` + `invert`

| Op                                                                                 | Apply                                                                                                                                        | Invert                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `apply_matte { clipId, params }`                                                   | Add or replace the clip's `matte` effect                                                                                                     | Restore the previous effect snapshot, or remove it |
| `update_matte { clipId, edgeShift?, feather?, decontaminate?, invert?, enabled? }` | Patch the look fields                                                                                                                        | Restore previous values                            |
| `review_matte { clipId, approve?: PtsRange[], unapprove?: PtsRange[] }`            | Mark ranges approved                                                                                                                         | Restore the previous review state                  |
| `remove_matte { clipId }`                                                          | Remove it                                                                                                                                    | Re-add the snapshot at its original effect index   |
| `add_text_behind_subject { clipId, text }` (BR6 shortcut)                          | Duplicate the clip onto a new track above, move the matte to the copy (removing it from the original), insert a text clip on a track between | Exact inverse of the composite patch               |

If generic effect ops already cover add, update and remove with snapshot inverses, use them and add
only the `matte` validator plus `review_matte`. Decide by reading `editor-core` at BR1 start; do not
build parallel ops. Patch identity is operations only.

Artifact existence is not a pure-function check. The pure validator checks shape and coverage; the
desktop project-media validation (where missing media is already reported) checks files and
digests, so a reopened project with a deleted matte shows one clear issue on the clip.

## Engine render (`engine/python/framepilot_engine/render/mattes.py`, new)

- `MatteReader`: reads `matte.mkv` (gray) and `foreground.mkv` via ffmpeg rawvideo, maps a source
  pts to the frame through `frames.json` (bisect), and keeps a sequential cursor plus a small LRU so
  export decodes each frame once. It never loads the whole matte.
- Order inside a picture layer, identical to the preview's layer pipeline in
  [`09`](./09-PREVIEW-EXPORT-PARITY.md): `source → decontaminate (foreground colour in band) → matte
(edgeShift, feather, invert) → × shape mask → × opacity → crop → grade/effects → transform →
composite`. The matte is applied at **source resolution** before crop, so crop and transform
  move the cut-out with the picture. (The BR1 ADR fixes the grade-vs-matte order once by reading
  the compiler, and the frame-plan parity vectors pin it.)
- Edge shift = greyscale erode/dilate with radius `|edgeShift| × EDGE_UNIT × min(w,h)`; feather =
  Gaussian blur of alpha. PIL `MinFilter`/`MaxFilter`/`GaussianBlur` and numpy are existing engine
  dependencies. The engine gains no new dependency.
- Typed refusals happen before rendering starts, not mid-export: missing file, digest mismatch, out
  of coverage, dimension mismatch against the asset.
- Tests: unit tests on synthetic mattes (a gradient, a hard disk, a 1-px line, a band with
  foreground colour); a render golden with a fixture matte in a **video → text → matted copy**
  timeline; VFR and edit-list pts fixtures; a speed-ramped clip mapping output time → source pts →
  matte frame.

## Preview

The preview side of mattes is **not** a special case anymore. It is one layer pass inside the
N-layer compositor planned in [`09-PREVIEW-EXPORT-PARITY.md`](./09-PREVIEW-EXPORT-PARITY.md):

- `apps/web-editor/src/preview/engine/passes/matte-pass.ts`: decodes `preview.webm` and
  `foreground.preview.webm` through the shared decoder pool by the pts the frame plan gives, then
  applies luma→alpha, decontamination, edge shift and feather as shader passes whose kernels mirror
  `mattes.py`.
- Preview-only views (Composite | Matte | Overlay | Flagged) are a final debug pass selected by
  UI state and never enter the project.
- Parity is proven by the `09` oracle rows for mattes and text-behind-subject, not by a separate test.
