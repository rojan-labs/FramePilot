/**
 * Keyframes as objects on the timeline (revamp Phase 6, F4).
 *
 * `timeline/keyframe-lanes.test.ts` proves the arithmetic; this proves the surface —
 * that a keyframe can be seen, selected, dragged and deleted, and above all that
 * **dragging a keyframe never drags the clip**, which is the one failure that would
 * make the feature worse than the decoration it replaced.
 *
 * jsdom reports zero-origin rects, so a pointer `clientX` maps straight through
 * `pxToSeconds(clientX, pxPerSecond)`; at the 40 px/s default zoom, clientX 160 ⇒ 4s.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Keyframe, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { TimelineView } from './TimelineView.js';

const kf = (property: string, time: number, value = 1): Keyframe =>
  ({ id: `${property}_${time}`, property, time, value, easing: 'linear' }) as Keyframe;

/** One 8s clip carrying a scale ramp and a single x keyframe on top of it. */
const animatedTimeline: Timeline = {
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
          end: 8,
          sourceStart: 0,
          sourceEnd: 8,
          effects: [],
          keyframes: [kf('scale', 0, 1), kf('scale', 4, 2), kf('x', 4, 100)],
        },
      ],
    },
  ],
};

const stillTimeline: Timeline = {
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
          end: 8,
          sourceStart: 0,
          sourceEnd: 8,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

function Host({
  timeline = animatedTimeline,
  at,
  onKeyframeSelectionChange,
}: {
  timeline?: Timeline;
  /** Optional playhead position, seeked via the button below. */
  at?: number;
  onKeyframeSelectionChange?: (
    keyframes: readonly {
      readonly clipId: string;
      readonly property: string;
      readonly time: number;
    }[],
  ) => void;
} = {}): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return (
    <>
      <button type="button" onClick={() => editor.seek(at ?? 0)}>
        seek
      </button>
      <span data-testid="keyframes">
        {clip.keyframes
          .slice()
          .sort((a, b) => a.property.localeCompare(b.property) || a.time - b.time)
          .map((k) => `${k.property}@${k.time}`)
          .join(' ')}
      </span>
      <span data-testid="span">{`${clip.start}-${clip.end}`}</span>
      <span data-testid="history">{editor.state.history.entries.length}</span>
      <TimelineView
        editor={editor}
        assets={[]}
        fps={30}
        {...(onKeyframeSelectionChange ? { onKeyframeSelectionChange } : {})}
      />
    </>
  );
}

/** jsdom has no PointerEvent, so coordinates are dropped — back it with MouseEvent. */
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props);
    this.pointerId = props.pointerId ?? 0;
  }
}

beforeEach(() => {
  (globalThis as { PointerEvent?: unknown }).PointerEvent = FakePointerEvent;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const keyframes = (): string => screen.getByTestId('keyframes').textContent ?? '';
const span = (): string => screen.getByTestId('span').textContent ?? '';
const historyLength = (): number => Number(screen.getByTestId('history').textContent);

/** Open the clip's lanes — everything below needs them. */
const expand = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /Show keyframes for/i }));
};

/** Drag a marker from `fromX` to `toX` (client px), the full pointer sequence. */
const dragMarker = (marker: HTMLElement, fromX: number, toX: number, init: object = {}): void => {
  fireEvent.pointerDown(marker, { clientX: fromX, pointerId: 1, button: 0, ...init });
  fireEvent.pointerMove(marker, { clientX: toX, pointerId: 1, ...init });
  fireEvent.pointerUp(marker, { clientX: toX, pointerId: 1, ...init });
};

describe('the expand affordance', () => {
  it('is offered on an animated clip and opens per-property lanes', () => {
    render(<Host />);
    expect(document.querySelectorAll('.keyframe-lane')).toHaveLength(0);
    expand();
    // One lane per animated property — the whole point of F4. The old code
    // collapsed both of these into a single anonymous dot at 4s.
    const lanes = [...document.querySelectorAll('.keyframe-lane')].map((lane) =>
      lane.getAttribute('data-property'),
    );
    expect(lanes).toEqual(['scale', 'x']);
  });

  it('is not offered on a clip with no animation', () => {
    // An expander that opens an empty drawer is a promise the clip cannot keep.
    render(<Host timeline={stillTimeline} />);
    expect(screen.queryByRole('button', { name: /keyframes for/i })).toBeNull();
  });

  it('collapses again, and says which state it is in', () => {
    render(<Host />);
    const toggle = screen.getByRole('button', { name: /Show keyframes for/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: /Hide keyframes for/i }).getAttribute('aria-expanded'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Hide keyframes for/i }));
    expect(document.querySelectorAll('.keyframe-lane')).toHaveLength(0);
  });
});

