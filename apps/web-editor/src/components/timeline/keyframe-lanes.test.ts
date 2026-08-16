/**
 * Tests for the keyframe-lane model (revamp Phase 6, F4).
 *
 * The interesting part of a keyframe lane is the arithmetic — where a drag lands,
 * what it snaps to, whether a group still fits inside the clip. Getting any of it
 * wrong loses or silently reshapes a user's animation, so it is tested here rather
 * than through a rendered drag.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe, Marker, Track } from '@framepilot/timeline-schema';
import {
  KEYFRAME_LANE_HEIGHT,
  clampGroupDelta,
  clipKeyframeLanes,
  describeKeyframe,
  isAnimated,
  keyframeKey,
  keyframeSnapTargets,
  parseKeyframeKey,
  snapKeyframeTime,
  trackKeyframeLanesHeight,
} from './keyframe-lanes.js';

const kf = (property: string, time: number, value = 1, easing = 'linear'): Keyframe =>
  ({ id: `${property}_${time}`, property, time, value, easing }) as Keyframe;

const clipWith = (id: string, start: number, end: number, keyframes: Keyframe[]): Clip =>
  ({
    id,
    assetId: 'a',
    trackId: 'v',
    start,
    end,
    sourceStart: 0,
    sourceEnd: end - start,
    effects: [],
    keyframes,
  }) as Clip;

describe('clipKeyframeLanes', () => {
  it('gives each property its OWN lane, so co-located keyframes do not merge', () => {
    // The bug this phase fixes: the old marker code deduplicated by rounded time, so
    // scale and x animating at the same instant showed as one anonymous dot.
    const lanes = clipKeyframeLanes(clipWith('c', 0, 5, [kf('scale', 1), kf('x', 1)]));
    expect(lanes.map((lane) => lane.property)).toEqual(['scale', 'x']);
    expect(lanes.every((lane) => lane.keyframes.length === 1)).toBe(true);
  });

  it('orders lanes by the animatable list, not by first-keyframe time', () => {
    // Stable order matters: lanes must not reorder underneath a user mid-drag.
    const lanes = clipKeyframeLanes(
      clipWith('c', 0, 5, [kf('opacity', 0), kf('rotation', 1), kf('scale', 2)]),
    );
    expect(lanes.map((lane) => lane.property)).toEqual(['scale', 'rotation', 'opacity']);
  });

  it('still gives an unknown property a lane, appended and sorted', () => {
    // A keyframe the UI refuses to show is a keyframe the user cannot delete.
    const lanes = clipKeyframeLanes(
      clipWith('c', 0, 5, [kf('zeta', 0), kf('scale', 0), kf('alpha', 0)]),
    );
    expect(lanes.map((lane) => lane.property)).toEqual(['scale', 'alpha', 'zeta']);
  });

  it('sorts each lane ascending by time', () => {
    const lanes = clipKeyframeLanes(
      clipWith('c', 0, 5, [kf('scale', 3), kf('scale', 1), kf('scale', 2)]),
    );
    expect(lanes[0]!.keyframes.map((k) => k.time)).toEqual([1, 2, 3]);
  });

  it('returns nothing for a still clip', () => {
    expect(clipKeyframeLanes(clipWith('c', 0, 5, []))).toEqual([]);
    expect(isAnimated(clipWith('c', 0, 5, []))).toBe(false);
  });
});

describe('trackKeyframeLanesHeight', () => {
  const track = (clips: Clip[]): Track => ({ id: 'v', type: 'video', clips }) as Track;

  it('is zero when nothing on the track is expanded', () => {
    const t = track([clipWith('a', 0, 5, [kf('scale', 1)])]);
    expect(trackKeyframeLanesHeight(t, new Set())).toBe(0);
  });

  it('takes the MAX across expanded clips, not the sum', () => {
    // Two clips' lane stacks sit side by side in x, so the track only has to be as
    // tall as the deepest one. Summing would leave a wide empty band.
    const t = track([
      clipWith('a', 0, 5, [kf('scale', 1)]),
      clipWith('b', 5, 10, [kf('scale', 1), kf('x', 1), kf('opacity', 1)]),
    ]);
    expect(trackKeyframeLanesHeight(t, new Set(['a', 'b']))).toBe(3 * KEYFRAME_LANE_HEIGHT);
  });

  it('ignores clips that are not expanded', () => {
    const t = track([
      clipWith('a', 0, 5, [kf('scale', 1)]),
      clipWith('b', 5, 10, [kf('scale', 1), kf('x', 1), kf('opacity', 1)]),
    ]);
    expect(trackKeyframeLanesHeight(t, new Set(['a']))).toBe(KEYFRAME_LANE_HEIGHT);
  });
});

describe('keyframeKey / parseKeyframeKey', () => {
  it('round-trips clip, property and time', () => {
    const key = keyframeKey('clip_1', 'scale', 1.25);
    expect(parseKeyframeKey(key)).toEqual({ clipId: 'clip_1', property: 'scale', time: 1.25 });
  });

  it('quantises to whole milliseconds, matching the engine epsilon', () => {
    // A key must identify exactly the keyframe a patch targeting that time would hit.
    expect(keyframeKey('c', 'scale', 1.0004)).toBe(keyframeKey('c', 'scale', 1));
    expect(keyframeKey('c', 'scale', 1.002)).not.toBe(keyframeKey('c', 'scale', 1));
  });

  it('survives a clip id containing the separator', () => {
    // Parsing splits from the right for exactly this reason.
    expect(parseKeyframeKey(keyframeKey('odd|name', 'x', 2))).toEqual({
      clipId: 'odd|name',
      property: 'x',
      time: 2,
    });
  });

  it('rejects a string that is not a key', () => {
    expect(parseKeyframeKey('nonsense')).toBeNull();
    expect(parseKeyframeKey('a|b')).toBeNull();
    expect(parseKeyframeKey('a|b|notanumber')).toBeNull();
  });
});

describe('keyframeSnapTargets', () => {
  const clip = clipWith('c', 10, 20, [kf('scale', 2), kf('x', 4), kf('x', 6)]);

  it('offers the clip edges', () => {
    expect(keyframeSnapTargets(clip, 'scale', null)).toEqual(expect.arrayContaining([0, 10]));
  });

  it("drops a target that collides with one of the dragged lane's own keyframes", () => {
    // Not hypothetical: x@4 and scale@4 animating together is exactly what lanes
    // exist to show, so without this a dragged scale keyframe would be helped onto
    // its own sibling and replace it.
    const collide = clipWith('c', 0, 10, [kf('scale', 4), kf('x', 4), kf('x', 7)]);
    // 4 is occupied in BOTH lanes, so neither offers it.
    expect(keyframeSnapTargets(collide, 'scale', null)).not.toContain(4);
    expect(keyframeSnapTargets(collide, 'x', null)).not.toContain(4);
    // A time only the other lane occupies is still offered: that is the alignment
    // this feature exists for.
    expect(keyframeSnapTargets(collide, 'scale', null)).toContain(7);
  });

  it('offers keyframes in OTHER lanes but never in the dragged one', () => {
    // Landing on a sibling in the same lane would replace it, destroying a keyframe
    // the user was not thinking about. Lining up with another property is the point.
    const targets = keyframeSnapTargets(clip, 'x', null);
    expect(targets).toContain(2); // the scale keyframe
    expect(targets).not.toContain(4); // its own lane
    expect(targets).not.toContain(6);
  });

  it('offers the playhead only when it is over the clip', () => {
    expect(keyframeSnapTargets(clip, 'scale', 5)).toContain(5);
    expect(keyframeSnapTargets(clip, 'scale', 99)).not.toContain(99);
    expect(keyframeSnapTargets(clip, 'scale', -1)).not.toContain(-1);
  });

  it('converts markers from timeline time to clip-relative, dropping off-clip ones', () => {
    const markers = [
      { id: 'm1', time: 13, label: 'beat' },
      { id: 'm2', time: 99, label: 'far' },
    ] as Marker[];
    const targets = keyframeSnapTargets(clip, 'scale', null, markers);
    expect(targets).toContain(3); // 13 − clip.start(10)
    expect(targets).not.toContain(89);
  });
});

describe('snapKeyframeTime', () => {
  it('snaps to the nearest target inside the threshold', () => {
    expect(snapKeyframeTime(2.04, [0, 2, 5], 0.1)).toEqual({ time: 2, snapped: true });
  });

  it('leaves the time alone outside the threshold', () => {
    expect(snapKeyframeTime(2.4, [0, 2, 5], 0.1)).toEqual({ time: 2.4, snapped: false });
  });

  it('reports `snapped: false` when the time is already ON a target', () => {
    // The lane draws its guide only while a snap is in effect; a guide that is always
    // on says nothing.
    expect(snapKeyframeTime(2, [2], 0.1)).toEqual({ time: 2, snapped: false });
  });

  it('picks the closest of several competing targets', () => {
    expect(snapKeyframeTime(2.06, [2, 2.1], 0.2).time).toBe(2.1);
  });

  it('is a no-op with no targets', () => {
    expect(snapKeyframeTime(3, [], 1)).toEqual({ time: 3, snapped: false });
  });
});

describe('clampGroupDelta', () => {
  it('lets a move through when the whole group fits', () => {
    expect(clampGroupDelta([1, 2], 1, 10)).toBe(1);
  });

  it('clamps on the EARLIEST keyframe, keeping the group shape', () => {
    // Clamping each keyframe independently would squash 1s of spacing into 0.2s,
    // which is not a move at all.
    expect(clampGroupDelta([1, 2], -5, 10)).toBe(-1);
  });

  it('clamps on the LATEST keyframe at the clip end', () => {
    expect(clampGroupDelta([1, 8], 5, 10)).toBe(2);
  });

  it('is zero for an empty group', () => {
    expect(clampGroupDelta([], 5, 10)).toBe(0);
  });
});

describe('describeKeyframe', () => {
  it('reads property, value, time and easing', () => {
    expect(describeKeyframe(kf('scale', 1.5, 1.2, 'ease-out'))).toBe(
      'scale 1.2 @ 1.50s · ease-out',
    );
  });

  it('rounds float noise out of the readout without touching the stored value', () => {
    expect(describeKeyframe(kf('scale', 1, 1.2000000000000002))).toContain('scale 1.2 ');
  });
});
