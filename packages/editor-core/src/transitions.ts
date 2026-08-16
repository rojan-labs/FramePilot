/**
 * Where a transition sits around the cut it treats, and how it is stored.
 *
 * ## The problem this solves
 *
 * A transition used to be exactly one thing: an effect on the incoming clip that
 * ramped it in over its first `durationSeconds`. That is a perfectly good
 * transition, but it is only ONE of the three placements every other NLE offers,
 * and it is not the one editors expect by default — "centre on cut" is.
 *
 * The other two placements need the *outgoing* clip to do something, and nothing
 * in the old model let it. So a transition is now stored as up to two effects:
 *
 * | effect | lives on | id | covers |
 * | --- | --- | --- | --- |
 * | `transition` | incoming clip | `${toClipId}__transition` | the part of the ramp after the cut |
 * | `transition_out` | outgoing clip | `${fromClipId}__transition_out` | the part before it |
 *
 * The second only exists when there IS a part before the cut, which is why
 * `start` alignment — the historical behaviour and still the default — produces
 * exactly the same single effect it always did, and every existing project keeps
 * rendering identically.
 *
 * ## One ramp, two clips
 *
 * Progress runs 0 → 1 across the whole window regardless of where the window
 * sits. At progress `p` the incoming clip's alpha is `A(p)` and the outgoing
 * clip's is `1 - A(p)`, so the two halves are complements of one function rather
 * than two independent animations that have to be kept in agreement.
 *
 * `Effect.type` is an open string in the schema, so `transition_out` is additive:
 * no schema change and no migration (`plan/ADVANCED-TRANSITION-SYSTEM.md`).
 */
import type { Clip, Effect } from '@framepilot/timeline-schema';

/** Effect type carrying the pre-cut half of a transition, on the outgoing clip. */
export const TRANSITION_OUT_EFFECT_TYPE = 'transition_out';

/** Effect type carrying the post-cut half, on the incoming clip. */
export const TRANSITION_EFFECT_TYPE = 'transition';

/**
 * Where the ramp sits relative to the cut.
 *
 * Mirrors `TransitionAlignment` in `@framepilot/timeline-schema/transition-params`;
 * restated here so editor-core does not have to reach into a sub-path export for a
 * three-value union it uses in its op types.
 */
export type TransitionAlignment = 'start' | 'centre' | 'end';

/** What an absent `alignment` param means — the pre-alignment behaviour. */
export const DEFAULT_TRANSITION_ALIGNMENT: TransitionAlignment = 'start';

/** The stable id of the incoming half. */
export function transitionEffectId(toClipId: string): string {
  return `${toClipId}__transition`;
}

/** The stable id of the outgoing half. */
export function transitionOutEffectId(fromClipId: string): string {
  return `${fromClipId}__transition_out`;
}

/** How the window of a transition divides either side of the cut. */
export interface TransitionWindow {
  /** Seconds of ramp on the incoming clip, measured from its start. */
  readonly inSeconds: number;
  /** Seconds of ramp on the outgoing clip, measured back from its end. */
  readonly outSeconds: number;
}

/**
 * Split `durationSeconds` either side of the cut for an alignment.
 *
 * `start` keeps the whole ramp on the incoming clip — what this engine has always
 * done, and the reason an existing project is untouched by any of this.
 */
export function transitionWindow(
  alignment: TransitionAlignment,
  durationSeconds: number,
): TransitionWindow {
  const duration = Math.max(0, durationSeconds);
  switch (alignment) {
    case 'centre':
      return { inSeconds: duration / 2, outSeconds: duration / 2 };
    case 'end':
      return { inSeconds: 0, outSeconds: duration };
    case 'start':
    default:
      return { inSeconds: duration, outSeconds: 0 };
  }
}

/**
 * Read an alignment out of free-form effect params, falling back to `start`.
 *
 * Unknown values fall back rather than throwing: `params` can hold anything a
 * hand-edited file or an AI patch put there, and an unreadable alignment should
 * render the transition the historical way, not fail the export.
 */
export function readAlignment(params: Readonly<Record<string, unknown>>): TransitionAlignment {
  const raw = params.alignment;
  if (raw === 'centre' || raw === 'end' || raw === 'start') return raw;
  return DEFAULT_TRANSITION_ALIGNMENT;
}

/**
 * Progress through a transition at a clip-local time, or `null` when the clip is
 * not inside the ramp at that moment.
 *
 * One function for both halves because they are one ramp: `role` only decides
 * which end of the clip the window is anchored to.
 *
 * @param role - `in` for the incoming clip's effect, `out` for the outgoing's.
 * @param t - Clip-local seconds (0 = the clip's own start).
 * @param clipDuration - The clip's timeline duration, needed to anchor `out`.
 */
export function transitionProgressAt(
  role: 'in' | 'out',
  t: number,
  params: Readonly<Record<string, unknown>>,
  clipDuration: number,
): number | null {
  const duration = Number(params.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const { inSeconds, outSeconds } = transitionWindow(readAlignment(params), duration);
  if (role === 'in') {
    if (inSeconds <= 0) return null;
    if (t < 0 || t >= inSeconds) return null;
    // The incoming half resumes where the outgoing half left off.
    return (outSeconds + t) / duration;
  }
  if (outSeconds <= 0) return null;
  const from = clipDuration - outSeconds;
  if (t < from || t >= clipDuration) return null;
  return (t - from) / duration;
}

/** The `transition` effect entering `clip`, if any. */
export function clipTransitionEffect(clip: Clip): Effect | undefined {
  return clip.effects.find((e) => e.type === TRANSITION_EFFECT_TYPE);
}

/** The `transition_out` effect leaving `clip`, if any. */
export function clipTransitionOutEffect(clip: Clip): Effect | undefined {
  return clip.effects.find((e) => e.type === TRANSITION_OUT_EFFECT_TYPE);
}
