/**
 * @framepilot/ai-sdk/kernel/scheduler — topological, parallel, resource-capped dispatch
 * (plan/AI-ORCHESTRATION-REDESIGN.md §8.4, Phase K3.2).
 *
 * A **pure** scheduler over a {@link TaskGraph}. Given the run's progress (what has
 * completed, what is in flight, what budget is spent), it decides which ready tasks to
 * dispatch next — honouring:
 *
 * - **Topological + parallel:** every task whose deps have completed is a candidate;
 *   independent tasks dispatch together (the win — `analyze_silence`, `detect_scenes`,
 *   `detect_beats` go out concurrently).
 * - **Resource-class caps (backpressure):** each task draws from a pool
 *   (`ffmpeg`/`model`/`pure`/`render`/`host`) with a concurrency cap, so naive
 *   parallelism can't melt the machine — a batch never exceeds a class's free capacity.
 * - **Priority:** user edits before analyses before speculative prefetch
 *   ({@link readyTasks} already orders by {@link PRIORITY_RANK}).
 * - **Budget-aware stop:** once the run hits its task/token cap the scheduler dispatches
 *   nothing new (generalizes today's `maxOpsPerRun`); in-flight work still drains.
 *
 * No I/O, no clock, no randomness: dispatch order is deterministic and completions are
 * folded back in a recorded order, so a run replays to the identical state (design
 * tenet 6). The driver owns the async — it runs the dispatched effects and folds each
 * result via {@link onTaskCompleted}.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  type ResourceClass,
  type TaskGraph,
  type TaskId,
  type TaskNode,
  readyTasks,
} from './task-graph.js';

const log = createLogger('ai-sdk:kernel:scheduler');

/**
 * Per-class concurrency caps (§8.4). `pure` is uncapped (cheap, in-process);
 * `ffmpeg`/`render` are CPU/IO-bound and tight; `model` is network-bound; `host` covers
 * generic sidecar calls. Callers may override any of these.
 */
export const DEFAULT_RESOURCE_CAPS: Readonly<Record<ResourceClass, number>> = {
  ffmpeg: 2,
  model: 4,
  pure: Infinity,
  render: 1,
  host: 2,
};

/** The run's spend caps. A cap left undefined is unbounded on that dimension. */
export interface Budget {
  /** Max tasks the run may *start* (generalizes `maxOpsPerRun`). */
  readonly maxTasks?: number;
  /** Max accumulated token cost across completed tasks. */
  readonly maxTokens?: number;
  /**
   * Max accumulated **USD** cost across completed tasks — the cost meter's dollar axis
   * (§19). The driver prices each model call via `cost-meter.ts` and folds the resulting
   * spend in through {@link onTaskCompleted}; once the run reaches this cap the scheduler
   * dispatches nothing new (in-flight work still drains). Undefined ⇒ unbounded on cost.
   */
  readonly maxUsd?: number;
}

export interface SchedulerConfig {
  readonly caps: Readonly<Record<ResourceClass, number>>;
  readonly budget?: Budget;
}

/** Fill in the default caps; caller overrides win. */
export function schedulerConfig(over: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    caps: { ...DEFAULT_RESOURCE_CAPS, ...over.caps },
    ...(over.budget !== undefined ? { budget: over.budget } : {}),
  };
}

/**
 * The scheduler's view of run progress — pure data. `completed`/`inflight` drive
 * readiness and capacity; `startedCount`/`tokensSpent` drive the budget; `completionOrder`
 * records the exact order results folded back (replay fidelity).
 */
export interface SchedulerState {
  readonly completed: ReadonlySet<TaskId>;
  /** id → resource class of each dispatched-but-not-yet-completed task. */
  readonly inflight: ReadonlyMap<TaskId, ResourceClass>;
  /** Tasks ever dispatched (the task-budget counter). */
  readonly startedCount: number;
  readonly tokensSpent: number;
  /** Accumulated USD cost across completed tasks (the cost-meter axis, §19). */
  readonly usdSpent: number;
  readonly completionOrder: readonly TaskId[];
}

/** The empty starting state, before any dispatch. */
export function initialSchedulerState(): SchedulerState {
  return {
    completed: new Set(),
    inflight: new Map(),
    startedCount: 0,
    tokensSpent: 0,
    usdSpent: 0,
    completionOrder: [],
  };
}

