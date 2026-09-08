/**
 * The picture slice, in the shapes tool results return it in (VU2.5).
 *
 * ## Why this exists
 *
 * `kernel/semantic-index/picture.ts` already joins every clip to the shots it shows and
 * derives the deltas across every cut. Until now only the context builder read it, so the
 * facts reached the model as prose in a clip row and nowhere else: a tool result — the one
 * place a model looks when it has decided to *act* on a specific clip — still carried
 * geometry only (ADR 0175, "The timeline slice carries geometry only").
 *
 * This module is the adapter between that slice and the tool surfaces. It does not derive
 * anything: every number here comes out of `picture.ts`, every word out of
 * `kernel/context/shot-words.ts`, and every measurement out of the ledger or a
 * `measure_color` evidence entry. Nothing is invented, and an absent tier is `null` rather
 * than a neutral value — the third rule the ledger enforces.
 *
 * ## Time bases, stated once and repeated in every payload
 *
 * A shot's own `t0`/`t1` are **asset seconds**; the span it occupies is **timeline
 * seconds**. Those are two different clocks and a result that prints both without saying
 * which is which is worse than one that prints neither, so the field names carry the base
 * (`assetStart`/`assetEnd` vs `start`/`end`) and every block states `timeBase`.
 */
import type { Project } from '@framepilot/timeline-schema';
import type { ColorMeasurement as SolverMeasurement } from '@framepilot/editor-core';
import type { ToolContext } from '../tool-context.js';
import { indexFor } from '../project-index.js';
import {
  type PictureClip,
  type PictureCut,
  type PictureSlice,
  pictureFor,
} from '../kernel/semantic-index/picture.js';
import { shotWords } from '../kernel/context/shot-words.js';
import {
  ColorMeasurementSchema,
  type ColorMeasurement as EvidenceMeasurement,
} from '../color-evidence.js';

// ---------------------------------------------------------------------------
// The slice
// ---------------------------------------------------------------------------

/**
 * The picture slice for a tool call's project and ledger.
 *
 * Memoized upstream per `(index, ledger, fps)`, so calling this once per tool call — or
 * once per clip in a loop — costs one map lookup after the first.
 */
export function pictureOf(ctx: ToolContext): PictureSlice {
  return pictureFor(ctx.project, indexFor(ctx.project), ctx.ledger ?? null);
}

/** The picture clip for one clip id, or `undefined` when it is not a picture clip. */
export function pictureClipOf(slice: PictureSlice, clipId: string): PictureClip | undefined {
  return slice.clips.find((clip) => clip.clipId === clipId);
}

/** Cuts keyed `from>to`, so a boundary listing can join to its measured delta in O(1). */
export function cutIndexOf(slice: PictureSlice): ReadonlyMap<string, PictureCut> {
  return new Map(slice.cuts.map((cut) => [cutKey(cut.fromClipId, cut.toClipId), cut]));
}

/**
 * Does this cut carry any fact at all?
 *
 * A cut between two unmeasured clips still EXISTS in the picture slice — the geometry is
 * known even when the pixels are not — and its delta is an object of nulls. Printing that
 * on every boundary of a long-form sequence spends tokens saying "unknown" seven times,
 * so the boundary listing omits it and lets absence mean absence.
 */
export function cutHasFacts(cut: PictureCut): boolean {
  if (cut.flags.length > 0) return true;
  return Object.values(cut.delta).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== null,
  );
}

/** The key {@link cutIndexOf} stores a cut under. */
export function cutKey(fromClipId: string, toClipId: string): string {
  return `${fromClipId}>${toClipId}`;
}

/**
 * Median duration of the picture clips on one layer, in seconds — the "pacing" the
 * transition policy clamps its durations against.
 *
 * Read off the picture slice rather than the raw timeline because the slice already knows
 * which clips carry a picture: audio beds and caption tracks have no bearing on how long a
 * dissolve should be. A layer with no picture clips returns 0, which
 * `chooseTransition` reads as "unknown" and answers with its nominal shot length.
 */
