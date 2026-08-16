# 0078. Context visibility and single-provider orchestration continuity

- Status: Accepted; supersedes the routing portion of ADR 0043
- Date: 2026-07-27

## Context

FramePilot needs to expose context pressure without confusing it with cumulative token
spend. It also needs predictable orchestration across classification, planning, editing,
repair, retries, and cancellation. Per-tier provider dispatch allowed a request to cross
provider/model capability boundaries mid-run, duplicated credential construction in the
browser and desktop hosts, and made planner failures harder to recover consistently.

Two concrete failures exposed the larger problem: an Ollama-compatible model rejected the
`temperature` field, and an unsupported bounded plan ended the request with a dead-end
"general planner path" message instead of continuing through the capable agent path.
Large projects could additionally serialize an unbounded semantic index into the planner
prompt.

## Decision

One host-selected provider and model own every model call in a user request. The effect
runtime may retain `small`/`mid`/`large` as cost and telemetry classes, but those labels do
not select providers, models, credentials, or base URLs. Remove model-tier controls from
Settings, configuration storage, IPC, environment configuration, and provider factories.

Add a typed `context_usage` stream event, separate from cumulative `usage`. Each streamed
call emits an estimate based on the complete request payload, including tool schemas, and
replaces it with provider-reported input usage when available. The composer renders the
latest call as an accessible ring immediately left of Send/Stop.

The bounded planner receives an explicit catalog of executable effect kind/name pairs.
Whole-project semantic context is deterministically sampled across the beginning, middle,
and end of every large category. If intent or plan output is unparseable, uncompilable, or
unsupported, auto mode continues the same request through the general agent with the same
controls, cancellation signal, context, and accumulated usage. A cancellation observed at
either planning call stops before fallback.

Ollama retries exactly once without `temperature` only after an explicit 400 response says
that parameter is deprecated or unsupported. The provider remembers the capability for
the rest of that fixed-model instance; unrelated 400 responses are never retried broadly.

## Consequences

- A request cannot silently switch credentials, model behavior, or tool-call capability
  midway through orchestration.
- Unsupported planner shapes degrade to the general agent instead of ending inert.
- Long timelines keep representative temporal coverage without an unbounded planner prompt.
- Cancellation and cumulative usage survive the planner-to-agent boundary.
- Context occupancy stays distinct from total run cost and remains honestly estimated when
  a provider reports no input-token usage.
- Existing persisted tier-routing fields become ignored legacy data and disappear on the
  next config write; no project/timeline schema migration is required.
