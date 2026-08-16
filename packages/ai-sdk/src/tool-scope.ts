/**
 * @framepilot/ai-sdk/tool-scope — metadata and least-privilege prompt scoping.
 *
 * Only tools a turn can actually use are advertised. Internal lifecycle tools,
 * including automatic media indexing, remain invokable by explicit orchestrator
 * name but never appear in an ordinary model-selected capability scope.
 */
import {
  autonomousToolDescriptorsForStage,
  autonomousToolsForStage,
  type AutonomousToolStage,
} from './autonomous-tool-contract.js';
import { toolContract } from './tool-contract.js';
import { withToolInputContract } from './tool-input-contract.js';
import {
  type ToolKind,
  type ToolParameterSchema,
  type ToolSpec,
  TOOL_REGISTRY,
} from './tool-registry.js';

export type ToolPermission = 'read' | 'write' | 'render' | 'analysis';
export type ToolCost = 'low' | 'medium' | 'high';
export type ToolLatency = 'fast' | 'medium' | 'slow';

export interface ToolMetadata {
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly permissions: readonly ToolPermission[];
  readonly cost: ToolCost;
  readonly latency: ToolLatency;
}

const KIND_DEFAULTS: Record<ToolKind, Omit<ToolMetadata, 'version' | 'permissions'>> = {
  read: { capabilities: ['read'], cost: 'low', latency: 'fast' },
  mutate: { capabilities: ['edit'], cost: 'low', latency: 'fast' },
  action: { capabilities: ['render'], cost: 'high', latency: 'slow' },
  analysis: { capabilities: ['analysis'], cost: 'medium', latency: 'slow' },
  ask: { capabilities: ['ask'], cost: 'low', latency: 'slow' },
  unavailable: { capabilities: [], cost: 'low', latency: 'fast' },
};

/** Orchestrator-owned lifecycle tools that must never be model-selected. */
export const IMPLICIT_ONLY_TOOL_NAMES = ['index_media'] as const;

const implicitOnly = (name: string): boolean =>
  (IMPLICIT_ONLY_TOOL_NAMES as readonly string[]).includes(name);

function internalNamesForStage(stage: AutonomousToolStage): string[] {
  return [
    ...new Set(autonomousToolsForStage(stage).flatMap((tool) => tool.internalRoutes)),
    /* v8 ignore next -- the equal arm is unreachable: names are deduplicated by a Set */
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export const AUTONOMOUS_CORE_TOOL_NAMES: readonly string[] = [
  ...new Set([...internalNamesForStage('inspect'), ...internalNamesForStage('understand')]),
  /* v8 ignore next -- the equal arm is unreachable: names are deduplicated by a Set */
].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

export const AUTONOMOUS_VERIFY_TOOL_NAMES: readonly string[] = internalNamesForStage('verify');

export function toolMetadata(tool: ToolSpec): ToolMetadata {
  const defaults = KIND_DEFAULTS[tool.kind];
  return {
    version: tool.version ?? '1',
    capabilities: tool.capabilities ?? defaults.capabilities,
    permissions: toolContract(tool).permissions,
    cost: tool.cost ?? defaults.cost,
    latency: tool.latency ?? defaults.latency,
  };
}

export interface ToolScope {
  readonly permissions?: readonly ToolPermission[];
  readonly capabilities?: readonly string[];
  readonly names?: readonly string[];
  readonly includeUnavailable?: boolean;
}

function permitted(tool: ToolSpec, granted: readonly ToolPermission[]): boolean {
  const grantedSet = new Set(granted);
  return toolContract(tool).permissions.every((permission) => grantedSet.has(permission));
}

function capable(tool: ToolSpec, wanted: readonly string[]): boolean {
  const capabilities = new Set(toolMetadata(tool).capabilities);
  return wanted.some((capability) => capabilities.has(capability));
}

export function selectTools(
  scope: ToolScope,
  tools: readonly ToolSpec[] = TOOL_REGISTRY,
): ToolSpec[] {
  return tools.map(withToolInputContract).filter((tool) => {
    if (!tool.available && !scope.includeUnavailable) return false;
    if (scope.names) return scope.names.includes(tool.name);
    if (implicitOnly(tool.name)) return false;
    if (scope.permissions && !permitted(tool, scope.permissions)) return false;
    if (scope.capabilities && !capable(tool, scope.capabilities)) return false;
    return true;
  });
}

export const QUESTION_ROUTE_PERMISSIONS: readonly ToolPermission[] = ['read', 'analysis'];

export function selectAutonomousTools(
  stage: AutonomousToolStage,
  tools: readonly ToolSpec[] = TOOL_REGISTRY,
): ToolSpec[] {
  const names = new Set(internalNamesForStage(stage));
  return tools
    .map(withToolInputContract)
    .filter((tool) => tool.available && !implicitOnly(tool.name) && names.has(tool.name));
}

export interface ScopedToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
  readonly version: string;
}

function descriptors(tools: readonly ToolSpec[]): ScopedToolDescriptor[] {
  return tools
    .map(withToolInputContract)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      version: toolMetadata(tool).version,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function scopedToolDescriptors(
  scope: ToolScope,
  tools: readonly ToolSpec[] = TOOL_REGISTRY,
): ScopedToolDescriptor[] {
  return descriptors(selectTools(scope, tools));
}

export function autonomousToolDescriptors(stage: AutonomousToolStage): ScopedToolDescriptor[] {
  return autonomousToolDescriptorsForStage(stage).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as ToolParameterSchema,
    version: String(tool.version),
  }));
}
