/**
 * The measured payloads the masking tools exchange with the host (AM1.1, AM3.1).
 *
 * The masking tools are split across two trust boundaries, like `track_subject_automatically`:
 * the model states an objective, a trusted host executor measures the media in an isolated pack
 * worker, and the orchestrator turns the validated measurement into editor-core commands. These
 * schemas are that seam. Everything the op builder needs must be here, because the orchestrator
 * refuses to guess: no candidate ⇒ no geometry, no artifact pin ⇒ no matte.
 */
import { z } from 'zod/v4';

/** Registry names; also the executor routing keys on the desktop host. */
export const FIND_MASK_TARGETS_TOOL_NAME = 'find_mask_targets';
export const CREATE_MASK_TOOL_NAME = 'create_mask';
export const REMOVE_BACKGROUND_TOOL_NAME = 'remove_background';
export const TRACK_MASK_TOOL_NAME = 'track_mask';

/** The tools a host executor measures for. */
export const MASKING_HOST_TOOL_NAMES: readonly string[] = [
  FIND_MASK_TARGETS_TOOL_NAME,
  CREATE_MASK_TOOL_NAME,
  REMOVE_BACKGROUND_TOOL_NAME,
  TRACK_MASK_TOOL_NAME,
];

/** The host-measured tools whose result becomes a patch. */
export const MASKING_HOST_MUTATION_TOOL_NAMES: readonly string[] = [
  CREATE_MASK_TOOL_NAME,
  REMOVE_BACKGROUND_TOOL_NAME,
  TRACK_MASK_TOOL_NAME,
];

const UnitSchema = z.number().finite().min(0).max(1);
const SourceTimeSchema = z.number().finite().nonnegative();
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const NormalizedBoxSchema = z
  .object({ x: UnitSchema, y: UnitSchema, width: UnitSchema, height: UnitSchema })
  .strict()
  .refine((box) => box.width > 0 && box.height > 0, { message: 'a box must have area' });

/** Stable per clip and source time, so an id recalled later in the run still resolves. */
export const MaskCandidateIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export const MASK_CANDIDATE_LABELS = ['face', 'person', 'object'] as const;

/** One thing on screen the editor could mean, as the detector measured it. */
export const MaskCandidateSchema = z
  .object({
    candidateId: MaskCandidateIdSchema,
    label: z.enum(MASK_CANDIDATE_LABELS),
    /** Ranking score in 0..1: grounding × agreement × persistence. */
    score: UnitSchema,
    box: NormalizedBoxSchema,
    /** Asset source seconds of the frame `box` was measured on. */
    sourceTime: SourceTimeSchema,
    /** Fraction of the sampled frames the candidate was seen on. */
    persistence: UnitSchema,
    /** A host-owned thumbnail handle for the sidebar picker; never a path. */
    thumbnailRef: z.string().min(1).max(256).optional(),
    /** Identity cluster, present only with face-recognition consent. */
    identity: z.string().min(1).max(128).optional(),
  })
  .strict();
export type MaskCandidate = z.infer<typeof MaskCandidateSchema>;

/** Why the resolver stopped instead of choosing. */
export const MASK_TARGET_STATUSES = [
  'resolved',
  'ambiguous_target',
  'needs_click',
  'needs_face_selection',
  'no_candidates',
] as const;
export type MaskTargetStatus = (typeof MASK_TARGET_STATUSES)[number];

export const MaskTargetsResultSchema = z
  .object({
    kind: z.literal('mask_targets'),
    clipId: z.string().min(1),
    description: z.string(),
    status: z.enum(MASK_TARGET_STATUSES),
    /** Ranked, best first. */
    candidates: z.array(MaskCandidateSchema).max(24),
    /** Set only for `resolved`: every candidate the request names (one, or all of a class). */
    chosenCandidateIds: z.array(MaskCandidateIdSchema).max(24).default([]),
    reranker: z.enum(['siglip', 'none']),
    engine: z.string().min(1).max(256),
  })
  .strict();
export type MaskTargetsResult = z.infer<typeof MaskTargetsResultSchema>;

const RangeSchema = z.object({ start: SourceTimeSchema, end: SourceTimeSchema }).strict();

