# FramePilot 9.5 Foundation Baseline

**Program:** `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` Phase 0  
**Captured:** 2026-08-17  
**Purpose:** freeze the measurement contract and the evidence FramePilot can honestly measure before Runtime convergence changes architecture.

## Evidence baseline

| Dimension | Phase-0 evidence | Interpretation |
| --- | --- | --- |
| Canonical agent-outcome scenarios | 50 registered, 10 in each A-E tier | The benchmark surface is fixed before convergence work. |
| Existing professional capability rows | 33 registered professional eval rows | Capability correctness continues to use the existing release gate rather than a second framework. |
| Foundation deterministic linkage | Tier-A representative rows link to the existing ripple-trim, roll, slip, slide, insert, overwrite, lift and replace professional fixtures | These execute through resolve/compile/validate/apply/invert/persist/cross-host checks. |
| Shipping agent-path representatives | Mutating agent turn and cancel-during-analysis scenarios | The Foundation telemetry is exercised on `Orchestrator.streamAgent`, not only synthetic metric objects. A `diff` emitted by the agent is treated as a proposal/attempt, not host-commit evidence. |
| Foundation contract eval | `pnpm eval:agent:foundation` | Runs the canonical manifest/drift checks, linked professional-eval executions, run-quality invariants and provider-capability transparency tests without creating another eval framework. |
| Run-quality metric surface | Complete roadmap §5.3 metric contract represented in one serializable record | Route, model/provider, model calls, exposed tool schemas, tool/invalid/duplicate/cache counts, tokens, timing, operation counts, revisions, findings, repairs, cancellation, outcome, deterministic validation, render evidence and optional human score are preserved per measured run. |
| Outcome grading | Scenario inspection/review requirements, revision budget, terminal outcome, deterministic validation and render failure are enforced before a run can pass | Predicate-only success cannot hide missing execution evidence or excessive rewrites. |
| Cancellation integrity | Explicit observed evidence only | A cancelled run is not called clean merely because it happened to have zero rejected operations. |
| Mutating route ownership | 6 route groups documented | Direct patch, primary agent, planned edit, host settlement, browser/manual mutation and undo/redo have explicit semantics. |
| Review writer count | 0 | Review remains a finding source. It has no direct project mutation authority. |
| Canonical project mutation authority | 1 (`@framepilot/editor-core` patch/project-patch boundary) | Agent/runtime convergence must not replace this authority. |
| Final-render authority | 1 (Python/FFmpeg) | Foundation does not change rendering architecture. |

## Measurement honesty rules

The Foundation record is deliberately strict about the difference between **zero** and **unknown**:

- an agent `diff` proves a proposed edit, not that the host applied it; applied operation counts, revision changes and deterministic-validation results require host-side evidence;
- required inspection or review that was not observed makes the scenario fail;
- missing project revision range makes the scenario fail instead of assuming zero revisions;
- a revision delta above `maxToleratedRevisionCount` makes the scenario fail;
- a missing terminal run outcome makes the scenario fail;
- failed render/media evidence makes the scenario fail whenever it was measured;
- cancellation integrity is excluded from the denominator unless it was explicitly evaluated;
- unavailable render, human/editorial and host-latency evidence stays unavailable;
- explicitly supplied negative, non-finite or fractional count metrics are rejected instead of being coerced to zero;
- host-observed wall-clock latency may override the narrower event-envelope fallback.

## Metrics intentionally not fabricated

Several roadmap scores require observations that a hermetic CI run cannot honestly manufacture.
They remain unavailable/not-run until the proper evidence source exists:

- real-provider p50/p95 latency and TTFT across a desktop-scale corpus;
- real provider cache hit rate where the provider does not report cache counters;
- human/editorial acceptance scores;
- render validity for benchmark rows that do not run the rendered evidence acquisition gate;
- full Tier B-D natural-language success rates on real media;
- large-project wall-clock/memory measurements on representative 1000+ clip sessions.

