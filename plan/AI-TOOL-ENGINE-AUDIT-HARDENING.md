# AI Tool / Engine Audit Hardening

**Status:** [x] implementation landed on `fix/ai-tool-engine-audit`; local verification complete (`pnpm verify` green end to end). GitHub Actions CI has not been checked (see Verification status).

**PR:** #144

## Scope

This hardening pass follows the repository-wide audit of the AI orchestration, model-facing tool registry, editor-core operation layer, Python tool mirror, patch validation and renderer-facing transition contracts.

The goal is to preserve FramePilot's core invariant:

> A model-authored edit is accepted only when every layer agrees on what the operation means, the operation is typed/reversible, validation succeeds against current project state, and completion is backed by evidence.

## Implemented

- [x] Scope autonomous idempotency by a stable editing-context identity; a proven identity is folded into the cache key as a collision guard rather than disabling caching when none can be proven (restored the base `(key, revision, request)` dedup contract — see `autonomous-edit-runtime.ts`).
- [x] Require Python transitions to sit on a clean cut rather than allowing a timeline gap/overlap.
- [x] Match Python transition duration validation to editor-core's half-of-shorter-neighbour limit.
- [x] Make Python `AddTransition.kind` carry generated transition catalog ids rather than the eight legacy ids.
- [x] Turn missing Python in-process tool handlers into an explicit typed dispatch failure rather than an untyped `KeyError` (`missing_in_process_handlers()` is now empty — every advertised tool is either handled or explicitly host-delegated).
- [x] Normalize expected handler-level semantic refusals into typed `ToolSemanticError` failures while leaving programmer exceptions visible (narrowed the catch to `ValueError` only — no handler ever raises `TypeError`; catching it too would have silently reclassified real bugs as client-facing refusals). `ToolSemanticError`/`ToolHandlerMissingError` are now exported from the `ai_tools` package alongside their sibling typed errors.
- [x] Restrict nested autonomous patch builders with explicit timeline/project allowlists, while preserving specific unknown/unavailable/non-mutating/wrong-scope diagnostics instead of one flat "not authorized" message.
- [x] Keep the timeline wipe guard enabled for scoped requests such as "remove silence" or "redo captions"; only explicit project/timeline resets disable the global guard. Tightened further: "start over"/"begin again" phrases now only count as a full reset when bare or paired with an explicit project/timeline/everything object — a narrowly-scoped "start over with the intro" no longer disables guard protection for the rest of the run.
- [x] Reject an AI transition request when editor-core would silently shorten its duration; the model must retry with the actual legal duration.
- [x] Reject unknown/out-of-range `apply_effect` parameters before renderer-oriented clamping can hide the bad request.
- [x] Fail completion when a target duration exists but verification did not produce `actualDurationFrames`.
- [x] Bound model-authored positive constant speed away from zero on the autonomous surface — including through the `set_clip_playback_mode` virtual builder's `normal`/`reverse` modes, which emit a raw `set_clip_speed` operation and had bypassed the floor entirely (found in post-implementation security review; a near-zero speed there reopened the same "5s clip becomes hours long" DoS the floor was added to close).
- [x] Derive tool state-dependency/cache metadata from the same explicit classification table used by the evidence store.
- [x] Add a Python transition behavioral contract that consumes the generated TypeScript transition catalog and pins clean-cut + duration semantics.

### Additional fixes found during local verification and security review

Running the full local suite (not done before this pass — see Verification status) surfaced several real regressions the static-review-only implementation pass had introduced; all are fixed and covered by tests:

