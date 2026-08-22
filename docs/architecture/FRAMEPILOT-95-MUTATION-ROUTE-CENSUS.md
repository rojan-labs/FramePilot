# FramePilot 9.5 Mutation Route Census

**Status:** Live authority map (Phase 1 convergence applied)  
**Roadmap:** `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §5.4, §6  
**Scope:** current authorities only.

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
| Natural-language classification | `packages/ai-sdk/src/orchestrator.ts` plus durable start mode in `run-contracts.ts` | Three routes: `chitchat`, `question`, `edit`. Only `edit` mutates. | Minimal routing only. Reached. |
| Agent execution | `Orchestrator.streamAgent` / LangGraph agent path | Primary mutating agent route. Emits turn-scoped validated diffs. | Retain as the candidate single runtime. |
| ~~Planned edit execution~~ | *removed* | Retired in Phase 1 (ADR 0126) after the parity gate showed no unique capability, no model-call saving, and one unvalidated model → host argument path. | Done. |
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

### R3. Single-shot `edit` proposal (Cmd+K)

**Entry points:** `Orchestrator.streamEdit` via `streamEditorRun({ route: 'edit' })`, then host
settlement of the emitted `DiffEvent`.

| Semantic | Current behavior |
| --- | --- |
| Tool/schema validation | One model turn's tool calls are parsed at the same trust boundary the agent uses (`operationsForCall`). A malformed call is a warning, and a turn where EVERY call was rejected fails. |
| Deterministic validation | The assembled patch reaches editor-core validation before host commit. |
| Timeline invariants | Editor-core, unchanged. |
| Review | Not run: a single-shot proposal is reviewed by the human, not by a perceptual pass. |
| Cancellation | Abort during the model call settles `cancelled` with no diff. |
| Revision / persistence / undo | Host commit boundary, identical to R2. |

This is a **proposal surface**, not a second mutating runtime: it has no loop, no conductor,
no durable checkpointing, and no authority the agent does not also have. Its `variations`
option (browser-only) proposes N candidate patches for the human to pick between; only the
chosen one is ever committed. It remains a deliberate, tracked simplification target — see
`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6 follow-ups — and must not grow execution
machinery of its own.

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
| Single-shot edit | Yes | Host commit | Yes | Host-owned | Abort before assembly | N/A | Yes |
| Desktop Instant Apply | Yes, revalidated | Yes | Yes | Yes, idempotent decision | Durable cancel + abort | Yes | Grouped run |
| Browser/manual | Yes | Host adapter | Yes | Host-owned | Async shell only | N/A | Yes |
| Undo/redo | Existing typed inverse/patch | Current history cursor | Yes per patch/group step | Persisted history | Synchronous | N/A | Is the undo authority |

## Phase-1 deletion evidence this census enables

1. **Keep editor-core as the only project mutation authority.** The agent runtime is not
   allowed to mutate project state directly.
2. **Keep review read-only.** A convergence change that gives review a patch-writing path is
   a regression, even if output quality improves in a demo.
3. **`planned_edit` was compared at the same host-commit boundary and retired.** The parity
   record is `docs/architecture/FRAMEPILOT-95-ROUTE-PARITY-EVIDENCE.md`; the decision is
   ADR 0126.
4. **Do not create another persistence or history model.** Run durability and editor history
   already provide the authorities later convergence should reuse.
5. **Do not reintroduce a second mutating runtime.** If a request seems to need one, the
   answer is agent capability work — a tool, a skill, better evidence — per roadmap §19.

## Maintenance rule

Any PR that adds a new path capable of changing the authoritative `Project` must update this
census in the same PR. A route missing validation, revision, persistence, cancellation, review or
undo semantics must be treated as an architecture defect, not an undocumented special case.
