/**
 * P1.2 — independent analysis effects overlap, and a mutation between them does not.
 *
 * ADR 0150 parallelized acquisition (`add_stock`/`add_music`). The same E1 batching
 * mechanism already covers independent ANALYSIS effects — `detect_beats` on the placed
 * music track and `analyze_silence` on the picture are both `pure_read` in
 * `tool-contract.ts`, so a turn that asks for both runs them against the bounded pool.
 * Nothing in the suite pinned that, which is how a single `serialOnly` or `mutates` flag
 * on a future analysis tool could quietly take it away.
 *
 * The second test pins the ORDERING contract the first one relies on: a mutating call
 * between two reads ends the batch. That is not a limitation to be optimized away — the
 * turn's speculative working copy is threaded call-to-call, so a read hoisted across a
 * mutation would answer about a timeline that no longer exists.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from './providers/types.js';
import type { HostToolOutcome } from './tool-executor.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import { makeProject } from './__fixtures__/project.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'cut this to the music' };
const opts = (): StreamOptions => ({ conversationId: 'c', turnId: 't', now: () => 1000 });

class OneTurnProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public constructor(private readonly calls: readonly ToolCall[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    return this.index === 1 ? { text: 'analysing', toolCalls: [...this.calls] } : { text: 'done' };
  }
}

/** A host that takes real time and records how many analyses were in flight at once. */
function recordingHost(delayMs: number) {
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  return {
    peak: () => peak,
    started,
    run: async (call: ToolCall): Promise<HostToolOutcome> => {
      started.push(call.name);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return { status: 'completed', summary: `${call.name} done`, data: {} };
    },
  };
}

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const beats: ToolCall = { id: 'a', name: 'detect_beats', arguments: { assetId: 'asset_1' } };
const silence: ToolCall = { id: 'b', name: 'analyze_silence', arguments: { assetId: 'asset_1' } };
const scenes: ToolCall = { id: 'c', name: 'detect_scenes', arguments: { assetId: 'asset_1' } };
const trim: ToolCall = {
  id: 'm',
  name: 'trim_clip',
  arguments: { clipId: 'clip_a', start: 0, end: 4 },
};

describe('independent analysis effects (P1.2)', () => {
  it('runs detect_beats, analyze_silence and detect_scenes in one concurrent batch', async () => {
    const host = recordingHost(25);
    await drain(
      new Orchestrator(new OneTurnProvider([beats, silence, scenes]), {
        executor: { run: host.run as never },
      }).streamAgent(input, opts(), { maxSteps: 3 }),
    );
    expect(new Set(host.started)).toEqual(
      new Set(['detect_beats', 'analyze_silence', 'detect_scenes']),
    );
    expect(host.peak()).toBeGreaterThan(1);
  });

  it('does not hoist an analysis across a mutation — the working copy is threaded', async () => {
    const host = recordingHost(20);
    await drain(
      new Orchestrator(new OneTurnProvider([beats, trim, silence]), {
        executor: { run: host.run as never },
      }).streamAgent(input, opts(), { maxSteps: 3 }),
    );
    // Both analyses ran, but never together: the mutation between them closed the batch.
    expect(host.started).toEqual(['detect_beats', 'analyze_silence']);
    expect(host.peak()).toBe(1);
  });
});
