/**
 * @framepilot/ai-sdk/kernel/semantic-index/picture — the `picture` slice (ADR 0175,
 * `plan/visual-understanding/01-ARCHITECTURE.md` §6, task VU2.2).
 *
 * The join that lets the agent answer "what is on screen here?" from text it already has.
 * The shot ledger stores facts in **asset** seconds; the timeline places **clips**. This
 * module is the projection between them: every picture clip is joined to the shots it
 * actually shows, in timeline seconds, honouring trim, constant speed, reverse, freeze and
 * speed curves — and every pair of touching neighbours gains the deltas a transition or
 * grade policy reads.
 *
 * Three rules it holds, in the same spirit as `ledger.ts`:
 *
 * 1. **Pure and memoized per immutable snapshot.** Keyed on the {@link ProjectIndex} object
 *    (itself memoized per `Project`) and on the {@link LedgerSnapshot} object, both of which
 *    are replaced wholesale when their content changes. A trim to one clip produces a new
 *    project and therefore a new index; an untouched one reuses this structure by reference.
 *    Same scheme as `semantic-index.ts`, no second cache.
 * 2. **A missing tier is unknown, not a default.** Every derived number a tier could not
 *    supply is `null`, never `0`; `sameSetting` is `boolean | null`. "Not measured" and
 *    "normal" must never be the same value, because a policy reading `0` would happily
 *    decide two unmeasured shots match.
 * 3. **Absence is honest.** A `null`, empty or malformed ledger yields a slice with every
 *    picture clip present, no shots on any of them, and zero coverage — never a throw and
 *    never an invented fact.
 *
 * Deliberately NOT here: rendering words for the model (VU2.3 `context/shot-words.ts`), the
 * digest block (VU2.4), tools (VU2.5) and the briefing line (VU2.6) all consume this slice.
 */
import type { Clip, Project } from '@framepilot/timeline-schema';
import { hasSpeedRamp, integrateRate } from '@framepilot/editor-core';
import {
  SHOT_SIZE_LADDER,
  shotKey,
  shotSizeSteps,
  type DescribedFacts,
  type LabelledFacts,
  type LedgerSnapshot,
  type MeasuredFacts,
  type MotionClass,
  type ShotRecord,
  type ShotSize,
} from '../../ledger.js';
import { clipKindOf, type ClipEntry, type ProjectIndex } from '../../project-index.js';

// ---------------------------------------------------------------------------
// Thresholds — ONE block, ADR 0175 / plan §VU2.2. Each number, and why it is that number.
// ---------------------------------------------------------------------------

/**
 * The fixed thresholds that turn a cut-pair delta into a flag. They live together because a
 * flag is a *shared vocabulary*: the clip row, the transition policy and the post-apply
 * verifier must all agree on what "an exposure jump" is, and three copies of 0.15 would
 * eventually be three different numbers.
 *
 * All luma/warmth/sharpness values are the ledger's normalised 0..1 (or −1..1) units, not
 * camera units, so these read as fractions of full scale.
 */
