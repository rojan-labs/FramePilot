# ADR 0126 — One mutating AI runtime

- **Status:** Accepted
- **Date:** 2026-08-18
- **Supersedes / relates to:** ADR 0055 (model-routed command classifier — the
  `planned_edit` route it introduced is removed), ADR 0125 (the recipe route is removed),
  ADR 0102 (LangGraph orchestration runtime), ADR 0103 (retirement of the orchestration
  kernel), `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6

## Context

FramePilot had two ways to execute a mutating AI request.

```text
ordinary agent request          analysis-dependent request
  -> LangGraph agent runtime      -> intent parser
  -> conductor + handlers         -> planner
  -> tools                        -> compilePlan
  -> typed operations             -> task graph / scheduler / effect runtime
                                  -> executePlannedEdit
                                  -> typed operations
```

Both ended at the same deterministic editor-core boundary, so neither was *unsafe* in the
patch sense. But they were two answers to one question — "how does FramePilot execute a
mutating AI request?" — with separate intent parsing, planning, compilation, scheduling,
cancellation, cost accounting, event vocabulary and failure semantics.

The `planned_edit` route existed for a specific reason: an edit that must acquire analysis
evidence before it can propose operations (beat synchronisation being the canonical case)
was thought to need a bounded, pre-compiled graph rather than an open agent loop, both for
correctness and for a bounded number of model calls.

The 9.5 convergence roadmap treated that as a **hypothesis to test**, not code to delete on
principle, and gated retirement on eight conditions (§6.3).

## Decision

**There is one mutating AI execution runtime: the agent.** The `planned_edit` route, and the
planner/graph machinery that served only it, are removed. Analysis-dependent edits are
ordinary agent work: the agent calls `detect_beats` / `detect_scenes` / `analyze_silence`,
reads the evidence, and mutates through the same schema-validated tool boundary as every
other edit.

`edit` (single-shot Cmd+K) and `agent` remain as distinct **user-facing surfaces** over the
run contracts; `planned_edit` is gone from the command classifier's route set, the editor-run
lifecycle route enum, the desktop stream modes and the IPC contract.

## Evidence

A parity harness ran the same user goal through both routes against the same project with the
same deterministic scripted provider and host executor, and compared them on every §6.3
dimension a scripted provider can measure. Full record:
`docs/architecture/FRAMEPILOT-95-ROUTE-PARITY-EVIDENCE.md`. The three findings that decided
it:

1. **No planned-edit-only capability.** Beat synchronisation — the capability the route was
   written for — is reached by the agent with the same operations, the same validation and
   the same reversibility.

2. **The bounded-model-call argument did not survive measurement.** Both routes used 3 model
   calls for the same edit, and on every failure path `planned_edit` cost *more* (5 vs 2–3),
   because a rejected proposal is re-proposed inside the graph.

3. **`planned_edit` had an unvalidated model → host argument path.** The agent parses every
   analysis/action tool call against its Zod schema before dispatch. The planned-edit graph
   executor built `{ kind: 'host_tool', call }` from **Planner-authored plan-step arguments**
   and dispatched them to the host analysis engine with no schema check. This was found *by*
   the harness: the agent rejected `analyze_silence({ trackId })` with "Unrecognized key"
   while `planned_edit` passed the identical arguments straight through. Retiring the route
   closes the hole.

Two §6.3 dimensions could not be measured deterministically — editorial `outcome` and
wall-clock `latency`, both properties of a real model on real media. They are recorded as
**explicit maintainer-accepted waivers**, not as passes. See the evidence document and
`plan/FRAMEPILOT-95-FOUNDATION-EXIT.md`.

## Consequences

### Good

- One answer to "how is a mutating AI request executed", explainable without archaeology.
- One unvalidated model → host argument path removed.
- About 3,900 lines of runtime code and 5,800 lines of test code deleted, not merely
  deprecated. Every deleted test belonged to a deleted module; no surviving behavior lost
  coverage (`effect-runtime.ts` and `kernel/replay` remain at 100%).
- Analysis-dependent edits gain what the agent has and the planner never did: mid-run
  steering, review findings folded into the next turn, grouped run undo, durable
  checkpoint/resume, and per-turn Instant Apply.
- The classifier has one fewer route to get wrong. Its `planned_edit` verdict previously
  fell back to the agent whenever the compiled plan missed the structural gate, which meant
  a failed classification cost two planning calls to arrive where it started.

### Costs and risks

- The bounded-call *shape* is gone. An agent loop is free to take more turns than a
  pre-compiled graph on a request neither was measured against. `maxSteps`, the loop
  detector and the cost ceilings remain the bound; the conformance suite pins a per-scenario
  model-call budget so a regression into a spin loop fails a test rather than a bill.
- Editorial quality parity rests on deterministic mechanics plus the argument that the agent
  is a superset, not on a real-provider A/B. If the Foundation real-provider capture later
  shows the planner produced better beat-synced edits, the answer is agent capability work
  (a skill, a tool, better evidence), not a second runtime — §19's stop rules still hold.
- Generic batch scheduling went with the route. Roadmap §6.4 permits keeping a scheduler
  *under* a tool or infrastructure service, but it had no such consumer; re-introducing one
  when a real batch job needs it is a smaller change than maintaining an unused one.

### Migration

Persisted `start` commands are re-parsed from the durable event log during recovery, so a run
that was in flight across the upgrade would otherwise become unreplayable. `planned-edit` is
still **accepted on read** and normalized to `agent`; fresh starts naming it are rejected at
the IPC boundary as a renderer/main version mismatch. `AgentRunRouteMode` keeps the
`planned-edit` label for the same reason: Phase-0 Foundation records captured before the
convergence still carry it.

## Alternatives considered

- **Keep both routes and document the split.** Rejected: the roadmap's §11 complexity budget
  targets exactly one mutating runtime, and the census showed the split bought no capability.
- **Keep the planner as agent *state* (a `RunPlan`) and delete only the executor.** Partly
  adopted — the agent already drafts and tracks a plan (`planFirst`, `AgentRun.plan`,
  plan-approval gating), so no new planning state was needed. What was deleted is the second
  *execution* universe, not planning.
- **Wait for real-provider evidence before deleting.** The honest option, and the one the
  Foundation exit record defaults to. Overridden explicitly by the maintainer on the strength
  of the deterministic evidence, with the two unmeasured dimensions recorded as waivers so
  the decision stays visible rather than inferred.
