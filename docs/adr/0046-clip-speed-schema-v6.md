# ADR 0046 — Clip constant speed / time-remap (schema v6)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Builds on:** ADR 0001 (reversible operations), ADR 0031 (track flags,
  schema v4), ADR 0045 (caption style, schema v5).
- **Part of:** Horizon 1 (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C5, WS-C), H1.2 —
  the second of five schema bumps (v5–v9), each its own small commit.

## Context

Today a `Clip`'s timeline duration (`end - start`) and source duration
(`sourceEnd - sourceStart`) are always equal — every operation that touches a
clip's edges (`trim_clip`, `split_clip`, `delete_range`'s `subtractRange`,
`ripple_delete`) maps timeline deltas onto the source range 1:1. That is an
*implicit* 1x playback rate; nothing in the schema names it, and there is no
way to author 2x speed-up, 0.5x slow-motion, or any other constant-rate
time-remap. The plan calls for "decouple source vs timeline duration; speed
curve" as part of Horizon 1's editing-power work (WS-C).

## Decision

### `Clip.speed` — a constant playback rate, not a curve

`ClipSchema` gains one new optional field:

```ts
speed: z.number().positive().optional();
```

`speed` absent (or, canonically, `1`) is exactly today's behavior. A `speed !=
1` **decouples** timeline duration from source duration by this invariant:

```
end - start === (sourceEnd - sourceStart) / speed
```

`sourceStart`/`sourceEnd` keep their existing meaning — "the asset range this
clip consumes" — unchanged by speed. `end` becomes a *derived* quantity: 2x
speed consumes the same footage in half the timeline time; 0.5x slow-mo
stretches the same footage across twice the timeline time.

**Why a constant rate instead of a speed curve:** the plan explicitly floats a
"speed curve" (multiple rate keyframes over a clip — e.g. ramp from 1x to 4x
mid-clip). We considered reusing `Clip.keyframes` (`property: 'speed'`,
`evaluateKeyframes` from the Phase 5 keyframe engine) so a curve would cost no
new schema shape. We rejected building that now for three reasons:

1. **Scope discipline.** The plan explicitly calls the curve "a natural
   additive v6.x extension later, not required for the acceptance bar" for
   this slice. A curve changes what `end` even means (it's no longer a closed-
   form division — it's an integral of the rate function over source time),
   which is a materially bigger render-engine and validator problem than this
   commit's budget.
2. **`evaluateKeyframes` evaluates a property at a point in time; it does not
   integrate a rate over an interval.** Reusing it for speed would need new
   integration machinery in the keyframe engine itself (both TS and Python),
   which is out of scope for a schema-only slice that explicitly excludes
   engine/render changes.
3. **The common cases (2x, 0.5x slow-mo, freeze-adjacent speed ramps built from
   several whole clips) are all served by a constant rate per clip.** A editor
   can already build a "ramp" by speed-varying several adjacent clips (each
   split off the same source) — exactly how ADR 0045's caption styling avoided
   over-engineering a free-form params bag before the concrete UI need for a
   curve exists.

The tradeoff: a true intra-clip speed ramp is not representable in v6. When
that need is concrete, the natural extension is `Clip.keyframes` entries with
`property: 'speed'` plus a new `evaluateKeyframes`-style integrator — additive,
no new schema shape required, and this ADR's invariant becomes the "average
speed" special case of that curve.

### Operation: `set_clip_speed`

A new reversible timeline operation:

```ts
interface SetClipSpeedOp {
  type: 'set_clip_speed';
  clipId: string;
  speed: number | null; // null resets to 1x
}
```

`applySetClipSpeed` resolves `speed ?? 1`, rejects non-positive/non-finite
values with `OperationError('invalid_speed', …)` (the same "validate before
apply" defensive re-check `set_caption_style` does for its own shape), and
recomputes `end = start + sourceDuration / speed` — `sourceStart`/`sourceEnd`
are never touched by this op. `1x` is canonicalized as an **absent** `speed`
field (mirrors `set_track_flags` canonicalizing "off" as absent): a reset
lands on a deep-equal timeline to a clip that never had a speed set, which
keeps `deep-equal` round-trip assertions meaningful and keeps unset clips out
of the serialized project file.

Same-shape, exact inverse (the `set_track_flags`/`set_caption_style`
precedent): `invertOperation` returns a `set_clip_speed` carrying the clip's
prior speed (`clip.speed ?? null`). Because the clip's source range is
untouched by this op, re-applying the prior speed deterministically
recomputes the prior `end` too — no separate "restore start/end" op is needed.

**Ripple-vs-isolated scope:** `set_clip_speed` only ever rewrites the target
clip's own `end`. It does **not** ripple/shift downstream clips on the same
track, matching `trim_clip`'s convention exactly (trimming a clip's edges can
open a gap or create an overlap; the validator's `overlap_error` check is what
catches an overlap, same as it would for a manual trim). A ripple variant
(re-flowing every subsequent clip, à la `ripple_delete`) is a plausible future
op but is out of scope here — inventing new ripple semantics for one op alone,
instead of an explicit `ripple_delete`-style counterpart, would be
inconsistent with how every other edge-changing op in this file works.

### Validator: clip-internal speed/duration consistency

The patch validator (`validatePatch`) gains a new whole-timeline check run
after every operation (alongside `overlapChecks`/`transitionOverlapChecks`),
`speedConsistencyChecks`: for every clip on every track, `end - start` must
equal `(sourceEnd - sourceStart) / (speed ?? 1)` within a `SPEED_EPSILON`
(`1e-6`, looser than the module's `1e-9` additive-comparison epsilon because
this check involves a division). A violation is `speed_duration_mismatch`
(error severity). This runs for **every** clip regardless of which operation
produced it — a hand-crafted or externally-authored clip (e.g. injected via
`restore_clips`) whose fields disagree is rejected exactly like an overlap
would be, not only clips touched by `set_clip_speed`.

A new `OperationError` code, `invalid_speed`, is mapped to a new
`ValidationCode: 'invalid_speed'` (the non-positive/non-finite input case);
`set_clip_speed` is registered in `SUPPORTED_OPERATIONS`.

**Known limitation (documented, not silently dropped):** `trim_clip`,
`split_clip`, `delete_range`, and `ripple_delete` still map timeline deltas
onto the source range 1:1 (unaware of `speed`). Applied to a clip that already
has `speed != 1`, the resulting clip could fail `speed_duration_mismatch` —
e.g. trimming a 2x clip's edges without also rescaling the source-range delta
by `speed` breaks the invariant. This is intentionally out of scope for this
schema-only slice (the task explicitly excludes reworking every edge-changing
op to be speed-aware); it is surfaced by the validator (a rejected patch, not
a silently-wrong render) and is a natural follow-up once a UI trims sped-up
clips in practice.

### Migration: v5 → v6

Purely additive, like every prior step: a v5 clip has no `speed`, which *is*
1x (today's implicit 1:1 timeline/source-duration behavior), so
`migrate: (raw) => raw` — the step exists only to stamp the new envelope
version.

## Consequences

- Schema bumps to **v6**; `schema/project.schema.json` is regenerated from the
  Zod source (`pnpm --filter @framepilot/timeline-schema build && … schema:generate`).
- `packages/editor-core` gains `set_clip_speed` (apply/invert/validate, 100%
  branch/line/func coverage) mirroring `set_caption_style`'s exact-inverse
  pattern.
- **Python engine, AI tool registry, and UI are explicitly out of scope for
  this commit** — this is a schema + patch-engine-only slice (per the task's
  build order: engine before AI/UI). Until the Python `Clip` Pydantic model
  gains the matching `speed` field, `engine/python/tests/test_schema_parity.py`
  will report a field mismatch on `Clip` — a known, tracked gap for the engine
  follow-up (rendering a sped-up clip via MoviePy's `speedx`/time-remap and
  wiring a `set_clip_speed` AI tool), not a silent drift.

## Addendum (H1.2b) — engine render

The Python side of this gap is now closed: `Clip.speed` was added to
`framepilot_engine/timeline/models.py` (mirroring `caption_style`'s alias
convention; `SCHEMA_VERSION` bumped to 6), and
`framepilot_engine/render/compiler.py` now actually time-remaps a clip whose
`speed` is set, rather than accepting-but-ignoring the field. Two decisions
made in that follow-up, recorded here rather than left implicit in code:

**MoviePy API used:** `vfx.MultiplySpeed(factor=speed)` via
`source.with_effects([...])` — this codebase's installed MoviePy is 2.x,
which has no `.fx()`/`speedx` (both 1.x-only); `MultiplySpeed` is the 2.x
equivalent and, applied before audio is split off the video source, threads
the same time-remap through the clip's attached audio and mask in one call
(`Effect.apply_to = ["mask", "audio"]`), so video, audio, and any mask stay in
sync automatically. It is applied in `compile_timeline` for both picture-kind
clips (video) and standalone audio-kind clips — the only two clip kinds that
have a time dimension speed can act on (stills have none).

**Pitch-shift decision: accepted as a known limitation, not fixed here.**
`MultiplySpeed` (like the old `speedx`) resamples audio purely in the time
domain, so 2x speed pitches audio up and 0.5x slow-mo pitches it down. This
codebase's audio pipeline (`framepilot_engine/audio/mixing.py`) has gain/fade/
duck/normalize primitives but no pitch-preserving time-stretch (e.g. a phase
vocoder), and building one is out of scope for this slice — it would be new
DSP, not reuse of an existing capability. The MVP therefore accepts
pitch-shifted audio on sped-up/slowed-down clips as an honest, documented
limitation (both in code — `_apply_speed`'s docstring — and here). A
pitch-preserving option is a plausible follow-up once a concrete need
(e.g. dialogue-heavy sped-up clips sounding "chipmunked") makes it worth the
DSP investment.

**Render-time invariant enforcement:** the schema validator already guarantees
`end - start == (sourceEnd - sourceStart) / speed` at patch-apply time, so the
render path should never see a mismatch. `_apply_speed` defensively checks the
post-remap duration against the clip's timeline span anyway (within a small
frame-accuracy tolerance, mirroring the slack `_subclipped_source` already
tolerates for container-probe-vs-decoded-duration drift) and raises
`CompileError` — loud and typed — rather than silently rendering a
misaligned clip if that invariant is ever violated (e.g. a hand-crafted or
externally authored project file that bypasses the TS validator).
