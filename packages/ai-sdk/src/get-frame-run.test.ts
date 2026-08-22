/**
 * Integration tests for the `get_frame` vision path THROUGH a real agent run.
 *
 * The unit tests in `get-frame.test.ts` cover the pieces; these cover the two properties
 * that only exist once the pieces are assembled, and that are the whole reason the plumbing
 * is shaped the way it is:
 *
 *  1. A frame the model asked for is attached as REAL image content on the NEXT request —
 *     not pasted into the text log, where it would be an unreadable, enormous blob.
 *  2. It is attached ONCE. Re-sending every frame a run has ever looked at would re-bill
 *     each of them every turn, and would put stale pictures of a timeline the run has
 *     since edited next to the current one with nothing telling them apart.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from './tool-executor.js';
import type { ContextInput } from './context-builder.js';
import { makeProject } from './__fixtures__/project.js';

const FRAME_BASE64 = 'ZmFrZS1qcGVn';

/** A provider that replays a queue of responses and records every request it received. */
class ScriptedProvider implements AiProvider {
  // NOT 'mock': the mock provider is treated as sighted by `supportsVision` so fixtures
  // can exercise the vision path, which would make the "text-only model" case untestable.
  public readonly name = 'anthropic' as const;
  public readonly requests: AiCompletionRequest[] = [];
  private turn = 0;
  public constructor(
    private readonly responses: readonly AiResponse[],
    public readonly modelId = 'claude-sonnet-5',
  ) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    // Snapshot the message list: the question route appends to ONE array across turns,
    // so storing the request by reference would show every turn the final transcript.
    this.requests.push({ ...request, messages: [...request.messages] });
    const response = this.responses[Math.min(this.turn, this.responses.length - 1)];
    this.turn += 1;
    return response!;
  }
}

/** A host executor that answers `get_frame` with a picture, like the sidecar would. */
const frameExecutor: HostToolExecutor = {
  async run(call): Promise<HostToolOutcome> {
    if (call.name !== 'get_frame') return { status: 'failed', summary: 'unexpected tool' };
    return {
      status: 'completed',
      summary: 'Looked at the timeline at 2.00s',
      data: { timeSeconds: 2, width: 288, height: 512 },
      images: [{ mediaType: 'image/jpeg', base64: FRAME_BASE64, label: 'the timeline at 2.00s' }],
    };
  },
};

/** The claim `unwrapFrame` puts in its payload — true only while an image really rides along. */
const ATTACHED_NOTE = 'The frame itself is attached to this turn as an image.';

/** As {@link frameExecutor}, but carrying the real payload note the sidecar sends. */
const notedFrameExecutor: HostToolExecutor = {
  async run(call): Promise<HostToolOutcome> {
    if (call.name !== 'get_frame') return { status: 'failed', summary: 'unexpected tool' };
    return {
      status: 'completed',
      summary: 'Looked at the timeline at 2.00s',
      data: { timeSeconds: 2, width: 288, height: 512, note: ATTACHED_NOTE },
      images: [{ mediaType: 'image/jpeg', base64: FRAME_BASE64, label: 'the timeline at 2.00s' }],
    };
  },
};

const input: ContextInput = { project: makeProject(), userPrompt: 'check the captions' };

/** As {@link input}, but with a timeline revision — the identity the run memo keys on. */
const versioned: ContextInput = {
  ...input,
  project: {
    ...input.project,
    timeline: { ...input.project.timeline, revision: 7 },
  },
};

/** Run a question turn to completion, discarding its events. */
async function drainChat(orchestrator: Orchestrator, from: ContextInput = input): Promise<void> {
  for await (const _event of orchestrator.streamChat(from, {
    conversationId: 'c',
    turnId: 't',
  })) {
    // The events are the host's business; these tests read what the PROVIDER received.
  }
}

/** Every image attached across a request's messages. */
function imagesIn(request: AiCompletionRequest): readonly string[] {
  return request.messages.flatMap((message) => (message.images ?? []).map((i) => i.base64));
}

describe('get_frame through an agent run', () => {
  it('attaches the frame as image content on the next request, never as log text', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'Let me look.',
        toolCalls: [{ id: 'c1', name: 'get_frame', arguments: { timeSeconds: 2 } }],
      },
      { text: 'The captions sit inside the safe area. Done.' },
    ]);
    const orchestrator = new Orchestrator(provider, { executor: frameExecutor });
    await orchestrator.agent(input, { maxSteps: 3 });

    // Turn 1 asked for the frame, so it cannot have carried it.
    expect(imagesIn(provider.requests[0]!)).toEqual([]);
    // Turn 2 is where the model actually sees it.
    expect(imagesIn(provider.requests[1]!)).toEqual([FRAME_BASE64]);

    // And the blob is nowhere in the prompt TEXT — that is the action log, where a
    // base64 image is unreadable to the model and ruinous to the budget.
    const promptText = provider.requests[1]!.messages.map((m) => m.content).join('\n');
    expect(promptText).not.toContain(FRAME_BASE64);
    // The model is still told what it is looking at, in words.
    expect(promptText).toContain('the timeline at 2.00s');
  });

  it('shows a frame once, then drops it instead of re-sending it every turn', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'Looking.',
        toolCalls: [{ id: 'c1', name: 'get_frame', arguments: { timeSeconds: 2 } }],
      },
      {
        text: 'Thinking about it.',
        toolCalls: [{ id: 'c2', name: 'get_timeline', arguments: {} }],
      },
      { text: 'All good. Done.' },
    ]);
    const orchestrator = new Orchestrator(provider, { executor: frameExecutor });
    await orchestrator.agent(input, { maxSteps: 4 });

    expect(imagesIn(provider.requests[1]!)).toEqual([FRAME_BASE64]);
    // The turn AFTER the model has seen it carries nothing: the picture described a
    // timeline that may already have changed.
    expect(imagesIn(provider.requests[2]!)).toEqual([]);
  });

  it('never offers the tool to a model that cannot see', () => {
    const blind = new Orchestrator(new ScriptedProvider([{ text: '' }], 'claude-instant-1.2'));
    expect(blind.agentTools().map((t) => t.name)).not.toContain('get_frame');

    const sighted = new Orchestrator(new ScriptedProvider([{ text: '' }], 'claude-sonnet-5'));
    expect(sighted.agentTools().map((t) => t.name)).toContain('get_frame');
  });
});

