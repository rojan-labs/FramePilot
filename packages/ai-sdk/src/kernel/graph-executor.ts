/**
 * @framepilot/ai-sdk/kernel/graph-executor — the shared "drive the scheduler" loop
 * (plan/AGENT-NATIVE-COMPLETION-PLAN.md P3.1).
 *
 * Extracted from `recipe-executor.ts` (P1.2) so the recipe path and the live planner
 * path (P3) share one execution loop instead of diverging retry/cancel/fold semantics
 * across two copies. `plan-compiler.ts` already asserts "a recipe *is* a plan... there is
 * exactly one execution path downstream" — this module is that one path. It is agnostic
 * to *what* a task runs (`host_tool`, a pure leaf, or a `model` proposer call): the caller
 * supplies a {@link GraphExecutorDeps.runTask} dispatcher and gets back the same
 * `task_started`/`tool_call`/`tool_result`/`task_finished` {@link AiEvent} lifecycle the
 * recipe path already streams, plus every task's folded output for the caller to turn
 * into its own domain result (a `RecipeRunResult`, a planned-edit result, …).
 *
 * The loop itself is unchanged from the recipe executor: ask {@link nextDispatch} for the
 * next ready batch, run it concurrently, flush each task's events in deterministic
 * dispatch order (replay fidelity), fold completions via {@link onTaskCompleted}, and stop
 * on the first failed/cancelled task (its dependants can never run honestly) or once the
 * scheduler has nothing left to dispatch.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { AiEvent, TurnEmitter } from '../events.js';
import type { ToolCall } from '../providers/types.js';
import { getTool } from '../tool-registry.js';
import type { EffectRuntime, HostToolEffectResult } from './effect-runtime.js';
import {
  type SchedulerConfig,
  type SchedulerState,
  initialSchedulerState,
  nextDispatch,
  onTaskCompleted,
  schedulerConfig,
} from './scheduler.js';
import type { TaskId, TaskNode } from './task-graph.js';
import type { TaskGraph } from './task-graph.js';

const log = createLogger('ai-sdk:kernel:graph-executor');

/** The per-task result a `runTask` dispatcher returns after running one node's effect. */
export interface TaskRunResult<TOutput> {
  readonly taskId: TaskId;
  /** The lifecycle events to flush, in order, for this task. */
  readonly events: readonly AiEvent[];
  readonly output: TOutput;
  readonly status: 'completed' | 'warning' | 'failed' | 'cancelled';
  readonly runtimeMs: number;
  /**
   * What this task's model call(s) actually cost (P7.1 cost-meter wiring). Absent/omitted
   * means "not priced" — a `host_tool`/pure leaf never calls a model, so it never carries
   * this field (see {@link runHostToolTask}, which never sets it). Only a `model`-kind task
   * dispatcher (e.g. `plan-driver.ts`'s `runProposeEdit`) prices real usage
   * here, and it does so on every attempt (including a retried/rejected one — that attempt
   * still burned real tokens).
   */
  readonly cost?: { readonly tokens: number; readonly usd: number };
}

/** How the whole graph run settled. */
export type GraphRunTerminal = 'completed' | 'failed' | 'cancelled';

/** The distilled outcome of a graph run — every task's output, for the caller to fold. */
export interface GraphRunResult<TOutput> {
  readonly terminal: GraphRunTerminal;
  /** Each completed/failed task's normalized output, keyed by task id (completion order). */
  readonly outputs: ReadonlyMap<TaskId, TOutput>;
  /**
   * The run's total priced spend (P7.1) — folded via the scheduler's
   * {@link import('./scheduler.js').onTaskCompleted}, so it is exactly
   * `state.tokensSpent`/`state.usdSpent` at settlement. A run with no costed tasks (every
   * recipe today — host-tool/pure leaves are never priced) is honestly `{ tokens: 0, usd: 0 }`,
   * not a hardcoded zero.
   */
  readonly cost: { readonly tokens: number; readonly usd: number };
}

