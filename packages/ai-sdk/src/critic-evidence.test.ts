/**
 * The critic sees what the run saw (context-management P4.3).
 *
 * A continuity check needs the same footage knowledge the planning turns had. Until this
 * landed, the critic got a THINNER view than the planner did: a run that could read the
 * whole transcript while planning saw only the timeline while reviewing, and would approve
 * cuts it would have rejected. That is a context-management defect, not an editing one,
 * which is why Phase 4 lives in this plan rather than a separate editing-quality one.
 *
 * The observable form of the fix: a check fires on evidence the run gathered turns
 * earlier, and CITES the handle in its detail — so the editor, and the next turn, can go
 * and read it. A finding that asserts a number from nowhere is the same broken promise
 * `clearedWithHandle` was written to end.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { ContextInput } from './context-builder.js';
import { Orchestrator } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from './tool-executor.js';

const FPS = 30;

/** A six-second take whose speech does not begin until four seconds in. */
function silentHeadProject(): Project {
  return parseProject({
    id: 'proj_dead',
    name: 'Dead air',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/take.mp4', kind: 'video', durationSeconds: 30 }],
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
      revision: 1,
    },
    transcript: [{ word: 'hello', start: 4, end: 4.5 }],
    aiMemory: {},
    history: [],
  });
}

/** Turn 1 measures silence; turn 2 stops. The critic runs after both. */
class SilenceThenStop implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    if (this.index === 1) {
      return {
        text: 'Measuring the silence.',
        toolCalls: [{ id: 'c1', name: 'analyze_silence', arguments: { assetId: 'asset_1' } }],
      };
    }
    return { text: 'Done.', toolCalls: [] };
  }
}

const silenceExecutor: HostToolExecutor = {
  async run(call): Promise<HostToolOutcome> {
    if (call.name !== 'analyze_silence') {
      return { status: 'failed', summary: `no route for ${call.name}` };
    }
    return {
      status: 'completed',
      summary: 'Found 1 silent range',
      data: { assetId: 'asset_1', ranges: [{ start: 0, end: 4, duration: 4 }] },
    };
  },
};

describe('a check fires on evidence the run gathered turns earlier', () => {
  it('cites the handle the silence was filed under', async () => {
    const input: ContextInput = {
      project: silentHeadProject(),
      userPrompt: 'tighten the top of this',
    };
    const run = await new Orchestrator(new SilenceThenStop(), {
      executor: silenceExecutor,
    }).agent(input, { maxSteps: 3, autoRepair: false });
    const deadAir = run.critique.checks.find((c) => c.id === 'dead_air')!;
    // The finding is there…
    expect(deadAir.status).toBe('warn');
    expect(deadAir.detail).toContain('frames');
    // …and it cites the handle the run filed its silence measurement under, two turns
    // earlier. An editor (and the next turn) can go and read ev_1; a bare number is
    // something they have to take on trust.
    expect(deadAir.detail).toMatch(/ev_\d+/);
  });

  it('still reports dead air when no silence evidence exists, without pretending to cite', async () => {
    // The check can always answer from the mapped transcript, so the evidence is a
    // SHARPENING rather than a dependency — but with none gathered it must not invent a
    // handle. `critique` alone (the standalone review route) has no run behind it.
    const { critique } = await import('./critic.js');
    const found = critique(silentHeadProject()).checks.find((c) => c.id === 'dead_air')!;
    expect(found.status).toBe('warn');
    expect(found.detail).toContain('120 frames');
    expect(found.detail).not.toMatch(/ev_\d+/);
  });
});
