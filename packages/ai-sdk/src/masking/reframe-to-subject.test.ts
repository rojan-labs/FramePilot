/**
 * `reframe_to_subject` (#137): a tracked mask's measured track, baked into x/y/scale keyframes.
 *
 * The subject is an ellipse centred at x = 400 px of a 1920×1080 source, carried 1000 px to the
 * right over four seconds by a synthetic `position` track (a pure translation per frame). In a
 * 1080×1920 frame the render compiler's cover arithmetic gives:
 *
 *   fit = 0.5625, cover ≈ 3.1605, rendered width ≈ 3413.3 px, pan limit ±1166.7 px
 *
 * so the subject (0.21 → 0.73 of the width) is always reachable, and at ≈15 rendered px per
 * frame it never trips the 24 px/frame damping. The claim under test is geometric: read through
 * `framePlanAt` — the preview/export placement — the subject's centre sits at the frame's centre.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  framePlanAt,
  invertPatch,
  type AnyOperation,
  type TrackArtifact,
} from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import type { ContextInput } from '../context-builder.js';
import type { AiEvent } from '../events.js';
import { maskingOpsFromMeasurement, MASKING_TOOLS } from '../domain-tools/masking.js';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../providers/types.js';
import type { HostToolExecutor, HostToolOutcome } from '../tool-executor.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { unusableHostPayload } from '../reliability/refusal-notes.js';
import type { ReframeToSubjectMeasurement } from './contracts.js';
import {
  reframeToSubjectEdit,
  reframeToSubjectTarget,
  subjectSampleStride,
  subjectSamplesFromTrack,
} from './reframe-to-subject.js';

const SHA = (seed: string): string => seed.repeat(64).slice(0, 64);
const PIN = { key: SHA('d'), sha256: SHA('e') };
const FPS = 30;
const SOURCE = { width: 1920, height: 1080 };
const FRAME = { width: 1080, height: 1920 };
const SUBJECT_X = 400;
const TRAVEL_PX = 1000;
const CLIP_SOURCE_START = 2;
const CLIP_SECONDS = 4;
const FRAMES = CLIP_SECONDS * FPS;

const tracking = { artifact: PIN, method: 'position', referenceSourceTime: CLIP_SOURCE_START };
const runner = { kind: 'ellipse', id: 'runner', cx: SUBJECT_X, cy: 540, rx: 60, ry: 120, tracking };

function project(
  options: { masks?: unknown[]; media?: unknown; keyframes?: unknown[] } = {},
): Project {
  return parseProject({
    id: 'reframe_project',
    name: 'Reframe fixture',
    version: 1,
    fps: FPS,
    resolution: FRAME,
    assets: [
      {
        id: 'asset',
        path: 'run.mp4',
        kind: 'video',
        durationSeconds: 20,
        media: options.media ?? SOURCE,
      },
    ],
    timeline: {
      revision: 1,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'asset',
              trackId: 'v1',
              start: 0,
              end: CLIP_SECONDS,
              sourceStart: CLIP_SOURCE_START,
              sourceEnd: CLIP_SOURCE_START + CLIP_SECONDS,
              effects: [],
              masks: options.masks ?? [runner],
              keyframes: options.keyframes ?? [],
              crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 },
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

/** Horizontal travel of the track at tracked frame `index` (source frame 60 + index). */
const travelAt = (index: number, frames: number): number => (TRAVEL_PX * index) / (frames - 1);

/**
 * A `position` track over source seconds `from`..`to` on the 30 fps grid, microsecond pts, as
 * `track-run.ts` writes one.
 */
function track(
  from = CLIP_SOURCE_START,
  to = CLIP_SOURCE_START + CLIP_SECONDS,
  confidence = 0.9,
): TrackArtifact {
  const frames = Math.round((to - from) * FPS) + 1;
  const pts: number[] = [];
  const transforms: number[] = [];
  for (let index = 0; index < frames; index += 1) {
    pts.push(Math.round(((Math.round(from * FPS) + index) / FPS) * 1_000_000));
    transforms.push(1, 0, travelAt(index, frames), 0, 1, 0, 0, 0, 1);
  }
  return {
    version: 1,
    method: 'position',
    timeBase: [1, 1_000_000],
    originPts: 0,
    firstFrame: Math.round(from * FPS),
    pts,
    transforms,
    confidence: pts.map(() => confidence),
  };
}

