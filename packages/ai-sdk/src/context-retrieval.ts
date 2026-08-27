/**
 * @framepilot/ai-sdk/context-retrieval — WHICH part of a long project reaches the prompt
 * (context-management Phase 2).
 *
 * Phase 1 bought coverage with room: on a ten-minute recording the whole project now fits,
 * and the question of what to select does not arise. On a sixty-minute interview or a
 * four-hour event it does, and no budget will make it go away. There the question stops
 * being *how much* and becomes *which part* — and FramePilot used to answer it with
 * `.slice(0, 12)` and a hard narrowing to the selection.
 *
 * This module is the answer, and it is deliberately three small pure functions rather than
 * a retrieval framework:
 *
 * - {@link deriveRetrievalQuery} reads the turn — pinned entities, selection, request
 *   scope — into a query, with a DECLARED precedence rather than a heuristic pile.
 * - {@link rankedClipIds} chooses which clips of a layer to show.
 * - {@link rankedDialogue} chooses which dialogue to show.
 *
 * Both rankers obey the same two rules, which are what make ranking safe to ship:
 *
 * 1. **Pinned is never ranked away.** The user said these explicitly.
 * 2. **A ranker may reorder within the room; it may never reduce coverage below what
 *    Phase 1 would have shown.** Where there is nothing ranked to prefer, behaviour is
 *    exactly head-of-list.
 *
 * And one rule that is the whole point of P2.2: **a selection is a BIAS, not a boundary.**
 * Clips and dialogue near it rank first; the rest of the project stays eligible for
 * whatever room is left. A global request over a sixty-minute project produces a wide,
 * sparse, whole-timeline slice; a local one produces a narrow, dense slice around the
 * selection. Both are the same function with a different fill order.
 */
import type { Clip } from '@framepilot/timeline-schema';
import type { PinnedEntity } from './context-builder.js';
import { type RequestScope, requestScopeOf } from './kernel/command-classifier.js';
import type { DialogueSegment } from './kernel/semantic-index/semantic-index.js';
import { sampleEvenly } from './kernel/semantic-index/semantic-index-slice.js';

/** A half-open timeline range the request is biased toward. */
export interface RetrievalBias {
  readonly start: number;
  readonly end: number;
}

/** What one turn asks retrieval for. Pure data — no index, no project, no I/O. */
export interface RetrievalQuery {
  readonly scope: RequestScope;
  /**
   * The live selection, when there is one. A bias on ordering, never a bound: material
   * outside it stays eligible for whatever room the biased material does not use.
   */
  readonly bias?: RetrievalBias;
  /** Clip ids the user pinned explicitly (P8.7). Always shown in full, never ranked away. */
  readonly pinnedClipIds: ReadonlySet<string>;
}

/**
 * Read the turn into a retrieval query, precedence first (P2.2).
 *
 * 1. **Pinned entities** — the user named these. They are carried through untouched.
 * 2. **Selection** — recorded as a bias, never as a boundary.
 * 3. **Request scope** — {@link requestScopeOf}, which can override a selection when the
 *    request explicitly says "the whole recording".
 */
export function deriveRetrievalQuery(input: {
  readonly userPrompt: string;
  readonly selection?: RetrievalBias;
  readonly pinned?: readonly PinnedEntity[];
}): RetrievalQuery {
  const pinnedClipIds = new Set(
    (input.pinned ?? []).filter((entity) => entity.kind === 'clip').map((entity) => entity.id),
  );
  const scope = requestScopeOf(input.userPrompt, input.selection !== undefined);
  return input.selection
    ? { scope, bias: input.selection, pinnedClipIds }
    : { scope, pinnedClipIds };
}

/** True when two half-open ranges overlap at all. */
const overlaps = (a: RetrievalBias, b: RetrievalBias): boolean =>
  a.start < b.end && a.end > b.start;

/**
 * Fill the room left after the preferred entries, in the order the request's scope calls
 * for.
 *
 * A **local** request wants the neighbourhood: take the rest in timeline order, which
 * grows the shown region outward from wherever the preferred entries already are — a
 * narrow, dense slice. A **global** request wants the shape of the whole thing: sample
 * evenly across the remainder, so a four-hour event yields beginning, middle and end
 * rather than its first four minutes.
 */
