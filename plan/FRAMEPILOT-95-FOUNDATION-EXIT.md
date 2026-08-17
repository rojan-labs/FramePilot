# FramePilot 9.5 Foundation Exit Record

**Parent roadmap:** [`FRAMEPILOT-95-CONVERGENCE-ROADMAP.md`](./FRAMEPILOT-95-CONVERGENCE-ROADMAP.md)  
**Phase:** 0, measurement before architecture  
**Status:** `[~]` measurement implementation complete; Phase 0 evidence exit still pending  
**Date:** 2026-08-17

## Measurement implementation completed

- [x] Canonical agent-outcome benchmark manifest exists with 50 scenarios.
- [x] Tiers A, B, C, D and E each contain 10 scenarios.
- [x] Every row records task, realistic project/media state, final-state predicates, hard constraints, inspection expectation, review expectation and maximum tolerated revisions.
- [x] Representative deterministic rows execute through the existing professional eval runner.
- [x] Representative mutation and cancel-during-analysis rows exercise the current shipping `Orchestrator.streamAgent` path.
- [x] `pnpm eval:agent:foundation` runs the deterministic Foundation manifest, linked professional-eval, telemetry and provider-capability contract suite.
- [x] Agent-emitted `diff` events are treated as proposed/attempted work; applied operations, revision advancement and deterministic validation require host-side evidence.
- [x] Phase-0 run-quality telemetry represents the complete roadmap §5.3 metric contract in serializable eval output records.
- [x] Outcome grading fails closed on missing required inspection/review evidence, missing revision evidence, excessive revisions, missing terminal outcome, unvalidated claimed application, impossible operation accounting, deterministic-validation failure and failed render/media evidence.
- [x] Cancellation integrity is scored only from explicit observed evidence.
- [x] Top-line aggregation exists for tier success, p50/p95 wall time, p50/p95 tool calls, revision rate, cancellation integrity and render validity.
- [x] Architecture census identifies all current mutation authority groups and documents validation, revision, persistence, cancellation, review and undo semantics.
- [x] The census explicitly preserves editor-core as project mutation authority and review as read-only.
- [x] No `planned_edit` deletion, runtime convergence or later roadmap phase is included.

## Phase 0 evidence exit still required

The roadmap's Phase 0 exit criteria require measured evidence, not only the instrumentation that can
collect it. These items remain open and must not be converted to inferred or synthetic passes:

- [ ] run the representative agent benchmark against real provider/media projects and persist the resulting distribution;
- [ ] replace the roadmap's working score estimates with measured values wherever the required evidence source exists;
- [ ] capture real-provider p50/p95 latency and cache behavior;
- [ ] capture human/editorial acceptance scores for scenarios where subjective quality is unavoidable;
- [ ] capture render-validity evidence for benchmark rows whose claim depends on rendered media;
- [ ] capture large-session wall-clock/memory numbers for the 1000+ clip/asset scenario.

The measuring contracts for those values now exist. When sampling is performed, results must be
stored through the same `AgentOutcomeEvalRunRecord`/top-line summary rather than a second benchmark
format.

## Gate for Runtime convergence

The Foundation contracts may be used now to implement and exercise comparison tooling for the
primary agent and `planned_edit`, but **route retirement, architecture deletion and claims that Phase
0 has exited remain blocked** until the evidence items above are satisfied.

Runtime-convergence work must not treat an unavailable metric as zero or passing, and it must not
change the host project mutation, revision, persistence, review or undo authorities merely to
improve an orchestration score.

Any later convergence or deletion decision should cite:

1. `packages/ai-sdk/src/professional-agent-evals.ts` for canonical scenario definitions;
2. `packages/ai-sdk/src/agent-run-quality.ts` for per-run and top-line measurements;
3. `docs/quality/FRAMEPILOT-95-FOUNDATION-BASELINE.md` for baseline interpretation;
4. `docs/architecture/FRAMEPILOT-95-MUTATION-ROUTE-CENSUS.md` for current ownership semantics.
