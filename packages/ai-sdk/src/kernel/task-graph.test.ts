/** Tests for the Task DAG (kernel/task-graph.ts, Phase K3.1). */
import { describe, expect, it } from 'vitest';
import {
  type TaskNode,
  buildTaskGraph,
  readyTasks,
  TaskGraphError,
  topologicalOrder,
} from './task-graph.js';

const node = (id: string, deps: string[] = [], over: Partial<TaskNode> = {}): TaskNode => ({
  id,
  label: id,
  effect: { kind: 'analysis', name: id },
  resource: 'pure',
  priority: 'edit',
  deps,
  ...over,
});

describe('buildTaskGraph', () => {
  it('builds a graph with an id lookup', () => {
    const g = buildTaskGraph([node('T1'), node('T2', ['T1'])]);
    expect(g.nodes).toHaveLength(2);
    expect(g.byId.get('T2')?.deps).toEqual(['T1']);
  });

  it('rejects duplicate ids', () => {
    expect(() => buildTaskGraph([node('T1'), node('T1')])).toThrow(TaskGraphError);
    expect(() => buildTaskGraph([node('T1'), node('T1')])).toThrow('Duplicate task id "T1"');
  });

  it('rejects a dep on an unknown task', () => {
    expect(() => buildTaskGraph([node('T1', ['ghost'])])).toThrow('unknown task "ghost"');
  });

  it('rejects a self-dependency', () => {
    expect(() => buildTaskGraph([node('T1', ['T1'])])).toThrow('depends on itself');
  });

  it('rejects a cycle', () => {
    expect(() => buildTaskGraph([node('A', ['B']), node('B', ['A'])])).toThrow('has a cycle');
  });
});

describe('topologicalOrder', () => {
  it('orders dependencies before dependants, stable by graph order', () => {
    const g = buildTaskGraph([
      node('T1'),
      node('T2', ['T1']),
      node('T3', ['T1']),
      node('T4', ['T2', 'T3']),
    ]);
    expect(topologicalOrder(g)).toEqual(['T1', 'T2', 'T3', 'T4']);
  });

  it('keeps independent roots in graph order', () => {
    const g = buildTaskGraph([node('A'), node('B'), node('C', ['A', 'B'])]);
    expect(topologicalOrder(g)).toEqual(['A', 'B', 'C']);
  });
});

describe('readyTasks', () => {
  const g = buildTaskGraph([
    node('T1', [], { priority: 'analysis' }),
    node('T2', [], { priority: 'edit' }),
    node('T3', ['T1', 'T2']),
  ]);

  it('returns tasks whose deps are all satisfied, in priority then graph order', () => {
    const ready = readyTasks(g, new Set(), new Set());
    // Both roots ready; edit (T2) outranks analysis (T1).
    expect(ready.map((n) => n.id)).toEqual(['T2', 'T1']);
  });

  it('excludes completed and in-flight tasks', () => {
    const ready = readyTasks(g, new Set(['T2']), new Set(['T1']));
    expect(ready).toEqual([]); // T3 still blocked on T1
  });

  it('unblocks a dependant once every dep has completed', () => {
    expect(readyTasks(g, new Set(['T1', 'T2']), new Set()).map((n) => n.id)).toEqual(['T3']);
  });

  it('breaks priority ties by original graph order', () => {
    const flat = buildTaskGraph([node('A'), node('B'), node('C')]); // all edit
    expect(readyTasks(flat, new Set(), new Set()).map((n) => n.id)).toEqual(['A', 'B', 'C']);
  });
});
