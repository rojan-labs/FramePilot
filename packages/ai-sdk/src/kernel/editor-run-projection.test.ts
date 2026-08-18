import { describe, expect, it } from 'vitest';
import type { AiEvent } from '../events.js';
import { reduceEditorRunStageEvent, type EditorRunStageEvent } from './editor-run-lifecycle.js';
import { EditorRunLifecycleProjector } from './editor-run-projection.js';

const base = { id: 'event', conversationId: 'conversation', turnId: 'turn', ts: 1000 } as const;

describe('EditorRun lifecycle projection', () => {
  it('projects a legacy edit into a valid, ordered, terminal side channel', () => {
    const emitted: EditorRunStageEvent[] = [];
    const projector = new EditorRunLifecycleProjector({
      runId: 'run_projection',
      route: 'edit',
      now: () => 1000,
      emit: (event) => emitted.push(event),
    });

    projector.observe({ ...base, type: 'reasoning', summaries: ['Understand'], done: true });
    projector.observe({ ...base, type: 'plan', steps: [] });
    projector.observe({
      ...base,
      type: 'diff',
      edit: {
        patch: { patchId: 'patch', createdBy: 'agent', reason: 'test', operations: [] },
        inversePatch: { patchId: 'inverse', createdBy: 'agent', reason: 'undo', operations: [] },
        summary: 'No-op fixture',
      },
    } as AiEvent);
    projector.observe({ ...base, type: 'status', status: 'completed' });

    expect(emitted.map((event) => event.sequence)).toEqual(
      Array.from({ length: emitted.length }, (_, index) => index + 1),
    );
    expect(
      emitted.filter((event) => event.state === 'completed').map((event) => event.stage),
    ).toEqual([
      'understand',
      'resolve',
      'inspect',
      'plan',
      'compile',
      'execute',
      'verify',
      'review',
      'finalize',
    ]);
    expect(projector.snapshot().terminal).toBe(true);
    expect(projector.snapshot().activeStage).toBeUndefined();

    let replay = {
      runId: 'run_projection',
      route: 'edit' as const,
      sequence: 0,
      completedStages: [],
      repairAttempt: 0,
      terminal: false,
    };
    for (const event of emitted) replay = reduceEditorRunStageEvent(replay, event);
    expect(replay).toEqual(projector.snapshot());
  });

  it('records cancellation as terminal without fabricating finalize', () => {
    const emitted: EditorRunStageEvent[] = [];
    const projector = new EditorRunLifecycleProjector({
      runId: 'run_cancelled',
      route: 'agent',
      now: () => 2000,
      emit: (event) => emitted.push(event),
    });

    projector.observe({ ...base, type: 'status', status: 'cancelled' });

    expect(emitted.at(-1)).toMatchObject({
      stage: 'understand',
      state: 'cancelled',
      reason: 'cancelled',
    });
    expect(emitted.some((event) => event.stage === 'finalize')).toBe(false);
    expect(projector.snapshot().terminal).toBe(true);
  });

  it('fails the active stage when a route exits without a terminal event', () => {
    const emitted: EditorRunStageEvent[] = [];
    const projector = new EditorRunLifecycleProjector({
      runId: 'run_broken',
      route: 'agent',
      now: () => 3000,
      emit: (event) => emitted.push(event),
    });

    projector.finishWithoutTerminal('driver ended');

    expect(emitted.at(-1)).toMatchObject({ state: 'failed', reason: 'driver ended' });
  });
});
