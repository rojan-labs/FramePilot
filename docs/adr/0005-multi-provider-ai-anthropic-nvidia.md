# ADR 0005: Multi-provider AI (Anthropic, NVIDIA NIM, mock) behind one interface

- **Status:** Accepted
- **Date:** 2026-06-18

## Context

The AI engine ([../architecture/ai-engine.md](../architecture/ai-engine.md)) must call a
large language model to plan and propose edits. Tying the orchestrator to a single vendor
risks lock-in, makes cost/latency trade-offs rigid, and — most importantly — makes the AI
layer **untestable in CI**, because real model calls are non-deterministic and require
network + secrets. We also want freedom to run different models for different modes (a
strong planner vs. a cheap autocomplete).

## Decision

We will define **one provider interface** and ship three implementations behind it,
selected by `FRAMEPILOT_AI_PROVIDER`:

- **`anthropic`** (Claude) — `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL`.
- **`nvidia`** (NVIDIA NIM, OpenAI-compatible endpoint) — `NVIDIA_API_KEY` /
  `NVIDIA_MODEL` / `NVIDIA_BASE_URL`.
- **`mock`** — returns deterministic canned patches; **the default** in `.env.example`,
  used for offline development and tests.

The abstraction lives in `packages/ai-sdk`. The orchestrator depends on the interface,
never on a concrete provider. See [../guides/ai-providers.md](../guides/ai-providers.md).

## Consequences

- **Positive:** the entire AI layer is testable deterministically in CI via the `mock`
  provider — no network, no secrets, no flakiness (PRD §16, §17).
- **Positive:** no vendor lock-in; swap or mix providers per environment or per mode;
  contributors without API keys can still run and test the AI layer end-to-end.
- **Positive:** since every provider must return a **patch** through the tool registry,
  swapping providers never weakens the safety guarantees.
- **Negative:** we maintain N adapters and must normalize their tool-calling/streaming
  differences behind the interface (NVIDIA via the OpenAI-compatible shape, Anthropic via
  its own).
- **Follow-up:** keep the `mock` provider's canned patches representative as new
  operations/tools are added, so tests stay meaningful.

## Alternatives Considered

- **Single provider (Anthropic only)** — simplest, but lock-in and, critically, no
  deterministic CI path.
- **A third-party multi-LLM gateway library** — adds a dependency and an abstraction we
  don't fully control; our needs (three backends + a mock) are small enough to own.
- **No mock; record/replay real responses** — brittle fixtures that rot quickly and still
  require occasional network; a hand-written deterministic mock is more stable.
