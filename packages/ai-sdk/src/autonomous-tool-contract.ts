/**
 * Canonical autonomous model-facing tool contract.
 *
 * The full TOOL_REGISTRY remains the internal operation-builder catalog. This
 * manifest is the smaller public surface shared by the autonomous orchestrator,
 * MCP projection, UI metadata, and the generated Python mirror.
 */
import rawManifest from './autonomous-tools.manifest.json' with { type: 'json' };

export type AutonomousToolStage =
  | 'inspect'
  | 'understand'
  | 'edit'
  | 'verify'
  | 'render'
  | 'recover';

export type AutonomousToolStatus = 'ready' | 'planned';
export type AutonomousToolKind = 'registry' | 'composite' | 'proposal' | 'runtime';

export interface AutonomousToolContract {
  readonly name: string;
  readonly description: string;
  readonly stages: readonly AutonomousToolStage[];
  readonly status: AutonomousToolStatus;
  readonly kind: AutonomousToolKind;
  readonly internalRoutes: readonly string[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface AutonomousToolManifest {
  readonly version: number;
  readonly tools: readonly AutonomousToolContract[];
}

export interface AutonomousToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly kind: AutonomousToolKind;
}

const STAGES = new Set<AutonomousToolStage>([
  'inspect',
  'understand',
  'edit',
  'verify',
  'render',
  'recover',
]);
const STATUSES = new Set<AutonomousToolStatus>(['ready', 'planned']);
const KINDS = new Set<AutonomousToolKind>(['registry', 'composite', 'proposal', 'runtime']);

export function assertManifest(value: AutonomousToolManifest): void {
  if (!Number.isInteger(value.version) || value.version <= 0) {
    throw new Error('Autonomous tool manifest version must be a positive integer.');
  }
  const names = new Set<string>();
  for (const tool of value.tools) {
    if (!tool.name || names.has(tool.name)) {
      throw new Error(`Duplicate or empty autonomous tool name "${tool.name}".`);
    }
    names.add(tool.name);
    if (!tool.description.trim()) {
      throw new Error(`Autonomous tool "${tool.name}" needs a description.`);
    }
    if (tool.stages.length === 0 || tool.stages.some((stage) => !STAGES.has(stage))) {
      throw new Error(`Autonomous tool "${tool.name}" has an invalid stage.`);
    }
    if (!STATUSES.has(tool.status)) {
      throw new Error(`Autonomous tool "${tool.name}" has an invalid status.`);
    }
    if (!KINDS.has(tool.kind)) {
      throw new Error(`Autonomous tool "${tool.name}" has an invalid kind.`);
    }
    if (tool.status === 'ready' && tool.kind !== 'proposal' && tool.internalRoutes.length === 0) {
      throw new Error(`Ready autonomous tool "${tool.name}" needs an execution route.`);
    }
    if (tool.internalRoutes.includes('index_media')) {
      throw new Error('index_media is implicit lifecycle work and cannot be model-facing.');
    }
    if (
      typeof tool.inputSchema !== 'object' ||
      tool.inputSchema === null ||
      Array.isArray(tool.inputSchema)
    ) {
      throw new Error(`Autonomous tool "${tool.name}" needs an object input schema.`);
    }
  }
}

interface JsonSchema {
  readonly type?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly additionalProperties?: unknown;
  readonly enum?: unknown;
  readonly minLength?: unknown;
  readonly maxLength?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly exclusiveMinimum?: unknown;
  readonly minItems?: unknown;
  readonly maxItems?: unknown;
  readonly items?: unknown;
  readonly prefixItems?: unknown;
}

const schemaRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

function validateSchema(value: unknown, schema: JsonSchema, path: string): string | undefined {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return `${path} must be one of ${schema.enum.map(String).join(', ')}.`;
  }

  if (schema.type === 'object') {
    const object = schemaRecord(value);
    if (!object) return `${path} must be an object.`;
    const properties = schemaRecord(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [];
    for (const key of required) {
      if (!(key in object)) return `${path}.${key} is required.`;
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(object).find((key) => !(key in properties));
      if (unknown !== undefined) return `${path}.${unknown} is not allowed.`;
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = schemaRecord(properties[key]);
      if (!childSchema) continue;
      const issue = validateSchema(child, childSchema, `${path}.${key}`);
      if (issue) return issue;
    }
    return undefined;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${path} must contain at least ${schema.minItems} item(s).`;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${path} must contain at most ${schema.maxItems} item(s).`;
    }
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : undefined;
    if (prefix) {
      for (let index = 0; index < Math.min(prefix.length, value.length); index += 1) {
        const childSchema = schemaRecord(prefix[index]);
        /* v8 ignore next -- every prefixItems entry in the manifest is a schema object. */
        if (!childSchema) continue;
        const issue = validateSchema(value[index], childSchema, `${path}[${index}]`);
        if (issue) return issue;
      }
    } else {
      const itemSchema = schemaRecord(schema.items);
      if (itemSchema) {
        for (let index = 0; index < value.length; index += 1) {
          const issue = validateSchema(value[index], itemSchema, `${path}[${index}]`);
          if (issue) return issue;
        }
      }
    }
    return undefined;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string.`;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return `${path} must contain at least ${schema.minLength} character(s).`;
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return `${path} must contain at most ${schema.maxLength} character(s).`;
    }
    return undefined;
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be finite.`;
    if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer.`;
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${path} must be >= ${schema.minimum}.`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${path} must be <= ${schema.maximum}.`;
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return `${path} must be > ${schema.exclusiveMinimum}.`;
    }
    return undefined;
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} must be a boolean.`;
  return undefined;
}

export function assertAutonomousToolInput(
  tool: AutonomousToolContract,
  input: Readonly<Record<string, unknown>>,
): void {
  const issue = validateSchema(input, tool.inputSchema as JsonSchema, tool.name);
  if (issue) throw new Error(issue);
}

export const AUTONOMOUS_TOOL_MANIFEST = rawManifest as AutonomousToolManifest;
assertManifest(AUTONOMOUS_TOOL_MANIFEST);

export const AUTONOMOUS_TOOL_NAMES: readonly string[] = AUTONOMOUS_TOOL_MANIFEST.tools
  .map((tool) => tool.name)
  /* v8 ignore next -- the equal arm is unreachable: the sort keys are unique */
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

export function getAutonomousTool(name: string): AutonomousToolContract | undefined {
  return AUTONOMOUS_TOOL_MANIFEST.tools.find((tool) => tool.name === name);
}

export function autonomousToolsForStage(
  stage: AutonomousToolStage,
  options: { readonly includePlanned?: boolean } = {},
): AutonomousToolContract[] {
  return (
    AUTONOMOUS_TOOL_MANIFEST.tools
      .filter(
        (tool) =>
          tool.stages.includes(stage) &&
          (tool.status === 'ready' || options.includePlanned === true),
      )
      /* v8 ignore next -- the equal arm is unreachable: the sort keys are unique */
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  );
}

export function autonomousToolDescriptorsForStage(
  stage: AutonomousToolStage,
  options: { readonly includePlanned?: boolean } = {},
): AutonomousToolDescriptor[] {
  return autonomousToolsForStage(stage, options).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    version: AUTONOMOUS_TOOL_MANIFEST.version,
    kind: tool.kind,
  }));
}

export function internalRoutesForAutonomousTool(name: string): readonly string[] {
  return getAutonomousTool(name)?.internalRoutes ?? [];
}
