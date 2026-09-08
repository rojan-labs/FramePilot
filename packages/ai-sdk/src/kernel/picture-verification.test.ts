import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { TemporalEvidenceBatch, TemporalEvidenceRequest } from '../temporal-review.js';
import type { VisionFrame } from '../vision-review.js';
import type {
  PictureClip,
  PictureCut,
  PictureCutFlag,
  PictureSlice,
} from './semantic-index/picture.js';
import { initialWorkingState } from './working-state.js';
import {
  MAX_VERIFIED_CUTS_PER_APPLY,
  MAX_VISION_PAIRS_PER_APPLY,
  SHOT_MATCH_MAX_DIFFERENCE,
  TRANSITION_CONTINUITY_MAX_DIFFERENCE,
  VISION_FRAMES_PER_PAIR,
  recordPictureVerification,
  verificationCandidates,
  verifyPictureAfterApply,
  visionEscalationAllowed,
  type PictureVisionControls,
} from './picture-verification.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FPS = 30;

const project = {
  fps: FPS,
  timeline: { revision: 7 },
} as unknown as Project;

function cut(over: Partial<PictureCut> & Pick<PictureCut, 'fromClipId' | 'toClipId'>): PictureCut {
  return {
    trackId: 'v1',
    at: 4,
    delta: {
      luma: null,
      warmth: null,
      sat: null,
      contrast: null,
      shotSizeSteps: null,
      sameSetting: null,
      sameEntities: [],
      motionChange: null,
      duplicate: null,
      transition: null,
    },
    flags: [],
    ...over,
  } as PictureCut;
}

function describedClip(clipId: string, subject: string): PictureClip {
  return {
    clipId,
    trackId: 'v1',
    start: 0,
    end: 4,
    assetId: 'a1',
    shots: [],
    dominant: {
      shotKey: `${clipId}:0`,
      assetId: 'a1',
      contentHash: 'h',
      shotIndex: 0,
      t0: 0,
      t1: 4,
      splitOf: false,
      measured: null,
      labelled: null,
      described: {
        tier2Version: 1,
        model: 'm',
        summary: subject,
        subject,
        action: '',
        setting: subject,
        camera: {},
        mood: '',
        onScreenText: [],
        quality: [],
        p: 0.8,
      },
    },
  } as unknown as PictureClip;
}

function slice(cuts: readonly PictureCut[], clips: readonly PictureClip[] = []): PictureSlice {
  return {
    clips,
    cuts,
    coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
  };
}

/** A batch that answers every comparison with `difference` and every frame with `blackRatio`. */
function batchAnswering(
  requests: readonly TemporalEvidenceRequest[],
  values: { difference?: number; blackRatio?: number } = {},
): TemporalEvidenceBatch {
  const renderSettings = {
    identity: 'review:640x360@30:captions=false',
    presetId: 'review',
    width: 640,
    height: 360,
    fps: 30,
    burnCaptions: false,
  } as const;
  return {
    renderSettings,
    results: requests.map((request) =>
      request.kind === 'comparison'
        ? {
            schemaVersion: 1,
            kind: 'comparison',
            requestId: request.requestId,
            projectRevision: request.projectRevision,
            renderSettings,
            leftFrame: request.leftFrame,
            rightFrame: request.rightFrame,
            difference: values.difference ?? 0,
          }
        : {
            schemaVersion: 1,
            kind: 'frame',
            requestId: request.requestId,
            projectRevision: request.projectRevision,
            renderSettings,
            sample: {
              frame: request.kind === 'frame' ? request.atFrame : 0,
              luma: 0.1,
              blackRatio: values.blackRatio ?? 0,
              perceptualHash: null,
            },
          },
    ),
  } as TemporalEvidenceBatch;
}

