/**
 * A run may restyle one caption track only so many times (run fb90e58d).
 *
 * The run restyled one track ten times in a turn, looking at the same frame after each
 * and reporting the same problem ("the caption runs off the right edge"): the renderer
 * placed the text wrongly whatever the style said, so no restyle could converge, and the
 * editor stopped it at 695k tokens. A design pass that converges — restyle, look, one or
 * two corrections — sits well inside the budget.
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import type { ContextInput } from './context-builder.js';
import { MAX_TRACK_RESTYLES_PER_RUN, Orchestrator, type StreamOptions } from './orchestrator.js';
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

describe('the per-run caption restyle budget', () => {
  it('refuses the restyle past the budget and says why, in the editor’s terms', async () => {
    const calls = Array.from({ length: MAX_TRACK_RESTYLES_PER_RUN + 1 }, (_, i) => restyle(i));
    const results = await summaries(calls);
    const refused = results.filter((summary) => /not applied/.test(summary));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(
      `Caption 1 was restyled ${String(MAX_TRACK_RESTYLES_PER_RUN)} times this run`,
    );
    expect(results.filter((summary) => !/not applied/.test(summary))).toHaveLength(
      MAX_TRACK_RESTYLES_PER_RUN,
    );
  });

  it('allows a converging pass — a restyle and a couple of corrections', async () => {
    const results = await summaries([restyle(0), restyle(1), restyle(2)]);
    expect(results.some((summary) => /not applied/.test(summary))).toBe(false);
  });
});
