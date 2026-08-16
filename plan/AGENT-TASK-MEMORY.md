# Agent Task Memory and Execution Continuity

> **Status:** M0–M4 implemented and green (2026-07-26); M5–M6 remaining, M7 partial.
> **Date:** 2026-07-26
> **Architecture:** `docs/architecture/orchestration-execution-engine.md`
> **Decision:** proposed ADR 0075 (`docs/adr/0075-durable-run-working-state.md`)
> **Parent initiative:** `plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md` — this document
> is the detailed design for gate **F6** (context, memory, long-project scale) and the
> memory half of **F7** (recovery). It does not supersede that initiative; it fills in
> the one gate whose failure is now reproducible in production.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

---

## 1. The failure this exists for

A creator asked the agent to cut a ~6-minute video to 60–90 seconds with captions,
animations, and transitions. Over ~3,400 stream events the run re-oriented itself again
and again — re-reading the timeline, re-fetching the transcript, re-mapping unchanged
footage, re-loading the same skills, re-deriving the same story beats, re-drafting nearly
identical plans, announcing it was ready to edit — and never applied a single operation.
The creator stopped it manually. Cancellation worked correctly; it is not part of this
problem.

ADR 0074 analysed the same run and correctly found that **no guard could stop it**
(novelty keys were per-window so the stall guard never advanced; output tokens were high
so diminishing-returns never fired). It added `RESEARCH_BUDGET_TURNS` as the missing
behavioral rail.

That rail is necessary and stays. It is not sufficient, because it treats the symptom:
it forces a model to act on evidence **it can no longer see**. This document addresses
why the evidence disappears.

### 1.1 Root cause — compaction and the read memo deadlock each other

Per turn, the model's entire memory of the run is rebuilt from scratch in
`Orchestrator.agentMessages` (`packages/ai-sdk/src/orchestrator.ts:1622`):

```
[ buildContext(project) ]
  + [ stable head: system contract + drafted plan + pinned skills ]
  + [ compactAgentLog(log) ]        ← the ONLY record of every prior turn
```

`log` is a `string[]` of note lines. Prior assistant/tool messages are **not** threaded
forward; each iteration re-derives one user message. There is no structured state.

Two independent mechanisms then act on that single channel, and they contradict:

**(a) Compaction deletes the payloads and instructs the model to re-read**
(`orchestrator.ts:385`, `:331`):

- `AGENT_LOG_CLEAR_THRESHOLD_TOKENS = 1000` — any real editing run crosses this by
  turn ~2.
- Past it, every entry older than `AGENT_LOG_PAYLOAD_FRESH = 2` turns has its payload
  replaced by the literal marker `[old result cleared — re-read if needed]`.
- Past `AGENT_LOG_RECENT = 6`, entries collapse into
  `(… N earlier steps summarized for brevity)` — a digest line carrying **zero**
  content: no facts, no decisions, no stage, no timestamps.

**(b) The read memo refuses to serve the data back** (`orchestrator.ts:1926`):

```ts
const memoized = host.readCache?.get(readKey);
if (memoized) {
  return {
    ops: [],
    fromCache: true,
    note: `${desc} → unchanged since you last called it —
           this is already in your context; act on it rather than reading it again.`,
    data: memoized.data, // ← surfaced to the UI "View details" popup ONLY
  };
}
```

`note` is what the model reads. `data` is what the UI shows. The model receives a
scolding and no transcript.

So from roughly turn 4 the run tells the model both _"cleared — re-read if needed"_ and,
when it obeys, _"already in your context, stop re-reading"_ — while returning nothing.
**There is no path by which the model can recover the data.**

The only escape the model has is to vary the call: `get_transcript{0,60}` →
`get_transcript{0,120}`. Different `callMemoKey` → memo miss → real payload → and, before
ADR 0074's coarsened `callNoveltyKey`, a "novel" result that reset the stall streak. The
observed loop is the exact, predictable output of these three rules composed.

**Compounding:** `host.readCache?.clear()` (`orchestrator.ts:1858`, `:2009`) wipes the
_entire_ memo whenever an edit applies. A transcript is not invalidated by a timeline
cut, but it is discarded anyway — the precise opposite of revision-scoped invalidation.

### 1.2 Why the architecture permits this

`packages/ai-sdk/src/scoped-memory.ts:5` documents five memory scopes, and states the
gap as an intentional design property:

> **task** — one task's inputs + prior results; _ephemeral_, never persisted. This is the
> scheduler's in-flight task-result state — derivable, so it is not a store here.

Task state is **not** derivable. It is destroyed by compaction and unrecoverable from the
memo. Everything below follows from making that scope real.

### 1.3 Non-goals

Explicitly rejected as fixes, per the brief:

- raising `AGENT_LOG_RECENT` / the clearing threshold / the context window;
- raising `RESEARCH_BUDGET_TURNS`, `DEFAULT_MAX_AGENT_STEPS`, or any other limit;
- adding prompt language telling the model not to repeat itself.

Each makes the loop longer, not finite. The run must carry state the model cannot lose.

---

## 2. Guardrails

Inherited from `ORCHESTRATION-FOUNDATION-INITIATIVE.md`, plus memory-specific ones:

- Preserve all five project invariants; no direct AI mutation of project JSON.
- Every timeline change remains a validated, reversible, typed patch.
- Working state is **derived data**, never authority: the project file and the patch
  log stay the source of truth. A corrupt or absent working state degrades the run to
  today's behavior, never to a wrong edit.
- Working state is additive and versioned; an unparseable one is dropped, not thrown
  (same defensive contract as `memory-store.ts` / `workflow-memory.ts`).
- No behavioral change without parity: `kernel/conductor.ts` and the legacy
  `orchestrator.ts#agent` loop must judge state identically, or `parity.test.ts` fails.
- The Conductor stays a **pure reducer**. Working state lives in `ConductorState`;
  distillation (which needs I/O and model calls) happens in handlers and folds back
  through `onEffectResult`.
- No big-bang cutover. Every phase below is independently shippable and reversible.
- `pnpm verify` green at every phase; new deterministic modules at 100% coverage.

---

## 3. Design

### 3.1 `RunWorkingState` — durable task memory

One versioned record per run, owned by the Conductor, persisted with the run snapshot,
and rebuilt into every model call. It stores **conclusions**, not payloads.

```ts
/** packages/ai-sdk/src/kernel/working-state.ts (new) */
export interface RunWorkingState {
  readonly schemaVersion: 1;
  readonly runId: string;
  /** Bumped on every mutation; the observability "task-memory version". */
  readonly version: number;

  // — objective (written once at Stage 1, never rewritten by a later turn) —
  readonly objective: {
    /** The creator's request, verbatim. */
    readonly request: string;
    /** The required final outcome, distilled ("≤90s vertical cut, captioned"). */
    readonly outcome: string;
    /** Checkable completion criteria, each independently verifiable. */
    readonly acceptance: readonly AcceptanceCriterion[];
  };

  // — stage machine (§3.2) —
  readonly stage: RunStage;
  readonly completedStages: readonly RunStage[];
  readonly stageEnteredAtTurn: number;

  // — knowledge (§3.4) —
  readonly facts: readonly Fact[];
  readonly decisions: readonly Decision[];
  readonly evidence: readonly EvidenceHandle[];

  // — execution record —
  readonly objectives: readonly Objective[]; // remaining + satisfied
  readonly operations: readonly OperationRecord[]; // attempted / succeeded / failed
  readonly verifications: readonly VerificationRecord[];

  // — forward pointer —
  readonly nextAction: NextAction | null;
  readonly blockedOn: Blocker | null;

  // — revision binding (§3.7) —
  readonly baseProjectRevision: ProjectRevision;
  readonly currentProjectRevision: ProjectRevision;
}
```

Supporting types:

```ts
export interface Fact {
  readonly id: string;
  readonly kind: 'project' | 'asset' | 'transcript' | 'footage' | 'audio' | 'derived';
  /** One line, model-facing. "Source runs 6:04; single asset A1, 1080x1920." */
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  /** Revisions this fact survives; see §3.7. */
  readonly scope: 'revision_independent' | 'timeline_dependent';
  readonly observedAtRevision: ProjectRevision;
  readonly stage: RunStage;
}

export interface Decision {
  readonly id: string;
  /** "Keep 0:12–0:26, 1:48–2:03, 4:31–4:58 as the three beats." */
  readonly decision: string;
  readonly evidenceIds: readonly string[];
  readonly stage: RunStage;
  readonly status: 'tentative' | 'committed' | 'superseded';
  /** What would justify reopening it — the ONLY admissible reason to revisit. */
  readonly reconsiderIf: string;
  readonly supersededBy?: string;
}

export interface OperationRecord {
  readonly id: string;
  readonly intent: string; // "ripple_delete 2:10–3:40"
  readonly status: 'attempted' | 'succeeded' | 'failed';
  readonly patchId?: string; // set on success — ties to the reversible patch
  readonly atRevision: ProjectRevision;
  readonly failureReason?: string;
  readonly attempts: number;
}

export interface NextAction {
  readonly stage: RunStage;
  /** Imperative and executable. "Apply ripple_delete for the three drop ranges." */
  readonly action: string;
  readonly toolHint?: string;
  readonly objectiveId: string;
}
```