export const PICTURE_FLAG_THRESHOLDS = {
  /**
   * |Δ mean luma| above which a cut reads as an exposure jump. 0.15 of full scale is
   * roughly a stop and a half on an 8-bit Rec.709 curve — the point at which an audience
   * sees a brightness change rather than a shot change, and the point at which
   * `normalize_exposure` has something worth fixing. Below it, two shots of the same
   * scene under one light differ by more than this only rarely.
   */
  exposureJump: 0.15,
  /**
   * |Δ warmth| above which a cut reads as a white-balance error. Warmth is (V−U)
   * normalised to −1..1 and calibrated so a neutral chart reads 0, so the whole legal
   * range is 2.0 wide; 0.25 is ~12% of it, about the distance between daylight and a
   * warm indoor preset. Wider than the exposure threshold on purpose: skin tone and
   * wardrobe move warmth around inside one setting, and a false `wb_jump` would send the
   * agent grading footage that is already correct.
   */
  wbJump: 0.25,
  /**
   * |Δ steps| on `SHOT_SIZE_LADDER` at which a size change stops reading as
   * coverage and starts reading as a jump. 3 is the classic "change the size by at least
   * two, and the angle" rule with one step of slack: MS→CU (2) is ordinary coverage,
   * MS→EWS (3) is a deliberate move the agent should be able to name.
   */
  sizeSteps: 3,
  /**
   * Hamming distance between two 64-bit dHashes at or below which the frames are treated
   * as the same picture. 6/64 is the value the ledger itself uses for `duplicateOf`
   * (`ledger.ts`), and re-deriving it here with a different number would let a shot be a
   * duplicate in one place and not in another.
   */
  duplicatePhashHamming: 6,
  /**
   * Asset-time discontinuity, in seconds, under which a cut between two near-identical
   * frames of the SAME asset is a jump cut rather than a legitimate return to a location.
   * 2 s is short enough that the removed material is a pause or a stumble (which is what
   * silence removal and tightening produce, the two operations that manufacture jump
   * cuts) and long enough to catch a whole excised sentence. Beyond it, the same framing
   * is a considered return, not an artifact.
   */
  jumpCutAssetGapSeconds: 2,
  /**
   * Sharpness below which an incoming shot reads as soft. Sharpness is
   * `1 − normalised blurdetect median`, so 0.35 sits well under handheld softness and
   * catches only genuine focus misses and motion smear — the false-positive cost is high
   * because "your footage is soft" is an accusation about the user's camerawork.
   */
  softSharpness: 0.35,
} as const;

/**
 * Frame rate assumed when deriving the "edges touch" tolerance and none is supplied.
 * A {@link ProjectIndex} carries no `fps` (it indexes the timeline, not the document), so
 * callers that have the `Project` should pass its `fps` — {@link pictureFor} does. 30 is the
 * project-template default and the tolerance is a snapping allowance, not a measurement:
 * being one 30th of a second generous about what "touching" means never changes which pairs
 * are neighbours in practice, it only forgives float drift left by a trim.
 */
export const DEFAULT_CUT_FPS = 30;

