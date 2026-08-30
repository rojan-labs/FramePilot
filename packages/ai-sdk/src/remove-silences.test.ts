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

  /** Run the scripted turn against one canned measurement and collect the tool results. */
  async function runWith(data: unknown): Promise<{ summaries: string[]; edited: boolean }> {
    const executor: HostToolExecutor = {
      async run() {
        return { status: 'completed', summary: 'measured', data };
      },
    };
    const orchestrator = new Orchestrator(scriptedProvider(), { executor });
    const events = [];
    for await (const event of orchestrator.streamAgent(
      { project: longClipProject(), userPrompt: 'remove the dead air' },
      { conversationId: 'c', turnId: 't' },
      {},
    )) events.push(event);
    return {
      edited: events.some((e) => e.type === 'diff' && e.edit.validation.valid),
      summaries: (events.filter((e) => e.type === 'tool_result') as { summary?: string }[]).map(
        (r) => r.summary ?? '',
      ),
    };
  }

  it('reports what was measured, not "no dead air", when nothing reaches the threshold', async () => {
    // The 49.77s talking head from the run this fixes, scaled to the fixture: every gap
    // is real dead air, none is 0.5s long. The old note claimed "0 silence(s) measured",
    // which the model read as "this recording has no dead air".
    const { edited, summaries } = await runWith({
      assetId: 'asset_1',
      ranges: [],
      measuredCount: 56,
      longestSeconds: 0.449,
      belowThresholdSeconds: 10.65,
      probeFloorSeconds: 0.1,
    });
    expect(edited).toBe(false);
    const note = summaries.find((s) => s.includes('Nothing to cut'));
    expect(note).toBeDefined();
    expect(note).toContain('56 silence(s) were measured');
    expect(note).toContain('longest is 0.449s');
    expect(note).toContain('minSilenceSeconds: 0.25');
    expect(summaries.every((s) => !s.includes('No dead air'))).toBe(true);
  });

  it('passes the engine reason through instead of inferring a tight recording', async () => {
    const { edited, summaries } = await runWith({
      assetId: 'asset_1',
      ranges: [],
      reason: 'a.mp4 has no audio track, so there is no silence to detect.',
    });
    expect(edited).toBe(false);
    expect(summaries).toContain('a.mp4 has no audio track, so there is no silence to detect.');
  });

  it('cuts a silence the old double-threshold silently kept', async () => {
    // 0.6s measured, cut at minSilenceSeconds 0.5 with keepSeconds 0.1: the old code
    // re-tested the trimmed 0.4s span and dropped it, so the effective floor was 0.7s.
    const { edited, summaries } = await runWith({
      assetId: 'asset_1',
      ranges: [{ start: 10, end: 10.6 }],
      measuredCount: 1,
      longestSeconds: 0.6,
      belowThresholdSeconds: 0,
      probeFloorSeconds: 0.1,
    });
    expect(edited).toBe(true);
    expect(summaries.some((s) => /Removed 1 silence\(s\)/.test(s))).toBe(true);
  });
});
