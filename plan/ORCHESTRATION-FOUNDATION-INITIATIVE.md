# Orchestration Foundation Initiative

> **Status:** transcription recovery in progress; foundation implementation queued.
> **Date:** 2026-07-23
> **Architecture:** `docs/architecture/orchestration-execution-engine.md`
> **Decision:** proposed ADR 0073
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

## Objective

Consolidate FramePilot's orchestration and AI workspace into one durable,
production-grade execution engine. Preserve the validated reversible patch foundation
while eliminating split execution authority, browser/desktop policy drift, hidden live
state, and non-resumable workflow behavior.

This initiative supersedes the _remaining implementation work_ scattered across
`AGENT-ORCHESTRATION-RELIABILITY.md`, `AI-ORCHESTRATION-REDESIGN.md`,
`AGENT-NATIVE-COMPLETION-PLAN.md`, `ORCHESTRATOR-GAP-CLOSURE.md`, and
`ORCHESTRATION-EFFICIENCY-CC-PATTERNS.md`. Those documents remain historical design and
delivery records. Newly discovered orchestration work must be added here.

## Guardrails

- Preserve all five project invariants.
- No direct AI mutation of project JSON.
- No renderer-hosted orchestration in the desktop product after F1.
- No state reported in the workspace without a durable run event.
- No destructive schema replacement; use versioned additive contracts and migrations.
- No big-bang cutover: every foundation gate is independently shippable and reversible.
- Every path keeps `pnpm verify` green; core deterministic modules stay at 100% coverage.
- Any render behavior change requires render/golden validation.

## Success measures

### Correctness

- 100% command/event schema validation at every trust boundary.
- zero duplicate patch commits under retry, reconnect, StrictMode, or event replay.
- zero UI-visible approval/steering/context controls that are not consumed by the run.
- deterministic replay from recorded effect outcomes.
- explicit terminal outcome for every accepted run.

### Reliability

- renderer reload reconnects to an in-flight desktop run;
- process interruption resumes from the last durable boundary;
- project revision conflicts rebase, replan, or pause without losing prior work;
- sidecar/provider outage never fabricates success;
- every wait state has a cancellation and expiry path.

### Responsiveness

- first status event <100 ms locally;
- fast deterministic route adds <20 ms orchestration overhead excluding the edit itself;
- UI event projection remains within frame budget at 10,000+ persisted events;
- no full project clone across desktop IPC after F3;
- event transport has bounded buffering and backpressure.

### Scale

- long-project fixture: 4-hour timeline, 10k clips, 100k transcript words;
- hierarchical workflow fixture: 500+ tasks materialized in bounded windows;
- concurrent analysis obeys resource caps;
- event/run stores remain bounded through snapshots, paging, and retention.

## Foundation gates

### T0 — Restore real transcription end to end `[~]`

**Goal:** remove the placeholder empty-word path and make transcription a real,
provider-backed, reversible editing workflow before changing orchestration foundations.

- [x] Trace renderer, desktop, sidecar, ASR provider, tool, and transcript-store paths;
      confirm that the registered `transcribe` tool accepts already-fetched `words`,
      permits `[]`, and never invokes an ASR provider.
- [x] Add a typed desktop transcription command that resolves the selected media asset
      inside the project sandbox and invokes the configured local, Groq, or NVIDIA ASR
      provider without exposing credentials to the renderer.
- [x] Apply successful results only through the validated, reversible `set_transcript`
      timeline operation; reject unavailable and empty provider results without erasing an
      existing transcript.
- [x] Replace the AI tool's caller-supplied word payload with host-side transcription so
      the agent cannot fabricate or repeatedly commit `words: []`.
- [x] Add clear workspace progress, provider-unavailable, empty-audio, and success states,
      with an explicit asset selection when a project contains multiple media assets.
- [x] Update architecture/API/user documentation and the changelog.
- [x] Run focused existing type, lint, and functional checks for the touched path. Per the
      current functionality-first request, new automated coverage is deferred to the next
      round and must remain recorded as follow-up work.
- [ ] Next round: add dedicated desktop IPC/UI/agent/MCP transcription regressions and live
      local/Groq/NVIDIA media fixtures, then run the full verification matrix.

**Exit gate:** local and explicitly selected hosted ASR paths return real word timestamps,
the transcript survives save/undo, an empty provider response cannot clear it, and both
manual and agent entry points use the same host-owned execution path.

### F0 — Contract freeze and failing evidence `[~]`

**Goal:** lock the new boundaries and prove the existing P0 gaps before runtime changes.

