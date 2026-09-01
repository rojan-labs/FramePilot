import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { AiCompletionRequest, AiProvider, AiResponse, ProviderChunk } from './providers/types.js';
import type { HostToolExecutor } from './tool-executor.js';
import { Orchestrator } from './orchestrator.js';
import { makeProject } from './__fixtures__/project.js';
import { AGENT_MAX_OPS_PER_TURN } from './kernel/conductor.js';

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

/**
 * A long interview is the length this tool exists for, and its op count is a fact
 * about the recording: one `ripple_delete` per measured silence. Charged against the
 * blast-radius bound that exists to stop a runaway MODEL, that count refused a long
 * interview for being long — the same defect, for the same reason, as the one that made
 * captioning a 50-second talking head impossible.
 *
 * The first version of the derived-fan-out fix stamped only the generic `operationsFor`
 * path and missed the four host-backed branches; `remove_silences` is the one where that
 * mattered, and this is the test that would have caught it.
 */
describe('remove_silences on a long recording', () => {
  const twentyMinuteProject = (): Project => {
    const base = makeProject();
    return {
      ...base,
      assets: [{ id: 'asset_1', path: 'media/talk.mp4', kind: 'video', durationSeconds: 600 }],
      timeline: {
        ...base.timeline,
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
                end: 1200,
                sourceStart: 0,
                sourceEnd: 1200,
                effects: [],
                keyframes: [],
              },
            ],
          },
          { id: 'audio_1', type: 'audio', clips: [] },
        ],
      },
    } as Project;
  };

  it('cuts more silences in one turn than a model is allowed to compose', async () => {
    // A realistic density for twenty minutes of interview: a pause every ~5 seconds. The
    // count is what makes this the test — it must clear `AGENT_MAX_OPS_PER_TURN`, or the
    // bound is never exercised and the test passes with or without the fix.
    const ranges = Array.from({ length: 230 }, (_, i) => ({
      start: 3 + i * 5,
      end: 3 + i * 5 + 0.9,
    }));
    const executor: HostToolExecutor = {
      async run() {
        return {
          status: 'completed',
          summary: `Found ${String(ranges.length)} silent ranges`,
          data: { assetId: 'asset_1', ranges },
        };
      },
    };
    const events = [];
    for await (const event of new Orchestrator(scriptedProvider(), { executor }).streamAgent(
      { project: twentyMinuteProject(), userPrompt: 'remove the dead air' },
      { conversationId: 'c', turnId: 't' },
      {},
    ))
      events.push(event);

    // More operations than the per-turn bound allows a model to compose — and every one
    // of them dictated by the measurement, not chosen.
    const diffs = events.filter((e) => e.type === 'diff' && e.edit.validation.valid);
    const ops = diffs.flatMap(
      (d) => (d as { edit: { patch: { operations: { type: string }[] } } }).edit.patch.operations,
    );
    expect(ranges.length).toBeGreaterThan(AGENT_MAX_OPS_PER_TURN);
    expect(ops.filter((o) => o.type === 'ripple_delete').length).toBe(ranges.length);

    // And the run must not report the bound, or the empty-run notice, at all.
    const warnings = events
      .filter((e) => e.type === 'warning')
      .map((e) => (e as { text: string }).text)
      .join('\n');
    expect(warnings).not.toMatch(/per-turn cap/);
    expect(warnings).not.toMatch(/couldn't be applied/);
  });
});
