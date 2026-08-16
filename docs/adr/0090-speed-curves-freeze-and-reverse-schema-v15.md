# ADR 0090 — Speed curves, freeze and reverse (schema v15)

- **Status:** Accepted
- **Date:** 2026-07-31
- **Supersedes:** nothing. **Extends:** ADR 0046 (clip speed, schema v6), taking the
  extension path that ADR pre-blessed and closing the known limitation it recorded.
- **Plan:** `plan/PREVIEW-INSPECTOR-KEYFRAME-TRANSITION-REVAMP.md` §4.1, Phase 10.

> **Numbering note.** The sub-plan reserved v14/ADR 0089 for speed ramps and
> v15/ADR 0090 for keyframe bezier handles. Handles landed first, and both a schema
> version and an ADR number are assigned by landing order, so the two swapped.
> Neither decision changed, only the sequence.

## Context

ADR 0046 gave a clip a **constant** playback rate with one invariant:

```
end - start === (sourceEnd - sourceStart) / speed
```

and `speed: z.number().positive()`. That shape cannot express three things editors
reach for constantly:

1. **A ramp** — speed that changes across the clip (the montage/hero/bullet-time
   look). A single number has no shape.
2. **A freeze frame** — `0` is not positive, and the invariant divides by it.
3. **Reverse** — negative is not positive, and the invariant would produce a
   negative duration.

ADR 0046 also recorded a **known limitation** that has been live ever since:
`trim_clip`, `split_clip`, `delete_range` and `ripple_delete` mapped timeline deltas
onto the source range **1:1, unaware of `speed`**. Trimming a 2x clip therefore
produced a clip that failed the validator's own `speed_duration_mismatch` — an
ordinary edit the product refused. A ramp makes that strictly worse, so it had to be
fixed *with* this change rather than after it.

## Decision

### 1. `speed` widens to any finite number

- `0` ⇒ **freeze frame**. A single held source frame. **The duration invariant does
  not apply** — dividing by zero has no answer, so a held frame's length is *set*,
  not derived, and the validator skips the check rather than inventing an
  expectation that would make every freeze invalid.
- `< 0` ⇒ **reverse**. The source range is consumed backwards, which still takes
  positive timeline time, so the invariant uses the **magnitude**:
  `end - start === (sourceEnd - sourceStart) / |speed|`.

### 2. `Clip.speedRamp?: SpeedPoint[]` — speed as a curve

```ts
SpeedPoint = {
  id: string;
  sourceTime: number;   // clip-relative SOURCE seconds
  rate: number;         // > 0
  easing: Easing;       // curve into the next point
}
```

Present and non-empty ⇒ the curve governs; absent ⇒ constant `speed`. Setting either
clears the other, so a clip never stores two contradictory rates.

**`sourceTime` is source time, not timeline time.** This is the load-bearing choice.
Timeline time is the *integral* of the rate over source time, so a point anchored in
timeline time would move whenever an **earlier** point changed — editing the first
point of a ramp would silently drag the whole rest of the curve along the footage.
Anchored in source time, each point stays on the frame the user put it on.

### 3. The invariant becomes its integral form

```
end - start === ∫ (1 / rate(s)) ds     over s ∈ [0, sourceEnd - sourceStart]
```

with ADR 0046's division falling out **exactly** when `rate` is constant (asserted in
both suites, for five different rates). `speedConsistencyChecks` switches to this
form via one shared function, `clipTimelineDuration`, which every edge-changing
operation also uses — if the validator computed its own, a trim could be rejected by
a rule slightly different from the one that produced the clip. That divergence is
precisely how ADR 0046's known limitation arose.

### 4. Rates in a ramp are strictly positive — a deliberate scope line

Freeze and reverse are the **constant** cases only. A rate that reaches or crosses
zero makes the timeline↔source mapping non-invertible: the integral stops being
strictly increasing, so "which source frame belongs at this output time?" has no
single answer, and `sourceTime`-anchoring — chosen precisely to keep the mapping
stable — buys nothing. Ramping *through* a freeze or into reverse is therefore a
further step needing its own model (most likely explicit segments with durations,
not a rate curve), not something to smuggle in by relaxing a bound.

Outside a curve's own span the rate is **held** at the nearest end point rather than
extrapolated. Extrapolating an accelerating curve would keep accelerating past the
end of the footage and could cross zero — exactly what the bound forbids.

### 5. `set_clip_speed_ramp`, a new operation

Same shape and same inverse strategy as `set_clip_speed`: the op carries the whole
ramp, so the inverse carries the prior one, and re-applying it deterministically
recomputes the prior `end` because the *source* range is untouched.

**The two ops share one inverse**, because they are one axis: each clears the other,
so undoing either must restore whichever of the two the clip actually had. Two
separate inverses would each restore only their own half, and a ramp undone through
`set_clip_speed` would come back as a constant rate — a silent loss of the curve.

**A prior freeze inverts through `restore_clips`, not the same-shape op.** ADR 0046's
same-shape inverse works because re-applying the prior speed recomputes the prior
`end`. At `speed === 0` there is no duration to recompute, so `set_clip_speed(0)`
would leave whatever `end` the *undone* speed produced. The track snapshot is this
codebase's established answer for a lossy op (`delete_range`, `ripple_delete`,
`remove_keyframes`).

### 6. The four edge ops become speed-aware

`truncateClip` — already shared by `delete_range` and `ripple_delete` — now maps
edges through the clip's speed, and `trim_clip` and `split_clip` route through it too,
so the four cannot disagree. Three cases:

- **Freeze**: the source range is left **untouched**. A held frame consumes no
  footage however long it is held; consuming source proportionally would shrink the
  range to nothing and make a freeze impossible to trim.
- **Reverse**: trimming the timeline *head* consumes footage from the source **end**.
  Getting this backwards is invisible in the duration check and obvious in the
  picture.
- **Forward, constant or ramped**: the integral mapping, with the ramp **re-based**.
  Re-basing matters: without it, splitting a ramped clip leaves both halves carrying
  the whole original curve, so each renders the wrong speeds. Points that fall before
  the new origin are replaced by **one synthetic point carrying the rate at the cut**
  rather than dropped — dropping them would leave the head of the clip running at the
  first *surviving* point's rate, silently changing the speed of footage the trim did
  not remove.

`split_clip` in particular used to take the **linear** fraction of the source span,
which is right for a constant rate and wrong for a curve: on a clip that starts slow
and ends fast, halfway in *time* is nowhere near halfway in *footage*, so a split
placed on a gesture cut somewhere else entirely.

### 7. Numerical method: fixed-step, in both languages

`editor-core/src/speed-curve.ts` and `framepilot_engine/effects/speed_curve.py` are a
parity pair. The integral has no closed form for an eased rate curve, so it is
**Simpson's rule with a fixed 128 sub-intervals per curve segment**, and the
inversion is **60 fixed bisection steps**.

**Fixed counts, not convergence tests** — the same lesson ADR 0089's bezier solver
recorded, and it bites harder here. An adaptive quadrature runs a different number of
steps in the two languages the moment their intermediate rounding differs by one ulp,
and then the preview and the export disagree about **how long a clip is**. That is
not a cosmetic drift like a slightly different ease: it desynchronises everything
after the clip.

Integration is **piecewise**, split at every control point, because the rate curve
has a kink at each one and Simpson is exact on a smooth piece but badly wrong across
a corner. The split is what buys the accuracy, not the step count.

128 rather than a cheaper 64 because **no fixed quadrature is exactly additive across
a split point**: splitting changes the sampling grid, so each half carries slightly
different error. At 64 that error is ~6e-8, uncomfortably close to the 1e-6
`SPEED_EPSILON` the validator enforces. Simpson is O(h⁴), so doubling cuts it ~16× to
~4e-9 — three orders of margin, for arithmetic nobody will notice.

**Numeric parity is a committed fixture**, `packages/editor-core/fixtures/speed-curve-parity.json`:
252 cases across seven curves (constant, a hero ramp, a `hold`-stepped curve, an
extreme flash-in, a single point, deliberately unsorted-and-duplicated input, and a
bezier ramp), asserted to 1e-9 in both suites. `test_schema_parity.py` proves the two
schemas have the same *shape*; it cannot prove two numerical integrators produce the
same *numbers*, and the numbers are the clip's length.

### 8. Render

`_apply_speed` keeps `vfx.MultiplySpeed` for the constant forward case — the existing
fast path, byte-identical. The three new cases each need a different primitive:

- **Ramp** → `time_transform` fed `source_time_at`, the inverse-integral mapping. The
  *same function* the validator and editor use, so the render cannot disagree with
  the timeline about where a frame is. `MultiplySpeed` structurally cannot express a
  ramp: it scales time by one constant factor.
- **Freeze** → `time_transform` mapping every output time to the clip's first source
  instant. There is no factor that makes `MultiplySpeed` stop.
- **Reverse** → `TimeMirror` *plus* `MultiplySpeed(|speed|)`. Reversal and rate are
  separate primitives; `TimeMirror` alone plays backwards at 1x, which is not what a
  −2x clip means.

## Consequences

### Audio, stated honestly

**Constant speed** keeps ADR 0046's documented limitation unchanged: `MultiplySpeed`
resamples in the time domain, so a sped-up clip's audio pitches up. This ADR does not
make that worse and does not fix it.

**Freeze drops audio.** A held audio sample is a DC offset — silence with a click at
each edge. Silence is the honest render of a frozen frame and is what every NLE does.

**Ramped audio is the open one.** `time_transform` on a clip with audio applies the
same mapping to the audio stream, which pitch-shifts continuously. There is no
pitch-independent time-stretch in MoviePy and this codebase has no DSP for one. The
two honest routes are an FFmpeg `atempo` chain (no new dependency, but `atempo` is
per-segment and would need the ramp discretised) or dropping audio on ramped
segments. **Neither is implemented here**; the first slice ships the picture correct
and the audio pitch-shifted, matching the constant-speed precedent, and this is
recorded rather than discovered. Choosing between the two belongs with the ramp UI
(Phase 10c/10d), where there is a control to expose the trade-off on.

### Migration v14 → v15

Pure passthrough. A v14 clip has no `speedRamp` and a `speed` that was already
positive, which is exactly the constant-rate case — so every v14 project renders
byte-identically.

### What this closes and what it opens

Closes ADR 0046's known limitation: trimming, splitting and range-deleting a
non-1x clip now produce valid clips instead of rejected patches.

Opens: ramping through zero or into reverse (§4), pitch-preserved ramped audio
(above), and a ripple-aware speed change (ADR 0046 §"Ripple-vs-isolated scope" still
stands — `set_clip_speed_ramp` rewrites only the target clip's `end`, exactly like
`trim_clip`, and an overlap it opens is caught by the validator's existing check).