describe('markers are real objects', () => {
  it('renders one marker per keyframe, in its own property lane', () => {
    render(<Host />);
    expand();
    const scaleLane = document.querySelector('.keyframe-lane[data-property="scale"]')!;
    const xLane = document.querySelector('.keyframe-lane[data-property="x"]')!;
    expect(scaleLane.querySelectorAll('.keyframe-marker')).toHaveLength(2);
    expect(xLane.querySelectorAll('.keyframe-marker')).toHaveLength(1);
  });

  it('announces property, value, time and easing — the hover readout', () => {
    render(<Host />);
    expand();
    // The old markers were aria-hidden with no handlers; a screen-reader user had no
    // idea a clip was animated at all.
    expect(screen.getByRole('button', { name: /^scale 2 @ 4\.00s · linear/ })).toBeTruthy();
  });

  it('selects on click and says so', () => {
    render(<Host />);
    expand();
    const marker = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(marker, { clientX: 160, pointerId: 1, button: 0 });
    fireEvent.pointerUp(marker, { clientX: 160, pointerId: 1 });
    expect(
      screen
        .getByRole('button', { name: /^scale 2 @ 4\.00s.*selected/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('publishes the exact selected keyframe reference for AI context', async () => {
    const selections: unknown[] = [];
    render(<Host onKeyframeSelectionChange={(selection) => selections.push(selection)} />);
    expand();
    const marker = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(marker, { clientX: 160, pointerId: 1, button: 0 });
    fireEvent.pointerUp(marker, { clientX: 160, pointerId: 1 });
    await waitFor(() =>
      expect(selections.at(-1)).toEqual([{ clipId: 'c1', property: 'scale', time: 4 }]),
    );
  });

  it('shift-click adds to the selection, and marks the group', () => {
    render(<Host />);
    expand();
    const first = screen.getByRole('button', { name: /^scale 1 @ 0\.00s/ });
    fireEvent.pointerDown(first, { clientX: 0, pointerId: 1, button: 0 });
    fireEvent.pointerUp(first, { clientX: 0, pointerId: 1 });
    const second = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(second, { clientX: 160, pointerId: 2, button: 0, shiftKey: true });
    fireEvent.pointerUp(second, { clientX: 160, pointerId: 2, shiftKey: true });
    expect(document.querySelectorAll('.keyframe-marker[data-in-group="true"]')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: /1 of 2 selected.*@ 0\.00s|@ 0\.00s.*1 of 2/ }),
    ).toBeTruthy();
  });
});

describe('moving a keyframe from the keyboard', () => {
  it('nudges by one frame per arrow press, in ONE undo step', () => {
    // The pointer could already drag a keyframe and the keyboard could not, so the
    // marker announced itself as an operable button and then refused to move — the
    // same gap the fade handles were given a keydown to close.
    render(<Host />);
    expand();
    const before = historyLength();
    // 30fps, so one frame is 1/30s: scale@4 lands at 4.0333…
    fireEvent.keyDown(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), {
      key: 'ArrowRight',
    });
    expect(screen.getByRole('button', { name: /^scale 2 @ 4\.03s/ })).toBeDefined();
    expect(historyLength()).toBe(before + 1);
  });

  it('nudges left, and ten frames at a time with Shift', () => {
    render(<Host />);
    expand();
    fireEvent.keyDown(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), {
      key: 'ArrowLeft',
      shiftKey: true,
    });
    // Ten frames at 30fps is a third of a second.
    expect(screen.getByRole('button', { name: /^scale 2 @ 3\.67s/ })).toBeDefined();
  });

  it('ignores keys that are not a nudge, so the lane keeps its own bindings', () => {
    // Delete and Escape belong to the lane group, which owns the whole selection.
    render(<Host />);
    expand();
    const before = historyLength();
    fireEvent.keyDown(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), { key: 'a' });
    expect(keyframes()).toBe('scale@0 scale@4 x@4');
    expect(historyLength()).toBe(before);
  });
});

