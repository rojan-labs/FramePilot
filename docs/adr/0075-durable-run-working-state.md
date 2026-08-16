# ADR 0075 — Durable run working state and forward-only stage execution

- **Status:** Accepted (decisions 1–7 and 9 implemented; see plan for what remains)
- **Date:** 2026-07-26
- **Relates to:** ADR 0055 (agent loop), ADR 0057 (run-scoped skill ledger), ADR 0068
  (action recovery after cached reads), ADR 0073 (durable orchestration runtime),
  ADR 0074 (research budget and empty-run honesty)
- **Plan:** `plan/AGENT-TASK-MEMORY.md`

## Context

ADR 0074 analysed a run that spent eight turns reading the transcript, mapping the
footage, analysing silence and proposing edits — and applied nothing. It found, correctly,
that no existing guard could stop that shape of failure, and added `RESEARCH_BUDGET_TURNS`
as the missing behavioral rail.

That rail forces the run to act. It does not give the run anything to act _with_, because
the reason the model kept re-gathering is that its knowledge was being deleted underneath
it. Tracing one turn shows a deadlock between two mechanisms that were designed
independently and never composed:

1. **The model's only memory of prior turns is a `string[]` of note lines**, rebuilt from
   scratch each turn by `Orchestrator.agentMessages` (`orchestrator.ts:1622`). Prior
   assistant and tool messages are not threaded forward. There is no structured state.

2. **Compaction deletes that memory and instructs the model to re-read.**
   `AGENT_LOG_CLEAR_THRESHOLD_TOKENS` is 1000 — crossed by turn ~2 in any real run — after
   which every entry older than two turns has its payload replaced by
   `[old result cleared — re-read if needed]`, and everything past six turns collapses
   into a content-free digest line.

3. **The read memo refuses to serve the data back.** A cache hit returns the note
   _"unchanged since you last called it — this is already in your context; act on it
   rather than reading it again"_ and routes the actual payload to the UI popup, not to
   the model (`orchestrator.ts:1926`).

Composed, the run tells the model "cleared, re-read if needed" and then, when it obeys,
"already in your context, stop re-reading" — while returning nothing. **No path exists by
which the model can recover the transcript.** Its only escape is to vary the call
(`get_transcript{0,60}` → `{0,120}`), which is exactly the arg-varying spin ADR 0074
observed. That ADR fixed the _accounting_ for that spin; this one removes its cause.

Compounding it, `readCache.clear()` on every applied patch (`orchestrator.ts:1858`,
`:2009`) discards the whole memo — including a transcript that a timeline cut cannot
invalidate.

The architecture permits this by design: `scoped-memory.ts:5` documents the **task** scope
as _"ephemeral, never persisted... derivable, so it is not a store here."_ It is not
derivable. That is the defect.

Raising the window, the thresholds, the step cap or the research budget makes the loop
longer, not finite. Adding prompt language asking the model not to repeat itself asks it
to remember something it was not given.

## Decision

**1. Task memory becomes a real, durable scope.** A versioned `RunWorkingState` — one
record per run, owned by the Conductor, persisted with the run snapshot and the resume
checkpoint — holds the objective, acceptance criteria, current stage, established facts,
a decision ledger, objectives, attempted/succeeded/failed operations, verification
results, and the single next action. It stores **conclusions, not payloads**, so it is
bounded independently of project duration. It is derived data, never authority: the
project file and the reversible patch log remain the source of truth, and a missing or
unparseable working state degrades the run to today's behavior rather than to a wrong
edit.

