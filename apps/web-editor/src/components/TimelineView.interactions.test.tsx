/**
 * Pointer-interaction tests for the timeline (plan 3.4 Part 2): drag-move,
 * edge-trim, razor split, and click-to-seek each commit exactly one validated
 * patch through the store. jsdom reports zero-origin rects, so a pointer
 * `clientX` maps straight through `pxToSeconds(clientX, pxPerSecond)`; at the
 * 40 px/s test zoom, clientX 160 ⇒ 4s.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { alignToDevicePixel } from '../editor/pixel-alignment.js';
import { useEditor } from '../editor/useEditor.js';
import { TimelineView } from './TimelineView.js';
import { ASSET_DND_TYPE } from './MediaBin.js';
import { TEXT_OVERLAY_DND_TYPE } from './OverlaysPanel.js';

/** One short clip on a single video track with empty room to move into. */
const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 2,
          sourceStart: 0,
          sourceEnd: 2,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

function Host({ tool }: { tool?: 'select' | 'blade' } = {}): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  return <TimelineView editor={editor} assets={[]} fps={30} {...(tool ? { tool } : {})} />;
}

const clip = (): HTMLElement => screen.getByLabelText('clip c1');

/** jsdom has no PointerEvent, so coordinates are dropped — back it with MouseEvent. */
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props);
    this.pointerId = props.pointerId ?? 0;
  }
}

beforeEach(() => {
  // jsdom implements neither PointerEvent, pointer capture, nor hit-testing.
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    FakePointerEvent as unknown as typeof MouseEvent;
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  document.elementFromPoint = vi.fn(() => null);
});

describe('alignToDevicePixel', () => {
  it('keeps the moving playhead line on whole physical pixels', () => {
    expect(alignToDevicePixel(10.24, 2)).toBe(10);
    expect(alignToDevicePixel(10.26, 2)).toBe(10.5);
    expect(alignToDevicePixel(3.6, 1)).toBe(4);
  });

  it('falls back safely for an invalid device scale', () => {
    expect(alignToDevicePixel(3.6, 0)).toBe(4);
    expect(alignToDevicePixel(3.6, Number.NaN)).toBe(4);
  });
});

