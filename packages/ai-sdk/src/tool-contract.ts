import type { ToolPermission } from './tool-scope.js';
import { classifyTool, type ToolEvidenceScope } from './tool-classification.js';
import { getTool, type ToolKind, type ToolSpec } from './tool-registry.js';

/** Where a tool actually executes. */
export type ToolExecutionPlane = 'in_process' | 'host' | 'human';

/** What observable state a tool can change. */
export type ToolEffectClass = 'pure_read' | 'mutation' | 'action';

/** Whether calls may overlap another tool in the same turn. */
export type ToolConcurrency = 'parallel' | 'serial';

/** Which state must be included when deciding whether a result is still valid. */
export type ToolStateDependency = 'none' | 'project_revision' | 'asset_content';

/**
 * The strongest cache scope a caller may safely use.
 *
 * There is deliberately no `project_revision` member, and its absence is the fix for a
 * bug this repo shipped three times (`get_frame`, `measure_color`, `search_media`). A
 * revision-keyed memo reads as the careful option and is not one: `Timeline.revision`
 * advances only when clip TIMING moves (`editor-core/operations.ts#mappingChanged`), so it
 * stands still through colour grades, effects, masks, keyframes, and through every
 * project-level bin operation — and every host read that was keyed on it was therefore
 * served a pre-edit answer on the exact call it made to check its own work. A tool whose
 * answer depends on the arrangement is now uncacheable BY DERIVATION rather than by each
 * author remembering to write `none`.
 */
export type ToolCacheScope = 'none' | 'run' | 'asset_content';

export interface ToolContract {
  readonly executionPlane: ToolExecutionPlane;
  readonly effectClass: ToolEffectClass;
  readonly permissions: readonly ToolPermission[];
  readonly concurrency: ToolConcurrency;
  readonly stateDependency: ToolStateDependency;
  readonly cacheScope: ToolCacheScope;
}

const DEFAULT_PERMISSIONS: Record<ToolKind, readonly ToolPermission[]> = {
  read: ['read'],
  mutate: ['read', 'write'],
  action: ['render'],
  analysis: ['analysis'],
  ask: ['read'],
  unavailable: ['read'],
};

/**
 * Explicit contracts for tools whose real effects differ from their legacy kind.
 * State-dependency/cache metadata for ordinary reads is derived below from the same
 * classification table used by EvidenceStore, so two subsystems cannot disagree about
 * whether a result becomes stale after a timeline edit.
 */
