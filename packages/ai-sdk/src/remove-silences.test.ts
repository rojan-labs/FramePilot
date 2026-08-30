import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { AiCompletionRequest, AiProvider, AiResponse, ProviderChunk } from './providers/types.js';
import type { HostToolExecutor } from './tool-executor.js';
import { Orchestrator } from './orchestrator.js';
import { makeProject } from './__fixtures__/project.js';

/** One turn that calls remove_silences, then a closing turn with no calls. */
function scriptedProvider(): AiProvider {
  let turns = 0;
  return {
    name: 'mock',
    async complete(): Promise<AiResponse> {
      return { text: 'Done.', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream(_request: AiCompletionRequest): AsyncGenerator<ProviderChunk> {
      turns += 1;
      if (turns === 1) {
        yield {
          type: 'tool-call',
          call: { id: 'call_1', name: 'remove_silences', arguments: { minSilenceSeconds: 0.5, keepSeconds: 0.1 } },
        };
        yield { type: 'done', text: '' };
        return;
      }
      yield { type: 'text-delta', text: 'The dead air is gone.' };
      yield { type: 'done', text: 'The dead air is gone.' };
    },
  };
}

const longClipProject = (): Project => {
  const base = makeProject();
  return {
    ...base,
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 60 }],
    timeline: {
      ...base.timeline,
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            { id: 'clip_a', assetId: 'asset_1', trackId: 'video_1', start: 0, end: 60, sourceStart: 0, sourceEnd: 60, effects: [], keyframes: [] },
          ],
        },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
  } as Project;
};

describe('remove_silences (plan/system-mission P4.1)', () => {
  it('turns one measurement into ripple deletes, last to first, and reports the seconds removed', async () => {
    const executor: HostToolExecutor = {
      async run(call) {
        expect(call.name).toBe('remove_silences');
        return {
          status: 'completed',
          summary: 'Found 2 silent ranges',
          data: { assetId: 'asset_1', ranges: [{ start: 10, end: 12 }, { start: 30, end: 34 }] },
        };
      },
    };
    const orchestrator = new Orchestrator(scriptedProvider(), { executor });
    const events = [];
    for await (const event of orchestrator.streamAgent(
      { project: longClipProject(), userPrompt: 'remove the dead air' },
      { conversationId: 'c', turnId: 't' },
      {},
    )) events.push(event);
    const diffs = events.filter((e) => e.type === 'diff' && e.edit.validation.valid);
    expect(diffs.length).toBeGreaterThan(0);
    const ops = diffs.flatMap((d) => (d as { edit: { patch: { operations: { type: string; start?: number }[] } } }).edit.patch.operations);
    const ripple = ops.filter((o) => o.type === 'ripple_delete');
    expect(ripple.map((o) => o.start)).toEqual([30.1, 10.1]);
    const results = events.filter((e) => e.type === 'tool_result') as { summary?: string }[];
    expect(results.some((r) => /Removed 2 silence\(s\), 5\.6s/.test(r.summary ?? ''))).toBe(true);
  });

  it('reports a warning, not an edit, when nothing measured is long enough to cut', async () => {
    const executor: HostToolExecutor = {
      async run() {
        return { status: 'completed', summary: 'Found 1 silent range', data: { assetId: 'asset_1', ranges: [{ start: 10, end: 10.4 }] } };
      },
    };
    const orchestrator = new Orchestrator(scriptedProvider(), { executor });
    const events = [];
    for await (const event of orchestrator.streamAgent(
      { project: longClipProject(), userPrompt: 'remove the dead air' },
      { conversationId: 'c', turnId: 't' },
      {},
    )) events.push(event);
    expect(events.some((e) => e.type === 'diff' && e.edit.validation.valid)).toBe(false);
    const results = events.filter((e) => e.type === 'tool_result') as { summary?: string }[];
    expect(results.some((r) => /No dead air to cut/.test(r.summary ?? ''))).toBe(true);
  });
});
