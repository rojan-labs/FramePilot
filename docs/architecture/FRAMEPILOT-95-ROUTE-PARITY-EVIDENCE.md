# FramePilot 9.5 Phase-1 Route Parity Evidence

**Status:** Phase 1 retirement-gate evidence
**Roadmap:** `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6.1, §6.3
**Census:** `docs/architecture/FRAMEPILOT-95-MUTATION-ROUTE-CENSUS.md`
**Harness (at the parity commit `34144a1`):** `packages/ai-sdk/src/route-parity.ts` ·
scenarios `route-parity-scenarios.ts` · gate `route-parity.test.ts`
**Harness (today):** `packages/ai-sdk/src/mutating-runtime-conformance.ts` — once the second
route was retired the comparator had no subject, so the same scenarios and observations
became invariants of the one runtime. The comparative harness is reproducible at `34144a1`.

## What this document is

Phase 1 may retire `planned_edit` as a distinct mutating execution route only when the §6.3
conditions hold. This is the record of what was measured, what was not, and why the
maintainer was asked to accept the difference.

The harness runs the **same user goal** through **both** mutating routes against the **same**
project with the **same** deterministic scripted provider and host executor, then compares the
observable result. Per-run numbers are projected through the Phase-0 telemetry contract
(`captureAgentRunQuality`), so parity numbers and Foundation numbers are the same numbers.

## Scenario set

| Row | Tier | Goal | Discharges |
| --- | --- | --- | --- |
| `silence-tighten` | B | tighten the pacing at the start | capability, cost, durability, activity, review, undo, failure honesty |
| `beat-sync-montage` | C | cut a short montage on the music beats | the capability `planned_edit` was written for |
| `cancel-during-analysis` | E | stop pressed during analysis | cancellation, durability |
| `analysis-backend-unavailable` | E | the media engine is down | failure honesty, activity |
| `invalid-tool-arguments` | E | model emits arguments no tool accepts | malformed call never mutates |

## Measured result

| Row | planned_edit | agent | Verdict |
| --- | --- | --- | --- |
| `silence-tighten` | completed · 3 model calls · `[ripple_delete]` · reversible | completed · 3 model calls · `[ripple_delete]` · reversible | `agent_ready` |
| `beat-sync-montage` | completed · 3 model calls · `[add_clip, add_clip]` · reversible | completed · 3 model calls · `[add_clip, add_clip]` · reversible | `agent_ready` |
| `cancel-during-analysis` | cancelled · 2 model calls · no operations | cancelled · 1 model call · no operations | `agent_ready` |
| `analysis-backend-unavailable` | failed · 5 model calls · no operations | failed · 2 model calls · no operations | `agent_ready` |
| `invalid-tool-arguments` | failed · 5 model calls · no operations | failed · 3 model calls · no operations | `agent_ready` |

Gate summary: **`retirement_unblocked`**, blockers `[]`.

### The three findings that mattered

1. **No planned-edit-only capability remains — with one exception the harness missed.** Beat
   synchronisation — the capability the classifier's `planned_edit` route was explicitly
   written for (`kernel/command-classifier.ts`) — is reached by the agent through
   `detect_beats` + `add_clip` with the same operations, the same validation and the same
   reversibility.

   **The exception, found during self-review rather than by this harness:** the deterministic
   beat-grid boundary rule (`kernel/beat-grid/beat-alignment.ts`) snapped near-miss `add_clip`
   boundaries onto detected onsets and rejected off-grid ones naming the nearest legal onset.
   The agent does not enforce it. This harness did not catch it because the `beat-sync-montage`
   scenario scripts perfectly on-beat clips, so no boundary was ever off-grid — a scenario-set
   gap worth remembering: a parity row proves parity only for the behavior it actually
   exercises. Tracked as roadmap PR 5; see ADR 0126's Costs and risks.

2. **The bounded-model-call argument does not survive measurement.** `planned_edit` exists
   partly because it consults the model a bounded number of times (intent + plan +
   `propose_edit`) rather than once per agent turn. Measured, that is 3 calls on both routes
   for the same edit — and on every failure path `planned_edit` costs *more* (5 vs 2–3),
   because a rejected proposal is re-proposed inside the graph.

3. **`planned_edit` had an unvalidated model → host argument path.** The agent validates
   every analysis/action tool call against its Zod schema before dispatch
   (`orchestrator.ts`, `tool.parse(args)` at the `host_tool` boundary). The planned-edit
   graph executor dispatched `{ kind: 'host_tool', call }` built from **Planner-authored plan
   step arguments** with no schema check (`kernel/graph-executor.ts`), so a hallucinated
   argument shape reached the host analysis engine directly. This was discovered *by* the
   harness: the agent rejected `analyze_silence({ trackId })` with "Unrecognized key" while
   `planned_edit` passed the same arguments straight through. Retiring the route closes the
   hole; `mutating-runtime-conformance.test.ts` pins the invariant behaviourally by asserting
   the host executor never receives the malformed call.

## What was NOT measured, and why

Two §6.3 dimensions are reported as `not_evaluated` and carried as explicit waivers rather
than silently scored as passes. A scripted provider structurally cannot produce either.

| Dimension | Why unavailable | What would close it |
| --- | --- | --- |
| `outcome` (editorial success equal or better) | Editorial quality is a property of a real model on real media. | The Foundation real-provider capture (`pnpm eval:agent:foundation:real`) with maintainer editorial scoring. |
| `latency` (within agreed budget) | Wall-clock under a synchronous mock measures the harness, not the runtime. | The same real-provider capture, recording p50/p95. |

`plan/FRAMEPILOT-95-FOUNDATION-EXIT.md` blocks route retirement until that real-provider
evidence exists. **The maintainer waived those two items for this convergence** on the basis
of the deterministic evidence above: capability, cost, cancellation, durability, activity,
review, undo and failure honesty are all measured at parity or better, and the agent runtime
is the route `planned_edit` already fell back to whenever its own gate declined a plan. The
waiver is recorded here, in the roadmap and in the PR so it is an owner decision on the record
rather than an inferred pass.

## Maintenance rule

This document is evidence for one deletion. It is not a standing claim. If a future change
reintroduces a second mutating route, restore the comparative harness from `34144a1` and
re-run it — do not cite this table.

The invariants it proved are enforced continuously by
`packages/ai-sdk/src/mutating-runtime-conformance.test.ts`, which also asserts that exactly
one mutating route remains in the run contracts.
