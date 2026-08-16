# 0089. Custom keyframe curves as per-keyframe bezier handles (schema v14)

- Status: Accepted
- Date: 2026-07-31

## Context

`Keyframe.easing` is a closed enum: `linear`, `ease-in`, `ease-out`, `ease-in-out`,
`hold`, `bezier`. Five of those six are fixed curves. The sixth is misleadingly named
— `bezier` is not a bezier at all, it is a hardcoded smoothstep (`3t² − 2t³`) with no
control points anywhere in the schema. So a user who wanted a curve the enum does not
contain — a slow start with a hard landing, an overshoot that settles, an anticipation
dip before a move — could not express it. This is diagnosis **F9** in
`plan/PREVIEW-INSPECTOR-KEYFRAME-TRANSITION-REVAMP.md`.

Three things constrain the fix.

**Every existing project must render byte-identically.** `bezier` is already stored in
real projects, meaning smoothstep. Any change that makes it mean something else
silently rewrites motion a user already approved.

**Two engines evaluate keyframes.** `packages/editor-core/src/keyframes.ts` drives the
preview; `engine/python/framepilot_engine/effects/keyframes.py` drives the export.
They are already parity-maintained. A curve that resolves differently in the two would
be the render-vs-preview rule broken in the worst way — the picture you judge is not
the picture you get, and the difference is a subtle motion feel rather than an obvious
error, so it would ship.

**A cubic bezier is parametric, and that is not an implementation detail.** `y` is not
a function of `x`; both are functions of a parameter `s`. Evaluating the curve at a
given progress means *inverting* `x(s)` first. Any iterative solver has a convergence
policy, and two languages with different policies produce different numbers.

## Decision

### The shape: handles on the keyframe, two per segment

```ts
handles: z.object({
  out: BezierHandleSchema,  // shapes the segment INTO the next keyframe
  in:  BezierHandleSchema,  // shapes the segment FROM the previous keyframe
}).optional();

BezierHandleSchema = z.tuple([z.number().min(0).max(1), z.number()]);
```

A segment `a → b` is shaped by **`a.handles.out` and `b.handles.in`** — the same
two-sided convention CSS `cubic-bezier(x1, y1, x2, y2)` and every animation tool use.
That is *why* a handle lives on the keyframe rather than on the segment: a keyframe
sits between two segments and the user drags one pair of handles at it, not two
separate segment properties that happen to meet there.

**`x` is clamped to `[0, 1]`; `y` is deliberately unbounded.** An `x` outside the unit
interval makes the curve non-monotonic in time, which means the property travels
backwards partway through the segment — not a curve anybody asked for, and it breaks
the solver's assumption that `x(s)` is invertible. But `y > 1` (overshoot) and `y < 0`
(anticipation) are the *entire reason* to reach for a custom curve. Clamping `y` would
quietly flatten exactly the effect the user drew. Consumers that need a bounded result
— opacity, alpha — clamp at the point of use, which they already do.

### Absent handles mean smoothstep, not linear and not a default curve

This is the compatibility rule and it is the most important line in this ADR.

```
easing === 'bezier' && handles === undefined  ⇒  3t² − 2t³
```

Falling back to `linear` would flatten every existing `bezier` animation. Falling back
to "some sensible default bezier" would change them by a smaller, harder-to-notice
amount, which is worse. Falling back to the curve `bezier` has always meant is the only
option under which the v13 → v14 migration is a no-op in fact and not just in the data.
The migration is therefore a pure passthrough, and both engines assert the rule
directly.

A segment with a handle on only **one** side also falls back. Half a curve is not a
curve, and guessing the missing control point would be inventing motion.

### The solver is fixed-iteration, in both languages

`solveCubicBezier` / `solve_cubic_bezier` invert `x(s)` with **8 Newton-Raphson
iterations**, falling back to **20 bisection steps** when Newton leaves `[0, 1]` (which
it does on a near-vertical curve, where the slope vanishes and the step explodes).

Both counts are **fixed constants, not convergence tests**. A loop that runs "until the
residual is below ε" runs a different number of times in the two languages the moment
their intermediate rounding differs by one ulp, and then the two engines disagree.
Eight iterations is far more accuracy than a pixel or an audio sample needs on `[0, 1]`,
and it is the same eight everywhere.

The identity case (`x1 = 1/3, x2 = 2/3`) short-circuits, because it is the common
"straight handles" configuration a graph editor produces by default and the solver
would otherwise only approximate what is exactly linear.

### Parity is a committed numeric fixture

`packages/editor-core/fixtures/bezier-parity.json` holds 88 `(handles, x) → y` cases
across eight curves, including overshoot, anticipation, and two degenerate near-vertical
shapes. **Both** test suites assert against it to `1e-12`. Field-name parity
(`test_schema_parity.py`) proves the two schemas have the same shape; it cannot prove
the two solvers produce the same numbers, and the numbers are what the user sees.

Regenerating the fixture is a deliberate act accompanying an intended change to the
curve math — never a way to make a failing test pass.

## Consequences

**Schema version 14.** Migration `13 → 14` is a passthrough that stamps the envelope.
`SCHEMA_VERSION` moves to 14 in both `packages/timeline-schema/src/index.ts` and
`engine/python/framepilot_engine/timeline/models.py`, and
`schema/project.schema.json` is regenerated.

> **Numbering note.** `plan/PREVIEW-INSPECTOR-KEYFRAME-TRANSITION-REVAMP.md` §4 planned
> handles as **v15 / ADR 0090**, behind speed ramps at v14 / ADR 0089. Phase 7 landed
> before Phase 10, and both a schema version and an ADR number are assigned by landing
> order, so the two swapped. Speed ramps are **v15 / ADR 0090**. Nothing about either
> decision changed — only the sequence.

**`evaluateKeyframes` now routes through `segmentProgress`, not `interpolate`.**
`interpolate(start, end, t, easing)` only ever sees the *earlier* keyframe's easing
name, so it structurally cannot express a two-sided curve. It remains exported and
unchanged for the callers that legitimately have one easing and two values.

**Overshoot can produce out-of-range values.** A scale curve that overshoots yields
`scale > toScale` briefly; an opacity curve that anticipates yields a negative alpha.
Both engines already clamp where a value must be bounded (`_clamp01` in
`effects/transform.py`, `clampUnit` in `preview/picture-transform.ts`), so this is
absorbed at the point of use rather than by flattening the curve at its source. This
is stated here because it is the one behaviour a reader might mistake for a bug.

**What this does not add.** No new easing enum member — `bezier` is still the name, it
just gained the control points it always implied. No change to `hold`, and no
per-segment interpolation *mode* (step, smooth, auto-bezier); those are UI conveniences
that compile down to handles rather than new schema.

## Alternatives considered

**Store the curve on the segment instead of the keyframe.** Conceptually tidier — a
curve belongs to the gap, not the endpoint — but there is no segment object in the
schema, and adding one means every keyframe insertion, deletion and move has to
maintain a parallel list that can desynchronise. Handles on keyframes cannot
desynchronise, because a keyframe carries its own.

**Widen the easing enum with more named curves.** Cheaper, and it would cover the three
or four most-wanted shapes. But it is an unbounded list that never covers the next
request, and it does not give a graph editor anything to drag.

**Use a shared WASM solver so parity is structural rather than tested.** Genuinely
eliminates drift, and genuinely disproportionate: a build-toolchain dependency in both
runtimes for roughly forty lines of arithmetic. The fixture gets the same guarantee at
a fraction of the cost, and it fails loudly.
