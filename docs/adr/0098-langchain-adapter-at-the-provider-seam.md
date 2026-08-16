# ADR 0098 — LangChain adapter at the provider seam

- **Status:** Accepted (2026-08-06)
- **Phase:** M1 of [`plan/LANGCHAIN-MIGRATION.md`](../../plan/LANGCHAIN-MIGRATION.md)
- **Supersedes:** the raw-`fetch` rationale recorded in `packages/ai-sdk/src/providers/anthropic.ts`

## Context

`providers/anthropic.ts` carries an explicit standing decision:

> _WHY raw `fetch` instead of `@anthropic-ai/sdk`: the Messages API is a single JSON POST, so
> calling it directly keeps the dependency surface (and license review burden) minimal._

That reasoning was sound and remains true on its own terms. The AI SDK's runtime dependency set
was three workspace packages and `zod` — no vendor SDK, no HTTP client, across 34k LOC and nine
providers.

The maintainer has decided on a complete end-to-end migration of the AI layer to
LangChain/LangGraph. M1 is its first step: adopt LangChain at the **provider seam only**, behind a
flag, so the riskiest unknown is resolved before anything larger is built on it.

## Decision

Add `packages/ai-sdk/src/providers/langchain.ts`, an `AiProvider` implemented over
`ChatAnthropic`, selected by `FRAMEPILOT_AI_PROVIDER_IMPL=langchain` and **defaulting to
`native`**. Both adapters coexist; the native one remains the default and is not deprecated by
this ADR.

This reverses the quoted decision. It should be recorded plainly that the reversal is **more
direct than "adopt an abstraction"**: `@langchain/anthropic` depends on `@anthropic-ai/sdk`, so
M1 vendors the exact SDK that decision declined, and adds a LangChain layer above it.

### What the adapter deliberately does not own

- **Retry, backoff and timeouts.** `resilient-provider.ts` stays the single retry authority;
  `maxRetries: 0` is set explicitly. Two retry layers would mean duplicate tool invocations
  (migration-plan risk 4), which for mutating tools means duplicate edits.
- **Extended thinking.** Not requested, matching the native adapter, which parses `thinking_delta`
  defensively but never asks for it. Requesting it would add a body field the native path lacks,
  breaking parity and changing cost.
- **Cache-breakpoint placement.** Imported from the native adapter
  (`splitAnthropicMessages`, `resolveMaxTokens`, `ANTHROPIC_CACHE_CONTROL`) rather than
  re-derived — see below.

## The unknown this phase existed to resolve

§12 of the migration plan named it: _"Whether `@langchain/anthropic` can express the dual
prompt-cache breakpoint. The highest single unknown; determinable only by writing M1.2. If it
cannot, cost per turn regresses."_

**It can.** `langchain-parity.test.ts` drives both adapters through a capturing `fetch` and
compares the real outgoing bodies. Both place breakpoints on exactly the same two blocks — the
system/tools prefix and the `cacheBoundary` message — and the system block, message list, tool
array (with byte-identical schemas), model and clamped `max_tokens` are equal.

Two body differences remain, both semantically inert and asserted explicitly so a third would fail
the test rather than hide:

1. JSON **key order** differs between the serializers.
2. LangChain writes `stream: false` where the native adapter omits the key.

Neither affects Anthropic's cache key, which is computed over the canonical tools → system →
messages content, not over our JSON encoding.

## Three defects this phase surfaced

Recorded because each was invisible before something compared the two paths:

1. **Prompt-cache hit rate was unmeasurable.** `buildBody` SET two `cache_control` breakpoints but
   nothing ever READ `cache_read_input_tokens` back. The acceptance metric for the plan's
   highest-impact risk could not be produced at all. `Usage` now carries optional
   `cacheReadInputTokens` / `cacheCreationInputTokens`.
2. **LangChain and Anthropic disagree on what `input_tokens` means.** LangChain reports
   `input_tokens + cache_creation + cache_read` as a total; Anthropic's own `input_tokens` is the
   non-cached portion, which is what `cost-meter.ts` and the durable WAL already record. The
   adapter subtracts the cache components back out, so the same turn reports the same numbers on
   either path. Without it, an identical run would show a different token count and a different
   cache-hit rate depending only on which adapter served it — quietly invalidating the M0.1 budget
   comparison that gates every later phase.
3. **Streamed usage arrives in two parts.** Anthropic reports the input side once (carrying the
   cache counts) and the output side cumulatively; LangChain surfaces these as separate
   `usage_metadata` payloads, the last with `input_tokens: 0` and no cache detail. The obvious
   "last one wins" implementation silently discards prompt-cache counts on every streamed turn —
   i.e. on every turn of a real agent run. `mergeUsage` folds them instead.

A fourth, found in FramePilot's own new code: `run-metrics.ts` divided cached tokens by
`inputTokens` alone. Since `inputTokens` excludes cached tokens, that reports a hit rate above
100% on exactly the runs caching hardest. The denominator is now `inputTokens + cacheRead`.

## Consequences

**Cost.** ~52.6 MB of installed dependencies (`js-tiktoken` 21.5 MB, `@langchain/core` 12.9 MB,
`@anthropic-ai/sdk` 10.1 MB, `langsmith` 5.0 MB, remainder ~3 MB). The desktop main process is
compiled with plain `tsc` and **not bundled**, so electron-builder ships this as-is — there is no
tree-shaking to reduce it. Licenses: 26 MIT, 1 Unlicense (`fast-sha256`, transitively via
`langsmith`), 0 unknown.

**Telemetry, earlier than planned.** `langsmith` is a **hard dependency of `@langchain/core`**, so
it installs now — eight phases before M11, where §11.2 schedules the privacy decision. It is inert
without `LANGCHAIN_TRACING_V2` / `LANGSMITH_TRACING`, but those are **ambient** environment
variables: a machine with them exported for an unrelated project would ship FramePilot users'
footage-derived content (transcripts, `get_frame` images, file paths, memory entries) to a third
party without anyone touching a FramePilot flag. `langchain-telemetry.test.ts` pins that the SDK
enables nothing itself and records that a FramePilot-owned flag is **necessary but not
sufficient** — §11.2 must neutralize the ambient variables, not merely default its own flag off.

**Zod.** `@langchain/core` declares `^3.25.76 || ^4`. The workspace floor was `^3.23.0`, which
allowed versions below LangChain's minimum; it is now `^3.25.76` in `ai-sdk`, `mcp-server` and
`timeline-schema` — all three already require the `zod/v4` subpath, which only exists from 3.25.
Resolution was verified to key on 3.25.76.

**Exit.** M1 reverts by deleting one file, one flag branch and two dependencies. The native
adapter is untouched and remains the default.

## Alternatives considered

- **Keep raw `fetch` and adopt LangChain only at the graph layer (M6+).** Rejected: the maintainer
  chose the end-to-end migration, and deferring the provider seam would leave the dual-breakpoint
  question — the plan's highest single unknown — unresolved until far more had been built on the
  assumption it worked.
- **Reimplement breakpoint placement inside the adapter.** Rejected: two implementations that
  merely look alike is exactly how a cache breakpoint drifts, and the failure is silent. The
  adapters share one implementation instead.
- **Use `ChatPromptTemplate` for the agent contract.** Rejected per §7.3 — interpolation syntax is
  a new way to perturb a cached prefix for no gain.
