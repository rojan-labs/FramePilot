import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PreviewTextEditor } from './PreviewTextEditor.js';
import { DEFAULT_TEXT_PARAMS } from '../editor/patch-builders.js';

const params = { ...DEFAULT_TEXT_PARAMS, text: 'Hello' };

describe('PreviewTextEditor', () => {
  it('renders the text content and the two width handles', () => {
    render(<PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={() => {}} />);
    expect(screen.getByLabelText('text overlay content').textContent).toBe('Hello');
    expect(screen.getByLabelText('resize text width left')).toBeDefined();
    expect(screen.getByLabelText('resize text width right')).toBeDefined();
  });

  it('double-click enters edit mode and blur commits changed text', () => {
    const onCommit = vi.fn();
    render(<PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={onCommit} />);
    const box = screen.getByLabelText('edit text overlay');
    fireEvent.doubleClick(box);
    const content = screen.getByLabelText('text overlay content');
    expect(content.getAttribute('contenteditable')).toBe('true');
    // Simulate the user typing a new value, then blurring to commit.
    content.textContent = 'Changed';
    fireEvent.blur(content);
    expect(onCommit).toHaveBeenCalledWith({ text: 'Changed' });
  });

  it('does not commit when the text is unchanged on blur', () => {
    const onCommit = vi.fn();
    render(<PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={onCommit} />);
    fireEvent.doubleClick(screen.getByLabelText('edit text overlay'));
    fireEvent.blur(screen.getByLabelText('text overlay content'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('releases its window drag listeners when unmounted mid-drag', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(
      <PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={() => {}} />,
    );

    fireEvent.pointerDown(screen.getByLabelText('edit text overlay'), {
      clientX: 10,
      clientY: 10,
    });
    const added = add.mock.calls.filter(([type]) => type === 'pointermove' || type === 'pointerup');
    expect(added).toHaveLength(2);

    // Unmount WITHOUT a pointerup — the drag is still live. Before the cleanup existed
    // the two handlers stayed on `window` for the life of the document.
    view.unmount();
    for (const [type, handler] of added) {
      expect(remove).toHaveBeenCalledWith(type, handler);
    }
    add.mockRestore();
    remove.mockRestore();
  });

  it('commits the params the drag produced, not the pre-drag state', () => {
    const onCommit = vi.fn();
    render(<PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={onCommit} />);
    const box = screen.getByLabelText('edit text overlay');
    // jsdom gives every element a zero-size rect, so give the offset parent a real one:
    // the drag maths divides by its width/height.
    const frame = box.offsetParent as HTMLElement | null;
    const host = frame ?? document.body;
    Object.defineProperty(box, 'offsetParent', { configurable: true, get: () => host });
    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;

    fireEvent.pointerDown(box, { clientX: 100, clientY: 50 });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 50 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', {}));
    });

    // The registered `endDrag` closure read `live` from the pointer-down render, where
    // it is null — so a completed move committed nothing at all.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]!.xPercent).toBeGreaterThan(params.xPercent);
  });
});
