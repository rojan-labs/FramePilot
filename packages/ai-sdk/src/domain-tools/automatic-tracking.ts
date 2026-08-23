/**
 * `track_subject_automatically` — measured tracking through the Tracking Lite
 * Capability Pack worker.
 *
 * Like `transcribe`, this is a host-backed mutation split across two trust
 * boundaries: the model supplies only the objective (which subject kind), a
 * trusted host executor measures the media in an isolated pack worker, and the
 * orchestrator turns the validated measurement into the same reversible
 * `track_object` patch the manual path produces. The model never authors
 * coordinates, and a measurement that fails the conversion policy is reported
 * as refused rather than downgraded into a plausible edit.
 */
import { z } from 'zod/v4';
import { compileTrackingCommand } from '@framepilot/editor-core';
import {
  AutomaticTrackingObjectiveSchema,
  SubjectDetectionObjectiveSchema,
  type TrackingRequestPlan,
} from '../controllers/automatic-tracking-controller.js';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { validateProfessionalOperationBatch } from './professional-batch.js';

/** The registry name; also the executor routing key on the desktop host. */
export const AUTOMATIC_TRACKING_TOOL_NAME = 'track_subject_automatically';

/** One worker measurement, exactly as the desktop authority returns it. */
export const TrackedSampleSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    box: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
    confidence: z.number().min(0).max(1),
    occluded: z.boolean(),
  })
  .strict();

/**
 * The full payload a trusted executor hands back for this tool. Everything the
 * op builder needs must be here, because the orchestrator refuses to guess:
 * no plan ⇒ no clip/mask identity, no engine string ⇒ no provenance.
 */
export const AutomaticTrackingMeasurementSchema = z
  .object({
    objective: AutomaticTrackingObjectiveSchema,
    plan: z.object({
      clipId: z.string().min(1),
      maskEffectId: z.string().min(1),
      capability: z.enum([
        'tracking.point',
        'tracking.region',
        'tracking.planar',
        'subject.segment',
      ]),
      fps: z.number().positive(),
      startSeconds: z.number().nonnegative(),
    }),
    samples: z.array(TrackedSampleSchema).min(1),
    /** `${packId}@${version}` of the worker that measured these samples. */
    engine: z.string().min(1).max(256),
    backend: z.string().min(1).max(256),
  })
  .strict();

export type AutomaticTrackingMeasurement = z.infer<typeof AutomaticTrackingMeasurementSchema>;

/** One measured segmentation mask exactly as the worker protocol carries it. */
export interface SegmentationMaskRun {
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  readonly counts: readonly number[];
  readonly confidence: number;
}

/**
 * Convert measured silhouette masks into region-track samples.
 *
 * A segmentation is a bitmap; a timeline mask steers by rectangle bounds, so
 * the honest host-side conversion is each silhouette's own bounding box —
 * deterministic row-major RLE decoding (runs begin with the zero run), no
 * smoothing and no padding, because the conversion policy downstream owns all
 * judgement. A frame with an empty silhouette yields no sample rather than a
 * fabricated box.
 */
export function silhouetteMasksToTrackSamples(
  masks: readonly SegmentationMaskRun[],
): { frame: number; box: z.infer<typeof TrackedSampleSchema>['box']; confidence: number; occluded: boolean }[] {
  const samples: {
    frame: number;
    box: z.infer<typeof TrackedSampleSchema>['box'];
    confidence: number;
    occluded: boolean;
  }[] = [];
  let minX = 0;
  let minY = 0;
  let maxX = -1;
  let maxY = -1;
  let currentFrame = -1;
  let currentConfidence = 0;
  const flush = (): void => {
    if (maxX < minX || maxY < minY) return;
    samples.push({
      frame: currentFrame,
      box: {
        x: minX / maskWidth,
        y: minY / maskHeight,
        width: Math.min((maxX - minX + 1) / maskWidth, 1),
        height: Math.min((maxY - minY + 1) / maskHeight, 1),
      },
      confidence: currentConfidence,
      occluded: false,
    });
  };
  let maskWidth = 1;
  let maskHeight = 1;
  for (const mask of masks) {
    if (mask.frame !== currentFrame) {
      flush();
      minX = 0;
      minY = 0;
      maxX = -1;
      maxY = -1;
    }
    currentFrame = mask.frame;
    currentConfidence = mask.confidence;
    maskWidth = Math.max(mask.width, 1);
    maskHeight = Math.max(mask.height, 1);
    let index = 0;
    let value = 0;
    for (const run of mask.counts) {
      if (value === 1 && run > 0) {
        const startX = index % mask.width;
        const endX = (index + run - 1) % mask.width;
        const startY = Math.floor(index / mask.width);
        const endY = Math.floor((index + run - 1) / mask.width);
        if (maxX < 0) {
          minX = startX;
          maxX = endX;
          minY = startY;
          maxY = endY;
        } else {
          minX = Math.min(minX, startX);
          maxX = Math.max(maxX, endX);
          minY = Math.min(minY, startY);
          maxY = Math.max(maxY, endY);
        }
      }
      index += run;
      value = value === 0 ? 1 : 0;
    }
  }
  flush();
  return samples;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return parameters;
}

