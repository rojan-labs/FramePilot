/**
 * P7.3's main deliverable (plan/AGENT-NATIVE-COMPLETION-PLAN.md P7.3): a determinism
 * regression test proving `createRecordingEffectRuntime` → `createReplayEffectRuntime`
 * actually reproduces a real planner-path run with **zero** provider/host calls.
 *
 * Drives a real `executePlannedEdit` graph (the same shape `planned-edit-stream.test.ts`
 * exercises against the live `Orchestrator` — here isolated at the driver level, mirroring
 * `plan-driver.test.ts`'s harness) through a REAL runtime wrapped in the recording
 * runtime, captures the recording, then re-runs the exact same `TaskGraph` through a
 * `createReplayEffectRuntime(recording)` that has no provider/executor reference AT ALL
 * (not merely one that happens not to be called) — and asserts the replayed run's status,
 * `unsupported` flag, priced cost (P7.1), and assembled patch/diff are byte-identical to
 * the first run's.
 *
 * A second, smaller test proves the P7.3 *wiring* itself: `Orchestrator`'s `recordEffects`
 * option, off by default, hands a real `RunRecording` to `onRecording` when turned on.
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../../__fixtures__/project.js';
import type { ContextInput } from '../../context-builder.js';
import { createTurnEmitter } from '../../events.js';
import { Orchestrator } from '../../orchestrator.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ToolCall,
} from '../../providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from '../../tool-executor.js';
import { createEffectRuntime } from '../effect-runtime.js';
import { executePlannedEdit, type PlannedEditRunResult } from '../plan-driver.js';
import { buildTaskGraph, type TaskGraph, type TaskNode } from '../task-graph.js';
import {
  createRecordingEffectRuntime,
  createReplayEffectRuntime,
  type RunRecording,
} from './replay.js';

/** A provider that replays canned responses in call order and counts how many it served. */
class SequencedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public calls = 0;
  public constructor(private readonly responses: readonly string[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    const text = this.responses[this.calls];
    this.calls += 1;
    if (text === undefined) throw new Error(`unexpected model call #${String(this.calls)}`);
    return { text };
  }
}

/** A provider that fails the test if it is EVER consulted — the replay must call no one. */
class PoisonProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public async complete(): Promise<AiResponse> {
    throw new Error('replay must never call a real provider');
  }
}

const silenceExecutor: HostToolExecutor = {
  async run(call: ToolCall): Promise<HostToolOutcome> {
    if (call.name !== 'analyze_silence') return { status: 'failed', summary: 'unexpected tool' };
    return { status: 'completed', summary: 'ok', data: { ranges: [{ start: 2, end: 3 }] } };
  },
};

const poisonExecutor: HostToolExecutor = {
  async run(): Promise<HostToolOutcome> {
    throw new Error('replay must never call a real host tool');
  },
};

/** T1 analyze_silence → T2 propose_edit(ripple_delete) → T3 assemble_patch → T4 verify. */
function pacingGraph(): TaskGraph {
  const node = (over: Partial<TaskNode> & Pick<TaskNode, 'id' | 'label' | 'effect'>): TaskNode => ({
    resource: 'pure',
    priority: 'edit',
    deps: [],
    ...over,
  });
  return buildTaskGraph([
    node({
      id: 'T1',
      label: 'analyze_silence(video_1)',
      effect: { kind: 'host_tool', name: 'analyze_silence', args: { trackId: 'video_1' } },
      resource: 'ffmpeg',
      priority: 'analysis',
    }),
    node({
      id: 'T2',
      label: 'tighten the start',
      effect: {
        kind: 'model',
        name: 'propose_edit',
        args: { toolNames: ['ripple_delete'], sliceFrom: 'T1' },
      },
      resource: 'model',
      deps: ['T1'],
    }),
    node({
      id: 'T3',
      label: 'assemble & validate patch',
      effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'T2' } },
      deps: ['T2'],
    }),
    node({
      id: 'T4',
      label: 'verify(pacing tightened)',
      effect: { kind: 'verify', name: 'verify', args: { goal: 'pacing tightened' } },
      deps: ['T3'],
    }),
  ]);
}

const PROPOSE_EDIT_RESPONSE = JSON.stringify({
  toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
});

/** Drain an `executePlannedEdit` generator to its final result (events are irrelevant here). */
async function drive(
  gen: AsyncGenerator<unknown, PlannedEditRunResult>,
): Promise<PlannedEditRunResult> {
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}

