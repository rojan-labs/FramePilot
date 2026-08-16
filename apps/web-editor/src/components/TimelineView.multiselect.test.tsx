/**
 * Multi-select interaction tests for the timeline (M2a): Shift/Cmd click, marquee
 * (rubber-band) selection, and batch delete via the keyboard — all routed through
 * the same validated store, one patch per gesture, fully reversible with one undo.
 *
 * jsdom reports zero-origin rects, so a pointer `clientX` maps straight through
 * `pxToSeconds(clientX, pxPerSecond)`; at the 40px/s default zoom, clientX 80 ⇒ 2s.
 * The tracks <ol> rect is stubbed to give the marquee a row height to map y onto.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { useEditorShortcuts } from '../editor/useShortcuts.js';
import { TimelineView } from './TimelineView.js';

/** Two clips on one video track (a [0,2], b [5,7]) plus a second video lane. */
const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'a',
          assetId: 'm',
          trackId: 'v',
          start: 0,
          end: 2,
          sourceStart: 0,
          sourceEnd: 2,
          effects: [],
          keyframes: [],
        },
        {
          id: 'b',
          assetId: 'm',
          trackId: 'v',
          start: 5,
          end: 7,
          sourceStart: 0,
          sourceEnd: 2,
          effects: [],
          keyframes: [],
        },
      ],
    },
    { id: 'layer_video_1', type: 'video', clips: [] },
  ],
};

/** Host wiring both the timeline view and the global shortcut layer (for delete). */
function Host(): JSX.Element {
  const editor = useEditor(timeline, ['m']);
  useEditorShortcuts(editor, 30);
  return <TimelineView editor={editor} assets={[]} fps={30} />;
}

const clip = (id: string): HTMLElement => screen.getByLabelText(`clip ${id}`);
const isSelected = (id: string): boolean => clip(id).getAttribute('data-selected') === 'true';

class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props);
    this.pointerId = props.pointerId ?? 0;
  }
}

beforeEach(() => {
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    FakePointerEvent as unknown as typeof MouseEvent;
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  document.elementFromPoint = vi.fn(() => null);
});

describe('TimelineView multi-selection (M2a)', () => {
  it('Shift+click extends the selection to multiple clips', () => {
    render(<Host />);
    fireEvent.click(clip('a'));
    expect(isSelected('a')).toBe(true);
    expect(isSelected('b')).toBe(false);
    fireEvent.click(clip('b'), { shiftKey: true });
    expect(isSelected('a')).toBe(true);
    expect(isSelected('b')).toBe(true);
  });

  it('Cmd/Ctrl+click toggles a clip in and out of the selection', () => {
    render(<Host />);
    fireEvent.click(clip('a'));
    fireEvent.click(clip('b'), { metaKey: true });
    expect(isSelected('b')).toBe(true);
    fireEvent.click(clip('b'), { metaKey: true }); // toggle off
    expect(isSelected('b')).toBe(false);
    expect(isSelected('a')).toBe(true);
  });

  it('a plain click replaces the multi-selection with a single clip', () => {
    render(<Host />);
    fireEvent.click(clip('a'));
    fireEvent.click(clip('b'), { shiftKey: true });
    expect(isSelected('a')).toBe(true);
    fireEvent.click(clip('a')); // plain click → single-select
    expect(isSelected('a')).toBe(true);
    expect(isSelected('b')).toBe(false);
  });

  it('marquee drag over empty lane selects every covered clip, then batch-deletes them', () => {
    const { container } = render(<Host />);
    const tracksOl = container.querySelector('.tracks') as HTMLElement;
    // Give the <ol> a measurable rect so the marquee maps y → row height. Two
    // visible rows (v + layer_video_1) at 50px each.
    tracksOl.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, height: 100 }) as DOMRect);

    // Drag a rect over [0..320px] = [0..8s] on row 0 → covers a (0–2) and b (5–7).
    fireEvent.pointerDown(tracksOl, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(tracksOl, { clientX: 320, clientY: 40, pointerId: 1 });
    expect(container.querySelector('.marquee')).not.toBeNull();
    fireEvent.pointerUp(tracksOl, { clientX: 320, clientY: 40, pointerId: 1 });
    // Marquee cleared on release (ephemeral); both clips selected.
    expect(container.querySelector('.marquee')).toBeNull();
    expect(isSelected('a')).toBe(true);
    expect(isSelected('b')).toBe(true);

    // Batch delete via the keyboard removes BOTH in one patch.
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(container.querySelectorAll('.clip-block').length).toBe(0);

    // A single undo restores the whole batch.
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(container.querySelectorAll('.clip-block').length).toBe(2);
  });

  it('a marquee drag with Shift extends rather than replaces the selection', () => {
    const { container } = render(<Host />);
    const tracksOl = container.querySelector('.tracks') as HTMLElement;
    tracksOl.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, height: 100 }) as DOMRect);
    // Pre-select b, then Shift-marquee over a only ([0..80px]=[0..2s]).
    fireEvent.click(clip('b'));
    fireEvent.pointerDown(tracksOl, {
      clientX: 0,
      clientY: 0,
      button: 0,
      shiftKey: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(tracksOl, { clientX: 80, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(tracksOl, { clientX: 80, clientY: 40, pointerId: 1 });
    expect(isSelected('a')).toBe(true);
    expect(isSelected('b')).toBe(true); // kept (additive)
  });

  it('a click on empty lane (no drag) clears the selection', () => {
    const { container } = render(<Host />);
    const tracksOl = container.querySelector('.tracks') as HTMLElement;
    tracksOl.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, height: 100 }) as DOMRect);
    fireEvent.click(clip('a'));
    expect(isSelected('a')).toBe(true);
    fireEvent.pointerDown(tracksOl, { clientX: 200, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerUp(tracksOl, { clientX: 200, clientY: 10, pointerId: 1 });
    expect(isSelected('a')).toBe(false);
  });

  it('drag-moving one clip of a multi-selection moves the WHOLE selection by the same delta', () => {
    render(<Host />);
    fireEvent.click(clip('a'));
    fireEvent.click(clip('b'), { shiftKey: true });
    // Drag a from 0 → +4s (clientX 0→160). Snapping is on; both shift by +4s,
    // landing a at 4s (160px) and b at 9s (360px).
    fireEvent.pointerDown(clip('a'), { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(clip('a'), { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(clip('a'), { clientX: 160, pointerId: 1 });
    expect(clip('a').style.left).toBe('160px'); // 4s
    expect(clip('b').style.left).toBe('360px'); // 9s
    // One undo reverts both.
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(clip('a').style.left).toBe('0px');
    expect(clip('b').style.left).toBe('200px'); // back at 5s
  });
});
