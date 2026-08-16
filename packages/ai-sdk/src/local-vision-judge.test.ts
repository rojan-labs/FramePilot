import { describe, expect, it } from 'vitest';
import {
  EDGE_TOLERANCE,
  MIN_SUBJECT_CONFIDENCE,
  createLocalVisionJudge,
  type LocalDetection,
} from './local-vision-judge.js';
import { reviewVisionObjectives, VISION_REVIEW_VERSION } from './vision-review.js';

const REVISION = 2;
const LOCAL_REVIEWER = {
  transport: 'local_pack',
  provider: 'framepilot-subject-intelligence',
  model: 'yunet+yolox',
  promptVersion: 'framing-v1',
  packVersion: '1.0.0+sha256:abc',
} as const;

function frame(index = 0) {
  return { frame: index, imageBase64: 'iVBORw0KGgo=', mediaType: 'image/png' as const };
}

function face(
  overrides: Partial<LocalDetection['box']> = {},
  confidence = 0.9,
): LocalDetection {
  return {
    label: 'face',
    box: { x: 0.4, y: 0.3, width: 0.2, height: 0.2, ...overrides },
    confidence,
  };
}

async function judge(
  detections: readonly LocalDetection[],
  requestId = 'patch-1:crop-framing:clip-1',
) {
  const run = createLocalVisionJudge(async () => detections);
  return run({ objective: 'Is the subject framed?', frames: [frame()], requestId });
}

describe('local vision judge', () => {
  it('passes a subject that sits clear of every edge', async () => {
    expect(await judge([face()])).toMatchObject({ verdict: 'pass' });
  });

  it('fails a subject cut off at the frame edge, naming where', async () => {
    const verdict = await judge([face({ x: 0 })]);

    expect(verdict).toMatchObject({ verdict: 'fail', frame: 0 });
    expect((verdict as { reason: string }).reason).toMatch(/left edge/i);
  });

  it('names every edge the subject runs off', async () => {
    const verdict = await judge([face({ x: 0, y: 0 })]);

    expect((verdict as { reason: string }).reason).toMatch(/left and top/i);
  });

  it('tolerates a subject standing legitimately near the edge', async () => {
    // Without a tolerance, a correctly framed edge-of-frame shot would fail.
    expect(await judge([face({ x: EDGE_TOLERANCE * 2 })])).toMatchObject({ verdict: 'pass' });
  });

  it('does not fail an edit on a low-confidence detection', async () => {
    const verdict = await judge([face({ x: 0 }, MIN_SUBJECT_CONFIDENCE - 0.01)]);

    expect(verdict).toMatchObject({ verdict: 'cannot_tell' });
  });

  it('says it cannot tell when it finds nobody, rather than failing', async () => {
    // Finding no person is not proof of bad framing — it may not be a shot of a
    // person at all. Failing here would block correct edits on B-roll.
    const verdict = await judge([]);

    expect(verdict).toMatchObject({ verdict: 'cannot_tell' });
    expect((verdict as { reason: string }).reason).toMatch(/no recognizable subject/i);
  });

  it('ignores person boxes, which legitimately run off the bottom of frame', async () => {
    const person: LocalDetection = {
      label: 'person',
      box: { x: 0.3, y: 0.4, width: 0.4, height: 0.6 },
      confidence: 0.95,
    };

    expect(await judge([person])).toMatchObject({ verdict: 'cannot_tell' });
  });

  it('refuses objectives a detector cannot honestly answer', async () => {
    for (const kind of ['transition-coherence', 'mask-subject', 'tracked-subject']) {
      const verdict = await judge([face()], `patch-1:${kind}:clip-1`);

      expect(verdict, kind).toMatchObject({ verdict: 'cannot_tell' });
      expect((verdict as { reason: string }).reason).toContain(kind);
    }
  });

  it('reports a detector failure instead of guessing', async () => {
    const run = createLocalVisionJudge(async () => {
      throw new Error('pack not installed');
    });

    const verdict = await run({
      objective: 'Is the subject framed?',
      frames: [frame()],
      requestId: 'patch-1:crop-framing:clip-1',
    });

    expect(verdict).toMatchObject({ verdict: 'cannot_tell' });
    expect((verdict as { reason: string }).reason).toMatch(/pack not installed/);
  });

  it('fails on the first frame that loses the subject, across a move', async () => {
    const perFrame: Record<number, readonly LocalDetection[]> = {
      0: [face()],
      1: [face()],
      2: [face({ x: 0.85, width: 0.2 })],
    };
    const run = createLocalVisionJudge(async (item) => perFrame[item.frame] ?? []);

    const verdict = await run({
      objective: 'Does the subject stay framed?',
      frames: [frame(0), frame(1), frame(2)],
      requestId: 'patch-1:motion-framing:clip-1',
    });

    expect(verdict).toMatchObject({ verdict: 'fail', frame: 2 });
  });

  it('drives a real review end to end and confirms the objective', async () => {
    const report = await reviewVisionObjectives({
      requests: [
        {
          schemaVersion: VISION_REVIEW_VERSION,
          requestId: 'patch-1:crop-framing:clip-1',
          projectRevision: REVISION,
          objective: 'After the crop, is the subject intentionally framed?',
          frames: [0],
        },
      ],
      projectRevision: REVISION,
      acquire: async () => [frame()],
      judge: createLocalVisionJudge(async () => [face()]),
      reviewer: LOCAL_REVIEWER,
    });

    expect(report.ok).toBe(true);
    // Local means local: the identity carries no cloud transport and no consent.
    expect(report.reviewer?.transport).toBe('local_pack');
  });

  it('leaves an unanswerable objective unverified through the real review', async () => {
    const report = await reviewVisionObjectives({
      requests: [
        {
          schemaVersion: VISION_REVIEW_VERSION,
          requestId: 'patch-1:transition-coherence:clip-1',
          projectRevision: REVISION,
          objective: 'Is the transition visually coherent?',
          frames: [0],
        },
      ],
      projectRevision: REVISION,
      acquire: async () => [frame()],
      judge: createLocalVisionJudge(async () => [face()]),
      reviewer: LOCAL_REVIEWER,
    });

    expect(report.ok).toBe(false);
    expect(report.checks[0]!.status).toBe('unverified');
  });
});
