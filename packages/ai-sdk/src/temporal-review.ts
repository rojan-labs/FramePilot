/** Typed temporal evidence protocol and deterministic professional edit reviewer. */
import { z } from 'zod/v4';
import type { EditorCommand, EditorCommandFact } from '@framepilot/editor-core';
import { effectLayersOf } from '@framepilot/timeline-schema';
import type { EditResult } from './assemble.js';
import {
  AUDIO_PEAK_DBFS,
  BLACK_FRAME,
  MAX_AUDIO_BOUNDARY_JUMP_DB,
} from './perceptual-thresholds.js';

export const TEMPORAL_EVIDENCE_VERSION = 1 as const;

const id = z.string().trim().min(1).max(256);
const frame = z.number().int().nonnegative();
const finite = z.number().finite();
const unitInterval = finite.min(0).max(1);
const frameRangeFields = { startFrame: frame, endFrame: frame };

const RequestBaseSchema = z.object({
  schemaVersion: z.literal(TEMPORAL_EVIDENCE_VERSION),
  requestId: id,
  projectRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(512),
});

const FrameEvidenceRequestSchema = RequestBaseSchema.extend({
  kind: z.literal('frame'),
  atFrame: frame,
  metrics: z.array(z.enum(['luma', 'black_ratio', 'perceptual_hash'])).min(1),
  /**
   * What this frame's measurements must SATISFY, as opposed to merely report.
   *
   * A frame request without it gathers numbers and asserts nothing — which is what the
   * representative opening/midpoint/ending probes did. Optional so an existing recorded
   * request stays valid and so a caller that genuinely only wants a measurement can say so.
   */
  checks: z.array(z.enum(['black_frames'])).min(1).optional(),
}).strict();

const RangeEvidenceRequestSchema = RequestBaseSchema.extend({
  kind: z.literal('range'),
  ...frameRangeFields,
  sampleEveryFrames: z.number().int().positive(),
  checks: z.array(z.enum(['black_frames', 'flash_frames'])).min(1),
})
  .strict()
  .refine((value) => value.endFrame > value.startFrame, {
    path: ['endFrame'],
    message: 'Range evidence requires endFrame > startFrame.',
  });

const ComparisonEvidenceRequestSchema = RequestBaseSchema.extend({
  kind: z.literal('comparison'),
  leftFrame: frame,
  rightFrame: frame,
  check: z.enum(['transition_continuity', 'shot_match']),
  maxDifference: unitInterval,
})
  .strict()
  .refine((value) => value.leftFrame !== value.rightFrame, {
    path: ['rightFrame'],
    message: 'Comparison frames must differ.',
  });

const ScopeEvidenceRequestSchema = RequestBaseSchema.extend({
  kind: z.literal('scope'),
  ...frameRangeFields,
  channels: z
    .array(
      z.enum(['luma', 'red', 'green', 'blue', 'saturation', 'skin_red', 'skin_green', 'skin_blue']),
    )
    .min(1),
  legalMin: finite,
  legalMax: finite,
})
  .strict()
  .refine((value) => value.endFrame > value.startFrame && value.legalMax > value.legalMin, {
    message: 'Scope evidence requires increasing frame and legal ranges.',
  });

const MotionEvidenceRequestSchema = RequestBaseSchema.extend({
  kind: z.literal('motion'),
  ...frameRangeFields,
  targetId: id,
  targetKind: z.enum(['clip_transform', 'tracker', 'mask']),
  property: z.string().trim().min(1).max(128),
  maxAccelerationPerFrame: finite.nonnegative().optional(),
  maxJitterPerFrame: finite.nonnegative().optional(),
  requireInsideFrame: z.boolean().default(false),
})
  .strict()
  .refine((value) => value.endFrame > value.startFrame, {
    path: ['endFrame'],
    message: 'Motion evidence requires endFrame > startFrame.',
  });

const AudioEvidenceRequestSchema = RequestBaseSchema.extend({
  kind: z.literal('audio'),
  ...frameRangeFields,
  channels: z.enum(['mix', 'dialogue', 'music', 'sfx']),
  maxPeakDbfs: finite.max(0).default(AUDIO_PEAK_DBFS.review.value),
  maxBoundaryJumpDb: finite.nonnegative().default(MAX_AUDIO_BOUNDARY_JUMP_DB),
  boundaryFrame: frame.optional(),
})
  .strict()
  .refine((value) => value.endFrame > value.startFrame, {
    path: ['endFrame'],
    message: 'Audio evidence requires endFrame > startFrame.',
  })
  .refine(
    (value) =>
      value.boundaryFrame === undefined ||
      (value.boundaryFrame > value.startFrame && value.boundaryFrame < value.endFrame),
    {
      path: ['boundaryFrame'],
      message: 'boundaryFrame must sit strictly inside the window, with frames on both sides.',
    },
  );