**2. Raw evidence and operational memory are separated.** Full payloads live in a
per-run evidence store keyed by handle (today's `readCache`, generalized). Each payload is
distilled **once, while it is freshest**, into one-line facts carrying evidence ids. Only
those facts enter the prompt. A new `recall_evidence` tool provides targeted retrieval of
a stored payload — the path that does not exist today and whose absence is half the
deadlock. A memo hit returns distilled facts plus the requested slice; it never again
withholds data while claiming the model already has it.

**3. Every model call receives a state briefing, not a history.** Objective, stage,
facts, committed decisions, satisfied and remaining objectives, succeeded and failed
operations, verifications, operations that must not be repeated, and the one next action —
in that order, so the run-stable head stays prompt-prefix-cache stable (E3.2). The action
log survives only as a short prose tail for continuity, no longer as the memory channel.

**4. Execution is forward-only across explicit task stages.** Nine stages
(`interpret`, `inspect`, `analyze`, `plan`, `apply`, `enhance`, `verify`, `repair`,
`complete`), each with defined entry requirements, permitted information, output,
completion condition, valid successors, and revisit conditions. `RunStage` is orthogonal
to the existing `RunPhase`, which describes the harness rather than the task. A new
reasoning cycle is never itself a reason to change stage: regression requires a named
cause recorded as a fact. Committed decisions are stable unless their recorded
`reconsiderIf` condition is met.

**5. The planning→execution boundary is structural, not advisory.** Once the plan stage's
decision set is complete, read and analysis tool descriptors are withheld in `apply` and
`enhance` unless a blocker names the missing dependency — reusing ADR 0068's mechanism,
since the remedy is identical. `recall_evidence` stays available, because reading back a
stored conclusion is not re-research.

**6. Loops are detected semantically, and detection resumes rather than restarts.** Each
turn declares a normalized intent; consecutive turns sharing an intent without a stage
advance or a committed decision are a loop. The response loads the working state, takes
the latest confirmed stage and first unsatisfied objective, and synthesizes a concrete
next action. A separate meaningful-progress predicate (new fact, committed decision,
attempted operation, verification, resolved failure, stage advance, satisfied objective —
never reasoning text, stream events, or memo hits) triggers, after two barren turns, a
schema-constrained recovery call that can only emit an action, never a plan.

**7. Knowledge is bound to project revisions.** Facts, decisions and operations carry the
revision they describe. An applied patch invalidates only timeline-dependent facts; the
transcript, footage map, source durations, loaded skills and the creator's objective
survive. This replaces `readCache.clear()`. `RunSnapshot` already carries
`baseProjectRevision` and `currentProjectRevision`, so no new concept is introduced.

**8. Completion is computed, not asserted.** Reading a transcript, mapping footage,
selecting timestamps and drafting a plan are evidence, not completion. An objective is
satisfied only by an applied, validated patch plus a passing verification. The run report
is derived from the operation and verification records.

**9. Streaming and orchestration memory are different channels.** Token fragments are
presentation, delivered to the UI and coalesced. Durable orchestration events are the
meaningful transitions only (stage entered, fact recorded, decision committed, operation
started/succeeded/failed, revision changed, verification completed, duplicate blocked,
loop detected, recovery triggered, run completed). Snapshots persist the compact working
state rather than the latest output text.

ADR 0074's rails are kept as backstops. Once the above lands they should rarely fire; they
are re-tuned only against measured runs, never to paper over lost state.

## Consequences

**Positive.** The reported loop becomes structurally impossible: knowledge that would age
out is instead distilled and retained, and the one mechanism that could destroy it is
revision-scoped. Runs survive compaction, provider switching, renderer reload, process
restart, and cancel-then-resume with their stage and decisions intact. Prompt size becomes
flat in project duration, which is the outstanding F6 exit gate. Durable event volume
drops by orders of magnitude, making "where did the run forget something" a query rather
than an investigation.

**Negative and accepted.** Distillation adds a small-tier model call at some turn
boundaries — cost and latency to be measured, with deterministic distillation covering the
non-semantic cases. A wrongly distilled fact is confidently retained, which is worse than a
missing one; mitigated by evidence ids plus `recall_evidence`, and a fixture that
deliberately distils wrong. The nine stages are drawn from the shorten-and-enhance request
and must be validated against `create_short`, `remove_silence`, `add_captions` and a
multi-scene documentary plan before the transition table is locked. `ConductorState` grows
and the reducer gains real surface area, all of which must stay pure and at 100% coverage,
with `parity.test.ts` extended so the legacy loop agrees on stage, facts, decisions and
progress.

**Implementation status (2026-07-26).** Decisions 1–7 are implemented on
`feat/agent-task-memory`; decision 9's snapshot half is done (working state rides the
durable snapshot and the resume checkpoint) while the stream/orchestration event split is
not. Decision 8's machinery exists — delivery is computed from operations and
verifications — but nothing populates objectives yet, because deriving them from the
request needs the semantic distillation step that was deliberately not attempted. Until
that lands, the planning→execution boundary rests on stage and budget rather than on a
complete decision set. See `plan/AGENT-TASK-MEMORY.md` §4 for the detail.

**Rejected alternatives.** Enlarging the log window or clearing threshold, raising the
step cap or research budget, and adding anti-repetition prompt language were all rejected:
each lengthens the loop without bounding it, and none gives the model back knowledge it
was structurally denied. Threading full assistant/tool message history forward was rejected
because it scales with project duration and reintroduces the compaction problem one context
window later.
