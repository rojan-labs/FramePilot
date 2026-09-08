/**
 * @framepilot/ai-sdk/ledger — the shot ledger contract (ADR 0175, plan/visual-understanding).
 *
 * The TS half of the shape the engine writes. Kept byte-identical BY HAND to
 * `engine/python/framepilot_engine/brain/ledger_models.py`, the way `footage-map.ts`
 * mirrors `FootageMapResponse`; both sides carry a drift test naming the other file.
 *
 * What the ledger is for, in one line: the agent should be able to answer "what is on
 * screen here?" and "how far apart are these two shots?" from text it already has, so it
 * never has to spend a turn and a thousand image tokens looking (it never did — see
 * `reports/golden/BASELINE.md`).
 *
 * Three rules the types enforce rather than document:
 *
 * 1. **Provenance is structural.** `measured` / `labelled` / `described` are separate
 *    objects, so nothing can quietly treat a model's guess as a measurement.
 * 2. **Absence is `undefined`, never a default.** A tier that has not run is unknown, and
 *    unknown must never render as "normal".
 * 3. **Times are ASSET seconds.** Timeline seconds are a projection through a clip and are
 *    computed by the picture slice, never stored.
 */
import { z } from 'zod/v4';

/**
 * Per-tier versions. Bumping one nulls THAT column in the brain and re-queues THAT tier —
 * a model swap must never cost a re-measure of the other two.
 */
export const TIER0_VERSION = 1 as const;
export const TIER1_VERSION = 1 as const;
export const TIER2_VERSION = 1 as const;

export const MOTION_CLASSES = ['static', 'slow', 'handheld', 'fast'] as const;
export type MotionClass = (typeof MOTION_CLASSES)[number];

/**
 * The framing ladder, wide to close. ORDER IS THE CONTRACT: the gap between two entries is
 * a "step", and a cut-pair delta counts steps. One place to define it, so a delta and a
 * transition policy can never disagree about which direction is wider.
 */
export const SHOT_SIZE_LADDER = ['EWS', 'WS', 'MWS', 'MS', 'MCU', 'CU', 'ECU'] as const;
export type ShotSize = (typeof SHOT_SIZE_LADDER)[number];

/** Signed step distance on the ladder; positive means the second shot is tighter. */
export function shotSizeSteps(from: ShotSize, to: ShotSize): number {
  return SHOT_SIZE_LADDER.indexOf(to) - SHOT_SIZE_LADDER.indexOf(from);
}