const LoudnessEvidenceRequestSchema = RequestBaseSchema.extend({
  kind: z.literal('loudness'),
  ...frameRangeFields,
  channels: z.enum(['mix', 'dialogue', 'music', 'sfx']),
  targetLufs: finite.max(0).default(-14),
  toleranceLu: finite.nonnegative().default(1),
})
  .strict()
  .refine((value) => value.endFrame > value.startFrame, {
    path: ['endFrame'],
    message: 'Loudness evidence requires endFrame > startFrame.',
  });

export const TemporalEvidenceRequestSchema = z.discriminatedUnion('kind', [
  FrameEvidenceRequestSchema,
  RangeEvidenceRequestSchema,
  ComparisonEvidenceRequestSchema,
  ScopeEvidenceRequestSchema,
  MotionEvidenceRequestSchema,
  AudioEvidenceRequestSchema,
  LoudnessEvidenceRequestSchema,
]);
export type TemporalEvidenceRequest = z.infer<typeof TemporalEvidenceRequestSchema>;

export const TemporalRenderSettingsSchema = z
  .object({
    identity: z.string().trim().min(1).max(512),
    presetId: id,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: finite.positive(),
    burnCaptions: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = `${value.presetId}:${value.width}x${value.height}@${value.fps}:captions=${value.burnCaptions}`;
    if (value.identity !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['identity'],
        message: `Render-settings identity must be ${expected}.`,
      });
    }
  });
export type TemporalRenderSettings = z.infer<typeof TemporalRenderSettingsSchema>;

const ResultBaseSchema = z.object({
  schemaVersion: z.literal(TEMPORAL_EVIDENCE_VERSION),
  requestId: id,
  projectRevision: z.number().int().nonnegative(),
});

/** Rendered/video/audio evidence must carry exact composition lineage. */
const RenderedResultBaseSchema = ResultBaseSchema.extend({
  renderSettings: TemporalRenderSettingsSchema,
});

/** Motion is derived from authored keyframes/tracking state and has no rendered lineage. */
const MotionResultBaseSchema = ResultBaseSchema.extend({
  renderSettings: z.null(),
});

