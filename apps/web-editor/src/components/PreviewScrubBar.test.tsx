/**
 * Monitor scrub bar (revamp Phase 2, F2).
 *
 * The arithmetic is pinned in `preview/scrub.test.ts`; these cases prove the
 * WIRING — that the pointer/keyboard events reach it with the right numbers, that
 * a fine scrub re-anchors mid-gesture, and that the ARIA contract holds.
 *
 * jsdom reports a zero rect for every element, so each test installs a real one
 * on the track. Without it every pointer position would map to time 0 and the
 * tests would pass vacuously.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PreviewScrubBar } from './PreviewScrubBar.js';

/** A 1000px-wide track at viewport x=100: one px is one thousandth of the bar. */
const TRACK_RECT = { left: 100, width: 1000, top: 0, height: 12, right: 1100, bottom: 12 };

/**
 * Render one bar and hand back its own track. Queried through the render's
 * container rather than `screen` so a single test can mount two bars (the
 * "empty timeline" comparisons below) without the query going ambiguous.
 */
function renderBar(props: Partial<React.ComponentProps<typeof PreviewScrubBar>> = {}): {
  onSeek: ReturnType<typeof vi.fn>;
  track: HTMLElement;
} {
  const onSeek = vi.fn();
  const { container } = render(
    <PreviewScrubBar
      durationSec={60}
      currentTimeSec={0}
      fps={30}
      editPoints={[0, 30, 60]}
      onSeek={onSeek}
      formatTimeLabel={(time) => `${time.toFixed(2)}s`}
      {...props}
    />,
  );
  const track = within(container).getByRole('slider', { name: 'Scrub' });
  track.getBoundingClientRect = () => TRACK_RECT as DOMRect;
  return { onSeek, track };
}