/** A binary bitmap as the worker protocol carries it. */
export const BinaryMatteSchema = z
  .object({
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    counts: z.array(z.number().int().nonnegative()).min(1).max(2_000_000),
  })
  .strict();

const MatteArtifactSchema = z
  .object({
    key: Sha256HexSchema,
    files: z.array(z.object({ name: z.string().min(1), sha256: Sha256HexSchema }).strict()).min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    coverage: z.object({ sourceStart: SourceTimeSchema, sourceEnd: SourceTimeSchema }).strict(),
    packId: z.string().min(1),
    packVersion: z.string().min(1),
    modelDigests: z.array(z.string()),
  })
  .strict();

const TrackMeasurementSchema = z
  .object({
    artifact: z.object({ key: Sha256HexSchema, sha256: Sha256HexSchema }).strict(),
    method: z.enum(['position', 'position-scale-rotation', 'perspective', 'point-cloud']),
    referenceSourceTime: SourceTimeSchema,
    /** Ranges the editor should look at, source seconds. */
    flagged: z.array(RangeSchema),
    frames: z.number().int().nonnegative(),
    /** The worst model residual over the track, source pixels. */
    worstResidualPx: z.number().finite().nonnegative(),
    engine: z.string().min(1).max(256),
  })
  .strict();
export type TrackMeasurement = z.infer<typeof TrackMeasurementSchema>;

/** What the host measured for `create_mask` / `remove_background`. */
export const CreateMaskMeasurementSchema = z.discriminatedUnion('precision', [
  z
    .object({
      kind: z.literal('create_mask'),
      precision: z.literal('cutout'),
      clipId: z.string().min(1),
      /** Absent for the main-subject preset, where the host's auto prompt chose. */
      candidate: MaskCandidateSchema.optional(),
      artifact: MatteArtifactSchema,
      needsReview: z.array(RangeSchema),
      verifiedFrames: z.number().int().nonnegative(),
      flaggedFrames: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('create_mask'),
      precision: z.literal('shape'),
      clipId: z.string().min(1),
      /** Absent when the editor typed the shape (`userShape`); the geometry is then theirs. */
      candidate: MaskCandidateSchema.optional(),
      /** A single-frame segmentation when the pack produced one; else the box is the source. */
      matte: BinaryMatteSchema.optional(),
      track: TrackMeasurementSchema.optional(),
    })
    .strict(),
]);
export type CreateMaskMeasurement = z.infer<typeof CreateMaskMeasurementSchema>;

export const TrackMaskMeasurementSchema = z
  .object({
    kind: z.literal('track_mask'),
    clipId: z.string().min(1),
    maskId: z.string().min(1),
    track: TrackMeasurementSchema,
  })
  .strict();
export type TrackMaskMeasurement = z.infer<typeof TrackMaskMeasurementSchema>;

/**
 * What every masking result reports about its own trustworthiness (AM3.1).
 *
 * Deterministic facts only: the pack's flagged ranges, the track's residual, and the
 * validator's verdict. There is deliberately no `verified` field — the Inspector's review list
 * is the only place that word is earned (plan 11 rule 3).
 */
export interface MaskReviewReport {
  readonly maskId: string;
  readonly needsReview: readonly { readonly start: number; readonly end: number }[];
  readonly flaggedCount: number;
  readonly trackConfidence?: {
    readonly frames: number;
    readonly worstResidualPx: number;
    readonly flaggedCount: number;
  };
  /** Frames the pack vouched for and flagged, for a cut-out. */
  readonly frames?: { readonly verified: number; readonly flagged: number };
  /** Non-blocking validator warnings ride along; an error would have refused the edit. */
  readonly validator: { readonly valid: boolean; readonly issues: readonly string[] };
  /**
   * The one visual look, where the numbers could not decide (AM3.2). `yes` is a second
   * opinion, not a verification; `unsure` put `frames` on the review list; `not_run` is a fact
   * about the check. There is no `no` here: a `no` means the mask was never applied.
   */
  readonly spotCheck?: {
    readonly verdict: 'yes' | 'unsure' | 'not_run';
    readonly reason: string;
    readonly frames: readonly number[];
  };
}