const FrameSampleSchema = z
  .object({
    frame,
    luma: unitInterval,
    blackRatio: unitInterval,
    perceptualHash: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

const PointSchema = z.object({ x: finite, y: finite }).strict();
const BoundsSchema = z.object({ x: finite, y: finite, width: finite, height: finite }).strict();

export const TemporalEvidenceResultSchema = z.discriminatedUnion('kind', [
  RenderedResultBaseSchema.extend({ kind: z.literal('frame'), sample: FrameSampleSchema }).strict(),
  RenderedResultBaseSchema.extend({
    kind: z.literal('range'),
    samples: z.array(FrameSampleSchema).min(1),
  }).strict(),
  RenderedResultBaseSchema.extend({
    kind: z.literal('comparison'),
    leftFrame: frame,
    rightFrame: frame,
    difference: unitInterval,
  }).strict(),
  RenderedResultBaseSchema.extend({
    kind: z.literal('scope'),
    samples: z
      .array(
        z
          .object({
            frame,
            channel: z.string().trim().min(1),
            min: finite,
            max: finite,
            mean: finite.optional(),
            p10: finite.optional(),
            p50: finite.optional(),
            p90: finite.optional(),
            nearBlackRatio: unitInterval.optional(),
            nearWhiteRatio: unitInterval.optional(),
            coverageRatio: unitInterval.optional(),
          })
          .strict(),
      )
      .min(1),
  }).strict(),
  MotionResultBaseSchema.extend({
    kind: z.literal('motion'),
    samples: z
      .array(
        z
          .object({
            frame,
            value: finite.optional(),
            point: PointSchema.optional(),
            bounds: BoundsSchema.optional(),
          })
          .strict(),
      )
      .min(2),
  }).strict(),
  RenderedResultBaseSchema.extend({
    kind: z.literal('loudness'),
    sample: z
      .object({
        integratedLufs: finite,
        loudnessRangeLu: finite.optional(),
        truePeakDbfs: finite.optional(),
      })
      .strict(),
  }).strict(),
  RenderedResultBaseSchema.extend({
    kind: z.literal('audio'),
    samples: z
      .array(
        z
          .object({
            startFrame: frame,
            endFrame: frame,
            peakDbfs: finite,
            rmsDbfs: finite,
            boundaryJumpDb: finite.nonnegative().nullable().optional(),
          })
          .strict(),
      )
      .min(1),
  }).strict(),
]);
export type TemporalEvidenceResult = z.infer<typeof TemporalEvidenceResultSchema>;

export const TemporalEvidenceBatchSchema = z
  .object({
    /** Backward-compatible default. Per-result renderSettings is authoritative for lineage. */
    renderSettings: TemporalRenderSettingsSchema,
    results: z.array(TemporalEvidenceResultSchema),
  })
  .strict();
export type TemporalEvidenceBatch = z.infer<typeof TemporalEvidenceBatchSchema>;

export type TemporalReviewStatus = 'pass' | 'fail' | 'skipped';

export interface TemporalReviewCheck {
  readonly requestId: string;
  readonly kind: TemporalEvidenceRequest['kind'];
  readonly status: TemporalReviewStatus;
  readonly issues: readonly string[];
}

export interface TemporalReviewReport {
  readonly ok: boolean;
  readonly projectRevision: number;
  readonly checks: readonly TemporalReviewCheck[];
  readonly evidenceRequestIds: readonly string[];
}

function sortedByFrame<T extends { readonly frame: number }>(samples: readonly T[]): T[] {
  return [...samples].sort((left, right) => left.frame - right.frame);
}

function rangeIssues(
  request: Extract<TemporalEvidenceRequest, { kind: 'range' }>,
  result: Extract<TemporalEvidenceResult, { kind: 'range' }>,
): string[] {
  const issues: string[] = [];
  const samples = sortedByFrame(result.samples);
  if (request.checks.includes('black_frames')) {
    const black = samples.filter(
      (sample) => sample.blackRatio >= BLACK_FRAME.reviewFrameRatio.value,
    );
    if (black.length > 0)
      issues.push(`Unexpected black frame(s): ${black.map((s) => s.frame).join(', ')}.`);
  }
  if (request.checks.includes('flash_frames')) {
    for (let index = 1; index < samples.length - 1; index += 1) {
      const left = samples[index - 1]!;
      const center = samples[index]!;
      const right = samples[index + 1]!;
      if (
        Math.abs(center.luma - left.luma) >= 0.8 &&
        Math.abs(center.luma - right.luma) >= 0.8 &&
        Math.abs(left.luma - right.luma) <= 0.2
      ) {
        issues.push(`Isolated luma flash at frame ${center.frame}.`);
      }
    }
  }
  return issues;
}

function motionIssues(
  request: Extract<TemporalEvidenceRequest, { kind: 'motion' }>,
  result: Extract<TemporalEvidenceResult, { kind: 'motion' }>,
): string[] {
  const issues: string[] = [];
  const samples = sortedByFrame(result.samples);
  if (request.requireInsideFrame) {
    for (const sample of samples) {
      const bounds = sample.bounds;
      if (
        bounds &&
        (bounds.x < 0 ||
          bounds.y < 0 ||
          bounds.width <= 0 ||
          bounds.height <= 0 ||
          bounds.x + bounds.width > 1 ||
          bounds.y + bounds.height > 1)
      ) {
        issues.push(`Target leaves frame bounds at frame ${sample.frame}.`);
      }
    }
  }
  if (request.maxAccelerationPerFrame !== undefined) {
    const numeric = samples.filter(
      (sample): sample is typeof sample & { readonly value: number } => sample.value !== undefined,
    );
    for (let index = 2; index < numeric.length; index += 1) {
      const a = numeric[index - 2]!;
      const b = numeric[index - 1]!;
      const c = numeric[index]!;
      const velocityA = (b.value - a.value) / (b.frame - a.frame);
      const velocityB = (c.value - b.value) / (c.frame - b.frame);
      if (Math.abs(velocityB - velocityA) > request.maxAccelerationPerFrame) {
        issues.push(`Motion acceleration exceeds its limit at frame ${b.frame}.`);
      }
    }
  }
  if (request.maxJitterPerFrame !== undefined) {
    const points = samples.filter(
      (
        sample,
      ): sample is typeof sample & { readonly point: { readonly x: number; readonly y: number } } =>
        sample.point !== undefined,
    );
    for (let index = 2; index < points.length; index += 1) {
      const a = points[index - 2]!;
      const b = points[index - 1]!;
      const c = points[index]!;
      const predictedX = (a.point.x + c.point.x) / 2;
      const predictedY = (a.point.y + c.point.y) / 2;
      const jitter = Math.hypot(b.point.x - predictedX, b.point.y - predictedY);
      if (jitter > request.maxJitterPerFrame) {
        issues.push(`Tracker/mask jitter exceeds its limit at frame ${b.frame}.`);
      }
    }
  }
  return issues;
}

function issuesFor(request: TemporalEvidenceRequest, result: TemporalEvidenceResult): string[] {
  if (request.kind !== result.kind)
    return [`Expected ${request.kind} evidence, received ${result.kind}.`];
  const contractIssues: string[] = [];
  if (request.kind === 'frame' && result.kind === 'frame') {
    if (result.sample.frame !== request.atFrame) {
      contractIssues.push(
        `Frame result ${result.sample.frame} does not match requested frame ${request.atFrame}.`,
      );
    }
    // The probe aimed at "is there a film here" used to be the only probe that asserted
    // nothing. Run 4c9b5f82's programme was black from 10.0s to its end at 36.1s; the
    // midpoint frame (541) and the ending frame (1083) were both sampled, both came back
    // with `blackRatio: 1`, and both were checked only for having the right frame number on
    // them. The one finding the run reported was the two black frames that happened to fall
    // inside a +-2-frame range window around the final cut — which reads as a defect in
    // that cut rather than as twenty-six seconds of nothing.
    if (
      request.checks?.includes('black_frames') &&
      result.sample.blackRatio >= BLACK_FRAME.reviewFrameRatio.value
    ) {
      contractIssues.push(`${request.reason} is black (frame ${request.atFrame}).`);
    }
  }
  if (request.kind === 'range' && result.kind === 'range') {
    const returnedFrames = new Set(result.samples.map((sample) => sample.frame));
    for (
      let expected = request.startFrame;
      expected < request.endFrame;
      expected += request.sampleEveryFrames
    ) {
      if (!returnedFrames.has(expected))
        contractIssues.push(`Range sample ${expected} is missing.`);
    }
    for (const sample of result.samples) {
      if (sample.frame < request.startFrame || sample.frame >= request.endFrame) {
        contractIssues.push(`Range sample ${sample.frame} is outside the requested window.`);
      }
    }
  }
  if (request.kind === 'comparison' && result.kind === 'comparison') {
    if (result.leftFrame !== request.leftFrame || result.rightFrame !== request.rightFrame) {
      contractIssues.push('Comparison result frames do not match the requested pair.');
    }
  }
  if (request.kind === 'scope' && result.kind === 'scope') {
    for (const sample of result.samples) {
      if (sample.frame < request.startFrame || sample.frame >= request.endFrame) {
        contractIssues.push(`Scope sample ${sample.frame} is outside the requested window.`);
      }
      if (!request.channels.includes(sample.channel as (typeof request.channels)[number])) {
        contractIssues.push(`Scope channel "${sample.channel}" was not requested.`);
      }
    }
  }
  if (request.kind === 'motion' && result.kind === 'motion') {
    const frames = new Set<number>();
    for (const sample of result.samples) {
      if (sample.frame < request.startFrame || sample.frame >= request.endFrame) {
        contractIssues.push(`Motion sample ${sample.frame} is outside the requested window.`);
      }
      if (frames.has(sample.frame))
        contractIssues.push(`Motion frame ${sample.frame} is duplicated.`);
      frames.add(sample.frame);
    }
    if (
      request.maxAccelerationPerFrame !== undefined &&
      result.samples.some((sample) => sample.value === undefined)
    ) {
      contractIssues.push('Motion acceleration evidence is missing numeric values.');
    }
    if (
      request.maxJitterPerFrame !== undefined &&
      result.samples.some((sample) => sample.point === undefined)
    ) {
      contractIssues.push('Motion jitter evidence is missing tracked points.');
    }
    if (
      request.requireInsideFrame &&
      result.samples.some((sample) => sample.bounds === undefined)
    ) {
      contractIssues.push('Motion bounds evidence is missing normalized bounds.');
    }
  }
  if (request.kind === 'audio' && result.kind === 'audio') {
    const samples = [...result.samples].sort(
      (left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame,
    );
    for (const sample of samples) {
      if (
        sample.endFrame <= sample.startFrame ||
        sample.startFrame < request.startFrame ||
        sample.endFrame > request.endFrame
      ) {
        contractIssues.push(
          `Audio segment ${sample.startFrame}–${sample.endFrame} is outside the requested window.`,
        );
      }
    }
    if (
      samples[0]?.startFrame !== request.startFrame ||
      samples.at(-1)?.endFrame !== request.endFrame
    ) {
      contractIssues.push('Audio evidence does not cover the complete requested window.');
    }
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index - 1]!.endFrame !== samples[index]!.startFrame) {
        contractIssues.push('Audio evidence contains a gap or overlap between segments.');
      }
    }
  }
  if (contractIssues.length > 0) return contractIssues;
  if (request.kind === 'range' && result.kind === 'range') return rangeIssues(request, result);
  if (request.kind === 'comparison' && result.kind === 'comparison') {
    return result.difference > request.maxDifference
      ? [`Frame difference ${result.difference} exceeds ${request.maxDifference}.`]
      : [];
  }
  if (request.kind === 'scope' && result.kind === 'scope') {
    return result.samples
      .filter((sample) => sample.min < request.legalMin || sample.max > request.legalMax)
      .map((sample) => `${sample.channel} exceeds legal scope at frame ${sample.frame}.`);
  }
  if (request.kind === 'motion' && result.kind === 'motion') return motionIssues(request, result);
  if (request.kind === 'audio' && result.kind === 'audio') {
    const issues: string[] = [];
    for (const sample of result.samples) {
      if (sample.peakDbfs > request.maxPeakDbfs) {
        issues.push(`Audio peak ${sample.peakDbfs} dBFS exceeds ${request.maxPeakDbfs} dBFS.`);
      }
      if (
        request.boundaryFrame !== undefined &&
        sample.boundaryJumpDb !== undefined &&
        sample.boundaryJumpDb !== null &&
        sample.boundaryJumpDb > request.maxBoundaryJumpDb
      ) {
        issues.push(
          `Audio discontinuity ${sample.boundaryJumpDb} dB exceeds ${request.maxBoundaryJumpDb} dB.`,
        );
      }
    }
    return issues;
  }
  if (request.kind === 'loudness' && result.kind === 'loudness') {
    const deviation = result.sample.integratedLufs - request.targetLufs;
    return Math.abs(deviation) > request.toleranceLu
      ? [
          `${request.channels} loudness ${result.sample.integratedLufs} LUFS misses the ` +
            `${request.targetLufs} LUFS target by ${deviation.toFixed(1)} LU ` +
            `(tolerance ${request.toleranceLu} LU).`,
        ]
      : [];
  }
  return [];
}