/** Motion classes as an ordered ladder, calm to busy — the only place the order is stated. */
const MOTION_ORDER: readonly MotionClass[] = ['static', 'slow', 'handheld', 'fast'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The facts known about one shot, provenance intact.
 *
 * `plan/visual-understanding/01-ARCHITECTURE.md` §6 names this type but never defines it;
 * this is it. Each tier is `null` when it has not run — the {@link ShotRecord} shape with
 * `nullish` collapsed to `null` so consumers have one absence value to test.
 */
export interface ShotFacts {
  /** `shotKey(record)` — stable across runs and caches. */
  readonly shotKey: string;
  readonly assetId: string;
  readonly contentHash: string;
  readonly shotIndex: number;
  /** ASSET seconds, inclusive. */
  readonly t0: number;
  /** ASSET seconds, exclusive. */
  readonly t1: number;
  /** A duration split inside one continuous take, not a scene cut. */
  readonly splitOf: boolean;
  readonly measured: MeasuredFacts | null;
  readonly labelled: LabelledFacts | null;
  readonly described: DescribedFacts | null;
}

/** One shot as it appears on the timeline: the facts plus the span they occupy there. */
export interface PictureShotSpan {
  readonly shotKey: string;
  /** TIMELINE seconds. */
  readonly tStart: number;
  /** TIMELINE seconds. */
  readonly tEnd: number;
  readonly facts: ShotFacts;
}

/** A picture clip (video or image) joined to what it shows. */
export interface PictureClip {
  readonly clipId: string;
  readonly trackId: string;
  /** TIMELINE seconds. */
  readonly start: number;
  /** TIMELINE seconds. */
  readonly end: number;
  readonly assetId: string;
  /** Shots this clip shows, in timeline order. Empty when the ledger knows nothing. */
  readonly shots: readonly PictureShotSpan[];
  /**
   * The shot covering the most timeline time of this clip, or `null` when the clip has no
   * ledger rows. §6 types this non-nullable; it cannot be, because a clip whose asset has
   * never been measured has no dominant shot and inventing one would fabricate facts.
   */
  readonly dominant: ShotFacts | null;
}

/** Which way the busier side of a cut lies. `null` when either side is unmeasured. */
export type MotionChange = 'none' | 'up' | 'down';

/**
 * How far apart the two sides of a cut are. Every number is signed **to − from**, so a
 * positive `luma` means the cut gets brighter and a positive `shotSizeSteps` means it gets
 * tighter. `null` is "the tier that answers this has not run", never "no difference".
 */
export interface CutDelta {
  /** Δ mean luma, 0..1 scale. */
  readonly luma: number | null;
  /** Δ warmth, −1..1 scale. */
  readonly warmth: number | null;
  /** Δ mean saturation. */
  readonly sat: number | null;
  /** Δ contrast index (p90 − p10 of luma). */
  readonly contrast: number | null;
  /** Signed steps on the shot-size ladder, −6..6; positive is tighter. */
  readonly shotSizeSteps: number | null;
  /** Whether both sides were labelled with the same setting. */
  readonly sameSetting: boolean | null;
  /** Entity ids present on both sides (tier 1). Empty when either side is unlabelled. */
  readonly sameEntities: readonly string[];
  readonly motionChange: MotionChange | null;
  /** phash Hamming ≤ 6 — the two sides show the same picture. */
  readonly duplicate: boolean | null;
  /** The existing transition effect kind sitting on this cut, if any. */
  readonly transition: string | null;
}

/** The flags a cut can raise. Thresholds in {@link PICTURE_FLAG_THRESHOLDS}. */
export type PictureCutFlag =
  'exposure_jump' | 'wb_jump' | 'jump_cut' | 'size_jump' | 'black_in' | 'soft_in';

/** Two touching picture clips on one layer, and what changes across the join. */
export interface PictureCut {
  readonly fromClipId: string;
  readonly toClipId: string;
  readonly trackId: string;
  /** TIMELINE seconds — the incoming clip's start. */
  readonly at: number;
  readonly delta: CutDelta;
  readonly flags: readonly PictureCutFlag[];
}

/** How many of the joined shots carry each tier. `total` counts distinct shots. */
export interface PictureCoverage {
  readonly measured: number;
  readonly labelled: number;
  readonly described: number;
  readonly total: number;
}

/** The derived picture projection of one project snapshot against one ledger snapshot. */
export interface PictureSlice {
  readonly clips: readonly PictureClip[];
  readonly cuts: readonly PictureCut[];
  readonly coverage: PictureCoverage;
}

const EMPTY_COVERAGE: PictureCoverage = { measured: 0, labelled: 0, described: 0, total: 0 };

// ---------------------------------------------------------------------------
// phash
// ---------------------------------------------------------------------------

/** Set bits per hex digit — a 16-entry table beats a popcount loop and is obviously right. */
const HEX_BIT_COUNTS: Readonly<Record<string, number>> = {
  '0': 0,
  '1': 1,
  '2': 1,
  '3': 2,
  '4': 1,
  '5': 2,
  '6': 2,
  '7': 3,
  '8': 1,
  '9': 2,
  a: 2,
  b: 3,
  c: 3,
  d: 3,
  e: 3,
  f: 4,
};

/**
 * Hamming distance between two dHashes stored as hex TEXT.
 *
 * Hex rather than a number because the hash is 64 bits and a JSON number is not
 * (`ledger.ts`: "a value a JSON number cannot hold"). Comparing nibble by nibble keeps the
 * whole 64 bits exact where `Number(...)` would silently round the low ones away.
 *
 * `null` when the two are not comparable — different lengths, or a non-hex character.
 * Unknown, not "far apart": a malformed hash must not be reported as a difference.
 */
export function phashHamming(a: string, b: string): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    const x = HEX_BIT_COUNTS[left[i] as string];
    const y = HEX_BIT_COUNTS[right[i] as string];
    if (x === undefined || y === undefined) return null;
    // XOR the two nibbles, then count the bits that differ.
    const diff =
      (Number.parseInt(left[i] as string, 16) ^ Number.parseInt(right[i] as string, 16)) & 0xf;
    distance += HEX_BIT_COUNTS[diff.toString(16)] as number;
  }
  return distance;
}

