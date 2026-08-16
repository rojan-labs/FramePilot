# Autonomous, Context-Aware Editing Quality and Orchestration Plan

> **Status:** `[~]` implementation active. The exact local desktop baseline remains a release gate.
>
> **Created:** 2026-08-05
>
> **Updated:** 2026-08-05
>
> **Branch:** `plan/autonomous-edit-phase0-diagnosis`
>
> **Primary target:** Electron desktop app. Browser-only gaps may be deferred. Desktop regressions may not.
>
> **Evidence ledger:** [`plan/AUTONOMOUS-EDIT-PHASE0-EVIDENCE.md`](./AUTONOMOUS-EDIT-PHASE0-EVIDENCE.md)
>
> **History:** this file supersedes the earlier AI Footage Intelligence implementation roadmap. The previous document remains available in Git history at the parent revision.
>
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## 1. Mission

FramePilot must turn a plain-language editing intent into a precise, reversible, context-aware edit that looks and sounds correct in playback. The first acceptance case is intentionally small: a real recording of about 30 seconds with only a few clips. Scale work does not substitute for correctness on this fixture.

The implementation order is fixed:

1. reproduce the current bad edit and prove the first divergence;
2. repair the smallest complete edit path;
3. consolidate the model-facing tool surface;
4. add deterministic media and timestamp queries;
5. centralize TwelveLabs access and automatic understanding;
6. guarantee persistent cache reuse;
7. narrow provider settings;
8. harden orchestration;
9. make the sidebar show the work and evidence;
10. verify the exact before/after baseline.

## 2. Non-negotiable product decisions

### D1. Automatic embeddings and indexing

There is no user-facing or model-selected manual embedding step. Search and analysis call an internal `ensure_media_understanding` capability. Any retained embed/index method is an internal facade operation, not a button or default model tool.

### D2. Speech-to-text providers

Exactly two user-facing options remain:

- **Local**, backed by the current local Whisper CLI pipeline.
- **TwelveLabs**, backed by the current indexed native transcript workflow.

Groq and NVIDIA are removed from selectors and new-run contracts. Existing persisted values migrate to Local with a one-time explanatory notice. A working transcription path is not deleted before its callers and settings are migrated.

### D3. Caption provider

The caption-provider selection concept is removed. Caption functionality remains intact. Transcript-to-cue segmentation, cue editing, caption tracks, templates, fonts, styling, auto emphasis, placement, animation, verification, schema parity, and Python rendering are preserved. Persisted provider preferences are ignored/removed through a settings migration without altering caption content.

### D4. TwelveLabs transcription versus analysis

Native indexed transcription and Pegasus analysis are separate capabilities. No endpoint or timing guarantee may be invented. The installed SDK types, current facade, and a real account response are the source of truth.

### D5. Offline behavior

Local probing, local transcription, deterministic analysis, timeline inspection, patching, validation, undo, preview, and rendering continue offline where their existing local dependencies are available. Completed TwelveLabs cache entries remain usable offline. Uncached semantic TwelveLabs operations return an explicit unavailable state and recovery action. They never silently route to another embedding provider.

### D6. Cost and consent

Adding/configuring a TwelveLabs key includes one cost disclosure. After consent, indexing is automatic on the first semantic need or Agent run for an unprepared asset. Optional background warming after import may be a preference, but there is no manual embedding workflow. Every cost-relevant call and cache decision is visible in the sidebar.

## 3. Architecture decisions

### A1. Canonical edit time

The internal editing boundary uses integer frame indices plus an explicit rational frame rate. Source/provider seconds are converted only at named boundaries with one rounding rule. The initial repair avoids changing `project.fp.json`. If exactness cannot be guaranteed without persisted frame-time fields, stop and request approval for a versioned schema migration.

### A2. Typed patch authority

The model proposes typed operations. It never mutates a project or timeline. The orchestrator owns assembly, canonical time conversion, validation, bounded correction, atomic apply, inverse generation, verification, rollback, and event emission.