/** Validate lineage and judge only deterministic metrics requested by the caller. */
export function reviewTemporalEvidence(
  rawRequests: readonly unknown[],
  rawResults: readonly unknown[],
): TemporalReviewReport {
  const requests = rawRequests.map((request) => TemporalEvidenceRequestSchema.parse(request));
  const results = rawResults.map((result) => TemporalEvidenceResultSchema.parse(result));
  const revisions = new Set(requests.map((request) => request.projectRevision));
  if (revisions.size !== 1)
    throw new Error('Temporal review requests must target one project revision.');
  const projectRevision = requests[0]?.projectRevision;
  if (projectRevision === undefined)
    throw new Error('Temporal review requires at least one request.');
  const resultById = new Map<string, TemporalEvidenceResult>();
  const requestIds = new Set<string>();
  for (const request of requests) {
    if (requestIds.has(request.requestId))
      throw new Error(`Duplicate temporal request "${request.requestId}".`);
    requestIds.add(request.requestId);
  }
  for (const result of results) {
    if (!requestIds.has(result.requestId))
      throw new Error(`Unexpected temporal result "${result.requestId}".`);
    if (resultById.has(result.requestId))
      throw new Error(`Duplicate temporal result "${result.requestId}".`);
    resultById.set(result.requestId, result);
  }
  const checks = requests.map((request): TemporalReviewCheck => {
    const result = resultById.get(request.requestId);
    if (!result)
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: 'skipped',
        issues: ['Evidence was not returned.'],
      };
    if (result.projectRevision !== request.projectRevision) {
      return {
        requestId: request.requestId,
        kind: request.kind,
        status: 'fail',
        issues: [
          `Evidence revision ${result.projectRevision} does not match requested revision ${request.projectRevision}.`,
        ],
      };
    }
    const issues = issuesFor(request, result);
    return {
      requestId: request.requestId,
      kind: request.kind,
      status: issues.length === 0 ? 'pass' : 'fail',
      issues,
    };
  });
  return {
    ok: checks.every((check) => check.status === 'pass'),
    projectRevision,
    checks: diagnoseWholeProgrammeBlack(requests, checks),
    evidenceRequestIds: requests.map((request) => request.requestId),
  };
}