function acquirerReturning(values: { difference?: number; blackRatio?: number } = {}): {
  readonly acquire: (
    p: Project,
    requests: readonly TemporalEvidenceRequest[],
  ) => Promise<TemporalEvidenceBatch>;
  readonly seen: TemporalEvidenceRequest[][];
} {
  const seen: TemporalEvidenceRequest[][] = [];
  return {
    seen,
    acquire: (_p, requests) => {
      seen.push([...requests]);
      return Promise.resolve(batchAnswering(requests, values));
    },
  };
}

function flaggedCut(id: number, flags: readonly PictureCutFlag[], at: number): PictureCut {
  return cut({ fromClipId: `c${String(id)}`, toClipId: `c${String(id + 1)}`, at, flags });
}

const visionControls = (over: Partial<PictureVisionControls> = {}): PictureVisionControls => ({
  acquire: (_p, request) =>
    Promise.resolve(
      request.frames.map((frame): VisionFrame => ({
        frame,
        imageBase64: 'aGk=',
        mediaType: 'image/png',
      })),
    ),
  judge: () => Promise.resolve({ verdict: 'pass', reason: 'Same room, same light' }),
  reviewer: {
    transport: 'local_pack',
    provider: 'pack',
    model: 'vlm',
    promptVersion: '1',
    packVersion: '1.0.0',
  },
  provider: 'mock',
  model: 'mock-vision',
  hasBudgetHeadroom: true,
  ...over,
});

// ---------------------------------------------------------------------------
// VU7.1 — candidate selection
// ---------------------------------------------------------------------------

describe('verificationCandidates', () => {
  it('checks a flag this apply introduced', () => {
    const before = slice([cut({ fromClipId: 'c1', toClipId: 'c2' })]);
    const after = slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })]);
    expect(verificationCandidates(before, after)).toHaveLength(1);
  });

  it('ignores a flag the footage inherited — an advisory is never this run’s shortfall', () => {
    const inherited = [cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })];
    expect(verificationCandidates(slice(inherited), slice(inherited))).toEqual([]);
  });

  it('checks only the NEW flag when a cut worsens', () => {
    const before = slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['wb_jump'] })]);
    const after = slice([
      cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['wb_jump', 'black_in'] }),
    ]);
    const [candidate] = verificationCandidates(before, after);
    expect(candidate?.newFlags).toEqual(['black_in']);
    expect(candidate?.inheritedFlags).toEqual(['wb_jump']);
  });

  it('ignores a removed cut and a flag-free unchanged one', () => {
    const before = slice([
      cut({ fromClipId: 'c1', toClipId: 'c2' }),
      cut({ fromClipId: 'c3', toClipId: 'c4' }),
    ]);
    const after = slice([cut({ fromClipId: 'c1', toClipId: 'c2' })]);
    expect(verificationCandidates(before, after)).toEqual([]);
  });

  it(`never returns more than ${String(MAX_VERIFIED_CUTS_PER_APPLY)} pairs`, () => {
    const after = slice(
      Array.from({ length: 9 }, (_unused, index) =>
        flaggedCut(index * 2, ['exposure_jump'], index + 1),
      ),
    );
    expect(verificationCandidates(null, after)).toHaveLength(MAX_VERIFIED_CUTS_PER_APPLY);
  });

  it('spends its four pairs on the worst defects first', () => {
    const after = slice([
      flaggedCut(0, ['wb_jump'], 1),
      flaggedCut(2, ['wb_jump'], 2),
      flaggedCut(4, ['wb_jump'], 3),
      flaggedCut(6, ['wb_jump'], 4),
      flaggedCut(8, ['black_in'], 9),
    ]);
    const chosen = verificationCandidates(null, after);
    expect(chosen[0]?.at).toBe(9);
    expect(chosen).toHaveLength(MAX_VERIFIED_CUTS_PER_APPLY);
  });
});

// ---------------------------------------------------------------------------
// VU7.1 — the deterministic pass
// ---------------------------------------------------------------------------

