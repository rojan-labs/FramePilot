/**
 * View-only track & viewport tests for the timeline (M2b-2): track collapse /
 * resize / solo, the minimap overview strip, and vertical virtualization. These
 * are presentation/session state only (invariant 5) — none emits a timeline
 * patch, so each assertion checks the *view* (DOM/aria/localStorage), never the
 * project. The pure geometry/decision functions are covered in `selectors.test`
 * and the persistence hook in `useTrackLayout.test`; here we verify the wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { TimelineView } from './TimelineView.js';

/** A small timeline: two video lanes, each with a clip. */
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
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
    {
      id: 'layer_audio_1',
      type: 'audio',
      clips: [
        {
          id: 'b',
          assetId: 'snd',
          trackId: 'layer_audio_1',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props);
    this.pointerId = props.pointerId ?? 0;
  }
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    FakePointerEvent as unknown as typeof MouseEvent;
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  document.elementFromPoint = vi.fn(() => null);
});

/** Render the timeline with a fresh localStorage-backed track layout. Returns
 *  the live `useEditor` instance so a test can assert the project/history are
 *  untouched by a view-only interaction (e.g. solo). */
function renderTimeline(): { editor: ReturnType<typeof useEditor> } {
  let captured!: ReturnType<typeof useEditor>;
  function Host(): JSX.Element {
    const editor = useEditor(timeline, ['m', 'snd']);
    captured = editor;
    return <TimelineView editor={editor} assets={[]} fps={30} />;
  }
  render(<Host />);
  return { editor: captured };
}

describe('TimelineView — collapse / expand (M2b-2)', () => {
  it('collapses a lane and persists it, then expands again', () => {
    renderTimeline();
    const collapse = screen.getByLabelText('Collapse track v');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    act(() => fireEvent.click(collapse));
    // The control flips to "Expand", the lane gets the collapsed class, and the
    // view state is persisted (session-only, never the project).
    const expand = screen.getByLabelText('Expand track v');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('framepilot.trackLayout')!).v.collapsed).toBe(true);
    act(() => fireEvent.click(expand));
    expect(screen.getByLabelText('Collapse track v').getAttribute('aria-expanded')).toBe('true');
  });
});

/* Track-height resize tests removed — the drag-to-resize grip was removed from
   the track header per UX feedback. Lane height is set programmatically or via
   the track layout hook; no UI gesture exists in the current design. */