/** Which mask property the tracker steers, per subject kind. */
function targetFor(capability: TrackingRequestPlan['capability']): 'object' | 'bounding_box' {
  return capability === 'tracking.point' ? 'object' : 'bounding_box';
}

/**
 * Convert a validated measurement into validated, reversible timeline ops.
 *
 * Runs entirely against the caller's working project: the compiler re-checks
 * the mask still exists with in-frame bounds (`stale_timeline` included) and
 * proves the exact inverse before anything is offered.
 */
export function automaticTrackingOpsFromMeasurement(
  measurement: AutomaticTrackingMeasurement,
  ctx: ToolContext,
): ReturnType<typeof validateProfessionalOperationBatch> {
  const command = {
    type: 'apply_tracked_mask',
    // Must equal `timeline.revision ?? 0` or the compiler refuses as stale —
    // a track compiled against a moved timeline is not the model's to force.
    timelineRevision: ctx.project.timeline.revision ?? 0,
    clipId: measurement.plan.clipId,
    maskEffectId: measurement.plan.maskEffectId,
    target: targetFor(measurement.plan.capability),
    engine: measurement.engine,
    fps: measurement.plan.fps,
    startSeconds: measurement.plan.startSeconds,
    samples: measurement.samples,
  } as const;
  const result = compileTrackingCommand({
    timeline: ctx.project.timeline,
    assets: ctx.project.assets,
    command,
  });
  if (result.status === 'rejected') {
    throw new Error(
      `${AUTOMATIC_TRACKING_TOOL_NAME} compiler rejected ${result.code}: ${result.detail}`,
    );
  }
  return validateProfessionalOperationBatch(ctx, AUTOMATIC_TRACKING_TOOL_NAME, [
    ...result.patch.operations,
  ]);
}

/** Measured by an isolated pack worker; geometry always comes from a drawn mask. */
export const PROFESSIONAL_AUTOMATIC_TRACKING_TOOL: ToolSpec = {
  name: AUTOMATIC_TRACKING_TOOL_NAME,
  description:
    'Track the subject inside the rectangle/ellipse mask on ONE selected video clip using an ' +
    'installed CV pack and apply the measured motion to that mask as a reversible tracked ' +
    'effect. subject="point"|"region"|"plane" use geometric tracking; subject="silhouette" ' +
    'segments the person inside the mask (Subject Intelligence pack) and follows their measured ' +
    'outline bounds per frame. Requires the user to have drawn a rectangle or ellipse mask ' +
    'around the subject first — the mask supplies the region; you never supply coordinates. ' +
    'Fails honestly when no clip is selected, the mask is missing, no pack is installed, or the ' +
    'measured track is too unreliable to apply.',
  version: '1',
  capabilities: ['tracking', 'masking', 'professional-editing'],
  permissions: ['write'],
  cost: 'high',
  latency: 'slow',
  hostUiOnly: true,
  mutates: false,
  available: true,
  kind: 'analysis',
  parameters: jsonSchema(AutomaticTrackingObjectiveSchema),
  parse: (rawArgs) => AutomaticTrackingObjectiveSchema.parse(rawArgs),
};

/** The registry name for whole-frame subject detection; executor routing key. */
export const DETECT_SUBJECTS_TOOL_NAME = 'detect_subjects';

export const SubjectDetectionArgsSchema = SubjectDetectionObjectiveSchema;

/**
 * Measured evidence about what is on screen, from the Subject Intelligence
 * pack (YuNet faces, YOLOX-S people and objects). Read-only: detections are
 * facts for the model to reason over, never geometry an edit can claim.
 */
export const PROFESSIONAL_DETECT_SUBJECTS_TOOL: ToolSpec = {
  name: DETECT_SUBJECTS_TOOL_NAME,
  description:
    'Detect subjects in ONE selected video clip using the installed Subject Intelligence CV ' +
    'pack: faces (every frame), people and objects. Returns frame-indexed, confidence-scored ' +
    'boxes as evidence — counts, positions, timing. Use it before claims like "the presenter ' +
    'is alone" or "no one touches the product". Fails honestly when no clip is selected or the ' +
    'pack is not installed; never guess who or what is on screen.',
  version: '1',
  capabilities: ['vision', 'tracking', 'professional-editing'],
  permissions: ['analysis'],
  cost: 'high',
  latency: 'slow',
  hostUiOnly: true,
  mutates: false,
  available: true,
  kind: 'analysis',
  parameters: jsonSchema(SubjectDetectionObjectiveSchema),
  parse: (rawArgs) => SubjectDetectionObjectiveSchema.parse(rawArgs),
};