### A3. Small model-facing registry

Operation-specific builders stay comprehensive internally but collapse into a small model-facing patch contract. The proposed shortlist and current-tool disposition are recorded in the evidence ledger. The canonical contract generates the orchestrator prompt surface, Python mirror, MCP projection, UI metadata, and parity tests.

### A4. One TwelveLabs facade

One typed facade owns index creation, asset upload/status, native transcript retrieval, search, image search, analyze, summarize, mapping, and provider error translation. No scattered SDK calls are allowed.

### A5. Universal cache

The cache key contains media content hash, operation, canonical parameters/query, backend/model, preprocessing identifiers, and cache schema version. A session LRU sits over an authoritative persistent project-brain cache. Per-key single-flight collapses concurrent duplicates. Completed and deterministic-empty results persist across restart and project reopen until a stable input/version changes or the user explicitly refreshes.

### A6. Evidence-first sidebar

The event stream carries typed visual evidence, cache decisions, cost relevance, validation failures, retries, applied operations, and blocking questions. A visual conclusion includes the exact frame/thumbnail/segment the model used, provenance, timestamp, source clip, and timeline-jump target.

## 4. Acceptance contract for a satisfying edit

A baseline edit passes only when all applicable checks pass:

- intent and requested platform are honored;
- exact target duration is reached within one frame when feasible, otherwise the nearest valid result is explained before apply;
- no negative, zero-length, orphaned, or unintended overlapping clips;
- no retained word is cut through;
- speech joins preserve natural handles and audio continuity;
- transitions fit real adjacent clip handles;
- captions represent retained speech and align to mapped transcript words within one project frame after transcript timing is accepted;
- hook placement, pacing, caption grouping, and restraint follow the loaded editing skill;
- preview and final render represent the same patch state;
- render validation reports expected streams, duration, black-frame, and clipping results;
- the full run is invertible and one grouped Undo restores the pre-run state;
- no-op or cosmetic-only output for a mutation intent is a failure;
- a failed validation or apply is never reported as success.

## 5. Execution phases

### Phase 0. Reproduce and diagnose `[~]`

The repository and provider-contract inspection is complete. The user explicitly authorized implementation to continue. The exact local Electron run over the user's real 30-second media remains `[!]` and must be completed before the initiative can be marked done.

- [x] Read repository contracts, master plan, relevant code, existing TwelveLabs integration, sidebar event surfaces, and accepted ADR context.
- [x] Record repository-proven mismatches, conflict decisions, cache design, tool disposition, and acceptance criteria in the evidence ledger.
- [x] Define the real 30-second fixture, five intents, trace schema, failure record, and root-cause buckets.
- [!] Run the exact fixture through desktop Agent mode and capture complete traces.
- [x] Confirm TwelveLabs search, analyze, embeddings, asset reuse, asynchronous indexing, modality, upload, and rate-limit contracts against the official v1.3 documentation.
- [~] Complete an exact inventory of remaining caption-provider settings and provider migration callers while implementing Phase 6.
- [ ] Assign a stable baseline failure id to every proven failure and link all later work to those ids.
- [!] Publish the real local desktop before/after evidence.

**Definition of Done:** every intent has before/after artifacts, the first divergence is proven, and no completed phase relies on a historical bug note or untested assumption.

### Phase 1. Repair the core edit path `[~]`

- [~] Add canonical frame-time utilities and explicit source/clip/sequence conversion boundaries without a project schema change.
- [ ] Make word, silence, shot, and visual-event outputs precise enough to produce real cuts.
- [ ] Repair only the trace-proven planning, tool-result, patch, validation, apply, preview, render, or craft failures.
- [ ] Surface exact validation issues to the model and user, with at most two bounded correction attempts.
- [ ] Add one regression test per baseline failure.
- [ ] Add a golden fixture assertion for final timeline, preview evidence, render duration, captions, and audio continuity.

**Definition of Done:** all five baseline intents produce an accepted, reversible edit and the same failures cannot recur in tests.

