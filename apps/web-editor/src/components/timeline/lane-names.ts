/**
 * Short lane names for the timeline's track headers — `V1`, `A2`, `C1`, `FX1`.
 *
 * Every NLE names its lanes, and the reason is not decoration: a lane is the
 * thing the user talks about ("mute A2", "put it on V1"), the thing shortcuts and
 * AI instructions address, and the only part of a track header that survives when
 * every control on it is hidden at rest. Without a name a header is a coloured
 * glyph and four identical grey buttons, which tells the user which *kind* of
 * lane it is but never *which* lane.
 *
 * Numbering is per prefix, in the order the lanes are shown (top to bottom),
 * starting at 1 — the rule a user can hold in their head while looking at the
 * stack. It deliberately does NOT follow the traditional bottom-up video
 * numbering of a broadcast NLE: FramePilot renders layer 0 at the top, so
 * bottom-up numbering would put `V1` at the bottom of a stack whose topmost lane
 * is the one the user just added.
 *
 * Pure and injected with the caller's kind lookup, so it carries no dependency on
 * the component's icon/label tables and is unit-tested without the DOM.
 */
import type { Track } from '@framepilot/timeline-schema';

/** The lane-name prefix for each clip kind an ordinary lane can hold. */
const KIND_PREFIX: Record<string, string> = {
  video: 'V',
  image: 'V',
  audio: 'A',
  text: 'T',
  caption: 'C',
};

/** The prefix for an adjustment lane, which holds effect layers rather than clips. */
const EFFECT_PREFIX = 'FX';

/** Fallback prefix for a lane whose kind the caller could not resolve. */
const UNKNOWN_PREFIX = 'L';

/**
 * Name every lane in `tracks`, keyed by track id.
 *
 * @param tracks - Visible lanes, in display order (top first).
 * @param kindOf - The dominant clip kind of a lane, or `null`/`undefined` when
 *   the lane is empty or its kind cannot be resolved.
 *   An `effect` lane is named without consulting this.
 * @returns A map from track id to its short name (`V1`, `A2`, …).
 */
export function laneNames(
  tracks: readonly Track[],
  kindOf: (track: Track) => string | null | undefined,
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const track of tracks) {
    const prefix =
      track.type === 'effect'
        ? EFFECT_PREFIX
        : (KIND_PREFIX[kindOf(track) ?? ''] ?? UNKNOWN_PREFIX);
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    names.set(track.id, `${prefix}${next}`);
  }
  return names;
}