`BaselineCaptureProvider` remains the provider-boundary measuring rig for real calls.
`captureAgentRunQuality` consumes those samples and the normal `AiEvent` trace. Later real-media
runs must populate the same record rather than introducing a second metric format.

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

Unavailable evidence stays out of the relevant denominator. A scenario with no render sample or no
observed cancellation-integrity result cannot silently become a zero or a pass.

## Phase 0 status

### Measurement implementation

- [x] Canonical approximately-50 scenario set exists. Exact count: 50.
- [x] Representative deterministic scenarios reuse the professional eval runner.
- [x] Representative mutating and cancellation scenarios exercise the shipping agent runtime.
- [x] `pnpm eval:agent:foundation` provides one deterministic command for the Foundation contract suite.
- [x] Per-run quality metrics are serializable in eval output records.
- [x] Scenario execution requirements are fail-closed in the grader.
- [x] Mutating-route census documents validation, revision, persistence, cancellation, review and undo.
- [x] Architecture deletion is explicitly excluded from this phase.

### Evidence exit gate

- [ ] Real-provider/full-media benchmark distribution has been captured.
- [ ] The roadmap's working score estimates have been replaced by measured values where the required evidence source exists.

The measuring infrastructure is ready for Runtime-convergence comparisons, but no route-retirement
or architecture-deletion decision should treat the Phase 0 evidence exit gate as complete until
those two items are satisfied.

## Real-provider capture path (Google Gemini)

**Status: infrastructure only. Not yet executed against a real API key.** This closes the
*measuring capability* for the two rows above; it does not close the rows themselves.

- `pnpm eval:agent:foundation:real` (`packages/ai-sdk/src/eval/foundation-real-eval.ts`) drives
  every Tier B, C and D scenario in `AGENT_OUTCOME_EVAL_SCENARIOS` through the real
  `Orchestrator.streamAgent` path against a real `ConcreteLangChainGoogleProvider` (Google
  Gemini, `GOOGLE_API_KEY`/`GOOGLE_MODEL`/`GOOGLE_BASE_URL`), wrapped in the existing
  `BaselineCaptureProvider` measuring rig. It reuses `captureAgentRunQuality` and
  `buildAgentOutcomeEvalRunRecord` unchanged — no second grading path.
- `.github/workflows/foundation-real-eval.yml` runs it as a **manual `workflow_dispatch` job
  only**, reading `GOOGLE_API_KEY` from a repository secret. It does not run on every push or
  pull request — these are real, billed provider calls. Output is uploaded as a build artifact
  and the top-line summary is written to the job's `$GITHUB_STEP_SUMMARY`; the workflow does
  **not** auto-commit results back to the branch, by design (a maintainer reviews and commits
  a specific capture as evidence if they choose to).
- **Scope, narrowed deliberately:** Tier B, C, D scenarios only. Tier A already runs against
  real professional fixtures in the offline suite. Tier E (adversarial/recovery, including the
  1000+ clip large-session scenario), the 1000+ clip performance gate, "full-media" render
  evidence, and human/editorial scoring all remain **explicitly open and out of scope** for
  this change.
- **Tier B-D `status` will legitimately read `failed` for most or all rows, even after a
  real, successful Gemini call.** `buildAgentOutcomeEvalRunRecord` is fail-closed: it only
  passes a scenario when its natural-language hard constraints/final-state predicates were
  mechanically observed as true, and no automated grader for those semantic judgments exists
  yet. This capture path also never touches a persisted project/revision store, so it never
  observes a revision range either — every record therefore fails on
  `"Project revision range was not observed."` in addition to any ungraded predicates. **This
  is correct fail-closed behavior, not a defect of this change.** The `metrics` on every
  record (latency, tokens, tool calls, model identity, terminal run outcome) are real captured
  telemetry regardless of `status`, and that telemetry — not a fabricated pass rate — is what
  this path exists to produce. Building the semantic predicate grader and wiring host
  settlement/revision observation into this harness are separate, not-yet-scoped follow-ups.
