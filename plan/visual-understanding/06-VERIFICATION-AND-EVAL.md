# 06 — Phase VU0 (first) and VU7: measure blindness, then verify with pixels only where needed

## VU0 Baseline and contracts — do this before any code

### VU0.1 Blindness metrics in the golden harness `[x]` (2026-09-07)

`src/eval/perception-metrics.ts` — pure, 22 tests — plus the wiring into
`measureGoldenTurn`/`summarizeGoldenRun`/`renderGoldenSummary` (3 more tests):

| Metric                  | Definition                                                                     |
| ----------------------- | ------------------------------------------------------------------------------ |
| `framesSeenPerEdit`     | frames put in front of the model (`get_frame`, vision review) ÷ accepted edits |
| `perceptionCallsPerRun` | `search_visual + describe_footage + map_footage + measure_color`               |
| `numericGuessRate`      | grade/transition operations applied with no measurement or solver before them  |
| `pictureFactsInPrompt`  | clip rows carrying a fact suffix ÷ rows shown, read from the rendered slice    |
| per-tool counts         | which surface a run leaned on, so a change can be attributed                   |

`GoldenTurnMetrics.perception` is **optional**: a result file written before this existed
carries no such evidence, and the summary reports `measuredTurns` rather than a flattering
zero. `framesSeen` is a ceiling — a change that raises it has not worked.

**The baseline was NOT produced by re-running the golden set.** Every recorded run already
stores `metrics.toolCallsByName` per turn, so `scripts/perception-baseline.mjs` folds the
existing `reports/golden/*/cases/` files into the floor. 318 turns, 210 accepted edits, ten
runs, no provider calls, no money. Result, in full in
[`reports/golden/BASELINE.md`](../../reports/golden/BASELINE.md):

|                             | floor                                           |
| --------------------------- | ----------------------------------------------- |
| frames seen / accepted edit | **0.00** (`get_frame` called zero times, ever)  |
| footage-surface calls       | **0** in every run                              |
| timeline reads              | 192                                             |
| grade/transition guess rate | **1.00** (3 calls, 1 turn, none measured first) |

Visual target resolution is deferred to VU0.3's new cases, which carry the labelled answers
it needs; scoring it before those exist would measure nothing.

### VU0.2 Labelled fixture set `[~]` (machine half done 2026-09-07; the human pass is open)

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

**What shipped, and what is still owed.** Two commands, both committed:

```bash
node packages/ai-sdk/scripts/propose-fixture-labels.mjs   # regenerates all four files
FRAMEPILOT_PROJECTS_ROOT="$PWD/tests/fixtures/mission/projects" uv run framepilot serve
node packages/ai-sdk/scripts/contact-sheet.mjs            # a captioned thumbnail per shot
```

`tier0.json` carries **498 shots over 12 assets**, every one `"source": "proposed"` — the
shipped tier-0 pass measured them and the shipped word functions named them, which is the
machine describing its own output. `cuts.json` carries `mission-montage`'s 4 cuts with their
measured luma/warmth deltas. `tier1.json` (498 rows) and `tier2.json` (50 rows) are
**scaffolds, not proposals**: shot size, subject, setting and on-screen text need the tier-1
pack or a captioner, and a generated guess would be read as a label. The directory's
`README.md` states the rule this all rests on — never tune a threshold against a label the
machine proposed.

Two things the machine could not do, recorded rather than papered over:

- **60 photos are unmeasured.** The tier-0 ffmpeg pass exits 234 on every fixture JPEG
  ("Could not open encoder before EOF"), through `measure_asset(is_image=True)` — the same
  call the enroller makes, so this is a product defect and not a script one. They are listed
  by name in `tier0.json`'s `unmeasured`, because an asset ffmpeg could not read must not
  look like an asset with nothing to say.
- **Nothing is verified.** The semantic half of VU0.2 is an afternoon with the contact sheet,
  and no agent can do it.

### VU0.3 New golden cases `[x]` (2026-09-07)

Added to `golden-cases.ts`, split by what a rubric can actually decide. Five change the
timeline and have a rubric each in `mission-rubric.ts`, reading the resulting edit state and
every one carrying a `no-collateral-changes` facet. Three are QUESTIONS: a rubric cannot judge
prose, so they score `unchanged` under a new `intent: 'answer'`, and the claim that the answer
cost no frame is measured by `perception-metrics.framesSeen`, not by the rubric. Their
correctness is the operator's call against VU0.2's labels, and each case's `why` says so.

