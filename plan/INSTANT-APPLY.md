# Instant Apply — one writer, review as a reader, auto only

> Status: `[x]` patches 1–4 complete · 2026-08-14 → 2026-08-15 · Owner: AI layer
> Linked from `plan/PLAN.md`. Recorded as **ADR 0122**, which amends ADR 0119 / 0120 / 0121.

## Problem

An AI edit does not reach the timeline until a full perceptual review has rendered real
frames and audio through the Python sidecar. From the code's own budgets:

- `engine/python/framepilot_engine/validation/temporal_evidence.py:45-47` — ~313ms per
  sampled frame, 3 MoviePy compiles; worst case **~224s**.
- `packages/ai-sdk/src/temporal-evidence-client.ts:20-24` — a *default* 48-request plan on
  a real sequence is **~134s**; the client timeout is **300s**.
- ADR 0121 — compile is ~0.8s/clip and the cache is keyed on project *content*, so an
  edited timeline is always a fresh miss (~30s on a 37-clip sequence).

`streamEditorRun` (`orchestrator.ts:3808-3816`) pushes every valid diff into `stagedDiffs`
and withholds it until review clears. Desktop then refuses to commit anything not stamped
`verified` (`patch-settlement.ts:11`). So "Auto" apply mode is not auto: on a multi-turn
run the timeline is frozen for 30s–4min, then every turn lands at once.

The deterministic half — `assembleEdit` → `validatePatch` → revision check — is pure,
in-memory and sub-millisecond. It is not the problem and does not move.

## Root cause: two writers

Review is not a reader today. On a repairable finding it calls `streamEdit`
(`orchestrator.ts:3945-3958`), gets a patch, applies it and stages it. The run therefore
has **two writers** — the turn loop and the review repair pass — and two writers over one
project force serialization. Every ordering question in this design (does turn N+1 wait for
review N?) descends from that single fact.

## Decision

**One writer.** The agent turn loop is the only thing that mutates the project. Review
becomes a pure reader that emits a *finding*: text plus the identity of what it looked at.
A finding enters the agent's context as evidence; the agent repairs it in a normal
mutating turn, serialized like every other turn.

With review unable to write, turn N+1 never waits for review N — there is nothing to
collide with. Review runs pipelined alongside the next turn and costs ~0 wall-clock.

### Per-turn flow

1. Turn N produces validated ops → diff emitted immediately, no staging.
2. Host commits it. Timeline moves and pulses. Undo covers it.
3. If turn N's diff has a perceptual surface, start review(N) — detached, scoped to the
   frames that diff actually touched, against the committed snapshot.
4. Turn N+1 starts at once. Before building context it drains settled findings and folds
   the still-valid ones in as evidence.
5. When the agent signals done, outstanding reviews drain. Surviving findings earn one
   repair turn. Then the run finishes.

Step 5 is the only place anything waits, and it is after the user already has their edit.

### Finding validity

Each finding carries the revision, patch id, and the clip/track ids it was computed
against. On drain a finding is **dropped** if any later committed turn touched an
overlapping clip or track — that region was rewritten anyway, so the finding describes a
timeline that no longer exists. Per-turn diffs already record exactly what each turn
touched, so this is a pure set-intersection, unit-testable without the engine.

### No manual path

Auto is the only mode. The diff-card model is borrowed from code assistants, where a diff
is legible as text and a bad apply breaks the build. Video is not text — "added 3 clips,
trimmed 2" says nothing about whether the edit is good, and the only real evaluation is
watching it. The product already owns the better primitive: a timeline that shows the
change, a preview that plays it, and grouped Undo (`history.ts:135` — `undoProject` walks
back every contiguous entry sharing a `groupId`) that reverses a whole run in one keystroke.

Manual review would earn its place for irreversible ops (none — every op has an `invert`,
a core invariant), expensive ops (render/export, already a separate explicit action), or
ops reaching outside the project (already sandbox-gated, separately).

---

## Sidebar design

The card stops being a **decision** and becomes a **receipt**, and receipts merge into the
plan steps. Today `DiffCard` (`EventNode.tsx:965`) is built entirely around deciding:
`canDecide`, `data-decision="pending"`, A/R key bindings, a double-fire `pending` guard,
and Accept as — per its own comment — *"the ONLY filled button in the stream, the single
place weight is spent."* With the edit already landed, all of that is dead weight.

### Target

```
Plan                                            3/3   ⌄
✓ 1  Find the silent gaps               12 gaps
✓ 2  Remove them                      9 changes   ↗
✓ 3  Tighten the pacing                4 changes  ↗
     └ checked 0:08 — fixed a black flash
──────────────────────────────────────────────────────
Made 13 edits                            [ Undo run ]
```

### Step rows absorb the receipt

