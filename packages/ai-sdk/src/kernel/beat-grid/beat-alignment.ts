/**
 * @framepilot/ai-sdk/kernel/beat-grid/beat-alignment — the deterministic beat-grid
 * boundary rule for a beat-backed montage proposal.
 *
 * ## Where this runs (ADR 0132)
 *
 * `Orchestrator#applyAgentTurn`, which both turn loops and the repair pass funnel through.
 * It engages only when the run gathered beat evidence — the agent elected `detect_beats` —
 * and the raw payload is threaded per run through `applyAgentTurn`'s arguments (a box on
 * `HostCallContext.beatEvidence`), never held on the Orchestrator, which serves concurrent
 * runs.
 *
 * There is deliberately no beat-sync mode, flag, or request classifier: the MODEL decides
 * that the music matters by choosing to analyze it, and the RUNTIME then guarantees the
 * frame-accuracy that decision implies. A run that never asks about the music is untouched.
 *
 * Between the 9.5 Phase-1 convergence (which retired its only caller, the planned-edit graph
 * driver) and ADR 0132, no path enforced this rule at all. Note it was never a hard invariant
 * even before that: the planned-edit route only ran when the classifier chose it AND the
 * compiled plan passed the structural gate, and otherwise fell back to the agent with no
 * beat-snap.
 *
 * ## Why this exists as its own module
 *
 * The rule used to be a private assertion inside `plan-driver.ts` that rejected any
 * `add_clip` whose `start`/`end` was not within half a frame of a detected onset. It was
 * wrong in three separate directions at once, and every one of them was observed on a real
 * "cut on every drum hit" run:
 *
 *  1. **Unsatisfiable boundaries.** The rule applied to EVERY `add_clip`, including the
 *     music bed itself. A 30s song placed `0 → 30` can never be on-grid (an onset at
 *     exactly 30.000 essentially never exists), so a step that placed the music and cut
 *     the picture was a guaranteed dead end — `off-grid: 30`. The sequence's own last
 *     boundary had the same problem: a montage that fills to the end of the music was
 *     unrepresentable.
 *  2. **Silent non-enforcement exactly when it mattered.** The grid is derived by
 *     translating onsets through clips of the analyzed asset that are ALREADY on the
 *     timeline. When the music bed was placed by the same proposal, the grid was empty at
 *     validation time and the rule early-returned — so a uniform, off-beat montage was
 *     accepted without complaint. That is the "clips placed uniformly, not on the beat"
 *     bug: not a prompting failure, a validator that wasn't looking.
 *  3. **Reject-only, with no way back.** A boundary two frames off a real onset was fatal,
 *     and the rejection named the offending times but not the legal ones — so the bounded
 *     repair budget was spent re-guessing.
 *
 * ## The rule this module implements
 *
 * - Only **picture** boundaries are structural: `video`/`overlay` tracks. Audio and caption
 *   boundaries are exempt — a music bed's start/end are not editorial cuts, and a caption
 *   follows speech, not the drums.
 * - The sequence's **outer** boundaries are exempt only where the grid cannot speak: the
 *   earliest start when it falls before the first onset, and the latest end when it falls
 *   after the last one. That is what makes "open at 0" and "run to the end of the music"
 *   representable without weakening anything — an outer boundary sitting INSIDE the grid's
 *   range is still a cut against the music and is held to it, so a one-clip proposal cannot
 *   exempt itself into being unchecked.
 * - An interior boundary within {@link SNAP_WINDOW_SECONDS} of an onset is **snapped** to
 *   it rather than rejected: the runtime disposes, so a near-miss becomes frame-accurate
 *   sync instead of a wasted repair turn. Snapping is a pure function of the time value, so
 *   two clips sharing a boundary always land on the same onset and the sequence stays
 *   continuous.
 * - A boundary with no onset inside that window is rejected with the **nearest legal onset**
 *   named, which is what a correction turn actually needs.
 * - When the graph analyzed beats but neither the project nor the proposal places the
 *   analyzed asset, the grid is unknowable and the proposal is rejected as ungrounded — the
 *   old silent pass is gone. Nothing here ever fabricates an onset.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';

const log = createLogger('ai-sdk:kernel:beat-alignment');

/**
 * How far off a detected onset an interior boundary may be and still be snapped rather than
 * rejected. ~80ms is inside the window where a cut still reads as "on the hit" to a viewer,
 * and comfortably below the ~150ms spacing of consecutive drum hits at a fast tempo, so a
 * snap can never cross into the neighbouring onset.
 */
