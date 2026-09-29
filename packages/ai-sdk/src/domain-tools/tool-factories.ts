/**
 * The shared spec builders every domain tool module is written against.
 *
 * These moved out of `tool-registry.ts` ahead of the domain split (P1.2) for one
 * reason: a family cannot own its tools while the only way to declare one lives
 * in the file it is moving out of. Extracting them first is what makes each
 * subsequent family a self-contained move rather than a circular import.
 *
 * The layering is one-directional and must stay that way — `tool-registry.ts`
 * imports from here and composes the public manifest; nothing here imports the
 * registry except as a *type*, which erases at runtime. `ToolSpec` and friends
 * still live in `tool-registry.ts` because that is the public surface consumers
 * already import.
 *
 * Each factory captures a tool's typed Zod schema and erases the generic behind
 * closures, so the registry stays a homogeneous list while every tool keeps
 * validating its own arguments.
 */
import { z } from 'zod/v4';
import type { Operation, ProjectOperation } from '@framepilot/editor-core';
import type { ToolContext } from '../tool-context.js';
import type { ToolParameterSchema, ToolSpec } from '../tool-registry.js';
import type { ToolCost, ToolLatency, ToolPermission } from '../tool-scope.js';

/**
 * Deliberately builders only, no argument primitives.
 *
 * `seconds`, `boolean`, and friends stay in `tool-registry.ts` beside the
 * string-coercion helpers they wrap: several models emit numbers as strings, and
 * a primitive separated from its `coerceNumericString` preprocessing looks
 * identical and silently stops accepting `"1.5"`. They move as their own step,
 * with their coercion, when the first family needs them.
 */
/** The empty argument object, shared by every tool that takes none. */
export const noArgs = z.object({}).strict();

export const jsonSchema = (schema: z.ZodType): ToolParameterSchema => {
  // `z.toJSONSchema` stamps a top-level `$schema` dialect URI (~14 tokens). The
  // parameters JSON is only ever advertised to a provider's tool interface (OpenAI/
  // Anthropic), which ignores `$schema`; arg VALIDATION runs off the Zod schema
  // directly, never this JSON. Since these descriptors are re-sent on EVERY agent turn,
  // that URI is pure per-turn token waste (~14 tok × 26 tools ≈ 360 tok/turn) with no
  // effect on behaviour — strip it.
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as ToolParameterSchema;
  return rest;
};

export interface ToolBase {
  readonly name: string;
  readonly description: string;
  /**
   * Optional scope-metadata refinements (K6.2), forwarded verbatim onto the
   * {@link ToolSpec} by every factory below (they spread `...base`). Declaring a
   * tool's `capabilities` lets scoped prompts target it by category (e.g.
   * `captions`, `reframe`) instead of the derived-by-kind default; the remaining
   * fields refine cost/latency/permission hints. Omit them to keep the kind
   * defaults.
   */
  readonly capabilities?: readonly string[];
  readonly version?: string;
  readonly permissions?: readonly ToolPermission[];
  readonly cost?: ToolCost;
  readonly latency?: ToolLatency;
  /** See {@link ToolSpec.serialOnly} — forwarded verbatim by the factories below. */
  readonly serialOnly?: boolean;
  readonly hostUiOnly?: boolean;
  /** See {@link ToolSpec.derivedFanOut} — forwarded verbatim by the factories below. */
  readonly derivedFanOut?: boolean;
}