- [~] Define Zod schemas and TypeScript types for `RunCommandEnvelope`,
  `RunEventEnvelope`, `RunSnapshot`, `RunStatus`, `RunOutcome`, `ProjectRevision`,
  and `PatchDecision`. Production schemas are implemented and type/lint checked;
  dedicated schema tests remain deferred to the next-round coverage task.
- [~] Add `schemaVersion`, `runId`, monotonic `sequence`, causation ids, and project
  revision to the protocol. Implemented in protocol v1; conformance/replay evidence
  remains open.
- [ ] Add cross-surface conformance tests for desktop, in-process browser adapter, and
      MCP adapter.
- [ ] Add failing regressions for desktop plan approval, steering, pinned context,
      renderer reconnect, persisted patch decisions, and duplicate auto-apply.
- [ ] Record current latency/event-rate/project-clone baselines.
- [x] Accept or amend ADR 0073.

**Exit gate:** contract reviewed; all current gaps reproduced; no production behavior
changed.

### F1 — Durable run service and full-duplex desktop controls `[~]`

**Goal:** establish one authoritative desktop run with reconnectable state.

- [x] Implement `RunStore` as append-only per-run WAL + atomic snapshots, with a
      version/migration registry and corruption quarantine.
- [x] Implement `RunCoordinator`/`RunGateway` start-subscribe-command APIs in Electron
      main.
- [x] Add typed IPC commands for approve/reject plan, answer, steer, cancel, resume,
      accept/reject patch, subscribe-from-cursor, and snapshot.
- [x] Replace live `PlanApprovalGate`/`SteeringQueue` across IPC with durable commands
      and wait effects; retain in-process adapters for tests.
- [x] Add heartbeat/inactivity leases, bounded client buffers, acknowledgements, and
      sender/project scoping.
- [x] Persist compatibility-stream `AiEvent`s before renderer publication and replay
      them from the run WAL; this is the prerequisite for truthful workspace recovery
      and the first strangler step toward the F2 Effect Runtime.
- [~] Restore a running workspace after renderer reload from snapshot + later events.
  Functionality is implemented and focused type/lint checks pass; dedicated reload
  coverage remains deferred to the requested test round.
- [~] Persist terminal outcomes and patch decisions. Terminal outcomes and accepted/
  rejected decisions are durable; dedicated recovery coverage remains deferred and
  revision-checked project commit integration remains in F3.

**Exit gate:** a desktop run can wait for approval, receive steering, survive renderer
reload, and show the same state before/after reconnect.

### F2 — One execution runtime `[~]`

**Goal:** eliminate hidden handler state and make every effect recordable/replayable.

- [~] Expand `EffectDescription` to model, host analysis, deterministic transform,
  patch validate/propose/commit, preview/render, verification, user wait, and
  persistence. Production vocabulary and scheduling/recovery metadata are implemented;
  dedicated contract coverage remains deferred.
- [~] Move model/tool/repair logic out of `orchestrator.ts` handler closures into effect
  handlers with typed inputs/outcomes. Model and host invocation now live behind
  typed runtime handlers for streaming and non-streaming agent APIs. Pure,
  side-effect-free tool-result interpretation remains in the orchestrator by design;
  all model, host, repair-model, and wait execution crosses the Effect Runtime.
- [~] Route ordinary `streamAgent` turns through the Effect Runtime. Streaming agent
  and question-route host tools now cross the shared runtime with the original
  run-scoped analysis budget, runtime-owned deduplication, durable observation, and
  abort propagation. Agent plan drafting and Critic repair completions now use that
  runtime too. Live agent model turns now use a streaming model effect that preserves
  incremental text/reasoning/tool calls while recording one requested/settled/failed
  lifecycle. Dedicated parity coverage remains deferred to the requested test round.
- [~] Record all effect requests/outcomes in the Run WAL; make idempotency and retry
  classification explicit. Runtime observers now durably record request/settled/
  failed events and project effect state. Plan approvals and model questions now
  execute as typed `user_wait` effects rather than hidden Promise waits. Dedicated
  record/replay coverage remains deferred to the requested test round.
- [~] Implement hierarchical cancellation and timeout policy per effect/resource.
  Per-effect timeouts, bounded retry classes, commit retry prohibition, parent/child
  cancellation, replay cancellation adapters, and abort-aware user waits are
  implemented; dedicated policy coverage remains deferred.
- [ ] Add record/replay parity for normal agent, cancel, question, approval, retry,
      repair, and failure scenarios.
