/**
 * P7.3's main deliverable (plan/AGENT-NATIVE-COMPLETION-PLAN.md P7.3): a determinism
 * regression test proving `createRecordingEffectRuntime` → `createReplayEffectRuntime`
 * reproduces a real run's effects with **zero** provider/host calls.
 *
 * This used to drive a planner `TaskGraph` through `executePlannedEdit`. That route was
 * retired (ADR 0126), so the same property is now proved against the runtime that
 * survived: a real agent run is recorded through the orchestrator's `recordEffects` wiring,
 * and every recorded effect is then replayed through a `createReplayEffectRuntime` that
 * holds no provider/executor reference AT ALL — not merely one that happens not to be
 * called — and must settle byte-identically.
 *
 * A second test proves the P7.3 *wiring* itself: `Orchestrator`'s `recordEffects` option,
 * off by default, hands a real `RunRecording` to `onRecording` when turned on.
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../../__fixtures__/project.js';
import type { ContextInput } from '../../context-builder.js';
import { Orchestrator } from '../../orchestrator.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ToolCall,
} from '../../providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from '../../tool-executor.js';
import type { RuntimeEffect } from '../effects.js';
import {
  ReplayDivergenceError,
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

const silenceExecutor: HostToolExecutor = {
  async run(call: ToolCall): Promise<HostToolOutcome> {
    if (call.name !== 'analyze_silence') return { status: 'failed', summary: 'unexpected tool' };
    return { status: 'completed', summary: 'ok', data: { ranges: [{ start: 2, end: 3 }] } };
  },
};


/** The agent script for the recorded run: analyse, ripple the gap out, then stop. */
const AGENT_SCRIPT: readonly AiResponse[] = [
  { text: '', toolCalls: [{ id: 'c1', name: 'analyze_silence', arguments: { assetId: 'asset_1' } }] },
  {
    text: '',
    toolCalls: [{ id: 'c2', name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
  },
  { text: 'Done.', toolCalls: [] },
];

/** A provider that serves scripted tool-calling turns, repeating the last one. */
class ScriptedAgentProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public calls = 0;
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    const turn = AGENT_SCRIPT[Math.min(this.calls, AGENT_SCRIPT.length - 1)]!;
    this.calls += 1;
    return turn;
  }
}

/** Record a real agent run's effects through the orchestrator's `recordEffects` wiring. */
async function recordAgentRun(): Promise<{
  recording: RunRecording;
  providerCalls: number;
}> {
  const provider = new ScriptedAgentProvider();
  let captured: RunRecording | undefined;
  const orch = new Orchestrator(provider, {
    executor: silenceExecutor,
    recordEffects: true,
    onRecording: (recording) => {
      captured = recording;
    },
  });
  const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the start' };
  await orch.agent(input, { maxSteps: 3, autoRepair: false });
  if (!captured) throw new Error('the orchestrator recorded nothing');
  return { recording: captured, providerCalls: provider.calls };
}

describe('replay determinism (P7.3) — record a real run, replay with zero provider/host calls', () => {
  it('serves every recorded effect in order, from the recording alone', async () => {
    const { recording, providerCalls } = await recordAgentRun();
    expect(recording.effects.length).toBeGreaterThan(0);
    expect(providerCalls).toBeGreaterThan(0);

    // The replay runtime is constructed from the recording ALONE — it never receives a
    // provider or an executor, so a fall-through to a live call is not merely unlikely,
    // it is unrepresentable.
    const replayRuntime = createReplayEffectRuntime(recording);
    const replayed = [];
    for (const recorded of recording.effects) {
      replayed.push(await replayRuntime.run({ kind: recorded.kind } as RuntimeEffect));
    }
    expect(replayed).toEqual(recording.effects.map((effect) => effect.result));
  });

  it('refuses to serve a run that diverges from what was recorded', async () => {
    // The load-bearing half of determinism. Returning recorded results in order is easy;
    // what makes a replay trustworthy is that it FAILS when the run stops matching, rather
    // than handing back a result belonging to a different effect.
    const { recording } = await recordAgentRun();
    const replayRuntime = createReplayEffectRuntime(recording);
    const wrongKind = recording.effects[0]?.kind === 'model' ? 'host_tool' : 'model';
    await expect(
      replayRuntime.run({ kind: wrongKind } as RuntimeEffect),
    ).rejects.toThrow(ReplayDivergenceError);
  });

  it('refuses to over-run the end of the recording', async () => {
    const { recording } = await recordAgentRun();
    const replayRuntime = createReplayEffectRuntime(recording);
    for (const recorded of recording.effects) {
      await replayRuntime.run({ kind: recorded.kind } as RuntimeEffect);
    }
    const lastKind = recording.effects.at(-1)?.kind ?? 'model';
    await expect(replayRuntime.run({ kind: lastKind } as RuntimeEffect)).rejects.toThrow(
      ReplayDivergenceError,
    );
  });

  it('records a run that actually reached the host and the model, not an empty trace', async () => {
    // Guards the test above against passing vacuously on a recording of nothing: a run
    // whose effects never included a host tool would "replay identically" while proving
    // nothing about determinism across the two collaborator kinds.
    const { recording } = await recordAgentRun();
    const kinds = new Set(recording.effects.map((effect) => effect.kind));
    expect(kinds.has('host_tool')).toBe(true);
    expect(recording.effects.some((effect) => effect.result.kind === 'host_tool')).toBe(true);
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
