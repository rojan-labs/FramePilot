# ADR 0048 — Clip blend mode (schema v8)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Builds on:** ADR 0001 (reversible operations), ADR 0031 (track flags,
  schema v4), ADR 0045 (caption style, schema v5), ADR 0046 (clip speed,
  schema v6), ADR 0047 (clip crop rect, schema v7).
- **Part of:** Horizon 1 (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C8, WS-C), H1.2 —
  one of five pre-authorized schema bumps (v5–v9), each its own small commit.

## Context

The plan's capability table lists a per-clip compositing blend mode (how a
clip's pixels combine with whatever is composited beneath it — most useful for
`overlay`-track clips layered over a base video track). Before this ADR,
`Clip` has no blend-mode field — every clip composites with plain alpha-over
(today's implicit "normal" behavior), regardless of track.

**Precedent check (per task instructions):** mirrors ADR 0047's crop rect and
ADR 0046's speed exactly — a single, well-defined, non-animated per-clip
control that both the renderer and the editor UI need typed read/write access
to (blend mode must be visible in preview compositing, not just at render
time), so it earns a real `ClipSchema` field rather than living in an effect's
free-form `params` bag (the same reasoning ADR 0045 gives for promoting
caption style, and ADR 0047 for crop).

## Decision

### `Clip.blendMode` — an optional enum

`ClipSchema` gains one new optional field, backed by a new top-level enum:

```ts
export const BlendModeSchema = z.enum([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
]);

// on ClipSchema:
blendMode: BlendModeSchema.optional();
```

**Why this subset, not the full CSS `mix-blend-mode` list:** the task
instructions ask the schema author to pick a set the render engine can
realistically deliver, without over-promising. This enum is exactly the
modes expressible as **simple per-channel arithmetic on two aligned RGB
frames** — `multiply`, `screen`, `darken`, `lighten`, `difference`,
`exclusion` are direct per-channel min/max/product/sum formulas, and
`overlay`/`hard-light`/`soft-light`/`color-dodge`/`color-burn` are the
standard piecewise per-channel formulas built from the same primitives
(these are exactly the modes Pillow's `ImageChops` module — `multiply`,
`screen`, `difference`, `darker`, `lighter` — either implements directly or
that a small per-channel NumPy/Pillow kernel can implement using the same
building blocks, without a colorspace conversion). **Deliberately excluded:**
`hue`, `saturation`, `color`, `luminosity` — the CSS/Photoshop "non-separable"
blend modes — because they require converting to HSL (or an equivalent
luminosity-preserving colorspace) and recombining channels, a materially
different and heavier implementation than the arithmetic modes above; they are
not part of this schema's enum so the schema never promises a mode the engine
follow-up can't realistically deliver without extra research. If a future
engine slice finds one of the twelve modes above impractical to render
correctly in MoviePy/Pillow, trimming the enum is that follow-up's call to
make (per the task's explicit instruction), not this schema commit's.

`'normal'` (or an absent field) is today's default compositing — alpha-over,
no blend — so this is a strictly additive, non-breaking field.

**Meaningful only on non-base-track clips (documented, not enforced):**
compositing only has an effect when there is something underneath a clip to
blend against — conceptually the same scope `AddMaskOp`/`TrackObjectOp` already
occupy (both are typed generically on `Clip` too). A clip alone on the bottom
of the stack (e.g. the sole clip on a project's base `video` track) has
nothing beneath it, so a non-`'normal'` `blendMode` is a no-op in the render
(it composites against whatever the engine treats as the frame's backdrop,
which for the bottom-most layer is nothing). This scoping is **not enforced by
the schema or the validator** — like ADR 0047's crop, the field lives on
`Clip` generically because there is no cheap, generically-correct way to
detect "is there a lower layer under this clip at this point in time" at the
schema level (it depends on track z-order *and* the clip's time range
overlapping a clip below it, which shifts continuously as the timeline is
edited). Documented here so the engine's compositor and the editor UI (e.g. a
blend-mode picker) can consistently only *surface* the control for non-base-
track clips, or silently no-op it for a bottom-layer clip, without that
convention drifting between call sites.

### Operation: `set_clip_blend_mode`

A new reversible timeline operation, mirroring `set_clip_crop` (v7) and
`set_clip_speed` (v6) exactly — "whole value, single axis" semantics:

```ts
interface SetClipBlendModeOp {
  type: 'set_clip_blend_mode';
  clipId: string;
  blendMode: BlendMode | null; // null resets to 'normal'/default
}
```

`applySetClipBlendMode` defensively re-validates the incoming mode against
`BlendModeSchema.safeParse` (same "validate before apply" belt-and-braces
re-check `set_clip_crop`/`set_caption_style` do for their own shapes) and
throws `OperationError('invalid_blend_mode', …)` for an unknown string — the
validator is the primary gate (PRD §8.5), but `apply` never trusts an
unvalidated shape reaching it directly. Zod's own enum check makes this mostly
redundant against a type-safe caller, but it is not redundant against a
hand-built op (a test, a future AI-tool caller, or a patch replayed from an
older/foreign client) — exactly the same rationale the crop/speed/caption-style
ops already document for keeping their own defensive re-checks.

`'normal'` and `null` are both canonicalized to *absent* (deletes the
`blendMode` key), the same "off ≡ absent, not an explicit default value"
convention `set_track_flags` and `set_clip_speed` (1x) already established —
so a reset lands on a deep-equal timeline to a clip that never had a
`blendMode` set, and undo/redo compares cleanly.

Same-shape, exact inverse: `invertOperation` returns a `set_clip_blend_mode`
carrying the clip's prior blend mode (`clip.blendMode ?? null`) — blend mode
has no effect on `start`/`end`/`sourceStart`/`sourceEnd`/`effects`, so no other
field needs restoring.

### Validator

- New `ValidationCode: 'invalid_blend_mode'`, mapped from `OperationError`'s
  new `'invalid_blend_mode'` code (same wiring as
  `invalid_style`/`invalid_speed`/`invalid_crop`).
- `set_clip_blend_mode` is registered in `SUPPORTED_OPERATIONS`.
- No new whole-timeline consistency check (unlike v6's
  `speed_duration_mismatch`) is needed: a blend mode has no relationship to
  any other clip field to go stale against — `BlendModeSchema`'s own enum
  check (re-checked defensively in `apply`) is sufficient.

### Migration: v7 → v8

Purely additive, like every prior step: a v7 clip has no `blendMode`, which
*is* `'normal'` (today's implicit alpha-over compositing), so
`migrate: (raw) => raw` — the step exists only to stamp the new envelope
version.

## Consequences

- Schema bumps to **v8**; `schema/project.schema.json` is regenerated from
  the Zod source (`pnpm --filter @framepilot/timeline-schema build && pnpm
  --filter @framepilot/timeline-schema schema:generate`).
- `packages/editor-core` gains `set_clip_blend_mode` (apply/invert/validate,
  100% branch/line/func coverage) mirroring `set_clip_crop`/`set_clip_speed`'s
  exact-inverse pattern.
- **Python engine, AI tool registry, and UI are explicitly out of scope for
  this commit** — this is a schema + patch-engine-only slice (per the task's
  build order: engine before AI/UI, and per this task's explicit instruction
  not to touch the Python engine or any UI). Until the Python `Clip` Pydantic
  model gains the matching `blend_mode` field,
  `engine/python/tests/test_schema_parity.py` will report a field mismatch on
  `Clip` — a known, tracked gap for the engine follow-up (actually compositing
  the blend mode via Pillow/NumPy and wiring a `set_clip_blend_mode` AI tool),
  not a silent drift, exactly like ADR 0046/0047's original (pre-addendum)
  scope notes. That follow-up is also the right place to trim this ADR's
  twelve-mode enum if any one of them proves impractical to render correctly
  (see the "Deliberately excluded" note above) — this schema commit
  intentionally does not touch `engine/python` or any UI.

## Addendum (2026-07-10): engine compositing (plan H1.2f)

The Python engine now actually composites `Clip.blend_mode` (`Clip.blendMode`
on the TS side), closing the gap the note above tracked. `SCHEMA_VERSION` in
`engine/python/framepilot_engine/timeline/models.py` is bumped to **8**
(`test_schema_parity.py` is green again) and `Clip.blend_mode: BlendMode |
None` mirrors the TS field alias-for-alias, same convention as
`speed`/`crop`.

### Base layer vs. blend layer

`compile_timeline` (`engine/python/framepilot_engine/render/compiler.py`)
composites track 0 **last** — it is the visual front (see that function's
"Assemble z-order" comment: `reversed(picture_by_track)`, and MoviePy paints
later list items on top). So for a clip carrying `blend_mode`:

- **base** (`a` in every formula) = the frame already composited from every
  layer *beneath* that clip — i.e. every lower-z-order track's picture that
  overlaps this instant, already flattened into one RGB frame.
- **blend** (`b` in every formula) = the blend-mode clip's own picture (after
  its own color grade/transform/crop/speed — the same frame that would have
  been alpha-composited on top anyway), about to be composited **onto** the
  base.

This is the natural reading of "this clip blends onto what's beneath it" and
is why a clip alone on the bottom of the stack (nothing beneath it) is a true
no-op: there is no `a` to blend `b` against, so the clip is placed as-is (see
"No-op scoping" below).

### Alpha + blend mode composition

A blend mode changes *how* two RGB frames combine — it never bypasses the
clip's own opacity/mask. The compositor still respects alpha the standard way
every real compositor does: compute the blended RGB from the formula, then
alpha-composite *that result* with the base using the clip's existing alpha,
i.e. `result = base * (1 - alpha) + blended(base, blend) * alpha`. A fully
opaque clip (`alpha = 1` everywhere) is therefore 100% blended color; a
partially transparent one (opacity < 1, a feathered mask, a fade transition)
proportionally mixes the blended result back toward the unmodified base.

### Compositing architecture: progressive fold vs. one-shot

Pre-v8, `compile_timeline` built the entire video composite in one
`CompositeVideoClip(all_layers)` call. Blend modes need per-layer access to
"everything beneath this layer, already flattened to one RGB frame" — not
achievable from inside a single MoviePy composite call (MoviePy has no
blend-mode hook). The compiler therefore folds layers **progressively**
back-to-front (`_composite_with_blend_modes`): the bottommost layer seeds the
running composite; each later layer either joins it the plain alpha-over way
(`'normal'`/absent, via a fresh `CompositeVideoClip([running, layer])` —
behaviorally identical to the one-shot call) or is folded in with
`_blend_layer_over`, which per-frame renders the layer alone against a
*transparent* background (to recover its true per-pixel coverage — MoviePy's
`CompositeVideoClip` builds a real coverage mask in that case, distinguishing
a clip's own black pixels from an uncovered letterbox bar, which plain RGB
sampling cannot), applies the NumPy blend formula, then alpha-composites the
result over the running base.

**Regression safety:** when no clip in the timeline sets a non-`'normal'`
blend mode (the overwhelming majority of timelines today and for the
foreseeable future), `compile_timeline` takes the **original, untouched**
single-`CompositeVideoClip` code path — not the progressive fold. This is a
correctness choice, not just an optimization: it guarantees every pre-v8
render is byte-identical to its v8 output, with zero risk of the progressive
fold's extra 8-bit quantization passes introducing drift for the common case
(verified by `test_compile_normal_blend_mode_is_byte_identical_to_absent`).

### NumPy formulas (`framepilot_engine/render/blend.py`)

All operate elementwise on `[0, 1]`-normalized `(H, W, 3)` float64 arrays,
`a` = base, `b` = blend:

| Mode | Formula |
| --- | --- |
| `multiply` | `a * b` |
| `screen` | `1 - (1-a)(1-b)` |
| `darken` | `min(a, b)` |
| `lighten` | `max(a, b)` |
| `overlay` | `b < 0.5 ? 2ab : 1 - 2(1-a)(1-b)` (discriminates on `b`, the blend layer) |
| `hard-light` | same expression, discriminates on `a` instead (`a < 0.5 ? 2ab : 1 - 2(1-a)(1-b)`) — "overlay with a/b swapped" |
| `color-dodge` | `b == 1 ? 1 : min(1, a / (1-b))` |
| `color-burn` | `b == 0 ? 0 : 1 - min(1, (1-a) / b)` |
| `soft-light` | W3C compositing-1: `d(a) = a<=0.25 ? ((16a-12)a+4)a : sqrt(a)`; `b<=0.5 ? a-(1-2b)a(1-a) : a+(2b-1)(d(a)-a)` |
| `difference` | `abs(a - b)` |
| `exclusion` | `a + b - 2ab` |

Division-by-zero at the exact 0/1 boundary in `color-dodge`/`color-burn` is
guarded with a `np.clip(denominator, 1e-6, None)` floor — invisible in the
output since the numerator is already bounded to `[0, 1]` and the `b == 1`/
`b == 0` cases are handled by the `np.where` branch before the division ever
matters.

### No-op scoping (still not schema/validator-enforced)

A clip with nothing beneath it (the sole clip on a base video track, or one
whose timeline span has no overlapping lower-z-order clip at a given instant)
renders unchanged: `_composite_with_blend_modes` seeds the running composite
from the bottommost layer without ever calling `_blend_layer_over` on it, and
per-instant, `_blend_layer_over` passes the base through untouched whenever
the blend-mode clip isn't active at that `t`. Verified by
`test_compile_base_track_blend_mode_is_a_noop_not_a_crash` — this is
"renders as if `blend_mode` were absent," not a crash or an error, matching
this ADR's original documented (not enforced) scoping.

### Known limitation: feathered-edge double-attenuation

`_blend_layer_over` recovers a blend-mode clip's coverage mask by compositing
it alone against a transparent background and reading MoviePy's own
`CompositeVideoClip` mask — but MoviePy's internal Pillow compositing already
premultiplies partially-transparent edge pixels toward that transparent
background before the mask is read back out. At a **feathered** mask edge or
mid-fade-transition frame (fractional alpha, not the common 0/1 case), this
means the RGB this module blends against may already be slightly
alpha-attenuated once, and `_blend_layer_over`'s own
`base*(1-alpha)+blended*alpha` step attenuates it a second time — a subtle,
edge-only darkening, not a full-clip color error. Full clips, and any pixel
at alpha 0 or 1 (the vast majority of practical `overlay`-track usage), are
unaffected. Documented here rather than fixed now: correcting it needs
un-premultiplying MoviePy's internal composite before reading it back, which
is a materially bigger change than this slice's scope; a future pass can
revisit if feathered-edge blend-mode compositing turns out to matter in
practice.