/** Deep copy of plain JSON-shaped arguments, so a repair never touches what the model sent. */
function cloneArgs(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/** The value at `path` in `root`, or `undefined`. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

/** Replace the value at a non-empty `path` inside `root` (mutates `root`, a clone). */
function setAt(root: unknown, path: readonly PropertyKey[], value: unknown): void {
  const parent = valueAt(root, path.slice(0, -1));
  if (parent !== null && typeof parent === 'object') {
    (parent as Record<PropertyKey, unknown>)[path[path.length - 1]!] = value;
  }
}

/**
 * Arguments with every JSON-encoded string decoded where the schema wanted the object or array
 * that string spells, or `undefined` when the failure is anything else.
 *
 * WHY: a model sometimes sends a structured argument as its JSON text — harness run 18's
 * `reframe_pan { from: "{\"x\":0.56,\"y\":0.5}" }` was refused "from: expected object,
 * received string" and a turn was spent re-sending it. A string whose JSON is exactly the shape
 * the schema asks for means one thing. Decided from the schema's own type errors and the value's
 * type alone; the repaired arguments are validated again from scratch, so nothing the schema
 * would refuse gets through.
 */
function decodeJsonStringArgs(rawArgs: unknown, error: z.ZodError): unknown {
  if (error.issues.length === 0) return undefined;
  const repaired = cloneArgs(rawArgs);
  for (const issue of error.issues) {
    if (issue.code !== 'invalid_type' || issue.path.length === 0) return undefined;
    const expected = (issue as { expected?: unknown }).expected;
    if (expected !== 'object' && expected !== 'array') return undefined;
    const raw = valueAt(repaired, issue.path);
    if (typeof raw !== 'string') return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    const isArray = Array.isArray(decoded);
    const isObject = decoded !== null && typeof decoded === 'object' && !isArray;
    if ((expected === 'array' && !isArray) || (expected === 'object' && !isObject)) {
      return undefined;
    }
    setAt(repaired, issue.path, decoded);
  }
  return repaired;
}

/**
 * Validate a tool's arguments against its schema, accepting a structured argument sent as its
 * JSON text (see {@link decodeJsonStringArgs}). Any other failure throws the schema's own error,
 * unchanged, so the model reads exactly what it did before.
 *
 * @param schema - The tool's argument schema.
 * @param rawArgs - The arguments as the model sent them.
 * @returns The parsed arguments.
 */
export function parseToolArgs<S extends z.ZodType>(schema: S, rawArgs: unknown): z.infer<S> {
  const first = schema.safeParse(rawArgs);
  if (first.success) return first.data;
  const repaired = decodeJsonStringArgs(rawArgs, first.error);
  if (repaired !== undefined) {
    const second = schema.safeParse(repaired);
    if (second.success) return second.data;
  }
  throw first.error;
}

export function readTool<S extends z.ZodType>(
  base: ToolBase,
  schema: S,
  read: (args: z.infer<S>, ctx: ToolContext) => unknown,
): ToolSpec {
  return {
    ...base,
    mutates: false,
    available: true,
    kind: 'read',
    parameters: jsonSchema(schema),
    parse: (rawArgs) => parseToolArgs(schema, rawArgs),
    read: (rawArgs, ctx) => read(parseToolArgs(schema, rawArgs), ctx),
  };
}

export function mutateTool<S extends z.ZodType>(
  base: ToolBase,
  schema: S,
  buildOps: (args: z.infer<S>, ctx: ToolContext) => Operation[],
): ToolSpec {
  return {
    ...base,
    mutates: true,
    available: true,
    kind: 'mutate',
    parameters: jsonSchema(schema),
    parse: (rawArgs) => parseToolArgs(schema, rawArgs),
    buildOps: (rawArgs, ctx) => buildOps(parseToolArgs(schema, rawArgs), ctx),
  };
}

/**
 * A mutating tool that edits the **project bin** (assets/folders) rather than the
 * timeline. Identical in shape to {@link mutateTool} — it returns reversible
 * {@link ProjectOperation}s the orchestrator assembles into the same validated
 * patch pipeline — so it flows over MCP and through agent mode unchanged.
 */
export function projectMutateTool<S extends z.ZodType>(
  base: ToolBase,
  schema: S,
  buildOps: (args: z.infer<S>, ctx: ToolContext) => ProjectOperation[],
): ToolSpec {
  return {
    ...base,
    mutates: true,
    available: true,
    kind: 'mutate',
    parameters: jsonSchema(schema),
    parse: (rawArgs) => parseToolArgs(schema, rawArgs),
    buildOps: (rawArgs, ctx) => buildOps(parseToolArgs(schema, rawArgs), ctx),
  };
}

/** A side-effecting request the host performs (render/export). No patch. */
export function actionTool<S extends z.ZodType>(base: ToolBase, schema: S): ToolSpec {
  return {
    ...base,
    mutates: false,
    available: true,
    kind: 'action',
    parameters: jsonSchema(schema),
    parse: (rawArgs) => parseToolArgs(schema, rawArgs),
  };
}

/**
 * A question put to the human driving the run, which blocks the turn until they answer
 * (P12). Non-mutating and available — but unlike every other kind it is `hostUiOnly`:
 * only a surface with a real editor in front of it can resolve one.
 */
export function askTool<S extends z.ZodType>(base: ToolBase, schema: S): ToolSpec {
  return {
    ...base,
    mutates: false,
    available: true,
    kind: 'ask',
    hostUiOnly: true,
    parameters: jsonSchema(schema),
    parse: (rawArgs) => parseToolArgs(schema, rawArgs),
  };
}

/**
 * An ffmpeg-backed analysis the host executes against the media (silence/scene
 * detection). Non-mutating and available — the engine capability exists — but,
 * like an {@link actionTool}, it carries no in-process `read`/`buildOps`: the
 * render engine is Python-only (render-vs-preview rule), so the host/sidecar runs
 * it and returns the data. Args are still schema-validated here.
 */
export function analysisTool<S extends z.ZodType>(base: ToolBase, schema: S): ToolSpec {
  return {
    ...base,
    mutates: false,
    available: true,
    kind: 'analysis',
    parameters: jsonSchema(schema),
    parse: (rawArgs) => parseToolArgs(schema, rawArgs),
  };
}

/** A tool whose engine does not exist yet — registered but not invokable. */
export function unavailableTool(base: ToolBase, mutates: boolean): ToolSpec {
  return {
    ...base,
    mutates,
    available: false,
    kind: 'unavailable',
    parameters: jsonSchema(noArgs),
    parse: (rawArgs) => noArgs.parse(rawArgs),
  };
}
