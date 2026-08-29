/**
 * @framepilot/ai-sdk/kernel/beat-grid/beat-evidence — what a run learned about the music,
 * and which of it the picture is actually cut against.
 *
 * ## Why this is a ledger and not a slot
 *
 * `HostCallContext.beatEvidence` used to be `{ current?: unknown }` — one field, written by
 * every settled `detect_beats`. Two independent things were wrong with that, and run
 * `ea8e46ec` hit both at once on a 61-photo beat-synced montage:
 *
 *  1. **It races.** `detect_beats` is a `pure_read`, so `tool-contract.ts` declares it
 *     `concurrency: 'parallel'` and a turn that analyses three tracks runs all three through
 *     `mapBounded`. Three writers, one field: the survivor is decided by completion order.
 *  2. **It cannot express the workflow.** Auditioning candidate tracks and picking one is
 *     what a music-video brief asks for in so many words. A run that compares three tracks
 *     has three analyses; a design that remembers one of them has already lost.
 *
 * In that run the surviving payload described *Epic Orchestral Adventure Theme* — the middle
 * of three parallel calls — while the editor placed *Skyline run* and cut to it. The grid
 * rule then rejected all six montage proposals for not placing an asset nobody had chosen,
 * and the run ended after 35 minutes with no picture on the timeline.
 *
 * Keying by `assetId` removes the race by construction: concurrent writes land on distinct
 * keys and commute, so the ledger does not depend on completion order. Re-analysing one
 * asset (a second `detect_beats` at a different sensitivity) replaces that asset's entry and
 * nothing else — "the grid the model is cutting to is the one it last saw", per asset.
 *
 * ## Why resolution lives here rather than in the boundary rule
 *
 * `beat-alignment.ts` answers "do these cuts land on the grid". That is a different question
 * from "which grid", and merging them is what produced the failure above: the rule read one
 * `assetId` off one payload and treated *that* asset's absence as the run's fault. Which
 * music the picture sits against is a fact about the project and the proposal, so it is
 * resolved from both — and only then handed to the rule.
 *
 * Resolution is deterministic end to end. Where several analysed beds are placed, the ranking
 * is by placed duration and then by `assetId`, never by iteration or completion order, so the
 * same project and proposal always resolve to the same grid.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';
import { beatGridFor } from '../semantic-index/semantic-index.js';
export { BEAT_ANALYSIS_TOOL } from './beat-tool.js';

const log = createLogger('ai-sdk:kernel:beat-evidence');

/**
 * Everything a run learned from `detect_beats`, keyed by the asset each analysis describes.
 *
 * Mutable and per-run (threaded through `HostCallContext`), never held on the Orchestrator,
 * which serves concurrent runs.
 */
export interface BeatEvidence {
  /** `assetId` → the latest raw `detect_beats` payload for that asset. */
  readonly analyses: Map<string, unknown>;
  /**
   * Did the run DECLARE that it is cutting hard to the grid (`detect_beats({ hardSync: true })`)?
   *
   * A run-level editorial declaration, not an analysis parameter, and sticky once set: a
   * later re-analysis at a different sensitivity does not change the intent. It is the
   * difference between a guarantee the run asked for and a policy imposed on it.
   */
  hardSync: boolean;
}

/** An empty ledger for one run. */
export function createBeatEvidence(): BeatEvidence {
  return { analyses: new Map(), hardSync: false };
}

/** Read `{ assetId }` off a raw `detect_beats` payload. */
export function readAnalyzedAssetId(payload: unknown): string | undefined {
  const record = (payload ?? {}) as Record<string, unknown>;
  return typeof record.assetId === 'string' && record.assetId.length > 0
    ? record.assetId
    : undefined;
}

/**
 * Read the onset times off a raw `detect_beats` payload (`beats: [{ time }]`).
 *
 * Prefers the onsets the engine marked as sitting on the tempo grid. An onset
 * detector answers "something happened here", and music routinely puts loud
 * events off the beat — so cutting on every onset is not cutting on the beat.
 * The mission's own fixture is the clean demonstration: it mixes a 0.6 s click
 * with a 1.0 s beep, and the detector correctly reports all 70 events. Snapping
 * to the 1.0 s beeps is what the `cuts-on-beats` rubric was scoring at 9/12.
 *
 * Falls back to every onset when nothing is marked — an older sidecar, or a
 * track with no derivable tempo. A grid of every onset is what this did before,
 * so the fallback is the previous behaviour rather than an empty grid.
 */
export function readOnsetTimes(payload: unknown): readonly number[] {
  const record = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(record.beats) ? record.beats : [];
  const times: number[] = [];
  const onGrid: number[] = [];
  for (const row of rows) {
    const beat = row as Record<string, unknown> | null;
    const time = beat?.time;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) continue;
    times.push(time);
    if (beat?.['on_grid'] !== false) onGrid.push(time);
  }
  return onGrid.length > 0 ? onGrid : times;
}

/**
 * File one settled `detect_beats` payload.
 *
 * A payload with no `assetId` is dropped rather than stored under a placeholder: the whole
 * point of the key is that it names the music, and an entry that cannot be matched against
 * the timeline would only ever resolve as ungrounded.
 *
 * @param evidence - The run's ledger.
 * @param payload - The raw tool payload.
 * @param hardSync - Whether THIS call declared hard sync (sticky for the run once true).
 */
export function recordBeatAnalysis(
  evidence: BeatEvidence,
  payload: unknown,
  hardSync: boolean,
): void {
  if (hardSync) evidence.hardSync = true;
  const assetId = readAnalyzedAssetId(payload);
  if (!assetId) {
    log.warn('recordBeatAnalysis → payload carries no assetId; not filed', {});
    return;
  }
  evidence.analyses.set(assetId, payload);
}