describe('dragging a keyframe', () => {
  it('moves it, in ONE undo step', () => {
    render(<Host />);
    expand();
    const before = historyLength();
    // 160px → 80px at 40 px/s = −2s, so scale@4 lands at 2.
    dragMarker(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), 160, 80, {
      altKey: true, // suppress snapping so the assertion is about the drag, not a target
    });
    expect(keyframes()).toBe('scale@0 scale@2 x@4');
    expect(historyLength()).toBe(before + 1);
  });

  it('NEVER drags the clip', () => {
    // The failure that would make lanes worse than the decoration they replaced.
    render(<Host />);
    expand();
    const spanBefore = span();
    dragMarker(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), 160, 80, {
      altKey: true,
    });
    expect(span()).toBe(spanBefore);
  });

  it('moves a whole selection together, keeping its shape, in one step', () => {
    render(<Host />);
    expand();
    const first = screen.getByRole('button', { name: /^scale 1 @ 0\.00s/ });
    fireEvent.pointerDown(first, { clientX: 0, pointerId: 1, button: 0 });
    fireEvent.pointerUp(first, { clientX: 0, pointerId: 1 });
    const second = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(second, { clientX: 160, pointerId: 2, button: 0, shiftKey: true });
    fireEvent.pointerUp(second, { clientX: 160, pointerId: 2, shiftKey: true });

    const before = historyLength();
    // Grab the one at 4s and push it +2s; the one at 0s must come along.
    dragMarker(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), 160, 240, {
      altKey: true,
    });
    // Both moved by 2, keeping their 4s spacing — and the batched remove-then-add
    // ordering means the 0→2 move did not clobber the keyframe travelling to 6.
    expect(keyframes()).toBe('scale@2 scale@6 x@4');
    expect(historyLength()).toBe(before + 1);
  });

  it('clamps the group at the clip edge instead of squashing it', () => {
    render(<Host />);
    expand();
    const first = screen.getByRole('button', { name: /^scale 1 @ 0\.00s/ });
    fireEvent.pointerDown(first, { clientX: 0, pointerId: 1, button: 0 });
    fireEvent.pointerUp(first, { clientX: 0, pointerId: 1 });
    const second = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(second, { clientX: 160, pointerId: 2, button: 0, shiftKey: true });
    fireEvent.pointerUp(second, { clientX: 160, pointerId: 2, shiftKey: true });

    // Drag far past the clip end (8s). The later keyframe stops at 8, and the
    // earlier one keeps its 4s offset at 4 — the spacing survives.
    dragMarker(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), 160, 2000, {
      altKey: true,
    });
    expect(keyframes()).toBe('scale@4 scale@8 x@4');
  });

  it('costs no undo step when the pointer did not move', () => {
    render(<Host />);
    expand();
    const before = historyLength();
    dragMarker(screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ }), 160, 160);
    expect(historyLength()).toBe(before);
  });

  it('snaps onto a keyframe in ANOTHER lane', () => {
    // A dedicated fixture: in `animatedTimeline` the x keyframe sits at 4s, where
    // scale already has one, so that time is (correctly) not offered as a target.
    // Here x is at 6s, which nothing in the scale lane occupies.
    const crossLane: Timeline = {
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
              end: 8,
              sourceStart: 0,
              sourceEnd: 8,
              effects: [],
              keyframes: [kf('scale', 0, 1), kf('x', 6, 100)],
            },
          ],
        },
      ],
    };
    render(<Host timeline={crossLane} />);
    expand();
    // scale@0 dragged to 5.9s; x@6 is one lane down and well inside the 6px
    // threshold, so it lands exactly on 6 — lining the two animations up.
    dragMarker(screen.getByRole('button', { name: /^scale 1 @ 0\.00s/ }), 0, 236);
    expect(keyframes()).toBe('scale@6 x@6');
  });

  it('is never snapped onto a sibling in its OWN lane, which would destroy it', () => {
    render(<Host />);
    expand();
    // scale@0 dragged to 3.9s. scale@4 is a sibling, and x@4 shares its time — so
    // without the collision filter the x keyframe's time would pull this one onto
    // scale@4 and replace it. It must stay where the pointer left it.
    dragMarker(screen.getByRole('button', { name: /^scale 1 @ 0\.00s/ }), 0, 156);
    expect(keyframes()).toBe('scale@3.9 scale@4 x@4');
  });
});

