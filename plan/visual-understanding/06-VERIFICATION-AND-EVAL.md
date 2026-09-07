# 06 — Phase VU0 (first) and VU7: measure blindness, then verify with pixels only where needed

## VU0 Baseline and contracts — do this before any code

### VU0.1 Blindness metrics in the golden harness `[ ]`

Add to `packages/ai-sdk/src/eval/golden-metrics.ts` (pure functions over the event stream):

| Metric                     | Definition                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `frames_seen_per_edit`     | `get_frame` calls + vision-review frames ÷ accepted edits                                                                               |
| `perception_calls_per_run` | `search_visual + describe_footage + map_footage + measure_color`                                                                        |
| `visual_target_resolution` | on cases whose target is defined by content ("the dark clip", "the street shot"), whether the resolved clip matches the labelled answer |
| `numeric_guess_rate`       | grade/transition operations whose values did not come from a solver result in the same run                                              |
| `picture_facts_in_prompt`  | count of clip rows with a fact suffix ÷ rows shown                                                                                      |

Run the 21 cases on `main` with the fixtures as they are (no ledger) and record the table in
`reports/golden/BASELINE.md` under "visual-understanding floor". This is the number the whole
plan is judged against.

### VU0.2 Labelled fixture set `[ ]`

`tests/fixtures/mission/labels/` (committed JSON, no media):

- `tier0.json`: per shot of the 5 videos + 60 photos: exposure class (dark/normal/bright),
  warmth class (cool/neutral/warm), motion class, sharpness class, black/freeze.
- `tier1.json`: shot size, subject kind, setting, screen content, face count, person cluster id.
- `tier2.json`: subject, setting, on-screen text for 50 shots.
- `cuts.json`: for `mission-montage`, per cut: same setting?, jump cut?, expected transition
  reason under "add transitions where they belong".

Labelling is one afternoon with a contact sheet; the sheet generator is a script in
`packages/ai-sdk/scripts/contact-sheet.mjs` that uses `/render/frame` (kept as a dev tool, not
an agent tool).

### VU0.3 New golden cases `[ ]`

Add to `golden-cases.ts` with rubrics on edit state or answer content:

| id                              | request                                                    | what proves understanding                                     |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `which-clips-show-host`         | "which clips show the host?"                               | answer names the labelled clips, zero frames                  |
| `whats-on-screen-at`            | "what's on screen at 0:42?"                                | answer matches `tier2` label, zero frames                     |
| `find-dark-clips`               | "which clips are underexposed?"                            | matches `tier0` exposure labels                               |
| `match-color-to-first-clip`     | "match clip 3's color to clip 1"                           | solver params applied; residual measured under tolerance      |
| `warmer-subtle`                 | "make it a little warmer"                                  | one `apply_color_grade` per clip with the look table's deltas |
| `transitions-where-they-belong` | "add transitions where they belong"                        | dissolves at labelled setting changes, none elsewhere         |
| `broll-over-sentence`           | "put b-roll of the street over the sentence about traffic" | placed shot has `setting: street`, not the speaker            |
| `remove-duplicate-takes`        | "drop the duplicate takes"                                 | clips with `duplicateOf` removed, others intact               |

### VU0.4 Contracts and ask-list `[ ]`

- ADR: "Perception is a compiled shot ledger; tier 0 is keyless" (accepts §4 schema v4).
- Ask-before-acting (CLAUDE.md §5) resolved with the maintainer and recorded in
  `08-REMOVE-DEFER-RISKS.md`: brain migration v4; two new workers and their weights; the
  `onnxruntime` optional extra promoted for the pack worker only; removal of the key gate;
  deprecation path for the NVIDIA hosted arm.
- Zod (`ledger.ts`) and Pydantic (`brain/ledger_models.py`) ledger schemas, byte-identical by
  hand like `FootageMap`, drift-tested.

## VU7 Sampled verification after apply

### VU7.1 Deterministic first `[ ]`

After an apply that touched picture clips, the conductor takes `picture.cuts` whose flags
changed (new or worsened; inherited flags are advisories) and requests, through the existing
`/review/temporal-evidence`:

- `comparison: shot_match` for `exposure_jump`/`wb_jump` pairs;
- `comparison: transition_continuity` for pairs with a transition;
- `frame: black_ratio` for `black_in`.

Bounded to 4 pairs per apply, one batch, cancellable (the route already watches disconnect).
Results become working-state facts (`kind: verification`) and the briefing's PICTURE line.

### VU7.2 Vision only when numbers cannot decide `[ ]`

`vision-review.ts` gets its first caller. Trigger conditions, all required:

1. a cut pair flagged by the deterministic pass as undecidable (`sameSetting: null` and
   `described` disagrees with `labelled`, or a `shot_match` residual inside tolerance while
   the described subjects differ);
2. a vision-capable provider is configured (`model-capabilities.ts`);
3. the run's budget has headroom.

At most 2 pairs × 2 frames per apply, 512 px, one call, `cannot_tell` is not a pass (the
module's own rules). The verdict is a fact and an advisory. It never blocks the apply and
never triggers a repair loop by itself.

### VU7.3 Offline judge for the harness `[ ]`

A vision judge (`scripts/golden-vision-judge.mjs`, dev only) scores exported goldens at cut
points for the visual cases and writes a score per case into the report. It is evidence for
this plan's exit, not a production path.

### VU7.4 Evidence `[ ]`

- Unit: trigger conditions; bound of 4/2; inherited-flag exclusion; cancellation.
- Golden: `match-color-to-first-clip` produces a `verification` fact; `frames_seen_per_edit`
  stays under 0.5 across the 29 cases (verification frames included).
- A/B: the visual cases with and without VU7 — verification must not lower first-pass
  acceptance (it adds facts, never retries).

## Definition of done

`[ ]` VU0.1–VU0.4 before VU1 starts · `[ ]` VU7.1–VU7.4 after VU2 and VU3 · `[ ]` golden gate
(`golden-gate.mjs`) carries the new metrics against `floor.json` · `[ ]` docs/guides/golden-eval.md
updated · `[ ]` plan reconciled.