**Where it lives.** `ConductorState.working: RunWorkingState`. It rides the existing
resume `CheckpointEvent` and the desktop `RunSnapshot` (`run-contracts.ts:306`), which
already carries `baseProjectRevision` / `currentProjectRevision` — the binding in §3.7
needs no new plumbing. Persisting it is what makes the state survive renderer reload,
process restart, provider switch, and cancellation-then-resume.

### 3.2 The stage machine

Nine stages, on `ConductorState` alongside — not replacing — the existing coarse
`RunPhase` (`conductor.ts:210`). `RunPhase` describes the _harness_ (planning, executing,
verifying, review); `RunStage` describes the _task_. They are orthogonal and both are
needed: a repair turn is `phase: 'executing'` but `stage: 'repair'`.

| #   | Stage       | Entry requires                   | May collect                               | Output                                       | Complete when                                             | Next                                             | Revisit only if                                        |
| --- | ----------- | -------------------------------- | ----------------------------------------- | -------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| 1   | `interpret` | run accepted                     | nothing (model + request only)            | `objective` + `acceptance`                   | objective and ≥1 criterion written                        | `inspect`                                        | never — a re-interpret is a new run                    |
| 2   | `inspect`   | objective set                    | project/timeline/asset reads              | project + asset facts                        | every acceptance criterion has its required project facts | `analyze`, or `plan` if no media analysis needed | a fact's `observedAtRevision` was invalidated (§3.7)   |
| 3   | `analyze`   | inspect complete                 | transcript, footage map, silence, skills  | content facts + tentative beats              | the plan's required inputs are all present                | `plan`                                           | a needed input is missing/incomplete, named explicitly |
| 4   | `plan`      | analyze complete                 | nothing new (§3.6 closes reads)           | committed `Decision`s + ordered `Objective`s | plan validated and all its decisions `committed`          | `apply`                                          | a committed decision's `reconsiderIf` is met           |
| 5   | `apply`     | plan locked                      | timeline reads for the step being applied | applied patches                              | all structural objectives `succeeded`                     | `enhance`                                        | —                                                      |
| 6   | `enhance`   | apply verified                   | caption/animation/transition context      | applied enhancement patches                  | all enhancement objectives `succeeded`                    | `verify`                                         | —                                                      |
| 7   | `verify`    | ≥1 patch applied                 | verification reads                        | `VerificationRecord`s                        | every acceptance criterion checked                        | `complete`, or `repair` on failure               | —                                                      |
| 8   | `repair`    | verify found a failure           | context for the failing item only         | corrective patches                           | the failure clears, or is reported as a blocker           | `verify`                                         | bounded: `MAX_REPAIR_CYCLES`                           |
| 9   | `complete`  | verify passed, or a real blocker | nothing                                   | run report                                   | terminal                                                  | —                                                | —                                                      |

**The forward-only rule.** Stage may only advance, or move to an explicitly enumerated
revisit target, and **a new reasoning cycle is never itself a reason to change stage**.
Regression is a pure-reducer decision requiring a named cause recorded as a `Fact`. This
is what structurally prevents "let me first understand the project" on turn 12.

`apply` and `enhance` are separate stages, not one, because §3.8 requires verification
between structural and decorative work — captions applied against pre-cut timings are the
classic silent failure.

### 3.3 Context assembly — the state briefing

`agentMessages` is replaced (behind a flag, §5 Phase 3) by a briefing built from
`RunWorkingState`, not from `compactAgentLog`:

```
[ system contract ]                                     ← unchanged, cache-stable
[ pinned skills (ADR 0057) ]                            ← unchanged
[ RUN STATE — objective, outcome, acceptance criteria ]
[ STAGE — current, completed, why you are here ]
[ ESTABLISHED FACTS — one line each, with evidence ids ]
[ COMMITTED DECISIONS — decision + reconsiderIf ]
[ OBJECTIVES — satisfied ✓ / remaining ]
[ OPERATIONS — succeeded (patch ids) / failed (reasons) ]
[ VERIFICATIONS — what passed, what did not ]
[ DO NOT REPEAT — operations already completed at this revision ]
[ NEXT ACTION — the one imperative instruction for this turn ]
[ recent turn notes (short rolling tail, for continuity of prose only) ]
```

Ordering preserves E3.2 prompt-prefix cache stability: run-stable head first, turn-varying
tail last. The briefing is **bounded by construction** — facts and decisions are one line
each — so it does not grow with project duration, which is the F6 exit gate.

The per-turn instruction is explicit: _continue this run; do not restart analysis; do not
repeat completed operations; execute the next action; report what changed._

### 3.4 Raw evidence vs. operational memory

The two are separated. Raw payloads (transcripts, footage maps, silence reports, project
slices) go to an **evidence store** keyed by handle; only distilled `Fact`s and
`Decision`s enter the briefing.

- **Store.** The existing per-run `readCache` becomes the evidence store: keyed by
  `callMemoKey`, holding the full payload plus an `EvidenceHandle` id.
- **Distil.** After a read/analysis call settles, a distillation step converts the payload
  into `Fact`s carrying `evidenceIds`. Cheap deterministic distillation where the shape is
  known (durations, ranges, counts); a small-tier model call (`ModelTier` `'small'`,
  already supported by `effect-runtime.ts`) where it is genuinely semantic (story beats,
  strongest hook). Distillation runs **once per evidence handle**, at the moment the
  payload is freshest — this is the fix for "clearing large tool results before extracting
  useful conclusions".
- **Retrieve.** A new `recall_evidence(evidenceId, query?)` tool returns a bounded slice
  of the stored payload. This is the path the model currently does not have, and its
  absence is half the deadlock.

**The memo's reply changes.** A cache hit must never again say "this is already in your
context" while withholding data. It returns the distilled facts plus the evidence handle,
and — when the caller asks for a window it has not seen — the actual slice.

### 3.5 Duplicate detection, semantic loop detection, progress

Three distinct guards, deliberately not merged:

**(a) Duplicate operations (exact).** Before dispatch, key on
`(operation type, normalized args, relevant project revision)`. A completed equivalent
returns the cached result and its distilled conclusion, and is recorded as a memo hit —
never re-executed. Extends `effect-runtime.ts`'s existing idempotency-key dedup from
"per-run" to "per-run, per-revision, revision-scoped invalidation" (§3.7).

**(b) Semantic loops (intent).** Each turn declares its **intent** — one short
normalized purpose string, distilled from the turn's reasoning by the same small-tier
call that distils facts. "Let me orient myself", "let me get the full picture", "let me
first understand the project" all normalize to `orient`. Track the last K intents; if
`SEMANTIC_LOOP_TURNS` (proposed: 3) consecutive turns share an intent **and** the stage
has not advanced **and** no decision was committed, the run is looping.

Response — never a restart: freeze planning, load the working state, take the latest
confirmed stage, take the first unsatisfied objective, synthesize a concrete `NextAction`,
continue. If no executable action exists, escalate to the recovery path (c).

**(c) Meaningful progress.** A turn made progress iff it did at least one of: acquired a
genuinely new fact; committed a decision; attempted an operation; recorded a verification;
resolved a failure; advanced the stage; satisfied an objective. Reasoning text, stream
events, status updates, repeated summaries, and memo hits are explicitly **not** progress.

