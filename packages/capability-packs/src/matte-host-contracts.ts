/**
 * Renderer → desktop-main payloads for background removal (plan 03, BR4.3–BR4.6).
 *
 * Every IPC argument is untrusted. These schemas are the only shapes main accepts: no paths,
 * no pack ids, no handles. Main resolves the asset, the pack, the staging directory and the
 * frame range itself; the renderer states WHAT (asset, source range, prompts, revision).
 */
import { z } from 'zod/v4';

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const UnitSchema = z.number().finite().min(0).max(1);
const SourceTimeSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(7 * 24 * 60 * 60);
/** Host job id, also the staging directory name: portable and traversal-free. */
export const MatteJobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
export const CapabilityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

/** Most prompts one run may carry; mirrors `CAPABILITY_PACK_MATTE_MAX_PROMPTS`. */
export const MATTE_INTENT_MAX_PROMPTS = 512;
/** Largest correction PNG main accepts over IPC. */
export const MATTE_CORRECTION_MAX_BYTES = 64 * 1024 * 1024;

const PointSchema = z
  .object({ x: UnitSchema, y: UnitSchema, label: z.enum(['include', 'exclude']) })
  .strict();
const BoxSchema = z
  .object({ x: UnitSchema, y: UnitSchema, width: UnitSchema, height: UnitSchema })
  .strict()
  .refine(
    (box) => box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1,
    {
      message: 'box must be non-empty and inside the frame',
    },
  );

/** Mirrors `MattePromptRefSchema` in timeline-schema: what the mask records it asked for. */
export const MatteIntentPromptSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('points'),
      sourceTime: SourceTimeSchema,
      points: z.array(PointSchema).min(1).max(64),
    })
    .strict(),
  z.object({ kind: z.literal('box'), sourceTime: SourceTimeSchema, box: BoxSchema }).strict(),
  z
    .object({ kind: z.literal('brush'), sourceTime: SourceTimeSchema, sha256: Sha256HexSchema })
    .strict(),
  z
    .object({ kind: z.literal('lock'), sourceTime: SourceTimeSchema, sha256: Sha256HexSchema })
    .strict(),
  z.object({ kind: z.literal('candidate'), candidateId: z.string().min(1).max(128) }).strict(),
]);

