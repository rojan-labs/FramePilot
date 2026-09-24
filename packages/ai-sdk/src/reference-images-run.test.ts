/**
 * EQ18 through real runs: what the MODEL is shown when the editor attaches an image, and
 * what the CARD is given when a tool shows the model a picture.
 *
 * The unit tests in `references/images.test.ts` cover the pieces; these cover the only
 * properties that exist once the routes assemble them:
 *
 *  1. An attached image reaches a sighted model as a real image part — on the question
 *     route and on every agent turn — and never reaches a text-only model at all.
 *  2. In agent mode it rides BELOW the cache boundary, because the Agent SDK provider turns
 *     everything at or above it into a text-only system prompt.
 *  3. A `get_frame` result event carries the picture, so the card can show it.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from './tool-executor.js';
import { assembleContext, type ContextInput } from './context-builder.js';
import type { AiEvent, ToolResultEvent } from './events.js';
import { buildReferenceProfile } from './references/profile.js';
import { makeProject } from './__fixtures__/project.js';

const LOGO_BASE64 = 'bG9nby1wbmc=';
const FRAME_BASE64 = 'ZnJhbWUtanBlZw==';

class ScriptedProvider implements AiProvider {
  // NOT 'mock': `supportsVision` treats mock as sighted, which would hide the blind case.
  public readonly name = 'anthropic' as const;
  public readonly requests: AiCompletionRequest[] = [];
  private turn = 0;
  public constructor(
    private readonly responses: readonly AiResponse[],
    public readonly modelId = 'claude-sonnet-5',
  ) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const response = this.responses[Math.min(this.turn, this.responses.length - 1)];
    this.turn += 1;
    return response!;
  }
}

const logo = buildReferenceProfile({
  id: 'ref_logo',
  role: 'brand-logo',
  kind: 'image',
  fileName: 'acme-logo.png',
  contentHash: 'a'.repeat(64),
  analyzedAt: '2026-09-24T00:00:00.000Z',
  image: { width: 400, height: 160, hasAlpha: true, dominantColors: ['#e5670a'] },
});

const withReference: ContextInput = {
  project: makeProject(),
  userPrompt: 'put my logo in the corner',
  references: [logo],
  referenceImages: [
    {
      referenceId: 'ref_logo',
      image: { mediaType: 'image/png', base64: LOGO_BASE64, width: 400, height: 160 },
    },
  ],
};

function imagesIn(request: AiCompletionRequest): readonly string[] {
  return request.messages.flatMap((message) => (message.images ?? []).map((i) => i.base64));
}

async function drain(stream: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('an attached reference image reaches the model as a picture', () => {
  it('rides as image content on the question route, labelled with its reference', async () => {
    const provider = new ScriptedProvider([{ text: 'It reads ACME in orange.' }]);
    const orchestrator = new Orchestrator(provider);
    await drain(orchestrator.streamChat(withReference, { conversationId: 'c', turnId: 't' }));

    const request = provider.requests[0]!;
    expect(imagesIn(request)).toEqual([LOGO_BASE64]);
    const carrier = request.messages.find((m) => (m.images?.length ?? 0) > 0)!;
    expect(carrier.role).toBe('user');
    expect(carrier.images![0]!.label).toBe('reference ref_logo · acme-logo.png (brand-logo)');
    // The words say which picture is which; the bytes never enter the text.
    expect(carrier.content).toContain('reference ref_logo · acme-logo.png (brand-logo)');
    expect(request.messages.map((m) => m.content).join('\n')).not.toContain(LOGO_BASE64);
  });

  it('never sends the picture to a model that cannot read it, but keeps the measured lines', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }], 'claude-instant-1.2');
    const orchestrator = new Orchestrator(provider);
    await drain(orchestrator.streamChat(withReference, { conversationId: 'c', turnId: 't' }));

    const request = provider.requests[0]!;
    expect(imagesIn(request)).toEqual([]);
    const text = request.messages.map((m) => m.content).join('\n');
    expect(text).toContain('ref_logo · acme-logo.png · brand-logo');
    expect(text).not.toContain('Attached to this message');
  });

  it('is withheld once the editor dismisses the reference', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }]);
    const orchestrator = new Orchestrator(provider);
    // The host still had the picture, but the reference is no longer in force.
    await drain(
      orchestrator.streamChat(
        { ...withReference, references: [] },
        { conversationId: 'c', turnId: 't' },
      ),
    );
    expect(imagesIn(provider.requests[0]!)).toEqual([]);
  });

  it('rides every agent turn, below the cache boundary and above the turn message', async () => {
    const provider = new ScriptedProvider([
      { text: 'Checking.', toolCalls: [{ id: 'c1', name: 'get_timeline', arguments: {} }] },
      { text: 'Done.' },
    ]);
    const orchestrator = new Orchestrator(provider);
    await orchestrator.agent(withReference, { maxSteps: 3 });

    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of provider.requests) {
      const messages = request.messages;
      const boundary = messages.findIndex((m) => m.cacheBoundary === true);
      const carrier = messages.findIndex((m) => (m.images?.length ?? 0) > 0);
      expect(boundary).toBeGreaterThanOrEqual(0);
      // After the boundary — at or above it the Agent SDK renders a text-only system prompt.
      expect(carrier).toBeGreaterThan(boundary);
      // Before the per-turn message, which stays last.
      expect(carrier).toBeLessThan(messages.length - 1);
      expect(messages[carrier]!.images!.map((i) => i.base64)).toEqual([LOGO_BASE64]);
    }
  });
});

describe('the pictures travel with the references block', () => {
  it('prices them into the block and drops them with it', () => {
    const roomy = assembleContext(withReference);
    expect(roomy.referenceImages.map((i) => i.base64)).toEqual([LOGO_BASE64]);
    expect(roomy.messages.at(-1)!.images!.map((i) => i.base64)).toEqual([LOGO_BASE64]);
    const section = roomy.sections.find((s) => s.label === 'references')!;
    const textOnly = assembleContext({ ...withReference, referenceImages: [] }).sections.find(
      (s) => s.label === 'references',
    )!;
    // 400 × 160 px ≈ 86 tokens of picture, plus the lines naming it.
    expect(section.tokenEstimate - textOnly.tokenEstimate).toBeGreaterThanOrEqual(86);

    // A budget too small for the block drops the block — and its pictures with it, so the
    // model is never shown an image nothing in the prompt explains.
    const tight = assembleContext({
      ...withReference,
      budget: { contextWindow: 200, maxOutputTokens: 0, headroom: 0 },
    });
    expect(tight.trimmed).toContain('pinned');
    expect(tight.referenceImages).toEqual([]);
    expect(tight.messages.some((m) => (m.images?.length ?? 0) > 0)).toBe(false);
  });
});

describe('a tool that shows the model a picture gives the card the same picture', () => {
  const frameExecutor: HostToolExecutor = {
    async run(call): Promise<HostToolOutcome> {
      if (call.name !== 'get_frame') return { status: 'failed', summary: 'unexpected tool' };
      return {
        status: 'completed',
        summary: 'Looked at the timeline at 2.00s',
        data: { timeSeconds: 2, width: 288, height: 512 },
        images: [
          {
            mediaType: 'image/jpeg',
            base64: FRAME_BASE64,
            label: 'the timeline at 2.00s',
            width: 288,
            height: 512,
          },
        ],
      };
    },
  };

  it('puts the frame on the get_frame result event, bytes and label together', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'Let me look.',
        toolCalls: [{ id: 'c1', name: 'get_frame', arguments: { timeSeconds: 2 } }],
      },
      { text: 'One person, centred.' },
    ]);
    const orchestrator = new Orchestrator(provider, { executor: frameExecutor });
    const events = await drain(
      orchestrator.streamChat(
        { project: makeProject(), userPrompt: 'what is on screen at 2s?' },
        { conversationId: 'c', turnId: 't' },
      ),
    );
    const result = events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result' && e.toolCallId === 'c1',
    );
    expect(result?.images).toEqual([
      {
        mediaType: 'image/jpeg',
        base64: FRAME_BASE64,
        label: 'the timeline at 2.00s',
        width: 288,
        height: 512,
      },
    ]);
    // The facts stay in `result` — the Details view and the copy button still have them.
    expect(result?.result).toMatchObject({ timeSeconds: 2 });
    // And the model got the very same bytes on its next request.
    expect(imagesIn(provider.requests[1]!)).toEqual([FRAME_BASE64]);
  });

  it('leaves a picture-less result without an images field', async () => {
    const provider = new ScriptedProvider([
      { text: 'Checking.', toolCalls: [{ id: 'c1', name: 'get_timeline', arguments: {} }] },
      { text: 'Done.' },
    ]);
    const orchestrator = new Orchestrator(provider);
    const events = await drain(
      orchestrator.streamChat(
        { project: makeProject(), userPrompt: 'what is on the timeline?' },
        { conversationId: 'c', turnId: 't' },
      ),
    );
    const result = events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result' && e.toolCallId === 'c1',
    );
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('images');
  });
});
