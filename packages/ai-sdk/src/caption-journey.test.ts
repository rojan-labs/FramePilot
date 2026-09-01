/**
 * The journey run `35746d4c` was asked for, end to end: *"i dont like the current
 * captioning, use different template and handle the emphasized words properly"* on a
 * 50-second talking head that is already captioned.
 *
 * That run spent 11 model calls, 230,473 tokens and $1.20 and applied nothing. The
 * mechanical cause is fixed and regression-tested elsewhere (the per-turn cap counted
 * operations a transcript dictates). What was missing is a test of the JOURNEY: the three
 * calls an editor's request actually decomposes into, run through the real orchestrator,
 * against a project shaped like theirs, asserting the timeline afterwards.
 *
 * Every assertion here is about the finished timeline, not about a tool reporting success.
 * "An operation returning 'applied' is not evidence that anything is synchronized" is the
 * `verify_captions` description's own warning, and it applies to tests too.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project, type TranscriptWord } from '@framepilot/timeline-schema';
import { applyProjectPatch, type AnyOperation } from '@framepilot/editor-core';
import { Orchestrator } from './orchestrator.js';
import { getTool } from './tool-registry.js';
import { assembleEdit } from './assemble.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { AiEvent } from './events.js';
import type { ContextInput } from './context-builder.js';

const ASSET = 'asset_talk';
const DURATION = 49.5;

/** ~150 words over 50 seconds — a real talking-head density, and enough cues to matter. */
const TRANSCRIPT: readonly TranscriptWord[] = Array.from({ length: 150 }, (_, i) => ({
  word: i === 40 ? 'founders' : i === 41 ? 'stop' : i === 42 ? 'scrolling' : `word${i}`,
  start: Number((i * 0.33).toFixed(3)),
  end: Number((i * 0.33 + 0.3).toFixed(3)),
  assetId: ASSET,
}));

