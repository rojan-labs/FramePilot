/**
 * The transition policy, tested one row of §VU4.1 at a time.
 *
 * Two of these tests are load-bearing beyond their row:
 *
 * - the continuity refusal, because it is the only thing standing between a
 *   measured delta and the unmotivated dissolve that marks an edit as amateur;
 * - "every kind exists in the catalog", because a typo'd id validates, saves and
 *   then renders as nothing at all. That test is what stops a silently
 *   non-rendering transition shipping.
 */
import { describe, expect, it } from 'vitest';
import { defaultDirectionFor, getTransition } from '@framepilot/timeline-schema/transition-catalog';
import {
  TRANSITION_REASONS,
  chooseTransition,
  type MeasuredCut,
  type TransitionReason,
} from './transition-policy.js';

/** The direction the catalog says an entry travels in. */
const directionOf = (kind: string | undefined): string | undefined => {
  const entry = kind === undefined ? undefined : getTransition(kind);
  return entry === undefined ? undefined : defaultDirectionFor(entry);
};

/** An ordinary talking-head pace: the scene default lands mid-range at 1.0s. */
const NORMAL_PACING = 4;
/** Fast enough that a wipe is on the table and every clamp hits its floor. */
const FAST_PACING = 1.5;
/** Slow enough that every clamp hits its ceiling. */
const SLOW_PACING = 20;

describe('chooseTransition — one row per reason', () => {
  it('refuses a continuity cut even when every delta is large', () => {
    const violent: MeasuredCut = {
      lumaDelta: -0.8,
      warmthDelta: 0.9,
      shotSizeSteps: 5,
      motionChange: 'up',
      outgoingCameraMovement: 'pan',
      incomingIsDark: true,
      jumpCut: true,
    };
    expect(chooseTransition('continuity', violent, NORMAL_PACING)).toBeNull();
    expect(chooseTransition('continuity', {}, FAST_PACING)).toBeNull();
  });

  it('dissolves a time jump at a quarter of the shot length', () => {
    expect(chooseTransition('time_jump', {}, NORMAL_PACING)).toEqual({
      kind: 'cross-dissolve',
      durationSeconds: 1,
    });
  });

  it('dips to black when the time jump lands on a dark shot', () => {
    const choice = chooseTransition(
      'time_jump',
      { lumaDelta: -0.35, incomingIsDark: true },
      NORMAL_PACING,
    );
    expect(choice?.kind).toBe('fade-to-black');
  });

  it('keeps the dissolve when the shot is dark but the step is small', () => {
    const choice = chooseTransition(
      'time_jump',
      { lumaDelta: -0.05, incomingIsDark: true },
      NORMAL_PACING,
    );
    expect(choice?.kind).toBe('cross-dissolve');
  });

  it('keeps the dissolve when the luma step is large but the shot is not dark', () => {
    const choice = chooseTransition('time_jump', { lumaDelta: 0.6 }, NORMAL_PACING);
    expect(choice?.kind).toBe('cross-dissolve');
  });

  it('dissolves a location change by default', () => {
    expect(chooseTransition('location_change', {}, NORMAL_PACING)?.kind).toBe('cross-dissolve');
  });

  it('wipes a location change only when the energy rises and the edit is already fast', () => {
    const rising: MeasuredCut = { motionChange: 'up' };
    expect(chooseTransition('location_change', rising, FAST_PACING)?.kind).toBe('soft-wipe');
    // Same cut, slow edit: a wipe would read as a graphic device nobody asked for.
    expect(chooseTransition('location_change', rising, SLOW_PACING)?.kind).toBe('cross-dissolve');
    // Fast edit, no rise: still a dissolve.
    expect(chooseTransition('location_change', { motionChange: 'same' }, FAST_PACING)?.kind).toBe(
      'cross-dissolve',
    );
  });

  it('zooms an energy cut and keeps it inside the beat', () => {
    expect(chooseTransition('energy', {}, NORMAL_PACING)).toEqual({
      kind: 'smooth-zoom',
      durationSeconds: 0.4,
    });
  });

  it('treats montage exactly as energy', () => {
    const cut: MeasuredCut = { outgoingCameraMovement: 'tilt', index: 0 };
    expect(chooseTransition('montage', cut, NORMAL_PACING)).toEqual(
      chooseTransition('energy', cut, NORMAL_PACING),
    );
  });

  it('slides instead of zooming when the cut already changes framing hard', () => {
    const choice = chooseTransition('energy', { shotSizeSteps: 3, index: 0 }, NORMAL_PACING);
    expect(choice?.kind).toBe('push');
  });

  it('softens a plain smoothing request with a short dissolve', () => {
    expect(chooseTransition('soften', {}, NORMAL_PACING)).toEqual({
      kind: 'cross-dissolve',
      durationSeconds: 0.5,
    });
    // 0.25 × 1.5 = 0.375, inside the soften range.
    expect(chooseTransition('soften', {}, FAST_PACING)?.durationSeconds).toBe(0.38);
  });

  it('gives a measured jump cut enough blend to swallow the pop', () => {
    expect(chooseTransition('soften', { jumpCut: true }, FAST_PACING)).toEqual({
      kind: 'cross-dissolve',
      durationSeconds: 0.4,
    });
    // A repeated take at identical framing is a jump cut whether or not the
    // caller flagged it.
    expect(
      chooseTransition('soften', { duplicate: true, shotSizeSteps: 0 }, FAST_PACING)
        ?.durationSeconds,
    ).toBe(0.4);
    // A repeated subject at different framing is not.
    expect(
      chooseTransition('soften', { duplicate: true, shotSizeSteps: 2 }, FAST_PACING)
        ?.durationSeconds,
    ).toBe(0.38);
  });

  it('reveals the opening with a fade', () => {
    expect(chooseTransition('reveal', { isFirstCut: true }, NORMAL_PACING)).toEqual({
      kind: 'fade',
      durationSeconds: 1,
    });
  });

  it('refuses a reveal anywhere but the opening', () => {
    expect(chooseTransition('reveal', { isFirstCut: false }, NORMAL_PACING)).toBeNull();
  });
});