describe('TimelineView direct manipulation', () => {
  it('drag-moves a clip and commits a single move patch', () => {
    render(<Host />);
    expect(clip().style.left).toBe('0px');

    fireEvent.pointerDown(clip(), { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(clip(), { clientX: 180, pointerId: 1 }); // +160px ⇒ +4s
    fireEvent.pointerUp(clip(), { clientX: 180, pointerId: 1 });

    // Grab offset was 0.5s, so start = 0 + (4.5 - 0.5) = 4s ⇒ 160px.
    expect(clip().style.left).toBe('160px');
    expect(clip().style.width).toBe('80px'); // duration unchanged (2s)
  });

  it('does not move (only selects) when the press never crosses the drag threshold', () => {
    render(<Host />);
    fireEvent.pointerDown(clip(), { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(clip(), { clientX: 21, pointerId: 1 }); // 1px < threshold
    fireEvent.pointerUp(clip(), { clientX: 21, pointerId: 1 });
    fireEvent.click(clip());
    expect(clip().style.left).toBe('0px');
    expect(clip().getAttribute('data-selected')).toBe('true');
  });

  it('edge-trims the right edge and commits a single trim patch', () => {
    render(<Host />);
    const handle = clip().querySelector('.clip-trim-r') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 80, pointerId: 1 }); // right edge at 2s
    fireEvent.pointerMove(handle, { clientX: 60, pointerId: 1 }); // ⇒ end 1.5s
    fireEvent.pointerUp(handle, { clientX: 60, pointerId: 1 });
    expect(clip().style.width).toBe('60px'); // 1.5s × 40px
  });

  it('blade tool splits the clip under the click into two', () => {
    // The Blade/Selection toggle itself lives in the toolbar now (lifted state,
    // TIMELINE-TOOLBAR-REORG) — this view only reacts to the `tool` prop.
    const { container } = render(<Host tool="blade" />);
    fireEvent.click(clip(), { clientX: 40 }); // split at 1s
    expect(container.querySelectorAll('.clip-block').length).toBe(2);
  });

  it('seeks when the ruler is pressed and dragged (click + scrub)', () => {
    render(<Host />);
    const ruler = screen.getByLabelText('timeline ruler');
    fireEvent.pointerDown(ruler, { clientX: 120, pointerId: 1 }); // 3s
    expect(screen.getByLabelText('playhead time').textContent).toBe('00:00:03:00');
    fireEvent.pointerMove(ruler, { clientX: 200, pointerId: 1 }); // drag to 5s
    expect(screen.getByLabelText('playhead time').textContent).toBe('00:00:05:00');
    fireEvent.pointerUp(ruler, { clientX: 200, pointerId: 1 });
  });

  it('edge-trims the left edge, shifting the source in-point with it', () => {
    render(<Host />);
    const handle = clip().querySelector('.clip-trim-l') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 }); // left edge at 0s
    fireEvent.pointerMove(handle, { clientX: 20, pointerId: 1 }); // ⇒ start 0.5s
    fireEvent.pointerUp(handle, { clientX: 20, pointerId: 1 });
    expect(clip().style.left).toBe('20px'); // 0.5s × 40px
    expect(clip().style.width).toBe('60px'); // 1.5s remaining
  });

  it('Cmd/Ctrl-drags a clip to duplicate it, leaving the original in place', () => {
    render(<Host />);
    expect(clip().style.left).toBe('0px');

    fireEvent.pointerDown(clip(), { clientX: 20, pointerId: 1, ctrlKey: true });
    fireEvent.pointerMove(clip(), { clientX: 180, pointerId: 1, ctrlKey: true }); // +160px ⇒ +4s
    fireEvent.pointerUp(clip(), { clientX: 180, pointerId: 1, ctrlKey: true });

    // The original c1 never moved…
    expect(screen.getByLabelText('clip c1').style.left).toBe('0px');
    // …and a copy landed at the resolved drop position (start 4s ⇒ 160px).
    const clips = screen.getAllByLabelText(/^clip /);
    expect(clips).toHaveLength(2);
    expect(clips.some((el) => (el as HTMLElement).style.left === '160px')).toBe(true);
  });

  it('rolls the shared edit point when Cmd/Ctrl-dragging a trim handle on a butt-joined cut', () => {
    const adjacent: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v',
              start: 0,
              end: 2,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [],
            },
            {
              id: 'c2',
              assetId: 'a',
              trackId: 'v',
              start: 2,
              end: 4,
              sourceStart: 2,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    function RollHost(): JSX.Element {
      const editor = useEditor(adjacent, ['a']);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }
    render(<RollHost />);
    const c1 = screen.getByLabelText('clip c1');
    const handle = c1.querySelector('.clip-trim-r') as HTMLElement;
    // Cut is at 2s (80px); roll it to 2.5s (100px) with Ctrl held.
    fireEvent.pointerDown(handle, { clientX: 80, pointerId: 1, ctrlKey: true });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1, ctrlKey: true });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1, ctrlKey: true });
    expect(screen.getByLabelText('clip c1').style.width).toBe('100px'); // 2.5s
    expect(screen.getByLabelText('clip c2').style.left).toBe('100px'); // c2 now starts at 2.5s
    expect(screen.getByLabelText('clip c2').style.width).toBe('60px'); // 1.5s remaining
  });

  it('drags an audio clip fade-in handle and commits a fade via setAudioPatch', () => {
    const audioAsset = { id: 'snd', path: 'media/song.mp3', kind: 'audio' as const };
    const audioTimeline: Timeline = {
      tracks: [
        {
          id: 'a1',
          type: 'audio',
          clips: [
            {
              id: 'c1',
              assetId: 'snd',
              trackId: 'a1',
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
    function AudioHost(): JSX.Element {
      const editor = useEditor(audioTimeline, ['snd']);
      return <TimelineView editor={editor} assets={[audioAsset]} fps={30} />;
    }
    render(<AudioHost />);
    const c1 = screen.getByLabelText('clip c1');
    const handle = c1.querySelector('.clip-fade-handle-in') as HTMLElement;
    expect(handle).not.toBeNull();
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 40, pointerId: 1 }); // +40px ⇒ +1s @ 40px/s
    fireEvent.pointerUp(handle, { clientX: 40, pointerId: 1 });
    // The overlay wedge widens to the committed fade duration.
    expect((c1.querySelector('.clip-fade-overlay-in') as HTMLElement).style.width).toBe('40px');

    // REGRESSION: and it can be dragged BACK. The handler converted its drag delta
    // with `pxToSeconds`, which clamps to >= 0 because it exists to turn an x into
    // a time — so every leftward pointer move computed a delta of exactly zero and
    // the handle released at the value it already had. A fade could be grown, and
    // then never shortened or removed, for the life of the clip.
    // −20px ⇒ −0.5s at 40px/s, landing on a whole frame at 30fps so the committed
    // value is exact rather than frame-quantised to something near it.
    fireEvent.pointerDown(handle, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 20, pointerId: 1 });
    expect((c1.querySelector('.clip-fade-overlay-in') as HTMLElement).style.width).toBe('20px');

    // And all the way back to none, which is how a fade is removed by direct
    // manipulation at all.
    fireEvent.pointerDown(handle, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -60, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -60, pointerId: 1 });
    expect((c1.querySelector('.clip-fade-overlay-in') as HTMLElement).style.width).toBe('0px');
  });

  it('marks contact when a dragged clip meets a neighbour edge', () => {
    // A second clip ends at 6s; dragging c1 so its start lands ~6s should snap.
    const twoClips: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v',
              start: 0,
              end: 2,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [],
            },
            {
              id: 'c2',
              assetId: 'a',
              trackId: 'v',
              start: 6,
              end: 8,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    function TwoHost(): JSX.Element {
      const editor = useEditor(twoClips, ['a']);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }
    const { container } = render(<TwoHost />);
    const c1 = screen.getByLabelText('clip c1');
    // Grab c1's left, drag so the start lands at ~7.95s — within snap range of c2's
    // end (8s); landing there sits c1 adjacent to c2 (no overlap, so it validates).
    fireEvent.pointerDown(c1, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(c1, { clientX: 318, pointerId: 1 }); // 7.95s
    // The two clips are now flush, so this is contact — the join marker, not the
    // plain snap guide. The guide is reserved for snapping to something that is
    // not another clip (the playhead, a marker), where nothing is "meeting".
    expect(container.querySelector('.edge-contact')).not.toBeNull();
    expect(container.querySelector('.snap-guide')).toBeNull();
    fireEvent.pointerUp(c1, { clientX: 318, pointerId: 1 });
    // Snapped to 8s ⇒ 320px (not 318px).
    expect(screen.getByLabelText('clip c1').style.left).toBe('320px');
    // Temporary by construction: the marker belongs to the drag, so releasing
    // takes it away rather than leaving a rule behind on the timeline.
    expect(container.querySelector('.edge-contact')).toBeNull();
  });

  it('marks contact on BOTH edges, and without needing the magnet to fire', () => {
    // c1 is 2s long; the gap between c0 (ends 4s) and c2 (starts 6s) is exactly
    // 2s. Dropping c1 into it puts its head on c0's end and its tail on c2's
    // start at the same time — two joins, so two markers.
    const gap: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c0',
              assetId: 'a',
              trackId: 'v',
              start: 2,
              end: 4,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [],
            },
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v',
              start: 10,
              end: 12,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [],
            },
            {
              id: 'c2',
              assetId: 'a',
              trackId: 'v',
              start: 6,
              end: 8,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    };
    function GapHost(): JSX.Element {
      const editor = useEditor(gap, ['a']);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }
    const { container } = render(<GapHost />);
    const c1 = screen.getByLabelText('clip c1');

    // Alt bypasses the magnet entirely, so nothing snaps and the landing time is
    // whatever the pointer says. Contact is a question about what the edges LOOK
    // like, not about whether the snap engine fired — at 40px/s this lands 0.05s
    // from flush, which is 2px, and must still read as touching. Before this the
    // marker keyed off exact equality after a snap and stayed dark all gesture.
    fireEvent.pointerDown(c1, { clientX: 400, pointerId: 1 }); // 10s, c1's head
    fireEvent.pointerMove(c1, { clientX: 162, pointerId: 1, altKey: true }); // 4.05s
    const marks = container.querySelectorAll('.edge-contact');
    expect(marks).toHaveLength(2);
    expect([...marks].map((m) => (m as HTMLElement).style.left).sort()).toEqual(['160px', '240px']);
    fireEvent.pointerUp(c1, { clientX: 162, pointerId: 1, altKey: true });
  });

  it('moves a clip onto a compatible track under the pointer', () => {
    // Use layer_ prefix for the second track so it renders in the CapCut-style
    // visible-track filter (empty pre-seeded tracks are hidden; user-created
    // layer_ tracks always show as drop targets).
    const twoTracks: Timeline = {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v1',
              start: 0,
              end: 2,
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
    function MoveHost(): JSX.Element {
      const editor = useEditor(twoTracks, ['a']);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }
    render(<MoveHost />);
    // Pointer hovers the second video lane → compatible, so the move targets it.
    const v2Lane = document.querySelector('[data-track-id="layer_video_1"]') as HTMLElement;
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValue(v2Lane);
    const c1 = screen.getByLabelText('clip c1');
    fireEvent.pointerDown(c1, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(c1, { clientX: 180, pointerId: 1 });
    fireEvent.pointerUp(c1, { clientX: 180, pointerId: 1 });
    // c1 now lives inside the layer_video_1 lane.
    const v2 = document.querySelector('[data-track-id="layer_video_1"]') as HTMLElement;
    expect(v2.querySelector('[aria-label="clip c1"]')).not.toBeNull();
  });

  it('drops an asset from the bin at the cursor position, not at offset 0', () => {
    // Regression: the old handler used the event's offsetX (relative to whatever
    // child took the drop), mis-placing the clip. It must use the lane-relative
    // cursor, so a drop at clientX 200 (40px/s ⇒ 5s) lands the new clip at 200px.
    function DropHost(): JSX.Element {
      const editor = useEditor(timeline, ['a', 'b']);
      return (
        <TimelineView
          editor={editor}
          assets={[{ id: 'b', path: 'blob:b', kind: 'video', durationSeconds: 3 }]}
          fps={30}
        />
      );
    }
    const { container } = render(<DropHost />);
    const lane = container.querySelector('[data-track-id="v"]') as HTMLElement;
    const dataTransfer = {
      getData: (type: string) => (type === ASSET_DND_TYPE ? 'b' : ''),
      types: [ASSET_DND_TYPE],
    };
    // jsdom builds `drop` as a plain Event (no clientX); back it with a MouseEvent
    // so the handler reads a real cursor X, and attach the dataTransfer stub.
    const dropEvent = new MouseEvent('drop', { bubbles: true, clientX: 200 });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer });
    fireEvent(lane, dropEvent);
    const placed = Array.from(container.querySelectorAll('.clip-block')).find(
      (el) => (el as HTMLElement).style.left === '200px',
    );
    expect(placed).toBeTruthy();
    expect((placed as HTMLElement).style.width).toBe('120px'); // 3s @ 40px/s
  });

  it('drops a Text overlay from the Overlays panel onto a lane (#5)', () => {
    const { container } = render(<Host />);
    expect(container.querySelectorAll('.clip-block').length).toBe(1); // just c1
    const lane = container.querySelector('[data-track-id="v"]') as HTMLElement;
    const dataTransfer = {
      getData: (type: string) => (type === TEXT_OVERLAY_DND_TYPE ? 'text' : ''),
      types: [TEXT_OVERLAY_DND_TYPE],
    };
    const dropEvent = new MouseEvent('drop', { bubbles: true, clientX: 300 });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer });
    fireEvent(lane, dropEvent);
    // A new text-overlay clip is created at the drop point (alongside c1).
    expect(container.querySelectorAll('.clip-block').length).toBe(2);
  });

  it('adds a new layer at the front via the Add-track menu (Phase 2 / TIMELINE-TOOLBAR-REORG)', () => {
    const { container } = render(<Host />);
    const before = container.querySelectorAll('[aria-label^="track "]').length;
    fireEvent.click(screen.getByLabelText('Add track'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Video' }));
    const tracks = container.querySelectorAll('[aria-label^="track "]');
    expect(tracks.length).toBe(before + 1);
    // The new layer is inserted at index 0 (the visual front / top of the stack).
    expect(tracks[0]!.getAttribute('aria-label')).toMatch(/^track layer_video_/);
  });

  it('adds an EFFECT lane via the Add-track menu, like every other offered role', () => {
    // Every other role had a test; the effect lane did not, and it is the one whose
    // geometry differs (EFFECT_TRACK_HEIGHT, not the 56px default), so it is the one a
    // regression in the add path would hide behind.
    const { container } = render(<Host />);
    const before = container.querySelectorAll('[aria-label^="track "]').length;
    fireEvent.click(screen.getByLabelText('Add track'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Effects (adjustment)' }));
    const tracks = container.querySelectorAll('[aria-label^="track "]');
    expect(tracks.length).toBe(before + 1);
    expect(tracks[0]!.getAttribute('aria-label')).toMatch(/^track layer_effect_/);
  });

  it('adds a new audio layer via the Add-track menu', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByLabelText('Add track'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Audio' }));
    const tracks = container.querySelectorAll('[aria-label^="track "]');
    expect(tracks[0]!.getAttribute('aria-label')).toMatch(/^track layer_audio_/);
  });

  it('offers every lane role in the Add-track menu, not just video/audio', () => {
    render(<Host />);
    fireEvent.click(screen.getByLabelText('Add track'));
    const items = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim())
      .filter(Boolean);
    // Caption / overlay / effect lanes are all first-class in the schema; the
    // menu used to hide them, leaving an effect lane unreachable from the UI.
    expect(items).toEqual(['Video', 'Audio', 'Text / overlay', 'Captions', 'Effects (adjustment)']);
  });

  it.each([
    ['Text / overlay', /^track layer_overlay_/],
    ['Captions', /^track layer_caption_/],
    ['Effects (adjustment)', /^track layer_effect_/],
  ])('adds a %s layer via the Add-track menu', (label, idPattern) => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByLabelText('Add track'));
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    const tracks = container.querySelectorAll('[aria-label^="track "]');
    expect(tracks[0]!.getAttribute('aria-label')).toMatch(idPattern);
  });

  it('right-clicking a track header opens the track menu (not the clip menu)', () => {
    render(<Host />);
    fireEvent.contextMenu(document.querySelector('.track-head')!, { clientX: 12, clientY: 40 });
    const menu = screen.getByRole('menu', { name: 'track actions' });
    expect(menu).toBeDefined();
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Add track above', 'Add track below', 'Delete track (1 item)']);
  });

  it('deletes a track from its context menu, and one undo brings it back with its clips', () => {
    // The keyboard shortcuts live in `Editor`, not this view, so undo is driven
    // through the store the menu itself commits to.
    let editor!: ReturnType<typeof useEditor>;
    function UndoHost(): JSX.Element {
      editor = useEditor(timeline, ['a']);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }
    const { container } = render(<UndoHost />);
    fireEvent.contextMenu(document.querySelector('.track-head')!, { clientX: 12, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete track/ }));
    expect(container.querySelectorAll('[aria-label^="track "]').length).toBe(0);
    expect(container.querySelectorAll('.clip-block').length).toBe(0);

    // `remove_layer` inverts to an `add_layer` carrying the clips, so the lane
    // comes back populated — a lossy delete would restore an empty lane.
    act(() => editor.undo());
    expect(container.querySelectorAll('[aria-label^="track "]').length).toBe(1);
    expect(screen.getByLabelText('clip c1')).toBeDefined();
  });

  it.each([
    ['Add track above', 0],
    ['Add track below', 1],
  ])('%s inserts the new lane at the right z-order slot', (label, expectedIndex) => {
    const { container } = render(<Host />);
    fireEvent.contextMenu(document.querySelector('.track-head')!, { clientX: 12, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    const tracks = [...container.querySelectorAll('[aria-label^="track "]')].map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(tracks).toHaveLength(2);
    // Index 0 is the visual front, so "above" is the LOWER index. The new lane
    // inherits the clicked lane's type, which is what makes above/below useful.
    expect(tracks[expectedIndex]).toMatch(/^track layer_video_/);
  });

  it('zoom-to-fit widens the lane to span the timeline', () => {
    render(<Host />);
    const before = clip().style.width;
    // The toolbar's Zoom-to-fit button lives outside this view now (moved to
    // Toolbar.tsx, TIMELINE-TOOLBAR-REORG); it dispatches the same decoupled
    // window event the `⇧Z` shortcut always used, which this view still listens for.
    fireEvent(window, new CustomEvent('framepilot:zoom', { detail: 'fit' }));
    // Fit recomputes px/s for the 10s minimum lane; the clip width changes.
    expect(clip().style.width).not.toBe(before);
  });

  it('opens a clip context menu and duplicates from it', () => {
    const { container } = render(<Host />);
    fireEvent.contextMenu(clip(), { clientX: 30, clientY: 40 });
    const menu = screen.getByRole('menu', { name: 'clip actions' });
    expect(menu).toBeDefined();
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
    // c1 is the only clip on its track → the duplicate appends after it (no overlap).
    expect(container.querySelectorAll('.clip-block').length).toBe(2);
    // Menu closes after the action.
    expect(screen.queryByRole('menu', { name: 'clip actions' })).toBeNull();
  });

  it('closes the context menu on Escape without acting', () => {
    const { container } = render(<Host />);
    fireEvent.contextMenu(clip(), { clientX: 30, clientY: 40 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'clip actions' })).toBeNull();
    expect(container.querySelectorAll('.clip-block').length).toBe(1);
  });

  describe('clip header (anatomy v2)', () => {
    /** Render one clip whose pixel width is fixed by the zoom × its duration. */
    function HeaderHost({ end }: { readonly end: number }): JSX.Element {
      const oneClip: Timeline = {
        tracks: [
          {
            id: 'v',
            type: 'video',
            clips: [
              {
                id: 'c1',
                assetId: 'a',
                trackId: 'v',
                start: 0,
                end,
                sourceStart: 0,
                sourceEnd: end,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      };
      const editor = useEditor(oneClip, ['a']);
      return <TimelineView editor={editor} assets={[]} fps={30} />;
    }

    it('renders the title + duration inside a single header row on a wide clip', () => {
      // 4s @ 40px/s ⇒ 160px (wide tier: title + duration + ⋯).
      render(<HeaderHost end={4} />);
      const header = clip().querySelector('.clip-header');
      expect(header).not.toBeNull();
      expect(header!.querySelector('.clip-label')).not.toBeNull();
      expect(header!.querySelector('.clip-time')).not.toBeNull();
      expect(header!.querySelector('.clip-menu-btn')).not.toBeNull();
    });

    it('opens the clip menu (with the right clipId) from the ⋯ button', () => {
      const { container } = render(<HeaderHost end={4} />);
      const menuBtn = screen.getByLabelText('Clip actions');
      fireEvent.click(menuBtn, { clientX: 50, clientY: 60 });
      // Same menu the right-click path opens, and the clip is now selected.
      expect(screen.getByRole('menu', { name: 'clip actions' })).toBeDefined();
      expect(clip().getAttribute('data-selected')).toBe('true');
      // Acting on it targets c1 (duplicate appends a second clip).
      fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
      expect(container.querySelectorAll('.clip-block').length).toBe(2);
    });

    it('opens the clip menu from the ⋯ button via keyboard (Enter)', () => {
      render(<HeaderHost end={4} />);
      const menuBtn = screen.getByLabelText('Clip actions');
      menuBtn.getBoundingClientRect = vi.fn(() => ({ left: 10, bottom: 20 }) as DOMRect);
      fireEvent.keyDown(menuBtn, { key: 'Enter' });
      expect(screen.getByRole('menu', { name: 'clip actions' })).toBeDefined();
      expect(clip().getAttribute('data-selected')).toBe('true');
    });

    it('opens the clip menu from the ⋯ button via keyboard (Space)', () => {
      render(<HeaderHost end={4} />);
      const menuBtn = screen.getByLabelText('Clip actions');
      menuBtn.getBoundingClientRect = vi.fn(() => ({ left: 10, bottom: 20 }) as DOMRect);
      fireEvent.keyDown(menuBtn, { key: ' ' });
      expect(screen.getByRole('menu', { name: 'clip actions' })).toBeDefined();
    });

    it('ignores non-activating keys on the ⋯ button (no menu opens)', () => {
      render(<HeaderHost end={4} />);
      fireEvent.keyDown(screen.getByLabelText('Clip actions'), { key: 'a' });
      expect(screen.queryByRole('menu', { name: 'clip actions' })).toBeNull();
    });

    it('does not select the clip when only the ⋯ button is pressed (pointer down)', () => {
      render(<HeaderHost end={4} />);
      const menuBtn = screen.getByLabelText('Clip actions');
      // A bare pointer-down on the button must not begin a gesture nor select.
      fireEvent.pointerDown(menuBtn, { clientX: 50, pointerId: 1 });
      expect(clip().getAttribute('data-selected')).not.toBe('true');
    });

    it('medium tier: hides the ⋯ button but keeps title + duration', () => {
      // 2s @ 40px/s ⇒ 80px (≥ time min 56, < menu min 96).
      render(<HeaderHost end={2} />);
      expect(clip().querySelector('.clip-label')).not.toBeNull();
      expect(clip().querySelector('.clip-time')).not.toBeNull();
      expect(clip().querySelector('.clip-menu-btn')).toBeNull();
    });

    it('narrow tier: shows the title only (no duration, no ⋯)', () => {
      // 1s @ 40px/s ⇒ 40px (≥ header min 24, < time min 56).
      render(<HeaderHost end={1} />);
      expect(clip().querySelector('.clip-header')).not.toBeNull();
      expect(clip().querySelector('.clip-label')).not.toBeNull();
      expect(clip().querySelector('.clip-time')).toBeNull();
      expect(clip().querySelector('.clip-menu-btn')).toBeNull();
    });

    it('sliver tier: renders no header at all (just the color block)', () => {
      // 0.4s @ 40px/s ⇒ 16px (< header min 24): bare block, no overflow.
      render(<HeaderHost end={0.4} />);
      expect(clip().querySelector('.clip-header')).toBeNull();
      expect(clip().querySelector('.clip-label')).toBeNull();
    });
  });
});