### Phase 2. Consolidate the tool surface `[~]`

- [ ] Add a generated inventory/parity test before changing the registry.
- [~] Introduce the small model-facing shortlist from the evidence ledger without deleting internal operation builders.
- [ ] Keep operation builders as internal typed functions and expose one timeline-patch proposal contract plus one project-patch proposal contract.
- [~] Remove `index_media` and unavailable tools from the default autonomous model surface.
- [ ] Merge overlapping inspection, transcript, discovery, search, and analysis routes.
- [ ] Keep MCP, Python, UI metadata, tool descriptions, prompt cache, and skills synchronized.
- [ ] Delete dead callers and stale descriptions.

**Definition of Done:** every advertised tool has one job, all surfaces derive from one typed source, and the baseline routes correctly with the reduced registry.

### Phase 3. Deterministic probe and timestamp queries `[ ]`

- [ ] Add `probe_media` for resolution, fps, codec, duration, stream presence, and frame count using local deterministic media inspection.
- [ ] Add a frame-precise `query_timestamp` contract with asset/clip identity, source versus sequence domain, inclusive/exclusive range semantics, and explicit no-answer shape.
- [ ] Compute locally reliable facts locally, including deterministic frame sampling and locally computable color metrics where appropriate.
- [ ] Return provenance, sampled frame ids/times, backend, cache state, and confidence where semantic inference is involved.
- [ ] Add timeline navigation handles for every visual result.

**Definition of Done:** resolution/fps/codec/duration questions never call a model, and semantic timestamp questions return specific evidence or an honest no-answer.

### Phase 4. TwelveLabs facade and automatic understanding `[~]`

- [~] Centralize all SDK access in one typed facade.
- [ ] Define asset content-hash to index/video mapping that survives rename, move, reopen, and duplicate media.
- [~] Implement internal automatic `ensure_media_understanding` for search/analyze needs.
- [x] Confirm the official v1.3 capability split: reusable assets, asynchronous indexing, Marengo search, Pegasus analyze, and multimodal embeddings.
- [ ] Add typed states for indexing, ready, unauthorized, unavailable, rate-limited, quota-exceeded, timeout, cancelled, moved/deleted source, and provider entitlement mismatch.
- [ ] Write a superseding ADR for the policy changes.

**Definition of Done:** there are no scattered provider calls, no manual indexing workflow, and every result carries stable provenance.

### Phase 5. Universal persistent caching `[~]`

- [~] Implement deterministic `CacheKeyV1` and versioned response envelopes.
- [ ] Add session LRU, persistent project-brain storage, atomic writes, size bounds, and eviction.
- [~] Add per-key single-flight across simultaneous identical requests.
- [ ] Persist completed and deterministic-empty results without ordinary TTL.
- [ ] Add negative-cache policy for rate limits, auth, timeout, network, and 5xx behavior.
- [ ] Make cache hit/miss/join/refresh observable in logs, traces, and sidebar.
- [ ] Prove identical completed inputs do not produce a second TwelveLabs call after restart or project reopen.

**Definition of Done:** tests count provider calls and prove zero duplicate calls for every supported completed operation.

### Phase 6. Provider narrowing and caption-setting migration `[~]`

- [~] Change STT choices to Local and TwelveLabs only across settings, request contracts, IPC/host routing, sidecar, tests, and docs.
- [ ] Migrate Groq/NVIDIA persisted selections to Local with a one-time notice.
- [ ] Remove dead adapters only after migration coverage proves no caller remains.
- [~] Remove caption-provider selectors and persisted preference handling.
- [ ] Preserve caption generation, editing, templates, style catalog, auto emphasis, verification, and TS/Python rendering parity.
- [ ] Add migration and reopen coverage for existing projects/settings.

**Definition of Done:** users see only the two STT choices, no caption-provider concept exists, and old projects keep their captions and open correctly.

### Phase 7. Orchestration accuracy and recovery `[~]`