const clipOf = (p: Project) => p.timeline.tracks[0]!.clips[0]!;

function measure(p: Project, artifact: TrackArtifact = track()): ReframeToSubjectMeasurement {
  const target = reframeToSubjectTarget(p, { clipId: 'shot', maskId: 'runner' });
  return {
    kind: 'reframe_to_subject',
    clipId: 'shot',
    maskId: 'runner',
    artifact: PIN,
    samples: subjectSamplesFromTrack({
      clip: target.clip,
      mask: target.mask,
      artifact,
      size: target.size,
      fps: FPS,
    }),
  };
}

function land(p: Project, operations: readonly AnyOperation[]) {
  const edit = assembleEdit(p, [...operations], 'reframe', 'agent');
  expect(edit.validation.valid).toBe(true);
  return { edit, after: applyProjectPatch(p, edit.patch) };
}

/** Output-pixel x of the subject's centre at clip frame `frame`, through the frame plan. */
function subjectOnScreen(p: Project, frame: number): { x: number; covers: boolean } {
  const layer = framePlanAt(p.timeline, p.assets, frame / FPS, p.resolution).layers[0]!;
  const { left, top, width, height } = layer.geometry!;
  const sourceX = SUBJECT_X + travelAt(frame, FRAMES + 1);
  return {
    x: left! + (sourceX / SOURCE.width) * width!,
    covers:
      left! <= 0.5 &&
      top! <= 0.5 &&
      left! + width! >= FRAME.width - 0.5 &&
      top! + height! >= FRAME.height - 0.5,
  };
}

describe('subjectSamplesFromTrack', () => {
  it('samples the subject six times a second, left to right, at its measured centre', () => {
    const samples = measure(project()).samples;
    expect(subjectSampleStride(FPS)).toBe(5);
    // The clip's first window is one-sided (frames 0–2), so its sample sits at their mean.
    expect(samples.map((sample) => sample.frame).slice(0, 3)).toEqual([1, 5, 10]);
    expect(samples.at(-1)!.frame).toBe(FRAMES - 2);
    for (const sample of samples) {
      const expected = (SUBJECT_X + travelAt(sample.frame, FRAMES + 1)) / SOURCE.width;
      expect(sample.x).toBeCloseTo(expected, 3);
      expect(sample.y).toBeCloseTo(0.5, 9);
      expect(sample.confidence).toBeCloseTo(0.9, 9);
    }
  });

  it('marks frames the track never measured, or measured without confidence, as unseen', () => {
    const partial = measure(project(), track(3, 5)).samples;
    expect(partial.find((sample) => sample.frame === 10)!.confidence).toBe(0);
    expect(partial.find((sample) => sample.frame === 60)!.confidence).toBeGreaterThan(0.5);
    const doubtful = measure(project(), track(undefined, undefined, 0.1)).samples;
    expect(doubtful.every((sample) => sample.confidence === 0)).toBe(true);
  });
});

