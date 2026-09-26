/**
 * The on-monitor shape handles (plan/elements EL4a): one patch per gesture, arrow-key nudges,
 * and endpoint handles for a segment.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { presetShapeParams } from '@framepilot/timeline-schema';
import { PreviewShapeEditor } from './PreviewShapeEditor.js';

const RESOLUTION = { width: 1280, height: 720 };
const IDENTITY = { x: 0, y: 0, scale: 1, rotation: 0 };

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

describe('PreviewShapeEditor', () => {
  it('commits one move for one drag of the box', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    const body = screen.getByRole('button', { name: 'Move Highlight box' });
    fireEvent.pointerDown(body, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(body, { clientX: 164, clientY: 136, pointerId: 1 });
    fireEvent.pointerMove(body, { clientX: 228, clientY: 172, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(body, { clientX: 228, clientY: 172, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ x: 60, y: 60 });
  });

  it('commits nothing for a click without movement', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    const body = screen.getByRole('button', { name: 'Move Highlight box' });
    fireEvent.pointerDown(body, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(body, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('resizes from a corner handle', () => {
    frameRect();
    const onCommit = mount('rounded-rect/highlight');
    const corner = handle('se');
    fireEvent.pointerDown(corner, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(corner, { clientX: 0, clientY: 72, pointerId: 1 });
    expect(onCommit.mock.calls[0]![0]).toMatchObject({ height: 37 });
  });

  it('nudges with the arrow keys, further with Shift', () => {
    const onCommit = mount('rounded-rect/highlight');
    const body = screen.getByRole('button', { name: 'Move Highlight box' });
    fireEvent.keyDown(body, { key: 'ArrowRight' });
    fireEvent.keyDown(body, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit.mock.calls).toEqual([[{ x: 50.5, y: 50 }], [{ x: 50, y: 45 }]]);
  });

  it('gives a segment two end handles that move one end each', () => {
    frameRect();
    const onCommit = mount('line-arrow/red');
    const end = handle('end-end');
    fireEvent.pointerDown(end, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 128, clientY: 0, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith({ x2: 60, y2: 50 });
    expect(handle('end-start')).toBeDefined();
  });

  it('names the shape by what it is and says how to move it', () => {
    mount('rounded-rect/highlight');
    const body = screen.getByRole('button', { name: 'Move Highlight box' });
    expect(body.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown ArrowLeft ArrowRight');
    expect(body.getAttribute('tabindex')).toBe('0');
  });

  it('keeps the pointer-only handles out of the accessibility tree and the Tab order', () => {
    // Resize and endpoint handles do nothing when activated; the Inspector's Box and Ends
    // fields are the keyboard route to the same edits.
    mount('rounded-rect/highlight');
    for (const corner of ['nw', 'se', 'n', 'w']) {
      const element = handle(corner);
      expect(element.getAttribute('aria-hidden')).toBe('true');
      expect(element.hasAttribute('role')).toBe(false);
      expect(element.hasAttribute('tabindex')).toBe(false);
    }
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('names a line by what it is, and hides its end handles', () => {
    mount('line-arrow/red');
    expect(screen.getByRole('button', { name: 'Move Arrow' })).toBeDefined();
    expect(handle('end-start').getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps a nudge from also reaching the editor-wide shortcuts', () => {
    const onCommit = mount('rounded-rect/highlight');
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Highlight box' }), {
      key: 'ArrowRight',
    });
    window.removeEventListener('keydown', onWindowKey);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onWindowKey).not.toHaveBeenCalled();
  });
});
