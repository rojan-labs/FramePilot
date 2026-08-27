# 05 — Context economics: 52 rebuilds, 60% spent on tool definitions

**Status:** `[x]` done — 2026-08-27, commit `fc58de5`; **ADR 0151**

**What shipped.** `findingsBudgetTokens` derives the budget from measured remaining
capacity, floored at the old 1,000 and capped so a huge window cannot bury the request; a
small-window model degrades by arithmetic rather than by a special case.
`summarizeRunContext`/`describeRunContext` aggregate the manifests a run already emits into
one ledger — model calls, assembled tokens, tool-schema share, churn, cached share, peak
window use — carried on `AgentRunQualityMetrics.context`. It reproduces the captured run
exactly: _52 model calls · 1,223,811 tokens assembled · tool definitions 60% of it ·
115,967 re-billed across 9 tool-set change(s) · cache not reported by this provider · peak
window use 33%_.

**Change 2 step 1, closed by acting rather than measuring** (`85a2441`). `cacheBoundary`
appeared nowhere in the OpenAI-compatible adapter, so the marker the agent loop carefully
places was dropped on the path the captured run actually used. It is now carried there too:
a gateway that understands it uses it (OpenRouter passes `cache_control` through to
Anthropic models), one that does not ignores an unknown key on a content part, and
providers doing automatic prefix caching are unaffected because their caching keys on the
byte prefix, which this does not move. Sending it costs nothing when it is not understood
and saves the largest line item in the product when it is.

**And the reason nobody could have measured it before.** `withProviderUsage` read
`cachedInputTokens`; every caller passes a provider `Usage`, which spells it
`cacheReadInputTokens`. Nothing produced the name being read, so the field was `undefined`
on **every manifest ever built** — the captured run's "cache not reported by this provider"
says nothing about what the provider did. Both spellings are accepted now.

**Change 4, shipped** (`819d461`): sections carry `cacheSide`, the tool block is marked
`cached_prefix` whenever a breakpoint exists, and the ledger aggregates
`cacheablePrefixTokens` alongside `cachedInputShare` — a wide gap between the two is the
signature of a breakpoint placed and not honoured. An assembled tier account claims no
side rather than guessing at one.

**Change 3, shipped** (`819d461`): the contract asks for independent calls in one turn.
Measured cost of that paragraph plus the two descriptor edits: **+183 tokens per request**
(21,285 → 21,468), recorded in the re-frozen goldens.

**Deferred, and it should stay deferred.** Change 2 steps 2–3 — narrowing the per-stage set
further and shortening tool descriptions. Both trade capability or clarity for tokens, and
neither is worth doing until a live run says what the cached share actually is now.
**Depends on:** nothing measurable-blocking, but lands best with 02 (fewer round trips is
the same lever as fewer gathering turns).
**Blast radius:** `packages/ai-sdk/src/orchestrator.ts` (agent log constants, message
assembly), `packages/ai-sdk/src/tool-scope.ts` / `autonomous-tool-contract.ts` (advertised
surface), `packages/ai-sdk/src/context-builder.ts` (manifest reporting).

---

## The finding

Every one of the 105 context manifests in `run.md` was parsed. Deduplicated by `requestId`:

**52 model calls · 1,223,811 estimated input tokens.**

| Section                                     |   Calls |      Tokens |     Share |
| ------------------------------------------- | ------: | ----------: | --------: |
| `tool_schemas` — tool definitions           |      51 | **736,595** | **60.2%** |
| `latest_user_message` — request + run state |      52 |     221,347 |     18.1% |
| `conversation` — user turn 1 (the brief)    |      32 |     133,312 |     10.9% |
| `conversation` — user turn 2                |      32 |      50,432 |      4.1% |
| `conversation` — user turns 9/10            |      38 |      69,889 |      5.7% |
| `system` — system contract                  |      52 |       7,270 |      0.6% |
| all assistant turns                         | 19 each |       4,901 |      0.4% |

**Context per call never grows and never compacts.** It oscillates 19,051 → 41,990 across
the whole run; `compaction.occurred` is `false` in all 105 manifests. The window is 128,000
and peak utilisation was 33%.

**This is the answer to "the UI says the context is small but it's growing fast."** It is
not growing. It is being **rebuilt from scratch 52 times**, and 60% of each rebuild is a
catalogue of tools the model has not called.

---

## The budget is inverted

One representative call (`361a4c23…:seg-1`, 21,942 tokens total):

