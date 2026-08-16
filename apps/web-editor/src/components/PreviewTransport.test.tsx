/**
 * Program-monitor transport (revamp Phase 2, F3).
 *
 * The gaps this phase closes are what these cases assert: prev/next edit point
 * exist and stop at gap edges, loop is in the transport rather than the view
 * controls, and volume/mute is real persisted monitor state rather than a dead
 * control. The scrub bar's own behaviour lives in `PreviewScrubBar.test.tsx`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { PreviewTransport } from './PreviewTransport.js';

// Loop and volume are persisted preferences — reset storage between cases.
afterEach(() => localStorage.clear());

const clip = (id: string, start: number, end: number) => ({
  id,
  assetId: 'a',
  trackId: 'v',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

/** Two clips with a GAP between them: edits at 0, 4, 6 and 9. */
const gappedTimeline: Timeline = {
  tracks: [{ id: 'v', type: 'video', clips: [clip('a', 0, 4), clip('b', 6, 9)] }],
};

function Host({
  timeline = gappedTimeline,
  durationSec = 9,
}: {
  readonly timeline?: Timeline;
  readonly durationSec?: number;
} = {}): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.seek(5)}>
        seek 5
      </button>
      <button type="button" onClick={() => editor.seek(0)}>
        seek 0
      </button>
      <PreviewTransport editor={editor} durationSec={durationSec} fps={30} />
    </SettingsProvider>
  );
}

const currentTime = (): string | null => screen.getByLabelText('current time').textContent;