// ---------------------------------------------------------------------------
// Asset time -> timeline time
// ---------------------------------------------------------------------------

/** A half-open span in timeline seconds. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** True when the clip plays its source backwards (schema v15 / ADR 0090 reverse). */
function isReverse(clip: Clip): boolean {
  return !hasSpeedRamp(clip) && (clip.speed ?? 1) < 0;
}

/** True when the clip holds a single source frame (`speed === 0`). */
function isFreeze(clip: Clip): boolean {
  return !hasSpeedRamp(clip) && clip.speed === 0;
}

/**
 * Timeline seconds at which clip-relative source second `s` is on screen.
 *
 * The three cases are the three the schema allows, and each is the inverse of
 * `clipTimelineDuration`'s branch for it:
 * - a **speed curve** governs the mapping through its integral (`integrateRate`), which is
 *   the same arithmetic the validator and the render use, so a ramped clip's shots land
 *   where its frames actually land rather than where a constant-speed guess would put them;
 * - **reverse** consumes the source backwards, so the far end of the range is at the start;
 * - **constant speed** (including 1) is the plain division.
 *
 * A freeze frame has no such mapping and is handled by {@link projectAssetSpan} instead.
 */
function timelineAtSourceOffset(clip: Clip, s: number): number {
  if (hasSpeedRamp(clip)) return clip.start + integrateRate(clip.speedRamp ?? [], 0, s);
  const speed = Math.abs(clip.speed ?? 1);
  const span = clip.sourceEnd - clip.sourceStart;
  if (isReverse(clip)) return clip.start + (span - s) / speed;
  return clip.start + s / speed;
}

/**
 * Project an ASSET-time span onto `clip`'s timeline span, or `null` when the clip does not
 * show any of it.
 *
 * Trim is the clamp to `[sourceStart, sourceEnd)`; speed is
 * {@link timelineAtSourceOffset}. The result is clamped to the clip's own timeline bounds:
 * quadrature error and a hand-authored duration can both put the computed edge a hair
 * outside the clip, and a shot must never be reported as visible where its clip is not.
 *
 * Exported because it is the ONE source→timeline projection in the semantic index. The
 * `shots`, `silences`, `beats`, `loudness` and `black` slices used to carry their own flat
 * 1:1 version, which placed every time wrongly on a speed-changed or reversed clip; they
 * call this now (VU2.5). Adding a slice? Use this, never `start + (clip.start -
 * clip.sourceStart)`.
 */
export function projectAssetSpan(clip: Clip, t0: number, t1: number): Span | null {
  const from = Math.max(t0, clip.sourceStart);
  const to = Math.min(t1, clip.sourceEnd);
  if (to <= from) return null;

  // A freeze holds the frame at `sourceStart` for the whole clip: the span is visible if
  // and only if it contains that frame, and then it fills the clip.
  if (isFreeze(clip)) {
    return t0 <= clip.sourceStart && clip.sourceStart < t1
      ? { start: clip.start, end: clip.end }
      : null;
  }

  const a = timelineAtSourceOffset(clip, from - clip.sourceStart);
  const b = timelineAtSourceOffset(clip, to - clip.sourceStart);
  const start = Math.max(clip.start, Math.min(a, b));
  const end = Math.min(clip.end, Math.max(a, b));
  return end > start ? { start, end } : null;
}