export const SNAP_WINDOW_SECONDS = 0.08;

/** How many off-grid boundaries a rejection names before summarising the rest. */
const REPORTED_MISS_LIMIT = 6;

/** Track types whose clip boundaries are perceived as montage cuts. */
const PICTURE_TRACK_TYPES: ReadonlySet<string> = new Set(['video', 'overlay']);

/** The outcome of applying the grid rule to one proposal. */
export type BeatAlignmentResult =
  | {
      readonly ok: true;
      /** The proposal, with interior near-miss boundaries snapped onto real onsets. */
      readonly operations: readonly AnyOperation[];
      /** How many boundaries were snapped — for tracing, never for user-facing claims. */
      readonly snapped: number;
    }
  | { readonly ok: false; readonly error: string };

/** A time value belonging to one operation, and how to write a new value back. */
interface Boundary {
  readonly time: number;
  readonly operationIndex: number;
  readonly field: 'start' | 'end' | 'at';
}

/** Read `{ assetId }` off a raw `detect_beats` payload. */
function readAnalyzedAssetId(payload: unknown): string | undefined {
  const record = (payload ?? {}) as Record<string, unknown>;
  return typeof record.assetId === 'string' && record.assetId.length > 0
    ? record.assetId
    : undefined;
}

/** Read the onset times off a raw `detect_beats` payload (`beats: [{ time }]`). */
function readOnsetTimes(payload: unknown): readonly number[] {
  const record = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(record.beats) ? record.beats : [];
  const times: number[] = [];
  for (const row of rows) {
    const time = (row as Record<string, unknown> | null)?.time;
    if (typeof time === 'number' && Number.isFinite(time) && time >= 0) times.push(time);
  }
  return times;
}

/**
 * Translate the analyzed asset's onsets into timeline time using a placement the PROPOSAL
 * itself declares — the case the old rule could not see. An `add_clip` plays its source at
 * 1x (the registry derives `sourceEnd` from the timeline span), so an onset inside the
 * trimmed source window maps to `start + (onset - sourceStart)`.
 */
function gridFromProposedPlacement(
  operations: readonly AnyOperation[],
  assetId: string,
  onsets: readonly number[],
): readonly number[] {
  const times: number[] = [];
  for (const operation of operations) {
    if (operation.type !== 'add_clip' || operation.assetId !== assetId) continue;
    for (const onset of onsets) {
      if (onset < operation.sourceStart || onset >= operation.sourceEnd) continue;
      times.push(operation.start + (onset - operation.sourceStart));
    }
  }
  return sortedUnique(times);
}

/** Sort ascending and drop exact duplicates, so "nearest onset" is well defined. */
function sortedUnique(times: readonly number[]): readonly number[] {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted.filter((time, index) => index === 0 || time !== sorted[index - 1]);
}

/**
 * Resolve the grid this proposal must align to.
 *
 * `projectGrid` is the timeline-time grid the Semantic Index already derived from clips of
 * the analyzed asset that are on the timeline. When it is empty, the analyzed asset is not
 * placed yet — so the grid is recovered from a placement inside the proposal, and when
 * there is none either, the caller gets an honest rejection instead of a silent pass.
 */
function resolveGrid(
  projectGrid: readonly number[] | undefined,
  rawBeats: unknown,
  operations: readonly AnyOperation[],
): { readonly grid: readonly number[] } | { readonly error: string } {
  if (projectGrid && projectGrid.length > 0) return { grid: sortedUnique(projectGrid) };
  const onsets = readOnsetTimes(rawBeats);
  const assetId = readAnalyzedAssetId(rawBeats);
  if (onsets.length === 0 || !assetId) {
    // Beat detection ran but returned nothing usable (silent footage, a failed analysis).
    // There is no grid to hold anyone to, and inventing one would be a fabricated edit.
    return { grid: [] };
  }
  const fromProposal = gridFromProposedPlacement(operations, assetId, onsets);
  if (fromProposal.length > 0) return { grid: fromProposal };
  return {
    error:
      `this step cuts to detected beats, but the analyzed audio asset "${assetId}" is not on ` +
      'the timeline and this proposal does not place it, so no boundary can be checked ' +
      'against a real onset. Place the music on an audio track in this same proposal (or in ' +
      'an earlier step) and cut the picture to its onsets.',
  };
}

