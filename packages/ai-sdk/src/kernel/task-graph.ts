/**
 * @framepilot/ai-sdk/kernel/task-graph — the run's Task DAG
 * (plan/AI-ORCHESTRATION-REDESIGN.md §8, Phase K3.1).
 *
 * The unit of scheduling. A {@link TaskGraph} is a validated, acyclic dependency graph
 * of {@link TaskNode}s; both a deterministic recipe and the LLM Planner compile to *this
 * same structure* (§8.2 — "a recipe is a plan"), so there is exactly one execution path
 * downstream. Each node carries what to run (an inert {@link TaskEffectSpec} the
 * EffectRuntime later interprets), the **resource class** its effect draws from (so the
 * Scheduler can cap ffmpeg vs. model concurrency, §8.4), a scheduling **priority**, and
 * its upstream **deps**.
 *
 * Pure data + pure functions: `buildTaskGraph` enforces the invariants (unique ids,
 * every dep resolves, acyclic) once, and {@link topologicalOrder} / {@link readyTasks}
 * are deterministic derivations the Conductor/Scheduler read. No I/O, no clock, no
 * randomness — table-testable and replayable (design tenet 6).
 */
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:kernel:task-graph');

/** Stable node identifier within a graph (e.g. `T1`, `T2`). */
export type TaskId = string;

/**
 * The pool a task's effect draws from (§8.4). The Scheduler enforces a per-class
 * concurrency cap so naive parallelism can't melt the machine: `ffmpeg`/`render` are
 * CPU/IO-bound and tightly capped, `model` is network-bound, `pure` is cheap.
 */
export type ResourceClass = 'ffmpeg' | 'model' | 'pure' | 'render' | 'host';

/**
 * Scheduling priority (§8.4): user-visible edits outrank background analyses, which
 * outrank speculative prefetch. Ties fall back to graph order for determinism.
 */
export type TaskPriority = 'edit' | 'analysis' | 'speculative';

/** Numeric rank for {@link TaskPriority} — lower dispatches first. */
export const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  edit: 0,
  analysis: 1,
  speculative: 2,
};

/**
 * What a task executes — aligned with the kernel effect kinds (§10). Inert at the graph
 * level: the graph only cares about scheduling structure; the EffectRuntime interprets
 * the payload (`host_tool`/`model` → the existing fine effects, `analysis`/`patch`/
 * `verify` → deterministic engine/editor-core steps).
 */
export interface TaskEffectSpec {
  readonly kind: 'host_tool' | 'analysis' | 'patch' | 'model' | 'verify';
  /** Tool/op/analysis name, e.g. `analyze_silence`, `synth_ripple_deletes`. */
  readonly name: string;
  /** Free-form arguments the runtime passes to the effect (deterministic). */
  readonly args?: Readonly<Record<string, unknown>>;
}

/** One DAG node: an effect to run, its resource class + priority, and upstream deps. */
export interface TaskNode {
  readonly id: TaskId;
  /** Human label for the plan ledger (drives the pinned todo checklist). */
  readonly label: string;
  readonly effect: TaskEffectSpec;
  readonly resource: ResourceClass;
  readonly priority: TaskPriority;
  /** Ids this task depends on; it becomes ready only once all have completed. */
  readonly deps: readonly TaskId[];
}

/** A validated task DAG. Only {@link buildTaskGraph} constructs one. */
export interface TaskGraph {
  readonly nodes: readonly TaskNode[];
  /** id → node, for O(1) lookup by dependants and the scheduler. */
  readonly byId: ReadonlyMap<TaskId, TaskNode>;
}

/** Thrown when a set of nodes cannot form a valid DAG (bad id/dep/cycle). */
export class TaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskGraphError';
  }
}

/**
 * Build and validate a {@link TaskGraph} from raw nodes. Enforces the three invariants
 * a scheduler relies on:
 *  1. **unique ids** — nodes address each other by id;
 *  2. **resolvable deps** — every dep names a node in the set;
 *  3. **acyclic** — a topological order exists (no task waits on itself, transitively).
 *
 * @throws {TaskGraphError} with a specific reason when any invariant is violated.
 */
export function buildTaskGraph(nodes: readonly TaskNode[]): TaskGraph {
  const byId = new Map<TaskId, TaskNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new TaskGraphError(`Duplicate task id "${node.id}".`);
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!byId.has(dep)) {
        throw new TaskGraphError(`Task "${node.id}" depends on unknown task "${dep}".`);
      }
      if (dep === node.id) {
        throw new TaskGraphError(`Task "${node.id}" depends on itself.`);
      }
    }
  }
  const graph: TaskGraph = { nodes, byId };
  // Validate acyclicity by computing a topological order (throws on a cycle).
  topologicalOrder(graph);
  log.debug('buildTaskGraph → validated', { nodes: nodes.length });
  return graph;
}

/**
 * A deterministic topological order of the graph's task ids (Kahn's algorithm). Ready
 * nodes are dequeued in **graph order** so the result is stable for the same input,
 * which keeps recorded runs replayable.
 *
 * @throws {TaskGraphError} when the graph contains a cycle.
 */
export function topologicalOrder(graph: TaskGraph): readonly TaskId[] {
  const indegree = new Map<TaskId, number>();
  for (const node of graph.nodes) indegree.set(node.id, node.deps.length);
  // Dependants: for each id, the nodes that depend on it (to decrement on completion).
  const dependants = new Map<TaskId, TaskId[]>();
  for (const node of graph.nodes) {
    for (const dep of node.deps) {
      const list = dependants.get(dep);
      if (list) list.push(node.id);
      else dependants.set(dep, [node.id]);
    }
  }
  // Seed the queue with zero-indegree nodes in graph order (stable tiebreak).
  const queue = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: TaskId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependant of dependants.get(id) ?? []) {
      const next = indegree.get(dependant)! - 1;
      indegree.set(dependant, next);
      if (next === 0) queue.push(dependant);
    }
  }
  if (order.length !== graph.nodes.length) {
    const stuck = graph.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    log.error('topologicalOrder → cycle detected', { stuck });
    throw new TaskGraphError(`Task graph has a cycle among: ${stuck.join(', ')}.`);
  }
  return order;
}

/**
 * The tasks that are dispatchable right now: every dependency has completed, and the
 * task is neither already completed nor in flight. Returned in **dispatch order** —
 * by ascending priority rank, ties broken by graph order — so the caller (Scheduler)
 * can take the highest-priority ready work first. Pure; the caller owns the
 * completed/inflight sets.
 */
export function readyTasks(
  graph: TaskGraph,
  completed: ReadonlySet<TaskId>,
  inflight: ReadonlySet<TaskId>,
): readonly TaskNode[] {
  const ready = graph.nodes.filter(
    (node) =>
      !completed.has(node.id) &&
      !inflight.has(node.id) &&
      node.deps.every((dep) => completed.has(dep)),
  );
  // Stable sort: priority first, original graph order as the tiebreak.
  return ready
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.node.priority] - PRIORITY_RANK[b.node.priority] || a.index - b.index,
    )
    .map(({ node }) => node);
}