/** The sentence every black range gets when the whole programme is black. */
const NO_PICTURE_DETAIL =
  'Every sampled moment of this programme is black. That is not a defect in the cuts — it ' +
  'is what a timeline with no picture under its overlays looks like. Put footage, a still ' +
  'or a stock clip on a video track.';

/**
 * Replace fifteen restatements of one fact with one fact.
 *
 * When a timeline carries only text overlays, EVERY sampled frame is black, so every
 * black-frame check fails and the run reports "Unexpected black frame(s): 0, 1, 2." once
 * per edit boundary. Run e30c1fe9 ended on fifteen such lines, which read as fifteen
 * broken cuts and sent the model looking for transitions to fix. The per-range reading is
 * right and the conclusion drawn from it is wrong: the defect is not at the boundaries,
 * it is that there is no film.
 *
 * Only fires when EVERY black-frame range failed. One black range among clean ones is a
 * real flash at a real cut and keeps its own precise frame numbers.
 */
function diagnoseWholeProgrammeBlack(
  requests: readonly TemporalEvidenceRequest[],
  checks: readonly TemporalReviewCheck[],
): TemporalReviewCheck[] {
  const blackRequested = new Set(
    requests
      .filter((request) => request.kind === 'range' && request.checks.includes('black_frames'))
      .map((request) => request.requestId),
  );
  if (blackRequested.size < 2) return [...checks];
  const judged = checks.filter((check) => blackRequested.has(check.requestId));
  const everyRangeBlack =
    judged.length === blackRequested.size &&
    judged.every((check) => check.issues.some((issue) => issue.startsWith('Unexpected black')));
  if (!everyRangeBlack) return [...checks];
  return checks.map((check) =>
    blackRequested.has(check.requestId)
      ? {
          ...check,
          issues: [
            NO_PICTURE_DETAIL,
            ...check.issues.filter((issue) => !issue.startsWith('Unexpected black')),
          ],
        }
      : check,
  );
}

