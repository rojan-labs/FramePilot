import { describe, expect, it } from 'vitest';
import { critique } from './critic.js';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  reviewVisionObjectives,
  VISION_REVIEW_VERSION,
  type VisionReviewRequest,
} from './vision-review.js';

const REVISION = 4;
const LOCAL_REVIEWER = {
  transport: 'local_pack',
  provider: 'framepilot-subject-intelligence',
  model: 'subject-reviewer',
  promptVersion: 'vision-objective-v1',
  packVersion: '1.2.3+sha256:abc',
} as const;

function request(overrides: Partial<VisionReviewRequest> = {}): VisionReviewRequest {
  return {
    schemaVersion: VISION_REVIEW_VERSION,
    requestId: 'framing',
    projectRevision: REVISION,
    objective: 'Is the speaker still fully in frame after the reframe?',
    frames: [0, 30],
    ...overrides,
  } as VisionReviewRequest;
}

const acquire = async (value: VisionReviewRequest) =>
  value.frames.map((frame) => ({
    frame,
    imageBase64: 'iVBORw0KGgo=',
    mediaType: 'image/png' as const,
  }));

function project(): Project {
  return parseProject({
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 5 }],
    timeline: {
      revision: REVISION,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v1',
              start: 0,
              end: 5,
              sourceStart: 0,
              sourceEnd: 5,
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
}

describe('vision review', () => {
  it('confirms a semantic objective only from a well-formed pass verdict', async () => {
    const report = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => ({ verdict: 'pass', reason: 'The speaker is fully inside frame.' }),
      reviewer: LOCAL_REVIEWER,
    });
    expect(report.ok).toBe(true);
    expect(report.checks[0]).toMatchObject({ status: 'pass' });
  });

  it.each([
    ['no reviewer is configured', undefined, undefined, /no vision reviewer/i],
    [
      'the model cannot tell',
      acquire,
      async () => ({ verdict: 'cannot_tell', reason: 'The frame is too dark to judge.' }),
      /too dark/i,
    ],
    ['the verdict is malformed', acquire, async () => ({ looksGood: true }), /no usable shape/i],
    [
      'the reviewer throws',
      acquire,
      async () => {
        throw new Error('model unavailable');
      },
      /model unavailable/i,
    ],
    [
      'a frame could not be acquired',
      async () => [{ frame: 0, imageBase64: 'iVBORw0KGgo=', mediaType: 'image/png' as const }],
      async () => ({ verdict: 'pass', reason: 'Fine.' }),
      /Frames 30 could not be acquired/i,
    ],
  ])('leaves the objective unverified when %s', async (_name, acquirer, judge, message) => {
    const report = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      ...(acquirer ? { acquire: acquirer as never } : {}),
      ...(judge ? { judge: judge as never } : {}),
      ...(judge && acquirer ? { reviewer: LOCAL_REVIEWER } : {}),
    });
    // Never `pass`: an unanswered question is the one thing a gate must not wave through.
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.status).toBe('unverified');
    expect(report.checks[0]!.reason).toMatch(message);
  });

  it('reports a fail verdict with the frame it rests on', async () => {
    const report = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => ({
        verdict: 'fail',
        reason: 'The speaker’s head is cropped at the top.',
        frame: 30,
      }),
      reviewer: LOCAL_REVIEWER,
    });
    expect(report.checks[0]).toMatchObject({ status: 'fail', frames: [30] });
  });

  it('refuses a request bound to another revision', async () => {
    await expect(
      reviewVisionObjectives({
        requests: [request({ projectRevision: REVISION - 1 })],
        projectRevision: REVISION,
        acquire,
        judge: async () => ({ verdict: 'pass', reason: 'Fine.' }),
        reviewer: LOCAL_REVIEWER,
      }),
    ).rejects.toThrow(/targets revision/i);
  });

  it('bounds how much one semantic question may look at', async () => {
    await expect(
      reviewVisionObjectives({
        requests: [request({ frames: [0, 1, 2, 3, 4] })],
        projectRevision: REVISION,
        acquire,
        judge: async () => ({ verdict: 'pass', reason: 'Fine.' }),
        reviewer: LOCAL_REVIEWER,
      }),
    ).rejects.toThrow();
    // Repeated frames are refused for the same reason: they cost a look and add nothing.
    await expect(
      reviewVisionObjectives({
        requests: [request({ frames: [7, 7] })],
        projectRevision: REVISION,
        acquire,
        judge: async () => ({ verdict: 'pass', reason: 'Fine.' }),
        reviewer: LOCAL_REVIEWER,
      }),
    ).rejects.toThrow(/distinct/i);
  });

  it('adds to the critic gate without ever rescuing a measured failure', async () => {
    const passing = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => ({ verdict: 'pass', reason: 'Framed.' }),
      reviewer: LOCAL_REVIEWER,
    });
    const base = project();

    // A clean vision pass over a render the deterministic checks failed stays failed.
    const rescued = critique(base, {
      vision: passing,
      render: { hasBlackFrames: true, durationSeconds: 5 },
    });
    expect(rescued.ok).toBe(false);

    // …and a vision failure fails a review that measured clean.
    const failing = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => ({ verdict: 'fail', reason: 'The subject left frame.' }),
      reviewer: LOCAL_REVIEWER,
    });
    expect(critique(base, { vision: failing }).ok).toBe(false);
    expect(critique(base, { vision: passing }).ok).toBe(true);
  });

  it('refuses cloud media egress without a run-scoped consent receipt', async () => {
    let acquired = false;
    const cloud = {
      transport: 'cloud',
      provider: 'anthropic',
      model: 'claude-vision',
      promptVersion: 'vision-objective-v1',
    } as const;
    const denied = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire: async (value) => {
        acquired = true;
        return acquire(value);
      },
      judge: async () => ({ verdict: 'pass', reason: 'Fine.' }),
      reviewer: cloud,
    });
    expect(denied.ok).toBe(false);
    expect(denied.checks[0]?.reason).toMatch(/media-egress consent/i);
    expect(acquired).toBe(false);

    const approved = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => ({ verdict: 'pass', reason: 'Fine.' }),
      reviewer: cloud,
      mediaEgressConsent: {
        approved: true,
        consentId: 'consent-run-1',
        approvedAt: '2026-08-13T10:00:00+05:45',
      },
    });
    expect(approved.ok).toBe(true);
    expect(approved.reviewer).toEqual(cloud);
  });

  it('leaves objectives unverified when the run is cancelled before they are asked', async () => {
    let asked = false;
    const report = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => {
        asked = true;
        return { verdict: 'pass', reason: 'Framed.' };
      },
      reviewer: LOCAL_REVIEWER,
      signal: AbortSignal.abort(),
    });

    expect(asked).toBe(false);
    expect(report.checks[0]!.status).toBe('unverified');
    expect(report.checks[0]!.reason).toMatch(/cancelled/i);
    expect(report.ok).toBe(false);
  });

  it('discards a verdict that arrives after cancellation', async () => {
    // The dangerous case: the judge was already in flight, so it answers anyway.
    // A `pass` returned after the user stopped the run must not confirm anything.
    const controller = new AbortController();
    const report = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => {
        controller.abort();
        return { verdict: 'pass', reason: 'Framed.' };
      },
      reviewer: LOCAL_REVIEWER,
      signal: controller.signal,
    });

    expect(report.checks[0]!.status).toBe('unverified');
    expect(report.ok).toBe(false);
  });

  it('cancels the remaining objectives without confirming the ones not yet asked', async () => {
    const controller = new AbortController();
    const report = await reviewVisionObjectives({
      requests: [request({ requestId: 'framing' }), request({ requestId: 'crop' })],
      projectRevision: REVISION,
      acquire,
      judge: async () => {
        controller.abort();
        return { verdict: 'pass', reason: 'Framed.' };
      },
      reviewer: LOCAL_REVIEWER,
      signal: controller.signal,
    });

    expect(report.checks.map((check) => check.status)).toEqual(['unverified', 'unverified']);
  });

  it('cannot auto-commit on a cancelled review', async () => {
    // The gate, not just the report: an unverified objective must fail the critic
    // that guards auto-commit, so cancellation cannot end in a committed edit.
    const cancelled = await reviewVisionObjectives({
      requests: [request()],
      projectRevision: REVISION,
      acquire,
      judge: async () => ({ verdict: 'pass', reason: 'Framed.' }),
      reviewer: LOCAL_REVIEWER,
      signal: AbortSignal.abort(),
    });

    const gate = critique(project(), { vision: cancelled });
    expect(gate.ok).toBe(false);
    expect(gate.checks.find((check) => check.id === 'vision_review')?.status).not.toBe('pass');
  });
});
