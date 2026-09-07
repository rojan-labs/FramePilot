/**
 * @framepilot/ai-sdk/kernel/briefing-picture — what changed ON SCREEN, in three lines
 * (ADR 0175, plan/visual-understanding VU2.6).
 *
 * The user's complaint that started this plan was "the AI does not know what it edited".
 * Everything else in the plan gives the model facts about footage it has not touched yet;
 * this module closes the loop on footage it just did. After an apply, the briefing says
 * which cuts appeared, which disappeared, and which ones now have a problem they did not
 * have before.
 *
 * Two rules, and the second is the one that matters:
 *
 * 1. **Words, not numbers** — the same discipline as the clip rows. "now MS→WS, a stop
 *    brighter" rather than a pair of decimals the model would copy into a grade.
 * 2. **A defect the footage already had is NOT this run's shortfall.** The run is judged on
 *    its delta. A cut that was over-exposed before the run started is an ADVISORY the model
 *    may act on if the editor asked; it is never a failure the run has to fix. This is the
 *    same rule the shortfall guard learned the hard way — a run that inherits a letterboxed
 *    project must not spend its turns cropping clips nobody mentioned.
 */
import { SHOT_SIZE_LADDER, type ShotSize } from '../ledger.js';
import type { PictureCut, PictureCutFlag, PictureSlice } from './semantic-index/picture.js';

/** How a cut differs from how it was before the apply. */
export type PictureChangeKind = 'added' | 'removed' | 'worsened' | 'unchanged';

export interface PictureChange {
  readonly kind: PictureChangeKind;
  readonly at: number;
  readonly fromClipId: string;
  readonly toClipId: string;
  /** Flags this apply is responsible for — new here, absent before. */
  readonly newFlags: readonly PictureCutFlag[];
  /** Flags the cut already had. Advisory only; never a shortfall. */
  readonly inheritedFlags: readonly PictureCutFlag[];
}

/** At most this many cut lines. Beyond it the model is reading a list, not a summary. */
export const MAX_PICTURE_LINES = 3;

/**
 * One stop of exposure, in the ledger's 0..1 luma-mean units.
 *
 * Not a photometric stop — a doubling of measured mean luma is what an editor would call
 * "about a stop" on this scale, and the line only needs to be right enough to be worth
 * reading. Below it the change is not worth a line at all.
 */
const LUMA_PER_STOP = 0.2;

/** Below this a warmth move is not worth mentioning; it matches `shot-words`' neutral band. */
const WARMTH_WORTH_SAYING = 0.12;

/** Human names for the flags, in the order a reader cares about them. */
const FLAG_WORDS: Readonly<Record<PictureCutFlag, string>> = {
  black_in: 'cuts to black',
  jump_cut: 'jump cut',
  exposure_jump: 'exposure jump',
  wb_jump: 'colour jump',
  size_jump: 'big framing jump',
  soft_in: 'cuts to a soft shot',
};

/** A stable identity for a cut across two revisions: the pair of clips it joins. */
function cutKey(cut: PictureCut): string {
  return `${cut.fromClipId}→${cut.toClipId}`;
}

function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${String(minutes)}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * Diff two picture slices into what this apply did to the screen.
 *
 * @param before - The slice as it was when the turn started; `null` on the first apply.
 * @param after - The slice now.
 * @returns One entry per cut that appeared, disappeared or got worse. Unchanged cuts are
 *   omitted: a briefing that lists what did not happen is a briefing nobody reads.
 */
export function diffPicture(
  before: PictureSlice | null | undefined,
  after: PictureSlice,
): readonly PictureChange[] {
  const previous = new Map<string, PictureCut>();
  for (const cut of before?.cuts ?? []) previous.set(cutKey(cut), cut);
  const seen = new Set<string>();
  const changes: PictureChange[] = [];

  for (const cut of after.cuts) {
    const key = cutKey(cut);
    seen.add(key);
    const was = previous.get(key);
    if (!was) {
      changes.push({
        kind: 'added',
        at: cut.at,
        fromClipId: cut.fromClipId,
        toClipId: cut.toClipId,
        newFlags: cut.flags,
        inheritedFlags: [],
      });
      continue;
    }
    const had = new Set<PictureCutFlag>(was.flags);
    const newFlags = cut.flags.filter((flag) => !had.has(flag));
    const inherited = cut.flags.filter((flag) => had.has(flag));
    if (newFlags.length > 0) {
      changes.push({
        kind: 'worsened',
        at: cut.at,
        fromClipId: cut.fromClipId,
        toClipId: cut.toClipId,
        newFlags,
        inheritedFlags: inherited,
      });
    } else if (inherited.length > 0) {
      changes.push({
        kind: 'unchanged',
        at: cut.at,
        fromClipId: cut.fromClipId,
        toClipId: cut.toClipId,
        newFlags: [],
        inheritedFlags: inherited,
      });
    }
  }

  for (const [key, cut] of previous) {
    if (seen.has(key)) continue;
    changes.push({
      kind: 'removed',
      at: cut.at,
      fromClipId: cut.fromClipId,
      toClipId: cut.toClipId,
      newFlags: [],
      inheritedFlags: [],
    });
  }
  return changes.sort((a, b) => a.at - b.at);
}

