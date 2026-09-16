# 04 — The `matte` mask kind: schema fields, operations, engine, preview

The timeline model for **all** masks is the v22 mask stack in
[`10-PROFESSIONAL-MASKING.md`](./10-PROFESSIONAL-MASKING.md#schema-v22-the-mask-stack-needs-md-1).
An earlier draft of this file proposed a separate `matte` effect type. That is **withdrawn**: two alpha
models (effects and masks) would fight over order and double every validator, renderer and AI path. A
matte is one mask kind. This file holds only what is specific to it.

## Fields of `kind: 'matte'`

```ts
MaskLayerBase & {
  kind: 'matte',
  artifact: {
    key: /^[0-9a-f]{64}$/,                          // → .framepilot-derived/mattes/<key>/
    files: [{ name: MatteFileName, sha256 }],
    width, height,                                   // source pixels; must equal the asset's probed size
    coverage: { sourceStart, sourceEnd },            // source seconds
    packId, packVersion, modelDigests: Sha256[],
  },
  prompts: MattePromptRef[],       // points/boxes inline; brush/lock by input-file sha256; grounding candidate refs
  review: { flagged: PtsRange[], approved: PtsRange[], locked: SourcePts[] },
  edgeShiftPx: number,             // creative only; default 0
  decontaminate: boolean,          // default true
}
```

The base fields (mode, opacity, invert, expansion, feathers, target) apply to a matte like any other
mask. A matte can therefore be combined with a shape (for example, subtract a light stand), aimed at an
effect (for example, blur only the background with `invert`), or tracked content can be intersected with it.

- `expansionPx`, the feathers and `edgeShiftPx` default to **0**: the delivered matte is already the
  precise one. The Inspector labels these controls "Creative", not "Fix".
- Validator additions: `artifact.width/height` equal the asset's probed size; the clip's source range
  lies within `coverage` (±½ frame), else `matte_out_of_coverage` with the remedy "Update the background
  removal for the new range"; review ranges lie within coverage.
- Artifact existence and digests are checked by desktop project-media validation (not the pure
  validator), so a reopened project with a deleted matte shows one clear issue on the clip.

## Operations

A matte uses the generic mask ops from `10` (`add_mask`, `update_mask`, `remove_mask`, `review_mask`,
`reorder_masks`, `set_mask_target`, `paste_masks`). Matte-specific behaviour lives in their validators and
in one composite op:

| Op                                                 | Apply                                                                                                                                                                  | Invert                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `add_text_behind_subject { clipId, text, style? }` | Duplicate the clip onto a new track above, move the clip's subject matte (or create one from the host job result) onto the copy, insert a text clip on a track between | The exact inverse of the composite patch |

A re-run after a correction produces a **new artifact** and an `update_mask` that swaps
`artifact` + `prompts` + `review`. Undo swaps back, and the old artifact stays referenced.

## Engine (`render/mattes.py`, used by `render/mask_stack.py`)

- `MatteReader`: reads `matte.mkv` (gray) and `foreground.mkv` via ffmpeg rawvideo, maps a source pts to
  the frame through `frames.json` (bisect), and keeps a sequential cursor plus a small LRU, so export
  decodes each frame once. It never loads the whole matte.
- In the stack a matte contributes its alpha (after `edgeShiftPx`, then the base expansion/feather by the
  distance-field rules of `10` applied to the matte's own edge). **Decontamination replaces the layer's
  RGB inside the band with the foreground estimate before any target is applied**, so an effect-target
  matte and an alpha-target matte both get clean edges.
- Typed refusals happen before rendering starts: missing file, digest mismatch, out of coverage, size mismatch.
- Tests: synthetic mattes (gradient, hard disk, 1-px line, band with foreground colour); a render golden
  for **video → text → matted copy**; VFR and edit-list pts; a speed-ramped clip mapping output time →
  source pts → matte frame; a matte subtracted by a path mask.

## Preview (a pass in the [`09`](./09-PREVIEW-EXPORT-PARITY.md) compositor)

- `apps/web-editor/src/preview/masks/matte-source.ts` decodes `preview.webm` and
  `foreground.preview.webm` through the shared decoder pool by the pts the frame plan gives. The
  `mask-stack` pass consumes it like any other mask kind (luma → alpha, decontaminate, edge shift, then
  the base stack rules).
- Views (Overlay / Mask only / Checkerboard / Flagged) are a final debug pass selected by UI state; they
  never enter the project.
- Parity is proven by the `09` oracle rows for mattes, matte + shape combinations, and text behind
  subject, not by a separate test.