describe('verifyPictureAfterApply — deterministic', () => {
  it('says nothing when this apply touched no cut it is answerable for', async () => {
    const same = [cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['wb_jump'] })];
    const report = await verifyPictureAfterApply({
      project,
      before: slice(same),
      after: slice(same),
      patchId: 'p1',
      acquireTemporal: acquirerReturning().acquire,
    });
    expect(report.checks).toEqual([]);
    expect(report.briefingLine).toBe('');
  });

  it('asks for shot_match on an exposure jump and confirms a residual outside tolerance', async () => {
    const { acquire, seen } = acquirerReturning({
      difference: SHOT_MATCH_MAX_DIFFERENCE + 0.1,
    });
    const report = await verifyPictureAfterApply({
      project,
      before: slice([cut({ fromClipId: 'c1', toClipId: 'c2' })]),
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })]),
      patchId: 'p1',
      acquireTemporal: acquire,
    });
    const [request] = seen[0] ?? [];
    expect(request?.kind).toBe('comparison');
    expect(request).toMatchObject({ check: 'shot_match', leftFrame: 119, rightFrame: 120 });
    expect(report.checks[0]).toMatchObject({ method: 'shot_match', status: 'confirmed' });
    expect(report.framesShownToModel).toBe(0);
    expect(report.framesDecoded).toBe(2);
  });

  it('refutes an exposure jump the render does not show', async () => {
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })]),
      patchId: 'p1',
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
    });
    expect(report.checks[0]?.status).toBe('refuted');
  });

  it('asks for transition_continuity on a new cut that carries a transition', async () => {
    const { acquire, seen } = acquirerReturning({
      difference: TRANSITION_CONTINUITY_MAX_DIFFERENCE + 0.05,
    });
    const after = slice([
      cut({
        fromClipId: 'c1',
        toClipId: 'c2',
        delta: {
          luma: null,
          warmth: null,
          sat: null,
          contrast: null,
          shotSizeSteps: null,
          sameSetting: true,
          sameEntities: [],
          motionChange: null,
          duplicate: null,
          transition: 'cross_dissolve',
        },
      }),
    ]);
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after,
      patchId: 'p1',
      acquireTemporal: acquire,
    });
    expect(seen[0]?.[0]).toMatchObject({ check: 'transition_continuity' });
    expect(report.checks[0]).toMatchObject({
      method: 'transition_continuity',
      status: 'confirmed',
    });
  });

  it('asks for a black_ratio frame on black_in and believes the number', async () => {
    const { acquire, seen } = acquirerReturning({ blackRatio: 1 });
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['black_in'] })]),
      patchId: 'p1',
      acquireTemporal: acquire,
    });
    expect(seen[0]?.[0]).toMatchObject({ kind: 'frame', metrics: ['black_ratio'], atFrame: 120 });
    expect(report.checks[0]).toMatchObject({ method: 'black_ratio', status: 'confirmed' });
    expect(report.framesDecoded).toBe(1);
  });

  it('sends ONE batch for every pair', async () => {
    const { acquire, seen } = acquirerReturning();
    await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([
        flaggedCut(0, ['exposure_jump'], 1),
        flaggedCut(2, ['wb_jump'], 2),
        flaggedCut(4, ['black_in'], 3),
      ]),
      patchId: 'p1',
      acquireTemporal: acquire,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(3);
  });

  it('reports unverified — never verified — when the host has no evidence route', async () => {
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })]),
      patchId: 'p1',
    });
    expect(report.checks[0]?.status).toBe('unverified');
    expect(report.checks[0]?.detail).toContain('no render evidence route');
    expect(report.framesDecoded).toBe(0);
  });

  it('reports unverified when the acquirer throws', async () => {
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })]),
      patchId: 'p1',
      acquireTemporal: () => Promise.reject(new Error('sidecar down')),
    });
    expect(report.checks[0]?.status).toBe('unverified');
  });

  it('confirms nothing when the run is cancelled mid-batch', async () => {
    const controller = new AbortController();
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['black_in'] })]),
      patchId: 'p1',
      signal: controller.signal,
      acquireTemporal: (_p, requests) => {
        // The answer arrives, but only after the user stopped the run.
        controller.abort();
        return Promise.resolve(batchAnswering(requests, { blackRatio: 1 }));
      },
    });
    expect(report.checks[0]?.status).toBe('unverified');
    expect(report.checks[0]?.detail).toContain('cancelled');
  });

  it('never asks for anything once the signal is already aborted', async () => {
    const acquire = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })]),
      patchId: 'p1',
      signal: controller.signal,
      acquireTemporal: acquire as never,
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(report.checks[0]?.status).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// VU7.2 — vision, only where numbers cannot decide
// ---------------------------------------------------------------------------

