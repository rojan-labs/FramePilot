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
 * There is deliberately no beat-sync mode and no request classifier. The MODEL decides that
 * the music matters by choosing to analyze it, and — separately — decides whether it is
 * cutting HARD to the grid by declaring `hardSync` on `detect_beats`. A run that never asks
 * about the music is untouched.
 *
 * That second decision used to be made here, and it was the wrong place for it. Quantising
 * every interior cut is one legitimate style among several; "the model analyzed the music"
 * does not imply "the model wants every cut on an onset". In a captured run the editor's brief
 * asked for cuts on visual motion peaks — "so the edit is ready to beat-sync once music is
 * dropped in" — and four cuts were rejected for sitting 124ms and 215ms from an onset, after
 * which the delivered rhythm was the grid's rather than the one the brief described. The
 * runtime's job is to make the measurement unmissable and the accuracy free; whether a
 * few-frame offset matters *here* is editorial, and only the agent can answer it.
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
 * - A boundary with no onset inside that window is **reported with the nearest legal onset
 *   named** and left where the agent put it — unless the run declared `hardSync`, in which
 *   case it is rejected, which is what a correction turn then needs.
 * - A proposal that declares **no picture boundary at all** — crops, transforms, keyframes,
 *   transitions, text, gain — is outside the rule and passes untouched, whatever the state of
 *   the grid. Relevance is decided before groundedness, or the ungrounded report below
 *   becomes a turn-level veto over work the grid has no opinion about.
 * - When the run analyzed beats but none of what it analyzed is on the timeline or in the
 *   proposal, the grid is **ungrounded**: it is reported, and rejected only under `hardSync`.
 *   Nothing here ever fabricates an onset, and the old silent pass is still gone.
 *
 * ## Why ungrounded is a measurement and not a veto
 *
 * The `hardSync` split above is the module's governing rule: quantising every interior cut is
 * one legitimate style among several, so a cut the runtime cannot place on an onset is
 * MEASURED unless the run promised otherwise. The ungrounded branch used to be the one place
 * that rule was not applied — it rejected whatever the run had declared.
 *
 * That asymmetry is what deadlocked run `ea8e46ec`. Three tracks were auditioned in one turn,
 * the run's single-slot beat evidence kept an arbitrary one of them (see `beat-evidence.ts`),
 * the editor placed a different one, and every montage proposal after that was refused for
 * not placing an asset nobody had chosen. The run had never declared `hardSync`; it was held
 * to a promise it never made, and the tool that could have changed the runtime's mind
 * (`detect_beats`) was an `analysis` tool the execution stages withheld — six proposals, one
 * verbatim rejection, 35 minutes, no picture on the timeline. (That second half is now fixed
 * on its own terms: see `kernel/stage-policy.ts#VALIDATOR_INPUT_TOOL_NAMES`, which is what
 * keeps a refusal from ever again naming a remedy the run is forbidden to reach.)
 *
 * The rule stands regardless. A veto is a guarantee the run asked for, not a house style, so:
 * report by default; reject when — and only when — the run declared hard sync, where the
 * remedy (place the analyzed bed) is a mutation every execution stage offers.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { AnyOperation } from '@framepilot/editor-core';
import type { ResolvedBeatGrid } from './beat-evidence.js';

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
/** The refusal classes the beat grid can reach — the guard key, never the message. */
export type BeatRejectionKey = 'ungrounded' | 'off-grid' | 'sub-frame';

export type BeatAlignmentResult =
  | {
      readonly ok: true;
      /** The proposal, with interior near-miss boundaries snapped onto real onsets. */
      readonly operations: readonly AnyOperation[];
      /** How many boundaries were snapped — for tracing, never for user-facing claims. */
      readonly snapped: number;
      /**
       * Interior cuts that are DELIBERATELY off the grid — too far to snap, and allowed to
       * stand because the run never declared hard sync. Reported to the model (and through
       * it to the editor) as a measurement; absent when everything is on-grid.
       */
      readonly offGrid?: string;
      /**
       * The run analysed music, but none of it is placed — so these cuts were checked
       * against nothing. Reported rather than vetoed (see the module doc); absent when the
       * grid was resolvable. Never set together with {@link offGrid}: an unchecked cut has
       * no measured distance to report.
       */
      readonly ungrounded?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * The refusal's STABLE identity, free of the numbers that vary between attempts.
       *
       * `error` names the exact offending cuts, which is what the model needs in order to
       * fix them — and which made the run's repeated-rejection guard useless: in
       * `beat-sync` r1 twenty-nine consecutive turns were refused by this same rule, and
       * because the enumerated off-grid times differed each time, the sentences differed
       * and `conductor.ts#repeatedRejection` never matched. Twenty minutes and $3.93. The
       * specifics belong in the message; the identity belongs here.
       */
      readonly reasonKey: BeatRejectionKey;
      /**
       * HOW MUCH of the proposal this refusal is still refusing — the number of boundaries
       * that failed the rule, not a severity. Shrinks as the run fixes cuts.
       *
       * {@link reasonKey} says the run hit the same wall again; this says whether it is
       * getting through it. `beat-sync` r3 of `session6` was refused eleven times running
       * by `off-grid` while its off-grid count fell 12 → 10 → … → 4 → 2, and its twelfth
       * proposal was the one that landed 35 operations. Under `rejectionKey` alone every
       * one of those turns read as the same non-progress, the stall streak reached
       * `conductor.ts#STALL_CONFIRM_TURNS` at the eleventh, and the run stopped one turn before
       * the edit it was converging on (5 ops, score 0.56, against 40 ops and 1.00).
       *
       * Absent where the refusal has no size — `ungrounded` is "the analysed music is not
       * on the timeline", which is true or false and never partly fixed.
       */
      readonly reasonScale?: number;
    };