- [x] `toolDescriptors()` (`tool-registry.ts`) never adopted `withToolInputContract` when the old mutating `installToolInputContracts` was deleted, so every model-facing tool schema silently lost its semantic tightening (`map_time`'s `oneOf`, `add_keyframes`'s property enum, `add_transition`'s `discover_transitions` wording, etc.). Now wraps each descriptor through the same immutable contract `tool-scope.ts` uses.
- [x] `orchestrator.ts`'s interactive dispatch (`read`/`ask`/`action`/`analysis` tool calls) looked up tools via raw `getTool()` and never applied `withToolInputContract`, so the relational/semantic assertions (`assertOrdered`, `assertMapTime`) silently didn't fire on that path even though the model-facing schema advertised them.
- [x] `_from_operation_error` (Python `patch_validation.py`) had no mapping for the new `invalid_transition` `OperationError` code, so it fell through to the generic `overlap_error` catch-all instead of the new dedicated `transition_overlap` validation code.
- [x] Fixed a stale shared test fixture (`_timeline()` in `test_operations.py`, `project` fixture in `test_ai_tools.py`) that used a 1s-gapped clip pair — valid before this PR, now correctly rejected by the new clean-cut requirement. Transition-specific tests now use a dedicated adjacent-clip fixture; the shared gapped fixture is untouched for the ~50 other tests that rely on it.

## Broader architecture follow-up

The audit also identified longer-lived consolidation work that should remain visible until the broader verification/refactor pass:

- [~] Generate or differentially test a wider TS↔Python behavioral fixture for all mirrored tools, not only structural JSON-schema parity and transitions. **Started:** `cross-runtime-operation-behavior.json` + consuming tests in both runtimes now cover 11 operation types (trim/split/move/add-text/track-flags/speed/crop/blend-mode/mask/audio/transition) out of the full operation set (~25+ types incl. `delete_range`, `ripple_delete`, `add_clip`, `add_caption_layer`, `add_keyframes`, `apply_color_grade`, `track_object`, layer ops, `restore_clips`, ...). Extending coverage to the remaining operations is still open.
- [x] Consolidate transition policy further so eligibility, validation, apply and verification consume one policy per runtime instead of duplicating formulas. Python side confirmed: `transition_policy.py`'s `transition_eligibility` is the sole source of clean-cut/adjacency/duration-capacity math; both `patch_validation.py` and `operations.py` consume it exclusively (verified no residual duplicate formula elsewhere in the Python engine tree).
- [x] Add an explicit model-facing transition removal/hard-cut action instead of representing only transition addition (`set_hard_cut` → resolves to `add_transition` with `kind: 'cut'`).
- [x] Remove mutable import-order-dependent tool-contract installation by constructing immutable complete tool definitions at registry creation time (`withToolInputContract`, cached per-tool in a `WeakMap`; `TOOL_REGISTRY` itself is never mutated). All known dispatch paths (`tool-dispatch.ts`, `tool-scope.ts`, `tool-registry.ts`'s `toolDescriptors()`, `orchestrator.ts`'s interactive dispatch) now apply it.
- [x] Derive LangGraph recursion allowance from the conductor run budget so the graph backstop can never terminate a valid configured run first (`agent-graph.ts`, tied to the real `config.maxSteps`, floored at 32).
- [ ] Refine progress accounting so a warning counts as learned evidence only when the warning carries a durable classified fact. Not started in this pass.
- [~] Complete engine-capability → AI-tool reachability for reverse/freeze/speed ramps, rich masks and the full audio operation surface. **Started:** the autonomous (non-interactive) patch-proposal surface gained `set_clip_playback_mode` (freeze/reverse/normal), `set_clip_speed_ramp`, `add_mask_advanced`, and `adjust_audio_full` as virtual builders (`autonomous-patch-proposal.ts`). The interactive tool registry / main agent loop was not extended in this pass — still open if those capabilities need to be reachable there too.
- [x] Implement or explicitly reclassify every Python `missing_in_process_handlers()` entry so advertised Python tool availability and executable handlers are one-to-one. Verified: `missing_in_process_handlers()` now returns an empty tuple — every advertised read/mutate tool is either locally handled or in the explicit `_HOST_DELEGATED_TOOLS` set.

## Verification status

**Local verification is complete for this pass** (previously deferred; now run in full):

- `pnpm verify` (typecheck + lint + test + `engine:test`) passes end to end across the whole monorepo.
- `packages/ai-sdk`: 135 test files / 2888 tests passing, typecheck clean, lint clean.
- `engine/python`: 2442 passed / 1 skipped, `ruff check .` clean, `mypy .` clean (178 source files).
- `prettier --check` clean on every file touched by this branch.

This required fixing real regressions the implementation pass (done via static review only, per the original note below) had introduced — see "Additional fixes found during local verification and security review" above and the security findings folded into the Implemented list. This is exactly why the original deferral was risky: several of the `[~]` items marked done in the first draft of this plan were not actually correct until exercised by the test suite.

GitHub Actions / remote CI has still **not** been checked in this pass (no Actions minutes available locally) — no workflow run, check log, or remote CI result was used to mark anything above complete. Everything above is backed by local command output only. The normal PR review should still confirm the same commands pass in CI before merge, as a defense against any local-environment drift (e.g. this session also discovered the repo's `engine:sync` pnpm script is missing `--extra dev`, unlike `.github/workflows/ci.yml`'s `uv sync --extra dev` — a local dev-environment footgun worth fixing separately, not fixed in this branch since it's outside this PR's scope).
