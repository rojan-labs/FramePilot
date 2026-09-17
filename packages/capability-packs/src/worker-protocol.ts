/** Versioned JSON-line protocol for isolated, on-demand media intelligence workers. */
import { z } from 'zod/v4';
import {
  CAPABILITY_PACK_WORKER_PROTOCOL_VERSION,
  CapabilityPackWorkerHandshakeSchema,
} from './contracts.js';

export const CAPABILITY_PACK_WORKER_MAX_LINE_BYTES = 1024 * 1024;
export const CAPABILITY_PACK_WORKER_MAX_SAMPLES = 18_000;
/** Shots one `visual.embed` request may carry. Bounded so a batch stays inside the line cap. */
export const CAPABILITY_PACK_WORKER_MAX_SHOTS = 64;
/** Texts one `visual.text` request may carry (prompt-bank warm-up is the largest caller). */
export const CAPABILITY_PACK_WORKER_MAX_TEXTS = 64;
/**
 * Shots one `visual.describe` request may carry. Far smaller than the embed bound on
 * purpose: a VLM call is seconds, not milliseconds, and one result line carries nine text
 * fields per shot. Tier 2 is the slow tier by design, and the bound says so in the
 * contract rather than in a comment upstream of it.
 */
export const CAPABILITY_PACK_WORKER_MAX_DESCRIBE_SHOTS = 16;

const RequestIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
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

// ---------------------------------------------------------------------------
// subject.matte / subject.segment_frame (background removal, plan 03, MD-3)
// ---------------------------------------------------------------------------

/** Prompts one `subject.matte` request may carry (clicks, boxes, brush fixes, locked frames). */
export const CAPABILITY_PACK_MATTE_MAX_PROMPTS = 512;
/** Points one `points` prompt may carry. */
export const CAPABILITY_PACK_MATTE_MAX_POINTS = 64;
/** Flagged ranges one matte result may report. */
export const CAPABILITY_PACK_MATTE_MAX_REVIEW_RANGES = 4096;
/** Largest artifact side a matte may be written at (display space, 8K). */
export const CAPABILITY_PACK_MATTE_MAX_SIDE = 8192;
/**
 * Largest byte ceiling a host may grant one matte job. The host computes the real ceiling
 * per request (frames x pixels x an FFV1 bound, x2 for foreground); this only bounds the wire.
 */
export const CAPABILITY_PACK_MATTE_MAX_OUTPUT_BYTES = 256 * 1024 * 1024 * 1024;
/** Base64 characters of one `subject.segment_frame` preview mask; keeps the line under 1 MiB. */
export const CAPABILITY_PACK_SEGMENT_FRAME_MAX_PNG_CHARS = 900_000;

/** The only files a matte job may create in its staging directory. Mirrors the v22 schema. */
export const MatteArtifactFileNameSchema = z.enum([
  'matte.mkv',
  'foreground.mkv',
  'preview.webm',
  'foreground.preview.webm',
  'frames.json',
  'report.json',
]);
/** Files every matte artifact must hold; the others are optional. */
export const MATTE_REQUIRED_FILES = ['matte.mkv', 'frames.json'] as const;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** Source-stream ticks. Integers, and may be negative (edit-list pre-roll). */
const PtsSchema = z.number().int().min(-(2 ** 52)).max(2 ** 52);
const AbsoluteDirectorySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value), {
    message: 'handle directory must be absolute',
  })
  .refine((value) => !value.split(/[\\/]/u).includes('..'), {
    message: 'handle directory must not contain traversal segments',
  });

/** `corrections/<pts>.png` (brush) or `locked/<pts>.png` (lock), relative to the inputs handle. */
export const MatteInputFileSchema = z
  .string()
  .max(64)
  .regex(/^(corrections|locked)\/-?(0|[1-9]\d{0,15})\.png$/u, {
    message: 'matte input files are corrections/<pts>.png or locked/<pts>.png',
  });
/**
 * The previous artifact's files, cloned read-only into the inputs handle for a partial re-run.
 * The worker never gets a path into the committed store itself.
 */
export const MattePreviousInputFileSchema = z.enum([
  'previous/matte.mkv',
  'previous/foreground.mkv',
  'previous/frames.json',
]);
const MatteHandleInputFileSchema = z.union([MatteInputFileSchema, MattePreviousInputFileSchema]);