/** Has this run gathered any beat evidence at all? */
export function hasBeatEvidence(evidence: BeatEvidence | undefined): boolean {
  return evidence !== undefined && evidence.analyses.size > 0;
}

/** Which grid — if any — a proposal must be held to. */
export type ResolvedBeatGrid =
  /** The run never analysed any music, so the grid has no opinion about anything. */
  | { readonly kind: 'none' }
  /** The onsets, in timeline time, of the analysed bed this proposal sits against. */
  | {
      readonly kind: 'grid';
      readonly assetId: string;
      readonly times: readonly number[];
      /** Where the placement came from: already on the timeline, or in this proposal. */
      readonly source: 'timeline' | 'proposal';
    }
  /**
   * The run analysed music, but none of what it analysed is on the timeline or in this
   * proposal — so no boundary can be checked against a real onset.
   */
  | { readonly kind: 'ungrounded'; readonly analyzedAssetIds: readonly string[] };

/** One candidate placement of an analysed bed, with the tie-break key it is ranked on. */
interface Candidate {
  readonly assetId: string;
  readonly times: readonly number[];
  /** Total placed duration in seconds — the montage is cut against the dominant bed. */
  readonly placedSeconds: number;
}

/** Sort ascending and drop exact duplicates, so "nearest onset" is well defined. */
export function sortedUnique(times: readonly number[]): readonly number[] {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted.filter((time, index) => index === 0 || time !== sorted[index - 1]);
}

/**
 * Rank candidates deterministically: the longest-placed bed wins, `assetId` breaks ties.
 *
 * Never iteration order and never completion order — those are exactly what made the old
 * single slot depend on which of three concurrent analyses finished first.
 */
function best(candidates: readonly Candidate[]): Candidate | undefined {
  return [...candidates].sort(
    (a, b) => b.placedSeconds - a.placedSeconds || (a.assetId < b.assetId ? -1 : 1),
  )[0];
}

/** Total seconds of `assetId` placed on the timeline. */
function placedSecondsOnTimeline(project: Project, assetId: string): number {
  let total = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId === assetId) total += Math.max(0, clip.end - clip.start);
    }
  }
  return total;
}

/**
 * Translate an analysed asset's onsets into timeline time using a placement the PROPOSAL
 * itself declares — the case a timeline-only grid cannot see.
 *
 * An `add_clip` plays its source at 1x (the registry derives `sourceEnd` from the timeline
 * span), so an onset inside the trimmed source window maps to `start + (onset - sourceStart)`.
 */
function gridFromProposedPlacement(
  operations: readonly AnyOperation[],
  assetId: string,
  onsets: readonly number[],
): { readonly times: readonly number[]; readonly placedSeconds: number } {
  const times: number[] = [];
  let placedSeconds = 0;
  for (const operation of operations) {
    if (operation.type !== 'add_clip' || operation.assetId !== assetId) continue;
    placedSeconds += Math.max(0, operation.end - operation.start);
    for (const onset of onsets) {
      if (onset < operation.sourceStart || onset >= operation.sourceEnd) continue;
      times.push(operation.start + (onset - operation.sourceStart));
    }
  }
  return { times: sortedUnique(times), placedSeconds };
}

/**
 * Which grid this proposal must align to.
 *
 * Asked in the order that matches what an editor means by "cut to the music":
 *
 *  1. **An analysed bed already on the timeline.** The normal case once a montage is under
 *     way, and the case run `ea8e46ec` was in when it was told its music was absent.
 *  2. **An analysed bed this proposal places.** The step that drops the music and cuts the
 *     picture in one go — silently unchecked before the module handled it.
 *  3. **Neither.** Honestly ungrounded; nothing here ever fabricates an onset.
 *
 * @param project - The project the proposal is validated against.
 * @param evidence - The run's beat ledger.
 * @param operations - The proposed operations, already registry-validated.
 */
export function resolveBeatGrid(
  project: Project,
  evidence: BeatEvidence,
  operations: readonly AnyOperation[],
): ResolvedBeatGrid {
  const analyzed: { assetId: string; payload: unknown; onsets: readonly number[] }[] = [];
  for (const [assetId, payload] of evidence.analyses) {
    const onsets = readOnsetTimes(payload);
    // Beat detection that returned nothing usable (silent footage, a failed analysis) is
    // not a grid. Keeping it would let an empty analysis veto a montage.
    if (onsets.length > 0) analyzed.push({ assetId, payload, onsets });
  }
  if (analyzed.length === 0) return { kind: 'none' };

  const onTimeline: Candidate[] = [];
  for (const { assetId, payload } of analyzed) {
    const grid = beatGridFor(project, payload);
    if (!grid || grid.times.length === 0) continue;
    onTimeline.push({
      assetId,
      times: sortedUnique(grid.times),
      placedSeconds: placedSecondsOnTimeline(project, assetId),
    });
  }
  const placed = best(onTimeline);
  if (placed) {
    return {
      kind: 'grid',
      assetId: placed.assetId,
      times: placed.times,
      source: 'timeline',
    };
  }

  const proposed: Candidate[] = [];
  for (const { assetId, onsets } of analyzed) {
    const { times, placedSeconds } = gridFromProposedPlacement(operations, assetId, onsets);
    if (times.length > 0) proposed.push({ assetId, times, placedSeconds });
  }
  const inProposal = best(proposed);
  if (inProposal) {
    return {
      kind: 'grid',
      assetId: inProposal.assetId,
      times: inProposal.times,
      source: 'proposal',
    };
  }

  return {
    kind: 'ungrounded',
    analyzedAssetIds: analyzed.map((entry) => entry.assetId).sort(),
  };
}
