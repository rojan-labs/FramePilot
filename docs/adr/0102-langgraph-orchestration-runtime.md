# ADR 0102: LangGraph is the orchestration runtime

Status: **Accepted** · Date: 2026-08-06 · Phase M12 of
[`plan/LANGCHAIN-MIGRATION.md`](../../plan/LANGCHAIN-MIGRATION.md)

**Supersedes or amends:** [0012](./0012-ai-tool-boundary.md) (AI tool boundary +
orchestrator), [0033](./0033-streaming-ai-sidebar.md), [0035](./0035-reliable-orchestration.md),
[0042](./0042-orchestration-kernel.md), [0044](./0044-orchestration-kernel-graduated.md),
[0073](./0073-durable-orchestration-runtime.md), [0075](./0075-durable-run-working-state.md),
[0081](./0081-run-state-causal-integrity.md), [0082](./0082-dag-owned-leaf-bindings.md)
in the parts that describe _how the agent loop is driven_. Every invariant those ADRs
establish is unchanged — see "What did not change".

**Complements:** [0098](./0098-langchain-adapter-at-the-provider-seam.md) (providers),
[0099](./0099-langgraph-conductor-runtime.md) (the shell migration this completes),
[0100](./0100-no-langchain-in-python.md), [0101](./0101-no-langsmith-tracing.md).

## Decision

`kernel/agent-graph.ts` — a LangGraph `StateGraph` with one named node per
`ConductorEffect` kind — is the only runtime that drives an agent run.
`kernel/driver.ts` and its `runConductor` entry point are deleted.

## What the graph is

```
START → dispatch → select_effect ─┬→ draft_plan     ─┐
                                  ├→ resume          │
                                  ├→ await_approval  ├→ (fold through the pure
                                  ├→ run_turn        │   decision, re-select)
                                  ├→ verify         ─┘
                                  └→ finalize → END
```

Each execution node is a **shell**: it runs its typed handler, then calls the matching
pure decision exported from `conductor.ts` — `onDraftPlanResult`, `onApprovalResult`,
`onResumeResult`, `onTurnResult`, `onVerifyResult`. The node does I/O; the decision does
policy; nothing does both.

## What did not change, and why that is the point

- **The reducer is still the policy.** `conductor.ts` was not deleted and was not
  rewritten. The graph calls the same decision functions the old `onEffectResult`
  dispatched to, so there is exactly one implementation of the run's control flow.
- **The WAL is still the only execution authority** (ADR 0073), and **no LangGraph
  checkpointer exists**. The graph is compiled without one: durability is FramePilot's
  WAL plus the existing `resume` effect, which the graph honours through its `resume`
  node. A LangGraph checkpointer was built during M5 and then **deleted**, because with
  `interrupt()` declined (see below) nothing consumed it, and a second resume mechanism
  beside FramePilot's own is §7 risk 5 in its real form — two authorities disagreeing
  about where a run got to. See ADR 0103.
- **Event ids are still ours** (§7.4). `seq` is FramePilot's monotonic sequence; each node
  seeds an emitter from the reducer's state and the reducer continues from the handler's
  `endSeq`. `streamEvents` is not used to construct user-visible events.
- **The five product invariants hold**: typed reversible operations validated before
  apply, AI emits patches and never raw project mutations, patch → validate → preview →
  validate-render, MoviePy render-only, wipe-guard and `unavailable`-tool refusal inside
  the tool path.

  > **Superseded in part (2026-08-30, ADR 0166).** The wipe guard was removed — it
  > refused legitimate user-intended track clears. The `unavailable`-tool refusal and
  > every other invariant listed here still hold inside the tool path. The corpus below
  > is now eight sessions: `wipe-guard-trigger` was deleted with the guard.

## Evidence this was safe to cut over

Not "the tests pass" — the specific oracles the plan required:

1. **The M0.2 golden corpus** — nine recorded sessions (wipe-guard trigger, `load_skill`
   chain, mid-stream cancellation, plan approval, `ask` round trip, multi-turn cache
   boundary, loop-detector stop, `unavailable` refusal, rejected patch) replay
   **byte-identical on the graph**, comparing event streams _including ids_, operations
   and terminal status.
2. **The frozen `streamAgent` golden** (K1.3's cutover gate, captured from the
   pre-kernel loop) still reproduces exactly.
3. The full suite — 2,980 ai-sdk, 263 desktop, 2,318 web-editor, 76 e2e — passes with the
   graph as the runtime.

## Two things this cutover found

Both were invisible to a passing test suite and are recorded because they are the
failure modes anyone repeating this work will hit.

1. **LangGraph discards a superstep's custom-stream writes on abort or throw.** Routing
   `AiEvent`s through `getWriter` meant a Stop mid-turn dropped every event the handler
   had already emitted — the settled-as-cancelled tool card, the resume checkpoint, the
   working state. The graph therefore owns an event queue and never hands LangGraph the
   `AbortSignal`; handlers own cancellation.
2. **The emitter must be seeded at `result.endSeq`, not `state.seq`.** A handler consumes
   sequence numbers while it streams. Seeding before it ran restarted the counter
   underneath its own events, producing a plausible stream with different ids. Caught by
   the corpus after a scripted-handler test had passed.

## Consequences

The exit is now a rewrite rather than a revert, as the plan stated. What limits the
damage is that the _decisions_ — the reducer, the stage table, the loop detector, the
caps — were never moved into the graph. A future migration away from LangGraph replaces
node plumbing, not the orchestration policy.

## Deliberately not deleted

`effect-runtime.ts`, `scheduler.ts`, `graph-executor.ts`, `plan-driver.ts` and
`recipe-executor.ts`. The plan's M12.1 listed the "DAG scheduler" for deletion, but that
machinery drives `streamPlannedEdit` and `streamRecipe` — the planner and zero-model
recipe paths — not the agent loop. Deleting it would have removed working features that
this migration never touched. See ADR 0103 for the full accounting.
