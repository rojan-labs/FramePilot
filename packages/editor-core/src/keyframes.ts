/**
 * @framepilot/editor-core/keyframes — keyframe easing + interpolation engine.
 *
 * WHY: motion (zoom/punch-in, position, opacity, etc.) is driven by keyframes
 * with easing (PRD §6.3, PLAN Phase 5). This is the deterministic **evaluation
 * engine** that turns a clip's stored {@link Keyframe} list into a concrete
 * property value at any time — the foundation the render compiler and the editor
 * UI both consume. It is pure (no DOM, no I/O), so it is 100% unit-testable.
 *
 * It is the TS source mirrored by the Python
 * `framepilot_engine.effects.keyframes` module; the two MUST stay in sync (same
 * easing curves, same segment semantics).
 *
 * Segment semantics (matches the schema's `Keyframe.easing` doc and the Python
 * mirror): a keyframe's `easing` describes the curve **into the next keyframe**,
 * so segment `a → b` is eased by `a`'s curve. Before the first keyframe the value
 * holds at the first; after the last it holds at the last.
 */
import type { Seconds } from '@framepilot/shared-types';
import type { Keyframe } from '@framepilot/timeline-schema';
import type { Easing } from '@framepilot/timeline-schema/keyframe-curves';

// The evaluation engine lives in `@framepilot/timeline-schema/keyframe-curves` since
// schema v22 (ADR 0178); every existing import of it from here keeps working.
export * from '@framepilot/timeline-schema/keyframe-curves';

/** Options for {@link punchInKeyframes}. */
export interface PunchInOptions {
  /** Prefix for the derived, deterministic keyframe ids. */
  readonly idPrefix: string;
  readonly startTime: Seconds;
  readonly endTime: Seconds;
  /** Scale at `startTime` (default `1.0`). */
  readonly fromScale?: number | undefined;
  /** Scale at `endTime` (default `1.2`). */
  readonly toScale?: number | undefined;
  /** Easing curve for the ramp (default `ease-in-out`). */
  readonly easing?: Easing | undefined;
  /** Animated property name (default `"scale"`). */
  readonly property?: string | undefined;
}

/**
 * Build a two-keyframe zoom/punch-in animation (pure).
 *
 * A punch-in is the canonical "subtle zoom to add energy" move (PRD §5.3): ramp
 * `property` from `fromScale` at `startTime` to `toScale` at `endTime` with the
 * given easing. Deterministic ids are derived from `idPrefix` so the same request
 * always yields the same keyframes. The result is fed to an `add_keyframes`
 * operation by the UI/AI layer.
 *
 * @throws {RangeError} If `endTime` is not strictly after `startTime`.
 */
export function punchInKeyframes(options: PunchInOptions): Keyframe[] {
  const {
    idPrefix,
    startTime,
    endTime,
    fromScale = 1.0,
    toScale = 1.2,
    easing = 'ease-in-out',
    property = 'scale',
  } = options;
  if (endTime <= startTime) {
    throw new RangeError(`punchInKeyframes needs endTime > startTime (${startTime} → ${endTime})`);
  }
  const idFor = (time: Seconds): string => `${idPrefix}__${property}__${Math.round(time * 1000)}`;
  return [
    { id: idFor(startTime), time: startTime, property, value: fromScale, easing },
    { id: idFor(endTime), time: endTime, property, value: toScale, easing },
  ];
}