/** ASSET seconds shown by the clip's first frame (its in-point, direction aware). */
function assetTimeAtClipStart(clip: Clip): number {
  return isReverse(clip) ? clip.sourceEnd : clip.sourceStart;
}

/** ASSET seconds shown by the clip's last frame (its out-point, direction aware). */
function assetTimeAtClipEnd(clip: Clip): number {
  if (isFreeze(clip)) return clip.sourceStart;
  return isReverse(clip) ? clip.sourceStart : clip.sourceEnd;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Flatten a {@link ShotRecord} into {@link ShotFacts} (nullish tiers collapsed to null). */
function factsOf(record: ShotRecord): ShotFacts {
  return {
    shotKey: shotKey(record),
    assetId: record.assetId,
    contentHash: record.contentHash,
    shotIndex: record.shotIndex,
    t0: record.t0,
    t1: record.t1,
    splitOf: record.splitOf,
    measured: record.measured ?? null,
    labelled: record.labelled ?? null,
    described: record.described ?? null,
  };
}

/** Group the ledger's shots by asset id, preserving order. */
function shotsByAsset(ledger: LedgerSnapshot | null | undefined): Map<string, ShotRecord[]> {
  const byAsset = new Map<string, ShotRecord[]>();
  for (const shot of ledger?.shots ?? []) {
    const bucket = byAsset.get(shot.assetId);
    if (bucket) bucket.push(shot);
    else byAsset.set(shot.assetId, [shot]);
  }
  return byAsset;
}

/** Join one picture clip to the shots it shows, in timeline order. */
function buildPictureClip(entry: ClipEntry, records: readonly ShotRecord[]): PictureClip {
  const { clip, track } = entry;
  const shots: PictureShotSpan[] = [];
  for (const record of records) {
    const span = projectAssetSpan(clip, record.t0, record.t1);
    if (!span) continue;
    const facts = factsOf(record);
    shots.push({ shotKey: facts.shotKey, tStart: span.start, tEnd: span.end, facts });
  }
  shots.sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);

  // Dominant = most timeline time on screen. Ties keep the earlier shot, so the choice is
  // deterministic and matches what an editor would call "the shot this clip is".
  let dominant: ShotFacts | null = null;
  let best = 0;
  for (const shot of shots) {
    const covered = shot.tEnd - shot.tStart;
    if (covered > best) {
      best = covered;
      dominant = shot.facts;
    }
  }

  return {
    clipId: clip.id,
    trackId: track.id,
    start: clip.start,
    end: clip.end,
    assetId: clip.assetId,
    shots,
    dominant,
  };
}

/** Δ of one measured scalar, or `null` when either side was not measured. */
function measuredDelta(
  from: MeasuredFacts | null,
  to: MeasuredFacts | null,
  read: (m: MeasuredFacts) => number,
): number | null {
  if (!from || !to) return null;
  return read(to) - read(from);
}

/** A tier-1 label's value when the model believed it, else `null`. */
function labelValue(label: { value: string; p: number } | null | undefined): string | null {
  return label ? label.value : null;
}

/** Signed shot-size distance across the cut, from tier 1 or tier 2, else `null`. */
function sizeStepsAcross(from: ShotFacts, to: ShotFacts): number | null {
  const a = shotSizeOf(from);
  const b = shotSizeOf(to);
  if (!a || !b) return null;
  return shotSizeSteps(a, b);
}

/**
 * A shot's framing: the tier-1 label first (it is the tier built to answer this), falling
 * back to the tier-2 caption's `camera.shotSize`. `null` when neither tier ran or the label
 * is not on the ladder — an off-ladder string is unknown, not an arbitrary rung.
 */
