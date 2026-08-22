/**
 * What the run REMEMBERS it did — the tool-result note.
 *
 * This one string is the tool card's summary, the agent log entry, and the
 * `ALREADY APPLIED — do not repeat` row in the state briefing. Until this was fixed it was
 * derived from the operation alone, so every tool that compiles down to a shared operation
 * became indistinguishable from every other tool that compiles to the same one.
 *
 * The captured run that motivated this: `auto_emphasize_captions` and
 * `set_track_caption_style` both emit `set_track_caption_style`, so both logged
 * "Set track caption style Caption 1". The model spent the run reading that its track style
 * had been set "multiple times" while the emphasis it kept trying to land never appeared in
 * its own memory as a distinct action — and it never landed.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { ContextInput } from './context-builder.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import { makeProject } from './__fixtures__/project.js';

/** A project with a caption track the caption tools can actually address. */
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

const opts: StreamOptions = { conversationId: 'conv_note', turnId: 'turn_note', now: () => 1000 };

/** Replies with the given tool calls on the first turn, then finishes. */
class OneCallProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public constructor(private readonly call: AiResponse['toolCalls']) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    return this.index === 1 ? { text: '', toolCalls: this.call } : { text: 'Done.', toolCalls: [] };
  }
}

async function notesFor(call: NonNullable<AiResponse['toolCalls']>[number]): Promise<string[]> {
  const orchestrator = new Orchestrator(new OneCallProvider([call]), {
    executor: {
      async execute() {
        return { status: 'completed' as const, summary: 'ok' };
      },
    },
  });
  const input: ContextInput = { project: captionProject(), userPrompt: 'style the captions' };
  const notes: string[] = [];
  for await (const event of orchestrator.streamAgent(input, opts)) {
    const record = event as unknown as Record<string, unknown>;
    if (typeof record['summary'] === 'string') notes.push(record['summary']);
    if (typeof record['note'] === 'string') notes.push(record['note']);
  }
  return notes;
}

const KARAOKE = { templateId: 'karaoke' as const };

describe('the tool-result note names the call when its operations cannot', () => {
  it('records an emphasis call as emphasis, not as a style change', async () => {
    const notes = await notesFor({
      id: 'c1',
      name: 'auto_emphasize_captions',
      arguments: { trackId: 'caption_1', keywords: ['world'] },
    });
    const emphasis = notes.filter((n) => n.includes('Emphasising key words'));
    expect(emphasis.length).toBeGreaterThan(0);
    // The outcome is still reported — the note says intent AND effect.
    expect(emphasis[0]).toContain('Set track caption style');
    expect(emphasis[0]).toContain('→');
  });

  it('records a plain style call distinguishably from an emphasis call', async () => {
    const [emphasis] = await Promise.all([
      notesFor({
        id: 'c1',
        name: 'auto_emphasize_captions',
        arguments: { trackId: 'caption_1', keywords: ['world'] },
      }),
    ]);
    const styling = await notesFor({
      id: 'c1',
      name: 'set_track_caption_style',
      arguments: { trackId: 'caption_1', captionStyle: KARAOKE },
    });
    const emphasisNote = emphasis.find((n) => n.includes('Set track caption style'));
    const stylingNote = styling.find((n) => n.includes('Set track caption style'));
    expect(emphasisNote).toBeDefined();
    expect(stylingNote).toBeDefined();
    // The regression: these two were byte-identical, so the run could not tell them apart.
    expect(emphasisNote).not.toBe(stylingNote);
  });

  it('does not restate a tool whose own name is the operation it produced', async () => {
    const notes = await notesFor({
      id: 'c1',
      name: 'set_track_caption_style',
      arguments: { trackId: 'caption_1', captionStyle: KARAOKE },
    });
    const styled = notes.filter((n) => n.includes('Set track caption style'));
    expect(styled.length).toBeGreaterThan(0);
    // `trim_clip → Trimmed …` would be pure restatement; the line stays as it was.
    for (const note of styled) expect(note).not.toContain('→');
  });
});