/**
 * Host-issued write handle: one empty staging directory the host created for this request
 * (MD-3). The worker never picks the path; it may create only `allowedFiles` inside it and
 * never more than `maxBytes` in total. The host re-verifies all of that independently.
 */
export const MatteOutputHandleSchema = z
  .object({
    handleId: RequestIdSchema,
    absolutePath: AbsoluteDirectorySchema,
    allowedFiles: z.array(MatteArtifactFileNameSchema).min(2).max(6),
    maxBytes: z.number().int().positive().max(CAPABILITY_PACK_MATTE_MAX_OUTPUT_BYTES),
  })
  .strict()
  .refine((handle) => new Set(handle.allowedFiles).size === handle.allowedFiles.length, {
    message: 'output handle files must be distinct',
  })
  .refine((handle) => MATTE_REQUIRED_FILES.every((name) => handle.allowedFiles.includes(name)), {
    message: 'output handle must allow matte.mkv and frames.json',
  });

/** Host-written, read-only correction masks and locked alpha for this request. */
export const MatteInputHandleSchema = z
  .object({
    handleId: RequestIdSchema,
    absolutePath: AbsoluteDirectorySchema,
    files: z.array(MatteHandleInputFileSchema).min(1).max(CAPABILITY_PACK_MATTE_MAX_PROMPTS + 3),
  })
  .strict()
  .refine((handle) => new Set(handle.files).size === handle.files.length, {
    message: 'input handle files must be distinct',
  });

const MattePointSchema = z
  .object({
    x: UnitCoordinateSchema,
    y: UnitCoordinateSchema,
    label: z.enum(['include', 'exclude']),
  })
  .strict();

/**
 * What the worker is asked to follow. A grounding `candidateId` never reaches the worker:
 * the host resolves it to boxes first, so a worker only ever sees geometry and files.
 */
export const MattePromptSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('points'),
      pts: PtsSchema,
      points: z.array(MattePointSchema).min(1).max(CAPABILITY_PACK_MATTE_MAX_POINTS),
    })
    .strict(),
  z.object({ kind: z.literal('box'), pts: PtsSchema, box: NormalizedBoxSchema }).strict(),
  z.object({ kind: z.literal('brush'), pts: PtsSchema, file: MatteInputFileSchema }).strict(),
  z.object({ kind: z.literal('lock'), pts: PtsSchema, file: MatteInputFileSchema }).strict(),
]);

const MatteParametersSchema = z
  .object({
    output: MatteOutputHandleSchema,
    inputs: MatteInputHandleSchema.optional(),
    prompts: z.array(MattePromptSchema).min(1).max(CAPABILITY_PACK_MATTE_MAX_PROMPTS),
    /** Re-run: frames the new prompts do not affect reuse this artifact's verified alpha. */
    previousArtifact: Sha256HexSchema.optional(),
    previewHeight: z.number().int().min(180).max(1080),
  })
  .strict()
  .superRefine((parameters, context) => {
    const declared = new Set(parameters.inputs?.files ?? []);
    const referenced = new Set<string>();
    parameters.prompts.forEach((prompt, index) => {
      if (prompt.kind !== 'brush' && prompt.kind !== 'lock') return;
      const folder = prompt.kind === 'brush' ? 'corrections' : 'locked';
      if (prompt.file !== `${folder}/${prompt.pts}.png`) {
        context.addIssue({
          code: 'custom',
          path: ['prompts', index, 'file'],
          message: `a ${prompt.kind} prompt's file must be ${folder}/<its pts>.png`,
        });
      }
      if (!declared.has(prompt.file)) {
        context.addIssue({
          code: 'custom',
          path: ['prompts', index, 'file'],
          message: 'brush and lock files must be listed in the inputs handle',
        });
      }
      referenced.add(prompt.file);
    });
    for (const file of declared) {
      if (file.startsWith('previous/')) {
        if (parameters.previousArtifact === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['inputs', 'files'],
            message: 'previous artifact files need previousArtifact',
          });
          break;
        }
        continue;
      }
      if (!referenced.has(file)) {
        context.addIssue({
          code: 'custom',
          path: ['inputs', 'files'],
          message: 'the inputs handle may list only files a prompt references',
        });
        break;
      }
    }
    if (
      parameters.prompts.every((prompt) => prompt.kind === 'brush' || prompt.kind === 'lock') &&
      parameters.previousArtifact === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['prompts'],
        message: 'a matte needs a point or box prompt unless it refines a previous artifact',
      });
    }
  });