/** The outcome of a scheduling pass. */
export interface DispatchDecision {
  /** Tasks to run now, in dispatch order (already reserved against the caps). */
  readonly dispatch: readonly TaskNode[];
  /** State with the dispatched tasks moved in-flight and the task counter advanced. */
  readonly state: SchedulerState;
  /** The run has hit a budget cap — nothing new was dispatched. */
  readonly budgetReached: boolean;
}

/** True once the run has reached any of its task/token/USD caps. */
function budgetReachedFor(state: SchedulerState, budget?: Budget): boolean {
  if (!budget) return false;
  if (budget.maxTasks !== undefined && state.startedCount >= budget.maxTasks) return true;
  if (budget.maxTokens !== undefined && state.tokensSpent >= budget.maxTokens) return true;
  if (budget.maxUsd !== undefined && state.usdSpent >= budget.maxUsd) return true;
  return false;
}

/** Count of in-flight tasks per resource class (capacity accounting). */
function inflightByClass(inflight: ReadonlyMap<TaskId, ResourceClass>): Map<ResourceClass, number> {
  const counts = new Map<ResourceClass, number>();
  for (const cls of inflight.values()) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  return counts;
}

/**
 * Decide the next batch to dispatch. Pure: returns the tasks to run plus the state with
 * them moved in-flight — the driver executes them and folds each result via
 * {@link onTaskCompleted}. Respects, in order: budget (stop when reached), the remaining
 * task budget (never start more than the cap allows), per-class capacity (backpressure),
 * and priority/graph order (via {@link readyTasks}).
 */
export function nextDispatch(
  graph: TaskGraph,
  state: SchedulerState,
  config: SchedulerConfig,
): DispatchDecision {
  if (budgetReachedFor(state, config.budget)) {
    log.warn('nextDispatch → budget reached, dispatching nothing new', {
      startedCount: state.startedCount,
      tokensSpent: state.tokensSpent,
      usdSpent: state.usdSpent,
    });
    return { dispatch: [], state, budgetReached: true };
  }
  const remainingTaskBudget =
    config.budget?.maxTasks !== undefined ? config.budget.maxTasks - state.startedCount : Infinity;

  const inflightIds = new Set(state.inflight.keys());
  const used = inflightByClass(state.inflight);
  const dispatch: TaskNode[] = [];
  for (const task of readyTasks(graph, state.completed, inflightIds)) {
    if (dispatch.length >= remainingTaskBudget) break;
    const cap = config.caps[task.resource] ?? Infinity;
    const inUse = used.get(task.resource) ?? 0;
    if (inUse < cap) {
      dispatch.push(task);
      used.set(task.resource, inUse + 1); // reserve so the batch itself respects the cap
    }
  }

  const inflight = new Map(state.inflight);
  for (const task of dispatch) inflight.set(task.id, task.resource);
  log.debug('nextDispatch → picked next batch', {
    picked: dispatch.map((t) => t.id),
  });
  return {
    dispatch,
    state: { ...state, inflight, startedCount: state.startedCount + dispatch.length },
    budgetReached: false,
  };
}

/**
 * Fold one task's completion back in: move it out of flight into `completed`, accrue its
 * token and USD cost (priced by the cost meter for a model task; both default 0 for a
 * pure/host task), and record it in `completionOrder`. Order-recorded so a replay that
 * folds the same completions reproduces the identical state.
 */
export function onTaskCompleted(
  state: SchedulerState,
  taskId: TaskId,
  cost: { readonly tokens?: number; readonly usd?: number } = {},
): SchedulerState {
  const inflight = new Map(state.inflight);
  inflight.delete(taskId);
  const completed = new Set(state.completed);
  completed.add(taskId);
  return {
    ...state,
    inflight,
    completed,
    tokensSpent: state.tokensSpent + (cost.tokens ?? 0),
    usdSpent: state.usdSpent + (cost.usd ?? 0),
    completionOrder: [...state.completionOrder, taskId],
  };
}

/** Every task in the graph has completed. */
export function isComplete(graph: TaskGraph, state: SchedulerState): boolean {
  return graph.nodes.every((node) => state.completed.has(node.id));
}

/**
 * The run will make no further progress: either it is complete, or nothing is in flight
 * and no more work can be dispatched (budget reached, or no ready task remains). The
 * driver stops its dispatch loop when this holds.
 */
export function isSettled(
  graph: TaskGraph,
  state: SchedulerState,
  config: SchedulerConfig,
): boolean {
  if (isComplete(graph, state)) return true;
  if (state.inflight.size > 0) return false;
  if (budgetReachedFor(state, config.budget)) return true;
  return readyTasks(graph, state.completed, new Set()).length === 0;
}
