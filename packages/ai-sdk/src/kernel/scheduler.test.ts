/** Tests for the Scheduler (kernel/scheduler.ts, Phase K3.2). */
import { describe, expect, it } from 'vitest';
import {
  type SchedulerConfig,
  type SchedulerState,
  DEFAULT_RESOURCE_CAPS,
  initialSchedulerState,
  isComplete,
  isSettled,
  nextDispatch,
  onTaskCompleted,
  schedulerConfig,
} from './scheduler.js';
import {
  type ResourceClass,
  type TaskGraph,
  type TaskNode,
  type TaskPriority,
  buildTaskGraph,
} from './task-graph.js';

const node = (
  id: string,
  deps: string[] = [],
  resource: ResourceClass = 'pure',
  priority: TaskPriority = 'edit',
): TaskNode => ({
  id,
  label: id,
  effect: { kind: 'analysis', name: id },
  resource,
  priority,
  deps,
});

/** Drive a graph to completion, dispatching greedily and completing in dispatch order. */
function runToCompletion(
  graph: TaskGraph,
  config: SchedulerConfig,
): { state: SchedulerState; batches: string[][] } {
  let state = initialSchedulerState();
  const batches: string[][] = [];
  // Bound the loop defensively so a scheduling bug fails fast instead of hanging.
  for (let guard = 0; guard < 100 && !isSettled(graph, state, config); guard += 1) {
    const decision = nextDispatch(graph, state, config);
    state = decision.state;
    if (decision.dispatch.length > 0) batches.push(decision.dispatch.map((t) => t.id));
    for (const task of decision.dispatch) state = onTaskCompleted(state, task.id);
  }
  return { state, batches };
}

describe('parallel dispatch', () => {
  it('dispatches independent ready tasks together (the parallel-analysis win)', () => {
    // detect_beats ∥ detect_scenes, then a dependent cut task.
    const g = buildTaskGraph([
      node('beats', [], 'ffmpeg'),
      node('scenes', [], 'ffmpeg'),
      node('cut', ['beats', 'scenes']),
    ]);
    const decision = nextDispatch(g, initialSchedulerState(), schedulerConfig());
    expect(decision.dispatch.map((t) => t.id)).toEqual(['beats', 'scenes']);
  });

  it('unblocks a dependant only once all deps complete', () => {
    const g = buildTaskGraph([node('a'), node('b'), node('c', ['a', 'b'])]);
    let state = initialSchedulerState();
    state = nextDispatch(g, state, schedulerConfig()).state; // dispatch a, b
    state = onTaskCompleted(state, 'a');
    expect(nextDispatch(g, state, schedulerConfig()).dispatch).toEqual([]); // c still blocked on b
    state = onTaskCompleted(state, 'b');
    expect(nextDispatch(g, state, schedulerConfig()).dispatch.map((t) => t.id)).toEqual(['c']);
  });
});