- [ ] Normalize each intent into measurable acceptance criteria before planning.
- [ ] Require deterministic local evidence before semantic paid calls when possible.
- [ ] Require cited evidence for content-dependent edit candidates.
- [ ] Enforce plan, tool selection, patch proposal, canonical conversion, validation, correction, apply, render, verification, and completion reconciliation in order.
- [ ] Add explicit idempotency, revision checks, bounded retries, timeouts, cancellation, rollback, and partial-failure policy.
- [~] Treat no-op/trivial output and unreconciled planned work as failure.
- [ ] Preserve safety guards and change one only when a baseline trace proves it blocks a legitimate edit.
- [~] Tune tool descriptions and editing skills against the reduced real registry and engine capabilities.

**Definition of Done:** the orchestrator cannot claim success without an applied, verified, intent-matching edit or an explicit honest refusal/question.

### Phase 8. AI sidebar transparency and `ask_user` UX `[~]`

- [~] Add typed event/attachment contracts for visual evidence, cache decisions, provider calls, validation/correction, applied operations, and long-running progress.
- [~] Render the actual frame/thumbnail/segment used by the AI with timestamp, source, backend, cached/fresh state, and timeline jump.
- [ ] Preserve virtualization/history caps and bound decoded image memory.
- [~] Redesign `ask_user` as a visually distinct blocking interaction with keyboard navigation, focus management, recommended/default choice, free-form escape, cancellation safety, and live-region announcements.
- [~] After answer, render a validated plain-language question/answer summary. Never fall back to raw JSON.
- [ ] Show applied edits in editor language, linked to timeline and Undo.
- [ ] Implement every required state: default, interaction states, queued, streaming, cached, empty, partial, success, failure, validation correction, cancelled, disabled, unconfigured, offline, rate-limited, quota, timeout, retrying, awaiting answer, answered, long-running, and overflow.
- [ ] Respect reduced motion and prevent streaming layout shift.

**Definition of Done:** no meaningful orchestrator step is silent, visual conclusions show visual evidence, and the entire flow remains responsive and accessible during long runs.

### Phase 9. Verification, ADRs, guides, and release evidence `[ ]`

- [ ] Rebuild `@framepilot/ai-sdk` before consumer tests.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm verify`, `pnpm engine:test`, `pnpm engine:lint`, and `pnpm engine:typecheck`.
- [ ] Add desktop/e2e coverage for autonomous edit, visual evidence, cache restart reuse, cancellation/rollback, and `ask_user` answer summary.
- [ ] Add golden media/render checks for the exact baseline.
- [ ] Maintain 100% coverage on new deterministic time, cache-key, operation, validation, and mapping modules.
- [ ] Run `pnpm license:scan` before declaring done and request approval before any dependency change.
- [ ] Write superseding ADRs, user/developer guides, API docs, `CHANGELOG.md`, and migration notes.
- [ ] Format only touched files and rebuild generated mirrors/artifacts.
- [ ] Re-run the exact Phase 0 scenarios and publish before/after timelines, traces, preview frames, renders, and acceptance results.

**Definition of Done:** every required check is green, every baseline failure has proof of repair, and residual cost/accuracy/offline/migration risks are documented.

## 6. Approval gates

Stop and ask before:

- adding or upgrading a dependency;
- changing the timeline/project schema;
- broadening path sandbox, IPC, or agent permissions;
- weakening a destructive-operation guard;
- introducing a new external provider capability not proven by installed SDK/account behavior;
- deleting a working provider path before its migration is complete;
- any destructive or irreversible repository operation.

## 7. Final report requirements

The implementation branch eventually reports:

- root causes and the trace proving each;
- exact before/after baseline evidence;
- kept/merged/removed tool inventory and prompt-token impact;
- every conflict resolution and migration;
- what the removed caption-provider concept concretely was;
- time, facade, cache, orchestration, and sidebar architecture with trade-offs;
- every changed file;
- every command/check and result;
- failed, skipped, or unavailable work and the reason;
- residual cost, provider accuracy, offline, cache invalidation, and migration risks.