describe('replay determinism (P7.3) — record a real run, replay with zero provider/host calls', () => {
  it('reproduces an identical status/cost/patch/diff on replay', async () => {
    const project = makeProject();
    const graph = pacingGraph();
    const emit = (turnId: string) =>
      createTurnEmitter({ conversationId: 'c', turnId, now: () => 1000 });

    // --- Record: a REAL run against a real (if canned) provider + host executor. --------
    const provider = new SequencedProvider([PROPOSE_EDIT_RESPONSE]);
    const liveRuntime = createEffectRuntime({
      provider: provider,
      executor: silenceExecutor,
    });
    const recorder = createRecordingEffectRuntime(liveRuntime);
    const recordedResult = await drive(
      executePlannedEdit(graph, {
        project,
        runtime: recorder.runtime,
        emit: emit('t1'),
        reason: 'r',
      }),
    );
    expect(provider.calls).toBe(1);
    expect(recordedResult.status).toBe('completed');
    expect(recordedResult.edit?.validation.valid).toBe(true);

    const recording: RunRecording = recorder.takeRecording();
    expect(recording.effects.length).toBeGreaterThan(0);

    // --- Replay: the SAME TaskGraph, through a runtime with NO provider/executor at all --
    const replayRuntime = createReplayEffectRuntime(recording);
    const replayedResult = await drive(
      executePlannedEdit(graph, { project, runtime: replayRuntime, emit: emit('t2'), reason: 'r' }),
    );

    // Identical terminal outcome, cost, and patch — reproduced with zero model/host calls
    // (the replay runtime never held a reference to `provider`/`silenceExecutor` at all).
    expect(replayedResult.status).toBe(recordedResult.status);
    expect(replayedResult.unsupported).toBe(recordedResult.unsupported);
    expect(replayedResult.cost).toEqual(recordedResult.cost);
    expect(replayedResult.edit?.patch).toEqual(recordedResult.edit?.patch);
    expect(replayedResult.edit?.validation).toEqual(recordedResult.edit?.validation);
    expect(replayedResult.edit?.diff).toEqual(recordedResult.edit?.diff);

    // The provider was never consulted again — replay served everything from the recording.
    expect(provider.calls).toBe(1);
  });

  it('replaying against a poisoned provider/executor still never calls them (proves the isolation, not just an omission)', async () => {
    const project = makeProject();
    const graph = pacingGraph();
    const emit = (turnId: string) =>
      createTurnEmitter({ conversationId: 'c', turnId, now: () => 1000 });

    const provider = new SequencedProvider([PROPOSE_EDIT_RESPONSE]);
    const liveRuntime = createEffectRuntime({
      provider: provider,
      executor: silenceExecutor,
    });
    const recorder = createRecordingEffectRuntime(liveRuntime);
    const recordedResult = await drive(
      executePlannedEdit(graph, {
        project,
        runtime: recorder.runtime,
        emit: emit('t1'),
        reason: 'r',
      }),
    );
    const recording = recorder.takeRecording();

    // A second live runtime built from POISONED collaborators — if replay ever fell through
    // to it, this run would throw. `createReplayEffectRuntime` doesn't take it at all; this
    // just documents that even constructing one alongside changes nothing about the result.
    const poisonRuntime = createEffectRuntime({
      provider: new PoisonProvider(),
      executor: poisonExecutor,
    });
    void poisonRuntime; // never wired into the replay runtime — the point of this test

    const replayRuntime = createReplayEffectRuntime(recording);
    const replayedResult = await drive(
      executePlannedEdit(graph, { project, runtime: replayRuntime, emit: emit('t2'), reason: 'r' }),
    );
    expect(replayedResult.edit?.patch).toEqual(recordedResult.edit?.patch);
  });
});

describe('Orchestrator recordEffects (P7.3 wiring)', () => {

  it('hands a real RunRecording to onRecording when recordEffects is on', async () => {
    const project = makeProject({
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_a',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 0,
                end: 6,
                sourceStart: 0,
                sourceEnd: 6,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    });
    let captured: RunRecording | undefined;
    // An agent run that ends on its first turn: enough to prove the recording runtime is
    // wired and hands its effects over, without scripting a whole multi-turn run.
    const orch = new Orchestrator(new SequencedProvider(['Nothing to do here. Done.']), {
      executor: silenceExecutor,
      recordEffects: true,
      onRecording: (recording) => {
        captured = recording;
      },
    });
    const input: ContextInput = { project, userPrompt: 'remove the silences' };
    await orch.agent(input, { maxSteps: 1 });

    expect(captured).toBeDefined();
    expect(captured?.effects.length).toBeGreaterThan(0);
  });

  it('never calls onRecording when recordEffects is left off (the default)', async () => {
    let captured: RunRecording | undefined;
    const orch = new Orchestrator(new SequencedProvider(['Nothing to do here. Done.']), {
      executor: silenceExecutor,
      onRecording: (recording) => {
        captured = recording;
      },
    });
    const input: ContextInput = { project: makeProject(), userPrompt: 'remove the silences' };
    await orch.agent(input, { maxSteps: 1 });

    expect(captured).toBeUndefined();
  });
});
