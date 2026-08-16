# ADR 0100: No LangChain in the Python engine

Status: **Accepted** · Date: 2026-08-06 · Relates to
[`plan/LANGCHAIN-MIGRATION.md`](../../plan/LANGCHAIN-MIGRATION.md) §8 and M13 ·
Complements [ADR 0098](./0098-langchain-adapter-at-the-provider-seam.md) and
[ADR 0099](./0099-langgraph-conductor-runtime.md)

## Context

The LangChain/LangGraph migration is scoped as a **complete end-to-end migration of the AI
layer**. "End to end" invites an obvious question — what happens to `engine/python`? — and
answering it by silence would leave a permanent open item that every future reader has to
re-investigate. This ADR records the answer and the evidence for it.

The assumption worth killing first is that Python has an orchestrator. It does not. Read from
source rather than inferred:

- `framepilot_engine/ai_tools/` is a **tool registry, a dispatcher and handlers**:
  `registry.py` mirrors the canonical TypeScript registry, and `dispatch.py` enforces
  registered → available → schema-validated → handler.
- `framepilot_engine/brain/` holds memory, embeddings, the TwelveLabs backend and the
  captioner.
- The only model calls in Python are `brain/captioner.py` (VLM captions) and
  `brain/visual_embed.py` (NVIDIA embeddings). Both are single-shot calls, not agent loops.
- **There is no agent loop, no turn state machine and no chat-model orchestration in Python.**
  The agent loop is TypeScript on every surface — desktop, browser and MCP alike.

So there is no Python orchestrator to migrate onto LangGraph. There is only the option of
_building_ one.

## Decision

**No `langchain` or `langgraph` dependency in `engine/python`.**

The Python side keeps its current shape: a typed tool surface behind the sidecar, called by the
TypeScript orchestration layer.

## Consequences

### Why this is the right answer rather than an omission

1. **It would be net-new work with no consumer.** Adopting `langchain` in Python means wrapping
   `ai_tools/registry.py` as `langchain_core` tools and standing up a graph that nothing calls.
   Every existing caller reaches these tools through the sidecar's HTTP surface.
2. **It would create a second place run state lives.** The migration's §5.4 is explicit that the
   durable `RunRecord` WAL stays the single execution authority, and that even LangGraph's own
   checkpointer must be implemented over it rather than beside it. A Python-side graph would be a
   third authority, in direct conflict with the decision that makes the rest of the migration
   safe.
3. **It would widen the security boundary for nothing.** `extra="forbid"` on the Pydantic models
   is what makes the sidecar reject arguments the TypeScript registry would reject. Routing tool
   invocation through another framework's argument handling adds a layer between the model and
   that boundary, and the parity fixture that guards it
   (`test_tool_registry_schema_parity.py`) compares _our_ schemas, not a wrapper's.
4. **The dependency cost is real.** The TypeScript side measured ~52.6 MB installed for the
   provider adapter alone, shipped unbundled in the desktop main process. The Python sidecar is
   packaged with the desktop app and would pay a comparable, equally unrecovered cost.

### What we give up

Nothing that is currently used. If FramePilot later wants Python-side agents — a long-running
analysis agent inside the sidecar, say, rather than a tool the TypeScript agent calls — this
decision is revisited on its own merits, not as a consequence of the TypeScript migration.

### If the maintainer chooses otherwise

The scope would be, in order: wrap `ai_tools/registry.py` as `langchain_core` tools with the
JSON Schema still derived from Pydantic; keep `dispatch.py` as the enforcement point so the
wrapper cannot bypass it; extend the parity fixture to assert the wrapped surface matches the
canonical registry; and — the part that must be answered first — **name what consumes it**. A
tool surface with no caller is the failure mode this ADR exists to prevent.

### What is genuinely worth doing on the Python side

Unrelated to LangChain, and already filed in the migration plan's §13: the TypeScript↔Python
registry parity is maintained **by hand**, while skills parity is generator-enforced. The parity
fixture added in M0 now blocks new drift and recorded 16 already-drifting tools as a strict-xfail
baseline. Fixing those — starting with the class where `extra="forbid"` is not inherited by
nested Pydantic models, which genuinely widens the security boundary (PRD §18.2) — is the real
Python work this migration surfaced.