- [~] Delete the duplicate `hostCache`/runtime cache implementations once parity passes.
  The orchestrator-local host cache and direct executor fallback are removed; the
  Effect Runtime is now the sole host deduplication/dispatch authority. Dedicated
  parity coverage remains in the next-round test task.

**Exit gate:** a recorded normal agent run replays with zero provider/host calls and
produces the identical domain-event/patch sequence.

### F3 — Revisioned project command service `[~]`

**Goal:** make project state and patch commits authoritative and conflict-aware.

- [~] Add monotonic project revision to the open-project service without changing
  original media or bypassing project schema validation. Desktop open, save, and
  external-change paths now share a per-project commit lane and monotonic revision;
  renderer autosave supplies the expected revision and rejects stale writes. Revision
  metadata is atomically checkpointed under Electron user data and restored before IPC
  registration; dedicated concurrency coverage remains deferred to the next test round.
- [~] Replace full-project AI IPC requests with `projectId` + expected revision +
  requested context handles. Saved desktop projects now send only identity and
  revision; Electron resolves and revision-checks the authoritative validated
  project before orchestration. Revision-zero unsaved projects retain a one-time
  bootstrap document until project registration/context-handle APIs land.
- [~] Implement revision-checked `validate/propose/commit` and one commit lane per
  project. The desktop exposes a typed patch-commit IPC command that validates and
  atomically applies through editor-core inside the existing per-project lane.
  Desktop review, subset apply, batch apply, and auto-apply now use that command;
  durable proposal/event integration remains.
- [~] Classify conflicts as disjoint/rebaseable, overlapping/replan, or authority
  required. The typed desktop result now reports `disjoint_rebaseable` for a clean
  stale rebase, `overlapping_replan` when newer edits invalidate the patch, and
  `authority_required` when the active project/run does not own the command.
- [~] Emit durable proposal, accepted/rejected/stale, committed, and rebased events.
  Diff publication records `run.patch_proposed`; project-command outcomes record
  explicit stale/committed/rebased events; review commands persist as
  `run.patch_accepted`/`run.patch_rejected`. The projector restores these decisions
  and committed project revisions from the WAL, including post-terminal review.
  Dedicated lifecycle coverage remains deferred to the next test round.
- [~] Move auto-apply from a React effect to an explicit pre-authorized run policy and
  commit effect. Protocol-v1 start/snapshot records `review` versus `auto_commit`;
  Electron commits proposed diffs through the revision lane before publication,
  persists lifecycle truth, groups undo by run, returns committed/stale state in the
  diff event, and pushes the authoritative project revision back to the workspace.
  The React auto-apply effect is now browser/dev-only. Dedicated policy coverage remains.
- [~] Group a run's accepted patches into deterministic undo history without
  double-application. Authoritative commits now use editor-core's project-scoped
  history path, persist inverse patches, and collapse consecutive patches sharing
  the durable run id into one undo entry; the renderer only installs the returned
  project and never applies the patch a second time. Dedicated coverage is deferred.

**Exit gate:** concurrent manual/MCP/AI edits never silently overwrite one another; the
workspace reports commit truth from the project service.

**Functional checkpoint (2026-07-23):** the F3 exit gate is implemented and the
desktop production bundles plus a real `pnpm --filter @framepilot/desktop dev` launch
completed without an immediate main/preload/renderer or sidecar startup failure. F3
remains `[~]` only because the user explicitly deferred new concurrency/lifecycle/
policy tests to the next round; project rules prohibit marking untested work `[x]`.

### F4 — Canonical task-graph execution `[ ]`

**Goal:** make the accepted kernel the normal path for complex work.

- [ ] Make fast recipes, direct edits, chat, and complex plans compile to a common
      versioned graph representation.
- [ ] Route novel desktop work through planner → graph → scheduler; retain the
      sequential loop only as a measured compatibility fallback.
- [ ] Support dynamic graph expansion and hierarchical segment plans.
- [ ] Connect task/effect events to the durable WAL and live `RunView`.
- [ ] Apply resource-class concurrency, priority, cost, and cancellation budgets.
- [ ] Integrate structured recovery decisions (retry/tier fallback/recipe fallback/
      route-around/rebase/replan/pause).
- [ ] Remove `planned-edit` as a browser-only mode and delete the duplicate path after
      parity.

**Exit gate:** desktop and browser produce contract-equivalent event/patch outcomes for
the same fixtures; planner/DAG is no longer dark architecture.

### F5 — AI workspace as a pure run projection `[ ]`