/** A time value belonging to one operation, and how to write a new value back. */
interface Boundary {
  readonly time: number;
  readonly operationIndex: number;
  readonly field: 'start' | 'end' | 'at';
}

/**
 * The sentence that explains an ungrounded grid, as a rejection or as a measurement.
 *
 * One text for both so the two can never drift into telling the model different stories
 * about the same state; only the surrounding verb changes.
 */
function ungroundedReason(analyzedAssetIds: readonly string[]): string {
  const one = analyzedAssetIds.length === 1;
  const named = analyzedAssetIds.map((id) => `"${id}"`).join(', ');
  return (
    `the analyzed audio ${one ? 'asset' : 'assets'} ${named} ${one ? 'is' : 'are'} not on ` +
    `the timeline and this proposal does not place ${one ? 'it' : 'any of them'}, so no ` +
    'boundary can be checked against a real onset. Put the music you are cutting to on an ' +
    'audio track, or run detect_beats on the music that IS on the timeline.'
  );
}

/**
 * Index every track id → type, and every existing clip id → its track type.
 *
 * The proposal's OWN `add_layer` operations are folded in, not just the tracks the
 * project already has. A turn may open a layer and put picture on it in the same patch —
 * `add_clip` does exactly that when a full-frame shot has to go in front of existing
 * footage (ADR 0169) — and a lookup that only knew the pre-turn timeline classified those
 * cuts as "not a picture track" and exempted the whole montage from the grid. Silent
 * non-enforcement exactly when it matters is failure mode 2 in this module's header; this
 * is the same mistake with a newer cause.
 */
function trackTypeLookups(
  project: Project,
  operations: readonly AnyOperation[],
): {
  readonly byTrackId: ReadonlyMap<string, string>;
  readonly byClipId: ReadonlyMap<string, string>;
} {
  const byTrackId = new Map<string, string>();
  const byClipId = new Map<string, string>();
  for (const track of project.timeline.tracks) {
    byTrackId.set(track.id, track.type);
    for (const clip of track.clips) byClipId.set(clip.id, track.type);
  }
  for (const operation of operations) {
    if (operation.type !== 'add_layer') continue;
    byTrackId.set(operation.layerId, operation.layerType);
    for (const clip of operation.clips ?? []) byClipId.set(clip.id, operation.layerType);
  }
  return { byTrackId, byClipId };
}

/**
 * Collect the boundaries the grid rule governs: `add_clip` spans, `trim_clip` spans, and
 * `split_clip` points, restricted to picture tracks. A `split_clip` cut point is always
 * interior by construction — it sits inside an existing clip — so it is never exempt.
 */
