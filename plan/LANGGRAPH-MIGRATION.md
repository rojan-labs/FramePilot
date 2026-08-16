# LangGraph Orchestration Migration

> **Status:** `[x]` complete and verified.
>
> **Created:** 2026-08-06
>
> **Completed:** 2026-08-06
>
> **Branch:** `plan/autonomous-edit-phase0-diagnosis`
>
> **Pull request:** #130
>
> **Primary target:** Electron desktop agent workflow

## Goal

Move FramePilot's custom Conductor execution loop onto LangGraph without replacing the editing domain, provider layer, typed tools, patch authority, desktop persistence, or UI event contracts.

## Non-negotiable boundaries

- The model still edits only through registered, schema-validated tools.
- Timeline and project changes still become typed, validated, reversible patches.
- Provider adapters remain FramePilot-owned.
- Existing `AiEvent` payloads and ordering remain the UI contract.
- Existing durable desktop runs, resume payloads, approval gates, and `ask_user` flows remain the persistence contract.
- No project schema, IPC, sandbox, render, or permission changes.
- No LangGraph checkpointer was introduced.

## Phase 0. Inventory and cutover design `[x]`

- [x] Locate and reuse the existing PR and non-main branch.
- [x] Inspect `AGENTS.md`, the orchestration plan, AI safety rules, package boundaries, current Conductor driver, and driver tests.
- [x] Confirm that FramePilot already separates pure orchestration policy from side-effect handlers.
- [x] Choose a shell-only migration rather than replacing providers or editing contracts.

**Result:** the stable cutover boundary is `runConductor(command, handlers, signal)`.

## Phase 1. Runtime dependency `[x]`

- [x] Add `@langchain/langgraph` to `@framepilot/ai-sdk`.
- [x] Add the required `@langchain/core` runtime dependency.
- [x] Keep all existing provider dependencies and model wire formats unchanged.
- [x] Regenerate and commit `pnpm-lock.yaml`.
- [x] Prove a frozen-lockfile installation succeeds.

**Initial dependency commit:** `2db255db7006a5bad26f5187c8312e06e41f5af0`

## Phase 2. Graph-backed Conductor driver `[x]`

- [x] Replace the bespoke pending-effect `while` loop with a compiled `StateGraph`.
- [x] Add explicit `dispatch`, `take_effect`, `execute_effect`, and `finalize` nodes.
- [x] Route typed reducer effects through conditional graph edges.
- [x] Preserve the pure Conductor reducer as the only orchestration-policy authority.
- [x] Preserve every existing typed handler contract.
- [x] Stream the original `AiEvent` values through LangGraph custom streaming.
- [x] Forward the caller's `AbortSignal` unchanged.
- [x] Keep existing turn and operation limits authoritative, with a graph recursion backstop.
- [x] Leave LangGraph checkpointing disabled to avoid duplicate durable state.

**Driver commit:** `06d760bb88043b23f3c91092f8654224661b1169`

## Phase 3. Migration parity coverage `[x]`

- [x] Add focused custom-stream event-order coverage.
- [x] Add AbortSignal identity coverage.
- [x] Add non-agent no-op coverage.
- [x] Keep the existing comprehensive `driver.test.ts` suite as the behavior matrix.
- [x] Cover planning, approval, multi-turn execution, verification, finalization, cancellation, and resume through the stable Conductor boundary.
- [x] Align fixtures and silent generator handlers with the repository's type and lint contracts.

**Initial coverage commits:**

- `9ca8aee3f9d5924f7e4d92475de52f7cfa1ca2d2`
- `0cc5103b08c0454280d04bbd03657eb0ef25e694`

**Verification-fix commits:**

- `26e0bb69753a5299d53ba52bbcea331a38ca5068`
- `8760bd9afe42f852ec432a7235f9485c1dd2d449`

## Phase 4. Architecture and review documentation `[x]`

- [x] Record the migration boundary in ADR 0099.
- [x] Document why providers, patches, persistence, and user-wait controls stay FramePilot-owned.
- [x] Document why a LangGraph checkpointer is deferred.
- [x] Keep all work in PR #130.

**ADR commit:** `231c41b74360525bb29c3860c95bf757896ccded`

## Phase 5. Dependency lock and verification `[x]`

- [x] Run `pnpm install --lockfile-only --no-frozen-lockfile` and commit the generated lockfile.
- [x] Run `pnpm install --frozen-lockfile` successfully.
- [x] Build `@framepilot/shared-types`, `@framepilot/timeline-schema`, and `@framepilot/editor-core` before consumer verification.
- [x] Run the focused Conductor migration suites. Result: 2 files and 11 tests passed.
- [x] Run `@framepilot/ai-sdk` TypeScript typecheck successfully.
- [x] Run `@framepilot/ai-sdk` lint successfully.
- [x] Run the repository dependency license scan successfully.
- [x] Exercise the complete orchestration lifecycle deterministically through the production `runConductor` boundary, including planning, approval, execution, verification, finalization, cancellation, resume, event ordering, and AbortSignal forwarding.

**Verification evidence:** GitHub Actions workflow run `31079414915`, job `92544573631`, completed successfully on 2026-08-06.

The exact real-media Electron baseline remains part of the parent autonomous-editing initiative in PR #130. It validates edit quality and rendering rather than the LangGraph shell migration, so it is tracked separately and does not keep this migration plan open.

## Completion criteria `[x]`

- [x] The lockfile resolves the selected LangGraph and LangChain Core versions.
- [x] Frozen installation succeeds.
- [x] Existing driver behavior passes unchanged.
- [x] New migration parity tests pass.
- [x] Typecheck, lint, and license checks pass.
- [x] Streaming, cancellation, resume, approval, verification, and finalization contracts remain intact.
- [x] No second persistent checkpoint source was introduced.

## Follow-up opportunities

These are separate product changes, not migration blockers:

- graph-level retry policies at named model/tool nodes;
- graph visualization in developer diagnostics;
- durable LangGraph checkpointing after a dedicated storage ADR;
- subgraphs for planned-edit execution and media-understanding workflows;
- LangSmith tracing as an optional development integration with explicit privacy and cost controls.
