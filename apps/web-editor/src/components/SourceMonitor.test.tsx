/**
 * Tests for the read-only Source monitor (H1.7, J3 — source-vs-program split):
 * loading an asset, transport controls, in/out mark-range visual state, and the
 * hard invariant that none of it ever touches the patch/undo store.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Asset } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SourceMonitor } from './SourceMonitor.js';

const videoAsset: Asset = { id: 'a1', path: 'blob:a1', kind: 'video', durationSeconds: 8 };
const imageAsset: Asset = { id: 'a2', path: 'blob:a2', kind: 'image', durationSeconds: 5 };

describe('SourceMonitor', () => {
  it('shows an empty state when no asset is loaded', () => {
    render(<SourceMonitor asset={undefined} fps={30} />);
    expect(screen.getByText('Select an asset in the Media panel to load it here.')).toBeTruthy();
    expect(screen.queryByLabelText(/source preview/)).toBeNull();
  });

  it('loads an asset and renders its own <video> element against the proxy URL', () => {
    render(<SourceMonitor asset={videoAsset} fps={30} />);
    const video = screen.getByLabelText('source preview a1') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.src).toContain('a1');
  });

  it('renders an image asset as <img>, not <video>', () => {
    render(<SourceMonitor asset={imageAsset} fps={30} />);
    const el = screen.getByLabelText('source preview a2');
    expect(el.tagName).toBe('IMG');
  });

  it('transport play/pause toggles aria-pressed', () => {
    const { container } = render(<SourceMonitor asset={videoAsset} fps={30} />);
    const playBtn = screen.getByLabelText('source play');
    const playback = container.querySelector('.transport-nav');
    const viewControls = container.querySelector('.transport-right');

    expect(playback?.contains(playBtn)).toBe(true);
    expect(viewControls?.contains(screen.getByLabelText('mark in'))).toBe(true);
    expect(playBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(playBtn);
    expect(screen.getByLabelText('source pause').getAttribute('aria-pressed')).toBe('true');
  });

  it('steps forward and back one frame', () => {
    render(<SourceMonitor asset={videoAsset} fps={30} />);
    fireEvent.click(screen.getByLabelText('source step forward one frame'));
    expect(screen.getByLabelText('source current time').textContent).toBe('00:00:00:01');
    fireEvent.click(screen.getByLabelText('source step back one frame'));
    expect(screen.getByLabelText('source current time').textContent).toBe('00:00:00:00');
  });

  it('scrubbing the range input updates the current time', () => {
    render(<SourceMonitor asset={videoAsset} fps={30} />);
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '3' } });
    expect(screen.getByLabelText('source current time').textContent).toBe('00:00:03:00');
  });

  it('marks in/out points and shows the marked range visually on the scrubber', () => {
    const { container } = render(<SourceMonitor asset={videoAsset} fps={30} />);
    // No range drawn until both in and out are marked.
    expect(container.querySelector('.source-scrubber-range')).toBeNull();

    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('mark in'));
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('mark out'));

    const rangeEl = container.querySelector('.source-scrubber-range') as HTMLElement;
    expect(rangeEl).toBeTruthy();
    // 8s duration: in=2s (25%), out=5s (62.5%), so width = 37.5%.
    expect(rangeEl.style.left).toBe('25%');
    expect(rangeEl.style.width).toBe('37.5%');
  });

  it('publishes source playhead and marks as ephemeral interaction state', async () => {
    const snapshots: unknown[] = [];
    render(
      <SourceMonitor
        asset={videoAsset}
        fps={30}
        onInteractionChange={(snapshot) => snapshots.push(snapshot)}
      />,
    );
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('mark in'));
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('mark out'));
    await waitFor(() =>
      expect(snapshots.at(-1)).toEqual({
        assetId: 'a1',
        rate: { numerator: 30, denominator: 1 },
        playhead: { seconds: 5, frame: 150 },
        markedRange: { startFrame: 60, endFrame: 150 },
      }),
    );
  });

  it('clears published interaction when the source monitor unmounts', async () => {
    const snapshots: unknown[] = [];
    const { unmount } = render(
      <SourceMonitor
        asset={videoAsset}
        fps={30}
        onInteractionChange={(snapshot) => snapshots.push(snapshot)}
      />,
    );
    await waitFor(() => expect(snapshots.at(-1)).toMatchObject({ assetId: 'a1' }));
    unmount();
    expect(snapshots.at(-1)).toBeUndefined();
  });

  it('marks in/out via the I/O keyboard shortcuts', () => {
    const { container } = render(<SourceMonitor asset={videoAsset} fps={30} />);
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '1' } });
    fireEvent.keyDown(window, { key: 'i' });
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '4' } });
    fireEvent.keyDown(window, { key: 'o' });
    expect(container.querySelector('.source-scrubber-range')).toBeTruthy();
  });

  it('resets transport and mark-range state when the loaded asset changes', () => {
    const { rerender, container } = render(<SourceMonitor asset={videoAsset} fps={30} />);
    fireEvent.click(screen.getByLabelText('mark in'));
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('mark out'));
    expect(container.querySelector('.source-scrubber-range')).toBeTruthy();

    rerender(<SourceMonitor asset={imageAsset} fps={30} />);
    expect(container.querySelector('.source-scrubber-range')).toBeNull();
    expect(screen.getByLabelText('source current time').textContent).toBe('00:00:00:00');
  });

  it('never touches the patch/undo store across a full interaction sequence', () => {
    // SourceMonitor takes no `editor`/`UseEditor` prop at all — the strongest
    // possible guarantee it cannot dispatch a patch (enforced by its type, not
    // just by convention). This test renders a real editor store SIDE BY SIDE
    // with the monitor and asserts the store's history never moves, however
    // hard the monitor's own controls (which hold no reference to it) are driven.
    let historyLength = -1;
    function Host(): JSX.Element {
      const editor = useEditor({ tracks: [] }, ['a1']);
      historyLength = editor.state.history.entries.length;
      return <SourceMonitor asset={videoAsset} fps={30} />;
    }
    render(<Host />);
    const before = historyLength;

    fireEvent.click(screen.getByLabelText('source play'));
    fireEvent.click(screen.getByLabelText('source pause'));
    fireEvent.click(screen.getByLabelText('source step forward one frame'));
    fireEvent.change(screen.getByLabelText('scrub source'), { target: { value: '3' } });
    fireEvent.click(screen.getByLabelText('mark in'));
    fireEvent.click(screen.getByLabelText('mark out'));

    expect(historyLength).toBe(before);
  });
});
