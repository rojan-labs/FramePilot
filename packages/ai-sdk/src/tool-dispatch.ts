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
  public constructor(
    public readonly code: 'unknown_tool' | 'unavailable_tool' | 'invalid_args',
    public readonly toolName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ToolInvocationError';
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
    throw new ToolInvocationError('unknown_tool', call.name, `Unknown tool: ${call.name}`);
  }
  const tool = withToolInputContract(registered);
  if (!tool.available) {
    log.warn('operationsForCall → tool unavailable', { tool: call.name });
    throw new ToolInvocationError(
      'unavailable_tool',
      call.name,
      `Tool "${call.name}" is registered but its engine is not available yet.`,
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
      { cause },
    );
  }
}