describe('PreviewScrubBar', () => {
  it('seeks to the pointer position on press — a click lands where you clicked', () => {
    const { onSeek, track } = renderBar();
    // 600px on a 1000px bar starting at 100 → halfway → 30s of 60s.
    fireEvent.pointerDown(track, { clientX: 600, pointerId: 1, button: 0 });
    expect(onSeek).toHaveBeenCalledWith(30);
  });

  it('seeks continuously while dragging', () => {
    const { onSeek, track } = renderBar();
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(track, { clientX: 350, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 850, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(45);
  });

  it('ignores a move from a DIFFERENT pointer (a second finger mid-drag)', () => {
    const { onSeek, track } = renderBar();
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1, button: 0 });
    onSeek.mockClear();
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 2 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('ignores a non-primary button and an empty timeline', () => {
    const right = renderBar();
    fireEvent.pointerDown(right.track, { clientX: 600, pointerId: 1, button: 2 });
    expect(right.onSeek).not.toHaveBeenCalled();

    const empty = renderBar({ durationSec: 0 });
    fireEvent.pointerDown(empty.track, { clientX: 600, pointerId: 1, button: 0 });
    expect(empty.onSeek).not.toHaveBeenCalled();
  });

  it('snaps a drag onto a nearby edit point, and Alt defeats the snap', () => {
    const { onSeek, track } = renderBar({ editPoints: [0, 30, 60] });
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1, button: 0 });
    // 604px → 30.24s, within the 6px (=0.36s) tolerance of the cut at 30.
    fireEvent.pointerMove(track, { clientX: 604, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(30);

    // Alt inverts snapping (the timeline's convention): the raw time, quantized
    // to a whole frame at 30fps.
    fireEvent.pointerMove(track, { clientX: 604, pointerId: 1, altKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(Math.round(30.24 * 30) / 30);
  });

  it('does not jump to the pointer when a fine scrub starts', () => {
    // Shift+press must keep the playhead where it is; only travel moves it.
    const { onSeek, track } = renderBar({ currentTimeSec: 12 });
    fireEvent.pointerDown(track, { clientX: 900, pointerId: 1, button: 0, shiftKey: true });
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1, shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(12);
  });

  it('damps a fine scrub to a fraction of its travel', () => {
    const { onSeek, track } = renderBar({ currentTimeSec: 10 });
    fireEvent.pointerDown(track, { clientX: 500, pointerId: 1, button: 0, shiftKey: true });
    // 250px of travel = 15s coarse; damped by 0.2 → 3s, from 10s.
    fireEvent.pointerMove(track, { clientX: 750, pointerId: 1, shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(13);
  });

  it('re-anchors when Shift goes down mid-drag instead of teleporting', () => {
    // A coarse drag, then Shift held: the fine portion must continue from where
    // the coarse drag left the playhead, not from the pointer's absolute position.
    const { onSeek, track } = renderBar({ currentTimeSec: 0 });
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(48);
    // Shift down at the same x: re-anchor, so the reported time is the CURRENT
    // playhead the parent fed back (0 here, since this render is uncontrolled).
    onSeek.mockClear();
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1, shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    // Further travel then moves off that anchor, damped.
    fireEvent.pointerMove(track, { clientX: 1000, pointerId: 1, shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(1.2);
  });

  it('stops seeking after the pointer is released', () => {
    const { onSeek, track } = renderBar();
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerUp(track, { clientX: 100, pointerId: 1 });
    onSeek.mockClear();
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('ends the gesture on pointercancel too (an interrupted touch)', () => {
    const { onSeek, track } = renderBar();
    fireEvent.pointerDown(track, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerCancel(track, { clientX: 100, pointerId: 1 });
    onSeek.mockClear();
    fireEvent.pointerMove(track, { clientX: 900, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('is fully operable from the keyboard', () => {
    const { onSeek, track } = renderBar({ currentTimeSec: 10 });
    fireEvent.keyDown(track, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(10 + 1 / 30);
    fireEvent.keyDown(track, { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenLastCalledWith(10 - 1 / 30);
    // Shift is the coarse step — a second, not a frame.
    fireEvent.keyDown(track, { key: 'ArrowRight', shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(11);
    fireEvent.keyDown(track, { key: 'Home' });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(track, { key: 'End' });
    expect(onSeek).toHaveBeenLastCalledWith(60);
  });

  it('accepts Up/Down as aliases and clamps at the ends', () => {
    const atStart = renderBar({ currentTimeSec: 0 });
    fireEvent.keyDown(atStart.track, { key: 'ArrowDown' });
    expect(atStart.onSeek).toHaveBeenLastCalledWith(0);

    const atEnd = renderBar({ currentTimeSec: 60 });
    fireEvent.keyDown(atEnd.track, { key: 'ArrowUp' });
    expect(atEnd.onSeek).toHaveBeenLastCalledWith(60);
  });

  it('ignores keys it does not own, and every key on an empty timeline', () => {
    const { onSeek, track } = renderBar();
    fireEvent.keyDown(track, { key: 'a' });
    expect(onSeek).not.toHaveBeenCalled();

    const empty = renderBar({ durationSec: 0 });
    fireEvent.keyDown(empty.track, { key: 'ArrowRight' });
    expect(empty.onSeek).not.toHaveBeenCalled();
  });

  it('exposes the position through ARIA, as text a screen reader can use', () => {
    renderBar({ currentTimeSec: 15 });
    const track = screen.getByRole('slider', { name: 'Scrub' });
    expect(track.getAttribute('aria-valuemin')).toBe('0');
    expect(track.getAttribute('aria-valuemax')).toBe('60');
    expect(track.getAttribute('aria-valuenow')).toBe('15');
    // The raw seconds are meaningless to read aloud; the formatted time is not.
    expect(track.getAttribute('aria-valuetext')).toBe('15.00s');
    expect(track.getAttribute('tabindex')).toBe('0');
  });

  it('reports itself disabled when there is nothing to scrub', () => {
    renderBar({ durationSec: 0 });
    expect(screen.getByRole('slider', { name: 'Scrub' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('clamps a playhead reported outside the timeline', () => {
    renderBar({ currentTimeSec: 999 });
    expect(screen.getByRole('slider', { name: 'Scrub' }).getAttribute('aria-valuenow')).toBe('60');
  });

  it('draws a tick per edit point, and none for an empty timeline', () => {
    const { container } = render(
      <PreviewScrubBar
        durationSec={60}
        currentTimeSec={0}
        fps={30}
        editPoints={[0, 12, 30, 60]}
        onSeek={() => {}}
        formatTimeLabel={String}
      />,
    );
    const ticks = container.querySelectorAll('.preview-scrub-tick');
    expect(ticks.length).toBe(4);
    // Positioned by fraction of the timeline, so they align to the picture.
    expect((ticks[1] as HTMLElement).style.left).toBe('20%');

    const { container: empty } = render(
      <PreviewScrubBar
        durationSec={0}
        currentTimeSec={0}
        fps={30}
        editPoints={[0, 12]}
        onSeek={() => {}}
        formatTimeLabel={String}
      />,
    );
    expect(empty.querySelectorAll('.preview-scrub-tick').length).toBe(0);
  });

  it('fills and positions the handle from the playhead fraction', () => {
    const { container } = render(
      <PreviewScrubBar
        durationSec={60}
        currentTimeSec={15}
        fps={30}
        editPoints={[]}
        onSeek={() => {}}
        formatTimeLabel={String}
      />,
    );
    expect(container.querySelector<HTMLElement>('.preview-scrub-fill')?.style.width).toBe('25%');
    expect(container.querySelector<HTMLElement>('.preview-scrub-handle')?.style.left).toBe('25%');
  });

  it('marks itself as scrubbing only while a gesture is in flight', () => {
    const { onSeek: _onSeek, track } = renderBar();
    expect(track.className).not.toContain('is-scrubbing');
    fireEvent.pointerDown(track, { clientX: 300, pointerId: 1, button: 0 });
    expect(track.className).toContain('is-scrubbing');
    fireEvent.pointerUp(track, { clientX: 300, pointerId: 1 });
    expect(track.className).not.toContain('is-scrubbing');
  });
});