/** What the executor needs to run one graph: the emitter and how to run one task. */
export interface GraphExecutorDeps<TOutput> {
  readonly emit: TurnEmitter;
  /** Scheduler caps/budget; defaults to {@link schedulerConfig}. */
  readonly config?: SchedulerConfig;
  /**
   * Run one dispatched task's effect. `upstream` reads a completed task's output by id —
   * safe to call for any dep, since the scheduler never dispatches a task before its deps
   * have completed.
   */
  readonly runTask: (
    task: TaskNode,
    upstream: (id: TaskId) => TOutput | undefined,
  ) => Promise<TaskRunResult<TOutput>>;
}

/**
 * Run one {@link TaskGraph} to completion, yielding the run's lifecycle events and
 * returning its distilled {@link GraphRunResult}. Domain-agnostic: the recipe executor
 * and the planned-edit driver both call this with their own `runTask` dispatcher and fold
 * the returned `outputs` into their own result shape.
 */
export async function* runGraph<TOutput>(
  graph: TaskGraph,
  deps: GraphExecutorDeps<TOutput>,
): AsyncGenerator<AiEvent, GraphRunResult<TOutput>> {
  const config = deps.config ?? schedulerConfig();
  const outputs = new Map<TaskId, TOutput>();
  let state: SchedulerState = initialSchedulerState();
  let terminal: GraphRunTerminal | null = null;

  log.action('runGraph → starting', { nodes: graph.nodes.length });

  // Drive the scheduler until it dispatches nothing more — the graph is complete, or a
  // budget cap stopped new work. Each iteration awaits its whole batch, so at the loop top
  // nothing is in flight and `nextDispatch` returns the next ready batch (or empty to end).
  for (;;) {
    const decision = nextDispatch(graph, state, config);
    if (decision.dispatch.length === 0) break;
    state = decision.state;

    log.action('runGraph → dispatching batch', {
      tasks: decision.dispatch.map((t) => ({ id: t.id, label: t.label, kind: t.effect.kind })),
    });

    // Announce the whole batch first so independent tasks surface as running in parallel.
    for (const task of decision.dispatch) {
      yield deps.emit.taskStarted(task.id, task.label, task.resource);
    }

    // Run the batch concurrently, then flush each task's events in deterministic dispatch
    // order (replay fidelity) and fold its completion.
    const settled = await Promise.all(
      decision.dispatch.map((task) => deps.runTask(task, (id) => outputs.get(id))),
    );
    for (const r of settled) {
      for (const ev of r.events) yield ev;
      outputs.set(r.taskId, r.output);
      yield deps.emit.taskFinished(r.taskId, r.status, r.runtimeMs);
      state = onTaskCompleted(
        state,
        r.taskId,
        r.cost ? { tokens: r.cost.tokens, usd: r.cost.usd } : {},
      );
      if (r.status === 'cancelled') {
        terminal = 'cancelled';
        log.warn('runGraph → task cancelled, stopping run', { taskId: r.taskId });
      } else if (r.status === 'failed' && terminal === null) {
        terminal = 'failed';
        log.warn('runGraph → task failed, stopping run', { taskId: r.taskId });
      }
    }
    // A failed/cancelled task stops the run — its dependants can never run honestly.
    if (terminal !== null) break;
  }

  log.action('runGraph ← settled', {
    terminal: terminal ?? 'completed',
    tasks: outputs.size,
    cost: { tokens: state.tokensSpent, usd: state.usdSpent },
  });
  return {
    terminal: terminal ?? 'completed',
    outputs,
    cost: { tokens: state.tokensSpent, usd: state.usdSpent },
  };
}

/** The normalized output of a `host_tool` task — the shape both the recipe path and the
 *  planned-edit path (P3.1) fold into their own richer output type. */
export interface HostToolTaskOutput {
  /** Raw host-tool result payload (e.g. `{ ranges: [...] }` from `analyze_silence`). */
  readonly data?: unknown;
  readonly summary: string;
  /** The host tool failed specifically because no analysis engine is connected. */
  readonly engineUnavailable?: boolean;
}