- A `PlanStep` renders its change count and a jump affordance (`↗`) once its turn's diff
  lands. Expanding the step shows the operation list and reference chips that live in
  `DiffCard`'s accordion today — that content is good and is kept verbatim.
- The join: `DiffEvent` gains an additive optional `planStepId`. The conductor already
  knows `planStepIndex` (`conductor.ts:610`) and step ids are `step-${i+1}`
  (`conductor.ts:948`), so this is a stamp, not a lookup. The view layer joins in the
  projection; `PlanStep` itself is unchanged.
- A diff with no plan step (single-proposal `recipe` / `planned_edit` routes, which never
  draft a plan) renders as a standalone receipt row — the same row, without a step number.

### What is deleted

- Accept / Reject buttons, `canDecide`, `decision`, `decisionDetail`, the `pending`
  double-fire guard, the A/R key bindings (`P` for preview is kept).
- `applyMode`, `APPLY_MODE_META`, `APPLY_MODE_INFO`, the apply-mode `Menu` in the header,
  `APPLY_MODE_STORAGE_KEY`.
- `diffActions` (`onAccept`/`onReject`/`onApplyPatch`), `applyDiffsInOrder`
  (`ai/diffActions.ts`), "Apply all" / "Reject all", and `DiffPreviewModal`'s subset-apply
  and reject-all paths. The modal survives as **read-only** before/after inspection.

### What is kept

- `Jump to timeline` and `Show preview` — now the only actions, both quiet. Jump is
  promoted to leftmost since going and looking is the whole point.
- The invalid-edit branch, which becomes the *only* failure state and stays expanded by
  default: "Couldn't apply this edit" plus `card.problems`.
- `AiReviewPlayer`, reference chips, `describeOperation`, `toReviewCard`.

### Review findings

A new node kind with two weights, because the difference matters more than the finding:

- **Repaired** — one quiet line nested under its step: `└ checked 0:08 — fixed a black
  flash`. Narrative, not an alert.
- **Unrepaired** — a warning-tone row, the loudest thing in the stream, with `Jump to
  timeline`. This is the one problem auto-apply could not solve, so it is the one thing
  the user must not miss.
- **Stale** (dropped by the intersection rule) — renders nothing at all. It describes a
  timeline that no longer exists; showing it would be noise about a non-problem.

### Run footer and Undo

- `Made N edits` plus `[ Undo run ]`, reverting the whole grouped run via `undoProject`.
- The button is live **only while that run is still the top of the history stack**. Once
  anything else is committed it degrades to plain text, because at that point it can no
  longer honestly claim to undo just that run. This is the safety net made visible, and
  it must never overstate what it does.

---

## Patch sequence

Each step is independently reviewable and leaves the tree green.

### 1. `packages/ai-sdk` — single writer — DONE

- Delete `stagedDiffs` / `reviewGateRequested` staging from `streamEditorRun`; emit diffs live.
- Delete the bounded-repair branch and `releaseUnreviewedDiffs`. Review no longer calls
  `streamEdit`.
- New `reviewTurn(...)` reader wrapping the existing acquirers, `reviewTemporalEvidence` /
  `reviewVisionObjectives` / `critique` — unchanged contracts, no patch output.
- New `review-findings.ts`: finding shape, staleness intersection, drain queue. Pure.
- New `ReviewFindingEvent` + `ReviewFindingNode`. `DiffEvent` gains `planStepId`;
  `verification` loses its gating role (kept as an advisory field for one release so
  persisted runs still parse).

### 2. `apps/desktop` — commit on validation — DONE

- `shouldAutoCommitAiDiff` drops the `verification === 'verified'` requirement; validation
  plus `auto_commit` policy is the authorization. Existing revision-conflict and
  stale-project handling in `main.ts` `beforePublish` is unchanged.
- Spawn/drain per-turn reviews; record findings via `runGatewayCoordinator`.
- `patchPolicy: 'review'` stays *accepted* in `run-contracts.ts` (persisted durable runs
  must keep parsing) but is never produced. Removing the enum member is a schema change
  needing its own migration — deliberately out of scope.

### 3. `apps/web-editor` — the sidebar rework above — DONE

- Step rows absorb receipts; finding rows; run footer with `Undo run`.
- Delete the manual surface listed above.
- Memory signal: replace `recordReviewDecision`'s accept/reject with undo-as-signal — a run
  reversed by Undo is the negative signal, a run that survives is the positive one.

### 4. Tests, docs, plan — DONE

- Pin **undo of an AI edit reaching disk**. Today it works incidentally: `invertProjectPatch`
  stamps the inverse with the original `createdBy` (`patch.ts:267`), so an agent patch's
  inverse is `'agent'`, `manualPatchesForHistoryTransition` filters it out, and it survives
  only because that branch skips `suppressFullAutosaveOnce` and the coarse full-project
  autosave catches it. With Undo as the entire safety net that needs a test, not luck.
