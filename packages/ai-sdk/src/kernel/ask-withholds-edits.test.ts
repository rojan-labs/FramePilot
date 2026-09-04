/**
 * A turn that asks a question does not apply that turn's edits.
 *
 * Golden case `clarify-which-clip`, three runs out of three: "Cut the clip a bit
 * shorter" over five clips with nothing selected. The agent does the right thing and
 * asks which clip — "Which clip should I shorten? Nothing is currently selected on the
 * timeline." — and reframes all five clips in the same turn. The run reported "**Applied
 * 5 edits**", the rubric expected an untouched timeline, and the editor got work they
 * never asked for while their own question sat open.
 *
 * Every operation in a turn comes from one model response, so a turn that asks composed
 * its edits before any answer existed — including the answer it was asking for. Applying
 * them is the run acting on exactly the guess it just said it could not make.
 */
import { describe, expect, it } from 'vitest';
import type {
  AiCompletionRequest,
  AiEvent,
  AiProvider,
  AiResponse,
  ContextInput,
  StreamOptions,
} from './../types.js';
import { Orchestrator } from '../orchestrator.js';
import { makeProject } from '../__fixtures__/project.js';

class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public readonly requests: AiCompletionRequest[] = [];
  private index = 0;
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response as AiResponse;
  }
}

async function drain(generator: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const opts = (): StreamOptions => ({
  conversationId: 'conv_1',
  turnId: 'turn_1',
  now: () => 1000,
});

const input: ContextInput = { project: makeProject(), userPrompt: 'Cut the clip a bit shorter.' };

/** The shape of the captured turn: one question, plus edits, from one model response. */
const askAndEdit: AiResponse = {
  text: 'Which clip did you mean? Reframing them vertically meanwhile.',
  toolCalls: [
    {
      id: 'q1',
      name: 'ask_user',
      arguments: {
        question: 'Which clip should I shorten? Nothing is currently selected.',
        options: [{ label: 'clip_a' }, { label: 'clip_b' }],
      },
    },
    { id: 't1', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 4 } },
  ],
};

const editOnly: AiResponse = {
  text: 'Trimming.',
  toolCalls: [{ id: 't2', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 4 } }],
};

const done: AiResponse = { text: 'done', toolCalls: [] };

const diffs = (events: readonly AiEvent[]) => events.filter((event) => event.type === 'diff');

describe('a turn that asks the editor a question', () => {
  it('does not apply the edits it composed alongside the question', async () => {
    const events = await drain(
      new Orchestrator(new ScriptedProvider([askAndEdit, done])).streamAgent(input, opts(), {}),
    );
    expect(diffs(events)).toHaveLength(0);
  });

  it('says why, and says to make them again once the answer is in', async () => {
    const provider = new ScriptedProvider([askAndEdit, done]);
    await drain(new Orchestrator(provider).streamAgent(input, opts(), {}));
    const seenByModel = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
    expect(seenByModel).toContain("this turn's 1 edit(s) were not applied");
    expect(seenByModel).toContain('Make them on the next turn');
  });

  it('leaves a turn that only edits alone', async () => {
    const events = await drain(
      new Orchestrator(new ScriptedProvider([editOnly, done])).streamAgent(input, opts(), {}),
    );
    expect(diffs(events).length).toBeGreaterThan(0);
  });
});