/** Whether a host-tool failure is specifically "no engine connected" (vs. a real error). */
function isEngineUnavailableSummary(summary: string): boolean {
  const s = summary.toLowerCase();
  return (
    s.includes('no analysis engine') || s.includes('unavailable') || s.includes('not connected')
  );
}

/**
 * Names of the arguments `toolName` requires but `args` does not supply.
 *
 * A graph's `host_tool` args reach the executor UNVALIDATED: the agent loop runs every
 * call through the registry's Zod schema, but a compiled plan's `effect.args` are authored
 * by the Planner and dispatched verbatim. A step that omitted a required id (`describe_footage`
 * with no `assetId`) therefore travelled all the way to the sidecar, which rejected it with a
 * FastAPI validation error that ECHOES THE WHOLE REQUEST BODY — the inlined project document,
 * waveform peaks and all — straight back into the run's context and the tool card.
 *
 * Checking presence only (never types, never extra keys) is deliberate: this is a
 * precondition on a plan step, not a second parse. Rejecting unknown keys here would fail
 * steps the engine happily ignores, trading one over-strict failure for another.
 */
export function missingRequiredArgs(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  const required = getTool(toolName)?.parameters.required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (key): key is string => typeof key === 'string' && args[key] === undefined,
  );
}

/**
 * Run one `host_tool` task through the {@link EffectRuntime} and emit its `tool_call`/
 * `tool_result` lifecycle — the one `runTask` branch every graph (recipe or plan) shares,
 * since a host-tool effect means the same thing regardless of who compiled the graph.
 */
export async function runHostToolTask(
  task: TaskNode,
  deps: {
    readonly runtime: EffectRuntime;
    readonly project: Project;
    readonly emit: TurnEmitter;
    /** Resolved clock — both callers (recipe-executor, plan-driver) already default it. */
    readonly now: () => number;
  },
  signal?: AbortSignal,
): Promise<TaskRunResult<HostToolTaskOutput>> {
  const { now } = deps;
  const events: AiEvent[] = [];
  const call: ToolCall = {
    id: `${task.id}:${task.effect.name}`,
    name: task.effect.name,
    // Spreading `undefined` is a no-op — a host-tool node with no args yields `{}`.
    arguments: { ...task.effect.args },
  };
  const argsSummary = task.label;
  events.push(deps.emit.toolCall(call.id, call.name, 'running', { title: task.label }));
  const started = now();
  const missing = missingRequiredArgs(call.name, call.arguments);
  if (missing.length > 0) {
    const summary = `"${call.name}" needs ${missing.join(', ')} — the plan step did not name ${missing.length === 1 ? 'it' : 'them'}.`;
    log.warn('runHostToolTask → step missing required args, not dispatched', {
      taskId: task.id,
      tool: call.name,
      missing,
    });
    events.push(
      deps.emit.toolCall(call.id, call.name, 'failed', {
        runtimeMs: 0,
        title: task.label,
        argsSummary,
      }),
    );
    events.push(deps.emit.toolResult(call.id, { summary }));
    return { taskId: task.id, events, output: { summary }, status: 'failed', runtimeMs: 0 };
  }
  const result = await deps.runtime.run({ kind: 'host_tool', call, project: deps.project }, signal);
  const runtimeMs = now() - started;
  // A `host_tool` effect always yields a HostToolEffectResult (the runtime contract).
  const { outcome } = result as HostToolEffectResult;
  events.push(
    deps.emit.toolCall(call.id, call.name, outcome.status, {
      runtimeMs,
      title: task.label,
      argsSummary,
    }),
  );
  events.push(
    deps.emit.toolResult(call.id, {
      summary: outcome.summary,
      ...(outcome.data !== undefined ? { result: outcome.data } : {}),
    }),
  );
  return {
    taskId: task.id,
    events,
    output: {
      summary: outcome.summary,
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      ...(outcome.status === 'failed' && isEngineUnavailableSummary(outcome.summary)
        ? { engineUnavailable: true }
        : {}),
    },
    status: outcome.status,
    runtimeMs,
  };
}
