/**
 * What a wrong clip id is told.
 *
 * The clip-level half of `dca15af` ("a wrong track id is answered with the right ones").
 * A clip id that resolves to nothing is almost always an identity the author has already
 * read and re-typed from memory — `clip_01` for `clip_001`, or the asset it was cut from,
 * or the track it sits on. Both ai-sdk messages answered it with "Use get_clips to list
 * real ids", which is a round trip for a fact that is in hand at the moment the error is
 * thrown, and `editor-core`'s `Clip not found: <id>` reached the model with nothing else.
 *
 * All three now name the real ids. Nothing here guesses what was meant.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Timeline } from '@framepilot/timeline-schema';
import { clipCandidates } from './domain-tools/clip-candidates.js';
import { operationsForCall } from './tool-dispatch.js';
import { getTool } from './tool-registry.js';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { ToolContext } from './tool-context.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from './providers/types.js';
import { makeProject } from './__fixtures__/project.js';

const clip = (id: string, start: number, end: number, assetId = 'asset_1'): unknown => ({
  id,
  assetId,
  trackId: 'video_1',
  start,
  end,
  sourceStart: start,
  sourceEnd: end,
  effects: [],
  keyframes: [],
});

/** A project whose clip ids are the zero-padded shape the model keeps mistyping. */
const padded = (count: number): Project =>
  makeProject({
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: Array.from({ length: count }, (_, i) =>
            clip(`clip_${String(i + 1).padStart(3, '0')}`, i * 2, i * 2 + 2),
          ),
        },
      ],
    } as unknown as Timeline,
  });

describe('clipCandidates — the ids that DO exist', () => {
  it('offers the near miss first when the id is a typo of a real one', () => {
    const answer = clipCandidates(padded(3), 'clip_01');
    expect(answer).toMatch(/^Closest real clip ids: clip_001/);
    expect(answer).toContain('Clips on the timeline: clip_001 (video_1 0–2s)');
  });

  it('says so when the id is an ASSET id, and names the clips cut from it', () => {
    const project = makeProject({
      assets: [
        { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 },
        { id: 'asset_2', path: 'media/b.mp4', kind: 'video', durationSeconds: 30 },
      ],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [clip('clip_a', 0, 6), clip('clip_b', 40, 62, 'asset_2')],
          },
        ],
      } as unknown as Timeline,
    });
    expect(clipCandidates(project, 'asset_2')).toBe(
      '"asset_2" is an asset id — clips on it: clip_b (video_1 40–62s).',
    );
  });

  it('says so when the id is a TRACK id, and names the clips on it', () => {
    expect(clipCandidates(makeProject(), 'video_1')).toBe(
      '"video_1" is a track id — clips on it: clip_a (video_1 0–6s), clip_b (video_1 6–10s).',
    );
  });

  it('lists eight clips and counts the rest rather than dumping the timeline', () => {
    const answer = clipCandidates(padded(20), 'nope');
    expect(answer).toContain('clip_008 (video_1 14–16s)');
    expect(answer).not.toContain('clip_009');
    expect(answer).toContain('…and 12 more; get_clips lists them all.');
  });

  it('says the timeline is empty instead of naming nothing', () => {
    const empty = makeProject({
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] } as unknown as Timeline,
    });
    expect(clipCandidates(empty, 'clip_a')).toBe('This timeline has no clips yet.');
  });
});

describe('a tool handed a clip id that does not exist', () => {
  const ctx: ToolContext = { project: makeProject() };

  it('delete_clip names the real clips instead of sending the model to look them up', () => {
    expect(() =>
      operationsForCall({ id: '1', name: 'delete_clip', arguments: { clipId: 'clip_A' } }, ctx),
    ).toThrow(/Closest real clip ids: clip_a.*clip_a \(video_1 0–6s\)/);
  });

  it('get_clip answers with the ids rather than "use get_clips"', () => {
    const result = getTool('get_clip')?.read?.({ clipId: 'asset_1' }, ctx) as { error: string };
    expect(result.error).toBe(
      'Unknown clip "asset_1". "asset_1" is an asset id — clips on it: ' +
        'clip_a (video_1 0–6s), clip_b (video_1 6–10s).',
    );
  });
});

/** A provider that plays a queued script of responses, repeating the last one. */
class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public readonly requests: AiCompletionRequest[] = [];
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const responses: AiResponse[] = [
      {
        text: 'trimming',
        toolCalls: [
          {
            id: 'e1',
            name: 'trim_clip',
            arguments: { clipId: 'clip_zz', start: 1, end: 4 },
          } satisfies ToolCall,
        ],
      },
      { text: 'done', toolCalls: [] },
    ];
    const response = responses[Math.min(this.index, responses.length - 1)]!;
    this.index += 1;
    return response;
  }
}

describe('a rejected patch whose clip reference is unknown', () => {
  it("appends the real ids to editor-core's bare `Clip not found`", async () => {
    // `editor-core` must not import the AI layer, so the repair lands where validation
    // issues become the model's note.
    const provider = new ScriptedProvider();
    const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
    const options: StreamOptions = { conversationId: 'c', turnId: 't', now: () => 1000 };
    const events: AiEvent[] = [];
    for await (const event of new Orchestrator(provider).streamAgent(input, options, {
      maxSteps: 3,
    })) {
      events.push(event);
    }
    const fedBack = provider.requests.flatMap((r) => r.messages.map((m) => m.content)).join('\n');
    expect(fedBack).toContain('Clip not found: clip_zz');
    expect(fedBack).toContain('clip_a (video_1 0–6s)');
  });
});