describe('chooseTransition — duration clamps', () => {
  it('clamps scene transitions at both ends', () => {
    // 0.25 × 0.6 = 0.15 → floor.
    expect(chooseTransition('time_jump', {}, 0.6)?.durationSeconds).toBe(0.4);
    // 0.25 × 20 = 5 → ceiling.
    expect(chooseTransition('time_jump', {}, SLOW_PACING)?.durationSeconds).toBe(1.2);
  });

  it('clamps energy transitions at both ends', () => {
    // 0.1 × 0.6 = 0.06 → floor.
    expect(chooseTransition('energy', {}, 0.6)?.durationSeconds).toBe(0.15);
    // 0.1 × 20 = 2 → ceiling.
    expect(chooseTransition('energy', {}, SLOW_PACING)?.durationSeconds).toBe(0.4);
  });

  it('clamps a reveal into the opening range at both ends', () => {
    expect(chooseTransition('reveal', { isFirstCut: true }, 0.6)?.durationSeconds).toBe(0.6);
    expect(chooseTransition('reveal', { isFirstCut: true }, SLOW_PACING)?.durationSeconds).toBe(1);
  });

  it('clamps a soften into its range at both ends', () => {
    expect(chooseTransition('soften', {}, 0.6)?.durationSeconds).toBe(0.3);
    expect(chooseTransition('soften', {}, SLOW_PACING)?.durationSeconds).toBe(0.5);
  });

  it('falls back to a nominal shot length when pacing is unusable', () => {
    const nominal = chooseTransition('time_jump', {}, NORMAL_PACING);
    for (const pacing of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(chooseTransition('time_jump', {}, pacing)).toEqual(nominal);
    }
  });
});

