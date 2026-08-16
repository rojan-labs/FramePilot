/**
 * Tests for the global editor keyboard shortcuts. The hook is mounted in a small
 * host that also renders the timeline + transport + inspector so each keystroke's
 * effect is observable through the same patch-engine-backed store the UI uses.
 * Keystrokes are dispatched on document.body, which bubbles to the window
 * listener the hook installs.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from './useEditor.js';
import { useEditorShortcuts } from './useShortcuts.js';
import { assetIdsOf } from './project.js';
import { demoProject } from './demo.js';
import { TimelineView } from '../components/TimelineView.js';
import { PreviewPlayer } from '../components/PreviewPlayer.js';

/** Mount the shortcuts hook over the demo project with the visible surfaces. */
function Host({
  fps = 30,
  onTogglePalette,
}: {
  fps?: number;
  onTogglePalette?: () => void;
}): JSX.Element {
  const editor = useEditor(demoProject.timeline, assetIdsOf(demoProject));
  useEditorShortcuts(editor, fps, { ...(onTogglePalette ? { onTogglePalette } : {}) });
  return (
    <>
      <button type="button" onClick={() => editor.select('clip_intro')}>
        pick intro
      </button>
      <PreviewPlayer
        editor={editor}
        assets={demoProject.assets}
        fps={30}
        resolution={demoProject.resolution}
      />
      <TimelineView editor={editor} assets={demoProject.assets} />
    </>
  );
}

/**
 * The same host over a project that also has an effect lane, with the effect
 * selection lifted exactly as `Editor` lifts it — the wiring select-all and
 * Delete act on.
 */
function HostWithEffects(): JSX.Element {
  const timeline: Timeline = {
    ...demoProject.timeline,
    tracks: [
      ...demoProject.timeline.tracks,
      {
        id: 'fx_1',
        type: 'effect',
        clips: [],
        effectLayers: [
          {
            id: 'fx_layer_1',
            effectId: 'halo-bloom',
            kind: 'bloom',
            start: 0,
            end: 2,
            params: {},
            keyframes: [],
          },
        ],
      },
    ],
  };
  const editor = useEditor(timeline, assetIdsOf(demoProject));
  const [selectedEffectLayerIds, setSelectedEffectLayerIds] = useState<readonly string[]>([]);
  useEditorShortcuts(editor, 30, { selectedEffectLayerIds, setSelectedEffectLayerIds });
  return (
    <TimelineView
      editor={editor}
      assets={demoProject.assets}
      selectedEffectLayerIds={selectedEffectLayerIds}
      onSelectEffectLayers={setSelectedEffectLayerIds}
    />
  );
}

const clipCount = (c: HTMLElement): number => c.querySelectorAll('.clip-block').length;
const key = (init: Partial<KeyboardEvent> & { key: string }): void => {
  fireEvent.keyDown(document.body, init);
};
const playheadTime = (): string => screen.getByLabelText('current time').textContent ?? '';

