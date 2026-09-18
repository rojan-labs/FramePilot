import { describe, expect, it, vi } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { VisionFrame, VisionReviewRequest } from '../vision-review.js';
import {
  framesToSourceRanges,
  spotCheckFrames,
  spotCheckIsWarranted,
  spotCheckMask,
  spotCheckQuestion,
  type MaskSpotCheckControls,
} from './spot-check.js';

const project = (): Project =>
  parseProject({
    id: 'spot',
    name: 'Spot check',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: 'shot.mp4',
        kind: 'video',
        durationSeconds: 60,
        media: { width: 1920, height: 1080 },
      },
    ],
    timeline: {
      revision: 5,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          // Starts 10 s into the timeline and 20 s into the source, so the two clocks differ.
          clips: [
            {
              id: 'shot',
              assetId: 'asset',
              trackId: 'v1',
              start: 10,
              end: 14,
              sourceStart: 20,
              sourceEnd: 24,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });

const frame = (index: number): VisionFrame => ({
  frame: index,
  imageBase64: 'AAAA',
  mediaType: 'image/jpeg',
});

function controls(
  verdict: 'pass' | 'fail' | 'cannot_tell',
  over: Partial<MaskSpotCheckControls> = {},
) {
  const seen: VisionReviewRequest[] = [];
  const value: MaskSpotCheckControls = {
    acquire: vi.fn(async (_project: Project, request: VisionReviewRequest) => {
      seen.push(request);
      return request.frames.map(frame);
    }),
    judge: vi.fn(async () => ({ verdict, reason: 'The kept region is a woman’s face.' })),
    reviewer: {
      transport: 'local_pack',
      provider: 'framepilot',
      model: 'smolvlm2',
      promptVersion: 'v1',
      packVersion: '1.0.0',
    },
    ...over,
  };
  return { value, seen };
}

const base = {
  project: project(),
  clipId: 'shot',
  maskId: 'm1',
  label: 'face',
  purpose: 'hide' as const,
  flagged: [],
};

describe('when a look is warranted', () => {
  it('is only where the numbers left the question open', () => {
    expect(
      spotCheckIsWarranted({ flaggedCount: 0, candidateScore: 0.95, editorChose: false }),
    ).toBe(false);
    expect(
      spotCheckIsWarranted({ flaggedCount: 2, candidateScore: 0.95, editorChose: false }),
    ).toBe(true);
    expect(spotCheckIsWarranted({ flaggedCount: 0, candidateScore: 0.6, editorChose: false })).toBe(
      true,
    );
    expect(spotCheckIsWarranted({ flaggedCount: 0, editorChose: false })).toBe(true);
  });

  it('never second-guesses a target the editor chose', () => {
    expect(spotCheckIsWarranted({ flaggedCount: 3, candidateScore: 0.2, editorChose: true })).toBe(
      false,
    );
  });
});

describe('the question and the frames', () => {
  it('is one question a person could answer by looking, with the three answers named', () => {
    const question = spotCheckQuestion('face', 'hide');
    expect(question).toContain('Is the masked region the face?');
    expect(question).toContain('the part of the picture that is removed');
    expect(question.match(/\?/g)).toHaveLength(1);
  });

  it('looks at flagged moments first, never more than four frames, all inside the clip', () => {
    const frames = spotCheckFrames({
      ...base,
      flagged: [
        { start: 21, end: 21.5 },
        { start: 23, end: 23.2 },
      ],
    });
    expect(frames).toHaveLength(4);
    // Source 21.25 s is 1.25 s into the clip, which starts at timeline 10 s.
    expect(frames[0]).toBe(Math.round(11.25 * 24));
    for (const index of frames) {
      expect(index).toBeGreaterThanOrEqual(240);
      expect(index).toBeLessThanOrEqual(335);
    }
    expect(spotCheckFrames({ ...base, clipId: 'gone' })).toEqual([]);
  });

  it('turns the frames it looked at back into source ranges for the review list', () => {
    const [range] = framesToSourceRanges(project(), 'shot', [264]);
    expect(range!.start).toBeCloseTo(21);
    expect(range!.end).toBeCloseTo(21 + 1 / 24);
  });
});

describe('spotCheckMask', () => {
  it('maps the three answers, asking once with at most four frames', async () => {
    for (const [verdict, expected] of [
      ['pass', 'yes'],
      ['fail', 'no'],
      ['cannot_tell', 'unsure'],
    ] as const) {
      const { value, seen } = controls(verdict);
      const result = await spotCheckMask({ ...base, controls: value });
      expect(result.verdict).toBe(expected);
      expect(value.judge).toHaveBeenCalledTimes(1);
      expect(seen[0]!.frames.length).toBeLessThanOrEqual(4);
      expect(seen[0]!.objective).toContain('Is the masked region the face?');
    }
  });

  it('is not_run without a reviewer, and never throws', async () => {
    expect((await spotCheckMask(base)).verdict).toBe('not_run');
    const { value } = controls('pass', {
      acquire: vi.fn(async () => Promise.reject(new Error('sidecar down'))),
    });
    const result = await spotCheckMask({ ...base, controls: value });
    expect(['unsure', 'not_run']).toContain(result.verdict);
  });

  it('sends no frame to a cloud reviewer without the editor’s consent', async () => {
    const { value } = controls('pass', {
      reviewer: { transport: 'cloud', provider: 'anthropic', model: 'claude', promptVersion: 'v1' },
    });
    const result = await spotCheckMask({ ...base, controls: value });
    expect(result.verdict).toBe('not_run');
    expect(value.acquire).not.toHaveBeenCalled();
    expect(value.judge).not.toHaveBeenCalled();
  });

  it('confirms nothing for a run that was cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const { value } = controls('pass');
    const result = await spotCheckMask({ ...base, controls: value, signal: abort.signal });
    expect(result.verdict).not.toBe('yes');
  });
});
