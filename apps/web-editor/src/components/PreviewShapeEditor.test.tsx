/**
 * The on-monitor shape handles (plan/elements EL4a): a box shape in the bounding box (move, resize
 * keeping the aspect unless Shift, turn), a line or arrow by its two ends; one commit per gesture
 * and arrow-key nudges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { presetShapeParams } from '@framepilot/timeline-schema';
import { PreviewShapeEditor } from './PreviewShapeEditor.js';

const RESOLUTION = { width: 1280, height: 720 };
const IDENTITY = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 };

function frameRect(): void {
  // jsdom lays nothing out: give the handle layer's frame a real size.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1280,
    bottom: 720,
    width: 1280,
    height: 720,
    toJSON: () => ({}),
  } as DOMRect);
}

/** A handle by its position class: `se`, `n`, … on a box; `end-start`, `end-end` on a line. */
const handle = (which: string): HTMLElement => {
  const [kind, end] = which.startsWith('end-') ? ['is-end', which.slice(4)] : [`is-${which}`, ''];
  const selector =
    end === ''
      ? `.preview-shape-handle.${kind}`
      : `.preview-shape-handle.${kind}[data-end="${end}"]`;
  return document.querySelector<HTMLElement>(selector)!;
};

function mount(presetId: string, onCommit = vi.fn()) {
  render(
    <div>
      <PreviewShapeEditor
        clipId="s1"
        name={presetId.startsWith('line') ? 'Arrow' : 'Highlight box'}
        params={presetShapeParams(presetId)!}
        resolution={RESOLUTION}
        transform={IDENTITY}
        onCommit={onCommit}
      />
    </div>,
  );
  return onCommit;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Drag `target` from one frame point to another (the frame is shown at 100 %). */
function drag(target: Element, from: [number, number], to: [number, number], extra = {}) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    button: 0,
    clientX: from[0],
    clientY: from[1],
    ...extra,
  });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: to[0], clientY: to[1], ...extra });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: to[0], clientY: to[1], ...extra });
}

describe('PreviewShapeEditor — a box shape in the bounding box', () => {
  // rounded-rect/highlight: centre 50 % × 50 %, 48 × 27 % of the height: 345.6 × 194.4 px.
  it('commits one move for one drag of the box', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    drag(screen.getByRole('group', { name: 'Move Highlight box' }), [640, 360], [768, 432]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ params: { x: 60, y: 60 } });
  });

  it('commits nothing for a click without movement', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    drag(screen.getByRole('group', { name: 'Move Highlight box' }), [640, 360], [641, 360]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps the aspect from a corner, anchored at the opposite corner', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    drag(screen.getByLabelText('Resize handle se'), [812.8, 457.2], [985.6, 457.2]);
    expect(onCommit).toHaveBeenCalledWith({
      params: { x: 56.75, y: 56.75, width: 72, height: 40.5 },
    });
  });

  it('stretches with Shift: a shape takes a new width and height natively', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    drag(screen.getByLabelText('Resize handle se'), [812.8, 457.2], [985.6, 457.2], {
      shiftKey: true,
    });
    expect(onCommit).toHaveBeenCalledWith({ params: { x: 56.75, width: 72 } });
  });

  it('turns the shape with the lollipop', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    drag(screen.getByLabelText('Rotate Highlight box'), [740, 360], [640, 260]);
    const [{ params, transform }] = onCommit.mock.calls[0]!;
    expect(params).toBeUndefined();
    expect(transform.rotation).toBeCloseTo(90);
  });

  it('nudges a pixel with the arrows, ten with Shift', () => {
    const onCommit = mount('rounded-rect/highlight');
    const box = screen.getByRole('group', { name: 'Move Highlight box' });
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    fireEvent.keyDown(box, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit.mock.calls).toEqual([[{ params: { x: 50.08 } }], [{ params: { y: 48.61 } }]]);
  });

  it('names the shape by what it is and offers its handles to the keyboard', () => {
    mount('rounded-rect/highlight');
    const box = screen.getByRole('group', { name: 'Move Highlight box' });
    expect(box.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown ArrowLeft ArrowRight');
    expect(box.getAttribute('tabindex')).toBe('0');
    expect(screen.getByLabelText('Resize handle se').getAttribute('tabindex')).toBe('0');
  });
});

describe('PreviewShapeEditor — a line by its ends', () => {
  it('gives a segment two end handles that move one end each', () => {
    frameRect();
    const onCommit = mount('line-arrow/red');
    const end = handle('end-end');
    fireEvent.pointerDown(end, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 128, clientY: 0, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith({ params: { x2: 60, y2: 50 } });
    expect(handle('end-start')).toBeDefined();
  });

  it('names a line by what it is, and hides its end handles', () => {
    mount('line-arrow/red');
    expect(screen.getByRole('button', { name: 'Move Arrow' })).toBeDefined();
    expect(handle('end-start').getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps a nudge from also reaching the editor-wide shortcuts', () => {
    const onCommit = mount('line-arrow/red');
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Arrow' }), {
      key: 'ArrowRight',
    });
    window.removeEventListener('keydown', onWindowKey);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onWindowKey).not.toHaveBeenCalled();
  });
});
