/**
 * @framepilot/ai-sdk/tool-dispatch — the tool boundary: ToolCall → operations
 * (plan/AGENT-NATIVE-COMPLETION-PLAN.md P3.2).
 *
 * Extracted from `orchestrator.ts` so every model-authored mutation shares the
 * exact same registered and contracted operation boundary.
 */
import { createLogger } from '@framepilot/shared-types';
import type { AnyOperation } from '@framepilot/editor-core';
import type { ToolCall } from './providers/types.js';
import { withToolInputContract } from './tool-input-contract.js';
import { type ToolSpec, getTool } from './tool-registry.js';
import type { ToolContext } from './tool-context.js';

const log = createLogger('ai-sdk:tool-dispatch');

interface ArgIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  /** Zod issue code — `invalid_type` is the one we can phrase plainly. */
  readonly code?: string;
  /** For `invalid_type`: the type the schema wanted (`"string"`, `"number"`, …). */
  readonly expected?: string;
  /**
   * For `invalid_type`: what arrived. Zod 3 sets `"undefined"` when the field was simply
   * absent; Zod 4 drops the field and says it in `message` instead — {@link isMissingField}
   * reads both, because the two shapes coexist across the schemas this dispatcher parses.
   */
  readonly received?: string;
}

/**
 * Argument names that are always a time on the timeline, so the editor summary can
 * say "in seconds" instead of leaving a bare "number" for a human to guess at.
 * Deliberately an exact-name allowlist: `speed` and `count` are numbers too, and
 * calling them seconds would be a lie.
 */
const SECONDS_FIELDS = new Set(['start', 'end', 'startTime', 'endTime', 'duration', 'at']);

/** Words that mean the raw schema text is machine-speak, not something an editor can act on. */
const MACHINE_SPEAK = /\breceived\b|\bundefined\b/;

/**
 * True when the argument was absent rather than wrong. Zod 3 reports
 * `received: "undefined"` with the message `"Required"`; Zod 4 reports no `received`
 * and the message `"Invalid input: expected string, received undefined"`.
 */
function isMissingField(issue: ArgIssue): boolean {
  if (issue.received === 'undefined') return true;
  return issue.received === undefined && / received undefined\b/.test(issue.message);
}

function issueField(issue: ArgIssue): string {
  return issue.path.join('.');
}

/** "a" · "a and b" · "a, b and c" — a list a human reads, not a JSON array. */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "numbers (in seconds)" when every field named is a timeline time, else "numbers". */
function typePhrase(expected: string, fields: readonly string[]): string {
  const plural = `${expected}s`;
  const allSeconds = fields.length > 0 && fields.every((f) => SECONDS_FIELDS.has(f));
  return expected === 'number' && allSeconds ? `${plural} (in seconds)` : plural;
}

/**
 * Say what was wrong with a tool call in the editor's words.
 *
 * WHY: the raw Zod text — `trackId: Required; start: Expected number, received string`
 * — reached the AI panel's failure card verbatim, where "received undefined" is both
 * meaningless to a video editor and a leak the golden harness grades as unexplained
 * (see `eval/golden-metrics.ts` INTERNAL_LEAK). The model still gets the raw text,
 * which it can act on; the human gets this.
 *
 * Pure: same issues in, same sentence out.
 *
 * @param toolName - The tool the model called, quoted back so the editor knows which.
 * @param cause - The thrown validation error (a ZodError, or anything else).
 * @returns One sentence naming the tool and the arguments that were wrong.
 */
export function describeArgValidationForEditor(toolName: string, cause: unknown): string {
  const issues = argIssues(cause);
  if (issues.length === 0) {
    return `"${toolName}" was called with arguments FramePilot could not read.`;
  }

  const missing: string[] = [];
  const wrongType = new Map<string, string[]>();
  const other: string[] = [];

  for (const issue of issues) {
    const field = issueField(issue);
    if (issue.code === 'invalid_type' && field !== '') {
      if (isMissingField(issue)) {
        missing.push(field);
        continue;
      }
      if (issue.expected) {
        const bucket = wrongType.get(issue.expected) ?? [];
        bucket.push(field);
        wrongType.set(issue.expected, bucket);
        continue;
      }
    }
    // Anything else keeps its own wording — unless that wording is machine-speak,
    // in which case naming the field is more use than quoting the schema.
    const readable = !MACHINE_SPEAK.test(issue.message);
    if (readable) other.push(field ? `${field}: ${issue.message}` : issue.message);
    else other.push(field ? `${field} is not valid for this tool` : 'the arguments are not valid');
  }

  const clauses: string[] = [];
  if (missing.length > 0) {
    clauses.push(`was called without the required ${joinList(missing)}`);
  }
  for (const [expected, fields] of wrongType) {
    clauses.push(`needs ${joinList(fields)} as ${typePhrase(expected, fields)}`);
  }
  if (other.length > 0) clauses.push(other.join('; '));
  return `"${toolName}" ${clauses.join('; ')}`;
}

