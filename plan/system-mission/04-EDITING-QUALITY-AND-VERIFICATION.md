# Phase 4 — Editing quality and the verification loop — `[~]`

> **Ships:** semantic editing operations built on existing editor-core ops; a bounded
> verify loop that is deterministic first; a graded scenario suite that becomes the
> quality gate every later optimization must pass.
> **Does not ship:** new low-level timeline ops (that is `timeline-engineer` territory
> and needs its own scope gate); generative media.
> **Depends on:** Phase 1 (state, memory), Phase 3 (reference profiles).
> **Schema/deps:** none — semantic ops compose existing operations into one patch.

## P4.1 — Semantic operations — `[~]`

**Touches:** `packages/ai-sdk/src/domain-tools/*` (new tool specs), the controllers that
implement them, `autonomous-tools.manifest.json` (regenerated), Python mirror
(generated, P2.3). Each op is a pure planner from (project, evidence, args) → one
editor-core patch, validated before apply, invertible as a unit:

| Op | Composes | Evidence it needs |
| --- | --- | --- |
| `cut_to_beat` | split/trim/ripple on the picture to the grounded beat grid | beat ledger of the placed track (ADR 0157), `hardSync` |
| `create_hook` | move/trim the strongest line to the head | full transcript + edit signals |
| `tighten_pacing` | trims + silence removal within a range, target shot length | transcript, silences, reference `medianShotS` if present |
| `insert_broll` | place a non-overlapping cutaway over a transcript-anchored range (ADR 0140) | transcript anchor, asset roles |
| `emphasize_word` | caption-emphasis op on matched words | transcript words + caption track |
| `match_reference_style` | orchestrates shot-length, transitions, grade, caption style from a `ReferenceProfile` | Phase 3 profile |
| `create_transition` | transition op from the catalog by intent word | transition catalog |
| `add_motion_graphic` | motion controller lower-third/title with keyframes | text + position intent |

Each op ships with: table tests over fixtures, a golden patch snapshot, an invert test,
a skill line in the matching `skills/*.md`.
**Done when:** every UC row in `USE-CASES.md` that names one of these has a passing
deterministic test that asserts the timeline outcome.

Landed 2026-08-29: `remove_silences` — measure once, cut deterministically
(`silence-cut.ts`, executor route, orchestrator branch, skill guidance; orchestrator-level
tests assert the ripple deletes and the seconds removed). Baseline evidence: 6/6
remove-dead-air runs died echoing ~110 ranges. Next: `cut_to_beat`, `tighten_pacing`,
`create_hook`, `insert_broll`, `match_reference_style`.

## P4.2 — Reference-driven planning — `[ ]`

**Touches:** proposers' plan prompt + `match_reference_style`. The plan must state which
constraints it is applying and which it is ignoring (with a reason) — this is what the
sidebar shows in Phase 8 and what the Critic checks.
**Done when:** UC-06 plan output cites ≥3 profile constraints on the fast-cut fixture.

## P4.3 — Bounded verify loop — `[ ]`

**Touches:** `kernel/proposers/critic.ts`, `kernel/conductor.ts` verify stage,
`kernel/stage-policy.ts`. Sequence: execute → deterministic critique (`src/critic.ts`
battery extended with the P0.3 rubric checks: intent constraints, timing on frames,
pacing target, continuity, sync, captions present, overlaps, dangling refs, missing
assets, render validation) → if findings, **one** fix turn scoped to the findings → verify
again → stop. Max two fix turns; on the third finding set, surface to the user with the
list. Advisory LLM judgment stays advisory.
**Done when:** a seeded broken patch (overlap + off-grid cut) is fixed in one loop
iteration in the test; the loop never exceeds two fix turns (test).

## P4.4 — Scenario suite as the quality gate — `[ ]`

**Touches:** `packages/ai-sdk/src/eval/mission-rubric.ts` (from P0.3),
`eval/mission-scenarios.ts`, `pnpm eval:mission`. Scenarios: UC-01…UC-12 with fixture
projects. Offline: deterministic replay through the kernel's `replay/` with recorded
provider responses. Online (`pnpm eval:mission:real`): real provider, three runs, p50
score. CI runs the offline suite; the score must not drop below the last committed
`reports/system-mission/mission-score.json`.
**Done when:** the suite runs in CI and a deliberate rubric regression fails it.

## P4.5 — Close — `[ ]`

`04-after.md`: per-scenario rubric before/after; skills updated (`editing-skills-expert`);
ADR for semantic ops as compositions; CHANGELOG.

## Discovered

