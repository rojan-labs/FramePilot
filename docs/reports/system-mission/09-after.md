# Phase 9 — E2E, failure paths, regression and efficiency gates: after

What Phase 9 owns is not features but **proof**: the journeys in `USE-CASES.md` exercised on
the real desktop host, the failure paths exercised deliberately, and the two things a
quarter of prompt work silently erodes — edit quality and cost — held by gates that have
been seen to go red.

## 1. The journey matrix

"Proven" means the row's spec asserts a **timeline or file outcome** (never chat text) and
has been run. Rows whose evidence is a rubric score come from the mission harness
(`mission-baseline.mjs` → `mission-score.mjs`); rows whose evidence is a spec come from
`tests/e2e-desktop`. The numbers are the measured p50s recorded in `01-after.md` — nothing
here is re-derived or estimated.

| ID | Journey | Evidence | State |
| --- | --- | --- | --- |
| UC-01 | Raw recording → 30 s montage | `montage-30s` rubric **1.00** (3/3 runs, 35 ops) · `ai-journey.spec.ts` turn 1 | **measured**; e2e written, unrun |
| UC-02 | Podcast highlight | `podcast-highlight-60s` rubric **1.00** (3/3 runs) | **measured** |
| UC-03 | Remove dead air | `remove-dead-air` rubric **0.75** (2/3 runs, 54 ops) | **measured**, below 1.00 by a stated finding |
| UC-04 | Add captions | `memory-captions` t2 rubric **0.71** (1 run, 83 ops) | **measured**, single observation |
| UC-05 | Cut to the beat | `beat-sync` rubric **0.78** (3/3 runs, 34 ops) | **measured** |
| UC-06 | Reference video's style | `references-analyze.spec.ts` (route + cache on the real fixture) · `ai-journey.spec.ts` reference turn | spec written, unrun — needs a provider |
| UC-07 | Image as brand/style context | `ai-journey.spec.ts` logo turn | spec written, unrun — and P3.4's logo-overlay op is not landed |
| UC-08 | Refine an existing edit | `refine-tighten` t2 rubric **0.88** (3/3, 4 ops — a refinement, not a rebuild) · `ai-journey.spec.ts` turn 2 | **measured** |
| UC-09 | Context persists across turns | `memory-captions` t1/t2/t3 **0.63 / 0.71 / 0.43** · `ai-journey.spec.ts` turn 3 | **measured, and the weakest row**: turn 3 applied nothing |
| UC-10 | B-roll insertion | — | not covered by a mission scenario |
| UC-11 | Animated captions / motion graphic | — | not covered by a mission scenario |
| UC-12 | Create a hook | — | not covered by a mission scenario |
| UC-13 | Export at chosen quality | `export-matrix.spec.ts`: 5 ffprobe rows + cancel + progress + history/reveal/settings-persistence | green on macOS (hardware path); Linux software path unrun |
| UC-14 | Long session stays healthy | `resource-baseline.spec.ts` + the P6.6 gate, bounds from the committed 2026-08-29 trace | **measured**; gate proven able to fail (§3) |
| UC-15 | Failure paths | `failure-paths.spec.ts`: 8 provider-free rows, 4 provider rows | provider-free rows run anywhere; provider rows unrun |
| UC-16 | Large media | `failure-paths.spec.ts`: 60-photo batch row (runs) + 4K 20-minute row (skips, no such fixture) | **not proven** — see §4 |

Nine of sixteen journeys have a measured outcome. The honest summary is that the *editing*
journeys are measured and the *desktop-host* journeys are written but waiting on a run with
a provider and the maintainer's media; nothing in this phase claims a journey is proven
because its spec compiles.

## 2. What the failure-path suite asserts

Every row in `failure-paths.spec.ts` asserts the same three things, because they are what
separates a handled failure from a corrupted session: nothing half-applied (the timeline is
untouched or fully committed), the app *says* what happened, and no orphan process is left
behind. The rows that need no provider — invalid media, engine SIGKILL, app close, music
offline, stock offline, a failing encoder, and now the two UC-16 large-media rows — run on
any machine that can launch the app, because they are the ones a release must not break.

## 3. The three gates, and proof each can fail

