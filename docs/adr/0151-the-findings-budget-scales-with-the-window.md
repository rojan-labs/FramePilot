# ADR 0151 — The findings budget scales with the window, and a run accounts for its context

**Status:** accepted
**Date:** 2026-08-27
**Related:** ADR 0075 (task memory), ADR 0080 (context manifest), ADR 0149 (a run holding
unspent candidates may not fetch more)

## Context

Every context manifest in captured run `e36235cc` looked healthy: 19,051–41,990 estimated
input tokens against a 128,000 window, `compaction.occurred` false on all 105 of them, peak
utilisation 33%. Nothing grew, nothing was trimmed, nothing overflowed.

Added up, the same run made **52 model calls and assembled 1,223,811 tokens**:

| Section               |  Tokens |     Share |
| --------------------- | ------: | --------: |
| `tool_schemas`        | 736,595 | **60.2%** |
| `latest_user_message` | 221,347 |     18.1% |
| `conversation`        | 258,599 |     21.1% |
| `system`              |   7,270 |      0.6% |

The editor's description of the symptom was exact: _"context seems less on the UI but
actually context is increasing at a very high rate."_ Context per call was not increasing.
It was being **rebuilt, in full, fifty-two times**.

## The budget was inverted

One representative call totals 21,942 tokens: `tool_schemas` 16,962 (77.3%), conversation
4,845, system contract 135. Against that, the findings budget —
`AGENT_LOG_CLEAR_THRESHOLD_TOKENS` — was a flat **1,000**. Past roughly two tool calls with
real results, every payload older than `AGENT_LOG_PAYLOAD_FRESH` (2) became
`[old result cleared — call recall_evidence("ev_N")]`.

**The model was handed about seventeen times more context describing tools it could call
than describing what it had already found.**

That ratio is the mechanism behind the run's headline failure, and it makes the recall loop
architectural rather than behavioural:

1. a stock `remoteId` exists only in a search payload;
2. payloads survive two turns;
3. placing a clip requires a `remoteId` the model no longer holds;
4. so it recalls — and the recall re-inflates the log past 1,000 tokens, so it is cleared
   again next turn;
5. → 62 recalls, each one its own model call, each one a full context rebuild.

144 tool calls arrived over **51 turns, a mean of 2.82**, with 32 of 51 turns making one or
two calls.

## Decision

**Derive the findings budget from measured remaining capacity, not from a constant.**

`findingsBudgetTokens(remainingCapacity)` spends a share of what the assembler actually left
free — window − output reservation − headroom − reserved prompt − assembled — bounded below
by the old 1,000 and above by a ceiling. A model with a small window keeps today's behaviour
**by arithmetic** rather than by a special case, and 1,000 remains the honest answer for a
caller that can measure nothing (the repair pass, the legacy loop).

The ceiling exists because more is not indefinitely better: past a point, extra candidates
stop informing the edit and start burying the request.

**And account for the run, not only the request.** `summarizeRunContext` aggregates the
manifests a run already emits into one ledger — model calls, assembled tokens, tool-schema
share, tool-set churn, cached share, peak window use — and `describeRunContext` renders it
as a sentence. Nothing new is measured. `toolSchemaTokensRebilled` had already recorded
**115,967 tokens re-billed at full price across nine mid-run tool-set changes**, correctly,
on every call. No reader ever added them up.

The ledger carries `run-metrics.ts`'s honest-degradation rule: a request whose provider
reported no cache counts is **excluded** from the cached share rather than scored as a miss.
The captured run's provider reported none, and a provider path that silently ignores the
cache breakpoint looks identical to a cold cache until someone asks the question.

## Consequences

**Good.** A run holding sixty search results can keep them in front of the model instead of
re-fetching them one at a time. The cost of a run is one readable line instead of 105
manifests. Tool-set churn has a price attached to it.

**Costs.** A larger log raises per-call input, and the change is only a win if it removes
more round trips than it adds tokens. The run's own arithmetic says it does — 62 recalls at
~4,670 tokens each is ~289,000 spent re-fetching what a 16,000-token budget would have held
— but that is a projection from one captured run, not a measurement of the fix.

**Deliberately not done.** No compaction or summarisation subsystem. Compaction never fired
in this run, the window was 67% empty, and building generalised machinery for a problem the
current requirements do not show is exactly what `CLAUDE.md` forbids. The fix is to spend
the window that already exists.

**Open, and it outranks the rest.** `splitAnthropicMessages` — which places the cache
breakpoint — is Anthropic-specific, and this run went through `openrouter/auto-beta`.
`cacheBoundary` appears nowhere in the OpenAI-compatible path. Whether OpenRouter honours a
breakpoint, or does automatic prefix caching, or neither, is unanswerable from the code and
needs a live request. If it does neither, those 736,595 tokens were billed at full price and
that is the largest single cost item in the product. The ledger now reports it either way.
