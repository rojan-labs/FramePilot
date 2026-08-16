/**
 * The interpolation menu and curve editor (revamp Phase 7, F9 — ADR 0089).
 *
 * The curve *math* is proven in `editor-core`'s `keyframes.test.ts` and mirrored in
 * Python against a committed fixture. What is proven here is the surface: that the
 * graph is behind a disclosure and only offered where it means something, that it
 * plots the engine's own curve rather than an approximation, that overshoot is drawn
 * instead of clipped, and that shaping a curve is completable by keyboard.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Keyframe } from '@framepilot/timeline-schema';
import { segmentProgress } from '@framepilot/editor-core';
import { KeyframeGraphEditor, curveSamples } from './KeyframeGraphEditor.js';

const kf = (
  time: number,
  value: number,
  easing: Keyframe['easing'] = 'linear',
  handles?: Keyframe['handles'],
): Keyframe =>
  ({
    id: `scale_${time}`,
    property: 'scale',
    time,
    value,
    easing,
    ...(handles ? { handles } : {}),
  }) as Keyframe;

const OVERSHOOT = { out: [0.34, 1.56] as [number, number], in: [0.64, 1] as [number, number] };

describe('curveSamples', () => {
  it('plots the ENGINE curve, not an approximation of it', () => {
    // The whole render-honesty point: what you drag has to be what renders, so the
    // plot samples the same `segmentProgress` the evaluator and the Python mirror
    // use — not a separate drawing routine that could drift.
    const left = kf(0, 0, 'bezier', OVERSHOOT);
    const right = kf(1, 1, 'bezier', OVERSHOOT);
    const { points } = curveSamples(left, right);
    for (const [x, y] of points) {
      expect(y).toBeCloseTo(segmentProgress(left, right, x), 12);
    }
  });

  it('expands the y-range to SHOW overshoot rather than clipping it', () => {
    // A curve pinned to the top of the box hides exactly the behaviour the user
    // reached for a custom curve to get.
    const { max } = curveSamples(kf(0, 0, 'bezier', OVERSHOOT), kf(1, 1, 'bezier', OVERSHOOT));
    expect(max).toBeGreaterThan(1);
  });

  it('expands downwards for anticipation', () => {
    const dip = { out: [0.36, -0.4] as [number, number], in: [0.66, 1] as [number, number] };
    const { min } = curveSamples(kf(0, 0, 'bezier', dip), kf(1, 1, 'bezier', dip));
    expect(min).toBeLessThan(0);
  });

  it('keeps the unit range for an ordinary curve', () => {
    const { min, max } = curveSamples(kf(0, 0, 'ease-in-out'), kf(1, 1));
    expect(min).toBe(0);
    expect(max).toBe(1);
  });

  it('draws the identity when there is no following keyframe', () => {
    // A curve into nothing is not a curve; the honest thing is a straight line.
    const { points } = curveSamples(kf(0, 0, 'linear'), null);
    expect(points[0]).toEqual([0, 0]);
    expect(points.at(-1)![1]).toBeCloseTo(1, 10);
  });
});

describe('progressive disclosure', () => {
  const setup = (keyframe: Keyframe) => {
    const onEasingChange = vi.fn();
    const onHandlesChange = vi.fn();
    render(
      <KeyframeGraphEditor
        keyframe={keyframe}
        next={kf(1, 1, keyframe.easing)}
        onEasingChange={onEasingChange}
        onHandlesChange={onHandlesChange}
      />,
    );
    return { onEasingChange, onHandlesChange };
  };

  it('always offers the interpolation menu', () => {
    setup(kf(0, 0, 'linear'));
    expect(screen.getByLabelText('keyframe interpolation')).toBeTruthy();
  });

  it('offers no curve editor for a non-bezier easing', () => {
    // It would store handles the engine then ignores — a control with no effect.
    setup(kf(0, 0, 'ease-in'));
    expect(screen.queryByRole('button', { name: 'Edit curve' })).toBeNull();
  });

  it('hides the graph behind one click for bezier', () => {
    setup(kf(0, 0, 'bezier'));
    const toggle = screen.getByRole('button', { name: 'Edit curve' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('img', { name: /curve/ })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('img', { name: 'scale keyframe curve' })).toBeTruthy();
  });
});

describe('shaping the curve', () => {
  const open = () => {
    const onHandlesChange = vi.fn();
    render(
      <KeyframeGraphEditor
        keyframe={kf(0, 0, 'bezier')}
        next={kf(1, 1, 'bezier')}
        onEasingChange={vi.fn()}
        onHandlesChange={onHandlesChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit curve' }));
    return { onHandlesChange };
  };

  it('is completable by keyboard — arrows move a handle', () => {
    // A curve is exactly the kind of control that is usually pointer-only.
    const { onHandlesChange } = open();
    const handle = screen.getByRole('slider', { name: 'outgoing curve handle' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onHandlesChange).toHaveBeenCalledTimes(1);
    const [written] = onHandlesChange.mock.calls[0]!;
    // y moved up; the untouched incoming handle came along unchanged.
    expect(written.out[1]).toBeCloseTo(1 / 3 + 0.02, 10);
    expect(written.in).toEqual([2 / 3, 2 / 3]);
  });

  it('takes a bigger step with Shift', () => {
    const { onHandlesChange } = open();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'incoming curve handle' }), {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(onHandlesChange.mock.calls[0]![0].in[1]).toBeCloseTo(2 / 3 - 0.1, 10);
  });

  it('clamps x into [0,1] but lets y go past it', () => {
    // ADR 0089: an x outside the unit interval runs the property backwards in time,
    // so it is clamped; a y outside it is overshoot, which is the point of the
    // feature, so it is not.
    const onHandlesChange = vi.fn();
    render(
      <KeyframeGraphEditor
        // Handles already near the edges, so one Shift-step would leave the range.
        keyframe={kf(0, 0, 'bezier', { out: [0.02, 0.95], in: [0.66, 1] })}
        next={kf(1, 1, 'bezier', { out: [0.02, 0.95], in: [0.66, 1] })}
        onEasingChange={vi.fn()}
        onHandlesChange={onHandlesChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit curve' }));
    const handle = screen.getByRole('slider', { name: 'outgoing curve handle' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true }); // 0.02 − 0.1
    expect(onHandlesChange.mock.calls.at(-1)![0].out[0]).toBe(0);

    fireEvent.keyDown(handle, { key: 'ArrowUp', shiftKey: true }); // 0.95 + 0.1
    expect(onHandlesChange.mock.calls.at(-1)![0].out[1]).toBeCloseTo(1.05, 10);
  });

  it('ignores keys that are not arrows', () => {
    const { onHandlesChange } = open();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'outgoing curve handle' }), { key: 'a' });
    expect(onHandlesChange).not.toHaveBeenCalled();
  });

  it('resets to the default smoothstep with null, not with default control points', () => {
    // A reset that WROTE straight handles would leave the project carrying handles
    // that say nothing, and would mean something different from a v13 keyframe.
    const { onHandlesChange } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Reset curve' }));
    expect(onHandlesChange).toHaveBeenCalledWith(null);
  });

  it('announces each handle position for assistive tech', () => {
    open();
    const handle = screen.getByRole('slider', { name: 'outgoing curve handle' });
    expect(handle.getAttribute('aria-valuetext')).toBe('x 0.33, y 0.33');
  });
});