export function pacingOf(slice: PictureSlice, trackId?: string): number {
  const durations = slice.clips
    .filter((clip) => trackId === undefined || clip.trackId === trackId)
    .map((clip) => clip.end - clip.start)
    .filter((duration) => Number.isFinite(duration) && duration > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return 0;
  const middle = Math.floor(durations.length / 2);
  if (durations.length % 2 === 1) return durations[middle] ?? 0;
  return ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------
// The result shapes
// ---------------------------------------------------------------------------

/**
 * One shot's facts as a tool returns them.
 *
 * Grouped by tier, exactly as the ledger stores them, because provenance is the difference
 * between "the camera moved" (measured, certain) and "this is a wide shot" (labelled,
 * probabilistic) — and a flattened payload throws that away. Every label keeps its `p`.
 */
export interface ShotFactsView {
  readonly shotKey: string;
  readonly assetId: string;
  readonly shotIndex: number;
  /** ASSET seconds, inclusive. */
  readonly assetStart: number;
  /** ASSET seconds, exclusive. */
  readonly assetEnd: number;
  /** A duration split inside one continuous take, not a scene cut. */
  readonly splitOf: boolean;
  /** The row words the model already sees in the timeline slice — `''` when nothing is known. */
  readonly words: string;
  readonly measured: MeasuredView | null;
  readonly labelled: LabelledView | null;
  readonly described: DescribedView | null;
}

/** Tier 0, trimmed to the fields a decision reads. Numbers, because a solver reads these. */
export interface MeasuredView {
  readonly lumaMean: number;
  readonly lumaP10: number;
  readonly lumaP90: number;
  readonly warmth: number;
  readonly satMean: number;
  readonly contrastIdx: number;
  readonly motion: string;
  readonly sharpness: number;
  readonly black: boolean;
  readonly freeze: boolean;
}

/** Tier 1, confidences intact. */
export interface LabelledView {
  readonly shotSize: { readonly value: string; readonly p: number } | null;
  readonly subjectKind: { readonly value: string; readonly p: number } | null;
  readonly setting: { readonly value: string; readonly p: number } | null;
  readonly screenContent: { readonly value: string; readonly p: number } | null;
  readonly faces: number;
  readonly entities: readonly { readonly id: string; readonly kind: string; readonly p: number }[];
  readonly duplicateOf: string | null;
}

/** Tier 2 — the structured caption, not prose about it. */
export interface DescribedView {
  readonly summary: string;
  readonly subject: string;
  readonly action: string;
  readonly setting: string;
  readonly mood: string;
  readonly onScreenText: readonly string[];
  readonly camera: { readonly shotSize: string | null; readonly movement: string | null };
  readonly p: number;
}

/** One shot as it sits on the timeline. `start`/`end` are TIMELINE seconds. */
export interface ShotSpanView {
  readonly shotKey: string;
  readonly start: number;
  readonly end: number;
  readonly facts: ShotFactsView;
}

/** The `picture` block a clip read returns. */
export interface PictureBlockView {
  /** Says which clock the span fields use, on every payload that has one. */
  readonly timeBase: 'timeline seconds; assetStart/assetEnd are asset seconds';
  readonly dominant: ShotFactsView | null;
  readonly shotCount: number;
  /** Present only on the deep read (`get_clip`); the listing carries the dominant alone. */
  readonly shots?: readonly ShotSpanView[];
}

function confidentView(
  value: { value: string; p: number } | null | undefined,
): { value: string; p: number } | null {
  return value ? { value: value.value, p: value.p } : null;
}

/** Project one shot's ledger record onto the view. Pure; no rounding, no invention. */
export function shotFactsView(facts: PictureClip['dominant']): ShotFactsView | null {
  if (!facts) return null;
  const measured = facts.measured;
  const labelled = facts.labelled;
  const described = facts.described;
  return {
    shotKey: facts.shotKey,
    assetId: facts.assetId,
    shotIndex: facts.shotIndex,
    assetStart: facts.t0,
    assetEnd: facts.t1,
    splitOf: facts.splitOf,
    words: shotWords(facts),
    measured: measured
      ? {
          lumaMean: measured.luma.mean,
          lumaP10: measured.luma.p10,
          lumaP90: measured.luma.p90,
          warmth: measured.warmth,
          satMean: measured.chroma.satMean,
          contrastIdx: measured.contrastIdx,
          motion: measured.motion.class,
          sharpness: measured.sharpness,
          black: measured.black,
          freeze: measured.freeze,
        }
      : null,
    labelled: labelled
      ? {
          shotSize: confidentView(labelled.shotSize),
          subjectKind: confidentView(labelled.subjectKind),
          setting: confidentView(labelled.setting),
          screenContent: confidentView(labelled.screenContent),
          faces: labelled.faces,
          entities: labelled.entities.map((entity) => ({
            id: entity.id,
            kind: entity.kind,
            p: entity.p,
          })),
          duplicateOf: labelled.duplicateOf ?? null,
        }
      : null,
    described: described
      ? {
          summary: described.summary,
          subject: described.subject,
          action: described.action,
          setting: described.setting,
          mood: described.mood,
          onScreenText: described.onScreenText,
          camera: {
            shotSize: described.camera.shotSize ?? null,
            movement: described.camera.movement ?? null,
          },
          p: described.p,
        }
      : null,
  };
}

/**
 * The `picture` block for one clip, or `undefined` when the ledger knows nothing about it.
 *
 * `undefined` rather than an empty block on purpose: a key whose value is "nothing" costs
 * tokens on every row of a 200-clip listing and tells the model only what its absence
 * already told it.
 *
 * @param slice - The run's picture slice ({@link pictureOf}).
 * @param clipId - The clip to describe.
 * @param detail - `'full'` includes every joined shot span (the `get_clip` deep read);
 *   `'compact'` carries the dominant shot alone (the `get_clips` listing).
 */
export function pictureBlockFor(
  slice: PictureSlice,
  clipId: string,
  detail: 'full' | 'compact',
): PictureBlockView | undefined {
  const clip = pictureClipOf(slice, clipId);
  if (!clip || clip.shots.length === 0) return undefined;
  const dominant = shotFactsView(clip.dominant);
  const block: PictureBlockView = {
    timeBase: 'timeline seconds; assetStart/assetEnd are asset seconds',
    dominant,
    shotCount: clip.shots.length,
    ...(detail === 'full'
      ? {
          shots: clip.shots.map((span) => ({
            shotKey: span.shotKey,
            start: span.tStart,
            end: span.tEnd,
            // A span's facts are a full ShotFacts record, so the view is never null here.
            facts: shotFactsView(span.facts) as ShotFactsView,
          })),
        }
      : {}),
  };
  return block;
}

// ---------------------------------------------------------------------------
// Measurements for the solver
// ---------------------------------------------------------------------------

/** Where a colour measurement came from, and therefore how far it can be trusted. */
export type MeasurementProvenance =
  /** A `measure_color` scope render at this revision: the composite as it will export. */
  | 'rendered'
  /** The ledger's tier-0 pass: the UNGRADED source, so any grade already on the clip is not in it. */
  | 'ledger';

/** A measurement plus the provenance a tool must state when it reports what it did. */
export interface ResolvedMeasurement {
  readonly clipId: string;
  readonly measurement: SolverMeasurement;
  readonly provenance: MeasurementProvenance;
  /** True only for a rendered measurement the host found uncontaminated by another layer. */
  readonly occlusionFree: boolean;
}

/** BT.709 chroma divisors and the 8-bit scale `signalstats` reports U/V on. */
const BT709_CB_DIVISOR = 1.8556;
const BT709_CR_DIVISOR = 1.5748;
const CHROMA_8BIT_SCALE = 255;
const CHROMA_NEUTRAL = 128;
const CHROMA_HALF_RANGE = 128;

function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function channelStat(
  measurement: EvidenceMeasurement,
  channel: EvidenceMeasurement['samples'][number]['channel'],
  field: 'mean' | 'p10' | 'p90',
): number | undefined {
  return medianOf(
    measurement.samples
      .filter((sample) => sample.channel === channel)
      .map((sample) => sample[field])
      .filter((value): value is number => value !== undefined),
  );
}

/**
 * Convert a `measure_color` evidence payload into the solver's measurement shape.
 *
 * The evidence route measures RGB, luma and saturation; the solver reads luma, raw 8-bit
 * U/V and warmth. The conversion is the BT.709 forward transform — the exact inverse of
 * the one `color-solver.ts` documents — applied to the channel medians, so both sides of a
 * match that mixes an evidence reading with a ledger reading are on one scale.
 *
 * `undefined` when a whole-frame channel is missing: an incomplete reading must not be
 * completed with a zero, which reads as a black, desaturated shot.
 */
export function measurementFromEvidence(
  measurement: EvidenceMeasurement,
): SolverMeasurement | undefined {
  const lumaMean = channelStat(measurement, 'luma', 'mean');
  const lumaP10 = channelStat(measurement, 'luma', 'p10');
  const lumaP90 = channelStat(measurement, 'luma', 'p90');
  const red = channelStat(measurement, 'red', 'mean');
  const green = channelStat(measurement, 'green', 'mean');
  const blue = channelStat(measurement, 'blue', 'mean');
  const satMean = channelStat(measurement, 'saturation', 'mean');
  if (
    lumaMean === undefined ||
    lumaP10 === undefined ||
    lumaP90 === undefined ||
    red === undefined ||
    green === undefined ||
    blue === undefined ||
    satMean === undefined
  ) {
    return undefined;
  }
  // `green` participates through the luma the divisors are taken against, which is what
  // the measured `luma` channel already is — so it is read for completeness of the guard
  // above rather than used twice here.
  void green;
  const uMean = CHROMA_NEUTRAL + (CHROMA_8BIT_SCALE * (blue - lumaMean)) / BT709_CB_DIVISOR;
  const vMean = CHROMA_NEUTRAL + (CHROMA_8BIT_SCALE * (red - lumaMean)) / BT709_CR_DIVISOR;
  const warmth = Math.max(-1, Math.min(1, (vMean - uMean) / CHROMA_HALF_RANGE));
  return {
    luma: { mean: lumaMean, p10: lumaP10, p90: lumaP90 },
    chroma: { uMean, vMean, satMean },
    warmth,
    contrastIdx: lumaP90 - lumaP10,
  };
}

/** The ledger's tier-0 facts already ARE the solver's shape; this is the projection. */
function measurementFromLedger(clip: PictureClip | undefined): SolverMeasurement | undefined {
  const measured = clip?.dominant?.measured;
  if (!measured) return undefined;
  return {
    luma: {
      mean: measured.luma.mean,
      std: measured.luma.std,
      p10: measured.luma.p10,
      p90: measured.luma.p90,
    },
    chroma: measured.chroma,
    warmth: measured.warmth,
    contrastIdx: measured.contrastIdx,
  };
}

/** The revision a rendered measurement must carry to still describe this timeline. */
function currentRevision(project: Project, ctx: ToolContext): number {
  return ctx.projectRevision ?? project.timeline.revision ?? 0;
}

/**
 * The best colour measurement the run holds for one clip, and where it came from.
 *
 * Order, and why:
 *
 * 1. A `measure_color` result **from this run at this revision** — the composite measured
 *    through the deterministic render path, which is the only reading that includes the
 *    grades already on the clip.
 * 2. The ledger's tier-0 pass. Always available with no key and no network, and measured
 *    on the UNGRADED source: a clip that is already graded measures as if it were not, so
 *    the caller must say so rather than report the match as exact.
 *
 * `undefined` means nothing is known, which is a refusal with a remedy (`measure_color`),
 * never a grade solved against a default.
 */
export function measurementFor(
  ctx: ToolContext,
  slice: PictureSlice,
  clipId: string,
): ResolvedMeasurement | undefined {
  const revision = currentRevision(ctx.project, ctx);
  for (const entry of ctx.evidence?.entries?.() ?? []) {
    if (entry.source !== 'measure_color') continue;
    const parsed = ColorMeasurementSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    if (parsed.data.clipId !== clipId) continue;
    if (parsed.data.projectRevision !== revision) continue;
    const measurement = measurementFromEvidence(parsed.data);
    if (measurement === undefined) continue;
    return {
      clipId,
      measurement,
      provenance: 'rendered',
      occlusionFree: parsed.data.occlusionFree,
    };
  }
  const fromLedger = measurementFromLedger(pictureClipOf(slice, clipId));
  if (fromLedger === undefined) return undefined;
  return { clipId, measurement: fromLedger, provenance: 'ledger', occlusionFree: false };
}

/** The skin reading of a clip's rendered measurement, when the run has one. */
export function skinFor(
  ctx: ToolContext,
  clipId: string,
): { red: number; green: number; blue: number; coverage: number } | undefined {
  const revision = currentRevision(ctx.project, ctx);
  for (const entry of ctx.evidence?.entries?.() ?? []) {
    if (entry.source !== 'measure_color') continue;
    const parsed = ColorMeasurementSchema.safeParse(entry.data);
    if (!parsed.success || parsed.data.clipId !== clipId) continue;
    if (parsed.data.projectRevision !== revision) continue;
    const coverage = medianOf(
      parsed.data.samples
        .filter((sample) => sample.channel === 'skin_red')
        .map((sample) => sample.coverageRatio)
        .filter((value): value is number => value !== undefined),
    );
    const red = channelStat(parsed.data, 'skin_red', 'mean');
    const green = channelStat(parsed.data, 'skin_green', 'mean');
    const blue = channelStat(parsed.data, 'skin_blue', 'mean');
    if (coverage === undefined || red === undefined || green === undefined || blue === undefined) {
      return undefined;
    }
    return { red, green, blue, coverage };
  }
  return undefined;
}
