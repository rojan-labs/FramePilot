# Phase 5 — Workers and lifecycle: after

## The decision rule, applied

`plan/system-mission/05-WORKERS-AND-LIFECYCLE.md` says a bounded-context specialist is
introduced **only** when the ledger shows, for a real scenario, at least one of: its
context is < 40 % of the main turn's; it can run concurrently with another step; or its
error rate drops with a narrower prompt.

Measured over **585 real requests** from the mission runs (`context_usage` manifests in
`reports/system-mission/runs/after-*.json`, p50):

| section | p50 tokens | share of a request |
| --- | --- | --- |
| **tool definitions** | **15,669** | **69.1 %** |
| additional request content | 3,945 | 17.4 % |
| transcript slice (when present) | 3,088 | 13.6 % |
| skills manifest | 1,649 | 7.3 % |
| session context | 521 | 2.3 % |
| source media | 240 | 1.1 % |
| system contract | 135 | 0.6 % |
| timeline summary | 91 | 0.4 % |
| media bin | 86 | 0.4 % |
| **total per request** | **22,671** | 100 % |

Splitting the tool block (88 tools, `estimateTokens` over the built registry):
**descriptions 8,748 · parameter schemas 7,553.**

## Candidate 1 — planner (plan-only prompt without tool schemas): **PASSES**

A request with the tool block removed is **7,002 tokens — 30.9 % of a main turn**, under
the 40 % threshold. The number is not marginal and it is not a projection: it is the same
manifest the runs actually reported, minus the section a planning step does not use.

The refinement the data suggests: a planner does not need to be told *nothing* about the
tools — it needs to know what each one can do, not how to call it. That is the
**descriptions (8,748) without the parameter schemas (7,553)**, so a planning request
lands near 15.8k rather than 22.7k, and the 7,553 tokens of JSON Schema — a third of every
planning request — buy nothing for a step that emits prose, not tool calls.

**Status: accepted, not yet implemented.** It belongs in `packages/ai-sdk`'s proposer
layer, which was being changed concurrently by other work in this same session; landing two
edits to the orchestrator's prompt assembly at once is how goldens end up regenerated
against a moving target. Carried as the open item on P5.2.

## Candidate 2 — media-analysis summarizer: **REJECTED, with the number that rejected it**

The premise was that turning a raw footage map into structured facts is expensive enough to
deserve its own bounded step. The ledger says it is not: across 585 requests the footage
map does not appear in the ten largest sections at all, and `source media` — the block that
carries the per-asset facts — is **240 tokens, 1.1 % of a request**.

There is nothing to save. A specialist here would add a model call, a contract and a
failure mode in exchange for roughly a fifth of one percent of the context. Rejected.

## Candidate 3 — critic judgment: **already a specialist**

It already runs through `proposerModelEffect` on a small tier with its own prompt
(`CRITIC_JUDGMENT_SYSTEM_PROMPT`, 140 tokens) and its own manifest budget. Nothing to
introduce; it is the shape the other candidates were measured against.

## Lifecycle (P5.3, P5.4, P5.5)

- **Registry** — `electron/process-registry.ts`: every child registered with owner,
  purpose, started-at, optional timeout and a cancel handle, moving through
  `created → ready → running → idle → failed → recovering → terminated`. `will-quit` walks
  it as a backstop, so a child added by later code cannot silently opt out of shutdown.
  10 tests.
- **Crash recovery** — the pidfile is the part nothing else could do: written
  synchronously (the one sync write in `userData`) so it survives a process that died
  without running a single handler, and swept on the next launch. Liveness-checked first,
  because a pid is reused and killing a stranger is the worse failure.
- **Duplicate suppression (P5.4)** — `engine/python/framepilot_engine/singleflight.py`
  coalesces identical in-flight requests on `/asset-media`, `/analyze-silence` and
  `/detect-beats`: six identical concurrent callers produce **one** ffmpeg derivation and
  all six are served. Concurrency caps already existed (asset-media, temporal evidence,
  visual index, one encode); duplicate suppression was the missing half.
- **Recovery (P5.5)** — an engine that dies after becoming ready is restarted, bounded,
  with 1s/2s/4s backoff and the cause in `status.detail`; `stop()` during the backoff
  cancels it and resets the budget; an exit during startup stays a plain start failure.
  6 tests.

## What this phase deliberately did not build

No new model workers, no message bus, no plugin runtime. Two of the three candidates were
rejected by measurement and the third is accepted-but-unlanded; the phase's own rule is
that a worker without a ledger row justifying it does not get built, and honouring that
rule is the result, not a shortfall against it.