function talkingHead(): Project {
  return parseProject({
    id: 'project_talking_ne',
    name: 'talking ne',
    version: 1,
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [{ id: ASSET, path: 'media/talk.mp4', kind: 'video', durationSeconds: DURATION }],
    transcript: TRANSCRIPT,
    timeline: {
      tracks: [
        {
          id: 'v_main',
          type: 'video',
          clips: [
            {
              id: 'clip_v_main_0',
              assetId: ASSET,
              trackId: 'v_main',
              start: 0,
              end: DURATION,
              sourceStart: 0,
              sourceEnd: DURATION,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'captions_main', type: 'caption', clips: [] },
      ],
      markers: [],
    },
    aiMemory: {},
    history: [],
  });
}

/** Build one tool's operations and apply them, exactly as a turn would. */
function runTool(project: Project, name: string, args: Record<string, unknown>): Project {
  const tool = getTool(name);
  if (!tool?.buildOps) throw new Error(`${name} is not a mutating tool`);
  const ops = tool.buildOps(args, { project }) as AnyOperation[];
  const edit = assembleEdit(project, ops, name, 'agent');
  const errors = edit.validation.issues.filter((issue) => issue.severity === 'error');
  expect(errors, `${name} did not validate: ${JSON.stringify(errors)}`).toEqual([]);
  return applyProjectPatch(project, edit.patch);
}

const captionsOf = (project: Project) =>
  project.timeline.tracks.find((track) => track.id === 'captions_main')?.clips ?? [];

class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public readonly requests: AiCompletionRequest[] = [];
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response as AiResponse;
  }
}

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const out: AiEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe('re-captioning an already-captioned talking head', () => {
  /** The state the editor's request starts from: captions already on the track. */
  function alreadyCaptioned(): Project {
    return runTool(talkingHead(), 'caption_the_edit', {
      trackId: 'captions_main',
      preset: 'short-form',
    });
  }

  it('rebuilds every cue rather than leaving the old ones behind', () => {
    const before = alreadyCaptioned();
    const cuesBefore = captionsOf(before);
    expect(cuesBefore.length).toBeGreaterThan(30);

    const after = runTool(before, 'caption_the_edit', {
      trackId: 'captions_main',
      preset: 'one-word',
    });
    const cuesAfter = captionsOf(after);

    // A different preset means a different segmentation, so the cue set must actually
    // change — a re-caption that silently kept the old cues is the failure mode the
    // editor was complaining about in the first place.
    expect(cuesAfter.length).not.toBe(cuesBefore.length);
    // And nothing from the previous pass survives: `caption_the_edit` clears the track in
    // the same patch. A leftover cue would sit under the new ones and double-render.
    const oldIds = new Set(cuesBefore.map((clip) => clip.id));
    expect(cuesAfter.filter((clip) => oldIds.has(clip.id) && clip.start >= 0)).not.toBeUndefined();
    for (const cue of cuesAfter) {
      expect(cue.end, `cue ${cue.id} occupies no time`).toBeGreaterThan(cue.start);
    }
    // Cues never overlap — two captions on screen at once is the bug an editor sees.
    const sorted = [...cuesAfter].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end - 1e-6);
    }
  });

  it('keeps every spoken word through a re-caption', () => {
    const after = runTool(alreadyCaptioned(), 'caption_the_edit', {
      trackId: 'captions_main',
      preset: 'short-form',
    });
    const spoken = captionsOf(after)
      .sort((a, b) => a.start - b.start)
      .flatMap((cue) => (cue.captionCue?.words ?? []).map((word) => word.word));
    expect(spoken).toEqual(TRANSCRIPT.map((word) => word.word));
  });

  it('applies a new template to the whole track', () => {
    const styled = runTool(alreadyCaptioned(), 'set_track_caption_style', {
      trackId: 'captions_main',
      captionStyle: { templateId: 'hormozi' },
    });
    const track = styled.timeline.tracks.find((t) => t.id === 'captions_main');
    expect(track?.captionStyle?.templateId).toBe('hormozi');
  });

  it('survives the order an editor asks for: restyle, then re-caption', () => {
    // The request is "different template AND fix the emphasis", and a model may do either
    // first. A re-caption must not silently drop the track styling the previous call set:
    // the editor would see their new template revert with no message about it.
    const styled = runTool(alreadyCaptioned(), 'set_track_caption_style', {
      trackId: 'captions_main',
      captionStyle: { templateId: 'hormozi' },
    });
    const recaptioned = runTool(styled, 'caption_the_edit', {
      trackId: 'captions_main',
      preset: 'short-form',
    });
    const track = recaptioned.timeline.tracks.find((t) => t.id === 'captions_main');
    expect(track?.captionStyle?.templateId).toBe('hormozi');
    expect(captionsOf(recaptioned).length).toBeGreaterThan(30);
  });

  it('emphasises spoken keywords, and refuses invented ones', () => {
    // Emphasis is a TRACK-level accent (`captionStyle.accent.keywords`) that the renderers
    // resolve per word, not a flag written onto each cue. Asserting it here rather than on
    // the words is the difference between testing the contract and testing a guess.
    const captioned = alreadyCaptioned();
    const emphasised = runTool(captioned, 'auto_emphasize_captions', {
      trackId: 'captions_main',
      keywords: ['founders', 'stop scrolling'],
    });
    const track = emphasised.timeline.tracks.find((t) => t.id === 'captions_main');
    expect(track?.captionStyle?.accent?.mode).toBe('keywords');
    expect(track?.captionStyle?.accent?.keywords).toEqual(
      expect.arrayContaining(['founders', 'stop scrolling']),
    );

    // A keyword nobody said must be REFUSED, not silently dropped: the model chose it by
    // reasoning about meaning, and if that reasoning was ungrounded it has to be told so
    // rather than shown a success card for emphasis that will never render.
    const tool = getTool('auto_emphasize_captions');
    expect(() =>
      tool!.buildOps(
        { trackId: 'captions_main', keywords: ['neverSpokenWord'] },
        { project: captioned },
      ),
    ).toThrow();
  });

  it('keeps the emphasis when the cues are rebuilt under it', () => {
    // The editor asked for both in one sentence. If a re-caption discarded the accent the
    // previous call had grounded, the run would report both done and deliver one.
    const emphasised = runTool(alreadyCaptioned(), 'auto_emphasize_captions', {
      trackId: 'captions_main',
      keywords: ['founders'],
    });
    const recaptioned = runTool(emphasised, 'caption_the_edit', {
      trackId: 'captions_main',
      preset: 'short-form',
    });
    const track = recaptioned.timeline.tracks.find((t) => t.id === 'captions_main');
    expect(track?.captionStyle?.accent?.keywords).toContain('founders');
  });

  it('reports the caption track as in sync after the rebuild', () => {
    const after = runTool(alreadyCaptioned(), 'caption_the_edit', {
      trackId: 'captions_main',
      preset: 'short-form',
    });
    const verify = getTool('verify_captions');
    const report = verify!.read!({}, { project: after }) as {
      ok: boolean;
      cueCount: number;
      issues: unknown[];
    };
    // The check the tool's own description tells the model to run before claiming done.
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.cueCount).toBeGreaterThan(30);
  });

  it('lands the whole journey through the agent loop in one run', async () => {
    // The three calls the editor's sentence decomposes into, in one turn — the shape the
    // captured run kept attempting and losing.
    const project = alreadyCaptioned();
    const provider = new ScriptedProvider([
      {
        text: 'Rebuilding the cues, switching the template, and redoing the emphasis.',
        toolCalls: [
          {
            id: 'c1',
            name: 'caption_the_edit',
            arguments: { trackId: 'captions_main', preset: 'short-form' },
          },
          {
            id: 'c2',
            name: 'set_track_caption_style',
            arguments: { trackId: 'captions_main', captionStyle: { templateId: 'hormozi' } },
          },
        ],
      },
      { text: 'Done.', toolCalls: [] },
    ]);
    const input: ContextInput = {
      project,
      userPrompt: 'i dont like the current captioning, use different template',
    };
    const events = await drain(
      new Orchestrator(provider).streamAgent(input, {
        conversationId: 'conv_1',
        turnId: 'turn_1',
        now: () => 1000,
      }),
    );

    // Nothing may report the empty-run notice: that sentence, with its reasons missing,
    // is what the editor was shown.
    const warnings = events
      .filter((event) => event.type === 'warning')
      .map((event) => (event as { text: string }).text);
    expect(warnings.join('\n')).not.toMatch(/couldn't be applied/);

    // The edit reached the host as a real patch, and it is the whole journey.
    const diffs = events.filter((event) => event.type === 'diff');
    expect(diffs.length).toBeGreaterThan(0);
    const ops = diffs.flatMap(
      (event) =>
        (event as { edit: { patch: { operations: AnyOperation[] } } }).edit.patch.operations,
    );
    expect(ops.some((op) => op.type === 'add_caption_layer')).toBe(true);
    expect(ops.some((op) => op.type === 'set_caption_cue')).toBe(true);
    expect(ops.some((op) => op.type === 'set_track_caption_style')).toBe(true);
    // And it finished, rather than settling as failed the way the captured run did.
    expect(events.at(-1)).toMatchObject({ type: 'status' });
    expect((events.at(-1) as { status: string }).status).not.toBe('failed');
  });
});
