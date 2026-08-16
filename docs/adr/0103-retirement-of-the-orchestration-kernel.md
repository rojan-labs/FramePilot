# ADR 0103: Retirement of the FramePilot orchestration kernel driver

Status: **Accepted** · Date: 2026-08-06 · Phase M12 of
[`plan/LANGCHAIN-MIGRATION.md`](../../plan/LANGCHAIN-MIGRATION.md) ·
Companion to [ADR 0102](./0102-langgraph-orchestration-runtime.md)

## Context

M12 is the migration's stated point of no return. Its precondition — two releases of green
dual-path operation — was **waived by the maintainer on 2026-08-06**, on the evidence
listed in ADR 0102. This ADR records exactly what was removed and, more importantly, what
was not, because the plan's own deletion list was wrong.

## What M12.1 said to delete

> Delete `kernel/conductor.ts`, drivers, effect runtime, DAG scheduler, and the legacy
> loop in `orchestrator.ts`.

That list predates §5.2 ("nodes are shells; decisions stay pure"), which became the
migration's central design decision. Executing it literally would have deleted the design
the migration was built on.

## What was actually deleted

### The kernel driver, and three modules that had no consumer

An audit after the cutover found **three modules built during this migration with zero
non-test callers**. They are removed here rather than left as staged infrastructure —
the same judgement this plan applied to other dead code it found, and it would be
incoherent to apply it to someone else's work and not to our own.

| Removed                                            | Why it had no consumer                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel/checkpoint/wal-checkpointer.ts`            | M5 built a LangGraph checkpointer over the WAL. Its only consumers would have been LangGraph's durable-execution features — `interrupt()` above all — and M9 declined those with reasons that still hold. The graph compiles without a checkpointer; FramePilot's WAL and `resume` effect already provide durability, and adding a second resume mechanism is risk 5 in its real form.                                                                |
| `apps/desktop/electron/ai/run-checkpoint-store.ts` | The desktop half of the same. Nothing constructed it.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `langchain-tools.ts` (`toLangChainTools`)          | M4 derived executable `StructuredTool`s from the registry. But the LangChain provider already binds the registry's tools with the registry's own schemas in `langchain-chat.ts#withTools`, and FramePilot's orchestrator — not LangChain — executes tool calls, because classification, memoization, concurrency safety, analysis caps and patch assembly live in the turn machinery. Letting LangChain execute would mean moving those, for no gain. |

What M4 uniquely guaranteed is preserved: `langchain-parity.test.ts` now asserts the
LangChain provider puts **exactly what MCP advertises** on the wire, names and schemas
byte for byte, at the path that actually runs.

## Original scope

| Removed                                                                | Why it was safe                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `kernel/driver.ts` (`runConductor`)                                    | Replaced node-for-node by `kernel/agent-graph.ts`, proven byte-identical on the M0.2 corpus.                           |
| `driver.test.ts`, `driver.langgraph.test.ts`, `driver.failure.test.ts` | Tests of the deleted module. Their behavioural content lives on in `agent-graph.parity.test.ts` and the golden corpus. |
| The `FRAMEPILOT_AI_ORCHESTRATOR` dual-path branch in `orchestrator.ts` | One runtime remains; a flag selecting between one option is dead configuration.                                        |

## What was deliberately kept, against the plan's text

- **`kernel/conductor.ts`.** It holds the pure decisions the graph _calls_. Deleting it
  would delete §5.2 — the property that keeps orchestration policy table-testable with no
  mocks and replayable after the migration. It is not legacy; it is the half of the design
  that LangGraph does not own.
- **`working-state.ts`, `loop-detector.ts`, `stage-policy.ts`, `analysis-caps.ts`.** The
  run's decision predicates, called from graph nodes and edges.
- **`effect-runtime.ts`, `scheduler.ts`, `graph-executor.ts`, `task-graph.ts`,
  `plan-driver.ts`, `recipe-executor.ts`, `recipe-leaves.ts`.** The plan called this "the
  DAG scheduler" and listed it for deletion. It is not part of the agent loop: it drives
  `streamPlannedEdit` and `streamRecipe`, the planner and the zero-model recipe paths.
  Deleting it would have removed shipping features the migration never touched.

## Consequences

### The safety net changed shape, and that is worth understanding

Before M12, `agent-graph.parity.test.ts` compared the graph against a live second
implementation. With the kernel gone there is no twin, so that file now proves
**determinism** — the same inputs produce the same stream, ids included, twice.

The standing cross-implementation oracle is `replay/golden-corpus.test.ts`: nine sessions
recorded _before_ the cutover, compared byte for byte. That is a stronger guarantee than a
live twin, because a twin can drift with you while a recording cannot.

### What a future reader should know

`kernel/parity.test.ts` (the K1.2 harness) now compares `Orchestrator.streamAgent` against
the direct `runAgentGraph` seam rather than `runConductor`. Its purpose is unchanged: the
seam MCP and Electron main drive must stay behaviour-equivalent to the shipping wrapper.

### Reversal

Not a revert. `runConductor` was ~390 lines over the same reducer, so reconstructing it is
mechanical rather than speculative — but it would have to be rebuilt, and the golden corpus
is what would tell you whether the reconstruction was faithful.
