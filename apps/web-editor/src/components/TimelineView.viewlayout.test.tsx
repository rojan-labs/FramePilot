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
    const collapse = screen.getByLabelText('Collapse lane V1');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    act(() => fireEvent.click(collapse));
    // The control flips to "Expand", the lane gets the collapsed class, and the
    // view state is persisted (session-only, never the project).
    const expand = screen.getByLabelText('Expand lane V1');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('framepilot.trackLayout')!).v.collapsed).toBe(true);
    act(() => fireEvent.click(expand));
    expect(screen.getByLabelText('Collapse lane V1').getAttribute('aria-expanded')).toBe('true');
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

    act(() => fireEvent.click(screen.getByLabelText('Collapse lane V1')));

    // REGRESSION: the virtualizer memoises measurements on `count`, not on
    // `estimateSize`, so without an explicit re-measure it kept laying this row
    // out at the old 56px offset — leaving a dead band under the collapsed lane.
    const after = rowOffset(secondLane());
    expect(after).toBeLessThan(before);

    // And expanding restores it exactly, rather than drifting.
    act(() => fireEvent.click(screen.getByLabelText('Expand lane V1')));
    expect(rowOffset(secondLane())).toBe(before);
  });

  it('keeps each header row aligned with its lane through a collapse', () => {
    renderTimeline();
    const alignment = (): { head: number; lane: number }[] =>
      ['v', 'layer_audio_1'].map((id) => ({
        head: rowOffset(document.querySelector(`.track-head[data-track-head="${id}"]`)!),
        lane: rowOffset(screen.getByLabelText(`track ${id}`)),
      }));
    for (const { head, lane } of alignment()) expect(head).toBe(lane);
    act(() => fireEvent.click(screen.getByLabelText('Collapse lane V1')));
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
  /**
   * Give the lane scroller a real `clientWidth` narrower than the sequence.
   *
   * The strip only exists when there is something to navigate, so a test that
   * wants one has to establish the overflow it navigates. jsdom reports 0 for
   * every layout box, and a 0-width viewport is indistinguishable from "not
   * measured yet" — which is exactly the state the component must NOT draw a
   * strip in, since a viewport of zero width would report every sequence as
   * overflowing.
   */
  function withNarrowViewport<T>(run: () => T): T {
    const proto = HTMLElement.prototype;
    const real = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('lane-scroll') ? 100 : 0;
      },
    });
    try {
      return run();
    } finally {
      if (real) Object.defineProperty(proto, 'clientWidth', real);
      else delete (proto as unknown as Record<string, unknown>).clientWidth;
    }
  }

  it('renders the overview strip with a block per clip and a viewport window', () => {
    withNarrowViewport(() => {
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
  });

  it('is not mounted at all when the whole sequence already fits', () => {
    // Regression: the strip was mounted unconditionally, against its own
    // documented contract. With nothing to navigate, the viewport window covers
    // the entire strip — so the map rendered as a solid accent slab that hid the
    // clip blocks it exists to show, and charged the lanes 22px for it.
    renderTimeline();
    expect(screen.queryByLabelText('Timeline overview')).toBeNull();
  });

  it('draws its blocks on the first paint, before any click', () => {
    // Regression: the strip measured its own width only from `onPointerDown`, so
    // it mounted at width 0 — every block and the viewport window computed to
    // zero px and the map rendered as an empty bar until the user clicked it.
    // jsdom reports 0 for every rect, so give the strip a real width the way the
    // browser would and assert the geometry lands WITHOUT any pointer event.
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const width = this.classList.contains('minimap') ? 300 : 0;
      return { ...rect.call(this), width, left: 0, right: width } as DOMRect;
    };
    try {
      withNarrowViewport(() => {
        renderTimeline();
        const minimap = screen.getByLabelText('Timeline overview');
        const blocks = minimap.querySelectorAll('.mm-block');
        expect(blocks.length).toBe(2); // one clip on each of the two lanes
        for (const block of blocks) {
          expect(Number.parseFloat((block as HTMLElement).style.width)).toBeGreaterThan(0);
        }
        // The viewport window is mounted, placed, and — now that the strip only
        // appears when the sequence overflows — narrower than the strip itself.
        const view = minimap.querySelector('.mm-view') as HTMLElement | null;
        expect(view).not.toBeNull();
        expect(Number.parseFloat(view!.style.width)).toBeLessThan(300);
      });
    } finally {
      Element.prototype.getBoundingClientRect = rect;
    }
  });

  it('is keyboard-operable as a slider without throwing', () => {
    withNarrowViewport(() => {
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
});

describe('empty tracks are rows (UX-05)', () => {
  it("renders a project's empty audio track so there is somewhere to drop music", () => {
    // The empty-track filter meant a project's own audio lane did not exist as far as
    // the editor was concerned, and "Add track" was the only way to find a lane at all.
    const withEmptyAudio: Timeline = {
      tracks: [...timeline.tracks, { id: 'empty_audio', type: 'audio', clips: [] }],
    };
    function Host(): JSX.Element {
      const editor = useEditor(withEmptyAudio, ['m', 'snd']);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }
    render(<Host />);
    // `empty_audio` is the first lane whose kind resolves to audio: the fixture
    // passes no assets, so `clipKind` types `layer_audio_1`'s clip as video (its
    // pre-existing fallback for an unknown asset) and the header glyph agrees.
    expect(screen.getByLabelText('Collapse lane A1')).toBeTruthy();
  });
});
