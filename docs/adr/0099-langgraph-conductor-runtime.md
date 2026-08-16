# ADR 0099: Use LangGraph as the Conductor runtime

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owners:** FramePilot maintainers
- **Scope:** `packages/ai-sdk` agent orchestration shell

## Context

FramePilot already had the important domain boundaries needed for reliable autonomous editing:

- a pure Conductor reducer owns orchestration policy;
- typed handlers own model calls, tools, verification, approval, and finalization;
- the model can edit only through registered, schema-validated operations;
- patch assembly, validation, application, inversion, rollback, and render verification remain FramePilot-owned;
- durable desktop run state, user questions, approval gates, and resume checkpoints already have application contracts.

The remaining custom component was a bespoke imperative loop in `kernel/driver.ts`. It manually dequeued reducer effects, selected handlers, folded results, and repeated until finalization. The loop worked, but it made future branching, inspection, retry policy, and durable workflow evolution depend on more custom control-flow infrastructure.

## Decision

Use `@langchain/langgraph` as the low-level runtime for the Conductor execution shell.

The graph contains four explicit nodes:

1. `dispatch` initializes the pure reducer and emits opening events.
2. `take_effect` selects the next typed Conductor effect.
3. `execute_effect` invokes the matching FramePilot handler and folds its typed result through the reducer.
4. `finalize` emits the terminal diff, report, and run status.

Conditional edges route between these nodes until the reducer emits its terminal finalization effect.

The public `runConductor(command, handlers, signal)` API remains an `AsyncGenerator<AiEvent>`. LangGraph custom streaming carries existing `AiEvent` objects without changing the web editor, desktop host, event reducer, or conversation persistence contracts.

## Boundaries retained by FramePilot

LangGraph does not become the source of truth for editing or persistence.

FramePilot continues to own:

- provider selection and provider wire formats;
- tool registration and Zod validation;
- typed, reversible timeline and project operations;
- patch validation, apply, inversion, rollback, and undo;
- deterministic media analysis and render verification;
- cost accounting and evidence provenance;
- durable desktop run logs and resume payloads;
- plan approval and `ask_user` controls.

No LangGraph checkpointer is configured in this phase. Adding one would introduce a second durable state system and requires a separate storage, migration, encryption, cleanup, and recovery decision.

## Dependency decision

`@langchain/langgraph` and its required `@langchain/core` runtime are direct dependencies of `@framepilot/ai-sdk`.

FramePilot does not migrate providers to LangChain model wrappers. Existing providers remain stable and are called from the current effect runtime. This keeps the migration focused on orchestration and avoids coupling editor behavior to a provider abstraction rewrite.

## Event and cancellation compatibility

- Existing event ids and sequence ownership remain in the Conductor and handler emitters.
- Graph nodes stream the original `AiEvent` payloads through custom chunks.
- The caller's `AbortSignal` is forwarded unchanged to every executed handler and to graph execution.
- The graph recursion limit is a runtime backstop. Existing FramePilot turn and operation limits remain authoritative.

## Consequences

### Positive

- Orchestration topology is explicit and inspectable.
- Branching and future retry policies can be added at named graph boundaries.
- Existing editing safety contracts remain unchanged.
- Consumers keep the same streaming API.
- The migration is reviewable independently from provider, UI, schema, and render work.

### Costs

- The AI SDK gains two runtime dependencies.
- The workspace lockfile must be regenerated with pnpm after dependency installation.
- Engineers must understand both the pure Conductor reducer and the thin LangGraph shell.
- Durable LangGraph features remain intentionally unavailable until a storage ADR is approved.

## Rejected alternatives

### Replace the whole AI SDK with LangChain agents

Rejected because FramePilot requires domain-specific patch authority, deterministic verification, evidence handling, cost accounting, provider behavior, and desktop resume semantics. Replacing those systems would create a broad regression surface without improving the core editing engine.

### Keep the bespoke loop indefinitely

Rejected because the loop duplicates workflow-runtime concerns and makes future branching, inspection, interruption, and recovery features harder to evolve safely.

### Enable an in-memory or persistent LangGraph checkpointer immediately

Rejected because FramePilot already persists durable runs. A second checkpoint source would create ambiguous recovery and cleanup behavior.

## Verification

Focused migration tests cover:

- unchanged agent event ordering through graph custom streaming;
- original `AbortSignal` forwarding;
- non-agent commands exiting without execution handlers;
- the existing comprehensive Conductor driver suite remaining the behavior contract.

Repository CI and local desktop verification were intentionally not run for this change at the creator's request. The dependency lockfile regeneration and normal install-time verification remain explicit repository follow-ups.
