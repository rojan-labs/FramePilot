# 17. Keyframe evaluation engine (easing + interpolation)

- Status: Accepted
- Date: 2026-06-25
- Phase: 5 (Professional Motion, Tracking & Masking)

## Context

Phase 5 begins with motion: zoom/punch-in, position, scale, rotation, opacity,
crop, blur, and audio-volume animation are all driven by **keyframes with
easing** (PRD §6.3). The data model already carries this — `Keyframe`
(`id/time/property/value/easing`) and clip/effect `keyframes[]` lists exist in
both the Zod schema (`packages/timeline-schema`) and the Pydantic mirror, and the
`add_keyframes` operation (with invert + validation) and the `add_keyframes` AI
tool already produce them. What was missing was the piece that gives keyframes any
meaning: a function that, given a property and a time, returns the concrete
**value** — the evaluation engine. The render compiler explicitly defers per-clip
keyframe rendering to "Phase 5/6", and nothing in the UI could compute an animated
value either.

A latent correctness bug also blocked this: the Python `Easing` enum used
underscored values (`ease_in`, `ease_out`, `ease_in_out`) while the canonical
contract — the Zod enum, the exported JSON Schema, and the AI tool registry (both
languages) — uses **hyphenated** names (`ease-in`, …). Stored keyframe `easing`
strings therefore could never have matched the enum's non-linear members.

## Decision

Build a small, **pure, deterministic** keyframe evaluation engine, implemented
once per language and kept in lock-step:

- TS: `packages/editor-core/src/keyframes.ts`
- Python: `engine/python/framepilot_engine/effects/keyframes.py`

Public surface (mirrored):

- `EASING_FUNCTIONS` — the six curves, each mapping normalized progress
  `t ∈ [0, 1] → eased t`. Endpoints are fixed at `0→0` and `1→1` so segment
  boundaries always land exactly on the keyframe values.
- `applyEasing(easing, t)` / `interpolate(start, end, t, easing)` — clamp `t`,
  apply the curve, then lerp. Unknown easing names fall back to `linear` (the
  engine must never crash a render on a stray string).
- `evaluateKeyframes(keyframes, property, time)` — the consumer API. Returns
  `undefined`/`None` when the property has no keyframes (caller uses the static
  value); otherwise holds before the first keyframe and after the last, and eases
  between two.
- `punchInKeyframes(...)` — a pure generator for the canonical zoom/punch-in move
  (two `scale` keyframes); the UI/AI layer feeds its output into `add_keyframes`.

Two semantic choices, made once and shared:

1. **Easing is "into the next keyframe."** Segment `a → b` is eased by **`a`'s**
   curve. This matches the existing `Keyframe.easing` doc comment and avoids the
   two-sided-influence model (After Effects style), which the single `easing`
   field cannot represent.
2. **`hold` holds, then snaps.** `hold` returns the start value for the whole
   segment and the end value only exactly at `t === 1`, so an interior held
   keyframe still reads its own value.

`bezier` is defined as the smoothstep cubic (`3t² − 2t³`) for now; per-keyframe
bezier control handles are a **future schema addition** (the `Keyframe` model has
no control points today) and are intentionally out of scope — adding them is a
schema change (migration + parity + tests).

The Python `Easing` enum is corrected to the canonical hyphenated values, closing
the contract mismatch.

## Consequences

- **No schema change, no migration.** This is pure behavior over the existing
  `Keyframe` shape. Both engines stay at 100% coverage
  (`editor-core` branch threshold; `effects` module 100%).
- The two implementations are byte-for-byte equivalent in behavior; their tests
  mirror each other so drift is caught.
- **Unblocks the rest of Phase 5**: render wiring (the compiler evaluating
  transform keyframes per frame), the keyframe editor UI, mask keyframes, and
  tracked-text/callout motion all consume `evaluateKeyframes`. These are the next
  reviewable slices and are _not_ in this change.
- A defensive zero-span guard was removed from the segment lookup in both engines
  because the earliest bracketing pair provably has `left.time < right.time` once
  `time` is strictly inside the range; the invariant is documented inline rather
  than left as untestable dead code.

## Alternatives considered

- **Evaluate inside the render compiler only.** Rejected: the UI needs the same
  math for a live preview, and putting it in `editor-core` keeps it pure and
  shared, honoring the build order (engine math before render/UI).
- **Two-sided easing (in/out per keyframe).** Rejected for now: not expressible
  with the single `easing` field; would require a schema change.
