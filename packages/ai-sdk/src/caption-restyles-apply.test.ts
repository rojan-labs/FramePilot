/**
 * Every distinct caption restyle applies — there is no per-run count.
 *
 * A five-restyle cap per track used to refuse the sixth (run fb90e58d restyled one track ten
 * times while a renderer placement bug, since fixed, made every style look wrong). Desktop run
 * `001be135` paid for it: a Hindi caption track was restyled five times while the run looked
 * for why its accent font did not show, and the sixth — a NEW keyword accent the editor had
 * just chosen through ask_user — was refused with "Stop restyling". A byte-identical repeat
 * that changes nothing is still withheld as "already done"; a count of distinct choices says
 * nothing about whether the next one is right.
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import type { ContextInput } from './context-builder.js';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';

function captionProject() {
  const base = makeProject();
  return {
    ...base,
    timeline: {
      ...base.timeline,
      tracks: [
        ...base.timeline.tracks,
        {
          id: 'caption_1',
          name: 'Caption 1',
          type: 'caption' as const,
          clips: [
            {
              id: 'cue_1',
              assetId: null,
              start: 0,
              end: 1,
              sourceStart: 0,
              sourceEnd: 1,
              captionCue: { text: 'hello world', words: [] },
            },
          ],
        },
        // After caption_1: panel labels are positional ("Caption 2" is the second lane).
        { id: 'caption_2', name: 'Caption 2', type: 'caption' as const, clips: [] },
      ],
    },
  };
}

const opts: StreamOptions = {
  conversationId: 'conv_budget',
  turnId: 'turn_budget',
  now: () => 1000,
};

/** One turn of the given calls, then a closing reply. */
class OneTurnProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public constructor(private readonly calls: AiResponse['toolCalls']) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    return this.index === 1
      ? { text: '', toolCalls: this.calls }
      : { text: 'Done.', toolCalls: [] };
  }
}

const restyle = (i: number, trackId = 'caption_1') => ({
  id: `call_${trackId}_${String(i)}`,
  name: 'set_track_caption_style',
  arguments: { trackId, captionStyle: { fontScale: 1 + i / 10 } },
});

async function summaries(calls: NonNullable<AiResponse['toolCalls']>): Promise<string[]> {
  const orchestrator = new Orchestrator(new OneTurnProvider(calls), {
    executor: {
      async execute() {
        return { status: 'completed' as const, summary: 'ok' };
      },
    },
  });
  const input: ContextInput = { project: captionProject(), userPrompt: 'style the captions' };
  const out: string[] = [];
  for await (const event of orchestrator.streamAgent(input, opts)) {
    if (event.type === 'tool_result' && typeof event.summary === 'string') out.push(event.summary);
  }
  return out.filter((summary) => /caption/i.test(summary));
}

describe('caption restyles', () => {
  it('applies every distinct restyle of one track, however many there are', async () => {
    const calls = Array.from({ length: 8 }, (_, i) => restyle(i));
    const results = await summaries(calls);
    expect(results).toHaveLength(8);
    expect(results.some((summary) => /not applied|refused/.test(summary))).toBe(false);
  });

  it('still withholds a byte-identical repeat that changes nothing', async () => {
    const results = await summaries([restyle(1), restyle(1)]);
    expect(results.filter((summary) => /already done/.test(summary))).toHaveLength(1);
  });
});