const SegmentFrameParametersSchema = z
  .object({
    pts: PtsSchema,
    points: z.array(MattePointSchema).min(1).max(CAPABILITY_PACK_MATTE_MAX_POINTS).optional(),
    box: NormalizedBoxSchema.optional(),
    /** Hover highlight: the object under the pointer, never written to project state. */
    hoverPoint: NormalizedPointSchema.optional(),
    previewHeight: z.number().int().min(180).max(1080),
  })
  .strict()
  .refine(
    (value) =>
      value.points !== undefined || value.box !== undefined || value.hoverPoint !== undefined,
    { message: 'segment_frame needs points, a box, or a hover point' },
  );

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

/** A packed fp16 vector, base64. Text, not numbers: 64 x 768 floats as JSON would not fit. */
const PackedVectorSchema = z
  .string()
  .min(4)
  .max(1_000_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'packed vector must be base64');
const ConfidentLabelSchema = z
  .object({ value: z.string().min(1).max(64), p: z.number().finite().min(0).max(1) })
  .strict();
/** One shot to embed: which shot it is, and the source second to decode for it. */
const ShotPromptSchema = z
  .object({
    shotIndex: z.number().int().nonnegative(),
    keyframeT: z.number().finite().nonnegative(),
  })
  .strict();

/**
 * One shot to describe: which shot it is, and the SPAN it occupies. Tier 2 is handed the
 * span rather than a keyframe because it looks at up to three frames (first, middle,
 * last) — a single still cannot show what a shot *does*, and the choice of which frames
 * to read is part of the description's meaning, so it belongs with the model that reads
 * them.
 */
const ShotSpanSchema = z
  .object({
    shotIndex: z.number().int().nonnegative(),
    t0: z.number().finite().nonnegative(),
    t1: z.number().finite().positive(),
  })
  .strict()
  .refine((shot) => shot.t1 > shot.t0, { message: 'a shot span must be positive' });

/**
 * The ledger's own framing ladder and camera-movement enum, plus an explicit `unknown`.
 * A sentinel rather than an optional key: the JSON schema the worker generates against
 * requires every property (OpenAI's strict mode and llama.cpp's grammar conversion both
 * need that), so "the model declined" and "the field was lost in transport" must not look
 * the same on the wire.
 */
