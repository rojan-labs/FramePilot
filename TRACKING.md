# TRACKING — goal.md program

Working log for the goal.md program (branch `feat/golden-eval-harness`, PR #75).
One row per **slice**: the smallest change a user could feel, finished before the
next one starts. Status is what is *true in the repo*, not what is planned.

- `[x]` shipped on the branch, scoped tests green
- `[~]` in progress
- `[ ]` queued
- `[M]` blocked on a maintainer decision or a manual real-media run

Anything that depends on real footage stays **pending manual verification** until
the maintainer reports back — see `reports/golden/BASELINE.md` for the recipes.

---

## Phase 0 — measure before touching anything

| | Slice | Evidence |
|---|---|---|
| `[x]` | Golden eval harness: 20 cases over the mission fixtures, edit-state rubrics, the ten goal.md metrics, one command per case, cost quoted up front, resumable per-case results, recordings + `--replay` | `docs/guides/golden-eval.md`, `packages/ai-sdk/src/eval/` |
| `[x]` | One gate, one floor — `golden-gate.mjs` replaces the two mission gates; CI + nightly rewired (nightly pinned, `--force`) | `scripts/golden-gate.mjs`, `.github/workflows/` |
| `[x]` | A second phrasing for each core verb | `golden-cases.ts` |
| `[~]` | Score an imported run dump (compact `diff` events, no recorded patches) without lying about reversibility | `golden-metrics.ts` |
| `[M]` | **Publish the real-media baseline** | `pnpm eval:golden -- --runs 3 --label baseline --yes` |

## Workstream A — editing precision

| | Slice | Evidence |
|---|---|---|
| `[x]` | Verification judges the delta: inherited footage defects are advisories, request-derived checks never excused | `7062e89` |
| `[x]` | A failed-after-apply run emits one error card + a receipt of what stuck | `7062e89` |
| `[x]` | A wrong clip id is answered with the right ones | `629b822` |
| `[M]` | Compound-request atomicity vs instant-apply (ADR 0056) | maintainer decision |

## Workstream B — footage understanding and indexing

| | Slice | Evidence |
|---|---|---|
| `[x]` | Audit: content-addressed index cache — no change needed | `e92e0c5` |
| `[x]` | Audit: indexing resume — no change needed | `e92e0c5` |

## Workstream C — intent understanding and prompt handling

| | Slice | Evidence |
|---|---|---|
| `[x]` | The ambiguity policy, stated as instruction (+77 tok/request net after trimming `ask_user`) | `1d9d14a`, `267472b` |
| `[x]` | A paid or slow tool says so before the model calls it | `cc378d3` |
| `[x]` | An unreachable media engine tells the model what to do next | `473aa01`, `9768d32` |
| `[x]` | A rejected tool call is explained in the editor's words | `aef78fc` |
| `[x]` | A failed run says what to do, not what the wire said | `22b3488` |
| `[x]` | A refusal is not a bad argument, and must not be worded as one | `8fd63f1` |
| `[x]` | Audit: prompt-cache prefix stability (95–100% hit on real runs) — no change | `e92e0c5` |

## Workstream D — autonomy and orchestration

| | Slice | Evidence |
|---|---|---|
| `[x]` | Bound every run by cost and time | `6244119` |
| `[x]` | The progress guards, audited together (a 40-step productive run survives all five) | `b88b911` |
| `[x]` | The reducer's decisions reach the log, not just its effects | `9efafb8` |
| `[~]` | The run budget is a **setting**, not a per-run announcement | maintainer request, 2026-09-02 |

## Workstream E — token and cost efficiency

| | Slice | Evidence |
|---|---|---|
| `[x]` | The cheap routing call can run on a cheap model (`FRAMEPILOT_TIER_*`) | `a5551f7` |
| `[M]` | Measure tiering on real media (second baseline run with `FRAMEPILOT_TIER_SMALL_MODEL` set) | recipe in `BASELINE.md` |

## Workstream F — reliability and output

| | Slice | Evidence |
|---|---|---|
| `[x]` | Validate every export against the intended spec (resolution, fps, black/silent tails, audio) | `9585e17` |
| `[x]` | Software-encode determinism pinned (VideoToolbox is not bit-reproducible — documented) | `07e4653` |
| `[x]` | A failed master-audio pass leaves no half-written temp file | `de5cdc9` |
| `[x]` | The preview cannot show a second picture layer, so the agent stops making one | `61ac69f` |

---

## Maintainer decisions outstanding

1. Compound-request atomicity vs instant-apply (ADR 0056).
2. Hardware-first vs deterministic export default.
3. `$5` / `20 min` run-budget defaults.
4. goal.md's "explicit confirmation of scope" for full-track wipes vs ADR 0166
   (no guard) — currently left as instruction only.

## The one thing that unblocks the rest

The **real-media baseline**. Every metric in goal.md's release gate is a number
nobody has yet; until it exists, every later change reports a fixture delta and
an unknown. Recipe: `reports/golden/BASELINE.md`.