describe('the playhead reaches the lanes', () => {
  // TimelineView deliberately does not read `state.playhead` (its lane subtree is
  // memoised against exactly that), so the lanes subscribe themselves. Without this
  // wiring the at-playhead state never lights and playhead snapping never fires —
  // both silently, which is why they are asserted.
  it('marks the keyframe under the playhead', () => {
    render(<Host at={4} />);
    expand();
    // The playhead starts at 0, where scale@0 sits — so one marker is already lit.
    expect(document.querySelectorAll('.keyframe-marker[data-at-playhead="true"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'seek' }));
    // Moving it to 4s lights the two keyframes there, and unlights the one at 0.
    expect(document.querySelectorAll('.keyframe-marker[data-at-playhead="true"]')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^scale 2 @ 4\.00s.*at the playhead/ })).toBeTruthy();
  });

  it('does not mark a keyframe when the playhead is elsewhere', () => {
    render(<Host at={7} />);
    expand();
    fireEvent.click(screen.getByRole('button', { name: 'seek' }));
    expect(document.querySelectorAll('.keyframe-marker[data-at-playhead="true"]')).toHaveLength(0);
  });

  it('snaps a dragged keyframe onto the playhead', () => {
    render(<Host at={7} />);
    expand();
    fireEvent.click(screen.getByRole('button', { name: 'seek' }));
    // scale@0 dragged to 6.9s, with the playhead parked at 7 — inside the threshold.
    dragMarker(screen.getByRole('button', { name: /^scale 1 @ 0\.00s/ }), 0, 276);
    expect(keyframes()).toBe('scale@4 scale@7 x@4');
  });
});

describe('deleting keyframes', () => {
  it('removes the selection on Delete, in one step', () => {
    render(<Host />);
    expand();
    const marker = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(marker, { clientX: 160, pointerId: 1, button: 0 });
    fireEvent.pointerUp(marker, { clientX: 160, pointerId: 1 });
    const before = historyLength();
    fireEvent.keyDown(marker, { key: 'Delete' });
    expect(keyframes()).toBe('scale@0 x@4');
    expect(historyLength()).toBe(before + 1);
  });

  it('removes a multi-lane selection as ONE patch', () => {
    render(<Host />);
    expand();
    const scaleMarker = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(scaleMarker, { clientX: 160, pointerId: 1, button: 0 });
    fireEvent.pointerUp(scaleMarker, { clientX: 160, pointerId: 1 });
    const xMarker = screen.getByRole('button', { name: /^x 100 @ 4\.00s/ });
    fireEvent.pointerDown(xMarker, { clientX: 160, pointerId: 2, button: 0, shiftKey: true });
    fireEvent.pointerUp(xMarker, { clientX: 160, pointerId: 2, shiftKey: true });

    const before = historyLength();
    fireEvent.keyDown(xMarker, { key: 'Delete' });
    expect(keyframes()).toBe('scale@0');
    expect(historyLength()).toBe(before + 1);
  });

  it('clears the selection on Escape without editing', () => {
    render(<Host />);
    expand();
    const marker = screen.getByRole('button', { name: /^scale 2 @ 4\.00s/ });
    fireEvent.pointerDown(marker, { clientX: 160, pointerId: 1, button: 0 });
    fireEvent.pointerUp(marker, { clientX: 160, pointerId: 1 });
    const before = historyLength();
    fireEvent.keyDown(marker, { key: 'Escape' });
    expect(document.querySelectorAll('.keyframe-marker[data-selected="true"]')).toHaveLength(0);
    expect(historyLength()).toBe(before);
  });
});

describe('adding a keyframe from a lane', () => {
  it('double-click drops one at that time, pinning the value already there', () => {
    render(<Host />);
    expand();
    const lane = document.querySelector('.keyframe-lane[data-property="scale"]')!;
    // 80px at 40 px/s = 2s, halfway up the 1→2 ramp.
    fireEvent.doubleClick(lane, { clientX: 80 });
    expect(keyframes()).toBe('scale@0 scale@2 scale@4 x@4');
    // Pinning the curve's own value means dropping a keyframe never moves the
    // picture — it only records where it already is.
    expect(screen.getByRole('button', { name: /^scale 1\.5 @ 2\.00s/ })).toBeTruthy();
  });
});