function shotSizeOf(facts: ShotFacts): ShotSize | null {
  const labelled = labelValue(facts.labelled?.shotSize);
  const described = facts.described?.camera.shotSize ?? null;
  const value = labelled ?? described;
  if (value === null) return null;
  return isShotSize(value) ? value : null;
}

/** Membership test for the ladder, derived from the ladder itself so the two cannot drift. */
const SHOT_SIZES: ReadonlySet<string> = new Set<string>(SHOT_SIZE_LADDER);

function isShotSize(value: string): value is ShotSize {
  return SHOT_SIZES.has(value);
}

/** Setting agreement across the cut: tier 1's label, else tier 2's `setting` string. */
function sameSettingAcross(from: ShotFacts, to: ShotFacts): boolean | null {
  const a = labelValue(from.labelled?.setting) ?? from.described?.setting ?? null;
  const b = labelValue(to.labelled?.setting) ?? to.described?.setting ?? null;
  if (a === null || b === null || a === '' || b === '') return null;
  return a === b;
}

/** Entity ids labelled on both sides of the cut. */
function sharedEntities(from: ShotFacts, to: ShotFacts): string[] {
  const before = new Set((from.labelled?.entities ?? []).map((e) => e.id));
  const shared: string[] = [];
  for (const entity of to.labelled?.entities ?? []) {
    if (before.has(entity.id) && !shared.includes(entity.id)) shared.push(entity.id);
  }
  return shared;
}

/** Which way motion moves across the cut, or `null` when either side is unmeasured. */
function motionChangeAcross(from: ShotFacts, to: ShotFacts): MotionChange | null {
  const a = from.measured?.motion.class;
  const b = to.measured?.motion.class;
  if (!a || !b) return null;
  const delta = MOTION_ORDER.indexOf(b) - MOTION_ORDER.indexOf(a);
  if (delta === 0) return 'none';
  return delta > 0 ? 'up' : 'down';
}

/** Whether the two sides show the same picture, or `null` when a phash is missing. */
function duplicateAcross(from: ShotFacts, to: ShotFacts): boolean | null {
  const a = from.measured?.phash;
  const b = to.measured?.phash;
  // `null` as well as `undefined`: the ledger records "no keyframe hash was computed" as a
  // real absence rather than a placeholder, precisely so it cannot be compared.
  if (a === undefined || a === null || b === undefined || b === null) return null;
  const distance = phashHamming(a, b);
  if (distance === null) return null;
  return distance <= PICTURE_FLAG_THRESHOLDS.duplicatePhashHamming;
}