export interface TemporalReviewPlanInput {
  readonly projectRevision: number;
  readonly command: EditorCommand;
  readonly facts: readonly EditorCommandFact[];
  readonly sequenceFps: number;
  readonly durationFrames: number;
}

export interface TemporalEditReviewPlanInput {
  readonly projectRevision: number;
  readonly edit: EditResult;
  readonly sequenceFps: number;
  readonly durationFrames: number;
  readonly maxRequests?: number;
}

const CRITICAL_TIME_FACTS = new Set([
  'newCutSeconds',
  'newStartSeconds',
  'newEndSeconds',
  'sequenceStartSeconds',
  'pictureCutSeconds',
  'soundCutSeconds',
  'switchSequenceSeconds',
]);

function representativeFrameRequests(
  projectRevision: number,
  durationFrames: number,
): TemporalEvidenceRequest[] {
  const lastFrame = durationFrames - 1;
  const representative = [...new Set([0, Math.floor(lastFrame / 2), lastFrame])];
  return representative.map((atFrame, index) => ({
    schemaVersion: TEMPORAL_EVIDENCE_VERSION,
    requestId: `representative_${index}_${atFrame}`,
    projectRevision,
    kind: 'frame',
    atFrame,
    metrics: ['luma', 'black_ratio', 'perceptual_hash'],
    // These three frames are the run's answer to "is there a film here at all", so they
    // assert on the black ratio they already measure rather than reporting it and stopping.
    checks: ['black_frames'],
    reason:
      index === 0
        ? 'Program opening'
        : index === representative.length - 1
          ? 'Program ending'
          : 'Program midpoint',
  }));
}

function assertPlanBounds(sequenceFps: number, durationFrames: number): void {
  if (!Number.isFinite(sequenceFps) || sequenceFps <= 0) {
    throw new Error('sequenceFps must be positive.');
  }
  if (!Number.isInteger(durationFrames) || durationFrames < 1) {
    throw new Error('durationFrames must be positive.');
  }
}

function boundedMotionWindows(startFrame: number, endFrame: number): readonly [number, number][] {
  const boundedEnd = Math.max(startFrame + 1, endFrame);
  if (boundedEnd - startFrame <= 300) return [[startFrame, boundedEnd]];
  const width = 100;
  const middle = Math.max(startFrame, Math.floor((startFrame + boundedEnd - width) / 2));
  return [
    [startFrame, startFrame + width],
    [middle, middle + width],
    [boundedEnd - width, boundedEnd],
  ];
}

