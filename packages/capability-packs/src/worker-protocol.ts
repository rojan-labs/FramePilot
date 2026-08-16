/** Versioned JSON-line protocol for isolated, on-demand media intelligence workers. */
import { z } from 'zod/v4';
import {
  CAPABILITY_PACK_WORKER_PROTOCOL_VERSION,
  CapabilityPackWorkerHandshakeSchema,
} from './contracts.js';

export const CAPABILITY_PACK_WORKER_MAX_LINE_BYTES = 1024 * 1024;
export const CAPABILITY_PACK_WORKER_MAX_SAMPLES = 18_000;

const RequestIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const UnitCoordinateSchema = z.number().finite().min(0).max(1);
const NormalizedBoxSchema = z
  .object({
    x: UnitCoordinateSchema,
    y: UnitCoordinateSchema,
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .refine((box) => box.x + box.width <= 1 && box.y + box.height <= 1, {
    message: 'normalized box must stay inside the frame',
  });
const NormalizedPointSchema = z
  .object({ x: UnitCoordinateSchema, y: UnitCoordinateSchema })
  .strict();

/** Host-resolved, sandbox-checked read-only media. Workers never resolve project paths. */
export const CapabilityPackMediaHandleSchema = z
  .object({
    handleId: RequestIdSchema,
    assetId: z.string().min(1).max(256),
    absolutePath: z.string().min(1).max(4096),
    sourceStartSeconds: z.number().finite().nonnegative(),
    sourceEndSeconds: z.number().finite().positive(),
    fps: z.number().finite().positive().max(240),
    firstFrame: z.number().int().nonnegative(),
    lastFrameExclusive: z.number().int().positive(),
  })
  .strict()
  .refine((media) => media.sourceEndSeconds > media.sourceStartSeconds, {
    message: 'media source range must be positive',
  })
  .refine((media) => media.lastFrameExclusive > media.firstFrame, {
    message: 'media frame range must be positive',
  });

const RequestBaseSchema = z.object({
  type: z.literal('request'),
  protocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
  requestId: RequestIdSchema,
  projectRevision: z.number().int().nonnegative(),
  media: CapabilityPackMediaHandleSchema,
});

export const CapabilityPackWorkerRequestSchema = z.discriminatedUnion('capability', [
  RequestBaseSchema.extend({
    capability: z.literal('tracking.point'),
    parameters: z.object({ point: NormalizedPointSchema }).strict(),
  }).strict(),
  RequestBaseSchema.extend({
    capability: z.literal('tracking.region'),
    parameters: z.object({ region: NormalizedBoxSchema }).strict(),
  }).strict(),
  RequestBaseSchema.extend({
    capability: z.literal('tracking.planar'),
    parameters: z
      .object({ corners: z.tuple([NormalizedPointSchema, NormalizedPointSchema, NormalizedPointSchema, NormalizedPointSchema]) })
      .strict(),
  }).strict(),
  RequestBaseSchema.extend({
    capability: z.literal('subject.detect'),
    parameters: z
      .object({
        labels: z.array(z.enum(['face', 'person', 'object'])).min(1).max(3),
        maxDetections: z.number().int().positive().max(100).default(20),
      })
      .strict(),
  }).strict(),
  RequestBaseSchema.extend({
    capability: z.literal('subject.segment'),
    parameters: z
      .object({
        region: NormalizedBoxSchema.optional(),
        point: NormalizedPointSchema.optional(),
      })
      .strict()
      .refine((value) => (value.region === undefined) !== (value.point === undefined), {
        message: 'segmentation requires exactly one region or point prompt',
      }),
  }).strict(),
]);

export const CapabilityPackWorkerCancelSchema = z
  .object({
    type: z.literal('cancel'),
    protocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
    requestId: RequestIdSchema,
  })
  .strict();

export const CapabilityPackWorkerProgressSchema = z
  .object({
    type: z.literal('progress'),
    protocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
    requestId: RequestIdSchema,
    phase: z.enum(['decode', 'initialize', 'track', 'detect', 'segment', 'encode']),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    detail: z.string().max(512).optional(),
  })
  .strict()
  .refine((value) => value.completed <= value.total, {
    message: 'worker progress cannot exceed its total',
  });

const TrackingSampleSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    box: NormalizedBoxSchema,
    confidence: z.number().finite().min(0).max(1),
    occluded: z.boolean(),
  })
  .strict();
const DetectionSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    label: z.enum(['face', 'person', 'object']),
    box: NormalizedBoxSchema,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();
const MaskSampleSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    /** COCO-style row-major binary-mask run lengths, beginning with the zero run. */
    counts: z.array(z.number().int().nonnegative()).min(1).max(2_000_000),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

const ResultBaseSchema = z.object({
  type: z.literal('result'),
  protocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
  requestId: RequestIdSchema,
  projectRevision: z.number().int().nonnegative(),
  backend: z.string().min(1).max(128),
  modelDigests: z.record(z.string().min(1).max(160), z.string().regex(/^[0-9a-f]{64}$/)),
});

export const CapabilityPackWorkerResultSchema = z.discriminatedUnion('capability', [
  ResultBaseSchema.extend({
    capability: z.enum(['tracking.point', 'tracking.region', 'tracking.planar']),
    samples: z.array(TrackingSampleSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_SAMPLES),
  }).strict(),
  ResultBaseSchema.extend({
    capability: z.literal('subject.detect'),
    detections: z.array(DetectionSchema).max(CAPABILITY_PACK_WORKER_MAX_SAMPLES),
  }).strict(),
  ResultBaseSchema.extend({
    capability: z.literal('subject.segment'),
    masks: z.array(MaskSampleSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_SAMPLES),
  }).strict(),
]);

export const CapabilityPackWorkerFailureSchema = z
  .object({
    type: z.literal('failure'),
    protocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
    requestId: RequestIdSchema,
    code: z.enum([
      'cancelled',
      'media_unreadable',
      'target_lost',
      'model_unavailable',
      'hardware_unsupported',
      'invalid_request',
      'internal_error',
    ]),
    detail: z.string().min(1).max(2_000),
    retryable: z.boolean(),
  })
  .strict();

export const CapabilityPackWorkerInputSchema = z.union([
  CapabilityPackWorkerRequestSchema,
  CapabilityPackWorkerCancelSchema,
]);
export const CapabilityPackWorkerOutputSchema = z.union([
  CapabilityPackWorkerHandshakeSchema,
  CapabilityPackWorkerProgressSchema,
  CapabilityPackWorkerResultSchema,
  CapabilityPackWorkerFailureSchema,
]);

export type CapabilityPackWorkerRequest = z.infer<typeof CapabilityPackWorkerRequestSchema>;
export type CapabilityPackWorkerCancel = z.infer<typeof CapabilityPackWorkerCancelSchema>;
export type CapabilityPackWorkerProgress = z.infer<typeof CapabilityPackWorkerProgressSchema>;
export type CapabilityPackWorkerResult = z.infer<typeof CapabilityPackWorkerResultSchema>;
export type CapabilityPackWorkerFailure = z.infer<typeof CapabilityPackWorkerFailureSchema>;
