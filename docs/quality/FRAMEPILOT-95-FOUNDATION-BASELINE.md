# FramePilot 9.5 Foundation Baseline

**Program:** `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` Phase 0  
**Captured:** 2026-08-17  
**Purpose:** freeze what is actually measured before Runtime convergence changes architecture.

## Evidence baseline

| Dimension | Phase-0 evidence | Interpretation |
| --- | --- | --- |
| Canonical agent-outcome scenarios | 50 registered, 10 in each A-E tier | The benchmark surface is fixed before convergence work. |
| Existing professional capability rows | 33 registered professional eval rows | Capability correctness continues to use the existing release gate rather than a second framework. |
| Foundation deterministic linkage | Tier-A representative rows link to the existing ripple-trim, roll, slip, slide, insert, overwrite, lift and replace professional fixtures | These execute through resolve/compile/validate/apply/invert/persist/cross-host checks. |
| Shipping agent-path representatives | Mutating agent turn and cancel-during-analysis scenarios | The Foundation telemetry is exercised on `Orchestrator.streamAgent`, not only synthetic metric objects. |
| Run-quality metric surface | 19 roadmap metric groups captured in one serializable record | Route, model/provider, model calls, exposed tool schemas, tool/invalid/duplicate/cache counts, tokens, timing, operation counts, revisions, findings, repairs, cancellation, outcome, deterministic validation, render evidence and optional human score are preserved per eval output. |
| Mutating route ownership | 6 route groups documented | Direct patch, primary agent, planned edit, desktop host settlement, browser/manual mutation and undo/redo have explicit semantics. |
| Review writer count | 0 | Review remains a finding source. It has no direct project mutation authority. |
| Canonical project mutation authority | 1 (`@framepilot/editor-core` patch/project-patch boundary) | Agent/runtime convergence must not replace this authority. |
| Final-render authority | 1 (Python/FFmpeg) | Foundation does not change rendering architecture. |

## Metrics intentionally not fabricated

Several roadmap scores require observations that a hermetic CI run cannot honestly manufacture.
They are represented as unavailable/not-run until the proper evidence source exists:

- real-provider p50/p95 latency and TTFT across a desktop-scale corpus;
- real provider cache hit rate where the provider does not report cache counters;
- human/editorial acceptance scores;
- render validity for benchmark rows that do not run the rendered evidence acquisition gate;
- full Tier B-D natural-language success rates on real media;
- large-project wall-clock/memory measurements on representative 1000+ clip sessions.

`BaselineCaptureProvider` remains the provider-boundary measuring rig for real calls. The new
`captureAgentRunQuality` observer consumes those real samples and the normal `AiEvent` trace, so
later real-media runs populate the same record without changing runtime behavior.

## Top-line comparison shape

Every persisted benchmark record can be reduced to the roadmap comparison tuple:

```text
Tier A-E success rate
p50 / p95 wall-clock latency
p50 / p95 tool-call count
revision rate
cancellation integrity
render validity
```

Missing evidence stays absent from its denominator. A provider that reports no cache usage, an eval
that does not render, or a scenario with no sampled human review never becomes an artificial zero.

## Foundation exit record

- [x] Canonical approximately-50 scenario set exists. Exact count: 50.
- [x] Representative deterministic scenarios reuse the professional eval runner.
- [x] Representative mutating and cancellation scenarios exercise the shipping agent runtime.
- [x] Per-run quality metrics are serializable in eval output records.
- [x] Mutating-route census documents validation, revision, persistence, cancellation, review and undo.
- [x] Architecture deletion is explicitly excluded from this phase.
- [ ] Real-provider/full-media benchmark distribution. This is external evidence collection, not a prerequisite for adding the measuring instrument. Values stay unclaimed until captured.

Runtime convergence must compare against these contracts and must not reinterpret unavailable
measurements as passing values.
