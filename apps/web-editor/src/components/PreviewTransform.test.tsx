/**
 * Tests for the on-canvas transform controls (H4): pure gesture math (box
 * geometry, move mapping, proportional corner scaling with clamping) and the
 * commit contract (one commit per completed gesture; no commit for a dead click).
 *
 * Revamp Phase 3 adds rotation, axis-constrain, snapping with alignment guides,
 * and reset. The rotation-direction case matters most: screen space is y-down so
 * `atan2` increases clockwise, while project rotation is anticlockwise-positive —
 * get the sign wrong and the clip turns the opposite way from the hand moving it.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  PreviewTransform,
  TRANSFORM_SCALE_BOUNDS,
  cornerGestureTransform,
  moveGestureTransform,
  rotateGestureTransform,
  transformBoxRotation,
  transformBoxStyle,
} from './PreviewTransform.js';

const RES = { width: 1000, height: 2000 };
const IDENTITY = { scale: 1, x: 0, y: 0 };

describe('transformBoxStyle', () => {
  it('centers an identity transform over the full frame', () => {
    expect(transformBoxStyle(IDENTITY, RES)).toEqual({
      left: '0%',
      top: '0%',
      width: '100%',
      height: '100%',
    });
  });

  it('offsets and shrinks with x/y/scale in canvas units', () => {
    expect(transformBoxStyle({ scale: 0.5, x: 100, y: -200 }, RES)).toEqual({
      left: '35%', // 50 + 10 - 25
      top: '15%', // 50 - 10 - 25
      width: '50%',
      height: '50%',
    });
  });
});

describe('moveGestureTransform', () => {
  it('maps frame-pixel deltas to canvas-pixel offsets', () => {
    const next = moveGestureTransform(
      IDENTITY,
      { dx: 50, dy: -25 },
      { width: 500, height: 500 },
      RES,
    );
    expect(next).toEqual({ scale: 1, x: 100, y: -100 });
  });

  it('is a no-op for a degenerate frame', () => {
    expect(moveGestureTransform(IDENTITY, { dx: 10, dy: 10 }, { width: 0, height: 0 }, RES)).toBe(
      IDENTITY,
    );
  });
});

describe('cornerGestureTransform', () => {
  it('scales proportionally by the pointer distance ratio', () => {
    expect(cornerGestureTransform({ ...IDENTITY, scale: 2 }, 100, 150).scale).toBe(3);
  });

  it('clamps to the scale bounds and guards a zero start distance', () => {
    expect(cornerGestureTransform(IDENTITY, 100, 100000).scale).toBe(TRANSFORM_SCALE_BOUNDS.max);
    expect(cornerGestureTransform(IDENTITY, 100, 0.0001).scale).toBe(TRANSFORM_SCALE_BOUNDS.min);
    expect(cornerGestureTransform(IDENTITY, 0, 50)).toBe(IDENTITY);
  });
});

describe('PreviewTransform gestures', () => {
  // The `PointerEvent` polyfill and the pointer-capture no-ops live in
  // `src/test-setup.ts` now — this file used to alias `PointerEvent = MouseEvent`
  // locally, which rescued clientX/Y but left `pointerId` undefined (so the
  // multi-pointer guard was satisfied only because `undefined !== undefined`).
  const mockRects = (box: HTMLElement): void => {
    const frame = box.parentElement as HTMLElement;
    frame.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500 }) as DOMRect;
    box.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500 }) as DOMRect;
  };

  it('previews while dragging and commits once on release', () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    render(
      <div className="preview-frame">
        <PreviewTransform
          value={IDENTITY}
          resolution={RES}
          onPreview={onPreview}
          onCommit={onCommit}
        />
      </div>,
    );
    const box = screen.getByRole('group', { name: 'Transform selected clip' });
    mockRects(box);
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(onPreview).toHaveBeenCalledWith({ scale: 1, x: 100, y: 0 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ scale: 1, x: 100, y: 0 });
  });

  it('does not commit a click that never moved', () => {
    const onCommit = vi.fn();
    render(
      <div className="preview-frame">
        <PreviewTransform
          value={IDENTITY}
          resolution={RES}
          onPreview={() => {}}
          onCommit={onCommit}
        />
      </div>,
    );
    const box = screen.getByRole('group', { name: 'Transform selected clip' });
    mockRects(box);
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('scales from a corner handle proportionally', () => {
    const onCommit = vi.fn();
    render(
      <div className="preview-frame">
        <PreviewTransform
          value={IDENTITY}
          resolution={RES}
          onPreview={() => {}}
          onCommit={onCommit}
        />
      </div>,
    );
    const box = screen.getByRole('group', { name: 'Transform selected clip' });
    mockRects(box);
    const handle = screen.getByRole('slider', { name: 'Resize handle se' });
    // Box center is (250,250); start at distance 100, drag to distance 200 → ×2.
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 350, clientY: 250 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 450, clientY: 250 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 450, clientY: 250 });
    expect(onCommit).toHaveBeenCalledWith({ scale: 2, x: 0, y: 0 });
  });
});

// --- Revamp Phase 3: rotation, constrain, snapping, reset -------------------

describe('transformBoxRotation', () => {
  it('stamps no transform for an unrotated clip', () => {
    // An unrotated box must not carry a transform at all, so it composes cleanly
    // with whatever else the frame is doing.
    expect(transformBoxRotation({ scale: 1, x: 0, y: 0 })).toBeUndefined();
    expect(transformBoxRotation({ scale: 1, x: 0, y: 0, rotation: 0 })).toBeUndefined();
  });

  it('NEGATES: the project turns anticlockwise, CSS clockwise', () => {
    // Same conversion the compositor applies (rotationToCssDegrees) — if the box
    // and the picture disagreed, the box would frame the clip at the wrong angle.
    expect(transformBoxRotation({ scale: 1, x: 0, y: 0, rotation: 30 })).toBe('rotate(-30deg)');
    expect(transformBoxRotation({ scale: 1, x: 0, y: 0, rotation: -45 })).toBe('rotate(45deg)');
  });
});

describe('rotateGestureTransform', () => {
  const quarter = Math.PI / 2;

  it('turns the clip the SAME way as the hand', () => {
    // A clockwise sweep on screen (atan2 increasing) must DECREASE the stored
    // anticlockwise-positive rotation. If this flips, the clip spins backwards.
    expect(rotateGestureTransform(IDENTITY, 0, quarter).rotation).toBeCloseTo(-90, 10);
    expect(rotateGestureTransform(IDENTITY, 0, -quarter).rotation).toBeCloseTo(90, 10);
  });

  it('accumulates on top of the clip’s existing rotation', () => {
    const base = { ...IDENTITY, rotation: 45 };
    expect(rotateGestureTransform(base, 0, -quarter).rotation).toBeCloseTo(135, 10);
  });

  it('snaps to 15° increments when constrained, and is free otherwise', () => {
    // ~5.7° of sweep: free-form keeps it, constrained rounds it to nothing.
    const small = 0.1;
    expect(rotateGestureTransform(IDENTITY, 0, -small).rotation).toBeCloseTo(5.7296, 3);
    expect(rotateGestureTransform(IDENTITY, 0, -small, true).rotation).toBe(0);
    // Just past the halfway point rounds up to the first increment.
    expect(rotateGestureTransform(IDENTITY, 0, -0.14, true).rotation).toBe(15);
  });

  it('normalizes so a readout never shows 725°', () => {
    const base = { ...IDENTITY, rotation: 170 };
    expect(rotateGestureTransform(base, 0, -quarter).rotation).toBeCloseTo(-100, 10);
  });

  it('leaves position and scale untouched', () => {
    const base = { scale: 2, x: 50, y: -25 };
    const next = rotateGestureTransform(base, 0, -quarter);
    expect(next.scale).toBe(2);
    expect(next.x).toBe(50);
    expect(next.y).toBe(-25);
  });
});

describe('moveGestureTransform — axis constrain', () => {
  const FRAME = { width: 500, height: 500 };

  it('locks to the dominant axis when constrained', () => {
    const horizontal = moveGestureTransform(IDENTITY, { dx: 50, dy: 10 }, FRAME, RES, true);
    expect(horizontal.y).toBe(0);
    expect(horizontal.x).toBe(100);

    const vertical = moveGestureTransform(IDENTITY, { dx: 10, dy: 50 }, FRAME, RES, true);
    expect(vertical.x).toBe(0);
    expect(vertical.y).toBe(200);
  });

  it('does not pick an axis inside the deadzone', () => {
    // Below the deadzone the dominant axis flickers on sub-pixel jitter, which
    // reads as the constraint being broken — so both axes stay live.
    const next = moveGestureTransform(IDENTITY, { dx: 2, dy: 1 }, FRAME, RES, true);
    expect(next.x).not.toBe(0);
    expect(next.y).not.toBe(0);
  });

  it('resolves the dominant axis from PIXELS, not project units', () => {
    // RES is 1000×2000, so equal pixel deltas convert to unequal project offsets.
    // The user means "the direction my hand is moving", so pixels decide.
    const next = moveGestureTransform(IDENTITY, { dx: 30, dy: 20 }, FRAME, RES, true);
    expect(next.y).toBe(0);
  });

  it('moves both axes when unconstrained', () => {
    const next = moveGestureTransform(IDENTITY, { dx: 50, dy: 10 }, FRAME, RES);
    expect(next.x).toBe(100);
    expect(next.y).toBe(40);
  });
});

describe('PreviewTransform — rotation, snapping and reset', () => {
  /** A 500×500 frame with the box filling it; box centre at (250,250). */
  const mockRects = (box: HTMLElement): void => {
    const rect = { left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500 } as DOMRect;
    (box.parentElement as HTMLElement).getBoundingClientRect = () => rect;
    box.getBoundingClientRect = () => rect;
  };

  function setup(props: Partial<React.ComponentProps<typeof PreviewTransform>> = {}): {
    onCommit: ReturnType<typeof vi.fn>;
    onPreview: ReturnType<typeof vi.fn>;
    container: HTMLElement;
    box: HTMLElement;
  } {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    const { container } = render(
      <div className="preview-frame">
        <PreviewTransform
          value={IDENTITY}
          resolution={RES}
          onPreview={onPreview}
          onCommit={onCommit}
          {...props}
        />
      </div>,
    );
    const box = screen.getByRole('group', { name: 'Transform selected clip' });
    mockRects(box);
    return { onCommit, onPreview, container, box };
  }

  it('offers a rotation handle with its angle in ARIA', () => {
    render(
      <div className="preview-frame">
        <PreviewTransform
          value={{ scale: 1, x: 0, y: 0, rotation: 30 }}
          resolution={RES}
          onPreview={() => {}}
          onCommit={() => {}}
        />
      </div>,
    );
    const handle = screen.getByRole('slider', { name: 'Rotate clip' });
    expect(handle.getAttribute('aria-valuenow')).toBe('30');
    expect(handle.getAttribute('aria-valuetext')).toBe('30°');
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  it('rotates on a handle drag and commits once', () => {
    const { onCommit, box } = setup();
    const handle = screen.getByRole('slider', { name: 'Rotate clip' });
    // Start above the centre (angle −90°), sweep to the right (angle 0°): a
    // clockwise sweep of +90°, so the project rotation goes to −90°.
    fireEvent.pointerDown(handle, { pointerId: 5, clientX: 250, clientY: 150 });
    fireEvent.pointerMove(handle, { pointerId: 5, clientX: 350, clientY: 250 });
    fireEvent.pointerUp(handle, { pointerId: 5, clientX: 350, clientY: 250 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0].rotation).toBeCloseTo(-90, 6);
    expect(box).toBeTruthy();
  });

  it('shows a live angle readout only while rotating', () => {
    const { container } = setup();
    expect(container.querySelector('.preview-transform-readout')).toBeNull();
    const handle = screen.getByRole('slider', { name: 'Rotate clip' });
    fireEvent.pointerDown(handle, { pointerId: 5, clientX: 250, clientY: 150 });
    fireEvent.pointerMove(handle, { pointerId: 5, clientX: 350, clientY: 250 });
    expect(container.querySelector('.preview-transform-readout')?.textContent).toBe('-90°');
    fireEvent.pointerUp(handle, { pointerId: 5, clientX: 350, clientY: 250 });
    expect(container.querySelector('.preview-transform-readout')).toBeNull();
  });

  it('snaps a move to the frame centre and draws a guide', () => {
    const { onCommit, container, box } = setup();
    // Drag a few px off centre: inside the 1.5%-of-1000 = 15 project px tolerance.
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 250, clientY: 250 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 253, clientY: 252 });
    // Both axes snapped back to 0, and both guides are showing.
    expect(container.querySelector('.preview-align-guide--v')).not.toBeNull();
    expect(container.querySelector('.preview-align-guide--h')).not.toBeNull();
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 253, clientY: 252 });
    // Snapped straight back to identity, so there is nothing to commit.
    expect(onCommit).not.toHaveBeenCalled();
    // Guides are gone at rest — the canvas is clean when no gesture is running.
    expect(container.querySelector('.preview-align-guide--v')).toBeNull();
  });

  it('Alt defeats snapping mid-drag', () => {
    const { onCommit, container, box } = setup();
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 250, clientY: 250 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 253, clientY: 250, altKey: true });
    expect(container.querySelector('.preview-align-guide--v')).toBeNull();
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 253, clientY: 250 });
    // 3px of 500 over a 1000-wide project = 6 project px, committed unsnapped.
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ x: 6 }));
  });

  it('Alt ENABLES snapping when the preference is off (it inverts, not disables)', () => {
    const { container, box } = setup({ snapping: false });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 250, clientY: 250 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 253, clientY: 250 });
    expect(container.querySelector('.preview-align-guide--v')).toBeNull();
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 253, clientY: 250, altKey: true });
    expect(container.querySelector('.preview-align-guide--v')).not.toBeNull();
  });

  it('resets position, scale and rotation as one commit', () => {
    const onCommit = vi.fn();
    render(
      <div className="preview-frame">
        <PreviewTransform
          value={{ scale: 2, x: 100, y: -50, rotation: 30 }}
          resolution={RES}
          onPreview={() => {}}
          onCommit={onCommit}
        />
      </div>,
    );
    fireEvent.click(screen.getByLabelText('reset clip transform'));
    expect(onCommit).toHaveBeenCalledWith({ scale: 1, x: 0, y: 0, rotation: 0 });
  });

  it('does not commit a reset on an already-identity clip', () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByLabelText('reset clip transform'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not start a drag when the reset button is pressed', () => {
    // The box owns a move gesture on pointerdown; without stopPropagation the
    // button would drag the clip instead of being clicked.
    const { onPreview } = setup({ value: { scale: 2, x: 100, y: 0 } } as never);
    fireEvent.pointerDown(screen.getByLabelText('reset clip transform'), {
      pointerId: 9,
      clientX: 400,
      clientY: 100,
    });
    expect(onPreview).not.toHaveBeenCalled();
  });
});
