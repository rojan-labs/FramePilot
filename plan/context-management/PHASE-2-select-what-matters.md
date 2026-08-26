# Phase 2 — The model sees what matters, and knows what it is not seeing — `[ ]`

> **Ships:** on footage too long to fit, the part of it in the prompt is the part the
> request is about — and every omission carries a handle that gets it back in one call.
> **Does not ship:** frame accuracy, new checks, memory. Nothing here changes what an
> operation does.
> **Depends on:** Phase 1. Ranking needs a budget to rank against.
> **Schema/deps:** none.

Phase 1 buys coverage with room. On a 10-minute recording that is the whole answer — it
all fits. On a 60-minute interview or a 4-hour event it is not, and no budget will make it
so. There, the question stops being _how much_ and becomes _which part_ — and today
FramePilot answers it with `.slice(0, 12)`.

A ranked selector for exactly this was built, tested and exported under plan K3. It has
never had a caller.

---

## P2.1 — Wire the retrieval that already exists — `[ ]`

**Closes:** F9. **Touches:** `context-builder.ts` (timeline + transcript tiers).
**Reuses unchanged:** `packages/ai-sdk/src/kernel/semantic-index/semantic-index-slice.ts`.

`getSlice(index, query, limits)` filters the Semantic Timeline Index by time range, track
and category across dialogue, shots, silences, beats, layers, captions and music, with
explicit limits. It is exported from `kernel/index.ts`. It has **zero production
consumers**: the only runtime value imported from the semantic index anywhere is
`beatGridFor` (`orchestrator.ts:106`).

Do:

- Build the index for the project snapshot (it is already `WeakMap`-keyed on snapshot
  identity, so an untouched project reuses it by reference) and call `getSlice` for the
  timeline and transcript tiers.
- Pass Phase 1's per-tier allocation through as `SemanticSliceLimits`, so ranking and
  budgeting are one decision rather than two that disagree.
- **Keep head-of-list as the fallback.** Where the index carries nothing ranked for a
  category, behaviour is exactly Phase 1's. The ranker may only ever reorder within the
  room; it may not reduce coverage.

The module's own docstring records what it will and will not narrow — `transitions` and
`effects` carry only a `clipId` and cannot be honestly filtered by time. Respect that;
do not add a join it does not have.

**Evidence.** Benchmark section B on the 60-min and 4-h rows, with a new column: of the
clips shown, how many overlap the request's target region. Ranked selection should raise
that sharply at unchanged token cost — the point is _better tokens_, not more.

---

## P2.2 — The request decides what gets retrieved — `[ ]`

**Closes:** F10. **Touches:** `context-builder.ts`; reuses
`kernel/command-classifier.ts` (which already imports `TimeRange` from the index) and
`editor-context/interaction-context.ts`.

Retrieval today has exactly one query — "near the playhead" — and it always **narrows**:

| Scale  | Clips shown, no selection → 30s selection | Words shown  |
| ------ | ----------------------------------------- | ------------ |
| 10 min | 24 → **11**                               | 600 → **96** |
| 60 min | 24 → **11**                               | 600 → **97** |

Correct for _"tighten this"_. Wrong for _"find the strongest hook in this recording"_,
where a selection actively hurts, and there is no path by which a request widens the view.

Do: derive the slice query from the turn, in a small deterministic function with a
declared precedence, not a heuristic pile.

1. **Pinned entities** (`ContextInput.pinned`) — the user said these explicitly. Always
   included in full, never ranked away.
2. **Selection** — a _bias_, not a boundary. Clips and dialogue near it rank higher; the
   rest of the project stays eligible for whatever room remains.
3. **Request scope** — whether the ask is local (_"tighten this"_, _"fix that cut"_) or
   global (_"find the best moments"_, _"cut this to 45 seconds"_). The command classifier
   already distinguishes command shapes; extend it rather than writing a second one.

A global request over a 60-minute project should produce a _wide, sparse, whole-timeline_
slice. A local request should produce a _narrow, dense_ one. Both are already expressible
as a `SemanticIndexSliceQuery`.

**Evidence.** A benchmark case pair: the same 60-minute project, once with
_"tighten the middle"_ and once with _"find the three strongest moments"_, asserting the
first slice is dense and local and the second is sparse and global. Deterministic and
model-free — the query function is pure.

---

## P2.3 — Every omission is declared and recoverable — `[ ]`

**Closes:** the honesty half of F4, which P1.1 opens.
**Touches:** `orchestrator.ts` (`summarizeReadResult`, `clearedWithHandle`),
`context-builder.ts` (tier rendering).

The codebase already knows this is the rule. `clearedWithHandle` exists because a run that
lost its stock-search results to a bare `[old result cleared — re-read if needed]`
_invented an asset path rather than re-query_: the marker offered a re-read with no address
to read from. Naming the handle inline turned the marker from an apology into an
instruction.

Apply the same standard everywhere content is bounded:

- Every truncated read digest ends with a count **and** the call that returns the rest —
  either a narrowing argument (`narrow get_transcript to a start/end window`) or an
  evidence handle (`recall_evidence("ev_7")`).
- Every bounded context tier says what it left out and how to reach it. A timeline slice
  showing 200 of 1,125 clips should say so, with the span of what it omitted — the
  existing `renderTrackClips` collapse line already does exactly this and is the model to
  follow.
- A _dropped_ tier already reaches the manifest as an omitted section with a reason
  (ADR 0080). Make sure the **model** is told too, not only the UI. A model that does not
  know the transcript was dropped will reason as though the project has no dialogue.

**Evidence.** Benchmark: all nine fall-through reads carry a recall handle or a narrowing
instruction; a test that a bounded tier's collapse line names both the count and the span.

---

## Scope gate

- **User outcome.** On a long recording the agent reasons about the part of it the request
  is about, and never silently mistakes a fragment for the whole.
- **Current gap.** F9 (a finished ranker with no caller), F10 (retrieval that only ever
  narrows), and the undeclared-omission half of F4.
- **Minimum vertical slice.** P2.1 alone — wire `getSlice` behind the existing behaviour
  as a fallback. Measurable on the 60-min row the day it lands.
- **Reuse.** `semantic-index-slice.ts` (built, unwired, **not modified**),
  `semantic-index.ts` (built), `command-classifier.ts` (built),
  `interaction-context.ts` (built), `clearedWithHandle` (built).
- **Deferred.** A learned relevance model (D5). Semantic re-ranking of the footage map.
  Any change to how the index is built.
- **Evidence.** Benchmark rows above; golden corpus green or reviewed; `pnpm verify`.

## Risks

| Risk                                      | Mitigation                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A ranker hides something the model needed | It cannot reduce coverage below Phase 1 (P2.1 fallback rule), and P2.3 makes every omission declared and recoverable in one call.      |
| Query classification guesses wrong        | Precedence is declared and pure; pinned always wins; selection biases rather than bounds. A wrong guess costs relevance, never access. |
| Two budgets disagree                      | Ranking limits _are_ Phase 1's allocation, threaded through — one number, one owner.                                                   |
