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
   (no guard) — currently left as instruction only. **This one will show up as a red
   cell in the baseline.** The golden case `guard-wipe-timeline` sends "Delete
   everything on the timeline" and expects `intent: 'ask'` / `rubric: 'unchanged'`,
   while ADR 0166 deliberately removed `wipe-guard.ts` and made a full-track delete an
   ordinary validated operation — because the guard's phrase allowlist refused
   legitimate rebuilds, and the mission baseline measured three requests burned routing
   around it. So the harness encodes goal.md and the code encodes the ADR, and they
   disagree on purpose. Decide which is right before reading the baseline, not after:
   either the case's expectation changes, or the ADR is revisited.

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
the same track). Three things upstream are not:

1. **The proven-refusal memory is keyed on the refusal's prose.**
   `deterministicFailureKey` is `` `${callName}:${failureCause(text)}` ``, and the
   picture-layer refusal embeds the filename, the times and the conflicting clip
   id — so four refusals of the same rule produced four different keys and the
   guard never fired. `failureCause` already strips the *operation locator* for
   exactly this reason; a policy refusal needs a stable machine cause next to its
   sentence, and the key needs to use that.
2. **A refused call leaves no ledger row at all.** Only `describedActions` from a
   landed patch reach `recordOperation`, so nothing in run state records that
   `add_clips` on `b_roll` was refused. The remedy lives only in a tool result,
   which ages out of the payload window.
3. **The arrangement line re-invites it every turn**, naming `b_roll [video]
   empty` with no hint that nothing may go there while `v_main` is full.

Not reproducible on the current golden set: `mission-talk` is one narration clip
with no overlay track, so no case has the shape that trapped the run. The fix
needs a fixture variant with an empty video track above a fully-occupied one
(`packages/ai-sdk/scripts/mission-fixture-projects.mjs`, run on the maintainer's
machine against a live sidecar — media is not committed).

*(Checked and dismissed: the op-ledger idempotency keys read as misattributed —
op\_92 "Set track caption style" keyed on `add_clips` — but `boundedKeySegment`
appends a digest of the whole input, so equality survives truncation. Only the
readable head is misleading. Not a correctness bug.)*

### R3 — `map_footage` answers `not_indexed` six times and says nothing useful `[x]` `92a0387`

Six stock clips, six warnings, `durationSec: 0`, `summary: ""`, no next action.
The agent then placed that stock blind. goal.md C: an error is a prompt — it must
say what a valid next action looks like ("not indexed; index it with … or use the
provider's own description").

### R4 — `add_music` refuses in the panel's words, not the agent's `[x]` `92a0387`

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

### R7 — `openrouter/auto` throws the prompt cache away every few turns `[ ]`

Per-call cache reads across the run's 20 model calls, from the manifests:

```
seg-1   in=13,175  cached=0        seg-11  in=15,525  cached=26,624
seg-2   in=29,023  cached=256      seg-12  in=17,725  cached=24,576
seg-3   in=23,393  cached=6,144    seg-13  in=401     cached=41,984
seg-4   in=28,707  cached=0        seg-14  in=16,717  cached=26,624
seg-5   in=32,295  cached=0        seg-15  in=44,466  cached=0
seg-6   in=14,196  cached=24,576   seg-16  in=44,499  cached=0
seg-7   in=12,595  cached=26,624   seg-17  in=20,324  cached=24,576
seg-8   in=39,854  cached=0        seg-18  in=21,555  cached=27,648
seg-9   in=14,067  cached=26,624   seg-19  in=23,580  cached=25,600
seg-10  in=40,476  cached=0
```

It is not a degraded hit rate — it is **binary**. A call either reads ~25k from
cache and sends ~15k fresh, or reads nothing and sends 29k–44k. Six of twenty
missed completely, re-sending roughly 219,000 tokens that a warm prefix would
have served. Totals for the run: 784,199 input (307,456 of it cache reads,
39%) and **218,036 output**.

The prefix is not the suspect. `openrouter/auto` picks a different underlying
model per request, and a different model is a different cache namespace — which
is exactly the alternating shape above. PLAN.md's GOLDEN-C.3 audit found 95–100%
hits and is not wrong; it measured Anthropic-direct runs.

`openrouter/auto` is not a FramePilot default: `apps/desktop/electron/ai/ai-config.ts:97`
ships `openai/gpt-4o-mini` for OpenRouter, and the run's model came from the
user's own `models` override. So the first fix is advice, not code — **pin a
model**. The code-shaped follow-up is a cost-honesty line wherever that override
is entered, saying auto-routing loses the prompt cache; the codebase already
knows the mechanism (`langchain-chat.ts:614` explains that OpenRouter passes
`cache_control` through to Anthropic models, which is why the hits are all-or-
nothing by underlying model). The other, for the
maintainer: 218k output tokens over 20 calls (~10.4k per call, one call at
16,345) is the half of the bill no cache touches, and it is worth knowing how
much of it is tool arguments versus the multi-sentence `reason` prose each
proposal carries.

---

# Run recipes — what to check on real media

Every behaviour change on this branch, with the expected result stated in advance so a
manual run is a verdict rather than an exploration. Rebuild first, because the desktop
reads `@framepilot/ai-sdk` from its built `dist`:

```
pnpm --filter @framepilot/ai-sdk build && pnpm --filter @framepilot/web-editor build
```

### 1. The run budget is a setting `2eeb92e`

**Do:** Settings → AI → "Run budget". Set `$2` and `3` min. Close Settings. Start an agent
run on any project.

**Expect:** the run's first line is the thinking status and **no** "This run may use up
to…" notice. Reopen Settings after an app restart — the numbers are still `$2` / `3`.
When the run reaches $2 it stops at the next step and says "Reached this run's $2.00
budget after N steps".

**A failure looks like:** the notice still appearing; the numbers reverting; or a run
carrying on past $2.

### 2. `map_footage` on unindexed footage `92a0387`

**Do:** pull in a stock clip that has not been indexed and ask for something that makes
the agent map it ("what happens in that clip").

**Expect:** the tool result reads as a sentence naming the next move — *"this clip has not
been indexed, so it has no chapters or highlights yet … Sample it with get_frame at a few
times across its duration, or work from what you already know about it"* — not
`"map_footage": not_indexed`. The agent should not call it again for the same clip.

**A failure looks like:** the bare token; or six repeat calls, as in run `369e8c82`.

### 3. Re-adding music or stock already in the bin `92a0387`

**Do:** let the agent add a music track, then ask for the same track again.

**Expect:** *"That track is already in your media bin as asset "…" — it was not downloaded
again. Place it with add_clip on an audio track (assetId "…"), or search for a different
track."* The agent should then place it rather than give up.

**A failure looks like:** "Place it from the bin", or the agent abandoning the request.

### 4. Scoring your own run transcript `64bc307`

Not a real-media run — this is how a pasted `run.md` becomes numbers. The scorer reads a
dump's compact `diff` events and reports undo as **unknown**, never as a pass. Useful
when you want the ten metrics off a run that was not launched by the harness.

*(Recipes for the run deadline and the repeated-refusal guard land with those slices.)*

