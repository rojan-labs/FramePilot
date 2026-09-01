import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe } from '@framepilot/timeline-schema';
import { clipKeyframeIntent, selectionKeyframeIntent } from './clip-keyframe-toggle.js';

const kf = (property: string, time: number, value: number): Keyframe =>
  ({ id: `${property}_${time}`, property, time, value, easing: 'linear' }) as Keyframe;

const clip = (keyframes: Keyframe[] = []): Clip =>
  ({
    id: 'c1',
    assetId: 'a',
    trackId: 't',
    start: 2,
    end: 8,
    sourceStart: 0,
    sourceEnd: 6,
    effects: [],
    keyframes,
  }) as Clip;

describe('clipKeyframeIntent', () => {
  it('seeds the whole transform set on a clip that is not animated yet', () => {
    const intent = clipKeyframeIntent(clip(), 3);
    expect(intent.kind).toBe('add');
    if (intent.kind !== 'add') return;
    expect(intent.writes.map((w) => w.property).sort()).toEqual([
      'opacity',
      'rotation',
      'scale',
      'x',
      'y',
    ]);
    // Identity values, so recording a pose does not move the picture.
    expect(intent.writes.find((w) => w.property === 'scale')?.value).toBe(1);
    expect(intent.writes.find((w) => w.property === 'x')?.value).toBe(0);
  });

  it('touches only the properties the clip already animates', () => {
    // Adding `opacity` to a clip that is only being scaled would pin a value the
    // user never asked to animate.
    const intent = clipKeyframeIntent(clip([kf('scale', 0, 1), kf('scale', 4, 2)]), 2);
    expect(intent.kind).toBe('add');
    if (intent.kind !== 'add') return;
    expect(intent.writes.map((w) => w.property)).toEqual(['scale']);
  });

  it('records the value the curve already has, so the picture does not jump', () => {
    // scale ramps 1 → 2 across 0–4s; at 2s the curve reads 1.5.
    const intent = clipKeyframeIntent(clip([kf('scale', 0, 1), kf('scale', 4, 2)]), 2);
    if (intent.kind !== 'add') throw new Error('expected add');
    expect(intent.writes[0]?.value).toBeCloseTo(1.5, 5);
  });

  it('removes instead of adding when the playhead already sits on a keyframe', () => {
    const intent = clipKeyframeIntent(clip([kf('scale', 4, 2), kf('opacity', 4, 0.5)]), 4);
    expect(intent.kind).toBe('remove');
    if (intent.kind !== 'remove') return;
    expect(intent.removals).toEqual([
      { clipId: 'c1', property: 'scale', time: 4 },
      { clipId: 'c1', property: 'opacity', time: 4 },
    ]);
  });

  it('is a toggle: pressing twice at the same time leaves nothing behind', () => {
    const first = clipKeyframeIntent(clip(), 3);
    expect(first.kind).toBe('add');
    const after = clip([kf('scale', 3, 1), kf('x', 3, 0)]);
    expect(clipKeyframeIntent(after, 3).kind).toBe('remove');
  });

  it('does nothing when the playhead is outside the clip', () => {
    // The button is disabled rather than writing a keyframe at a time the clip
    // does not cover.
    // The clip spans 2s–8s, so clip-relative time runs 0–6.
    expect(clipKeyframeIntent(clip(), -1).kind).toBe('none');
    expect(clipKeyframeIntent(clip(), 7).kind).toBe('none');
  });

  it('treats the clip end as inside and anything past it as outside', () => {
    expect(clipKeyframeIntent(clip(), 6).kind).toBe('add'); // exactly the duration
    expect(clipKeyframeIntent(clip(), 6.01).kind).toBe('none');
    expect(clipKeyframeIntent(clip(), Number.NaN).kind).toBe('none');
  });
});

describe('selectionKeyframeIntent', () => {
  const at = (id: string, start: number, end: number, keyframes: Keyframe[] = []): Clip =>
    ({
      id,
      assetId: 'a',
      trackId: 't',
      start,
      end,
      sourceStart: 0,
      sourceEnd: end - start,
      effects: [],
      keyframes,
    }) as Clip;

  it('acts only on the clips the playhead is actually inside', () => {
    // Selecting a clip does not make it animatable at a time it does not cover,
    // and writing a keyframe clamped to some other clip's edge would be worse
    // than doing nothing.
    const result = selectionKeyframeIntent([at('a', 0, 5), at('b', 10, 15)], 3);
    expect(result.kind).toBe('add');
    expect(result.plans.map((p) => p.clipId)).toEqual(['a']);
  });

  it('reports none when the playhead is inside nothing selected', () => {
    expect(selectionKeyframeIntent([at('a', 0, 5), at('b', 10, 15)], 7).kind).toBe('none');
    expect(selectionKeyframeIntent([], 3).kind).toBe('none');
  });

  it('adds to ALL when the selection is mixed, resolving toward uniform', () => {
    // The alternative — toggling each clip independently — means one press both
    // adds and removes, and the user cannot predict what they ended up with.
    const animated = at('a', 0, 5, [kf('scale', 3, 2)]);
    const plain = at('b', 0, 5);
    const result = selectionKeyframeIntent([animated, plain], 3);
    expect(result.kind).toBe('add');
    expect(result.plans.map((p) => p.clipId)).toEqual(['a', 'b']);
  });

  it('removes only when EVERY participating clip has a keyframe there', () => {
    const result = selectionKeyframeIntent(
      [at('a', 0, 5, [kf('scale', 3, 2)]), at('b', 0, 5, [kf('x', 3, 10)])],
      3,
    );
    expect(result.kind).toBe('remove');
    expect(result.plans).toHaveLength(2);
  });

  it('gives each clip its own clip-relative time', () => {
    // The clips start at different places, so one playhead is a different offset
    // in each — writing both at the same number would misplace one of them.
    const result = selectionKeyframeIntent([at('a', 0, 10), at('b', 2, 10)], 4);
    expect(result.plans.map((p) => p.clipTime)).toEqual([4, 2]);
  });
});
