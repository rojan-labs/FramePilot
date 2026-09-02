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
| `[x]` | Score an imported run dump (compact `diff` events, no recorded patches) without lying about reversibility — undo reports UNKNOWN, never a pass | `64bc307` |
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
| `[x]` | The run budget is a **setting**, not a per-run announcement — Settings → AI → Run budget; `budgetNotice` deleted | `2eeb92e` |
| `[ ]` | **R1** — the wall-clock budget cannot fire during a step (see below) | `GOLDEN-D.5` |

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

---

# Defects from the pasted run (`run.md`, 2026-09-02, conversation `369e8c82`)

One agent run: 68 minutes wall clock, 20 model calls, 9 committed patches,
final status **failed — "The app closed before this run finished."** Ranked by
what it cost the user.

### R1 — the run hung for 39 minutes and no budget stopped it `[ ]`

Last event 15:16:45 (`generating`, `seg-20`); next event 15:55:33, the app
closing. The run's 37-minute limit expired at 15:24 and never fired.

Cause, confirmed in code: `budgetExhausted()` is only read by `advance()`
(`kernel/conductor.ts:1224`), which runs on a **turn result**. A step that never
returns is never checked, so the wall-clock budget bounds the gaps between model
calls and not the calls themselves. `runElapsedMs` is likewise only stamped on a
finished turn (`orchestrator.ts:7483`).

Cause 2, and probably the one the user actually sat through: the provider's
reliability layer retries in complete silence. `DEFAULT_TIMEOUTS` is
`{ connectMs: 900_000, idleMs: 600_000 }` and `DEFAULT_RETRY_POLICY.maxAttempts`
is 3, and the desktop wraps every provider with `withResilience(provider)` — no
`hooks.onRetry`. So a stalled call can burn **3 × 15 minutes with not one event
emitted**; `onRetry` writes a log line and nothing reaches the transcript. 39
minutes of silence ending in a force-quit is exactly that shape. (Hypothesis from
the timings — the log has no retry marker to confirm it, because there is nothing
to make one.)

Fix, in one slice:
1. Arm the deadline on the in-flight step, not between steps — abort at
   `runStart + maxWallMs` and finalize through `toVerify` so the run still
   reports what it applied. This is the promise the Settings control now makes.
2. Wire `hooks.onRetry` so a retry is a visible event. A long wait a user can
   see is a wait; a long wait they cannot see is a hang.
3. Open question for the maintainer: 15 minutes for one completion and 10
   between stream chunks are very long. Recommend cutting both once (2) makes
   the cost of a timeout visible.

### R2 — an empty `b_roll` track the agent may never use, offered on every turn `[ ]`

The timeline summary handed to the model every turn reads
`b_roll [video] empty; v_main [video] N clips 0–49.77s`. `v_main` covers the
whole 0–49.77s, and under ADR 0140 the placement guard refuses any clip that
overlaps it. So every placement on `b_roll` is refused — the track is a trap, and
the model walked into it **four times** (14:56, 15:03, 15:07, 15:11) with
`add_clips`/`add_clip`, losing ~15 minutes of the run.

The refusal itself is good (it names the remedy: split at the in/out and place on
the same track). What is wrong is upstream: state advertises a placement target
that cannot hold a clip, and the repeat-call ledger records the identical
`add_clips:{"trackId":"b_roll",…}` key each time without it changing anything.

### R3 — `map_footage` answers `not_indexed` six times and says nothing useful `[ ]`

Six stock clips, six warnings, `durationSec: 0`, `summary: ""`, no next action.
The agent then placed that stock blind. goal.md C: an error is a prompt — it must
say what a valid next action looks like ("not indexed; index it with … or use the
provider's own description").

### R4 — `add_music` refuses in the panel's words, not the agent's `[ ]`

> That track is already in your media bin — it was not downloaded again. Place it
> from the bin, or pick a different track.

"Place it from the bin" names no tool. Music did land later, so this cost turns
rather than the outcome. Same class as the shared-panel-service policies.

### R5 — every call ran with an assumed context limit `[ ]`

`limitAssumed: true` on all 20 calls (`openrouter/auto`, 128000 guessed).
goal.md E: read real limits from the provider and fail loudly if unknown.

### R6 — 20 model calls and 29 minutes had not finished the request `[ ]`

~90 s per step, ~40k context by step 20, and the objective was still
`stage: apply` with 1 remaining objective. Worth re-measuring once R1–R3 land,
since R2 alone burned four of those steps.