/** The transition effect kind sitting on the incoming clip, if any. */
function transitionKindOf(index: ProjectIndex, clipId: string): string | null {
  for (const { effect } of index.effectsOf(clipId)) {
    if (effect.type !== 'transition') continue;
    const kind = (effect.params as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }
  return null;
}

/** The empty delta — every fact unknown. Used when either side has no ledger row at all. */
const UNKNOWN_DELTA: CutDelta = {
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
};

/** Derive the delta between the two dominant shots of a cut pair. */
function deltaAcross(index: ProjectIndex, from: PictureClip, to: PictureClip): CutDelta {
  const transition = transitionKindOf(index, to.clipId);
  const a = from.dominant;
  const b = to.dominant;
  if (!a || !b) return { ...UNKNOWN_DELTA, transition };
  return {
    luma: measuredDelta(a.measured, b.measured, (m) => m.luma.mean),
    warmth: measuredDelta(a.measured, b.measured, (m) => m.warmth),
    sat: measuredDelta(a.measured, b.measured, (m) => m.chroma.satMean),
    contrast: measuredDelta(a.measured, b.measured, (m) => m.contrastIdx),
    shotSizeSteps: sizeStepsAcross(a, b),
    sameSetting: sameSettingAcross(a, b),
    sameEntities: sharedEntities(a, b),
    motionChange: motionChangeAcross(a, b),
    duplicate: duplicateAcross(a, b),
    transition,
  };
}

/**
 * Raise the flags this cut earns.
 *
 * Every test is against a known value: a `null` delta raises nothing, which is the whole
 * point of typing them nullable. A cut the ledger cannot describe is silent, not clean.
 */
function flagsFor(
  delta: CutDelta,
  fromClip: PictureClip,
  toClip: PictureClip,
  fromEntry: ClipEntry,
  toEntry: ClipEntry,
): PictureCutFlag[] {
  const flags: PictureCutFlag[] = [];
  const t = PICTURE_FLAG_THRESHOLDS;

  if (delta.luma !== null && Math.abs(delta.luma) > t.exposureJump) flags.push('exposure_jump');
  if (delta.warmth !== null && Math.abs(delta.warmth) > t.wbJump) flags.push('wb_jump');
  if (delta.shotSizeSteps !== null && Math.abs(delta.shotSizeSteps) >= t.sizeSteps) {
    flags.push('size_jump');
  }

  // A jump cut is same-source material with the same framing and a short excision — what
  // silence removal and tightening manufacture. Different assets showing the same thing are
  // a match cut, not an artifact, so the asset ids must agree.
  if (delta.duplicate === true && fromClip.assetId === toClip.assetId) {
    const gap = Math.abs(assetTimeAtClipStart(toEntry.clip) - assetTimeAtClipEnd(fromEntry.clip));
    if (gap < t.jumpCutAssetGapSeconds) flags.push('jump_cut');
  }

  const incoming = toClip.dominant?.measured ?? null;
  if (incoming?.black === true) flags.push('black_in');
  if (incoming !== null && incoming.sharpness < t.softSharpness) flags.push('soft_in');

  return flags;
}

/** Count how many distinct joined shots carry each tier. */
function coverageOf(clips: readonly PictureClip[]): PictureCoverage {
  const seen = new Set<string>();
  let measured = 0;
  let labelled = 0;
  let described = 0;
  for (const clip of clips) {
    for (const shot of clip.shots) {
      if (seen.has(shot.shotKey)) continue;
      seen.add(shot.shotKey);
      if (shot.facts.measured) measured += 1;
      if (shot.facts.labelled) labelled += 1;
      if (shot.facts.described) described += 1;
    }
  }
  return { measured, labelled, described, total: seen.size };
}

/**
 * Derive the picture slice for one project snapshot and one ledger snapshot.
 *
 * Pure. Prefer {@link pictureFor}, which memoizes this per (index, ledger) pair and reads
 * the project's real `fps`.
 *
 * @param index - The project index for the snapshot (`indexFor`).
 * @param ledger - The ledger snapshot for the timeline's assets. `null`/`undefined` (no
 *   brain, no coverage, a malformed response `parseLedgerSnapshot` rejected) yields every
 *   picture clip with no shots and zero coverage.
 * @param fps - Frame rate used for the "edges touch" tolerance. Defaults to
 *   {@link DEFAULT_CUT_FPS}.
 */
export function derivePicture(
  index: ProjectIndex,
  ledger: LedgerSnapshot | null | undefined,
  fps: number = DEFAULT_CUT_FPS,
): PictureSlice {
  const byAsset = shotsByAsset(ledger);

  // Picture only: audio carries no picture and captions/text are drawn, not shot.
  const entries: ClipEntry[] = [];
  for (const entry of index.clipById.values()) {
    const kind = clipKindOf(entry.clip, index.assetById);
    if (kind === 'video' || kind === 'image') entries.push(entry);
  }

  const clips: PictureClip[] = [];
  const entryByClipId = new Map<string, ClipEntry>();
  for (const entry of entries) {
    entryByClipId.set(entry.clip.id, entry);
    clips.push(buildPictureClip(entry, byAsset.get(entry.clip.assetId) ?? []));
  }
  clips.sort((a, b) => a.trackId.localeCompare(b.trackId) || a.start - b.start || a.end - b.end);

  // Neighbours are per LAYER: two clips on different tracks are composited, not cut between,
  // however their edges line up.
  const byTrack = new Map<string, PictureClip[]>();
  for (const clip of clips) {
    const bucket = byTrack.get(clip.trackId);
    if (bucket) bucket.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }

  const tolerance = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / DEFAULT_CUT_FPS;
  const cuts: PictureCut[] = [];
  for (const [trackId, layer] of byTrack) {
    const ordered = [...layer].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const from = ordered[i] as PictureClip;
      const to = ordered[i + 1] as PictureClip;
      // "Touching": within one frame either way, so a butt join survives float drift and a
      // one-frame overlap left by a trim still reads as a cut — but a real gap does not.
      if (Math.abs(to.start - from.end) > tolerance) continue;
      const fromEntry = entryByClipId.get(from.clipId) as ClipEntry;
      const toEntry = entryByClipId.get(to.clipId) as ClipEntry;
      const delta = deltaAcross(index, from, to);
      cuts.push({
        fromClipId: from.clipId,
        toClipId: to.clipId,
        trackId,
        at: to.start,
        delta,
        flags: flagsFor(delta, from, to, fromEntry, toEntry),
      });
    }
  }
  cuts.sort((a, b) => a.at - b.at || a.trackId.localeCompare(b.trackId));

  return { clips, cuts, coverage: clips.length > 0 ? coverageOf(clips) : EMPTY_COVERAGE };
}