**Goal:** remove orchestration truth from React state.

- [ ] Introduce a schema-validated `RunView` projector from snapshot + domain events.
- [ ] Split `AiSidebar.tsx` into workspace shell, run subscription controller,
      composer, task/plan view, activity stream, review queue, and history projection.
- [ ] Persist only ephemeral UI state locally (draft, scroll, expansion).
- [ ] Derive decisions, pending gates, retry/resume capability, apply status, and
      terminal outcome from `RunView`.
- [ ] Add connection/reconnecting/stale projection states and cursor diagnostics.
- [ ] Make plan progress evidence-based on task/effect/commit completion.
- [ ] Add accessibility and visual-regression coverage for every lifecycle/wait/failure
      state.

**Exit gate:** reload, reconnect, replay, and a second observer produce the same
workspace state with no private decision reconstruction.

### F6 — Context, memory, and long-project scale `[ ]`

**Goal:** scale capability without scaling full-document transfer or prompt size.

- [ ] Replace full project copies with revisioned project/index slice handles.
- [ ] Make selection, pins, transcript ranges, semantic results, memory, and prior
      applied-edit digests typed context sources with provenance.
- [ ] Add hierarchical retrieval for acts/chapters/scenes/shots and raw footage.
- [ ] Persist context manifests/digests per decision effect for reproducibility without
      storing secrets or unnecessary media.
- [ ] Page/segment conversation projections and run events; wire existing compaction
      into snapshots without deleting audit history.
- [ ] Add retention/archive policy and storage quotas.
- [ ] Prove prompt, memory, and IPC payload sizes scale with the active slice rather
      than project duration.

**Exit gate:** the 4-hour/10k-clip fixture stays within budgets and produces the same
quality gates as a small project.

### F7 — Quality, recovery, and production operations `[ ]`

**Goal:** make professional output quality and graceful recovery first-class.

- [ ] Define per-workflow acceptance policies: deterministic validation, preview,
      render validation, Critic checks, and approval threshold.
- [ ] Add a typed failure taxonomy and recovery matrix with bounded attempts.
- [ ] Add fault-injection tests: provider disconnect, malformed proposal, sidecar crash,
      render timeout, storage failure, revision conflict, renderer reload, app restart.
- [ ] Add run diagnostics: task/effect latency, retries, cache hits, context trims,
      tokens/cost, queue delay, patch/rebase outcomes, terminal reason.
- [ ] Add privacy/redaction/leak tests for logs, events, prompts, paths, and provider
      fallback.
- [ ] Add SLO dashboards/exportable support bundle and run-inspector tooling.
- [ ] Run security, performance, accessibility, and release-readiness reviews.

**Exit gate:** deterministic eval and chaos matrices pass in CI; no known P0/P1 finding
from the architecture review remains.

### F8 — Consolidation and deletion `[ ]`

**Goal:** finish the strangler migration and make the new architecture maintainable.

- [ ] Delete renderer-local desktop orchestrator/recipe execution.
- [ ] Delete browser-only planned-edit routing and redundant agent loop caches/policies.
- [ ] Reduce `orchestrator.ts` to application/facade composition; move no policy back
      into it.
- [ ] Version/migrate existing conversation records into projections over archived
      legacy events.
- [ ] Mark superseded plans/ADR clauses clearly and update `docs/architecture/ai-engine.md`.
- [ ] Update API docs, runbooks, CHANGELOG, release checklist, and plan status.
- [ ] Run full `pnpm verify`, coverage, e2e, visual, desktop packaging, engine checks,
      license scan, and render fixture validation.

**Exit gate:** one canonical code path, one canonical architecture document, and one
canonical execution plan.

## Delivery slicing

Each gate should ship in small PRs:

1. contracts/tests;
2. storage/projection core;
3. one vertical desktop control;
4. reconnect/replay;
5. compatibility adapter;
6. cutover;
7. deletion and docs.

Do not combine protocol, storage, UI, and cutover in one unreviewable change.

## Immediate first slice

The safest first implementation unit is F0 plus the smallest F1 vertical:

1. add versioned `RunCommand`/`RunEvent` schemas;
2. carry `sequence`, `runId`, `projectId`, and revision through desktop streaming;
3. implement durable `steer` and `approve_plan` commands;
4. remove the auto-approval fallback from the desktop product path;
5. add renderer-reload snapshot/replay for a run paused at approval;
6. keep the existing orchestrator behind the new gateway as a compatibility effect.

This closes the most dangerous UI/execution mismatch without yet rewriting creative
logic.
