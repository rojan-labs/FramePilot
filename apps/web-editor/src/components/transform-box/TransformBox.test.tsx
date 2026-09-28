/**
 * The bounding box as a user drives it: a click is not a drag, a drag commits once on release in
 * project pixels whatever the monitor's zoom, corners keep the aspect until Shift is held, the
 * lollipop turns the layer, and the keyboard does all three.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TransformBox } from './TransformBox.js';
import type { Box } from '../../preview/transform-box/geometry.js';

const RESOLUTION = { width: 1920, height: 1080 };
const BOX: Box = { cx: 960, cy: 540, width: 400, height: 200, rotation: 0 };

/** Render the box inside a frame element shown at half size (960 × 540 at 100, 50). */
function renderBox(props: Partial<Parameters<typeof TransformBox>[0]> = {}) {
  const onCommit = vi.fn();
  const onPreview = vi.fn();
  const view = render(
    <div data-testid="frame">
      <TransformBox
        box={BOX}
        resolution={RESOLUTION}
        label="Transform clip"
        onCommit={onCommit}
        onPreview={onPreview}
        snapping={false}
        {...props}
      />
    </div>,
  );
  const frame = screen.getByTestId('frame');
  frame.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: 960, height: 540, right: 1060, bottom: 590 }) as DOMRect;
  return { ...view, onCommit, onPreview };
}

/** Screen position of a project point on the half-size frame. */
const screenOf = (x: number, y: number) => ({ clientX: 100 + x / 2, clientY: 50 + y / 2 });

function drag(
  target: Element,
  from: { clientX: number; clientY: number },
  to: typeof from,
  extra = {},
) {
  fireEvent.pointerDown(target, { pointerId: 1, button: 0, ...from, ...extra });
  fireEvent.pointerMove(target, { pointerId: 1, ...to, ...extra });
  fireEvent.pointerUp(target, { pointerId: 1, ...to, ...extra });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe('TransformBox', () => {
  it('treats a press that barely moves as a click, not a move', () => {
    const { onCommit } = renderBox();
    const box = screen.getByRole('group', { name: 'Transform clip' });
    drag(box, screenOf(960, 540), { clientX: 581, clientY: 321 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('moves by project pixels: ten screen pixels on a half-size monitor are twenty', () => {
    const { onCommit } = renderBox();
    const box = screen.getByRole('group', { name: 'Transform clip' });
    drag(box, screenOf(960, 540), { clientX: 590, clientY: 320 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [committed, gesture] = onCommit.mock.calls[0]!;
    expect(gesture).toEqual({ kind: 'move' });
    expect(committed).toMatchObject({ cx: 980, cy: 540, width: 400, height: 200 });
  });

  it('keeps the aspect from a corner, and stretches with Shift', () => {
    const uniform = renderBox();
    drag(screen.getByLabelText('Resize handle se'), screenOf(1160, 640), screenOf(1360, 700));
    const [kept, keptGesture] = uniform.onCommit.mock.calls[0]!;
    expect(keptGesture).toMatchObject({ kind: 'resize', handle: 'se', uniform: true });
    expect(kept.width).toBeCloseTo(600);
    expect(kept.height).toBeCloseTo(300);
    uniform.unmount();

    const free = renderBox();
    drag(screen.getByLabelText('Resize handle se'), screenOf(1160, 640), screenOf(1360, 700), {
      shiftKey: true,
    });
    const [stretched, gesture] = free.onCommit.mock.calls[0]!;
    expect(gesture).toMatchObject({ kind: 'resize', uniform: false });
    expect(stretched.width).toBeCloseTo(600);
    expect(stretched.height).toBeCloseTo(260);
  });

  it('turns about the centre from the lollipop', () => {
    const { onCommit } = renderBox();
    drag(screen.getByLabelText('Rotate'), screenOf(1060, 540), screenOf(960, 440));
    const [turned, gesture] = onCommit.mock.calls[0]!;
    expect(gesture).toEqual({ kind: 'rotate' });
    expect(turned.rotation).toBeCloseTo(90);
  });

  it('shows the live box while dragging and clears it on release', () => {
    const { onPreview } = renderBox();
    const box = screen.getByRole('group', { name: 'Transform clip' });
    fireEvent.pointerDown(box, { pointerId: 1, button: 0, ...screenOf(960, 540) });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 600, clientY: 320 });
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ cx: 1000 }), {
      kind: 'move',
    });
    expect(box.getAttribute('class')).toContain('is-move');
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 600, clientY: 320 });
    expect(onPreview).toHaveBeenLastCalledWith(null, { kind: 'move' });
  });

  it('commits nothing when the gesture is cancelled', () => {
    const { onCommit } = renderBox();
    const box = screen.getByRole('group', { name: 'Transform clip' });
    fireEvent.pointerDown(box, { pointerId: 1, button: 0, ...screenOf(960, 540) });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 640, clientY: 320 });
    fireEvent.pointerCancel(box, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('nudges, scales and turns from the keyboard', () => {
    const { onCommit } = renderBox();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Transform clip' }), { key: 'ArrowRight' });
    expect(onCommit.mock.calls[0]![0]).toMatchObject({ cx: 961 });
    fireEvent.keyDown(screen.getByLabelText('Resize handle ne'), {
      key: 'ArrowUp',
      shiftKey: true,
    });
    expect(onCommit.mock.calls[1]![0].width).toBeCloseTo(440);
    fireEvent.keyDown(screen.getByLabelText('Rotate'), { key: 'ArrowUp' });
    expect(onCommit.mock.calls[2]![0]).toMatchObject({ rotation: 1 });
  });

  it('points each handle cursor along the way it pulls, turned with the box', () => {
    renderBox({ box: { ...BOX, rotation: 90 } });
    expect(screen.getByLabelText('Resize handle e').style.cursor).toBe('ns-resize');
    expect(screen.getByLabelText('Resize handle n').style.cursor).toBe('ew-resize');
  });

  it('draws no handles and takes no gesture while passive', () => {
    const { onCommit } = renderBox({ interactive: false });
    expect(screen.queryByLabelText('Rotate')).toBeNull();
    const box = screen.getByRole('group', { name: 'Transform clip' });
    drag(box, screenOf(960, 540), { clientX: 640, clientY: 320 });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