/** Index every track id → type, and every existing clip id → its track type. */
function trackTypeLookups(project: Project): {
  readonly byTrackId: ReadonlyMap<string, string>;
  readonly byClipId: ReadonlyMap<string, string>;
} {
  const byTrackId = new Map<string, string>();
  const byClipId = new Map<string, string>();
  for (const track of project.timeline.tracks) {
    byTrackId.set(track.id, track.type);
    for (const clip of track.clips) byClipId.set(clip.id, track.type);
  }
  return { byTrackId, byClipId };
}

/**
 * Collect the boundaries the grid rule governs: `add_clip` spans, `trim_clip` spans, and
 * `split_clip` points, restricted to picture tracks. A `split_clip` cut point is always
 * interior by construction — it sits inside an existing clip — so it is never exempt.
 */
function structuralBoundaries(project: Project, operations: readonly AnyOperation[]): Boundary[] {
  const { byTrackId, byClipId } = trackTypeLookups(project);
  const isPicture = (type: string | undefined): boolean =>
    type !== undefined && PICTURE_TRACK_TYPES.has(type);
  const boundaries: Boundary[] = [];
  for (const [operationIndex, operation] of operations.entries()) {
    if (operation.type === 'add_clip') {
      if (!isPicture(byTrackId.get(operation.trackId))) continue;
      boundaries.push(
        { time: operation.start, operationIndex, field: 'start' },
        { time: operation.end, operationIndex, field: 'end' },
      );
      continue;
    }
    if (operation.type === 'trim_clip') {
      if (!isPicture(byClipId.get(operation.clipId))) continue;
      boundaries.push(
        { time: operation.start, operationIndex, field: 'start' },
        { time: operation.end, operationIndex, field: 'end' },
      );
      continue;
    }
    if (operation.type === 'split_clip') {
      if (!isPicture(byClipId.get(operation.clipId))) continue;
      boundaries.push({ time: operation.at, operationIndex, field: 'at' });
    }
  }
  return boundaries;
}

/** The nearest grid onset to `time` (the grid is non-empty at every call site). */
function nearestOnset(grid: readonly number[], time: number): number {
  let best = grid[0]!;
  for (const onset of grid) {
    if (Math.abs(onset - time) < Math.abs(best - time)) best = onset;
  }
  return best;
}

/** Round for a message a model reads back: enough precision to copy, not a float dump. */
function readable(time: number): string {
  return time.toFixed(3);
}

/** Write a snapped time back onto one operation, keeping the clip internally consistent. */
function withSnappedTime(operation: AnyOperation, field: Boundary['field'], time: number) {
  if (operation.type === 'add_clip') {
    const next = { ...operation, [field]: time } as typeof operation;
    // `add_clip` plays at 1x, so the source window must follow the timeline span it was
    // derived from — otherwise a snapped boundary silently changes the clip's speed.
    return { ...next, sourceEnd: next.sourceStart + (next.end - next.start) };
  }
  return { ...operation, [field]: time } as typeof operation;
}

/**
 * Apply the beat-grid rule to one proposal (see the module doc for the rule itself).
 *
 * @param project - The project the proposal is being validated against (supplies `fps`,
 *   track types, and existing clip ids).
 * @param operations - The proposed operations, already registry-validated.
 * @param projectGrid - The timeline-time onset grid the Semantic Index derived, if any.
 * @param rawBeats - The raw `detect_beats` payload, used to recover the grid when the music
 *   bed is placed by this same proposal.
 * @returns The proposal with interior near-misses snapped, or an actionable rejection.
 */