// ---------------------------------------------------------------------------
// Memoization — the same discipline as `semantic-index.ts`, one scheme only.
// ---------------------------------------------------------------------------

/**
 * Stand-in key for "no ledger". A WeakMap cannot key on `null`, and a Map would keep the
 * entry alive forever; one shared sentinel object costs nothing and keeps every cache level
 * weak on a real object identity.
 */
const NO_LEDGER: LedgerSnapshot = Object.freeze({
  shots: [],
  digests: [],
  coverage: { measured: 0, labelled: 0, described: 0, total: 0 },
});

/**
 * `ProjectIndex` → `LedgerSnapshot` → fps → slice.
 *
 * Both object levels are weak because both are immutable snapshots replaced wholesale when
 * their content changes: a trim yields a new `Project`, hence a new index, hence a miss on
 * exactly the projects that changed and a hit on every other. `fps` is a plain number so it
 * gets the innermost (bounded, per-index) Map. There is no invalidation path and nothing to
 * drift — the same argument `project-index.ts` and `semantic-index.ts` make.
 */
const pictureCache = new WeakMap<
  ProjectIndex,
  WeakMap<LedgerSnapshot, Map<number, PictureSlice>>
>();

/** The picture slice for `(index, ledger, fps)`, derived at most once per triple. */
export function pictureSliceFor(
  index: ProjectIndex,
  ledger: LedgerSnapshot | null | undefined,
  fps: number = DEFAULT_CUT_FPS,
): PictureSlice {
  const ledgerKey = ledger ?? NO_LEDGER;
  let byLedger = pictureCache.get(index);
  if (!byLedger) {
    byLedger = new WeakMap();
    pictureCache.set(index, byLedger);
  }
  let byFps = byLedger.get(ledgerKey);
  if (!byFps) {
    byFps = new Map();
    byLedger.set(ledgerKey, byFps);
  }
  const cached = byFps.get(fps);
  if (cached) return cached;
  const built = derivePicture(index, ledger, fps);
  byFps.set(fps, built);
  return built;
}

/**
 * The picture slice for a `Project` — the entry point callers with the document should use,
 * because it supplies the project's real `fps` for the touch tolerance.
 */
export function pictureFor(
  project: Project,
  index: ProjectIndex,
  ledger: LedgerSnapshot | null | undefined,
): PictureSlice {
  return pictureSliceFor(index, ledger, project.fps);
}