describe('editor keyboard shortcuts', () => {
  it('toggles playback with Space and pauses with K', () => {
    render(<Host />);
    expect(screen.getByLabelText('play')).toBeDefined();
    key({ key: ' ' });
    expect(screen.getByLabelText('pause')).toBeDefined(); // now playing
    key({ key: 'k' });
    expect(screen.getByLabelText('play')).toBeDefined(); // K pauses
  });

  it('plays with L', () => {
    render(<Host />);
    key({ key: 'l' });
    expect(screen.getByLabelText('pause')).toBeDefined();
  });

  it('lift-deletes the selected clip on Delete', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    expect(clipCount(container)).toBe(3);
    key({ key: 'Backspace' });
    expect(clipCount(container)).toBe(2);
  });

  it('ripple-deletes the selected clip on Shift+Delete', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    key({ key: 'Delete', shiftKey: true });
    expect(clipCount(container)).toBe(2);
    // Ripple pulls clip_body back to the origin (gap closed), unlike a lift.
    expect(screen.getByLabelText('clip clip_body').style.left).toBe('0px');
  });

  it('does nothing on Delete with no selection', () => {
    const { container } = render(<Host />);
    key({ key: 'Delete' });
    expect(clipCount(container)).toBe(3);
  });

  it('⌘A selects clips AND effect layers, and Delete then removes both at once', () => {
    // Regression: Delete used to handle effect layers "exclusively" and return,
    // so a select-all followed by Delete silently spared every clip.
    const { container } = render(<HostWithEffects />);
    expect(clipCount(container)).toBe(3);
    expect(container.querySelectorAll('.fx-layer').length).toBe(1);

    key({ key: 'a', metaKey: true });
    expect(screen.getByLabelText('clip clip_intro').getAttribute('data-selected')).toBe('true');
    expect(container.querySelector('.fx-layer')?.classList.contains('is-selected')).toBe(true);

    key({ key: 'Delete' });
    expect(clipCount(container)).toBe(0);
    expect(container.querySelectorAll('.fx-layer').length).toBe(0);

    // One undo brings the whole thing back — clips and layer are one patch.
    key({ key: 'z', metaKey: true });
    expect(clipCount(container)).toBe(3);
    expect(container.querySelectorAll('.fx-layer').length).toBe(1);
  });

  it('leaves unmapped modifier chords (e.g. ⌘S) to the browser', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    key({ key: 's', metaKey: true }); // not our split — plain S is
    expect(clipCount(container)).toBe(3);
  });

  it('splits the selected clip at the playhead on S', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '3' } });
    key({ key: 's' });
    expect(clipCount(container)).toBe(4);
  });

  it('⌘K no longer splits — it opens the command palette instead', () => {
    const onTogglePalette = vi.fn();
    const { container } = render(<Host onTogglePalette={onTogglePalette} />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '3' } });
    key({ key: 'k', metaKey: true });
    expect(clipCount(container)).toBe(3); // unchanged — mod+k no longer splits
    expect(onTogglePalette).toHaveBeenCalledTimes(1);
  });

  it('nudges the playhead one frame with arrows and a second with Shift', () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '5' } });
    key({ key: 'ArrowRight' }); // +1 frame at 30fps ≈ 0.033s
    expect(playheadTime()).toBe('00:00:05:01');
    key({ key: 'ArrowLeft' }); // −1 frame, back to 5.00
    expect(playheadTime()).toBe('00:00:05:00');
    key({ key: 'ArrowRight', shiftKey: true }); // +1s
    expect(playheadTime()).toBe('00:00:06:00');
    key({ key: 'ArrowLeft', shiftKey: true }); // −1s
    expect(playheadTime()).toBe('00:00:05:00');
  });

  it('clamps a frame nudge to the timeline end', () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '14' } });
    key({ key: 'ArrowRight' }); // already at the 14s end → clamped
    expect(playheadTime()).toBe('00:00:14:00');
  });

  it('falls back to a 30fps frame step when the project fps is unusable', () => {
    render(<Host fps={0} />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '5' } });
    key({ key: 'ArrowRight' });
    expect(playheadTime()).toBe('00:00:05:01'); // 1/30s fallback, not a divide-by-zero
  });

  it('does nothing on S with no selection', () => {
    const { container } = render(<Host />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '3' } });
    key({ key: 's' }); // nothing selected → no split
    expect(clipCount(container)).toBe(3);
  });

  it('does not split when the playhead is on a clip boundary', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    // clip_intro is [0,6]; the playhead defaults to 0 (its start) → no split.
    key({ key: 's' });
    expect(clipCount(container)).toBe(3);
  });

  it('jumps to start with Home and end with End', () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '5' } });
    key({ key: 'Home' });
    expect(playheadTime()).toBe('00:00:00:00');
    key({ key: 'End' }); // demo timeline is 14s long
    expect(playheadTime()).toBe('00:00:14:00');
  });

  it('walks the edit points with Shift+Up / Shift+Down', () => {
    // Revamp Phase 2, F3. Premiere and Resolve put this on bare Up/Down, but those
    // are already "select clip on track above/below" here — hence the Shift
    // variants rather than making one of the two gestures conditional on whether
    // something happens to be selected.
    render(<Host />);
    // The demo timeline's clips give edit points at 0 and beyond; walking forward
    // from 0 must land on a real edit rather than the end of the sequence.
    key({ key: 'ArrowDown', shiftKey: true });
    const firstEdit = playheadTime();
    expect(firstEdit).not.toBe('00:00:00:00');
    expect(firstEdit).not.toBe('00:00:14:00');
    // And back again — "strictly before/after" means presses keep walking rather
    // than sticking on the point already under the playhead.
    key({ key: 'ArrowUp', shiftKey: true });
    expect(playheadTime()).toBe('00:00:00:00');
  });

  it('runs to the sequence ends when there is no further edit point', () => {
    render(<Host />);
    key({ key: 'ArrowUp', shiftKey: true });
    expect(playheadTime()).toBe('00:00:00:00');
    key({ key: 'End' });
    key({ key: 'ArrowDown', shiftKey: true });
    expect(playheadTime()).toBe('00:00:14:00');
  });

  it('keeps global Home/End available when a range control owns focus', () => {
    render(<Host />);
    const playhead = screen.getByLabelText('playhead');
    playhead.focus();
    fireEvent.keyDown(playhead, { key: 'End' });
    expect(playheadTime()).toBe('00:00:14:00');
    fireEvent.keyDown(playhead, { key: 'Home' });
    expect(playheadTime()).toBe('00:00:00:00');
  });

  it('keeps edit shortcuts available when a newly mounted transform range owns focus', () => {
    const { container } = render(<Host />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    const handle = screen.getByRole('slider', { name: 'Resize handle nw' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 's' });
    expect(clipCount(container)).toBe(4);
  });

  it('steps back a second with J', () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '5' } });
    key({ key: 'j' });
    expect(playheadTime()).toBe('00:00:04:00');
  });

  it('toggles a marker at the playhead with M', () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText('playhead'), { target: { value: '4' } });
    key({ key: 'm' });
    expect(screen.getByLabelText('marker at 4s')).toBeDefined();
  });

  it('selects the first clip with Tab (focus rests on the body)', () => {
    render(<Host />);
    key({ key: 'Tab' });
    // Tab navigation is allowed while focus is on the body; first clip is selected.
    expect(screen.getByLabelText('clip clip_intro').getAttribute('data-selected')).toBe('true');
  });

  it('ignores Tab for clip-nav while focus is on a control outside the timeline', () => {
    render(<Host />);
    const pick = screen.getByRole('button', { name: 'pick intro' });
    pick.focus();
    fireEvent.keyDown(pick, { key: 'Tab' });
    // No clip became selected — the browser's normal focus traversal is preserved.
    expect(screen.getByLabelText('clip clip_intro').getAttribute('data-selected')).toBe('false');
  });

  it('selects every clip with ⌘A while the timeline has focus', () => {
    const { container } = render(<Host />);
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(document.body, event);
    expect(event.defaultPrevented).toBe(true); // text select-all is suppressed
    const blocks = [...container.querySelectorAll('.clip-block')];
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((b) => b.getAttribute('data-selected') === 'true')).toBe(true);
  });

  it('leaves ⌘A to the browser while focus is outside the timeline', () => {
    render(<Host />);
    const pick = screen.getByRole('button', { name: 'pick intro' });
    pick.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(pick, event);
    expect(event.defaultPrevented).toBe(false); // native text selection preserved
    expect(screen.getByLabelText('clip clip_intro').getAttribute('data-selected')).toBe('false');
  });

  it('zooms the timeline in and out with = and -', () => {
    render(<Host />);
    const width = (): string => screen.getByLabelText('clip clip_intro').style.width;
    expect(width()).toBe('240px'); // 6s × 40px/s
    key({ key: '=' });
    expect(width()).toBe('360px'); // ×1.5
    key({ key: '-' });
    expect(width()).toBe('240px');
  });

  it('undoes and redoes edits with ⌘Z / ⌘⇧Z', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    key({ key: 'Backspace' });
    expect(clipCount(container)).toBe(2);
    key({ key: 'z', metaKey: true });
    expect(clipCount(container)).toBe(3); // undo
    key({ key: 'z', metaKey: true, shiftKey: true });
    expect(clipCount(container)).toBe(2); // redo
  });

  it('redoes with ⌘Y', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    key({ key: 'Backspace' });
    key({ key: 'z', metaKey: true });
    key({ key: 'y', metaKey: true });
    expect(clipCount(container)).toBe(2);
  });

  it('ignores shortcuts while typing in a text field', () => {
    const { container } = render(
      <>
        <input aria-label="probe" />
        <Host />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'pick intro' }));
    const input = screen.getByLabelText('probe');
    input.focus();
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(clipCount(container)).toBe(3); // untouched — typing, not editing
  });

  it('handles keystrokes whose target is not an element (window)', () => {
    render(<Host />);
    // A non-element target (the window itself) is not a typing surface, so the
    // shortcut still runs — covers the non-HTMLElement guard.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    });
    expect(screen.getByLabelText('pause')).toBeDefined();
  });

  it('leaves unmapped keys alone', () => {
    const { container } = render(<Host />);
    key({ key: 'q' });
    expect(clipCount(container)).toBe(3);
  });
});