/** A cut whose residual will land inside tolerance while the two shots are described apart. */
function undecidableSlice(count: number): PictureSlice {
  const cuts: PictureCut[] = [];
  const clips: PictureClip[] = [];
  for (let index = 0; index < count; index += 1) {
    const from = `c${String(index * 2)}`;
    const to = `c${String(index * 2 + 1)}`;
    cuts.push(cut({ fromClipId: from, toClipId: to, at: index + 1, flags: ['wb_jump'] }));
    clips.push(describedClip(from, `kitchen ${String(index)}`));
    clips.push(describedClip(to, `street ${String(index)}`));
  }
  return { clips, cuts, coverage: { measured: 0, labelled: 0, described: 0, total: 0 } };
}

describe('verifyPictureAfterApply — vision escalation', () => {
  const undecidable = { project, before: null, patchId: 'p1' } as const;

  it('does NOT escalate a pair the numbers already decided', async () => {
    const judge = vi.fn();
    const report = await verifyPictureAfterApply({
      ...undecidable,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['wb_jump'] })]),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
      vision: visionControls({ judge: judge as never }),
    });
    expect(judge).not.toHaveBeenCalled();
    expect(report.checks[0]?.status).toBe('refuted');
    expect(report.framesShownToModel).toBe(0);
  });

  it('leaves an undecided pair undecided with no vision provider, and says so', async () => {
    const report = await verifyPictureAfterApply({
      ...undecidable,
      after: undecidableSlice(1),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
    });
    expect(report.checks[0]?.status).toBe('undecided');
    expect(report.checks[0]?.method).toBe('shot_match');
    expect(report.framesShownToModel).toBe(0);
  });

  it('refuses to look when the configured model cannot read an image', async () => {
    const judge = vi.fn();
    const report = await verifyPictureAfterApply({
      ...undecidable,
      after: undecidableSlice(1),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
      vision: visionControls({ provider: 'openai', model: 'gpt-3.5-turbo', judge: judge as never }),
    });
    expect(judge).not.toHaveBeenCalled();
    expect(report.checks[0]?.status).toBe('undecided');
  });

  it('refuses to look when the run has no budget headroom', async () => {
    const judge = vi.fn();
    await verifyPictureAfterApply({
      ...undecidable,
      after: undecidableSlice(1),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
      vision: visionControls({ hasBudgetHeadroom: false, judge: judge as never }),
    });
    expect(judge).not.toHaveBeenCalled();
  });

  it('looks at an undecidable pair and settles it', async () => {
    const report = await verifyPictureAfterApply({
      ...undecidable,
      after: undecidableSlice(1),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
      vision: visionControls(),
    });
    expect(report.checks[0]).toMatchObject({ method: 'vision', status: 'refuted' });
    expect(report.framesShownToModel).toBe(VISION_FRAMES_PER_PAIR);
  });

  it('a fail verdict confirms the defect', async () => {
    const report = await verifyPictureAfterApply({
      ...undecidable,
      after: undecidableSlice(1),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
      vision: visionControls({
        judge: () => Promise.resolve({ verdict: 'fail', reason: 'The second shot is far cooler' }),
      }),
    });
    expect(report.checks[0]?.status).toBe('confirmed');
  });

  it('cannot_tell settles as unverified, not as a pass', async () => {
    const report = await verifyPictureAfterApply({
      ...undecidable,
      after: undecidableSlice(1),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
      vision: visionControls({
        judge: () => Promise.resolve({ verdict: 'cannot_tell', reason: 'Both frames are dark' }),
      }),
    });
    expect(report.checks[0]?.status).toBe('unverified');
  });

  it(`looks at no more than ${String(MAX_VISION_PAIRS_PER_APPLY)} pairs of ${String(VISION_FRAMES_PER_PAIR)} frames`, async () => {
    const seen: number[] = [];
    const report = await verifyPictureAfterApply({
      ...undecidable,
      after: undecidableSlice(4),
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
      vision: visionControls({
        judge: (input) => {
          seen.push(input.frames.length);
          return Promise.resolve({ verdict: 'pass', reason: 'Same scene' });
        },
      }),
    });
    expect(seen).toHaveLength(MAX_VISION_PAIRS_PER_APPLY);
    expect(seen.every((count) => count === VISION_FRAMES_PER_PAIR)).toBe(true);
    expect(report.framesShownToModel).toBe(MAX_VISION_PAIRS_PER_APPLY * VISION_FRAMES_PER_PAIR);
    expect(report.checks.filter((check) => check.status === 'undecided')).toHaveLength(
      MAX_VERIFIED_CUTS_PER_APPLY - MAX_VISION_PAIRS_PER_APPLY,
    );
  });

  it('gates on all three conditions together', () => {
    expect(visionEscalationAllowed(undefined)).toBe(false);
    expect(visionEscalationAllowed(visionControls({ hasBudgetHeadroom: false }))).toBe(false);
    expect(
      visionEscalationAllowed(visionControls({ provider: 'openai', model: 'gpt-3.5-turbo' })),
    ).toBe(false);
    expect(visionEscalationAllowed(visionControls())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

describe('recordPictureVerification', () => {
  it('puts one cited fact per check into the working state', async () => {
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['black_in'] })]),
      patchId: 'p1',
      acquireTemporal: acquirerReturning({ blackRatio: 1 }).acquire,
    });
    const state = recordPictureVerification(
      initialWorkingState({ runId: 'r1', request: 'tighten it' }),
      report,
    );
    expect(state.facts).toHaveLength(1);
    expect(state.facts[0]?.kind).toBe('verification');
    expect(state.facts[0]?.statement).toContain('black frame');
    expect(state.facts[0]?.evidenceIds).toEqual([report.checks[0]?.requestId]);
    expect(state.evidence[0]?.source).toBe('review/temporal-evidence');
  });

  it('records an unverified check honestly rather than dropping it', async () => {
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([cut({ fromClipId: 'c1', toClipId: 'c2', flags: ['exposure_jump'] })]),
      patchId: 'p1',
    });
    const state = recordPictureVerification(
      initialWorkingState({ runId: 'r1', request: 'grade it' }),
      report,
    );
    expect(state.facts[0]?.statement.startsWith('Unverified —')).toBe(true);
  });

  it('renders a bounded PICTURE block', async () => {
    const report = await verifyPictureAfterApply({
      project,
      before: null,
      after: slice([
        flaggedCut(0, ['exposure_jump'], 1),
        flaggedCut(2, ['exposure_jump'], 2),
        flaggedCut(4, ['exposure_jump'], 3),
        flaggedCut(6, ['exposure_jump'], 4),
      ]),
      patchId: 'p1',
      acquireTemporal: acquirerReturning({ difference: 0.01 }).acquire,
    });
    const lines = report.briefingLine.split('\n');
    expect(lines[0]).toBe('PICTURE — what was checked after this edit');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain('1 more check(s)');
  });
});