```
tool_schemas      16,962   77.3%   ← what the model COULD do
conversation       4,845   22.1%
system contract      135    0.6%
```

Against that, the findings budget is `AGENT_LOG_CLEAR_THRESHOLD_TOKENS = 1000`
(`orchestrator.ts:500`). Once the agent log passes **1,000 tokens** — which is roughly two
tool calls with real results — every payload older than the freshest
`AGENT_LOG_PAYLOAD_FRESH = 2` (`orchestrator.ts:504`) is replaced with
`[old result cleared — recall ev_N]`.

> **The model is given ~17× more context describing tools it could call than describing
> what it has already found.**

That ratio is the mechanism behind every symptom in `00-DIAGNOSIS.md`:

1. A `remoteId` exists **only** in a search payload. Payloads survive two turns.
2. To place a clip, the model needs a `remoteId` it no longer holds → it must
   `recall_evidence`.
3. The recall re-inflates the log past 1,000 tokens → it is cleared again next turn.
4. → **62 recalls.** The recall loop is _architecturally mandated_, not a model failure.
5. Each recall is a fresh model call → **52 round trips** → 1.22M tokens of assembly.
6. The model never holds enough candidates at once to place 50 clips → **cheap output.**

Round 3 correctly stopped the harness from _killing_ runs that recall. It did not change the
reason they must.

## Round trips are the multiplier

144 tool calls over **51 tool-bearing turns — mean 2.82 per turn**:

```
 1 call  × 17 turns      6 calls × 2 turns
 2 calls × 15 turns      7 calls × 1 turn
 3 calls ×  6 turns      8 calls × 1 turn
 4 calls ×  3 turns     10 calls × 2 turns
 5 calls ×  4 turns
```

**32 of 51 turns (63%) made one or two tool calls**, each paying a full ~23,500-token
context rebuild plus a model inference. The batching machinery exists
(`concurrency.ts`, pool 4) and `search_stock` uses it — but 03 shows `add_stock` cannot,
and a recall-driven loop is one-call-per-turn by nature.

---

## Change 1 — rebalance the findings budget against the schema budget

`AGENT_LOG_CLEAR_THRESHOLD_TOKENS = 1000` was set in isolation. It is indefensible next to
16,962 tokens of schemas in the same message, with 97,866 tokens of window unused.

**Fix:** derive the findings budget from **measured remaining capacity**, not a constant.
`usage.estimatedRemainingCapacity` is already computed per call
(96,772–97,866 in every manifest). Spend a defined share of it on the agent log before
clearing anything.

A first target: allow the findings budget up to the size of the schema budget. On this run
that is ~16,000 tokens instead of 1,000 — roughly 60–80 stock candidates held live, which is
enough to place 50 clips without a single recall.

**Edge cases:** the budget must shrink when the window genuinely fills (a 60-minute project
with a large timeline tier); it must never push total context past
`modelContextLimit - reservedOutputTokens`; a model with a smaller window (some OpenRouter
routes) must degrade to today's behaviour rather than overflow; and clearing must remain
deterministic so the cache prefix is stable.

**Do not simply raise the constant.** A fixed 16,000 would overflow a small-window model.
The capacity figure is already there — use it.

## Change 2 — stop paying for 100 tool definitions on every call

~100 tools are registered across `domain-tools/`. Stage scoping already varies the schema
block (**12,263 / 13,663 / 16,962 tokens** observed across the run) so the mechanism works —
but the _smallest_ set still costs 12,263 tokens, and that is 51 calls' worth.

Three reductions, cheapest first:

1. **Verify the schema block sits above the cache boundary and stays byte-identical within a
   stage.** `orchestrator.ts:3040` places the boundary after `stableHead`. Confirm the tool
   block is inside the cached prefix for the **OpenRouter** path, not only Anthropic:
   `splitAnthropicMessages` (`providers/langchain.ts:105`) is Anthropic-specific, and this run
   ran `openrouter/auto-beta`. If OpenRouter does not honour a breakpoint, 736,595 tokens
   were billed at full price and this is the single largest cost item in the product.
   **Measure before optimising anything else here.**
2. **Narrow the advertised set further per stage.** A run in `apply` holding a beat grid and
   12 assets does not need `track_subject_automatically`, `detect_subjects`, mask tools, or
   the professional-color surface. Extend the existing `stageAllowsRole` filter rather than
   adding a layer.
3. **Shorten descriptions, not the set.** ~170 tokens per tool is high. This is
   `lead-prompt-engineer` work and it shifts the token goldens — the diff **is** the measured
   delta.

