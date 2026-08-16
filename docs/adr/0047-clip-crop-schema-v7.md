# ADR 0047 — Clip crop rect (schema v7)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Builds on:** ADR 0001 (reversible operations), ADR 0031 (track flags,
  schema v4), ADR 0045 (caption style, schema v5), ADR 0046 (clip speed,
  schema v6).
- **Part of:** Horizon 1 (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C6, WS-C), H1.2 —
  one of five pre-authorized schema bumps (v5–v9), each its own small commit.

## Context

The plan calls for a clip-level crop rect: a rectangular window into the
source frame that lets a clip fill a different aspect ratio (e.g. crop a 16:9
source into a 9:16 vertical clip) or reframe a shot. Before this ADR, `Clip`
has no crop field — the full source frame is always used.

**Precedent check (per task instructions):** `Clip` has no `transform` field
either. What the plan's capability table calls "transform" is actually
`Clip.keyframes` (`property`/`value` pairs like `scale`/`x`/`y`/`opacity`,
evaluated by `evaluate_clip_transform` in the Python engine) — a *curve*, not
a static rect, so it is not a useful shape precedent for a static crop.

The relevant precedent is **masking** (PRD §6.5): `AddMaskOp.bounds` /
`TrackObjectOp.region` are both typed as `MaskBounds` — `{ x, y, width,
height }` as **fractions (0..1) of the clip frame** — but that geometry is
stored in the mask/track effect's free-form `params` (no schema change), not
as a typed `Clip` field, specifically so a shape/points/feather/opacity bag
didn't need its own schema slot before the concrete UI need for one existed
(mirrors ADR 0045's original reasoning for caption style before it became a
persisted field).

Crop is different from mask/transform in a way that justifies a real schema
field instead of another effect: it is **exactly one rect, always axis-
aligned, with no shape/animation/opacity variants** — the plan's capability
table lists it as a single control, not an effects family — and, like
`captionStyle` (v5) and `speed` (v6) before it, both the renderer and the
editor UI need typed read/write access to it (crop must be visible in preview
compositing, not just at render time), which is exactly the reasoning ADR
0045 gives for promoting caption style out of a free-form params bag.

## Decision

### `Clip.crop` — an optional, axis-aligned rect

`ClipSchema` gains one new optional field:

```ts
export const CropRectSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .refine((r) => r.x + r.width <= 1 + 1e-9, { path: ['width'], message: '…' })
  .refine((r) => r.y + r.height <= 1 + 1e-9, { path: ['height'], message: '…' });

// on ClipSchema:
crop: CropRectSchema.optional();
```

**Coordinate convention: fractions (0..1) of the clip's source frame.** This
is a deliberate match to `MaskBounds`'s existing "frame fractions" convention
(same field names `x`/`y`/`width`/`height`, same 0..1 range, same axis-aligned
top-left-origin rect) rather than pixels or `left/top/right/bottom` edges —
consistency with the one geometry convention this schema already has beats
inventing a second one, and fractions stay valid across a proxy/full-res
media swap (unlike pixel coordinates, which would need to be re-derived per
resolution). "Source frame" (not "clip frame" as `MaskBounds`'s comment
says) is used here because crop is conceptually a *source*-side operation —
it selects which part of the original footage this clip shows — whereas a
mask is composited against the clip's rendered output; in practice both
describe the same `[0,1] x [0,1]` unit square for an uncropped clip, so the
convention is identical, just documented precisely for its own field.

**Why a `.refine()` on `CropRectSchema` itself, not `ClipSchema`:** the "stays
within the unit frame" and "positive width/height" invariants are properties
of the rect's own four numbers, not a whole-clip cross-field invariant like
`ClipSchema`'s existing `end > start` refine. Keeping the refine on the rect
type keeps it reusable and testable in isolation, and mirrors how `speed`'s
positivity is a field-level `z.number().positive()` (schema v6) rather than a
whole-clip refine — only truly clip-wide invariants (like the v6
speed/duration consistency check) live in the patch validator instead.

**Absent = uncropped**, the full source frame — today's behavior, unchanged.

### Operation: `set_clip_crop`

A new reversible timeline operation, mirroring `set_caption_style` (v5) and
`set_clip_speed` (v6) exactly — "whole value, single axis" semantics:

```ts
interface SetClipCropOp {
  type: 'set_clip_crop';
  clipId: string;
  crop: CropRect | null; // null clears back to uncropped
}
```

`applySetClipCrop` defensively re-validates the incoming rect against
`CropRectSchema` (same "validate before apply" belt-and-braces re-check
`set_caption_style` does for its own shape) and throws
`OperationError('invalid_crop', …)` for an out-of-bounds, zero, or negative
rect — the validator is the primary gate (PRD §8.5), but `apply` never trusts
an unvalidated shape reaching it directly. A valid `crop` replaces the field
wholesale (not merged); `null` deletes it.

Same-shape, exact inverse: `invertOperation` returns a `set_clip_crop`
carrying the clip's prior crop (`clip.crop ?? null`) — the crop has no effect
on `start`/`end`/`sourceStart`/`sourceEnd`, so no other field needs restoring.

