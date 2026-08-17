# FramePilot 9.5 Mutation Route Census

**Status:** Phase 0 evidence baseline  
**Roadmap:** `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §5.4  
**Scope:** current authorities only. This document does not approve architecture deletion.

## Why this exists

Phase 1 is allowed to converge mutating AI execution only after the current routes and their
safety semantics are explicit. This census records where decisions are made today and which
authority owns validation, revision checks, persistence, cancellation, review and undo.

The key invariant already shared by all successful mutation paths is the deterministic patch
boundary in `packages/editor-core/src/patch.ts`: a patch is typed, operation contracts are checked
at apply time, application is transactional over immutable project/timeline values, and inverse
patches back undo/redo. Review is deliberately read-only and is not a mutation authority.

## Authority map

| Concern | Current authority | Current state | Phase-1 target |
| --- | --- | --- | --- |
| Natural-language classification | `packages/ai-sdk/src/orchestrator.ts` plus durable start mode in `run-contracts.ts` | Several user-facing modes can select different execution paths. | Minimal routing only. |
| Agent execution | `Orchestrator.streamAgent` / LangGraph agent path | Primary mutating agent route. Emits turn-scoped validated diffs. | Retain as the candidate single runtime. |
| Planned edit execution | planner + `kernel/plan-driver.ts` + graph/effect runtime | Separate mutating execution universe. Transactionally folds a planned graph to an edit result. | Prove parity, then retain only if benchmark evidence earns it. |
| Project mutation | `@framepilot/editor-core` patch/project-patch functions plus host commit boundary | Canonical typed mutation authority. | One authority, retained. |
| Desktop AI commit | `apps/desktop/electron/ai/ai-stream.ts` and `patch-settlement.ts` | Host decides whether an emitted diff may commit, revalidates against current project/revision, and persists accepted work. | One host commit contract used by the converged runtime. |
| Durable run state | `packages/ai-sdk/src/run-contracts.ts` plus desktop durable-run controls/store | Schema-validated commands/events/snapshots and explicit terminal outcomes. | One durable run authority, retained. |
| Review | temporal/vision review event path (`review_finding`) | Reader only. Findings can steer a later agent turn but do not write the project. | Zero review writers. |
| Undo/redo | `packages/editor-core/src/history.ts` | Reversible patches. Consecutive durable-run entries sharing a `groupId` undo/redo as one user action. | Same project-history authority for all routes. |
| Final render | Python/FFmpeg engine | Deterministic final render authority. | One final-render authority. |
| Preview | editor preview implementation | Responsive UI implementation intended to match project semantics. | One semantic contract with export. |

## Mutating route census

### R1. Direct typed patch/project-patch application

**Entry points:** `applyPatch`, `applyProjectPatch`, `commitPatch`, `commitProjectPatch` in
`packages/editor-core/src/patch.ts` and `history.ts`.

| Semantic | Current behavior |
| --- | --- |
| Schema/operation validation | Patch callers normally run `validatePatch`; the canonical apply boundary additionally runs `assertOperationContract` for timeline operations. Project operations route through their project-operation contract. |
| Media validation | Operation/project validators receive current project assets/folders where required. Media/render claims remain outside this pure mutation boundary. |
| Timeline invariants | Enforced by operation contracts and immutable operation application. A failing operation throws `PatchError`; the caller's original project remains unchanged. |
| Ripple/lift semantics | Encoded in typed editor operations. The patch layer executes those semantics, it does not reinterpret them. |
| Review | None. Direct application is deterministic state mutation, not perceptual review. |
| Cancellation | None inside the pure synchronous patch apply. Cancellation must be decided before entering this atomic boundary or after it completes. |
| Revision | Project revision is part of the canonical project/timeline state. Host/durable routes perform expected-revision checks before calling the mutation authority. |
| Persistence | Not owned here. The host persists the returned project/history. |
| Undo | `invertPatch` / `invertProjectPatch` are captured by history before apply. |

### R2. Primary agent turn execution

**Entry points:** `Orchestrator.streamAgent`, current LangGraph agent path, tool dispatch/registry,
then host settlement of emitted `DiffEvent`s.

| Semantic | Current behavior |
| --- | --- |
| Tool/schema validation | Model-facing tools come from the registered/scoped tool surface. Tool arguments are parsed at the trust boundary before operations can be assembled. |
| Deterministic validation | Produced edits reach editor-core validation/operation contracts before host commit. A malformed/invalid call is not a mutation. |
| Timeline invariants | Final authority remains editor-core, not the model or graph state. |
| Ripple/lift semantics | Agent chooses a semantic editor tool/operation; deterministic editor-core implements the actual timeline semantics. |
| Review | Perceptual review runs after Instant Apply as a reader. `review_finding` events can inform a subsequent agent turn and never commit a patch themselves. |
| Cancellation | Run controls/AbortSignal stop model/tool work. Terminal status is `cancelled`; checkpoint/durable state can preserve already completed work for resume. No later work may be reported as successful after cancellation. |
| Revision | Each host commit is checked against current authoritative project revision. Stale work is rejected or explicitly rebased only by the host contract. |
| Persistence | Durable run events and accepted host project mutations are persisted by the host/run authority. |
| Undo | Turn diffs share a run id/group id. Project history keeps compact per-turn entries and presents the contiguous run as one Undo run action. |

### R3. Planned-edit execution

**Entry points:** planner -> compiled `TaskGraph` -> `packages/ai-sdk/src/kernel/plan-driver.ts` ->
shared graph/effect runtime -> folded `EditResult` -> host settlement.

| Semantic | Current behavior |
| --- | --- |
| Tool/schema validation | Model proposal calls are validated against the exact scoped tool registry. Hallucinated/malformed calls are rejected. |
| Deterministic validation | `plan-driver.ts` validates proposed operations against the current project and bounds proposal repair. |
| Timeline invariants | The whole planned graph settles before its folded patch is applied. Editor-core is still the mutation authority. |
| Ripple/lift semantics | Deterministic recipe/editor leaves and typed operations implement them. Planner structure does not replace editor semantics. |
| Review | Uses the shared verification/review leaves where planned. Review evidence does not become a second writer. |
| Cancellation | Graph/effect runtime propagates AbortSignal and keeps cancellation distinct from recoverable task failure. Cancellation is not routed around as success. |
| Revision | Host settlement remains authoritative for the current project revision. |
| Persistence | Durable run authority records the route and terminal result; committed project state is persisted by the host. |
| Undo | A successful committed planned edit is represented by reversible patch/history semantics like other host commits. |

### R4. Desktop host commit / Instant Apply settlement

**Entry points:** `apps/desktop/electron/ai/ai-stream.ts`,
`apps/desktop/electron/ai/patch-settlement.ts`, durable run controls.

| Semantic | Current behavior |
| --- | --- |
| Authorization | `patchPolicy === 'auto_commit'` authorizes an arriving AI diff to attempt commit. Perceptual verification is deliberately not a commit gate. |
| Validation | The commit path re-runs patch validation against the current project before writing. |
| Revision | Expected/current revision is checked at the host boundary. A stale delivery cannot overwrite newer project state silently. |
| Exactly once | Durable patch decisions/idempotency keys prevent replayed/retried delivery from committing the same patch twice. |
| Review | Review happens after mutation and reports findings. It cannot approve an otherwise invalid patch. |
| Cancellation | Stop/cancel is a durable command and AbortSignal boundary. Already committed atomic edits remain coherent; future work stops. |
| Persistence | Host writes authoritative project plus durable run/decision state. This is the desktop persistence authority for AI commits. |
| Undo | Commits are added to project history with the durable run grouping key so the editor can undo the whole run. |

### R5. Browser/manual editor mutation

**Entry points:** web-editor/manual edit commands -> shared typed patch/editor-core contracts ->
project history/persistence adapter.

| Semantic | Current behavior |
| --- | --- |
| Validation | Uses shared editor-core typed operations/contracts rather than an AI-only mutation format. |
| Revision | Browser durable-run/project adapters carry the canonical project revision and reject stale durable decisions. |
| Persistence | Browser persistence adapter owns durable write/reload for its host. |
| Review | Manual edits are not gated by AI perceptual review. |
| Cancellation | Synchronous editor patches are atomic; cancellation applies to surrounding async UI/media work, not half of a patch. |
| Undo | Same editor-core history/inverse authority. |

### R6. Undo, redo and history time travel

**Entry points:** `undoProject`, `redoProject`, `gotoProject` in
`packages/editor-core/src/history.ts`.

| Semantic | Current behavior |
| --- | --- |
| Validation/application | Undo and redo apply already-captured inverse/forward typed patches through the same project-patch authority. |
| Run grouping | Contiguous entries with the same `groupId` undo/redo as a single user action. History-panel time travel can still move entry-by-entry. |
| Persistence | Restart serialization collapses a run group once while preserving forward commit order and reverse inverse order. |
| Cancellation/review | Neither creates a special writer. Undo is a deterministic user action and review remains read-only. |

## Cross-route safety matrix

| Route | Typed/schema boundary | Current-revision guard | Atomic mutation | Durable result | Cancel semantics | Read-only review | Undo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Direct patch | Yes | Caller/host | Yes | Host-owned | Outside atomic apply | N/A | Yes |
| Primary agent | Yes | Host commit | Yes | Yes | Abort + terminal cancelled/checkpoint | Yes | Grouped run |
| Planned edit | Yes | Host commit | Yes after graph settles | Yes | Graph/effect abort | Yes | Yes |
| Desktop Instant Apply | Yes, revalidated | Yes | Yes | Yes, idempotent decision | Durable cancel + abort | Yes | Grouped run |
| Browser/manual | Yes | Host adapter | Yes | Host-owned | Async shell only | N/A | Yes |
| Undo/redo | Existing typed inverse/patch | Current history cursor | Yes per patch/group step | Persisted history | Synchronous | N/A | Is the undo authority |

## Phase-1 deletion evidence this census enables

1. **Keep editor-core as the only project mutation authority.** Neither agent runtime is
   allowed to mutate project state directly.
2. **Keep review read-only.** A convergence change that gives review a patch-writing path is
   a regression, even if output quality improves in a demo.
3. **Compare primary agent and `planned_edit` at the same host-commit boundary.** Differences
   in model/tool behavior can then be measured without changing validation, persistence or undo.
4. **Do not delete `planned_edit` in Phase 0.** Its separate planner/graph execution remains a
   measured hypothesis until the Phase-1 parity matrix is populated.
5. **Do not create another persistence or history model.** Run durability and editor history
   already provide the authorities later convergence should reuse.

## Maintenance rule

Any PR that adds a new path capable of changing the authoritative `Project` must update this
census in the same PR. A route missing validation, revision, persistence, cancellation, review or
undo semantics must be treated as an architecture defect, not an undocumented special case.
