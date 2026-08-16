# ADR 0012: AI layer — tool-call boundary, fetch-based providers, memory on `aiMemory`

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Phase 4 ai-tooling-engineer
- **Builds on:** [ADR 0004](0004-timeline-patch-engine-before-ai.md) (engine before
  AI), [ADR 0005](0005-multi-provider-ai-anthropic-nvidia.md) (multi-provider),
  [ADR 0006](0006-reversible-operations-via-restore-clips.md) (reversible ops).

## Context

Phase 4 puts the AI layer on top of the finished timeline/patch engine and
deterministic render. AGENTS.md invariant 5 is the hard constraint: **the AI edits
ONLY through registered, schema-validated tools and returns reviewable, reversible
patches — never a raw mutation of `project.fp.json`.** The scaffolding from earlier
phases left stubs (`packages/ai-sdk`: providers, tool registry, context builder,
orchestrator; `engine/python/.../ai_tools`: a placeholder registry). Several
design questions had to be settled to wire it together correctly and safely.

## Decision

### 1. The orchestrator is the only place tool calls become a patch

A provider returns **tool calls** (`{ name, arguments }`), never a `Patch`. The
`Orchestrator` is the sole component that turns a tool call into operations:

1. `buildContext` assembles `[system, context]` messages (timeline summary,
   transcript, selection, platform, learned memory).
2. The provider is asked to complete with a **filtered** tool list (mutating tools
   for `edit`/`autocomplete`; read-only tools for `plan`; none for `chat`).
3. For each returned tool call the orchestrator looks the tool up, **rejects
   unknown or unavailable tools**, validates `arguments` against the tool's schema,
   and runs the tool handler to get typed `Operation[]`.
4. It assembles a `Patch`, runs `validatePatch` (PRD §8.5), and computes a
   before/after `diffTimeline` for the review UI.

Because a provider can never hand back a ready-made patch, a misbehaving or
prompt-injected model cannot bypass the tool boundary — the gate is structural,
not advisory.

### 2. Tools carry a Zod schema as the single source of truth

Each tool's input schema is a Zod schema. The JSON Schema advertised to the model
is **derived** from it via `z.toJSONSchema` (the same technique the timeline schema
uses), and the same Zod schema validates untrusted `arguments`. Validation and the
advertised contract therefore cannot drift. Schemas are `.strict()` so unknown
arguments are rejected (defense against argument smuggling). The Python mirror uses
Pydantic models with `extra="forbid"` and `model_json_schema()` for the identical
property.

### 3. Unavailable tools are registered but not faked (build order)

`analyze_silence`, `detect_scenes`, `detect_faces`, and `generate_mask` depend on
engine capabilities that do not exist yet (Phase 5+). They are registered for
discoverability but marked `available: false`; the orchestrator **refuses to invoke
them** rather than fabricate a result. This keeps the build-order invariant
(ADR 0004): no AI feature pretends to use an engine that isn't built.

### 4. Providers call the HTTP APIs directly via injected `fetch`

The Anthropic (Messages API) and NVIDIA NIM (OpenAI-compatible) providers are
implemented with the global `fetch`, not vendor SDKs. The wire format is a single
JSON POST, so this **adds no runtime dependency** (and no license-review burden)
while keeping the provider abstraction from ADR 0005. `fetch` is injected through
the constructor, so request-building and response-parsing are unit-tested fully
offline. The deterministic `mock` provider remains the default.

### 5. Memory store rides the existing `aiMemory` field — no migration

Project memory (PRD §8.7: brand/caption style, pacing, audience, export platforms,
accepted/rejected edits) is stored in the **existing** `Project.aiMemory` record.
No schema field is added, so **no migration is required**. The store parses
`aiMemory` defensively (garbage falls back to safe defaults, since the file is
user-editable) and exposes pure read/write helpers; the orchestrator injects a
memory summary into context so the model honors learned preferences.

### 6. Modes implemented now; agent/critic deferred to Phase 7

`chat`, `plan`, `edit`, and `autocomplete` are implemented (PLAN §4.2). `agent`
(multi-step loop) and `review` (critic) belong to Phase 7 and remain explicit
stubs, respecting the staged plan. The web Review UX (PLAN §4.3) surfaces a
proposal as **what / why / before-after** with Apply / Reject, routing Apply
through the same `validate → apply → record` store path as a manual edit (so Undo
works) and recording the decision to memory.

## Consequences

**Positive**

- The tool boundary is enforced by construction; schema validation is the single
  gate on every AI edit, in both TS and Python, at 100% coverage.
- No new dependencies and no schema migration — Phase 4 lands within the safety
  rules (AGENTS.md §6/§8).
- Providers are fully testable offline; the editor works with zero configuration
  (mock default) and upgrades to Anthropic/NVIDIA via env vars.
- Memory makes the agent's edits improve with use without touching the schema.

**Negative / accepted costs**

- Single-shot tool use: the orchestrator does not yet run a tool-result feedback
  loop (a model that calls a read tool mid-`edit` has that call ignored). The
  multi-step loop is Phase 7's job.
- The web Review UX previews edits as a **timeline diff**, not a rendered video —
  a real preview render needs the renderer→engine export IPC channel, which is a
  deferred Phase 8 surface (broadening IPC is an "ask first" change).
- The HTTP providers are not yet exercised against the live APIs in CI (no network
  in CI); they are covered structurally with an injected `fetch`.

## Alternatives Considered

- **Let providers return a `Patch` directly.** Rejected: it would let the model
  (or a compromised provider) emit arbitrary mutations, defeating invariant 5. The
  orchestrator-assembles-the-patch design makes the boundary structural.
- **Vendor SDKs (`@anthropic-ai/sdk`, `openai`).** Rejected for now: they add
  runtime dependencies and a license-review step for a single JSON POST. `fetch`
  keeps the surface minimal; an SDK can be adopted later behind the same interface.
- **A new `memory` schema field.** Rejected: it requires a migration for no benefit
  over the existing free-form `aiMemory` record. Deferred unless a typed,
  cross-language memory contract is needed.
- **Hand-written JSON Schemas per tool.** Rejected: they drift from the validator.
  Deriving JSON Schema from the Zod/Pydantic model keeps one source of truth.