describe('reframe_to_subject', () => {
  it('keeps the moving subject at the centre of the frame, and the picture covers it', () => {
    const p = project();
    const edit = reframeToSubjectEdit(p, { clipId: 'shot', maskId: 'runner' }, measure(p));
    const { after } = land(p, edit.operations);
    const clip = clipOf(after);
    expect(clip.crop).toBeUndefined();
    const x = clip.keyframes.filter((keyframe) => keyframe.property === 'x');
    expect(x.length).toBeGreaterThan(20);
    // The window pans right as the subject runs right: x offsets fall.
    expect(x[0]!.value).toBeGreaterThan(x.at(-1)!.value);
    for (const frame of [3, 30, 45, 61, 90, 118]) {
      const seen = subjectOnScreen(after, frame);
      expect(seen.covers).toBe(true);
      expect(Math.abs(seen.x - FRAME.width / 2)).toBeLessThan(2);
    }
  });

  it('writes one scale keyframe at the cover zoom and one y (the source is as tall as the frame)', () => {
    const p = project();
    const { after } = land(
      p,
      reframeToSubjectEdit(p, { clipId: 'shot', maskId: 'runner' }, measure(p)).operations,
    );
    const scale = clipOf(after).keyframes.filter((keyframe) => keyframe.property === 'scale');
    const y = clipOf(after).keyframes.filter((keyframe) => keyframe.property === 'y');
    expect(scale).toHaveLength(1);
    expect(scale[0]!.value).toBeCloseTo(3.1605, 3);
    expect(y).toHaveLength(1);
    expect(y[0]!.value).toBeCloseTo(0, 9);
  });

  it('says how many keyframes it wrote and where the window travels', () => {
    const p = project();
    const edit = reframeToSubjectEdit(p, { clipId: 'shot', maskId: 'runner' }, measure(p));
    expect(edit.note).toMatch(
      /Reframed shot to follow mask runner: \d+ x keyframes from 0 s to 3.9 s, at a 3.2× zoom/,
    );
    expect(edit.note).toMatch(/between 2\d% and 7\d% of the source's width/);
    expect(edit.data).toMatchObject({ kind: 'subject_reframe', axis: 'x', dampedSteps: 0 });
  });

  it('holds outside the span the track saw, and says so', () => {
    const p = project();
    const edit = reframeToSubjectEdit(
      p,
      { clipId: 'shot', maskId: 'runner' },
      measure(p, track(3, 5)),
    );
    const x = edit.operations
      .flatMap((op) => (op.type === 'add_keyframes' ? op.keyframes : []))
      .filter((keyframe) => keyframe.property === 'x');
    expect(x[0]!.time).toBeGreaterThanOrEqual(1 - 1 / FPS);
    expect(x.at(-1)!.time).toBeLessThanOrEqual(3 + 1 / FPS);
    expect(edit.note).toMatch(/Outside that span the track did not see the subject/);
  });

  it('undoes in one step, and a second run replaces the first instead of stacking', () => {
    const p = project({
      keyframes: [{ id: 'fade', time: 1, property: 'opacity', value: 1, easing: 'linear' }],
    });
    const args = { clipId: 'shot', maskId: 'runner' };
    const first = land(p, reframeToSubjectEdit(p, args, measure(p)).operations);
    const undone = applyProjectPatch(first.after, invertPatch(p.timeline, first.edit.patch));
    expect(clipOf(undone).crop).toEqual(clipOf(p).crop);
    expect(clipOf(undone).keyframes).toEqual(clipOf(p).keyframes);

    const again = land(
      first.after,
      reframeToSubjectEdit(first.after, args, measure(first.after)).operations,
    );
    expect(clipOf(again.after).keyframes).toHaveLength(clipOf(first.after).keyframes.length);
    expect(clipOf(again.after).keyframes.filter((k) => k.property === 'opacity')).toHaveLength(1);
  });

  it('refuses a mask with no track, naming track_mask as the remedy', () => {
    const untracked = project({ masks: [{ ...runner, tracking: undefined }] });
    expect(() => reframeToSubjectTarget(untracked, { clipId: 'shot', maskId: 'runner' })).toThrow(
      /not tracked[\s\S]*track_mask/,
    );
  });

  it('refuses a cut-out, an unknown mask, and a clip that already has the frame shape', () => {
    expect(() => reframeToSubjectTarget(project(), { clipId: 'shot', maskId: 'nope' })).toThrow(
      /get_masks/,
    );
    expect(() =>
      reframeToSubjectTarget(project({ media: FRAME }), { clipId: 'shot', maskId: 'runner' }),
    ).toThrow(/already has the frame’s shape[\s\S]*punch_in/);
    expect(() =>
      reframeToSubjectTarget(project(), { clipId: 'shot', maskId: 'runner', extra: 1 }),
    ).toThrow();
  });

  it('refuses a measurement of an older track, of another length of clip, or of an unseen subject', () => {
    const p = project();
    const args = { clipId: 'shot', maskId: 'runner' };
    const stale = { ...measure(p), artifact: { key: SHA('f'), sha256: SHA('e') } };
    expect(() => reframeToSubjectEdit(p, args, stale)).toThrow(/tracked again/);
    const longer = measure(p);
    const tooLong = {
      ...longer,
      samples: [...longer.samples, { frame: FRAMES + 10, x: 0.5, y: 0.5, confidence: 1 }],
    };
    expect(() => reframeToSubjectEdit(p, args, tooLong)).toThrow(/trimmed/);
    const unseen = measure(p, track(undefined, undefined, 0.1));
    expect(() => reframeToSubjectEdit(p, args, unseen)).toThrow(ToolRefusalError);
    expect(() => reframeToSubjectEdit(p, args, unseen)).toThrow(/never measured the subject/);
  });

  it('is a registered, host-measured masking tool whose payload is schema-checked', () => {
    const spec = MASKING_TOOLS.find((tool) => tool.name === 'reframe_to_subject');
    expect(spec).toMatchObject({ hostUiOnly: true, capabilities: ['masking'] });
    expect(() => spec!.parse!({ clipId: 'shot' })).toThrow();
    const p = project();
    expect(() =>
      maskingOpsFromMeasurement(
        'reframe_to_subject',
        { clipId: 'shot', maskId: 'runner' },
        { kind: 'x' },
        { project: p },
      ),
    ).toThrow(/could not read/);
    expect(unusableHostPayload('reframe_to_subject')).toMatch(/not reframed/);
  });
});

describe('reframe_to_subject through the orchestrator', () => {
  class ScriptedProvider implements AiProvider {
    public readonly name = 'mock' as const;
    private index = 0;
    public constructor(private readonly responses: readonly AiResponse[]) {}
    public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
      const response = this.responses[Math.min(this.index, this.responses.length - 1)]!;
      this.index += 1;
      return response;
    }
  }
  const opts = (): StreamOptions => ({ conversationId: 'c', turnId: 't', now: () => 1000 });
  const call = (args: Record<string, unknown>): AiResponse => ({
    text: '',
    toolCalls: [{ id: 'reframe_1', name: 'reframe_to_subject', arguments: args }],
  });
  const done: AiResponse = { text: 'done', toolCalls: [] };

  async function run(p: Project, executor: HostToolExecutor): Promise<AiEvent[]> {
    const input: ContextInput = { project: p, userPrompt: 'keep the runner in frame' };
    const events: AiEvent[] = [];
    for await (const event of new Orchestrator(
      new ScriptedProvider([call({ clipId: 'shot', maskId: 'runner' }), done]),
      {
        executor,
      },
    ).streamAgent(input, opts(), {})) {
      events.push(event);
    }
    return events;
  }
  const results = (events: readonly AiEvent[]) =>
    events.filter((e): e is Extract<AiEvent, { type: 'tool_result' }> => e.type === 'tool_result');

  it('turns the host measurement into a validated keyframe patch with its own result', async () => {
    const p = project();
    const outcome: HostToolOutcome = {
      status: 'completed',
      summary: 'Read where mask runner is across shot',
      data: measure(p),
    };
    const events = await run(p, { run: async () => outcome });
    const [result] = results(events);
    expect(result?.result).toMatchObject({
      kind: 'subject_reframe',
      clipId: 'shot',
      maskId: 'runner',
    });
    const diff = events.find((e): e is Extract<AiEvent, { type: 'diff' }> => e.type === 'diff');
    const operations = diff?.edit.patch.operations.map((operation) => operation.type);
    expect(operations).toEqual(['set_clip_crop', 'add_keyframes']);
    expect(diff?.edit.patch.createdBy).toBe('agent');
  });

  it('refuses an untracked mask before the host reads anything', async () => {
    let hostCalls = 0;
    const events = await run(project({ masks: [{ ...runner, tracking: undefined }] }), {
      run: async () => {
        hostCalls += 1;
        return { status: 'completed', summary: 'x', data: {} };
      },
    });
    expect(hostCalls).toBe(0);
    expect(JSON.stringify(results(events)[0]?.result)).toMatch(/track_mask/);
  });
});
