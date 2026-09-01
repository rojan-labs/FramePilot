/**
 * Which lane a new clip should land on.
 *
 * A track may never hold overlapping clips — the validator rejects a patch that
 * would create one, and rightly so: two clips occupying the same instant on one
 * lane has no defined render order. But "reject" is the wrong answer to give a
 * *user*, and it was the answer they got. Dropping a second title over the first,
 * or asking the agent for two simultaneous text elements, produced
 *
 *     Clips 'text__t_motion_gfx_18000' and 'text__t_motion_gfx_22800'
 *     overlap on track 't_motion_gfx'.
 *
 * and nothing happened. The intent was never ambiguous — the user wanted both
 * things on screen at that moment — and stacking simultaneous elements on
 * separate lanes is exactly what lanes are for. So the placement resolves the
 * lane instead of trusting the caller's, the same way asset drops already did.
 *
 * This module is the shared, pure rule. The same overlap test lived as three
 * separate copies — one in the editor's patch builders, one in `stock-placement.ts`,
 * one inline in the timeline's drop handler — which is three chances for the
 * tolerance or the half-open convention to drift apart. The patch builders and the
 * drop handler now resolve through here; `stock-placement.ts` still carries its own,
 * because it answers a different question (see `picture-occupancy.ts`: picture may
 * not be relocated onto a stacked lane at all) and folding it in would have made
 * this change larger than the defect it fixes.
 */
import type { Timeline, Track } from '@framepilot/timeline-schema';
import type { Operation } from './operations.js';

/**
 * Overlap tolerance, in seconds.
 *
 * Butt-joined clips share an instant by construction (one ends exactly where the
 * next begins), so the comparison is half-open by this epsilon rather than
 * strict. It matches the renderer's `MIN_EDIT_SECONDS`.
 */
export const LANE_OVERLAP_EPSILON = 1e-3;

/**
 * TRUE when no clip on `track` occupies the half-open span `[start, end)`.
 *
 * @param track - The lane to test.
 * @param start - Span start, in seconds.
 * @param end - Span end, in seconds.
 */
export function trackHasRoomFor(track: Track, start: number, end: number): boolean {
  return !track.clips.some(
    (clip) => clip.start < end - LANE_OVERLAP_EPSILON && clip.end > start + LANE_OVERLAP_EPSILON,
  );
}

/**
 * The lane a clip spanning `[start, end)` should land on, or `null` when every
 * acceptable lane is already occupied there and the caller must create one.
 *
 * The preferred lane wins whenever it can: the user aimed at it, or the agent
 * named it, and moving a drop to a different lane than the one under the cursor
 * is its own kind of wrong. It is only overruled when it has no room — which is
 * the case that used to fail outright.
 *
 * Pure and total; `null` is a normal answer, not an error.
 *
 * @param timeline - Current timeline.
 * @param start - Span start, in seconds.
 * @param end - Span end, in seconds.
 * @param accepts - Whether a lane is eligible at all (kind, lock state, role).
 * @param preferredTrackId - The lane the caller asked for, if any.
 * @returns The chosen lane, or `null` to signal "create a new one".
 */
export function laneWithRoomFor(
  timeline: Timeline,
  start: number,
  end: number,
  accepts: (track: Track) => boolean,
  preferredTrackId?: string | undefined,
): Track | null {
  if (preferredTrackId !== undefined) {
    const preferred = timeline.tracks.find((track) => track.id === preferredTrackId);
    if (preferred && accepts(preferred) && trackHasRoomFor(preferred, start, end)) {
      return preferred;
    }
  }
  return (
    timeline.tracks.find((track) => accepts(track) && trackHasRoomFor(track, start, end)) ?? null
  );
}

/**
 * A non-colliding, deterministic id for a new lane, matching the renderer's
 * scheme (`layer_<type>_<n>`).
 *
 * Deterministic so the same placement produces the same patch twice — the
 * property the patch/undo contract and the golden tests both rely on.
 *
 * @param timeline - Current timeline, for collision avoidance.
 * @param layerType - The advisory type the new lane is created with.
 */
export function nextLayerId(timeline: Timeline, layerType: Track['type']): string {
  let n = timeline.tracks.length + 1;
  let id = `layer_${layerType}_${n}`;
  while (timeline.tracks.some((track) => track.id === id)) {
    n += 1;
    id = `layer_${layerType}_${n}`;
  }
  return id;
}