function fill<T>(
  rest: readonly T[],
  room: number,
  query: RetrievalQuery,
  timeOf: (entry: T) => number,
): readonly T[] {
  if (room <= 0) return [];
  if (rest.length <= room) return rest;
  if (query.scope === 'global' || !query.bias) return sampleEvenly(rest, room);
  const centre = (query.bias.start + query.bias.end) / 2;
  // Nearest-first, then back into source order: the caller renders in time order, and
  // "the clips around the selection" is a contiguous region, not a scattered sample.
  return [...rest]
    .sort((a, b) => Math.abs(timeOf(a) - centre) - Math.abs(timeOf(b) - centre))
    .slice(0, room);
}

/**
 * Which of a layer's clips to render in full, given the room for `limit` of them.
 *
 * Returns ids, not clips: the caller renders in TIME order regardless of rank, because a
 * timeline read out of order is harder to reason about than one with gaps in it, and the
 * gaps are declared separately (P2.3).
 */
export function rankedClipIds(
  clips: readonly Clip[],
  query: RetrievalQuery,
  limit: number,
): ReadonlySet<string> {
  if (clips.length <= limit) return new Set(clips.map((clip) => clip.id));
  const byStart = [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  // Rule 1: pinned first, and pinned is not counted against relevance — only against room.
  const pinned = byStart.filter((clip) => query.pinnedClipIds.has(clip.id));
  const biased = query.bias
    ? byStart.filter(
        (clip) =>
          !query.pinnedClipIds.has(clip.id) &&
          overlaps(query.bias!, { start: clip.start, end: clip.end }),
      )
    : [];
  const chosen = new Set([...pinned, ...biased].slice(0, limit).map((clip) => clip.id));
  const rest = byStart.filter((clip) => !chosen.has(clip.id));
  for (const clip of fill(rest, limit - chosen.size, query, (clip) => clip.start)) {
    chosen.add(clip.id);
  }
  return chosen;
}

/**
 * Which dialogue segments to render, given room for `limit` WORDS.
 *
 * Words rather than segments because that is the unit the budget was allocated in (P1.3)
 * and the unit coverage is measured in. Segments are whole: a half-quoted sentence is a
 * sentence the model can misread, and dropping whole records with a declared count is the
 * same rule the read digests follow.
 */
export function rankedDialogue(
  dialogue: readonly DialogueSegment[],
  query: RetrievalQuery,
  wordLimit: number,
): readonly DialogueSegment[] {
  const words = (segment: DialogueSegment): number =>
    segment.text.split(/\s+/).filter(Boolean).length;
  const cost = (segments: readonly DialogueSegment[]): number =>
    segments.reduce((sum, segment) => sum + words(segment), 0);
  if (cost(dialogue) <= wordLimit) return dialogue;
  const byStart = [...dialogue].sort((a, b) => a.start - b.start);
  const biased = query.bias
    ? byStart.filter((segment) => overlaps(query.bias!, { start: segment.start, end: segment.end }))
    : [];
  const chosen = new Set<DialogueSegment>();
  let spent = 0;
  for (const segment of biased) {
    const next = words(segment);
    if (spent + next > wordLimit) break;
    chosen.add(segment);
    spent += next;
  }
  const rest = byStart.filter((segment) => !chosen.has(segment));
  // How many MORE segments the remaining words buy — found by search rather than by
  // dividing by an average, because segment lengths are wildly uneven (a one-word
  // interjection and a two-minute monologue are both one segment) and an average
  // underfills the prompt by most of its room on real footage.
  const remaining = wordLimit - spent;
  let low = 0;
  let high = rest.length;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (cost(fill(rest, mid, query, (segment) => segment.start)) <= remaining) low = mid;
    else high = mid;
  }
  for (const segment of fill(rest, low, query, (segment) => segment.start)) chosen.add(segment);
  return byStart.filter((segment) => chosen.has(segment));
}