- Rewrite `editor-run-adapter.test.ts` and `patch-settlement.test.ts`, which pin the gating
  contract, with the reversal reasoned inline (the discipline ADR 0120 used).
- `AiSidebar.test.tsx` (99KB) and `EventNode.test.tsx` (40KB) carry the decision-flow
  suites; they shrink substantially rather than being rewritten.
- New e2e: a multi-turn agent run moves the timeline before any review completes.
- ADR amending 0119/0120/0121 + CHANGELOG + `plan/PLAN.md` reconciliation.

## Risk

A run whose review later finds a defect has already written to the project file. Accepted:
the finding still arrives in-run and earns a repair turn, and grouped Undo reverses the
whole run in one keystroke. This is the same trade ADR 0120 already made when it chose to
release uncleared work rather than destroy it — the person decides, with the finding in
front of them. We are changing *when* they are told, not *whether*.

---

## Outcome (2026-08-15)

Landed across `packages/ai-sdk`, `apps/desktop`, `apps/web-editor` and the e2e suite.

**Verification.** `pnpm typecheck` and `pnpm lint` clean across all 17 packages.
Tests: ai-sdk 3201, web-editor 2397, desktop 359, editor-core 840, mcp-server 130,
capability-packs 106, ui 42, shared-types 24, website 15 — plus 76 Playwright e2e, all
passing. `review-findings.ts` is at 100% statement/branch/function/line coverage.

The two golden corpora changed by exactly one line — `+ "planStepId": "step-1"` — which is
the intended additive event field and nothing else.

**Two bugs the tests caught while building this**, both fixed in the source rather than the
assertion:

1. `touchedRegion` missed a clip moved verbatim between tracks. The track id is not part of
   the clip, so the JSON compared equal on both sides and the move read as "no change" —
   the single most obviously stale case there is.
2. `planStepId` was being stamped on unplanned runs. The conductor keeps `planSteps`
   internally for status tracking even when no checklist is drafted, so the receipt would
   have been merged into a step that never renders and vanished from the sidebar.

**Deviations from the plan as written**, both deliberate:

- Findings reach the agent through the existing `SteeringQueue` rather than new plumbing
  into the conductor. `runTurn` already pops it at the top of every turn and folds it into
  that turn's context, which is exactly the semantics a finding needs.
- Receipts fold into `PlanAccordion` (the live checklist surface) rather than
  `PlanChecklist`, which the sidebar does not render — the plan node is pulled out of the
  activity list and shown in the header. `PlanChecklist` got the same treatment so the two
  cannot drift.
- The `variants` (A/B takes) surface was a *chooser*, and a chooser cannot survive with no
  decision step. Rather than delete the feature, the tabs now preview the alternatives and
  name which take actually landed (`Take A · applied`, per `DiffEvent.variants`' guarantee
  that `edit` mirrors `variants[0]`). Letting the user swap to another take is a follow-up.

## Follow-ups

- **Late findings.** A finding that settles after the agent has stopped is too late to steer,
  so it surfaces unresolved instead of earning an automatic repair. Absorbing those needs a
  resumable agent loop.
- **Swap take.** Applying a non-primary variant needs an explicit undo-and-apply action.
- **`patchPolicy: 'review'`** stays accepted in `run-contracts.ts` for durable runs recorded
  before this change. Removing the enum member is a schema change needing its own migration.
- **Per-turn review cost.** Review is now off the critical path, but a multi-turn run still
  pays one compile per reviewed turn in CPU. Scoping the evidence plan to only the changed
  region would cut that; it was out of scope here.

---

## Addendum — ai-sdk activity that was visible only in logs (2026-08-15)

A survey of every `log.action(...)` in `packages/ai-sdk` for events that carry real user
meaning and reached no surface. Two were worth fixing and are done:

- **A taught workflow firing.** `matchSavedWorkflow → matched` silently rerouted the run to
  `recipe` with the user's own saved parameters — the entire payoff of having taught it —
  and the only trace was a log line. The run now says which workflow answered.
- **Beat snapping.** `runProposeEdit ← completed` computed `snappedToBeats`, logged it, and
  discarded it; the task summary said only "Proposed N operation(s)". Moving cuts onto real
  onsets is a craft decision an editor cares about, so the count is now in the summary.

Considered and deliberately left alone:

- `effect served from cache` — would explain why a step was instant and free, but it is
  per-effect and would read as chatter next to the work itself. Better expressed as run-level
  cost, which the usage chip already covers.
- `routeCommand`/`streamAuto classified` — the chosen route is already implied by the status
  the run emits (`editing`/`planning`/`thinking`); naming it as well would be redundant.
- `verify → verdict` — already surfaced through its own `summary` string.
- Provider retries (`endpoint rejects temperature …`), warmups, and retention are
  infrastructure: real operational signal, no user decision attached.