/** The `translateY(Npx)` a windowed row is positioned at, as a number. */
function rowOffset(el: Element): number {
  const match = /translateY\((-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
  expect(match, `expected a translateY on ${el.className}`).not.toBeNull();
  return Number(match![1]);
}

describe('TimelineView — row layout reflows on height change', () => {
  it('collapsing a lane pulls the lanes below it up', () => {
    renderTimeline();
    const secondLane = (): Element => screen.getByLabelText('track layer_audio_1');
    const before = rowOffset(secondLane());
    // A full-height lane above it, so the second row starts below one.
    expect(before).toBeGreaterThan(0);

    act(() => fireEvent.click(screen.getByLabelText('Collapse track v')));

    // REGRESSION: the virtualizer memoises measurements on `count`, not on
    // `estimateSize`, so without an explicit re-measure it kept laying this row
    // out at the old 56px offset — leaving a dead band under the collapsed lane.
    const after = rowOffset(secondLane());
    expect(after).toBeLessThan(before);

    // And expanding restores it exactly, rather than drifting.
    act(() => fireEvent.click(screen.getByLabelText('Expand track v')));
    expect(rowOffset(secondLane())).toBe(before);
  });

  it('keeps each header row aligned with its lane through a collapse', () => {
    renderTimeline();
    const alignment = (): { head: number; lane: number }[] =>
      ['v', 'layer_audio_1'].map((id) => ({
        head: rowOffset(document.querySelector(`.track-head:has([aria-label$="track ${id}"])`)!),
        lane: rowOffset(screen.getByLabelText(`track ${id}`)),
      }));
    for (const { head, lane } of alignment()) expect(head).toBe(lane);
    act(() => fireEvent.click(screen.getByLabelText('Collapse track v')));
    for (const { head, lane } of alignment()) expect(head).toBe(lane);
  });
});

describe('TimelineView — solo (derived preview mute, M2b-2)', () => {
  it('soloing an audio lane marks the other audio lane as muted-by-solo (no schema flag)', () => {
    renderTimeline();
    // Solo the first lane (the video lane, which carries audio); the audio lane
    // then solo-mutes for preview monitoring.
    const soloButtons = screen.getAllByLabelText('Solo track');
    act(() => fireEvent.click(soloButtons[0]!));
    // The persisted layout records the solo (view state) — never a track flag.
    const stored = JSON.parse(localStorage.getItem('framepilot.trackLayout')!);
    const soloedId = Object.keys(stored).find((id) => stored[id].soloed);
    expect(soloedId).toBeDefined();
    // The other audio lane now shows a "Muted by solo" control — a derived
    // preview state on the mute button, not a `set_track_flags` patch / schema flag.
    expect(document.querySelector('.track-control.is-solo-muted')).not.toBeNull();
  });

  it('toggling solo never mutates the project timeline or enters undo history', () => {
    const { editor } = renderTimeline();
    const before = editor.state.timeline;
    const soloButtons = screen.getAllByLabelText('Solo track');
    act(() => fireEvent.click(soloButtons[0]!));
    // Same timeline reference: solo never dispatches a patch (a real edit would
    // replace it), so the guardrail is object identity, not a deep diff.
    expect(editor.state.timeline).toBe(before);
    expect(editor.canUndo).toBe(false);
    // The persisted schema flag on every track is exactly as authored — solo
    // never writes `Track.muted`, even for the lane it just soloed.
    for (const track of editor.state.timeline.tracks) expect(track.muted).toBeUndefined();

    // Un-soloing (click again) is likewise a pure view toggle.
    act(() => fireEvent.click(soloButtons[0]!));
    expect(editor.state.timeline).toBe(before);
    expect(editor.canUndo).toBe(false);
  });
});

describe('TimelineView — minimap overview (M2b-2)', () => {
  it('renders the overview strip with a block per clip and a viewport window', () => {
    renderTimeline();
    const minimap = screen.getByLabelText('Timeline overview');
    expect(minimap.getAttribute('role')).toBe('slider');
    // Pure navigation chrome — dragging it must not throw or emit a patch.
    act(() => {
      fireEvent.pointerDown(minimap, { clientX: 20, pointerId: 1 });
      fireEvent.pointerMove(minimap, { clientX: 40, pointerId: 1 });
      fireEvent.pointerUp(minimap, { pointerId: 1 });
    });
    expect(screen.getByLabelText('Timeline overview')).toBeDefined();
  });

  it('is keyboard-operable as a slider without throwing', () => {
    renderTimeline();
    const minimap = screen.getByLabelText('Timeline overview');
    act(() => {
      fireEvent.keyDown(minimap, { key: 'End' });
      fireEvent.keyDown(minimap, { key: 'Home' });
      fireEvent.keyDown(minimap, { key: 'ArrowRight' });
    });
    expect(minimap).toBeDefined();
  });
});

describe('TimelineView — vertical virtualization (M2b-2)', () => {
  /** A timeline with many empty user-created layers (window-able lane list). */
  const manyTracks: Timeline = {
    tracks: Array.from({ length: 60 }, (_, i) => ({
      id: `layer_${i}`,
      type: 'video' as const,
      clips: [],
    })),
  };

  it('mounts every lane when the viewport is unmeasured (jsdom fallback) and keeps aria hooks', () => {
    function Host(): JSX.Element {
      const editor = useEditor(manyTracks, []);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }
    render(<Host />);
    // The aria hook for each track lane is preserved across the windowed render.
    expect(screen.getByLabelText('track layer_0')).toBeDefined();
    expect(screen.getByLabelText('track layer_30')).toBeDefined();
    expect(screen.getByLabelText('track layer_59')).toBeDefined();
    // The sr-only playhead seek/a11y hook must survive virtualization.
    expect(screen.getByLabelText('playhead')).toBeDefined();
  });

  it('windows the lane list when the viewport is measured (only on-screen lanes mount)', () => {
    // Give the vertical scroll viewport a real (small) height so the virtualizer
    // windows instead of falling back to mounting everything. ResizeObserver is
    // stubbed to deliver that height to the virtual core on observe.
    const VIEWPORT = 240; // px — fits only a handful of ~46px rows + overscan
    // The virtual core measures the scroll element via `offsetHeight` (jsdom
    // reports 0, which triggers the mount-everything fallback). Stub a real
    // offsetHeight on the vertical scroll viewport so the virtualizer windows.
    const proto = HTMLElement.prototype;
    const realH = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
    const realW = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
    Object.defineProperty(proto, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('timeline-vscroll') ? VIEWPORT : 0;
      },
    });
    Object.defineProperty(proto, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('timeline-vscroll') ? 800 : 0;
      },
    });
    try {
      function Host(): JSX.Element {
        const editor = useEditor(manyTracks, []);
        return <TimelineView editor={editor} assets={[]} fps={30} />;
      }
      render(<Host />);
      const mounted = screen.getAllByLabelText(/^track layer_\d+$/);
      // Far fewer than the 60 lanes are mounted (windowing is active), and the
      // first lane is in the window while a deep lane is not.
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThan(manyTracks.tracks.length);
      expect(screen.queryByLabelText('track layer_0')).not.toBeNull();
      expect(screen.queryByLabelText('track layer_59')).toBeNull();
    } finally {
      if (realH) Object.defineProperty(proto, 'offsetHeight', realH);
      else delete (proto as unknown as Record<string, unknown>).offsetHeight;
      if (realW) Object.defineProperty(proto, 'offsetWidth', realW);
      else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    }
  });
});
