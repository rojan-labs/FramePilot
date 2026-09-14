/**
 * @framepilot/ai-sdk/kernel/placement-note — what a mutation's result tells the model
 * about WHERE things now are, so it does not spend a round trip reading it back.
 *
 * ## Why a mutation result carries placement
 *
 * A landed edit used to answer with its intent only ("Trimmed clip raw_skating.mp4 ·
 * 3.033s–5.2s", "Added transition Video 2") and a no-op with a reading instruction
 * ("Read the current value with get_timeline or get_clips before setting it again").
 * The model did as told. Across the five Claude runs recorded 2026-09-01 → 09-14
 * (TRACKING.md §W), 17 of 128 model calls did nothing but read the arrangement or verify
 * it — 288 s of wall time — and 14 of those came straight after a mutation (234 s). Nine
 * were a bare `get_clips` / `get_timeline`, each a full round trip (≈3.4 s of fixed
 * overhead plus 8–37 s of thinking) that produced no edit. Run `3ed87ff0` turn `014f` read
 * the clips back four times in eighteen steps; run `55bf6774` turn `323c` read the
 * timeline twice after placing a single effect layer.
 *
 * The result already knows the answer: the orchestrator holds the post-patch project when
 * it writes the note. Saying where the touched clips landed — id, track, sequence span,
 * source span — is what the follow-up read would have returned, minus the round trip. A
 * no-op likewise states the value the clip already holds, which is the one thing the model
 * needs to set a different one.
 *
 * ## What is deliberately NOT here
 *
 * Only clips whose placement changed, appeared, or vanished are listed. A grade or a gain
 * change moves nothing, and restating an unchanged span after every `apply_color_grade`
 * would be noise in a log that is compacted by token budget. The list is capped: a
 * `caption_the_edit` pass places hundreds of cues, and the tally in
 * `summarizeOperations` already says so.
 */
import type { AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';

/** Clips named per note before the rest collapse into a count. */
export const PLACEMENT_NOTE_MAX_CLIPS = 12;

type Clip = Project['timeline']['tracks'][number]['clips'][number];

interface Placement {
  readonly trackId: string;
  readonly start: number;
  readonly end: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly speed: number;
}

const round = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/** Every clip in the sequence, by id, with the fields a placement is made of. */
function placementsOf(project: Project): Map<string, Placement> {
  const out = new Map<string, Placement>();
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips as readonly Clip[]) {
      out.set(clip.id, {
        trackId: track.id,
        start: clip.start,
        end: clip.end,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        speed: clip.speed ?? 1,
      });
    }
  }
  return out;
}

function samePlacement(a: Placement, b: Placement): boolean {
  return (
    a.trackId === b.trackId &&
    a.start === b.start &&
    a.end === b.end &&
    a.sourceStart === b.sourceStart &&
    a.sourceEnd === b.sourceEnd &&
    a.speed === b.speed
  );
}

/**
 * The clip ids an operation names explicitly. `clipId` is the common field; `clipIds` is
 * the batch form (`reorder_clips`, `restore_clips`); `clips` carries whole clip records on
 * a restore. Ids of clips an operation CREATES are not knowable from the op alone — they
 * are found by diffing the two projects instead.
 */
function namedClipIds(op: AnyOperation): string[] {
  const record = op as unknown as Record<string, unknown>;
  const ids: string[] = [];
  const single = record['clipId'];
  if (typeof single === 'string') ids.push(single);
  const many = record['clipIds'];
  if (Array.isArray(many)) for (const id of many) if (typeof id === 'string') ids.push(id);
  const records = record['clips'];
  if (Array.isArray(records)) {
    for (const clip of records) {
      const id = (clip as { id?: unknown })?.id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

/** One model-facing line: the id first, because the id is what the next call needs. */
function placementLine(id: string, placement: Placement): string {
  const speed = placement.speed === 1 ? '' : `, ${round(placement.speed)}×`;
  return (
    `${id} on ${placement.trackId} ${round(placement.start)}s–${round(placement.end)}s ` +
    `(src ${round(placement.sourceStart)}s–${round(placement.sourceEnd)}s${speed})`
  );
}

function capped(lines: readonly string[]): string {
  if (lines.length <= PLACEMENT_NOTE_MAX_CLIPS) return lines.join('; ');
  const rest = lines.length - PLACEMENT_NOTE_MAX_CLIPS;
  return `${lines.slice(0, PLACEMENT_NOTE_MAX_CLIPS).join('; ')}; …and ${String(rest)} more`;
}

/**
 * Where the clips a landed edit touched now sit, or `''` when the edit moved no clip
 * (a grade, a gain change, a marker, a track flag).
 *
 * Listed, in this order: clips the operations named whose placement changed, then every
 * other clip whose placement differs between the two copies — the ones an operation
 * created (an `add_clip`, the second half of a `split_clip`, a text overlay), removed, or
 * shifted without naming (everything downstream of a `ripple_delete`). Each line reads
 * `id on track start–end (src in–out[, speed×])`, which is exactly what `get_clips` would
 * have said about that clip.
 *
 * @param ops - The normalized operations the patch applied.
 * @param before - The working copy the patch was applied to.
 * @param after - The working copy the patch produced.
 * @returns A ` · now: …` suffix for the result note, or `''`.
 */
export function placementNote(
  ops: readonly AnyOperation[],
  before: Project,
  after: Project,
): string {
  const was = placementsOf(before);
  const now = placementsOf(after);
  const lines: string[] = [];
  const seen = new Set<string>();
  const consider = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const current = now.get(id);
    const previous = was.get(id);
    if (current && previous && samePlacement(current, previous)) return;
    if (current) lines.push(placementLine(id, current));
    else if (previous) lines.push(`${id} removed from ${previous.trackId}`);
  };
  for (const op of ops) for (const id of namedClipIds(op)) consider(id);
  for (const id of now.keys()) consider(id);
  for (const id of was.keys()) consider(id);
  return lines.length === 0 ? '' : ` · now: ${capped(lines)}`;
}

/**
 * The current placement of every clip the operations name, as one capped clause, or `''`
 * when they name none that exists.
 *
 * @param ops - The operations whose clip references to resolve.
 * @param project - The working copy to read the placements from.
 */
export function currentPlacement(ops: readonly AnyOperation[], project: Project): string {
  const now = placementsOf(project);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    for (const id of namedClipIds(op)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const placement = now.get(id);
      if (placement) lines.push(placementLine(id, placement));
    }
  }
  return capped(lines);
}

/**
 * What the clips an edit named already hold, for an edit that changed nothing.
 *
 * The value the model tried to set is the value the timeline already had, so the one
 * thing worth saying is that value — not an instruction to go and read it. Names only the
 * clips the operations reference; an edit that names none (a track-level or project-level
 * no-op) gets the plain sentence.
 *
 * @param ops - The operations that applied cleanly and changed nothing.
 * @param project - The working copy they were applied to (equal to the result).
 * @returns The ` — nothing moved: …` suffix for the result note.
 */
export function unchangedNote(ops: readonly AnyOperation[], project: Project): string {
  const holds = currentPlacement(ops, project);
  const already =
    holds === ''
      ? 'the project already said exactly this'
      : `the project already holds this — ${holds}`;
  return ` — nothing moved: ${already}. Set a different value, or go on to the next part of the request.`;
}