Ordering matters: (1) may make (2) and (3) unnecessary. Do not reorder.

## Change 3 — cut round trips at the source

Two levers, both already half-built:

- **03 removes the biggest one.** 18 serial `add_stock` calls become one batched turn.
- **Change 1 removes the second.** Recalls collapse when findings survive.

What remains: **encourage multi-call turns explicitly.** 63% of turns made one or two calls.
The system contract and the stage guidance should state that independent reads and downloads
belong in one turn. This is prompt work — but unlike the four advisory fixes already tried,
it is here supported by a structural change that makes the batch _possible_ (03) and
_useful_ (Change 1).

## Change 4 — make the cost visible

The manifest reports `latest_user_message` as **one section** whose size grows 197 → 22,450
tokens across the run. It does not report:

- the **stable/volatile split** the agent loop actually sends (`context-builder.ts:556`),
- which side of the **cache boundary** each section lands on,
- **cached vs uncached** input as reported by the provider,
- the **findings-vs-schemas ratio**.

This is exactly why the problem was invisible: per-call numbers looked healthy, and nothing
aggregated them. **Report the split, the boundary, and the cumulative per-run totals.** A
run summary should end with total input tokens, cached share, and the schema share — the four
numbers at the top of this document should be readable without parsing a transcript.

---

## Verification

**Unit** — `context-budget.test.ts`, `orchestrator.test.ts`:

1. The findings budget scales with `estimatedRemainingCapacity`; a small-window model
   degrades to today's clearing behaviour rather than overflowing.
2. Total assembled context never exceeds `modelContextLimit - reservedOutputTokens`.
3. Clearing stays deterministic — the same state produces a byte-identical prefix twice
   (the cache-stability guard).
4. A stage's advertised tool set is a strict subset of the previous stage's where intended,
   and is stable within a stage (a set that churns per turn breaks the cache).

**Cache correctness** — the highest-cost thing to get wrong
(`providers/langchain.ts:97`, "a mis-placed breakpoint multiplies cost per turn with no
functional symptom"):

5. For **each provider path** — Anthropic and OpenRouter — assert the tool block and the
   stable head fall inside the cached prefix, and the turn message falls outside.
6. An applied patch invalidates **only** the volatile tail.

**Measured, on a replayed run** (fixtures cannot support this claim — `CLAUDE.md` §3):

7. Re-run the captured brief and publish: model calls, total input tokens, cached share,
   schema share, findings share, `recall_evidence` count, mean tool calls per turn.
   **Targets:** model calls **52 → <25**; total input **1.22M → <400k**; `recall_evidence`
   **62 → <20**; mean tool calls per turn **2.82 → >5**.
8. Confirm cached share is non-zero on the OpenRouter path. If it is zero, that finding
   outranks every other item in this document.

**Commands:** `pnpm --filter @framepilot/ai-sdk test`, `pnpm typecheck`, `pnpm lint`.
Token goldens require the three separate regen commands; the diff is the measured delta.

---

## Risks

- **Raising the findings budget raises per-call cost.** It is only a win if it removes more
  round trips than it adds tokens. The run's own arithmetic says it does — 62 recalls at
  ~4,670 tokens each is ~289k spent re-fetching what a 16k budget would have held — but
  step 7 must confirm it rather than assume it.
- **A bigger log could bury the request.** Keep the request and the run-state briefing
  ordered above the log, as they are today (`orchestrator.ts:3022`).
- **Churning the tool set across turns destroys the cache.** `tool-set-churn.test.ts`
  already exists; extend it rather than risking silent regression.
- **Do not add a compaction/summarisation subsystem.** Nothing here needs one: compaction has
  never fired in this run, the window is 67% empty, and `CLAUDE.md` forbids building
  generalised infrastructure for a problem the current requirements do not show. The fix is
  to spend the window that already exists.

## Definition of done

- [ ] Findings budget derives from measured remaining capacity; small windows degrade safely.
- [ ] Cache-prefix membership asserted per provider path, OpenRouter included.
- [ ] Cached share on the OpenRouter path measured and published.
- [ ] Stage tool sets narrowed and proven stable within a stage.
- [ ] Manifest reports stable/volatile, cache side, cached-vs-uncached, and per-run totals.
- [ ] Step 7 targets met, or the shortfall published with its reason.
- [ ] `pnpm verify` green; ADR for the context budget model; `CHANGELOG.md` updated.