describe('PreviewTransport — the full control set (F3)', () => {
  it('offers every transport control the monitor was missing', () => {
    render(<Host />);
    for (const name of [
      'go to start',
      'previous edit point',
      'step back one frame',
      'play',
      'step forward one frame',
      'next edit point',
      'go to end',
      'loop',
      'mute monitor',
      'monitor volume',
    ]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    // And the scrub bar it never had at all.
    expect(screen.getByRole('slider', { name: 'Scrub' })).toBeTruthy();
  });

  it('navigates to the next edit point, stopping at BOTH edges of a gap', () => {
    // The regression this guards: wired to `listEditBoundaries` these clips abut
    // nowhere, so the button would skip 4 and 6 entirely and jump to the end.
    render(<Host />);
    fireEvent.click(screen.getByLabelText('next edit point'));
    expect(currentTime()).toBe('00:00:04:00');
    fireEvent.click(screen.getByLabelText('next edit point'));
    expect(currentTime()).toBe('00:00:06:00');
    fireEvent.click(screen.getByLabelText('next edit point'));
    expect(currentTime()).toBe('00:00:09:00');
  });

  it('navigates backwards through the same edit points', () => {
    render(<Host />);
    fireEvent.click(screen.getByLabelText('go to end'));
    fireEvent.click(screen.getByLabelText('previous edit point'));
    expect(currentTime()).toBe('00:00:06:00');
    fireEvent.click(screen.getByLabelText('previous edit point'));
    expect(currentTime()).toBe('00:00:04:00');
    fireEvent.click(screen.getByLabelText('previous edit point'));
    expect(currentTime()).toBe('00:00:00:00');
  });

  it('falls back to the sequence ends rather than doing nothing', () => {
    // Past the last edit point there is no "next" — the button still has to mean
    // something, so it runs to the end (and symmetrically to the start).
    render(<Host />);
    fireEvent.click(screen.getByLabelText('previous edit point'));
    expect(currentTime()).toBe('00:00:00:00');
    fireEvent.click(screen.getByLabelText('go to end'));
    fireEvent.click(screen.getByLabelText('next edit point'));
    expect(currentTime()).toBe('00:00:09:00');
  });

  it('lands on an edit point from a position between two of them', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'seek 5' }));
    fireEvent.click(screen.getByLabelText('next edit point'));
    expect(currentTime()).toBe('00:00:06:00');
    fireEvent.click(screen.getByRole('button', { name: 'seek 5' }));
    fireEvent.click(screen.getByLabelText('previous edit point'));
    expect(currentTime()).toBe('00:00:04:00');
  });

  it('steps single frames and jumps to the ends', () => {
    render(<Host />);
    fireEvent.click(screen.getByLabelText('step forward one frame'));
    expect(currentTime()).toBe('00:00:00:01');
    fireEvent.click(screen.getByLabelText('step back one frame'));
    expect(currentTime()).toBe('00:00:00:00');
    fireEvent.click(screen.getByLabelText('go to end'));
    expect(currentTime()).toBe('00:00:09:00');
    fireEvent.click(screen.getByLabelText('go to start'));
    expect(currentTime()).toBe('00:00:00:00');
  });

  it('shows current / total time', () => {
    render(<Host />);
    expect(screen.getByLabelText('total time').textContent).toBe('00:00:09:00');
  });

  it('toggles play and pause', () => {
    render(<Host />);
    fireEvent.click(screen.getByLabelText('play'));
    expect(screen.getByLabelText('pause').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByLabelText('pause'));
    expect(screen.getByLabelText('play').getAttribute('aria-pressed')).toBe('false');
  });

  it('puts LOOP in the transport, where playback lives', () => {
    // It used to sit in the view controls next to the grid and the safe-area
    // guides — a different mental category (F3).
    render(<Host />);
    const loop = screen.getByLabelText('loop');
    expect(screen.getByRole('group', { name: 'transport' }).contains(loop)).toBe(true);
    expect(loop.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(loop);
    expect(screen.getByLabelText('loop').getAttribute('aria-pressed')).toBe('true');
  });

  it('honours a persisted loop preference on first render', () => {
    localStorage.setItem('framepilot.settings', JSON.stringify({ loopByDefault: true }));
    render(<Host />);
    expect(screen.getByLabelText('loop').getAttribute('aria-pressed')).toBe('true');
  });

  it('mutes and un-mutes the monitor, persisting the choice', () => {
    render(<Host />);
    fireEvent.click(screen.getByLabelText('mute monitor'));
    const unmute = screen.getByLabelText('unmute monitor');
    expect(unmute.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('framepilot.settings') ?? '{}').previewMuted).toBe(true);
    fireEvent.click(unmute);
    expect(screen.getByLabelText('mute monitor').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a muted monitor as zero on the slider without losing the level', () => {
    // Mute is kept separate from level so un-muting restores what the user had,
    // rather than jumping back to unity.
    localStorage.setItem(
      'framepilot.settings',
      JSON.stringify({ previewVolume: 0.4, previewMuted: true }),
    );
    render(<Host />);
    const slider = screen.getByLabelText('monitor volume') as HTMLInputElement;
    expect(slider.value).toBe('0');
    fireEvent.click(screen.getByLabelText('unmute monitor'));
    expect((screen.getByLabelText('monitor volume') as HTMLInputElement).value).toBe('0.4');
  });

  it('sets the monitor level, and dragging to zero also mutes', () => {
    render(<Host />);
    const slider = screen.getByLabelText('monitor volume');
    fireEvent.change(slider, { target: { value: '0.5' } });
    expect(JSON.parse(localStorage.getItem('framepilot.settings') ?? '{}').previewVolume).toBe(0.5);
    expect(screen.getByLabelText('mute monitor').getAttribute('aria-pressed')).toBe('false');

    // Reaching for volume and hearing nothing would read as a broken control, so
    // zero IS mute — and moving off zero un-mutes (asserted above).
    fireEvent.change(screen.getByLabelText('monitor volume'), { target: { value: '0' } });
    expect(screen.getByLabelText('unmute monitor').getAttribute('aria-pressed')).toBe('true');
  });

  it('feeds the scrub bar the project edit points as ticks', () => {
    const { container } = render(<Host />);
    // 0, 4, 6, 9 — including both gap edges.
    expect(container.querySelectorAll('.preview-scrub-tick').length).toBe(4);
  });

  it('scrubbing does not pause, but every other transport action does', () => {
    render(<Host />);
    fireEvent.click(screen.getByLabelText('play'));
    // A scrub during playback is a legitimate gesture; stopping playback under
    // the user's finger is not what they asked for.
    const track = screen.getByRole('slider', { name: 'Scrub' });
    fireEvent.keyDown(track, { key: 'ArrowRight' });
    expect(screen.getByLabelText('pause')).toBeTruthy();
    // Whereas stepping a frame is an explicit "stop and look at this frame".
    fireEvent.click(screen.getByLabelText('step forward one frame'));
    expect(screen.getByLabelText('play')).toBeTruthy();
  });

  it('renders an inert transport for an empty timeline', () => {
    render(<Host timeline={{ tracks: [] }} durationSec={0} />);
    expect(screen.getByLabelText('total time').textContent).toBe('00:00:00:00');
    expect(screen.getByRole('slider', { name: 'Scrub' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // The buttons still exist and are harmless — nothing to navigate to.
    fireEvent.click(screen.getByLabelText('next edit point'));
    expect(currentTime()).toBe('00:00:00:00');
  });
});