/** A lane chosen for a placement, plus any ops needed to make it exist first. */
export interface AllocatedLane {
  /** The lane the clip should be placed on. */
  readonly trackId: string;
  /**
   * Ops that must precede the placement. Empty when an existing lane was reused;
   * a single `add_layer` when a new one had to be opened. They ride the SAME
   * patch as the placement, so undo removes the lane along with what went on it.
   */
  readonly setupOps: readonly Operation[];
}

/**
 * Allocates lanes for a run of placements, remembering what it has already
 * promised.
 *
 * A single placement could be resolved with {@link laneWithRoomFor} alone, but a
 * batch cannot: `add_clips` builds every operation against the timeline as it was
 * before the call, so two entries in one batch that overlap each other would both
 * be told the same lane was free and would collide the moment the patch applied —
 * trading one rejection for a subtler one. The allocator books each span as it
 * hands it out, so a batch lays down exactly like a sequence of single calls.
 *
 * Stateful by design and scoped to one call; construct one per tool invocation.
 *
 * @param timeline - The timeline the placements are being planned against.
 */
export function createLaneAllocator(timeline: Timeline): {
  allocate: (preferredTrackId: string, start: number, end: number) => AllocatedLane;
} {
  /** Spans booked during this call, per lane id, on top of what the timeline holds. */
  const booked = new Map<string, { start: number; end: number }[]>();
  /** Lanes opened during this call, so a second entry can reuse one. */
  const opened: { id: string; type: Track['type'] }[] = [];

  const bookedHasRoom = (trackId: string, start: number, end: number): boolean =>
    !(booked.get(trackId) ?? []).some(
      (span) => span.start < end - LANE_OVERLAP_EPSILON && span.end > start + LANE_OVERLAP_EPSILON,
    );

  const book = (trackId: string, start: number, end: number): void => {
    const spans = booked.get(trackId);
    if (spans) spans.push({ start, end });
    else booked.set(trackId, [{ start, end }]);
  };

  return {
    allocate(preferredTrackId, start, end) {
      const named = timeline.tracks.find((track) => track.id === preferredTrackId);
      // An id that names no lane is handed straight back, unresolved.
      //
      // This function exists to rescue a placement that would collide, not to
      // rescue one that was addressed to nothing. A track id the timeline does not
      // contain is a mistake — a typo, or a model that did not read the timeline —
      // and quietly inventing a lane for it would scatter clips across lanes nobody
      // asked for while hiding the mistake that caused it. The caller's existing
      // validation still rejects it, with the reason that teaches the fix.
      if (!named) return { trackId: preferredTrackId, setupOps: [] };
      // Stay within the role that was asked for. Lanes are type-agnostic, so an
      // unconstrained search will happily put a title on the audio bed just because
      // it was free — legal, and a useless answer.
      const role = named.type;

      const existing = laneWithRoomFor(
        timeline,
        start,
        end,
        (track) =>
          // Hidden and muted lanes are not fallbacks. A hidden lane renders
          // nothing, so relocating onto one would report success and produce an
          // edit invisible in both the preview and the export — worse than the
          // rejection this rescue replaces. Muted is the same bargain for anything
          // audible. The lane the caller NAMED is still honoured whatever flags it
          // carries, because `laneWithRoomFor` tests the preferred one first:
          // pointing at a hidden lane is a choice, landing on one is an accident.
          !track.locked &&
          track.type === role &&
          bookedHasRoom(track.id, start, end) &&
          // The exemption is what makes the comment above true: `laneWithRoomFor`
          // applies this same predicate to the preferred lane, so without it a
          // deliberately-named hidden lane would be refused too.
          (track.id === preferredTrackId || (track.hidden !== true && track.muted !== true)),
        preferredTrackId,
      );
      if (existing) {
        book(existing.id, start, end);
        return { trackId: existing.id, setupOps: [] };
      }

      // Reuse a lane this same call already opened before opening another.
      const reusable = opened.find(
        (lane) => lane.type === role && bookedHasRoom(lane.id, start, end),
      );
      if (reusable) {
        book(reusable.id, start, end);
        return { trackId: reusable.id, setupOps: [] };
      }

      const layerId = nextLayerId(
        { tracks: [...timeline.tracks, ...opened.map((l) => ({ id: l.id }) as Track)] },
        role,
      );
      opened.push({ id: layerId, type: role });
      book(layerId, start, end);
      return {
        trackId: layerId,
        setupOps: [{ type: 'add_layer', layerId, layerType: role, atIndex: 0 }],
      };
    },
  };
}
