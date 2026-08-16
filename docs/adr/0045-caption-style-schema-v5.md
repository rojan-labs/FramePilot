# ADR 0045 — Persisted caption style (schema v5)

- **Status:** Partially superseded by ADR 0069 (schema v10): `presetId` and the
  3-preset resolution are replaced by the caption template catalog
  (`templateId`); the structured-`captionStyle`-on-Clip decision itself stands.
  Further extended by ADR 0071 (schema v11): `captionStyle` on Clip is now a
  per-cue *override* layered over a new `Track.captionStyle` default.
- **Date:** 2026-07-10
- **Builds on:** ADR 0001 (reversible operations), ADR 0031 (track flags, schema
  v4), ADR 0032 (type-agnostic layers).
- **Part of:** Horizon 1 (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md`), H1.1 — the first
  of five schema bumps (v5–v9), each its own small commit.

## Context

`apps/web-editor/src/editor/captions.ts` and `CaptionEditor.tsx` already offer a
full caption-styling UI — a template gallery (`CAPTION_TEMPLATES`: color,
background, font weight, text transform), keyword highlighting, font scale,
color, and position controls — but every one of those choices lived in local
React `useState`. Reloading the project, or having the AI layer touch the
caption, silently discarded the style: nothing about it was in
`project.fp.json`. `captions.ts`'s header called this out explicitly and deferred
persisting it to "a schema migration in a later phase" (AGENTS.md: no schema
change without a migration) — this ADR is that migration.

The caption clip itself already carries a `caption`-type `Effect` with a
free-form `params: Record<string, unknown>` bag (the same shape every other
effect uses). We considered stuffing the style fields in there instead of on
`Clip` directly.

## Decision

### `Clip.captionStyle` — a structured field, not effect params

`ClipSchema` gains one new optional field, `captionStyle`, typed against a new
`CaptionStyleSchema`:

```ts
CaptionStyleSchema = z.object({
  fontFamily: z.string().min(1).optional(),
  fontScale: z.number().positive().optional(),
  textColor: z.string().min(1).optional(),
  outlineColor: z.string().min(1).optional(),
  outlineWidth: z.number().nonnegative().optional(),
  position: z.enum(['top', 'middle', 'bottom']).optional(),
  highlight: z.object({
    enabled: z.boolean().optional(),
    color: z.string().min(1).optional(),
    animation: z.enum(['none', 'pop', 'karaoke-fill']).optional(),
  }).optional(),
  presetId: z.string().min(1).optional(),
});
```

We rejected nesting this inside the caption `Effect`'s `params: Record<string,
unknown>` bag. Both consumers of this data — the Python renderer (burning
captions into frames) and the web-editor's `CaptionEditor`/preview — need typed,
compile-time-checked field access, not `params.highlight?.animation as string`
lookups with no shape guarantee. Word-highlight/karaoke animation in particular
needs a small closed enum (`'none' | 'pop' | 'karaoke-fill'`) the renderer
branches on; a stringly-typed params record gives no such guarantee and would
silently no-op on a typo. Modeling it as a first-class, optional `Clip` field
(the same pattern as `Clip.keyframes`) keeps that contract in the schema itself,
mirrored 1:1 into the Python Pydantic `Clip` model (a follow-up step) via the
shared JSON Schema — consistent with how `TrackSchema.locked/hidden/muted` (ADR
0031) are typed track-level fields rather than untyped metadata.

`captionStyle` is meaningful only on caption-kind clips (`assetId ===
'__caption__'`, created by `add_caption_layer`) but is not schema-restricted to
them — the field lives on `Clip` generically, same as `keyframes`/`effects` do
on every clip regardless of kind.

### Operation: `set_caption_style`

A new reversible timeline operation, `set_caption_style`:

```ts
interface SetCaptionStyleOp {
  type: 'set_caption_style';
  clipId: string;
  captionStyle: CaptionStyle | null; // null clears back to unstyled
}
```

It follows the `set_track_flags` precedent (ADR 0031): a whole-value,
single-axis change gets a same-shape, exact inverse — `set_caption_style`
carrying the clip's prior style (or `null` if it had none) — rather than the
generic `restore_clips` snapshot every multi-axis op falls back to. Replacing
(not merging) keeps the semantics simple: the caller reads the clip's current
style, edits the fields it wants, and resubmits the whole object.

`applySetCaptionStyle` re-validates the incoming `captionStyle` against
`CaptionStyleSchema` before writing it (`OperationError('invalid_style', …)` on
failure) — the "validate before apply" invariant applied defensively at the op
boundary, not only at the patch validator. The validator additionally maps that
error to a new `ValidationCode: 'invalid_style'` and the op is registered in
`SUPPORTED_OPERATIONS`.

### Migration: v4 → v5

Purely additive, like every prior step: a v4 clip has no `captionStyle`, which
*is* the default "unstyled" render (exactly what the caption UI already renders
when no style is chosen), so `migrate: (raw) => raw` — the step exists only to
stamp the new envelope version.

## Consequences

- Schema bumps to **v5**; `schema/project.schema.json` is regenerated from the
  Zod source (`pnpm --filter @framepilot/timeline-schema build && … schema:generate`).
- **Python engine and `CaptionEditor.tsx` are explicitly out of scope for this
  commit** (separate, later steps: the renderer needs to read `captionStyle` to
  burn styled captions, and the UI needs to switch its local `useState` for a
  `set_caption_style` patch). Until the Python `Clip` Pydantic model gains the
  matching field, `engine/python/tests/test_schema_parity.py` will report a field
  mismatch on `Clip` — a known, tracked gap closed by the engine follow-up, not a
  silent drift (the parity test's job is exactly to surface it).

  **Update (2026-07-10):** the Python engine half landed. `timeline/models.py`
  now has `CaptionStyle`/`CaptionHighlight` (mirroring the Zod shape 1:1) and
  `Clip.caption_style`, `SCHEMA_VERSION` bumped to 5 — `test_schema_parity.py`
  is green again. `render/captions.py`/`render/compiler.py` burn a styled
  clip's font/color/outline/position and per-word `pop`/`karaoke-fill`
  highlight (see `docs/architecture/render-engine.md`); an unstyled clip still
  renders through the byte-identical pre-v5 path. `CaptionEditor.tsx` still has
  no way to author a `captionStyle` — that UI wiring remains the one
  outstanding follow-up before this is a user-facing feature.
- `CAPTION_TEMPLATES` (`captions.ts`) map naturally onto `captionStyle` +
  `presetId`, so a later commit can make "apply a template" call
  `set_caption_style` instead of a local state update, with zero schema change.