### Validator

- New `ValidationCode: 'invalid_crop'`, mapped from `OperationError`'s new
  `'invalid_crop'` code (same wiring as `invalid_style`/`invalid_speed`).
- `set_clip_crop` is registered in `SUPPORTED_OPERATIONS`.
- No new whole-timeline consistency check (unlike v6's
  `speed_duration_mismatch`) is needed: a crop rect has no relationship to
  `start`/`end`/`sourceStart`/`sourceEnd` to go stale against, so
  `CropRectSchema`'s own `.refine()`s (re-checked defensively in `apply`) are
  sufficient — there is no analogous "hand-crafted clip disagrees with a
  derived field" failure mode.

### Migration: v6 → v7

Purely additive, like every prior step: a v6 clip has no `crop`, which *is*
"uncropped" (today's implicit full-source-frame behavior), so
`migrate: (raw) => raw` — the step exists only to stamp the new envelope
version.

## Consequences

- Schema bumps to **v7**; `schema/project.schema.json` is regenerated from the
  Zod source (`pnpm --filter @framepilot/timeline-schema build && pnpm
  --filter @framepilot/timeline-schema schema:generate`).
- `packages/editor-core` gains `set_clip_crop` (apply/invert/validate, 100%
  branch/line/func coverage) mirroring `set_caption_style`/`set_clip_speed`'s
  exact-inverse pattern.
- **Python engine, AI tool registry, and UI are explicitly out of scope for
  this commit** — this is a schema + patch-engine-only slice (per the task's
  build order: engine before AI/UI, and per this task's explicit instruction
  not to touch the Python engine or any UI). Until the Python `Clip` Pydantic
  model gains the matching `crop` field,
  `engine/python/tests/test_schema_parity.py` will report a field mismatch on
  `Clip` — a known, tracked gap for the engine follow-up (actually cropping
  the frame via MoviePy and wiring a `set_clip_crop` AI tool), not a silent
  drift, exactly like ADR 0046's original (pre-addendum) scope note.

## Addendum — engine render

The Python side of this gap is now closed: `Clip.crop` was added to
`framepilot_engine/timeline/models.py` as a new `CropRect` model (`x`/`y`/
`width`/`height`, same names/range as `MaskBounds`; `SCHEMA_VERSION` bumped to
7), and `framepilot_engine/render/compiler.py` now actually crops the source
frame via `_apply_crop` rather than accepting-but-ignoring the field. Decisions
made in that follow-up, recorded here rather than left implicit in code:

**Why `CropRect` is a new model, not a reused `MaskBounds`:** `MaskBounds`
lives in `framepilot_engine/timeline/operations.py`, which already imports
`Clip` from `timeline/models.py` — importing `MaskBounds` back into
`models.py` would be circular. `CropRect` is defined in `models.py` instead,
field-for-field identical to `MaskBounds` (same names, same 0..1 frame-
fraction convention), so the two stay interchangeable in spirit without an
import cycle.

**No bounds re-validation on `CropRect`:** consistent with `MaskBounds` (which
has no bounds check either) and with `Clip.speed`'s positivity note, the
engine trusts that a `crop` reaching it already passed the TS
`CropRectSchema.refine()`s at patch-apply time. No redundant out-of-range test
was added on the engine side for the same reason.

**MoviePy API used:** `vfx.Crop(x1=..., y1=..., x2=..., y2=...)` via
`source.with_effects([...])` — pixel corner coordinates; this codebase's
installed MoviePy 2.x has no other crop primitive. The fractional rect is
converted to pixels against `source.size` — the actual decoded **source**
resolution, not the output preset frame — matching the ADR's "source frame"
convention above. This mirrors (but does not literally call, to avoid a
cross-module coupling for four lines of arithmetic) the same `frac * width`
/ `frac * height` inline conversion already used for mask geometry in
`framepilot_engine/render/masks.py` (`rasterize_mask`, `left = spec.x * width`
etc., masks.py:109-112) — this codebase's established convention is to do this
trivial conversion inline at each call site rather than extract a shared
helper, so `_apply_crop` follows suit instead of introducing a new one.

**Composition order: crop → speed → color grade → mask/transition → letterbox
placement.** `_apply_crop` runs immediately after `_subclipped_source`, before
`_apply_speed`, `_apply_color_grade`, `_attach_mask`/transitions, and
`_place_video_clip`. This is the standard crop-then-fit NLE order, and the
only order that keeps later stages consistent: `_place_video_clip` reads
`source.size` to compute the letterbox `base_scale`, and `_attach_mask`
rasterizes mask geometry at `source.size` — both must see the *cropped* frame
size, or a mask/letterbox-fit computed against the original (uncropped)
resolution would misalign with what the crop actually leaves on screen. Crop
vs. speed has no interaction (crop is spatial-only, speed is temporal-only),
so their relative order doesn't matter functionally; crop is placed first
simply to keep all spatial operations (crop, then color grade, mask, and
placement) grouped ahead of the temporal one.