/**
 * The framing of a clip, read from whichever tier knows it.
 *
 * Derived from the slice's own clips rather than added to `PictureCut`: the cut carries the
 * DELTA (how many ladder steps), which is what a policy needs, and the two names are a
 * presentation concern belonging here.
 */
function shotSizeOf(slice: PictureSlice, clipId: string): ShotSize | null {
  const clip = slice.clips.find((entry) => entry.clipId === clipId);
  const facts = clip?.dominant;
  const labelled = facts?.labelled?.shotSize?.value;
  const described = facts?.described?.camera?.shotSize;
  const value = labelled ?? described;
  return value !== undefined &&
    value !== null &&
    (SHOT_SIZE_LADDER as readonly string[]).includes(value)
    ? (value as ShotSize)
    : null;
}

/** The framing move across a cut, when both sides are known. */
function framingPhrase(slice: PictureSlice, cut: PictureCut | undefined): string {
  if (!cut) return '';
  const steps = cut.delta.shotSizeSteps;
  if (steps === null || steps === 0) return '';
  const from = shotSizeOf(slice, cut.fromClipId);
  const to = shotSizeOf(slice, cut.toClipId);
  if (from && to) return `${from}→${to}`;
  return steps > 0 ? 'tighter' : 'wider';
}

/** The exposure/colour move across a cut, in words. */
function lookPhrase(cut: PictureCut | undefined): string {
  if (!cut) return '';
  const parts: string[] = [];
  const luma = cut.delta.luma;
  if (luma !== null && Math.abs(luma) >= LUMA_PER_STOP) {
    const stops = Math.abs(luma) / LUMA_PER_STOP;
    const amount = stops >= 1.5 ? `${stops.toFixed(0)} stops` : 'a stop';
    parts.push(`${amount} ${luma > 0 ? 'brighter' : 'darker'}`);
  }
  const warmth = cut.delta.warmth;
  if (warmth !== null && Math.abs(warmth) >= WARMTH_WORTH_SAYING) {
    parts.push(warmth > 0 ? 'warmer' : 'cooler');
  }
  return parts.join(', ');
}

function describeFlags(flags: readonly PictureCutFlag[]): string {
  return flags.map((flag) => FLAG_WORDS[flag]).join(', ');
}

/**
 * Render the PICTURE section of a briefing, or `''` when there is nothing to say.
 *
 * @param before - The picture slice at the start of the turn.
 * @param after - The picture slice now.
 * @param maxLines - Cut lines to show; the rest collapse to a count.
 * @returns The section text WITHOUT a trailing newline, or `''`.
 */
export function renderPictureBriefing(
  before: PictureSlice | null | undefined,
  after: PictureSlice,
  maxLines: number = MAX_PICTURE_LINES,
): string {
  const changes = diffPicture(before, after);
  const cutsNow = new Map<string, PictureCut>();
  for (const cut of after.cuts) cutsNow.set(cutKey(cut), cut);

  // Order by how much the model needs to know: what this apply broke, then what it made,
  // then what it removed, then what was already wrong. An advisory must never crowd out a
  // problem the run just caused.
  const rank: Record<PictureChangeKind, number> = {
    worsened: 0,
    added: 1,
    removed: 2,
    unchanged: 3,
  };
  const ordered = [...changes].sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at);
  const worth = ordered.filter(
    (change) => change.kind !== 'unchanged' || change.inheritedFlags.length > 0,
  );
  if (worth.length === 0) return '';

  const lines: string[] = [];
  for (const change of worth.slice(0, maxLines)) {
    const cut = cutsNow.get(`${change.fromClipId}→${change.toClipId}`);
    const where = clock(change.at);
    if (change.kind === 'removed') {
      lines.push(`- ${where} cut removed`);
      continue;
    }
    const detail = [framingPhrase(after, cut), lookPhrase(cut)].filter(Boolean).join(', ');
    if (change.kind === 'added') {
      const problem = change.newFlags.length > 0 ? ` ⚑ ${describeFlags(change.newFlags)}` : '';
      lines.push(`- ${where} new cut${detail ? ` — ${detail}` : ''}${problem}`);
    } else if (change.kind === 'worsened') {
      lines.push(`- ${where} ⚑ ${describeFlags(change.newFlags)}${detail ? ` (${detail})` : ''}`);
    } else {
      // Inherited only. Say whose problem it is, or the run will adopt it as its own.
      lines.push(
        `- ${where} ${describeFlags(change.inheritedFlags)} — already there before this run; fix only if asked`,
      );
    }
  }
  if (worth.length > maxLines) {
    lines.push(`- …and ${String(worth.length - maxLines)} more change(s)`);
  }
  return `PICTURE — what changed on screen\n${lines.join('\n')}`;
}