/**
 * The same guarantee on the QUESTION route, which is where a creator actually asks
 * "what's on screen at 13.3s?".
 *
 * This route offers `get_frame` (it is a read, so the question scope includes it) and
 * renders the frame for real — but it used to drop the picture on the floor: `streamChat`
 * threaded only the tool NOTES into the next turn and never the images. So the model was
 * handed a payload saying "the frame is attached as an image", with no image, on every
 * Q&A turn. It answered by refusing ("I don't have usable visual access to the attached
 * frame") on questions it had the evidence to answer, and the run burned a full frame
 * render — sometimes several — for nothing.
 */
describe('get_frame through a question run', () => {
  it('offers the tool on the question scope only to a model that can see', () => {
    const sighted = new Orchestrator(new ScriptedProvider([{ text: '' }], 'claude-sonnet-5'));
    expect(sighted.agentTools('question').map((t) => t.name)).toContain('get_frame');
    const blind = new Orchestrator(new ScriptedProvider([{ text: '' }], 'claude-instant-1.2'));
    expect(blind.agentTools('question').map((t) => t.name)).not.toContain('get_frame');
  });

  it('re-attaches the picture when the memo answers a repeated look', async () => {
    // The memo key for get_frame carries the timeline REVISION, so a hit proves the frame
    // still shows the timeline as it is now. Frames ride one request and are then stripped,
    // so a replay that dropped the picture left the model with no image and a note telling
    // it to answer from one it had been shown two turns ago — which is how the captured run
    // produced a confident, wrong reading of its own framing.
    const provider = new ScriptedProvider([
      {
        text: 'Looking.',
        toolCalls: [{ id: 'c1', name: 'get_frame', arguments: { timeSeconds: 2 } }],
      },
      {
        text: 'Looking again.',
        toolCalls: [{ id: 'c2', name: 'get_frame', arguments: { timeSeconds: 2 } }],
      },
      { text: 'All good. Done.' },
    ]);
    const orchestrator = new Orchestrator(provider, { executor: notedFrameExecutor });
    // `get_frame` is memoized per project REVISION, so the run memo can only answer the
    // repeat when the timeline names one (see `idempotencyKeyFor`).
    await drainChat(orchestrator, versioned);

    // Both the fresh look and the replay carry the picture.
    expect(imagesIn(provider.requests[1]!)).toEqual([FRAME_BASE64]);
    expect(imagesIn(provider.requests[2]!)).toEqual([FRAME_BASE64]);
    // The replay says it is served from the memo, and its attachment claim is TRUE again.
    const replayNote = provider.requests[2]!.messages.filter((m) => m.role === 'tool').at(
      -1,
    )!.content;
    expect(replayNote).toContain('(cached)');
    expect(replayNote).toContain('timeSeconds');
    expect(replayNote).not.toContain('already rendered earlier in this run');
  });

  it('tells a sighted model that answering a visual question means looking', async () => {
    const provider = new ScriptedProvider([{ text: 'answer' }]);
    await drainChat(new Orchestrator(provider, { executor: notedFrameExecutor }));
    const contract = provider.requests[0]!.messages.at(-1)!.content;
    expect(contract).toContain('You can SEE this footage');
    expect(contract).toContain('get_frame');
  });

  it('attaches the rendered frame to the next request, as image content', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'Let me look at that moment.',
        toolCalls: [{ id: 'c1', name: 'get_frame', arguments: { timeSeconds: 2 } }],
      },
      { text: 'There is one person in the centre of the frame.' },
    ]);
    const orchestrator = new Orchestrator(provider, { executor: notedFrameExecutor });
    await drainChat(orchestrator);

    // The turn that ASKED cannot have carried it; the turn that answers must.
    expect(imagesIn(provider.requests[0]!)).toEqual([]);
    expect(imagesIn(provider.requests[1]!)).toEqual([FRAME_BASE64]);

    const answerTurn = provider.requests[1]!.messages.map((m) => m.content).join('\n');
    // Labelled in words, so several frames stay distinguishable...
    expect(answerTurn).toContain('the timeline at 2.00s');
    // ...and never pasted into the prompt as a blob.
    expect(answerTurn).not.toContain(FRAME_BASE64);
  });
});