describe('resource-class backpressure', () => {
  it('never exceeds a class cap within one batch', () => {
    const g = buildTaskGraph([
      node('f1', [], 'ffmpeg'),
      node('f2', [], 'ffmpeg'),
      node('f3', [], 'ffmpeg'),
    ]);
    const decision = nextDispatch(g, initialSchedulerState(), schedulerConfig()); // ffmpeg cap 2
    expect(decision.dispatch.map((t) => t.id)).toEqual(['f1', 'f2']);
  });

  it('dispatches the queued task once capacity frees up', () => {
    const g = buildTaskGraph([
      node('f1', [], 'ffmpeg'),
      node('f2', [], 'ffmpeg'),
      node('f3', [], 'ffmpeg'),
    ]);
    let state = nextDispatch(g, initialSchedulerState(), schedulerConfig()).state; // f1,f2 inflight
    expect(nextDispatch(g, state, schedulerConfig()).dispatch).toEqual([]); // saturated
    state = onTaskCompleted(state, 'f1');
    expect(nextDispatch(g, state, schedulerConfig()).dispatch.map((t) => t.id)).toEqual(['f3']);
  });

  it('accounts capacity per class independently', () => {
    const g = buildTaskGraph([
      node('r1', [], 'render'), // cap 1
      node('r2', [], 'render'),
      node('m1', [], 'model'), // cap 4
    ]);
    const decision = nextDispatch(g, initialSchedulerState(), schedulerConfig());
    // one render (cap 1) + the model task; r2 waits.
    expect(decision.dispatch.map((t) => t.id).sort()).toEqual(['m1', 'r1']);
  });

  it('treats pure tasks as uncapped', () => {
    const g = buildTaskGraph(Array.from({ length: 20 }, (_, i) => node(`p${i}`)));
    expect(nextDispatch(g, initialSchedulerState(), schedulerConfig()).dispatch).toHaveLength(20);
  });

  it('treats a class with no configured cap as uncapped', () => {
    const g = buildTaskGraph([
      node('f1', [], 'ffmpeg'),
      node('f2', [], 'ffmpeg'),
      node('f3', [], 'ffmpeg'),
    ]);
    // Drop ffmpeg from the caps entirely → the ?? Infinity fallback governs.
    const caps = { ...DEFAULT_RESOURCE_CAPS } as Record<ResourceClass, number>;
    delete (caps as Partial<Record<ResourceClass, number>>).ffmpeg;
    const decision = nextDispatch(g, initialSchedulerState(), { caps });
    expect(decision.dispatch.map((t) => t.id)).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('priority', () => {
  it('dispatches higher-priority ready work first', () => {
    const g = buildTaskGraph([
      node('spec', [], 'pure', 'speculative'),
      node('edit', [], 'pure', 'edit'),
      node('analysis', [], 'pure', 'analysis'),
    ]);
    expect(
      nextDispatch(g, initialSchedulerState(), schedulerConfig()).dispatch.map((t) => t.id),
    ).toEqual(['edit', 'analysis', 'spec']);
  });

  it('prefers edits over speculative under a tight class cap', () => {
    const g = buildTaskGraph([
      node('spec', [], 'ffmpeg', 'speculative'),
      node('e1', [], 'ffmpeg', 'edit'),
      node('e2', [], 'ffmpeg', 'edit'),
    ]);
    // ffmpeg cap 2 → the two edits win, speculative is starved this pass.
    expect(
      nextDispatch(g, initialSchedulerState(), schedulerConfig()).dispatch.map((t) => t.id),
    ).toEqual(['e1', 'e2']);
  });
});

describe('budget-aware stop', () => {
  it('stops starting tasks at the task cap but lets in-flight drain', () => {
    const g = buildTaskGraph([node('a'), node('b'), node('c')]);
    const config = schedulerConfig({ budget: { maxTasks: 2 } });
    const decision = nextDispatch(g, initialSchedulerState(), config);
    expect(decision.dispatch.map((t) => t.id)).toEqual(['a', 'b']); // capped to 2
    const next = nextDispatch(g, decision.state, config);
    expect(next.budgetReached).toBe(true);
    expect(next.dispatch).toEqual([]);
  });

  it('stops dispatching once the token cap is spent', () => {
    const g = buildTaskGraph([node('a'), node('b')]);
    const config = schedulerConfig({ budget: { maxTokens: 100 } });
    let state = nextDispatch(g, initialSchedulerState(), config).state;
    state = onTaskCompleted(state, 'a', { tokens: 100 });
    const decision = nextDispatch(g, state, config);
    expect(decision.budgetReached).toBe(true);
    expect(decision.dispatch).toEqual([]);
  });

  it('stops dispatching once the USD cap is spent (cost meter, §19)', () => {
    const g = buildTaskGraph([node('a'), node('b')]);
    const config = schedulerConfig({ budget: { maxUsd: 0.5 } });
    let state = nextDispatch(g, initialSchedulerState(), config).state;
    state = onTaskCompleted(state, 'a', { tokens: 1000, usd: 0.5 });
    expect(state.usdSpent).toBe(0.5);
    const decision = nextDispatch(g, state, config);
    expect(decision.budgetReached).toBe(true);
    expect(decision.dispatch).toEqual([]);
  });

  it('keeps dispatching while under the USD cap', () => {
    const g = buildTaskGraph([node('a'), node('b')]);
    const config = schedulerConfig({ budget: { maxUsd: 1 } });
    let state = nextDispatch(g, initialSchedulerState(), config).state; // start a
    state = onTaskCompleted(state, 'a', { usd: 0.25 });
    expect(nextDispatch(g, state, config).budgetReached).toBe(false);
  });

  it('is settled when the budget is reached with nothing in flight', () => {
    const g = buildTaskGraph([node('a'), node('b'), node('c')]);
    const config = schedulerConfig({ budget: { maxTasks: 1 } });
    let state = nextDispatch(g, initialSchedulerState(), config).state; // start a
    state = onTaskCompleted(state, 'a');
    expect(isComplete(g, state)).toBe(false);
    expect(isSettled(g, state, config)).toBe(true); // budget blocks b, c
  });
});

describe('completion & lifecycle', () => {
  it('records the completion order for replay fidelity', () => {
    const g = buildTaskGraph([node('a'), node('b'), node('c', ['a', 'b'])]);
    const { state } = runToCompletion(g, schedulerConfig());
    expect(state.completionOrder).toEqual(['a', 'b', 'c']);
    expect(isComplete(g, state)).toBe(true);
  });

  it('runs the remove_silence-shaped linear DAG one task at a time', () => {
    const g = buildTaskGraph([
      node('T1', [], 'ffmpeg'),
      node('T2', ['T1']),
      node('T3', ['T2']),
      node('T4', ['T3']),
    ]);
    const { batches } = runToCompletion(g, schedulerConfig());
    expect(batches).toEqual([['T1'], ['T2'], ['T3'], ['T4']]);
  });

  it('isSettled is false while work remains dispatchable', () => {
    const g = buildTaskGraph([node('a')]);
    expect(isSettled(g, initialSchedulerState(), schedulerConfig())).toBe(false);
  });

  it('isSettled is false while a task is in flight', () => {
    const g = buildTaskGraph([node('a'), node('b', ['a'])]);
    const state = nextDispatch(g, initialSchedulerState(), schedulerConfig()).state; // a inflight
    expect(isSettled(g, state, schedulerConfig())).toBe(false);
  });
});

describe('schedulerConfig', () => {
  it('fills default caps and passes through budget', () => {
    const c = schedulerConfig({ budget: { maxTasks: 5 } });
    expect(c.caps).toEqual(DEFAULT_RESOURCE_CAPS);
    expect(c.budget).toEqual({ maxTasks: 5 });
  });

  it('merges cap overrides over the defaults', () => {
    const c = schedulerConfig({ caps: { ffmpeg: 8 } as SchedulerConfig['caps'] });
    expect(c.caps.ffmpeg).toBe(8);
    expect(c.caps.model).toBe(DEFAULT_RESOURCE_CAPS.model);
    expect(c.budget).toBeUndefined();
  });
});