/** The issue list of a ZodError, or empty for anything that is not one. */
function argIssues(cause: unknown): readonly ArgIssue[] {
  if (!cause || typeof cause !== 'object') return [];
  const issues = (cause as { issues?: unknown }).issues;
  return Array.isArray(issues) ? (issues as ArgIssue[]) : [];
}

export function describeArgValidationError(cause: unknown): string {
  /* v8 ignore start */
  if (
    !cause ||
    typeof cause !== 'object' ||
    !Array.isArray((cause as { issues?: unknown }).issues)
  ) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  /* v8 ignore stop */
  return (cause as { issues: ArgIssue[] }).issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Preserve model arguments byte-for-byte until the registered schema parses them. */
export function sanitizeToolArgs(_tool: ToolSpec, rawArgs: unknown): unknown {
  return rawArgs;
}

export function validateSemanticToolArgs(call: ToolCall): void {
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments))
    return;
  const args = call.arguments as Readonly<Record<string, unknown>>;

  if (call.name === 'punch_in') {
    const start = args.startTime;
    const end = args.endTime;
    if (typeof start === 'number' && typeof end === 'number' && end <= start) {
      throw new Error(`endTime (${end}) must be greater than startTime (${start}).`);
    }
  }

  if (call.name === 'manage_assets' && args.strategy === 'plan') {
    const folders = Array.isArray(args.folders) ? args.folders : [];
    const assignments = Array.isArray(args.assignments) ? args.assignments : [];
    if (folders.length === 0 && assignments.length === 0) {
      throw new Error('strategy="plan" requires at least one folder or assignment.');
    }
  }
}

export class ToolInvocationError extends Error {
  /**
   * The same failure in the editor's words. `message` stays the technical text — the
   * model reads it and can correct the call from it — while this is what the AI panel
   * shows. Two audiences, two strings; never blur them.
   */
  public readonly editorSummary: string;

  public constructor(
    public readonly code: 'unknown_tool' | 'unavailable_tool' | 'invalid_args',
    public readonly toolName: string,
    message: string,
    options?: { cause?: unknown; editorSummary?: string },
  ) {
    super(message, options);
    this.name = 'ToolInvocationError';
    this.editorSummary = options?.editorSummary ?? message;
  }
}

/**
 * Turn one mutating tool call into operations. The immutable contract wrapper is
 * resolved here, at the actual invocation boundary, so correctness never depends on
 * a side-effecting module having been imported earlier in the process.
 */
export function operationsForCall(call: ToolCall, ctx: ToolContext): AnyOperation[] {
  const registered = getTool(call.name);
  if (!registered) {
    log.warn('operationsForCall → unknown tool', { tool: call.name });
    throw new ToolInvocationError('unknown_tool', call.name, `Unknown tool: ${call.name}`, {
      editorSummary: `The assistant asked for a tool FramePilot doesn't have ("${call.name}").`,
    });
  }
  const tool = withToolInputContract(registered);
  if (!tool.available) {
    log.warn('operationsForCall → tool unavailable', { tool: call.name });
    throw new ToolInvocationError(
      'unavailable_tool',
      call.name,
      `Tool "${call.name}" is registered but its engine is not available yet.`,
      {
        editorSummary: `"${call.name}" isn't available yet — the engine behind it isn't running.`,
      },
    );
  }
  if (!tool.mutates) return [];
  /* v8 ignore start -- a mutating tool always has buildOps */
  if (!tool.buildOps) return [];
  /* v8 ignore stop */
  try {
    validateSemanticToolArgs(call);
    const ops = tool.buildOps(sanitizeToolArgs(tool, call.arguments), ctx);
    log.action('operationsForCall → dispatched', { tool: call.name, opCount: ops.length });
    return ops;
  } catch (cause) {
    const reason = describeArgValidationError(cause);
    log.warn('operationsForCall → invalid args', { tool: call.name, reason });
    throw new ToolInvocationError(
      'invalid_args',
      call.name,
      `Invalid arguments for "${call.name}": ${reason}`,
      { cause, editorSummary: describeArgValidationForEditor(call.name, cause) },
    );
  }
}