export const TOOL_CONTRACT_DECLARATIONS: Readonly<Record<string, ToolContract>> = {
  transcribe: {
    executionPlane: 'host',
    effectClass: 'mutation',
    permissions: ['analysis', 'write'],
    concurrency: 'serial',
    stateDependency: 'asset_content',
    cacheScope: 'none',
  },
  index_media: {
    executionPlane: 'host',
    effectClass: 'mutation',
    permissions: ['analysis', 'write'],
    concurrency: 'serial',
    stateDependency: 'asset_content',
    cacheScope: 'none',
  },
  detect_subjects: {
    executionPlane: 'host',
    effectClass: 'pure_read',
    permissions: ['analysis'],
    concurrency: 'serial',
    stateDependency: 'asset_content',
    // A measurement of media bytes — never serve one run's detections as
    // another's answer.
    cacheScope: 'none',
  },
  track_subject_automatically: {
    // A measurement, not a memo: the worker runs against media bytes for
    // minutes at a time and its output is applied against the live timeline,
    // so a cached replay could re-apply stale samples as if they were fresh.
    executionPlane: 'host',
    effectClass: 'mutation',
    permissions: ['analysis', 'write'],
    concurrency: 'serial',
    stateDependency: 'asset_content',
    cacheScope: 'none',
  },
  // `add_music`/`add_stock` are sourcing tools whose NAMES read as analysis and whose
  // registry kind IS `analysis` — they are reached through `search_music`/`search_stock`
  // — but each one downloads a third-party file into the project and places a clip via a
  // reversible patch. Without these rows they fell to the `analysis` kind default and
  // landed on a contract identical to `get_frame`: a pure read, cacheable within a
  // revision, safe to run in parallel, and needing no `write` permission. That last one
  // is what made it visible — `QUESTION_ROUTE_PERMISSIONS` is `['read','analysis']`, so
  // the question route advertised both to the model while correctly withholding
  // `trim_clip` and `export_video`, and a turn that cannot apply ops could still fetch
  // media and place it. `cacheScope: 'none'` for the same reason
  // `track_subject_automatically` declares it: replaying a memoized placement would
  // re-apply a stale edit as if it were fresh.
  add_music: {
    executionPlane: 'host',
    effectClass: 'mutation',
    permissions: ['analysis', 'write'],
    concurrency: 'serial',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
  // `remove_silences` measures via the sidecar and then CUTS (plan/system-mission P4.1):
  // a host-planed mutation with the same contract as `add_music` — serial, revision-bound,
  // never replayed from a memo (the timeline it cut may have moved since).
  remove_silences: {
    executionPlane: 'host',
    effectClass: 'mutation',
    permissions: ['analysis', 'write'],
    concurrency: 'serial',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
  add_stock: {
    executionPlane: 'host',
    effectClass: 'mutation',
    permissions: ['analysis', 'write'],
    concurrency: 'serial',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
  // `get_frame` and `measure_color` are PICTURE measurements, and `Timeline.revision` is
  // not a picture counter.
  //
  // `applyOperation` (editor-core/operations.ts) bumps the revision only when
  // `mappingChanged` — i.e. only when clip TIMING moves — because its job is to tell
  // mapping-derived state (captions above all, ADR 0076) that it needs remapping. A colour
  // grade, an effect, an opacity/scale keyframe, a `punch_in`, a mask: every one of them
  // rewrites the picture and leaves the revision exactly where it was.
  //
  // So a `project_revision` cacheScope keyed a picture memo on a mapping counter. The
  // effect runtime's memo (`kernel/effect-runtime.ts#idempotencyKeyFor`) hit on the
  // unchanged revision, `runAgentCall` read that hit as proof of freshness and re-attached
  // the STORED image as the current frame, and the model reasoned about the pre-grade
  // picture — on the exact call it had made to verify the grade. `measure_color` is the
  // same defect with the same trigger: apply a grade, re-measure, get the old numbers.
  //
  // Not fixed by threading a run-scoped edit counter instead. The obvious candidate,
  // `cumulativeOps.length`, is not monotonic — `reconcileHostVerdicts` splices it when the
  // host refuses a patch, so one key value can denote two different timelines inside one
  // run — and a correct counter would still be a SECOND cache running beside the
  // EvidenceStore on its own staleness rules, which is the structure that produced this
  // bug. The EvidenceStore already splits picture from structure and drops the picture
  // facet on any picture-changing op; one authority is the fix.
  //
  // The cost is a re-render (~1.2s) when a run asks for the identical frame twice with no
  // edit between. That is the correct thing to pay: the image is the one part of the answer
  // that must be current.
  get_frame: {
    executionPlane: 'host',
    effectClass: 'pure_read',
    permissions: ['analysis'],
    concurrency: 'parallel',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
  measure_color: {
    executionPlane: 'host',
    effectClass: 'pure_read',
    permissions: ['analysis'],
    concurrency: 'parallel',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
  // `search_media` is the same defect as `get_frame` above, arrived at from the other
  // side: it reads the BIN, and `Timeline.revision` is not a bin counter either.
  //
  // Its answer depends on two things the revision cannot see. The hits come from the
  // sidecar brain index over the project's ASSETS (`/brain/search`), which `add_asset`,
  // `manage_assets` and `index_media` change — none of them a timeline operation, so
  // `applyOperation`'s `mappingChanged` bump never fires for any of them (project
  // operations do not go through it at all). The derived `project_revision` cacheScope
  // therefore memoized a bin read under a mapping counter: a run that imported a file and
  // then searched for it was served the pre-import answer and concluded the asset was not
  // there. `unwrapSearch` then enriches each asset hit with its live clip placements, so
  // the SAME payload also ages with the arrangement.
  //
  // `asset_content` is not the fix, and this is the trap worth naming: the effect
  // runtime's `asset_content` branch (`kernel/effect-runtime.ts#idempotencyKeyFor`) keys
  // on name + arguments ALONE — there is no asset identity in the key. It is a per-run
  // memo whose name promises content-addressing it does not do. That is sound for the
  // revision-independent media analyses that use it (media bytes cannot change mid-run;
  // FramePilot never mutates originals), and wrong for a query over a bin the run itself
  // edits. `EvidenceStore` models the real rule — `asset_dependent` evidence is dropped on
  // any bin operation (`evidence-store.ts#ASSET_OPERATIONS`) — and it is the one authority
  // that should own staleness. Adding a second, bin-keyed cache here to compete with it is
  // how the `get_frame` bug was built.
  //
  // So: no memo. The cost is a re-query (a local index lookup, not a decode) when a run
  // asks the same question twice with no import between.
  //
  // Kept as an explicit row even though {@link cacheScopeFor} now derives `none` for it:
  // that derivation follows the tool's evidence scope, and `search_media`'s scope is
  // `timeline_dependent` for the placements rather than for the bin. Reclassify it to sit
  // with its `revision_independent` sidecar siblings and the memo comes back silently.
  search_media: {
    executionPlane: 'host',
    effectClass: 'pure_read',
    permissions: ['analysis'],
    concurrency: 'parallel',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
  render_preview: {
    executionPlane: 'host',
    effectClass: 'action',
    permissions: ['render'],
    concurrency: 'serial',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
  export_video: {
    executionPlane: 'host',
    effectClass: 'action',
    permissions: ['render'],
    concurrency: 'serial',
    stateDependency: 'project_revision',
    cacheScope: 'none',
  },
};

function executionPlaneFor(kind: ToolKind): ToolExecutionPlane {
  if (kind === 'ask') return 'human';
  if (kind === 'analysis' || kind === 'action') return 'host';
  return 'in_process';
}

function stateDependencyFor(scope: ToolEvidenceScope): ToolStateDependency {
  switch (scope) {
    case 'timeline_dependent':
      return 'project_revision';
    case 'asset_dependent':
    case 'transcript_dependent':
      return 'asset_content';
    case 'revision_independent':
      return 'none';
  }
}

/**
 * The strongest memo a tool's own nature permits — the safe DEFAULT, which is the level
 * this decision has to be made at.
 *
 * Only `revision_independent` is memoizable, and the three exclusions are the three ways a
 * run changes the thing underneath its own question:
 *
 *  - `timeline_dependent` — the arrangement moves constantly, and the only identity the
 *    runtime could key on is `Timeline.revision`, a mapping counter rather than a
 *    description of what the tool would see (see {@link ToolCacheScope}).
 *  - `asset_dependent` — the BIN is not the timeline. `add_asset`, `manage_assets` and the
 *    sourcing downloads all change what a bin read would return and none of them touches
 *    the revision; there is no bin identity in the runtime's key either, so a memo here
 *    would answer "is that file in the project?" with the state before the import.
 *  - `transcript_dependent` — `transcribe` rewrites the words mid-run.
 *
 * What remains is source material, and FramePilot never mutates originals (invariant 1),
 * so its answer cannot change inside one run. The runtime memoizes it per run keyed on
 * name + arguments, which is what stops a metered provider catalogue being re-queried for
 * a question already asked.
 *
 * The default is deliberately the safe one: a new host read is uncacheable unless its
 * classification says it describes something no edit can reach.
 */
function cacheScopeFor(
  executionPlane: ToolExecutionPlane,
  effectClass: ToolEffectClass,
  scope: ToolEvidenceScope,
): ToolCacheScope {
  if (executionPlane !== 'host' || effectClass !== 'pure_read') return 'none';
  switch (scope) {
    case 'timeline_dependent':
    case 'asset_dependent':
    case 'transcript_dependent':
      return 'none';
    case 'revision_independent':
      return 'asset_content';
  }
}

/** Resolve the complete execution contract for one registered tool. */
export function toolContract(tool: ToolSpec): ToolContract {
  const declared = TOOL_CONTRACT_DECLARATIONS[tool.name];
  if (declared) return declared;

  const executionPlane = executionPlaneFor(tool.kind);
  const effectClass: ToolEffectClass = tool.mutates
    ? 'mutation'
    : tool.kind === 'action'
      ? 'action'
      : 'pure_read';
  const concurrency: ToolConcurrency =
    tool.serialOnly === true || effectClass !== 'pure_read' ? 'serial' : 'parallel';
  const classification = classifyTool(tool.name, tool.kind, tool.mutates);
  const stateDependency = stateDependencyFor(classification.scope);
  const cacheScope = cacheScopeFor(executionPlane, effectClass, classification.scope);

  return {
    executionPlane,
    effectClass,
    permissions: tool.permissions ?? DEFAULT_PERMISSIONS[tool.kind],
    concurrency,
    stateDependency,
    cacheScope,
  };
}

/** Name-only adapter used by the generic batching helper. */
export function toolRequiresSerialExecution(name: string): boolean {
  const tool = getTool(name);
  return tool !== undefined && toolContract(tool).concurrency === 'serial';
}