/** Plan review directly from the validated before/after edit, independent of route/model prose. */
export function planTemporalEvidenceForEdit(
  input: TemporalEditReviewPlanInput,
): TemporalEvidenceRequest[] {
  assertPlanBounds(input.sequenceFps, input.durationFrames);
  const diff = input.edit.diff;
  if (!diff) return [];
  const maxRequests = Math.max(1, Math.min(64, input.maxRequests ?? 48));
  const beforeTracks = new Map(diff.before.tracks.map((track) => [track.id, track]));
  const afterTracks = new Map(diff.after.tracks.map((track) => [track.id, track]));
  const trackIds = [...new Set([...beforeTracks.keys(), ...afterTracks.keys()])].sort();
  const visualFrames = new Set<number>();
  const audioFrames = new Map<number, number | undefined>();
  const addAudioFrame = (rawFrame: number, splice = false): void => {
    const centre = Math.max(0, Math.min(input.durationFrames - 1, rawFrame));
    const boundary =
      splice && rawFrame > 0 && rawFrame < input.durationFrames ? rawFrame : undefined;
    audioFrames.set(centre, audioFrames.get(centre) ?? boundary);
  };
  const motionRequests: TemporalEvidenceRequest[] = [];
  let visualChanged = false;
  for (const trackId of trackIds) {
    const before = beforeTracks.get(trackId);
    const after = afterTracks.get(trackId);
    const trackType = after?.type ?? before?.type;
    if (
      JSON.stringify({ hidden: before?.hidden, muted: before?.muted }) !==
      JSON.stringify({ hidden: after?.hidden, muted: after?.muted })
    ) {
      if (trackType === 'audio') {
        addAudioFrame(0);
        addAudioFrame(input.durationFrames - 1);
      } else {
        visualFrames.add(0);
        visualFrames.add(input.durationFrames - 1);
        visualChanged = true;
      }
    }
    const beforeClips = new Map((before?.clips ?? []).map((clip) => [clip.id, clip]));
    const afterClips = new Map((after?.clips ?? []).map((clip) => [clip.id, clip]));
    const clipIds = [...new Set([...beforeClips.keys(), ...afterClips.keys()])].sort();
    for (const clipId of clipIds) {
      const left = beforeClips.get(clipId);
      const right = afterClips.get(clipId);
      if (JSON.stringify(left) === JSON.stringify(right)) continue;
      const beforeAudio = left?.effects.find((effect) => effect.type === 'audio_gain');
      const afterAudio = right?.effects.find((effect) => effect.type === 'audio_gain');
      const audioMixChanged = JSON.stringify(beforeAudio) !== JSON.stringify(afterAudio);
      const edgeFrames = [left?.start, left?.end, right?.start, right?.end]
        .filter((value): value is number => value !== undefined)
        .map((value) => Math.round(value * input.sequenceFps));
      const frames = edgeFrames.map((value) =>
        Math.max(0, Math.min(input.durationFrames - 1, value)),
      );
      if (audioMixChanged) {
        const clip = right ?? left;
        if (clip) {
          const startFrame = Math.max(
            0,
            Math.min(input.durationFrames - 1, Math.floor(clip.start * input.sequenceFps)),
          );
          const endFrame = Math.max(
            startFrame,
            Math.min(input.durationFrames - 1, Math.ceil(clip.end * input.sequenceFps) - 1),
          );
          addAudioFrame(startFrame);
          addAudioFrame(Math.floor((startFrame + endFrame) / 2));
          addAudioFrame(endFrame);
          const lane = (afterAudio?.keyframes ?? []).filter(
            (keyframe) => keyframe.property === 'gainDb',
          );
          if (lane.length > 0) {
            const quietest = lane.reduce((low, k) => (k.value < low.value ? k : low), lane[0]!);
            const loudest = lane.reduce((high, k) => (k.value > high.value ? k : high), lane[0]!);
            for (const keyframe of [quietest, loudest]) {
              addAudioFrame(
                Math.max(
                  startFrame,
                  Math.min(endFrame, Math.round((clip.start + keyframe.time) * input.sequenceFps)),
                ),
              );
            }
          }
        }
      }
      if (trackType === 'audio') {
        edgeFrames.forEach((edgeFrame) => addAudioFrame(edgeFrame, true));
      } else {
        visualChanged = true;
        frames.forEach((criticalFrame) => visualFrames.add(criticalFrame));
        if (right) {
          const beforeEffects = new Map((left?.effects ?? []).map((effect) => [effect.id, effect]));
          for (const effect of right.effects) {
            const targetKind =
              effect.type === 'object_track'
                ? 'tracker'
                : effect.type === 'mask'
                  ? 'mask'
                  : undefined;
            if (
              !targetKind ||
              JSON.stringify(beforeEffects.get(effect.id)) === JSON.stringify(effect)
            ) {
              continue;
            }
            const clipStart = Math.max(
              0,
              Math.min(input.durationFrames - 1, Math.floor(right.start * input.sequenceFps)),
            );
            const clipEnd = Math.max(
              clipStart + 1,
              Math.min(input.durationFrames, Math.ceil(right.end * input.sequenceFps)),
            );
            boundedMotionWindows(clipStart, clipEnd).forEach(([startFrame, endFrame], index) => {
              motionRequests.push({
                schemaVersion: TEMPORAL_EVIDENCE_VERSION,
                requestId: `edit_${targetKind}_${effect.id}_${index}`,
                projectRevision: input.projectRevision,
                kind: 'motion',
                startFrame,
                endFrame,
                targetId: effect.id,
                targetKind,
                property: 'x',
                maxAccelerationPerFrame: 0.08,
                maxJitterPerFrame: 0.08,
                requireInsideFrame: true,
                reason: `Changed ${targetKind} motion`,
              });
            });
          }
        }
      }
    }
    const beforeLayers = new Map(
      (before ? effectLayersOf(before) : []).map((layer) => [layer.id, layer]),
    );
    const afterLayers = new Map(
      (after ? effectLayersOf(after) : []).map((layer) => [layer.id, layer]),
    );
    for (const layerId of [...new Set([...beforeLayers.keys(), ...afterLayers.keys()])].sort()) {
      const left = beforeLayers.get(layerId);
      const right = afterLayers.get(layerId);
      if (JSON.stringify(left) === JSON.stringify(right)) continue;
      visualChanged = true;
      [left?.start, left?.end, right?.start, right?.end]
        .filter((value): value is number => value !== undefined)
        .map((value) =>
          Math.max(0, Math.min(input.durationFrames - 1, Math.round(value * input.sequenceFps))),
        )
        .forEach((criticalFrame) => visualFrames.add(criticalFrame));
    }
  }
  const representativeRequests = visualChanged
    ? representativeFrameRequests(input.projectRevision, input.durationFrames)
    : [];
  const visualRequests: TemporalEvidenceRequest[] = [];
  for (const criticalFrame of [...visualFrames].sort((left, right) => left - right)) {
    const startFrame = Math.max(0, criticalFrame - 2);
    const endFrame = Math.min(input.durationFrames, criticalFrame + 3);
    if (endFrame <= startFrame) continue;
    visualRequests.push({
      schemaVersion: TEMPORAL_EVIDENCE_VERSION,
      requestId: `edit_range_${criticalFrame}`,
      projectRevision: input.projectRevision,
      kind: 'range',
      startFrame,
      endFrame,
      sampleEveryFrames: 1,
      checks: ['black_frames', 'flash_frames'],
      reason: 'Changed visual edit boundary',
    });
  }
  const audioRequests: TemporalEvidenceRequest[] = [];
  for (const [criticalFrame, splice] of [...audioFrames].sort(([left], [right]) => left - right)) {
    const startFrame = Math.max(0, criticalFrame - 2);
    const endFrame = Math.min(input.durationFrames, criticalFrame + 3);
    if (endFrame <= startFrame) continue;
    const boundaryFrame =
      splice !== undefined && splice > startFrame && splice < endFrame ? splice : undefined;
    audioRequests.push({
      schemaVersion: TEMPORAL_EVIDENCE_VERSION,
      requestId: `edit_audio_${criticalFrame}`,
      projectRevision: input.projectRevision,
      kind: 'audio',
      startFrame,
      endFrame,
      channels: 'mix',
      maxPeakDbfs: AUDIO_PEAK_DBFS.review.value,
      maxBoundaryJumpDb: MAX_AUDIO_BOUNDARY_JUMP_DB,
      ...(boundaryFrame === undefined ? {} : { boundaryFrame }),
      reason: boundaryFrame === undefined ? 'Changed audio level' : 'Changed audio edit boundary',
    });
  }
  const requests = representativeRequests.slice(0, maxRequests);
  let visualIndex = 0;
  let audioIndex = 0;
  let motionIndex = 0;
  while (
    requests.length < maxRequests &&
    (motionIndex < motionRequests.length ||
      visualIndex < visualRequests.length ||
      audioIndex < audioRequests.length)
  ) {
    const motion = motionRequests[motionIndex];
    if (motion && requests.length < maxRequests) {
      requests.push(motion);
      motionIndex += 1;
    }
    const visual = visualRequests[visualIndex];
    if (visual && requests.length < maxRequests) {
      requests.push(visual);
      visualIndex += 1;
    }
    const audio = audioRequests[audioIndex];
    if (audio && requests.length < maxRequests) {
      requests.push(audio);
      audioIndex += 1;
    }
  }
  return requests;
}