export const SUBJECT_KINDS = [
  'person',
  'people',
  'object',
  'place',
  'screen',
  'text',
  'animal',
  'food',
  'vehicle',
  'none',
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SCREEN_CONTENTS = [
  'talking-head',
  'b-roll',
  'screen-recording',
  'slides',
  'title-card',
  'graphic',
] as const;
export type ScreenContent = (typeof SCREEN_CONTENTS)[number];

export const CAMERA_MOVEMENTS = ['static', 'pan', 'tilt', 'zoom', 'handheld', 'tracking'] as const;
export type CameraMovement = (typeof CAMERA_MOVEMENTS)[number];

/** Brightness distribution over a shot, normalised 0..1 from the Y plane. */
export const LumaStatsSchema = z.object({
  mean: z.number(),
  std: z.number(),
  /**
   * The 10th and 90th percentiles — signalstats' own `YLOW`/`YHIGH`, named for what they
   * actually are. Percentiles, not min/max: one blown highlight or a black border must not
   * decide that a shot is bright.
   */
  p10: z.number(),
  p90: z.number(),
});
export type LumaStats = z.infer<typeof LumaStatsSchema>;

export const ChromaStatsSchema = z.object({
  uMean: z.number(),
  vMean: z.number(),
  satMean: z.number(),
});
export type ChromaStats = z.infer<typeof ChromaStatsSchema>;

export const MotionStatsSchema = z.object({
  /** Spatial information — detail, not movement. */
  si: z.number(),
  /** Temporal information — frame-to-frame movement; the class is derived from it. */
  ti: z.number(),
  class: z.enum(MOTION_CLASSES),
});
export type MotionStats = z.infer<typeof MotionStatsSchema>;

/** Tier 0: what ffmpeg can prove. No key, no model, no network — always available. */
export const MeasuredFactsSchema = z.object({
  tier0Version: z.number().int(),
  luma: LumaStatsSchema,
  chroma: ChromaStatsSchema,
  /** (V−U) normalised to −1..1, calibrated so a neutral chart reads 0. Positive is warm. */
  warmth: z.number(),
  /** p90 − p10 of luma: "flat" vs "punchy" as one printable number. */
  contrastIdx: z.number(),
  motion: MotionStatsSchema,
  /** scdet score at the shot's start — how hard it begins. */
  cutScore: z.number(),
  black: z.boolean(),
  freeze: z.boolean(),
  /** 1 − normalised blurdetect median; low is soft. */
  sharpness: z.number(),
  /**
   * 64-bit dHash as TEXT — a value a JSON number cannot hold.
   *
   * Absent when no keyframe hash was computed (the hash comes from the sampler's JPEG pass,
   * not the statistics decode). Never a placeholder string: every unhashed shot would then
   * read as a duplicate of every other.
   */
  phash: z.string().nullish(),
  loudnessLufs: z.number().nullish(),
});
export type MeasuredFacts = z.infer<typeof MeasuredFactsSchema>;

/**
 * A label and how much the model believed it.
 *
 * Wrapped rather than bare because the printing rule ("show it only at p ≥ 0.6") must be
 * applied uniformly, and a bare string cannot carry the number that rule reads.
 */
export const ConfidentSchema = z.object({
  value: z.string(),
  p: z.number().min(0).max(1),
});
export type Confident = z.infer<typeof ConfidentSchema>;

export const EntityRefSchema = z.object({
  id: z.string(),
  kind: z.string(),
  p: z.number().min(0).max(1),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

/** Tier 1: what a local embedding/face pack recognises. Probabilistic throughout. */
export const LabelledFactsSchema = z.object({
  tier1Version: z.number().int(),
  model: z.string(),
  shotSize: ConfidentSchema.nullish(),
  subjectKind: ConfidentSchema.nullish(),
  setting: ConfidentSchema.nullish(),
  screenContent: ConfidentSchema.nullish(),
  faces: z.number().int().default(0),
  entities: z.array(EntityRefSchema).default([]),
  /** Shot key of a near-identical shot (phash Hamming ≤ 6) — a repeated take. */
  duplicateOf: z.string().nullish(),
});
export type LabelledFacts = z.infer<typeof LabelledFactsSchema>;

export const CameraFactsSchema = z.object({
  shotSize: z.enum(SHOT_SIZE_LADDER).nullish(),
  angle: z.string().nullish(),
  movement: z.enum(CAMERA_MOVEMENTS).nullish(),
});
export type CameraFacts = z.infer<typeof CameraFactsSchema>;

/**
 * Tier 2: one STRUCTURED caption per shot.
 *
 * Structured, not prose: `summary` is what FTS indexes and a human reads; every other field
 * is what a filter or a solver can use. The hosted captioner, the local VLM pack and the
 * TwelveLabs arm all emit this same object — one schema, three producers.
 */
export const DescribedFactsSchema = z.object({
  tier2Version: z.number().int(),
  model: z.string(),
  summary: z.string(),
  subject: z.string().default(''),
  action: z.string().default(''),
  setting: z.string().default(''),
  camera: CameraFactsSchema.default({}),
  mood: z.string().default(''),
  /** Verbatim text visible in frame; never paraphrased. */
  onScreenText: z.array(z.string()).default([]),
  quality: z.array(z.string()).default([]),
  p: z.number().min(0).max(1).default(0.7),
});
export type DescribedFacts = z.infer<typeof DescribedFactsSchema>;

/**
 * One shot of one asset, with whichever tiers have run.
 *
 * Keyed `(assetId, contentHash, shotIndex)`: changed bytes are a different asset as far as
 * the ledger is concerned, which is what makes a re-import free and a re-encode correctly
 * expensive.
 */
export const ShotRecordSchema = z.object({
  assetId: z.string(),
  contentHash: z.string(),
  shotIndex: z.number().int(),
  /** ASSET seconds, inclusive. */
  t0: z.number(),
  /** ASSET seconds, exclusive. */
  t1: z.number(),
  keyframeT: z.number(),
  /**
   * A duration split inside one continuous take, not a scene cut. Long static material is
   * cut every 30s so per-shot statistics stay local; a policy must not read it as an edit
   * point.
   */
  splitOf: z.boolean().default(false),
  measured: MeasuredFactsSchema.nullish(),
  labelled: LabelledFactsSchema.nullish(),
  described: DescribedFactsSchema.nullish(),
});
export type ShotRecord = z.infer<typeof ShotRecordSchema>;

/**
 * How much of a project each tier has covered.
 *
 * Reported rather than inferred: a project with no described rows has not been described
 * yet, and the agent must be able to tell that from footage that has nothing to say.
 */
export const TierCoverageSchema = z.object({
  measured: z.number().int().default(0),
  labelled: z.number().int().default(0),
  described: z.number().int().default(0),
  total: z.number().int().default(0),
});
export type TierCoverage = z.infer<typeof TierCoverageSchema>;

/**
 * The whole-asset summary the project digest is built from.
 *
 * Pre-aggregated on purpose: the context block that says "14 assets, 212 shots, three of
 * them dim, the host is in 86" must never load per-shot rows.
 */
export const AssetDigestSchema = z.object({
  assetId: z.string(),
  contentHash: z.string(),
  durationS: z.number(),
  shotCount: z.number().int(),
  medianShotS: z.number(),
  shotSizeMix: z.record(z.string(), z.number()).default({}),
  settingMix: z.record(z.string(), z.number()).default({}),
  motionMix: z.record(z.string(), z.number()).default({}),
  /** Entity ids, most frequent first. */
  people: z.array(z.string()).default([]),
  exposureRange: z.tuple([z.number(), z.number()]).nullish(),
  warmthRange: z.tuple([z.number(), z.number()]).nullish(),
  hasSpeech: z.boolean().default(false),
  /** Shot indices flagged soft, black or frozen. */
  lowQualityShots: z.array(z.number().int()).default([]),
  coverage: TierCoverageSchema.default({ measured: 0, labelled: 0, described: 0, total: 0 }),
});
export type AssetDigest = z.infer<typeof AssetDigestSchema>;

/**
 * What one run reads: the shots of the assets its timeline references, plus digests.
 *
 * Bounded and paged by the route. A run never loads the library — only the assets that are
 * actually on the timeline it is editing.
 */
export const LedgerSnapshotSchema = z.object({
  shots: z.array(ShotRecordSchema).default([]),
  digests: z.array(AssetDigestSchema).default([]),
  coverage: TierCoverageSchema.default({ measured: 0, labelled: 0, described: 0, total: 0 }),
  nextCursor: z.string().nullish(),
});
export type LedgerSnapshot = z.infer<typeof LedgerSnapshotSchema>;

/** The stable key of a shot, used by `duplicateOf` and by every cache. */
export function shotKey(shot: Pick<ShotRecord, 'assetId' | 'contentHash' | 'shotIndex'>): string {
  return `${shot.assetId}:${shot.contentHash.slice(0, 12)}:${String(shot.shotIndex)}`;
}

/**
 * Parse a snapshot the engine sent, tolerantly.
 *
 * A ledger is an optimization: a malformed or unreachable one must degrade to "the agent
 * knows less", never to a failed run. Callers treat `null` as no coverage at all.
 */
export function parseLedgerSnapshot(value: unknown): LedgerSnapshot | null {
  const parsed = LedgerSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
