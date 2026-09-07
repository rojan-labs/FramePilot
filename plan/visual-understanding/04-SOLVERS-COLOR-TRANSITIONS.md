# 04 — Phases VU3–VU4: numbers come from measurements, not from the model

**User outcome.** "Match clip 3 to clip 1" produces a grade that measurably closes the gap
and is verified. "Make it warmer" moves the measured baseline by a known step. "Add
transitions where they belong" adds a dissolve at the time jump and nothing at the
continuity cut, at a duration that fits the pacing.

**Scope gate.** Gap: `apply_color_grade` values and `add_transition` kinds are guessed
(`00-DIAGNOSIS.md` §2.4). Minimum slice: three color tools and one `reason` argument, each
emitting operations that already exist. Reuse: `COLOR_GRADE_PARAMETER_CONTRACTS`,
`temporal-evidence` `scope`/`comparison`, the transition catalog and its params, `list_edit_boundaries`.
Deferred: LUT generation, per-region grading, new render kinds, any new schema.

## VU3 Deterministic color

### VU3.1 The color model `[x]` (2026-09-07) — arithmetic exact, coefficients UNFITTED

The renderer's grade is a parameter set with fixed ranges. The solver maps measured deltas
onto those parameters with a calibrated, invertible model that is **fitted once against the
renderer**, not guessed:

1. Render `ref/colorchart.png` and `ref/slow-cinematic-4k.mov` keyframes through
   `apply_color_grade` at a grid of parameter values (exposure −2..2, temperature −1..1, etc.)
   via `/render/frame`, measure each with `scope`, and fit per-parameter response curves
   (luma.mean vs exposure, warmth vs temperature, satMean vs saturation, contrastIdx vs
   contrast). Store the fitted coefficients as constants in `editor-core/src/color-solver.ts`
   with the fixture hashes; a test re-fits and asserts the constants within tolerance so a
   renderer change breaks the test, not the user's grade.
2. `solveColorMatch(target: Measured, reference: Measured): GradeParams` inverts the curves:
   exposure from `log2(ref.luma.mean / target.luma.mean)` through the fitted response,
   temperature from Δwarmth, saturation from the satMean ratio, contrast from the contrastIdx
   ratio, shadows/highlights from Δp5/Δp95 after exposure. Clamp to the contracts; report
   `clamped: true` so the tool can say the match is partial.
3. Skin protection: when both sides have `skin_*` channels with enough samples, cap the
   temperature/tint move so skin hue shifts stay under a fixed threshold (the `scope`
   request already measures skin channels).


### VU3.1 as built, and what is not yet true

The inversion is **derived from `engine/python/framepilot_engine/render/color.py`**, not
guessed: it honours the renderer's pipeline order (exposure → white balance → contrast →
shadows/highlights → saturation), solves each stage against what the previous ones leave
behind, and clamps before the next stage predicts from it. Two consequences of reading the
real pass: exposure and contrast both scale chroma, so warmth and saturation are solved net
of them (which is why "brighter" returns pure exposure and not an unrequested temperature
move); and shadows/highlights each move BOTH percentiles, so they are one 2×2 solve rather
than two nudges.

**The coefficients are UNFITTED.** All three response constants sit at 1.0 — the
no-clipping value — and the fit will move them below. `packages/ai-sdk/scripts/fit-color-response.mjs`
runs the real fit against a live sidecar and prints the constants to replace. Its header
names the one thing it cannot settle: `scope` has no U/V channel, so the chroma matrix and
range (full-range BT.709 is assumed) need a second `signalstats` pass over a rendered file.
White balance's second-order effect on saturation is modelled as zero and named as a gap.

**No test asserts a fitted number** — signs, orderings, bounds and invariants only.
Freezing a provisional coefficient as an expected value would turn a guess into a
regression gate and make the real fit look like a bug.

A finding worth keeping: under this renderer's white-balance model the skin cap effectively
governs `tint` alone. A full-range temperature move shifts a mid-tone skin hue by about 3°,
because pushing red up and blue down moves skin ALONG its own hue line; a full-range tint
move shifts it about 33°. That matches colourist practice, but it is a property of the model
rather than a measured fact about faces.

### VU3.2 Tools `[ ]`

