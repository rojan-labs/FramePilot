# FramePilot 9.5 Foundation Exit Record

**Parent roadmap:** [`FRAMEPILOT-95-CONVERGENCE-ROADMAP.md`](./FRAMEPILOT-95-CONVERGENCE-ROADMAP.md)  
**Phase:** 0, measurement before architecture  
**Status:** `[x]` Foundation implementation complete, external real-media sampling remains evidence collection  
**Date:** 2026-08-17

## Completed in this phase

- [x] Canonical agent-outcome benchmark manifest exists with 50 scenarios.
- [x] Tiers A, B, C, D and E each contain 10 scenarios.
- [x] Every row records task, realistic project/media state, final-state predicates, hard constraints, inspection expectation, review expectation and maximum tolerated revisions.
- [x] Representative deterministic rows execute through the existing professional eval runner.
- [x] Representative mutation and cancel-during-analysis rows exercise the current shipping `Orchestrator.streamAgent` path.
- [x] Phase-0 run-quality telemetry records the complete roadmap §5.3 metric surface in serializable eval output records.
- [x] Top-line aggregation exists for tier success, p50/p95 wall time, p50/p95 tool calls, revision rate, cancellation integrity and render validity.
- [x] Architecture census identifies all current mutation authority groups and documents validation, revision, persistence, cancellation, review and undo semantics.
- [x] The census explicitly preserves editor-core as project mutation authority and review as read-only.
- [x] No `planned_edit` deletion, runtime convergence or later roadmap phase is included.

## Evidence that remains deliberately unclaimed

These require real provider/media/editor samples and are not fabricated by hermetic tests:

- full 50-scenario success distribution on representative source media;
- real-provider p50/p95 latency and cache behavior;
- human/editorial acceptance score distribution;
- render-validity distribution for rows requiring rendered evidence;
- large-session wall-clock/memory numbers for 1000+ clip/asset projects.

The measuring contracts for those values now exist. When sampling is performed, results must be
stored through the same `AgentOutcomeEvalRunRecord`/top-line summary rather than a second benchmark
format.

## Gate for Runtime convergence

Phase 1 may now compare the primary agent and `planned_edit` against one benchmark/census contract.
It must not treat an unavailable metric as zero or passing, and it must not change the host project
mutation, revision, persistence, review or undo authorities merely to improve an orchestration
score.

Any Phase-1 deletion decision should cite:

1. `packages/ai-sdk/src/professional-agent-evals.ts` for canonical scenario definitions;
2. `packages/ai-sdk/src/agent-run-quality.ts` for per-run and top-line measurements;
3. `docs/quality/FRAMEPILOT-95-FOUNDATION-BASELINE.md` for baseline interpretation;
4. `docs/architecture/FRAMEPILOT-95-MUTATION-ROUTE-CENSUS.md` for current ownership semantics.