After `MAX_NO_PROGRESS_TURNS` (proposed: 2) the run enters **recovery**: a single
structured, non-streaming model call answering exactly — requested outcome; what is done;
known facts; committed decisions; current stage; the one remaining action; what blocked
it; the smallest valid next execution step. Its output must be a `NextAction`, and it is
schema-constrained so it _cannot_ be a plan. If recovery cannot produce an action, the run
finalizes with an honest blocker report (ADR 0074's empty-run honesty carries this).

This subsumes and generalizes the existing `stallStreak`; `researchStreak` /
`RESEARCH_BUDGET_TURNS` remains as the backstop rail for the case where distillation
itself misbehaves.

### 3.6 The planning→execution boundary

Stage 4 (`plan`) closes when its decision set is complete. For the canonical
shorten-plus-enhance request that means: source duration; target duration; narrative
beats; ranges to keep; ranges to remove; enhancement strategy. All six are `Decision`s
with `status: 'committed'`.

On close, the boundary is enforced **structurally, not by instruction** — reusing ADR
0068's action-recovery mechanism, which already withholds tool descriptors: read and
analysis tool descriptors are withheld in `apply`/`enhance` unless a specific
`Blocker` names the missing dependency. `recall_evidence` stays available, because reading
back a stored conclusion is not re-research.

`MAX_PLANNING_TURNS` bounds stages 2–4 in aggregate. Hitting it forces stage advance with
the best committed decision set, and records a `Fact` saying so.

### 3.7 Project-revision awareness

Every `Fact`, `Decision`, and `OperationRecord` carries `observedAtRevision` /
`atRevision`. `RunSnapshot` already tracks `baseProjectRevision` and
`currentProjectRevision` — this reuses that, no new concept.

On an applied patch: bump `currentProjectRevision`; invalidate **only**
`scope: 'timeline_dependent'` facts (clip ids, positions, durations, gaps); preserve
`revision_independent` facts (transcript text, footage map, source asset duration,
loaded skills, the creator's objective). Stage, decisions, and objectives are untouched.

This directly replaces `readCache.clear()` (`orchestrator.ts:1858`, `:2009`), which today
discards the transcript because a cut landed.

A revision conflict from an outside edit (the F3 revisioned command service) invalidates
timeline-dependent facts and returns the run to `apply` with its plan intact — never to
`inspect`.

### 3.8 Incremental, verified execution

Stages 5–7 execute the locked plan in verifiable increments, persisting working state
after each success: apply cuts → verify duration + beat order → captions → verify timing
and placement → animations → verify → transitions → verify placement → final project
validation.

A failure at any step enters `repair` scoped to _that step_, with the prior successes
intact. Recovery resumes from the last confirmed step — never from orientation.

**Tool results are evidence, not completion.** Reading a transcript, mapping footage,
selecting timestamps, and drafting a plan are all non-completion. An `Objective` is
satisfied only by an applied, validated patch plus a passing `VerificationRecord`. The
run's completion report is computed from `operations` and `verifications`, never from the
model's assertion that it is done.

### 3.9 Event noise and observability

Today every streamed token fragment is persisted as a durable `run.stream_event` — 3,428
sequences for one run, which is what made this failure hard to diagnose.

Split the two channels:

- **Presentation stream** — token deltas, reasoning fragments. Delivered to the UI,
  coalesced, **not** durable orchestration memory.
- **Orchestration log** — durable, replayable, one event per meaningful transition:
  `stage.entered`, `fact.recorded`, `decision.committed`, `operation.started`,
  `operation.succeeded`, `operation.failed`, `revision.changed`,
  `verification.completed`, `duplicate.blocked`, `loop.detected`, `recovery.triggered`,
  `run.completed`.

Snapshots persist the compact `RunWorkingState`, not "latest output text + `generating`".

Per model iteration, log (as one structured record): stage; working-state `version`;
project revision; fact ids supplied; decision ids supplied; next action supplied;
duplicates blocked; entries omitted for size; whether distillation or compaction ran;
whether any required state was unavailable; and whether the turn produced meaningful
progress. This makes "where did it forget" a query, not an investigation.

---

## 4. Phases

Sized so each is independently shippable, reversible, and reviewable on its own.

### M0 — Failing evidence `[x]`

- [x] Regression test reproducing the deadlock deterministically: a fake provider that
      reads the transcript, then re-reads it after `AGENT_LOG_PAYLOAD_FRESH` turns;
      assert the model-facing note contains no transcript content. **Must fail today.**
- [x] Test asserting `readCache.clear()` on an applied edit destroys a
      revision-independent transcript result. **Must fail today.**
- [x] Golden fixture: 6-minute single-asset project, "cut to 60–90s with captions,
      animations, transitions". Record today's turn count, applied-op count (0), and
      duplicate-read count as the documented baseline.

**Exit gate:** the loop is reproducible in CI without a live model.

### M1 — Working state + honest memo `[x]`

Smallest change that breaks the reported loop.

- [x] `kernel/working-state.ts`: schema, constructors, pure reducers, 100% coverage.
- [x] `ConductorState.working`; thread through `onCommand` / `onTurnResult` /
      `onEffectResult`; mirror in the legacy loop for `parity.test.ts`.
- [x] Memo hit returns distilled facts + evidence handle + requested slice — delete the
      "already in your context" note.
- [x] `recall_evidence` tool.
- [x] Replace `readCache.clear()` with revision-scoped invalidation (§3.7).
- [x] Persist working state in `RunSnapshot` + the resume checkpoint (additive,
      versioned).

**Exit gate:** M0's first two tests pass; the golden fixture applies ≥1 operation.

### M2 — Stages, decision ledger, planning boundary `[x]`

- [x] `RunStage` + the §3.2 transition table as a pure, exhaustively tested reducer.
- [x] Decision ledger with `committed` / `reconsiderIf` / `superseded`.
- [x] Stage-scoped tool exposure; `MAX_PLANNING_TURNS`; structural read withholding in
      `apply`/`enhance` (reusing ADR 0068).
- [x] Forward-only enforcement: regression requires a named recorded cause.

**Exit gate:** the fixture inspects once, analyses once, produces one stable plan, and
enters `apply` within `MAX_PLANNING_TURNS`.

### M3 — Briefing context assembly `[x]`

- [x] Distillation step (deterministic + small-tier model) writing `Fact`s per evidence
      handle.
- [x] `buildStateBriefing` replacing `compactAgentLog` as the primary memory channel,
      behind a flag; keep the short prose tail.
- [x] Prompt-prefix cache stability verified (E3.2) — assert the stable head is
      byte-identical across turns.
- [x] Retire `CLEARED_RESULT_MARKER` and its "re-read if needed" wording.

**Exit gate:** briefing size is flat in project duration on the 4-hour fixture (F6 gate).

### M4 — Loop detection, progress, recovery `[x]`

- [x] Per-turn intent distillation and normalization.
- [x] `SEMANTIC_LOOP_TURNS` detector; response resumes from working state, never restarts.
- [x] Meaningful-progress predicate; `MAX_NO_PROGRESS_TURNS`.
- [x] Schema-constrained recovery call that can only emit a `NextAction`.

**Exit gate:** an adversarial fake provider that always emits orient-flavoured reasoning
is forced into execution within `SEMANTIC_LOOP_TURNS + 1` turns.

### M5 — Incremental verified execution `[ ]`

- [ ] Per-increment apply→verify with working-state persistence after each success.
- [ ] Scoped `repair` with `MAX_REPAIR_CYCLES`; resume from the failed step.
- [ ] Completion computed from `operations` + `verifications`, never asserted.

**Exit gate:** an injected failure at the caption step resumes at captions, keeps the
applied cuts, and never re-enters `inspect`.

### M6 — Event split and observability `[ ]`

- [ ] Presentation stream vs. durable orchestration log (§3.9).
- [ ] Per-iteration structured context-retention record.
- [ ] Snapshots carry working state, not latest-text.
- [ ] Prove the golden run persists orders of magnitude fewer durable events.

**Exit gate:** the fixture's durable orchestration events are countable by hand; a
diagnostic query answers "what did the run know at turn N".

### M7 — Consolidation `[~]`

- [ ] Remove the M3 flag; delete `compactAgentLog`'s payload-clearing tier.
- [ ] Reconcile with ADR 0074's rails (keep as backstops; re-tune only with evidence).
- [ ] Update `docs/architecture/orchestration-execution-engine.md` and
      `docs/runbooks/ai-run-lifecycle.md`; accept ADR 0075.

### Delivered so far (2026-07-26)

M0–M4 are implemented, on `feat/agent-task-memory`, with the whole workspace green
(16 packages, `@framepilot/ai-sdk` at 1,869 tests). New deterministic modules —
`working-state.ts`, `evidence-store.ts`, `stage-policy.ts`, `briefing.ts`,
`loop-detector.ts` — are each at 100% statement/branch/function/line coverage.

Two deviations from the design above, both deliberate:

1. **Distillation is deterministic only.** §3.4 calls for a small-tier model call where a
   conclusion is genuinely semantic (the strongest hook, the story beats). Only the
   deterministic half shipped: each settled read becomes a line stating what is known and
   which handle holds it. A heuristic standing in for the semantic half would produce
   confident, wrong facts that the run then retains — worse than having none, and it would
   corrupt the decision ledger it feeds.

2. **The decision ledger is built but not yet populated by the run.** `recordDecision` /
   `commitDecision` / `supersedeDecision` and the briefing's DECIDED section are complete
   and tested; nothing in the loop writes to them yet, because deciding "these are the
   three beats, committed" is exactly the semantic distillation deferred in (1). Until
   then the planning→execution boundary is enforced by stage and budget rather than by a
   complete decision set, which is weaker than §3.6 specifies but not weaker than what
   shipped before it.

**M5** (incremental verified execution) depends on objectives existing, which depends on
interpreting the request into acceptance criteria — the same deferred step. **M6** (event
split) is independent of both and touches the desktop run store rather than the SDK.

---

## 5. Test matrix

Primary scenario, asserted end to end: _"Edit the current six-minute video into a 60–90
second version with proper captions, animations, and transitions."_

| #   | Assertion                                                  | Phase |
| --- | ---------------------------------------------------------- | ----- |
| 1   | timeline inspected exactly once                            | M2    |
| 2   | each transcript section fetched exactly once               | M1    |
| 3   | unchanged footage mapped exactly once                      | M1    |
| 4   | each skill loaded exactly once                             | M1    |
| 5   | exactly one plan committed                                 | M2    |
| 6   | execution begins within `MAX_PLANNING_TURNS`               | M2    |
| 7   | selected timestamps byte-identical across every later turn | M1    |
| 8   | real timeline operations applied                           | M1    |
| 9   | stage never regresses after a tool call                    | M2    |
| 10  | plan not rebuilt without a recorded `reconsiderIf` trigger | M2    |
| 11  | post-failure run resumes at the failed step                | M5    |
| 12  | final duration and each enhancement verified               | M5    |
| 13  | run stops only on completion or a reported blocker         | M4    |

Robustness cases, each with its own fixture:

| Case                                | Must hold                                                        |
| ----------------------------------- | ---------------------------------------------------------------- |
| project exceeding model context     | briefing size flat; retrieval targeted                           |
| transcript too large for one prompt | distilled facts + `recall_evidence` slices                       |
| context compaction mid-run          | decisions and stage survive verbatim                             |
| model-provider switch mid-run       | working state provider-independent; run continues                |
| tool failure                        | recorded as `failed` operation; repair scoped; no re-orientation |
| stream interruption                 | presentation loss only; orchestration log intact                 |
| desktop reload / process restart    | working state rehydrates from snapshot; stage preserved          |
| timeline mutated during execution   | timeline-dependent facts invalidated only; plan intact           |
| multiple assets                     | facts asset-scoped; no cross-asset invalidation                  |
| multi-stage creative task           | stages 5–7 iterate per increment                                 |
| cancel then resume                  | resumes at last confirmed stage, not at `interpret`              |

Plus: `parity.test.ts` extended so Conductor and legacy loop agree on stage, facts,
decisions, and progress; property test asserting stage never decreases without a recorded
cause; `streamAgent-golden.test.ts.snap` regenerated with justification per change.

---

## 6. Success measures

The run is measured by project progress, not event count.

- Duplicate reads of unchanged material per run: **0**.
- Turns before the first applied operation on the canonical request: **≤ 5**.
- Stage regressions without a recorded cause: **0**.
- Committed decisions surviving to run end unchanged (absent a `reconsiderIf` trigger):
  **100%**.
- Runs finishing with zero applied ops **and** no honest blocker report: **0**.
- Durable orchestration events for the canonical run: **< 100** (baseline 3,430).
- Briefing tokens: flat in project duration.

---

## 7. Open questions

1. **Distillation cost and latency.** A small-tier call per read adds a turn-boundary
   hop. Deterministic distillation covers durations/ranges/counts; the semantic cases
   (beats, hook) are the ones that need a model. Measure before assuming it must be
   batched into the main turn.
2. **Distillation fidelity.** A wrong distilled fact is worse than a missing one — it is
   confidently retained. Mitigation: every `Fact` carries `evidenceIds`, and
   `recall_evidence` lets the model check. Needs a fixture where distillation is
   deliberately wrong.
3. **Intent normalization.** Model-produced intent labels may drift. Consider a closed
   enum over free text, at the cost of expressiveness.
4. **Stage fit beyond shorten-and-enhance.** The nine stages are drawn from that request.
   Validate against `create_short`, `remove_silence`, `add_captions`, and a
   multi-scene documentary plan before locking the table.
5. **Interaction with ADR 0074.** Once §3.5(c) lands, `RESEARCH_BUDGET_TURNS` should
   rarely fire. Keep it as a backstop; re-tune only against measured runs.