| Tool                 | Args                                     | Behaviour                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match_color`        | `targetClipIds[]`, `referenceClipId`     | measure both (fresh `scope` over the clips, cached per revision, falls back to ledger `measured` for un-renderable states) → solve → one `apply_color_grade` per target → re-measure → report residual; at most one correction iteration |
| `normalize_exposure` | `trackId`, `anchor: 'median' \| clipId`  | outliers beyond a fixed luma tolerance get a grade toward the anchor; others untouched                                                                                                                                                   |
| `apply_look`         | `clipIds[] \| trackId`, `look`, `amount` | `look ∈ warmer, cooler, punchier, flatter, brighter, darker, cinematic, clean`; `amount ∈ subtle, medium, strong` → fixed deltas in fact units applied through the solver relative to the measured baseline                              |

`apply_color_grade` with raw numbers stays for explicit numeric requests and for the UI, but
its description tells the model to prefer the three above. `measure_color` stays as an
inspection tool. All emit the existing `apply_color_grade` operation, so undo, validation and
render are unchanged.

### VU3.3 Verification `[ ]`

After apply, the conductor requests `comparison: shot_match` for the target/reference pair
(exists in `temporal_evidence.py`). Residual within tolerance → fact `color_match ok`;
outside → one correction (solver re-run on the residual) then a fact either way. No loop.

### VU3.4 Evidence `[ ]`

- Fit test: coefficients re-derived from the fixtures within tolerance.
- Solver unit tests: identity (match to self → zero grade), monotonicity, clamping, skin cap.
- Render-backed: on `mission-montage.fp.json`, match `b3-1080p60-15s` to `b1-4k30-22s`;
  measured Δluma.mean and Δwarmth after the grade under 25% of the pre-grade delta. Record the
  numbers.
- Golden: `match-color-to-first-clip`, `warmer-subtle`. Rubric checks the applied params are
  within the solver's own output ± tolerance and that no other clip changed.

## VU4 Transition policy

### VU4.1 The policy `[x]` (2026-09-07)

`editor-core/src/transition-policy.ts`: `chooseTransition(reason, cut, pacing): Choice | null`.

| reason               | default                    | duration                             | rules                                                                                    |
| -------------------- | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `continuity`         | **none** (hard cut)        | —                                    | returns null unless the user named a kind; a transition here is the classic amateur tell |
| `time_jump`          | `cross-dissolve`           | `clamp(0.25 × medianShot, 0.4, 1.2)` | `dip-color` black when Δluma large and the incoming is dark                              |
| `location_change`    | `cross-dissolve` or `wipe` | as above                             | wipe only when `motionChange` is `up` and pacing is fast                                 |
| `energy` / `montage` | `zoom` or `slide` family   | `clamp(0.1 × medianShot, 0.15, 0.4)` | direction from the outgoing shot's dominant motion when known, else alternate            |
| `soften`             | `cross-dissolve` short     | 0.3–0.5                              | used to hide a `jump_cut` flag when the user asked to smooth                             |
| `reveal`             | `fade` from black          | 0.6–1.0                              | first cut only                                                                           |

Pacing = median picture-clip duration on the layer (from the semantic index). The policy
picks a **family** and then the catalog's default entry for that family, so the 50-entry
catalog stays for the UI and for explicit asks; the model sees seven reasons.

### VU4.2 Tool change `[ ]`

`add_transition` gains `reason` (required unless `kind` is given) and makes `kind`/`durationSeconds`
optional. `add_transitions` (plural) takes `reason` per cut or a rule (`'auto'`) that reads
`list_edit_boundaries` flags: `jump_cut` → soften, `location/setting change` → location_change,
otherwise continuity → none. The tool result names every cut it left as a hard cut and why.

### VU4.3 Evidence `[ ]`

- Policy unit tests per row; duration clamps; null on continuity.
- Golden: `transitions-where-they-belong` on `mission-montage`: expected dissolves at the
  two setting changes and none at the same-setting cuts; `no-collateral-changes` holds.
- `verify_transitions` reads the policy's own choice back (existing tool).

## VU4.4 B-roll ranking (small) `[ ]`

`rankBroll(candidates, sentence, aRoll)` in ai-sdk (pure): score = visual search score

- bonus for `screenContent: b-roll`, penalty for `duplicateOf` an already-used shot, penalty
  for `sameEntities` with the A-roll speaker (a cutaway to the same face is not b-roll), penalty
  for `soft`/`black` flags, bonus for motion class matching the sentence's energy words. Used by
  the b-roll skill and by `add_stock` placement. Evidence: `broll-first-20s` target resolution
  up; the ranking is printed in the tool result with reasons.

## Definition of done

`[ ]` VU3.1–VU3.4 · `[ ]` VU4.1–VU4.4 · `[ ]` editor-core, ai-sdk, engine suites green ·
`[ ]` ADR "Grades and transitions are solved from measurements; the model states intent" ·
`[ ]` skills `color`, `transitions`, `b-roll` updated to the new tools (editing-skills-expert) ·
`[ ]` docs + CHANGELOG · `[ ]` plan reconciled.
