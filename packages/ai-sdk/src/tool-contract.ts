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

/** The strongest cache scope a caller may safely use. */
export type ToolCacheScope = 'none' | 'run' | 'project_revision' | 'asset_content';

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

function cacheScopeFor(
  executionPlane: ToolExecutionPlane,
  effectClass: ToolEffectClass,
  scope: ToolEvidenceScope,
): ToolCacheScope {
  if (executionPlane !== 'host' || effectClass !== 'pure_read') return 'none';
  switch (scope) {
    case 'timeline_dependent':
      return 'project_revision';
    case 'asset_dependent':
    case 'transcript_dependent':
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