function structuralBoundaries(project: Project, operations: readonly AnyOperation[]): Boundary[] {
  const { byTrackId, byClipId } = trackTypeLookups(project, operations);
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
 * @param resolved - Which grid this proposal sits against, from
 *   {@link import('./beat-evidence.js').resolveBeatGrid}. Resolution is deliberately not
 *   done here: "which music" is a fact about the project and the proposal, and merging it
 *   into "do these cuts land" is what let one arbitrary payload veto a whole run.
 * @returns The proposal with interior near-misses snapped, or an actionable rejection.
 */
export function alignBeatBackedBoundaries(
  project: Project,
  operations: readonly AnyOperation[],
  resolved: ResolvedBeatGrid,
  /**
   * Did the run DECLARE that it is cutting hard to the grid (`detect_beats({ hardSync: true })`)?
   *
   * This is the difference between a guarantee and a policy. Quantising every interior cut is
   * one legitimate style among several, and a run that never asked for it was being held to it
   * anyway: in a captured run the editor's brief asked for cuts on visual motion peaks — "so
   * the edit is ready to beat-sync once music is dropped in" — and four cuts were rejected for
   * being 124ms and 215ms from an audio onset, after which the delivered rhythm was the grid's
   * rather than the one the brief described. The runtime's job is to make the measurement
   * unmissable; only the agent knows whether it matters here.
   */
  hardSync = false,
): BeatAlignmentResult {
  // WHAT THIS PROPOSAL EVEN PROPOSES, FIRST. The grid governs picture CUTS and nothing
  // else, so a proposal that declares no cut has nothing for the rule to hold it to — and
  // asking whether the grid is knowable before asking whether it is relevant made the
  // ungrounded rejection a turn-level veto over unrelated work. In the captured run a step
  // of eight `set_clip_crop` calls — the vertical reframe the editor had asked for, with no
  // boundary in it at all — was rejected with "the analyzed audio asset is not on the
  // timeline", because `detect_beats` had run earlier and the music bed had since been
  // removed. The reframe never landed, and the model learned to delete and re-place the
  // music on every step to appease a rule that was never about crops.
  const boundaries = structuralBoundaries(project, operations);
  if (boundaries.length === 0) return { ok: true, operations, snapped: 0 };

  if (resolved.kind === 'none') return { ok: true, operations, snapped: 0 };
  if (resolved.kind === 'ungrounded') {
    const reason = ungroundedReason(resolved.analyzedAssetIds);
    if (hardSync) {
      log.warn('alignBeatBackedBoundaries → rejected an ungrounded proposal (hard sync)', {
        analyzed: resolved.analyzedAssetIds.length,
      });
      return {
        ok: false,
        reasonKey: 'ungrounded',
        error:
          'you declared hard sync, so every interior picture cut must land on a detected ' +
          `onset — but ${reason}`,
      };
    }
    // No declaration: the cuts stand, and the state goes to the model as a measurement.
    // Refusing here would hold the run to a style it never chose — the same mistake the
    // off-grid branch below stopped making, and the one that deadlocked `ea8e46ec`.
    log.action('alignBeatBackedBoundaries → ungrounded grid reported, cuts left as proposed', {
      analyzed: resolved.analyzedAssetIds.length,
    });
    return {
      ok: true,
      operations,
      snapped: 0,
      ungrounded:
        `These cuts were not checked against any onset — ${reason} They were left exactly ` +
        'as you placed them.',
    };
  }
  const grid = resolved.times;
  /* v8 ignore next -- `resolveBeatGrid` never returns a `grid` with no times (both branches
     that build one require a non-empty array); kept so the arithmetic below is total. */
  if (grid.length === 0) return { ok: true, operations, snapped: 0 };

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

  let offGrid: string | undefined;
  if (misses.length > 0) {
    const shown = misses
      .slice(0, REPORTED_MISS_LIMIT)
      .map((miss) => `${readable(miss.time)} (nearest detected onset ${readable(miss.nearest)})`);
    const omitted = misses.length - shown.length;
    const list = `${shown.join('; ')}${omitted > 0 ? `; plus ${String(omitted)} more` : ''}`;
    if (hardSync) {
      log.warn('alignBeatBackedBoundaries → rejected off-grid boundaries (hard sync declared)', {
        misses: misses.length,
        gridSize: grid.length,
      });
      return {
        ok: false,
        reasonKey: 'off-grid',
        reasonScale: misses.length,
        error:
          'you declared hard sync, so every interior picture cut must land on a detected ' +
          `onset. Off-grid: ${list}. Replace each with the detected onset time exactly as ` +
          "supplied — do not round or interpolate. Only the sequence's own opening (before " +
          'the first onset) and its final end (after the last onset) may sit off-grid; audio ' +
          'and caption boundaries are never checked. Drop hardSync if the picture should ' +
          'lead instead.',
      };
    }
    // No declaration: the cut stands, and the measurement goes to the model. A cut that is
    // deliberately a few frames off an onset is ordinary editing, not an error.
    log.action('alignBeatBackedBoundaries → off-grid cuts left as proposed', {
      misses: misses.length,
      gridSize: grid.length,
    });
    offGrid =
      `${String(misses.length)} interior cut(s) do not sit on a detected onset: ${list}. ` +
      'Left as you placed them — set hardSync on detect_beats if you want them held to the ' +
      'grid instead.';
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
      reasonKey: 'sub-frame',
      reasonScale: collapsed.length,
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
  return { ok: true, operations: next, snapped, ...(offGrid ? { offGrid } : {}) };
}