export function alignBeatBackedBoundaries(
  project: Project,
  operations: readonly AnyOperation[],
  projectGrid: readonly number[] | undefined,
  rawBeats: unknown,
): BeatAlignmentResult {
  const resolved = resolveGrid(projectGrid, rawBeats, operations);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const grid = resolved.grid;
  if (grid.length === 0) return { ok: true, operations, snapped: 0 };

  const boundaries = structuralBoundaries(project, operations);
  if (boundaries.length === 0) return { ok: true, operations, snapped: 0 };

  const onGridTolerance = 0.5 / project.fps;
  const firstOnset = grid[0]!;
  const lastOnset = grid[grid.length - 1]!;

  // The sequence's head and tail are editorial, not rhythmic — but only where the grid has
  // nothing to say. A montage may open before the first onset and run past the last one (to
  // the end of the music); a head or tail that lands INSIDE the grid's range is a cut
  // against the music like any other.
  const spans = boundaries.filter((b) => b.field !== 'at');
  const times = spans.map((b) => b.time);
  const earliestStart = times.length > 0 ? Math.min(...times) : undefined;
  const latestEnd = times.length > 0 ? Math.max(...times) : undefined;
  const isExemptOuter = (boundary: Boundary): boolean => {
    if (boundary.field === 'at') return false;
    if (boundary.time === earliestStart && boundary.time < firstOnset - onGridTolerance) {
      return true;
    }
    return boundary.time === latestEnd && boundary.time > lastOnset + onGridTolerance;
  };

  const next = [...operations];
  const misses: { readonly time: number; readonly nearest: number }[] = [];
  let snapped = 0;

  for (const boundary of boundaries) {
    if (isExemptOuter(boundary)) continue;
    const nearest = nearestOnset(grid, boundary.time);
    const delta = Math.abs(nearest - boundary.time);
    if (delta <= onGridTolerance) continue;
    if (delta > SNAP_WINDOW_SECONDS) {
      misses.push({ time: boundary.time, nearest });
      continue;
    }
    next[boundary.operationIndex] = withSnappedTime(
      next[boundary.operationIndex]!,
      boundary.field,
      nearest,
    );
    snapped += 1;
  }

  if (misses.length > 0) {
    const shown = misses
      .slice(0, REPORTED_MISS_LIMIT)
      .map((miss) => `${readable(miss.time)} (nearest detected onset ${readable(miss.nearest)})`);
    const omitted = misses.length - shown.length;
    log.warn('alignBeatBackedBoundaries → rejected off-grid boundaries', {
      misses: misses.length,
      gridSize: grid.length,
    });
    return {
      ok: false,
      error:
        'every interior picture cut in a beat-backed montage must land on a detected onset. ' +
        `Off-grid: ${shown.join('; ')}${omitted > 0 ? `; plus ${String(omitted)} more` : ''}. ` +
        'Replace each with the detected onset time exactly as supplied — do not round or ' +
        "interpolate. Only the sequence's own opening (before the first onset) and its " +
        'final end (after the last onset) may sit off-grid; audio and caption boundaries ' +
        'are never checked.',
    };
  }

  // Two onsets can sit closer together than one frame, and a snap can pull a short span
  // shorter still. Either way the result is a picture cut nobody can see, so report it
  // rather than emitting a clip the timeline would reject or render as a single frame.
  const governed = new Set(boundaries.map((boundary) => boundary.operationIndex));
  const collapsed = [...governed].filter((index) => {
    const operation = next[index]!;
    return (
      (operation.type === 'add_clip' || operation.type === 'trim_clip') &&
      operation.end - operation.start < 1 / project.fps
    );
  });
  if (collapsed.length > 0) {
    return {
      ok: false,
      error:
        `${String(collapsed.length)} picture clip(s) are shorter than one frame once their ` +
        'boundaries sit on real onsets. Use a wider pair of onsets for those cuts — ' +
        'consecutive onsets can be closer together than a single frame.',
    };
  }

  if (snapped > 0) {
    log.action('alignBeatBackedBoundaries → snapped interior cuts onto onsets', {
      snapped,
      boundaries: boundaries.length,
    });
  }
  return { ok: true, operations: next, snapped };
}