describe('chooseTransition — direction', () => {
  it('takes the travel from the outgoing camera movement', () => {
    // A pan or a tracking shot travels sideways; a tilt travels vertically.
    expect(
      chooseTransition('energy', { outgoingCameraMovement: 'pan', index: 0 }, NORMAL_PACING),
    ).toEqual({ kind: 'push', durationSeconds: 0.4 });
    expect(
      chooseTransition('energy', { outgoingCameraMovement: 'tracking', index: 0 }, NORMAL_PACING)
        ?.kind,
    ).toBe('push');
    expect(
      chooseTransition('energy', { outgoingCameraMovement: 'tilt', index: 0 }, NORMAL_PACING)?.kind,
    ).toBe('push-up');
    // A camera already pushing in hands the cut its own zoom, whatever the index.
    for (const index of [0, 1]) {
      expect(
        chooseTransition('energy', { outgoingCameraMovement: 'zoom', index }, NORMAL_PACING)?.kind,
      ).toBe('smooth-zoom');
    }
  });

  it('alternates on the cut index when nothing measured gives a direction', () => {
    const kinds = [0, 1, 2, 3].map(
      (index) => chooseTransition('energy', { index }, NORMAL_PACING)?.kind,
    );
    expect(kinds).toEqual(['smooth-zoom', 'zoom-out', 'smooth-zoom', 'zoom-out']);

    const panned = [0, 1, 2].map(
      (index) =>
        chooseTransition('energy', { outgoingCameraMovement: 'pan', index }, NORMAL_PACING)?.kind,
    );
    expect(panned).toEqual(['push', 'push-right', 'push']);
  });

  it('takes the wipe direction from the same travel', () => {
    const cut: MeasuredCut = { motionChange: 'up', outgoingCameraMovement: 'pan', index: 0 };
    const left = chooseTransition('location_change', cut, FAST_PACING);
    const right = chooseTransition('location_change', { ...cut, index: 1 }, FAST_PACING);
    // Asserted through the catalog rather than by id: which entry represents a
    // right-facing wipe is the catalog's call, and it currently answers with the
    // recommended soft one rather than the plain one.
    expect(directionOf(left?.kind)).toBe('left');
    expect(directionOf(right?.kind)).toBe('right');
  });
});

/** A spread of cuts wide enough to reach every branch of the policy. */
const CUT_MATRIX: readonly MeasuredCut[] = [
  {},
  { isFirstCut: true },
  { lumaDelta: -0.5, incomingIsDark: true, isFirstCut: true },
  { lumaDelta: 0.5, outgoingIsDark: true, warmthDelta: -0.4, isFirstCut: true },
  { motionChange: 'up', isFirstCut: true },
  { motionChange: 'down', shotSizeSteps: -3, isFirstCut: true },
  { outgoingCameraMovement: 'pan', motionChange: 'up', index: 1, isFirstCut: true },
  { outgoingCameraMovement: 'tilt', index: 2, isFirstCut: true },
  { outgoingCameraMovement: 'tracking', motionChange: 'up', index: 3, isFirstCut: true },
  { outgoingCameraMovement: 'zoom', isFirstCut: true },
  { outgoingCameraMovement: 'handheld', jumpCut: true, isFirstCut: true },
  { duplicate: true, shotSizeSteps: 0, isFirstCut: true },
];

const PACINGS = [0.4, FAST_PACING, NORMAL_PACING, SLOW_PACING];

describe('chooseTransition — invariants over the whole matrix', () => {
  it('only ever returns a kind the catalog actually holds', () => {
    let returned = 0;
    for (const reason of TRANSITION_REASONS) {
      for (const cut of CUT_MATRIX) {
        for (const pacing of PACINGS) {
          const choice = chooseTransition(reason, cut, pacing);
          if (choice === null) continue;
          returned += 1;
          const entry = getTransition(choice.kind);
          expect(
            entry,
            `${reason} chose an id the catalog does not hold: ${choice.kind}`,
          ).toBeDefined();
          // The hard cut is a removal, never something to add.
          expect(entry?.isCut).not.toBe(true);
          expect(choice.durationSeconds).toBeGreaterThan(0);
        }
      }
    }
    // Continuity is the only reason that never returns a choice.
    expect(returned).toBe((TRANSITION_REASONS.length - 1) * CUT_MATRIX.length * PACINGS.length);
  });

  it('is deterministic: the same inputs give an identical result twice', () => {
    for (const reason of TRANSITION_REASONS) {
      for (const cut of CUT_MATRIX) {
        for (const pacing of PACINGS) {
          const first = chooseTransition(reason, cut, pacing);
          const second = chooseTransition(reason, cut, pacing);
          expect(second).toEqual(first);
        }
      }
    }
  });

  it('never returns a transition for continuity, for any cut at any pace', () => {
    const reason: TransitionReason = 'continuity';
    for (const cut of CUT_MATRIX) {
      for (const pacing of PACINGS) {
        expect(chooseTransition(reason, cut, pacing)).toBeNull();
      }
    }
  });
});