/** Choose bounded representative frames and command-fact windows, never arbitrary timestamps. */
export function planTemporalEvidence(input: TemporalReviewPlanInput): TemporalEvidenceRequest[] {
  assertPlanBounds(input.sequenceFps, input.durationFrames);
  const lastFrame = input.durationFrames - 1;
  const requests = representativeFrameRequests(input.projectRevision, input.durationFrames);
  const criticalFrames = [
    ...new Set(
      input.facts
        .filter((fact) => CRITICAL_TIME_FACTS.has(fact.name) && typeof fact.value === 'number')
        .map((fact) =>
          Math.max(0, Math.min(lastFrame, Math.round((fact.value as number) * input.sequenceFps))),
        ),
    ),
  ];
  for (const criticalFrame of criticalFrames) {
    const startFrame = Math.max(0, criticalFrame - 2);
    const endFrame = Math.min(input.durationFrames, criticalFrame + 3);
    if (endFrame <= startFrame) continue;
    requests.push({
      schemaVersion: TEMPORAL_EVIDENCE_VERSION,
      requestId: `critical_range_${criticalFrame}`,
      projectRevision: input.projectRevision,
      kind: 'range',
      startFrame,
      endFrame,
      sampleEveryFrames: 1,
      checks: ['black_frames', 'flash_frames'],
      reason: `Critical temporal window produced by ${input.command.type}`,
    });
  }
  if (input.command.type === 'j_cut_edit' || input.command.type === 'l_cut_edit') {
    const soundCut = input.facts.find((fact) => fact.name === 'soundCutSeconds');
    if (typeof soundCut?.value === 'number') {
      const rawCut = Math.round(soundCut.value * input.sequenceFps);
      const center = Math.max(0, Math.min(lastFrame, rawCut));
      const startFrame = Math.max(0, center - 2);
      const endFrame = Math.min(input.durationFrames, center + 3);
      const boundaryFrame = rawCut > startFrame && rawCut < endFrame ? rawCut : undefined;
      requests.push({
        schemaVersion: TEMPORAL_EVIDENCE_VERSION,
        requestId: `audio_cut_${center}`,
        projectRevision: input.projectRevision,
        kind: 'audio',
        startFrame,
        endFrame,
        channels: 'mix',
        maxPeakDbfs: AUDIO_PEAK_DBFS.review.value,
        maxBoundaryJumpDb: MAX_AUDIO_BOUNDARY_JUMP_DB,
        ...(boundaryFrame === undefined ? {} : { boundaryFrame }),
        reason: `Audio continuity across ${input.command.type}`,
      });
    }
  }
  return requests;
}