export const MatteRunIntentSchema = z
  .object({
    requestId: MatteJobIdSchema,
    assetId: z.string().min(1).max(256),
    /** The clip the editor is working on, for the jobs panel and scheduling priority. */
    clipId: z.string().min(1).max(256).optional(),
    /** Coverage in asset source seconds, handles included. */
    sourceStart: SourceTimeSchema,
    sourceEnd: SourceTimeSchema,
    /** Empty asks the host for the main subject (auto prompt). */
    prompts: z.array(MatteIntentPromptSchema).max(MATTE_INTENT_MAX_PROMPTS),
    /** Partial re-run: frames the new prompts do not affect keep this artifact's alpha. */
    previousArtifactKey: Sha256HexSchema.optional(),
    /** Write `foreground.mkv` for clean edges (`decontaminate`). */
    foreground: z.boolean().default(true),
    previewHeight: z.number().int().min(180).max(1080).default(540),
    /**
     * Plan 13: `fast` (minutes, macOS) or `best` (the models, hours). Absent = the host's
     * default for this machine, which is `fast` wherever it can run.
     */
    quality: z.enum(['fast', 'best']).optional(),
    /** The renderer's timeline revision; a moved project refuses or discards the job. */
    timelineRevision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((intent) => intent.sourceEnd > intent.sourceStart, {
    message: 'matte coverage must be a positive range',
  });

export const MatteSaveCorrectionSchema = z
  .object({
    /** The artifact the correction was drawn on; its size is the PNG's required size. */
    artifactKey: Sha256HexSchema,
    sourceTime: SourceTimeSchema,
    kind: z.enum(['brush', 'lock']),
    png: z.custom<Uint8Array>(
      (value) =>
        value instanceof Uint8Array &&
        value.byteLength > 0 &&
        value.byteLength <= MATTE_CORRECTION_MAX_BYTES,
      { message: 'png must be non-empty bytes within the size limit' },
    ),
  })
  .strict();

/**
 * Hover highlight / click preview on one frame (`subject.segment_frame`, BR6.11). Read-only: main
 * answers with a preview-resolution mask and writes nothing, to the project or to disk. Exactly
 * one of a hover point (what a click here would select) or include/exclude points.
 */
export const MatteSegmentFrameIntentSchema = z
  .object({
    /** The renderer's id for this request; a newer hover supersedes an older one in flight. */
    requestId: MatteJobIdSchema,
    assetId: z.string().min(1).max(256),
    /** Asset source seconds of the frame on the monitor. */
    sourceTime: SourceTimeSchema,
    hoverPoint: z.object({ x: UnitSchema, y: UnitSchema }).strict().optional(),
    points: z.array(PointSchema).min(1).max(64).optional(),
    previewHeight: z.number().int().min(180).max(1080).default(360),
  })
  .strict()
  .refine((intent) => (intent.hoverPoint === undefined) !== (intent.points === undefined), {
    message: 'segment_frame takes a hover point or points, not both',
  });

export type MatteSegmentFrameIntent = z.infer<typeof MatteSegmentFrameIntentSchema>;

export const MatteCleanRequestSchema = z
  .object({
    /** Exactly the keys the confirmation dialog listed; anything referenced is still refused. */
    approvedKeys: z.array(Sha256HexSchema).max(100_000),
    /**
     * Artifact and input digests the open session's undo history still references. They can
     * only PROTECT more files from deletion, never less, so the renderer is trusted with them.
     */
    protectedKeys: z.array(Sha256HexSchema).max(100_000).default([]),
  })
  .strict();

export const MatteStorageRequestSchema = z
  .object({ protectedKeys: z.array(Sha256HexSchema).max(100_000).default([]) })
  .strict();

export type MatteStorageRequest = z.infer<typeof MatteStorageRequestSchema>;

export type MatteRunIntent = z.infer<typeof MatteRunIntentSchema>;
export type MatteIntentPrompt = z.infer<typeof MatteIntentPromptSchema>;
export type MatteSaveCorrection = z.infer<typeof MatteSaveCorrectionSchema>;
export type MatteCleanRequest = z.infer<typeof MatteCleanRequestSchema>;

/**
 * Host-written facts about one committed artifact (`mattes/.results/<key>.json`).
 *
 * A cache hit needs the summary and review ranges the worker reported when the artifact was
 * verified; the artifact folder itself holds only the files a mask pins. The record is
 * re-checked against the files' digests before it is trusted.
 */
export const MatteArtifactRecordSchema = z
  .object({
    version: z.literal(1),
    key: Sha256HexSchema,
    assetId: z.string().min(1).max(256),
    files: z
      .array(
        z
          .object({
            name: z.enum([
              'matte.mkv',
              'foreground.mkv',
              'preview.webm',
              'foreground.preview.webm',
              'frames.json',
              'report.json',
            ]),
            bytes: z.number().int().positive(),
            sha256: Sha256HexSchema,
          })
          .strict(),
      )
      .min(2)
      .max(6),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    coverage: z.object({ sourceStart: SourceTimeSchema, sourceEnd: SourceTimeSchema }).strict(),
    packId: z.string().min(1).max(128),
    packVersion: z.string().min(1).max(64),
    modelDigests: z.array(Sha256HexSchema).max(64),
    executionProvider: z.enum(['coreml', 'directml', 'cpu']),
    summary: z
      .object({
        verifiedFrames: z.number().int().nonnegative(),
        flaggedFrames: z.number().int().nonnegative(),
        lockedFrames: z.number().int().nonnegative(),
        selfCorrectionRounds: z.number().int().nonnegative(),
      })
      .strict(),
    needsReview: z
      .array(
        z
          .object({
            start: SourceTimeSchema,
            end: SourceTimeSchema,
            reason: z.enum([
              'subject_lost',
              'estimates_disagree',
              'flow_inconsistent',
              'new_region',
              'edge_misaligned',
              'occlusion',
              'motion_blur',
            ]),
          })
          .strict(),
      )
      .max(4096),
    /** Source pts of frames locked in this artifact; a re-run must keep them bit-identical. */
    lockedPts: z.array(z.number().int()).max(4096),
    /** The source's content fingerprint when the matte was made (part of the cache key). */
    contentFingerprint: Sha256HexSchema,
    /**
     * Decoded-frame hashes of the SOURCE at commit time: the coverage's exact first and last
     * frames plus up to 16 evenly spaced samples (BR4.10 relink/replace re-check).
     */
    sourceSamples: z
      .array(z.object({ pts: z.number().int(), sha256: Sha256HexSchema }).strict())
      .max(64),
    createdAt: z.string().datetime(),
  })
  .strict();

export type MatteArtifactRecord = z.infer<typeof MatteArtifactRecordSchema>;

/** An asset id named by the renderer for a relink (BR4.14). */
export const RelinkAssetIdSchema = z.string().min(1).max(256);

export const MatteRecheckRequestSchema = z
  .object({ assetIds: z.array(RelinkAssetIdSchema).min(1).max(1_000) })
  .strict();

/** A jobs-panel action on one scheduled pack job (BR4.9). */
export const CapabilityPackJobActionSchema = z
  .object({
    jobId: MatteJobIdSchema,
    action: z.enum(['pause', 'resume', 'cancel']),
  })
  .strict();

/**
 * Track one mask (MK7.4).
 *
 * Deliberately carries no media path, no frame range and no geometry: main derives all of that
 * from the mask in the project it reads from disk, so a renderer cannot ask for a track of
 * geometry the project does not contain. Point and region lists are bounded here, before
 * anything is spawned.
 */
export const MaskTrackIntentSchema = z
  .object({
    requestId: MatteJobIdSchema,
    clipId: z.string().min(1).max(256),
    maskId: z.string().min(1).max(256),
    method: z.enum(['position', 'position-scale-rotation', 'perspective', 'point-cloud']),
    direction: z.enum(['forward', 'backward', 'one-frame', 'to-clip-edge', 'both']),
    referenceSourceTime: SourceTimeSchema,
    /** Extra texture the tracker should follow, display-corrected source pixels. */
    featurePoints: z
      .array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
      .max(64)
      .optional(),
    /**
     * Regions the tracker must ignore, display-corrected source pixels, with the source instant
     * each was drawn at (MK7.7): a measurement carries the boxes drawn on its own first frame.
     */
    exclusions: z
      .array(
        z
          .object({
            x: z.number().finite(),
            y: z.number().finite(),
            width: z.number().finite().positive(),
            height: z.number().finite().positive(),
            sourceTime: SourceTimeSchema.optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    /** Re-measure only around the mask's constraint frames instead of the whole direction. */
    fromConstraints: z.boolean().optional(),
  })
  .strict();

export type MaskTrackIntent = z.infer<typeof MaskTrackIntentSchema>;

export type CapabilityPackJobAction = z.infer<typeof CapabilityPackJobActionSchema>;
