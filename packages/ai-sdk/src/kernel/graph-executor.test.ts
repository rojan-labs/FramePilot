/**
 * Tests for the shared graph executor's cost folding (P7.1): a `runTask` dispatcher that
 * prices some tasks and not others must have its costs summed correctly into the returned
 * {@link GraphRunResult.cost}, and a run with no costed tasks must be exactly `{tokens: 0,
 * usd: 0}` — the mechanism that keeps recipe runs honestly free (see
 * `recipe-executor.test.ts`'s companion assertion).
 */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '../events.js';
import { buildTaskGraph, type TaskNode } from './task-graph.js';
import {
  missingRequiredArgs,
  runGraph,
  runHostToolTask,
  type TaskRunResult,
} from './graph-executor.js';
import { makeProject } from '../__fixtures__/project.js';

const emitter = () => createTurnEmitter({ conversationId: 'c', turnId: 't', now: () => 1000 });

/** A minimal two-node graph: T1 (no deps) → T2 (depends on T1). */
function twoNodeGraph(): { t1: TaskNode; t2: TaskNode } {
  const t1: TaskNode = {
    id: 'T1',
    label: 'First',
    effect: { kind: 'model', name: 'propose_edit' },
    resource: 'model',
    priority: 'edit',
    deps: [],
  };
  const t2: TaskNode = {
    id: 'T2',
    label: 'Second',
    effect: { kind: 'analysis', name: 'noop' },
    resource: 'pure',
    priority: 'edit',
    deps: ['T1'],
  };
  return { t1, t2 };
}

describe('runGraph — cost folding (P7.1)', () => {
  it('sums a costed task and an uncosted task into GraphRunResult.cost', async () => {
    const { t1, t2 } = twoNodeGraph();
    const graph = buildTaskGraph([t1, t2]);

    const runTask = (task: TaskNode): Promise<TaskRunResult<string>> => {
      if (task.id === 'T1') {
        return Promise.resolve({
          taskId: task.id,
          events: [],
          output: 'first',
          status: 'completed',
          runtimeMs: 1,
          cost: { tokens: 100, usd: 0.01 },
        });
      }
      // T2 is a pure leaf — no cost field at all (mirrors runHostToolTask/runLeaf).
      return Promise.resolve({
        taskId: task.id,
        events: [],
        output: 'second',
        status: 'completed',
        runtimeMs: 1,
      });
    };

    const gen = runGraph(graph, { emit: emitter(), runTask });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    const result = step.value;

    expect(result.terminal).toBe('completed');
    expect(result.cost).toEqual({ tokens: 100, usd: 0.01 });
    expect(result.outputs.get('T1')).toBe('first');
    expect(result.outputs.get('T2')).toBe('second');
  });

  it('returns exactly {tokens: 0, usd: 0} for a run with no costed tasks', async () => {
    const { t1, t2 } = twoNodeGraph();
    const graph = buildTaskGraph([t1, t2]);

    const runTask = (task: TaskNode): Promise<TaskRunResult<string>> =>
      Promise.resolve({
        taskId: task.id,
        events: [],
        output: task.id,
        status: 'completed',
        runtimeMs: 1,
        // No `cost` field on either task — a recipe-shaped run (host-tool/pure leaves only).
      });

    const gen = runGraph(graph, { emit: emitter(), runTask });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    const result = step.value;

    expect(result.cost).toEqual({ tokens: 0, usd: 0 });
  });
});

describe('missingRequiredArgs', () => {
  it('names the required arguments a plan step left out, and nothing else', () => {
    // `describe_footage` requires an assetId — the omission that sent an unvalidated plan
    // step to the sidecar, which rejected it by echoing the whole inlined project back.
    expect(missingRequiredArgs('describe_footage', {})).toEqual(['assetId']);
    expect(missingRequiredArgs('describe_footage', { assetId: 'a1' })).toEqual([]);
    // Presence only: extra keys are the engine's business, and optional args are optional.
    expect(missingRequiredArgs('describe_footage', { assetId: 'a1', sliceFrom: 'T1' })).toEqual([]);
    expect(missingRequiredArgs('detect_beats', {})).toEqual([]);
    // A name the registry does not know cannot have a precondition asserted about it.
    expect(missingRequiredArgs('not_a_tool', {})).toEqual([]);
  });
});

describe('runHostToolTask — required-argument precondition', () => {
  it('reports the missing argument without dispatching the call', async () => {
    let dispatched = false;
    const runtime = {
      run: async () => {
        dispatched = true;
        return { outcome: { status: 'completed' as const, summary: 'never' } };
      },
    };
    const task: TaskNode = {
      id: 'T1',
      label: 'Walk footage',
      effect: { kind: 'host_tool', name: 'describe_footage', args: {} },
      resource: 'host',
      priority: 'edit',
      deps: [],
    };
    const result = await runHostToolTask(task, {
      runtime: runtime as unknown as Parameters<typeof runHostToolTask>[1]['runtime'],
      project: makeProject(),
      emit: emitter(),
      now: () => 1000,
    });
    expect(dispatched).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.output.summary).toContain('assetId');
    // Nothing to fold into the semantic index — and no engine payload to echo.
    expect(result.output.data).toBeUndefined();
  });

  it('names every missing argument, plural, in one message', async () => {
    const runtime = {
      run: async () => ({ outcome: { status: 'completed' as const, summary: '' } }),
    };
    const task: TaskNode = {
      id: 'T1',
      label: 'Trim',
      effect: { kind: 'host_tool', name: 'trim_clip', args: {} },
      resource: 'host',
      priority: 'edit',
      deps: [],
    };
    const result = await runHostToolTask(task, {
      runtime: runtime as unknown as Parameters<typeof runHostToolTask>[1]['runtime'],
      project: makeProject(),
      emit: emitter(),
      now: () => 1000,
    });
    expect(result.output.summary).toMatch(/clipId/);
    expect(result.output.summary).toMatch(/them\.$/);
  });
});