A gate nobody has seen go red is a decoration. All three were re-verified on 2026-08-29
against the committed evidence.

**Rubric floor** (`mission-score.mjs`, tolerance 0.05, PR lane):

```
$ node packages/ai-sdk/scripts/mission-score.mjs reports/system-mission/after-orchestration-merged.json
… | montage-30s | 1.00 | 1.00 | 3 | 1 | held |                                   exit 0
# seed: every montage-30s turn score halved
| montage-30s | 1.00 | 0.50 | 3 | 1 | REGRESSION |
1 scenario(s) regressed by more than 0.05 …                                       exit 2
```

**Efficiency floor** (`mission-efficiency-gate.mjs`, +10% without a rubric gain, PR lane):

```
# seed: +40% modelCalls on podcast-highlight-60s, same score
| podcast-highlight-60s | 5 → 7 (+40.0%) | … | 1.00 → 1.00 | REGRESSION |         exit 2
# seed: +30% prompt tokens on montage-30s, same score
| montage-30s | 31 → 31 (+0.0%) | 33503 → 42912 (+28.1%) | 1.00 → 1.00 | REGRESSION | exit 2
# seed: +40% calls on remove-dead-air BUT 0.75 → 1.00
| remove-dead-air | 6 → 8 (+33.3%) | … | 0.75 → 1.00 | costlier, but a better edit | exit 0
```

The last arm matters most: paying more for a *better* edit is a trade the maintainer may
make, so the gate does not fire on it and therefore does not need routing around.

**Resource gate** (P6.6). This one used to be six inline `expect`s at the bottom of a
ten-minute Electron session, which made it unfalsifiable in practice — the only way to see
it fail was to hope the app leaked. The arithmetic now lives in `specs/resource-gate.ts` as
a pure function, and `specs/resource-gate.spec.ts` replays the committed
`baseline-resources.json` through it:

```
$ npx playwright test specs/resource-gate.spec.ts
  ✓ holds on the real measured session
  ✓ fails on a seeded heap leak
  ✓ fails on seeded listener and node growth
  ✓ fails on a seeded file-handle leak and on an orphan encoder
  ✓ tolerates the ordinary variance the bounds were drawn for
  5 passed (0.5s)
```

Five rows: green on the real trace, red on each seeded leak, and green again on the
ordinary variance the bounds were drawn for — a gate that fires on noise gets disabled
within a week, so that last row is part of the proof, not padding.

## 4. What is not proven, and why

- **UC-16's 4K 20-minute file.** No such file exists on this machine — the largest real
  camera fixture is 40 seconds (`tests/fixtures/mission/README.md` records that residual).
  The row is written, checks the candidate with `ffprobe`, and **skips with the measured
  shape** when it is too short or too small rather than passing on a stand-in. A 40-second
  1080p file would make the row green while proving nothing about large media.
- **The Linux (software encoder) half of the export matrix.** The fixtures are the
  maintainer's own camera files and are deliberately never committed, so the matrix runs
  only where the media lives. P9.4's "Done when" names two platforms; one has run.
- **Every provider-gated row.** `ai-journey.spec.ts` and four `failure-paths` rows need
  `MISSION_AI=1` and a billed provider. They are wired into `mission-nightly.yml`; none has
  been run green yet.
- **UC-10, UC-11, UC-12.** No mission scenario exercises b-roll, motion graphics or hook
  restructuring, so the regression suite says nothing about them.

## 5. Where each gate runs

| Lane | What runs | Why there |
| --- | --- | --- |
| PR (`ci.yml` · `mission-gates`) | rubric floor, efficiency floor | dependency-free JSON reductions, ~20 s, no provider or media |
| Nightly (`mission-nightly.yml` · `real-eval`) | real mission run, then both floors against it | needs a billed provider; `continue-on-error`, because a 429 is not a regression |
| Nightly (`desktop-gates`) | resource-gate proof → reference route → export matrix → failure paths → AI journey → resource gate | needs Electron, the sidecar and the uncommitted media |

The split is the point: what a PR can *honestly* gate is the committed evidence, and the
expensive half that produces that evidence belongs where a red result means "look at this",
not "the provider was busy".