| id | fixture | rubric | what it checks |
| --- | --- | --- | --- |
| `match-color-to-first-clip` | `mission-montage` | `match-color-to-reference` | the THIRD clip gained a grade and the first did not (the inverted edit is the plausible wrong answer); every parameter inside `COLOR_GRADE_PARAMETER_CONTRACTS` and actually moving; nothing else on the timeline touched |
| `warmer-subtle` | `mission-montage` | `warmer-subtle` | every picture clip carries a positive `temperature` under 0.5 and moves no exposure/contrast/saturation — the look table's own content (`LOOK_DELTAS.warmer` is a warmth delta and nothing else); no clip may move |
| `transitions-where-they-belong` | `mission-montage`, 2 turns | `transitions-where-they-belong` | turn 1 builds the montage so the timeline has BOTH kinds of cut; then ≥1 source-change cut carries a transition and NO continuity cut does — the rule `chooseTransition` enforces by returning `null` |
| `broll-over-sentence` | `mission-talk` + montage bin | `broll-over-sentence` | the cutaway covers the transcript span of the line the request named (target resolution by sentence, which `broll-first-20s` cannot test); duration kept; content away from the line preserved |
| `remove-duplicate-takes` | `mission-montage`, 2 turns | `remove-duplicate-takes` | turn 1 is asked for repeats, because no fixture ships duplicate takes; then no two clips play overlapping source of one asset AND every un-repeated shot survives |
| `which-clips-show-host` | `mission-montage` | `unchanged` (answer) | answered, nothing edited, no frame rendered. Correctness → operator, against `tier1.json` |
| `whats-on-screen-at` | `mission-montage` | `unchanged` (answer) | same; correctness → operator, against `tier2.json` |
| `find-dark-clips` | `mission-montage` | `unchanged` (answer) | same; correctness → operator, against `tier0.json`'s PROPOSED exposure classes |

Three honest departures from the table above as it was written:

- **`match-color`'s residual is not scored.** A rubric reads the project file, which carries
  no measurement, so "residual under tolerance" is not expressible there. Direction,
  containment and contract compliance are; the residual belongs to VU7's `shot_match` route.
- **`broll-over-sentence` does not check `setting: street`.** No fixture b-roll is a street,
  and no fixture footage carries a verified setting label. The case asks for the line
  `mission-talk` actually contains, scores the PLACEMENT, and leaves the footage choice to
  the operator rather than faking a content check.
- **`remove-duplicate-takes` does not read tier 1's `duplicateOf`.** That is a phash cluster
  over two separate recordings and no fixture has one, so the case builds repeats in turn 1
  and the rubric defines a duplicate as overlapping source of one asset — a fact the project
  file proves.

### VU0.4 Contracts and ask-list `[x]` (2026-09-07)

- **[ADR 0175](../../docs/adr/0175-perception-is-a-compiled-shot-ledger.md) — accepted.**
  "Perception is a compiled shot ledger, and tier 0 needs no key." Names the four causes
  of the measured blindness, the three-tier decision, the cost model, and the rejected
  alternatives (a frame per model call; a bigger hosted backend; facts in
  `project.fp.json`; free-text captions; waiting for the scene-understanding service).
- **The ledger contract exists in both languages.**
  `engine/python/framepilot_engine/brain/ledger_models.py` (the writer) and
  `packages/ai-sdk/src/ledger.ts` (the reader), byte-identical by hand, guarded by
  `engine/python/tests/test_ledger_ts_parity.py` — 11 tests over every schema, both
  enum vocabularies, the shot-size ladder's ORDER (a delta's sign depends on it), the
  `class`/`motion_class` alias, and the three tier versions. Plus 13 TS tests on the
  degradation rules: a tier that has not run is `undefined`, a malformed snapshot parses
  to `null` rather than throwing into a run, and an empty snapshot is real and distinct
  from a broken one.
- **Ask-before-acting: all approved by the maintainer** (2026-09-07, standing decision
  recorded in `08-REMOVE-DEFER-RISKS.md`) — brain migration v4, the two new workers and
  their pinned weights, the pack dependencies subject to `pnpm license:scan`, removing
  the key gate, `GET /brain/shots`, and every new model-facing tool. Where the plan
  leaves a choice open, take the best option on the evidence and record it rather than
  stopping. **Deprecated means deleted**: implementation, UI, config keys, env vars,
  docs and tests go in the same change, with a migration when existing projects need one.

### VU0.2 / VU0.3 — sequencing note (2026-09-07)

VU0.2's _human-semantic_ labels (shot size, subject, setting) need an eye on a contact
sheet, and VU0.3's new cases score against them, so neither can be finished by an agent
alone. They do **not** gate VU1: the accuracy check that actually protects tier 0 is
machine-checkable and independent — **full-resolution ffmpeg statistics versus the 160 px
downscale tier 0 uses**, which is the real engineering risk in VU1.1 and needs the tier-0
code to exist first. So the order is VU0.1 → VU0.4 → VU1 (with the full-res agreement
test) → the labelled set and the new cases alongside VU2.

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
