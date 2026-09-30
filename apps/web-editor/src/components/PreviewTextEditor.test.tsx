/**
 * The selected text overlay on the monitor: its words in the bounding box. A drag moves it, a
 * corner scales its words, a side reflows them, Shift stretches the letters, the lollipop turns
 * it, and a double-click types into it; each gesture is ONE commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PreviewTextEditor } from './PreviewTextEditor.js';
import { DEFAULT_TEXT_PARAMS } from '../editor/patch-builders.js';

const RESOLUTION = { width: 1920, height: 1080 };
// Before the words are measured (jsdom lays nothing out) the box is the wrap box: 80 % of the
// width, 8 % of the height, centred: 1536 × 86.4 at (960, 540).
const params = { ...DEFAULT_TEXT_PARAMS, text: 'Hello' };

function renderEditor(onCommit = vi.fn(), keyframes = [] as never[]) {
  render(
    <div data-testid="frame">
      <PreviewTextEditor
        params={params}
        timeInClip={1}
        duration={5}
        resolution={RESOLUTION}
        keyframes={keyframes}
        onCommit={onCommit}
      />
    </div>,
  );
  // The frame shown at half size.
  screen.getByTestId('frame').getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540 }) as DOMRect;
  return onCommit;
}

const at = (x: number, y: number) => ({ clientX: x / 2, clientY: y / 2 });

function drag(target: Element, from: ReturnType<typeof at>, to: ReturnType<typeof at>, extra = {}) {
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

describe('PreviewTextEditor', () => {
  it('draws the words inside a bounding box with eight handles and a rotation handle', () => {
    renderEditor();
    expect(screen.getByLabelText('text overlay content').textContent).toBe('Hello');
    expect(screen.getByRole('group', { name: 'edit text overlay' })).toBeDefined();
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      expect(screen.getByLabelText(`Resize handle ${handle}`)).toBeDefined();
    }
    expect(screen.getByLabelText('Rotate text overlay')).toBeDefined();
  });

  it('moves the words: the centre in percent of the frame', () => {
    const onCommit = renderEditor();
    drag(screen.getByRole('group', { name: 'edit text overlay' }), at(960, 540), at(1152, 432));
    expect(onCommit).toHaveBeenCalledWith({ params: { xPercent: 60, yPercent: 40 } });
  });

  it('scales the words and the wrap together from a corner', () => {
    const onCommit = renderEditor();
    // se corner of the 1536-wide box, dragged a quarter wider.
    drag(screen.getByLabelText('Resize handle se'), at(1728, 583), at(2112, 604));
    const [{ params: changed, transform }] = onCommit.mock.calls[0]!;
    expect(transform).toBeUndefined();
    expect(changed.fontSizePercent).toBeCloseTo(10);
    expect(changed.boxWidthPercent).toBe(100);
  });

  it('reflows from a side: a new wrap width, the same word size', () => {
    const onCommit = renderEditor();
    drag(screen.getByLabelText('Resize handle e'), at(1728, 540), at(1536, 540));
    const [{ params: changed, transform }] = onCommit.mock.calls[0]!;
    expect(transform).toBeUndefined();
    expect(changed.boxWidthPercent).toBe(70);
    expect(changed.fontSizePercent).toBeUndefined();
  });

  it('stretches the letters with Shift, as one edit with the centre travel', () => {
    const onCommit = renderEditor();
    drag(screen.getByLabelText('Resize handle s'), at(960, 583.2), at(960, 626.4), {
      shiftKey: true,
    });
    const [{ params: changed, transform }] = onCommit.mock.calls[0]!;
    // 86.4 → 129.6 px tall, anchored on the top edge: the centre moves down 21.6 px.
    expect(transform.scaleY).toBeCloseTo(1.5);
    expect(transform.scaleX).toBe(1);
    expect(changed.yPercent).toBeCloseTo(52, 1);
  });

  it('turns the text overlay with the lollipop', () => {
    const onCommit = renderEditor();
    drag(screen.getByLabelText('Rotate text overlay'), at(1060, 540), at(960, 440));
    const [{ params: changed, transform }] = onCommit.mock.calls[0]!;
    expect(changed).toBeUndefined();
    expect(transform.rotation).toBeCloseTo(90);
  });

  it('frames a turned and scaled text overlay with its clip transform', () => {
    renderEditor(vi.fn(), [
      { id: 'r', time: 0, property: 'rotation', value: 30, easing: 'linear' },
    ] as never[]);
    expect(screen.getByRole('group', { name: 'edit text overlay' }).style.transform).toBe(
      'rotate(-30deg)',
    );
  });

  it('types on double-click: blur commits changed words, Escape cancels', () => {
    const onCommit = renderEditor();
    fireEvent.doubleClick(screen.getByRole('group', { name: 'edit text overlay' }));
    const content = screen.getByLabelText('text overlay content');
    expect(content.getAttribute('contenteditable')).toBe('true');
    // The box goes passive while typing: no handles, clicks reach the words.
    expect(screen.queryByLabelText('Resize handle se')).toBeNull();
    content.textContent = 'Changed';
    fireEvent.blur(content);
    expect(onCommit).toHaveBeenCalledWith({ params: { text: 'Changed' } });

    fireEvent.doubleClick(screen.getByRole('group', { name: 'edit text overlay' }));
    const again = screen.getByLabelText('text overlay content');
    again.textContent = 'Discarded';
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('text overlay content').textContent).toBe('Hello');
  });

  it('starts a new line on Shift+Enter, as a line break the words keep', () => {
    const onCommit = renderEditor();
    fireEvent.doubleClick(screen.getByRole('group', { name: 'edit text overlay' }));
    const content = screen.getByLabelText('text overlay content');
    // The caret at the end of the words.
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(content, { key: 'Enter', shiftKey: true });
    content.appendChild(document.createTextNode('World'));
    fireEvent.keyDown(content, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith({ params: { text: 'Hello\nWorld' } });
  });

  it("draws a lockup's lines each in its own face, and types them as plain lines", () => {
    render(
      <PreviewTextEditor
        params={{
          ...params,
          text: 'KICKER\nHeadline',
          fontFamily: 'Anton',
          typography: { lines: [{ fontFamily: 'Montserrat', scale: 0.3 }, {}] },
        }}
        timeInClip={1}
        duration={5}
        resolution={RESOLUTION}
        onCommit={vi.fn()}
      />,
    );
    const content = screen.getByLabelText('text overlay content');
    const lines = content.querySelectorAll<HTMLElement>('.text-overlay-line');
    expect(Array.from(lines, (line) => line.textContent)).toEqual(['KICKER', 'Headline']);
    expect(lines[0]!.style.fontFamily).toContain('Montserrat');
    expect(lines[1]!.style.fontFamily).toContain('Anton');

    fireEvent.doubleClick(screen.getByRole('group', { name: 'edit text overlay' }));
    const typing = screen.getByLabelText('text overlay content');
    expect(typing.querySelectorAll('.text-overlay-line')).toHaveLength(0);
    expect(typing.textContent).toBe('KICKER\nHeadline');
  });

  it('does not commit unchanged words', () => {
    const onCommit = renderEditor();
    fireEvent.doubleClick(screen.getByRole('group', { name: 'edit text overlay' }));
    fireEvent.blur(screen.getByLabelText('text overlay content'));
    expect(onCommit).not.toHaveBeenCalled();
  });
});