const DESCRIBE_UNKNOWN = 'unknown' as const;
const DescribedShotSizeSchema = z.enum([
  'EWS',
  'WS',
  'MWS',
  'MS',
  'MCU',
  'CU',
  'ECU',
  DESCRIBE_UNKNOWN,
]);
const DescribedCameraAngleSchema = z.enum([
  'eye-level',
  'high',
  'low',
  'overhead',
  'dutch',
  'over-the-shoulder',
  'pov',
  DESCRIBE_UNKNOWN,
]);
const DescribedCameraMovementSchema = z.enum([
  'static',
  'pan',
  'tilt',
  'zoom',
  'handheld',
  'tracking',
  DESCRIBE_UNKNOWN,
]);
/** Closed vocabulary for `quality`. No `unknown`: an empty list already says it. */
const DescribedQualitySchema = z.enum([
  'well-lit',
  'dim',
  'overexposed',
  'underexposed',
  'backlit',
  'sharp',
  'soft-focus',
  'motion-blur',
  'noisy',
  'shaky',
  'high-contrast',
  'flat',
]);

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
      .object({
        corners: z.tuple([
          NormalizedPointSchema,
          NormalizedPointSchema,
          NormalizedPointSchema,
          NormalizedPointSchema,
        ]),
      })
      .strict(),
  }).strict(),
  RequestBaseSchema.extend({
    capability: z.literal('subject.detect'),
    parameters: z
      .object({
        labels: z
          .array(z.enum(['face', 'person', 'object']))
          .min(1)
          .max(3),
        maxDetections: z.number().int().positive().max(100).default(20),
      })
      .strict(),
  }).strict(),
  RequestBaseSchema.extend({
    capability: z.literal('visual.embed'),
    parameters: z
      .object({
        /**
         * The bank version the HOST believes is current. The worker owns the phrases and
         * refuses a version it does not speak, so a pack and an engine that disagree fail
         * loudly instead of labelling footage against sentences nobody chose.
         */
        promptBankVersion: z.number().int().positive(),
        shots: z.array(ShotPromptSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_SHOTS),
      })
      .strict()
      .refine(
        (value) => new Set(value.shots.map((shot) => shot.shotIndex)).size === value.shots.length,
        { message: 'visual.embed shots must be distinct' },
      ),
  }).strict(),
  /**
   * Text embedding carries NO media handle: a query ("wide shots of the street") has no
   * frames. It is the one capability whose request is media-free, which is why it extends
   * the bare message shape rather than `RequestBaseSchema`.
   */
  z
    .object({
      type: z.literal('request'),
      protocolVersion: z.literal(CAPABILITY_PACK_WORKER_PROTOCOL_VERSION),
      requestId: RequestIdSchema,
      projectRevision: z.number().int().nonnegative(),
      capability: z.literal('visual.text'),
      parameters: z
        .object({
          texts: z.array(z.string().min(1).max(512)).min(1).max(CAPABILITY_PACK_WORKER_MAX_TEXTS),
        })
        .strict(),
    })
    .strict(),
  RequestBaseSchema.extend({
    capability: z.literal('visual.describe'),
    parameters: z
      .object({
        /**
         * The ledger tier version the HOST believes is current. The worker owns the
         * description schema and refuses a version it does not speak, so a pack and an
         * engine that disagree fail loudly instead of writing facts nobody can interpret.
         */
        tier2Version: z.number().int().positive(),
        shots: z.array(ShotSpanSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_DESCRIBE_SHOTS),
      })
      .strict()
      .refine(
        (value) => new Set(value.shots.map((shot) => shot.shotIndex)).size === value.shots.length,
        { message: 'visual.describe shots must be distinct' },
      ),
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
  /**
   * Background removal over a frame range (plan 03). The only capability with a WRITE
   * handle; the worker client re-checks it lies inside the host's staging root.
   */
  RequestBaseSchema.extend({
    capability: z.literal('subject.matte'),
    parameters: MatteParametersSchema,
  }).strict(),
  /** Interactive single-frame segmentation against a warm worker. Writes nothing. */
  RequestBaseSchema.extend({
    capability: z.literal('subject.segment_frame'),
    parameters: SegmentFrameParametersSchema,
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
    phase: z.enum([
      'decode',
      'initialize',
      'track',
      'detect',
      'segment',
      'embed',
      'encode',
      'describe',
      // subject.matte (plan 03); additive, so v1 packs are unaffected.
      'refine',
      'consensus',
      'self_correct',
      'matte',
      'foreground',
      'stabilise',
      'verify',
    ]),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    /** Self-correction round, 1-based. Only `self_correct` progress carries it. */
    round: z.number().int().positive().max(16).optional(),
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

/** One shot's tier-1 product: a vector, closed-vocabulary labels with `p`, and faces. */
const ShotEmbeddingSchema = z
  .object({
    shotIndex: z.number().int().nonnegative(),
    vector: PackedVectorSchema,
    /**
     * Absent groups are absent, never a zero-probability guess: a backend that could not
     * score a group has said nothing about it, and the ledger stores that as `null`.
     */
    labels: z
      .object({
        shotSize: ConfidentLabelSchema.optional(),
        subjectKind: ConfidentLabelSchema.optional(),
        setting: ConfidentLabelSchema.optional(),
        screenContent: ConfidentLabelSchema.optional(),
      })
      .strict(),
    faces: z.number().int().nonnegative().max(1_000),
    /** Identity embeddings, one per counted face, for the host's entity clustering. */
    faceVectors: z.array(PackedVectorSchema).max(1_000),
  })
  .strict()
  .refine((shot) => shot.faceVectors.length === 0 || shot.faceVectors.length === shot.faces, {
    message: 'faceVectors must be empty or carry one vector per counted face',
  });

/**
 * One shot's tier-2 product: the structured description every producer emits — the local
 * pack, the hosted captioner, and TwelveLabs (which can fill only `summary`). Free-text
 * fields are `''` when the model said nothing rather than a plausible sentence: a filler
 * sentence would be counted as coverage by the digest.
 */
const DescribedShotSchema = z
  .object({
    shotIndex: z.number().int().nonnegative(),
    /** At most two sentences, only what is visible. This is what FTS indexes. */
    summary: z.string().min(1).max(400),
    subject: z.string().max(160),
    action: z.string().max(160),
    setting: z.string().max(160),
    camera: z
      .object({
        shotSize: DescribedShotSizeSchema,
        angle: DescribedCameraAngleSchema,
        movement: DescribedCameraMovementSchema,
      })
      .strict(),
    mood: z.string().max(160),
    /** Text legible in frame, VERBATIM. Never paraphrased, never tidied. */
    onScreenText: z.array(z.string().min(1).max(200)).max(16),
    quality: z.array(DescribedQualitySchema).max(6),
    /**
     * The model's self-rated confidence, as three words. The engine maps it to
     * `described.p` = 0.5 / 0.7 / 0.9. It is a hint a renderer may print — never a gate,
     * and nothing has calibrated it.
     */
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

/** One file the worker wrote, as the worker claims it. The host re-hashes every one. */
const MatteArtifactFileSchema = z
  .object({
    name: MatteArtifactFileNameSchema,
    bytes: z.number().int().positive().max(CAPABILITY_PACK_MATTE_MAX_OUTPUT_BYTES),
    sha256: Sha256HexSchema,
  })
  .strict();

const RationalSchema = z.tuple([
  z.number().int().positive().max(2 ** 31),
  z.number().int().positive().max(2 ** 31),
]);

export const MatteReviewReasonSchema = z.enum([
  'subject_lost',
  'estimates_disagree',
  'flow_inconsistent',
  'new_region',
  'edge_misaligned',
  'occlusion',
  'motion_blur',
]);

const MatteArtifactDescriptorSchema = z
  .object({
    files: z.array(MatteArtifactFileSchema).min(2).max(6),
    width: z.number().int().positive().max(CAPABILITY_PACK_MATTE_MAX_SIDE),
    height: z.number().int().positive().max(CAPABILITY_PACK_MATTE_MAX_SIDE),
    frameCount: z.number().int().positive(),
    firstPts: PtsSchema,
    lastPts: PtsSchema,
    timeBase: RationalSchema,
  })
  .strict()
  .refine((artifact) => new Set(artifact.files.map((file) => file.name)).size === artifact.files.length, {
    message: 'artifact files must be distinct',
  })
  .refine(
    (artifact) =>
      MATTE_REQUIRED_FILES.every((name) => artifact.files.some((file) => file.name === name)),
    { message: 'artifact must include matte.mkv and frames.json' },
  )
  .refine((artifact) => artifact.lastPts >= artifact.firstPts, {
    message: 'artifact lastPts must not precede firstPts',
  })
  .refine((artifact) => artifact.frameCount > 1 || artifact.lastPts === artifact.firstPts, {
    message: 'a one-frame artifact has one pts',
  });

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
    capability: z.literal('visual.embed'),
    promptBankVersion: z.number().int().positive(),
    dim: z.number().int().positive().max(8192),
    faceDim: z.number().int().positive().max(8192).optional(),
    shots: z.array(ShotEmbeddingSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_SHOTS),
  }).strict(),
  ResultBaseSchema.extend({
    capability: z.literal('visual.text'),
    dim: z.number().int().positive().max(8192),
    vectors: z.array(PackedVectorSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_TEXTS),
  }).strict(),
  ResultBaseSchema.extend({
    capability: z.literal('visual.describe'),
    tier2Version: z.number().int().positive(),
    /** The producing model id, stored on every `shots.described` row. */
    model: z.string().min(1).max(160),
    shots: z.array(DescribedShotSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_DESCRIBE_SHOTS),
  }).strict(),
  ResultBaseSchema.extend({
    capability: z.literal('subject.segment'),
    masks: z.array(MaskSampleSchema).min(1).max(CAPABILITY_PACK_WORKER_MAX_SAMPLES),
  }).strict(),
  ResultBaseSchema.extend({
    capability: z.literal('subject.matte'),
    artifact: MatteArtifactDescriptorSchema,
    executionProvider: z.enum(['coreml', 'directml', 'cpu']),
    summary: z
      .object({
        verifiedFrames: z.number().int().nonnegative(),
        flaggedFrames: z.number().int().nonnegative(),
        lockedFrames: z.number().int().nonnegative(),
        selfCorrectionRounds: z.number().int().nonnegative().max(16),
      })
      .strict(),
    needsReview: z
      .array(
        z
          .object({ startPts: PtsSchema, endPts: PtsSchema, reason: MatteReviewReasonSchema })
          .strict()
          .refine((range) => range.endPts >= range.startPts, {
            message: 'a review range must not end before it starts',
          }),
      )
      .max(CAPABILITY_PACK_MATTE_MAX_REVIEW_RANGES),
  })
    .strict()
    // A frame the pipeline could not verify is flagged, never counted as verified.
    .refine(
      (result) =>
        result.summary.verifiedFrames + result.summary.flaggedFrames <= result.artifact.frameCount,
      { message: 'verified and flagged frames cannot exceed the artifact frame count' },
    ),
  ResultBaseSchema.extend({
    capability: z.literal('subject.segment_frame'),
    pts: PtsSchema,
    width: z.number().int().positive().max(CAPABILITY_PACK_MATTE_MAX_SIDE),
    height: z.number().int().positive().max(1080),
    /** 8-bit grayscale PNG, base64. The host writes it to a temp inputs file. */
    maskPng: z
      .string()
      .min(8)
      .max(CAPABILITY_PACK_SEGMENT_FRAME_MAX_PNG_CHARS)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u, 'maskPng must be base64'),
    score: z.number().finite().min(0).max(1),
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
      // A worker refusing to emit a result line that would exceed
      // `CAPABILITY_PACK_WORKER_MAX_LINE_BYTES`. Distinct from `internal_error` so the
      // host can recognise a deterministic size-bound refusal by this code instead of
      // pattern-matching `detail` text (packs built before this code existed still
      // report the same condition as `internal_error`; the host keeps a message-text
      // fallback for those — see `isRetryableWorkerFault` in
      // apps/desktop/electron/capability-packs/tracking.ts).
      'output_too_large',
      // The staging directory could not be written (disk full, folder not writable). Its own
      // code so the host can say so without matching `detail` text.
      'output_unwritable',
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

/** Capabilities whose request carries a host-issued WRITE handle (MD-3). A closed list. */
export const CAPABILITY_PACK_OUTPUT_HANDLE_CAPABILITIES: ReadonlySet<string> = new Set([
  'subject.matte',
]);

export type CapabilityPackCapabilityNegotiation =
  | { readonly status: 'supported' }
  | { readonly status: 'unsupported'; readonly reason: 'capability_absent' | 'protocol_mismatch' };

/**
 * Whether a pack that announced `offer` (its handshake) can answer `capability`.
 *
 * Additive negotiation: the protocol version stays 1 and new capabilities are new union
 * members. A pack built before a capability existed simply does not list it, and the host
 * treats that as "this pack cannot do it" (install/update proposal), never as a crash.
 */
export function negotiateCapabilityPackCapability(
  offer: { readonly protocolVersion: number; readonly capabilities: readonly string[] },
  capability: string,
): CapabilityPackCapabilityNegotiation {
  if (offer.protocolVersion !== CAPABILITY_PACK_WORKER_PROTOCOL_VERSION) {
    return { status: 'unsupported', reason: 'protocol_mismatch' };
  }
  return offer.capabilities.includes(capability)
    ? { status: 'supported' }
    : { status: 'unsupported', reason: 'capability_absent' };
}

export type MatteOutputHandle = z.infer<typeof MatteOutputHandleSchema>;
export type MatteInputHandle = z.infer<typeof MatteInputHandleSchema>;
export type MattePrompt = z.infer<typeof MattePromptSchema>;
export type MatteArtifactFileName = z.infer<typeof MatteArtifactFileNameSchema>;
export type MatteReviewReason = z.infer<typeof MatteReviewReasonSchema>;
