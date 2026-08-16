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
  get_frame: {
    executionPlane: 'host',
    effectClass: 'pure_read',
    permissions: ['analysis'],
    concurrency: 'parallel',
    stateDependency: 'project_revision',
    cacheScope: 'project_revision',
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
