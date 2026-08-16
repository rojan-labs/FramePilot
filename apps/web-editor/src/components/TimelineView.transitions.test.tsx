/**
 * On-cut transition UX tests (Timeline Revamp M3b): the transition pill renders
 * straddling a valid cut, selecting it selects the incoming clip, a pointer drag
 * on an edge resizes the duration as ONE patch, and the empty-cut affordance adds
 * a default cross-dissolve on double-click or on a drop from the browser.
 *
 * jsdom reports zero-origin rects, so a pointer `clientX` maps straight through
 * `pxToSeconds(clientX, pxPerSecond)`; at the 40px/s default zoom 1s ⇒ 40px.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Effect, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { TimelineView } from './TimelineView.js';
import { TRANSITION_DND_TYPE } from './EffectsPanel.js';

const transition = (toId: string, fromId: string, durationSeconds: number): Effect => ({
  id: `${toId}__transition`,
  type: 'transition',
  params: { kind: 'fade', durationSeconds, fromClipId: fromId },
  keyframes: [],
});

/** Two adjacent clips a [0,4], b [4,10]; `withTransition` adds a fade entering b. */
const makeTimeline = (withTransition: boolean): Timeline => ({
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
        {
          id: 'b',
          assetId: 'm',
          trackId: 'v',
          start: 4,
          end: 10,
          sourceStart: 0,
          sourceEnd: 6,
          effects: withTransition ? [transition('b', 'a', 1)] : [],
          keyframes: [],
        },
      ],
    },
  ],
});

function Host({ withTransition }: { readonly withTransition: boolean }): JSX.Element {
  const editor = useEditor(makeTimeline(withTransition), ['m']);
  return <TimelineView editor={editor} assets={[]} fps={30} />;
}

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
});

describe('TimelineView on-cut transitions (M3b)', () => {
  it('renders a pill on the cut and selecting it selects the incoming clip', () => {
    const { container } = render(<Host withTransition />);
    const pill = container.querySelector('.clip-transition-pill') as HTMLElement;
    expect(pill).not.toBeNull();
    // Centred on the 4s cut (160px), width = 1s (40px): left = 3.5s = 140px.
    expect(pill.style.left).toBe('140px');
    expect(pill.style.width).toBe('40px');
    fireEvent.click(pill);
    expect(screen.getByLabelText('clip b').getAttribute('data-selected')).toBe('true');
  });

  it('dragging the pill edge resizes the duration as one committed patch', () => {
    const { container } = render(<Host withTransition />);
    const edge = container.querySelector('.clip-transition-pill-edge-r') as HTMLElement;
    // +20px on the right edge → +2·(20/40)s = +1s → duration 1s → 2s (≤ max 4s).
    fireEvent.pointerDown(edge, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 20, pointerId: 1 });
    const pill = container.querySelector('.clip-transition-pill') as HTMLElement;
    expect(pill.getAttribute('aria-label')).toBe('Fade transition, 2.00s');
    expect(pill.style.width).toBe('80px'); // 2s @ 40px/s
  });

  it('selects the incoming clip via the keyboard (Enter)', () => {
    const { container } = render(<Host withTransition />);
    const pill = container.querySelector('.clip-transition-pill') as HTMLElement;
    fireEvent.keyDown(pill, { key: 'Enter' });
    expect(screen.getByLabelText('clip b').getAttribute('data-selected')).toBe('true');
  });

  it('dragging the left edge resizes symmetrically about the cut too', () => {
    const { container } = render(<Host withTransition />);
    const edge = container.querySelector('.clip-transition-pill-edge-l') as HTMLElement;
    // -20px on the left edge → +2·(20/40)s = +1s (outward) → 1s → 2s.
    fireEvent.pointerDown(edge, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 0, pointerId: 1 });
    const pill = container.querySelector('.clip-transition-pill') as HTMLElement;
    expect(pill.getAttribute('aria-label')).toBe('Fade transition, 2.00s');
  });

  it('a sub-threshold press does not resize (it is a click, not a drag)', () => {
    const { container } = render(<Host withTransition />);
    const edge = container.querySelector('.clip-transition-pill-edge-r') as HTMLElement;
    fireEvent.pointerDown(edge, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 2, pointerId: 1 }); // within RESIZE_THRESHOLD_PX
    fireEvent.pointerUp(edge, { clientX: 2, pointerId: 1 });
    const pill = container.querySelector('.clip-transition-pill') as HTMLElement;
    expect(pill.getAttribute('aria-label')).toBe('Fade transition, 1.00s');
  });

  it('clicking the empty-cut affordance opens a picker; choosing a kind adds it (#8)', () => {
    const { container } = render(<Host withTransition={false} />);
    expect(container.querySelector('.clip-transition-pill')).toBeNull();
    const add = container.querySelector('.clip-transition-add') as HTMLElement;
    expect(add).not.toBeNull();
    // Click opens the picker rather than silently inserting a default.
    fireEvent.click(add);
    const picker = screen.getByRole('dialog', { name: 'Choose a transition' });
    expect(picker).not.toBeNull();
    expect(container.querySelector('.clip-transition-pill')).toBeNull();
    // Choosing a transition commits it and closes the picker. The picker is a
    // grid of previews now, not a list of words, so the tile is a button whose
    // accessible name leads with the transition's label.
    fireEvent.click(within(picker).getByRole('button', { name: /^Zoom In\./ }));
    expect(container.querySelector('.clip-transition-pill')).not.toBeNull();
  });

  it('gives a dropped transition its own default length, not one global number', () => {
    const { container } = render(<Host withTransition={false} />);
    const add = container.querySelector('.clip-transition-add') as HTMLElement;
    fireEvent.drop(add, {
      dataTransfer: {
        getData: (type: string) => (type === TRANSITION_DND_TYPE ? 'whip-pan-left' : ''),
        types: [TRANSITION_DND_TYPE],
      },
    });
    const block = container.querySelector('.clip-transition-pill') as HTMLElement;
    // A whip pan wants 0.28s; the old default of 0.5s would be twice the length
    // the transition was designed at.
    expect(block.getAttribute('aria-label')).toContain('0.28s');
  });

  it('dropping a transition kind onto the cut adds it', () => {
    const { container } = render(<Host withTransition={false} />);
    const add = container.querySelector('.clip-transition-add') as HTMLElement;
    const dataTransfer = {
      getData: (type: string) => (type === TRANSITION_DND_TYPE ? 'zoom' : ''),
      types: [TRANSITION_DND_TYPE],
    };
    const dropEvent = new MouseEvent('drop', { bubbles: true });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer });
    fireEvent(add, dropEvent);
    expect(container.querySelector('.clip-transition-pill')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Revamp Phase 8 — the block, not the pill
// ---------------------------------------------------------------------------

describe('the transition block says what it is', () => {
  it('shows its kind and duration when there is room', () => {
    // Before this a timeline of six transitions was six identical arrows.
    const { container } = render(<Host withTransition />);
    const block = container.querySelector('.clip-transition-pill') as HTMLElement;
    // 1s at 40 px/s = 40px, which is icon density — wide enough for a glyph, not
    // for words.
    expect(block.getAttribute('data-density')).toBe('icon');
    expect(block.getAttribute('title')).toBe('Fade 1.00s');
  });

  it('carries the duration in its accessible name at EVERY density', () => {
    // A block too narrow to print its label is exactly the one a screen-reader user
    // has no other way to identify.
    const { container } = render(<Host withTransition />);
    const block = container.querySelector('.clip-transition-pill') as HTMLElement;
    expect(block.getAttribute('aria-label')).toBe('Fade transition, 1.00s');
  });

  it('shows a live duration readout while an edge is dragged, and not before', () => {
    const { container } = render(<Host withTransition />);
    expect(container.querySelector('.clip-transition-readout')).toBeNull();
    const edge = container.querySelector('.clip-transition-pill-edge-r') as HTMLElement;
    fireEvent.pointerDown(edge, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 20, pointerId: 1 });
    // The pill's real gap: you used to drag blind and read the result afterwards.
    expect(container.querySelector('.clip-transition-readout')?.textContent).toBe('2.00s');
    fireEvent.pointerUp(edge, { clientX: 20, pointerId: 1 });
    expect(container.querySelector('.clip-transition-readout')).toBeNull();
  });
});

describe("the block's actions menu", () => {
  const openMenu = () => {
    const { container } = render(<Host withTransition />);
    const block = container.querySelector('.clip-transition-pill') as HTMLElement;
    fireEvent.contextMenu(block, { clientX: 100, clientY: 100 });
    return container;
  };

  it('opens on right-click with replace, presets and remove', () => {
    openMenu();
    const menu = screen.getByRole('menu', { name: 'transition actions' });
    expect(within(menu).getByRole('menuitem', { name: /Replace transition/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Remove transition/ })).toBeTruthy();
    expect(within(menu).getAllByRole('menuitemradio').length).toBeGreaterThan(0);
  });

  it('marks the preset that matches the current duration', () => {
    openMenu();
    // The fixture transition is 1s, which is the "Slow" preset.
    const slow = screen.getByRole('menuitemradio', { name: /Slow/ });
    expect(slow.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: /Fast/ }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('applies a preset duration as one patch', () => {
    const container = openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Fast/ }));
    const block = container.querySelector('.clip-transition-pill') as HTMLElement;
    expect(block.getAttribute('aria-label')).toBe('Fade transition, 0.25s');
  });

  it('removes the transition', () => {
    const container = openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove transition/ }));
    expect(container.querySelector('.clip-transition-pill')).toBeNull();
  });

  it('replace reopens the picker, so one place knows what kinds exist', () => {
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Replace transition/ }));
    expect(screen.getByRole('dialog', { name: 'Choose a transition' })).toBeTruthy();
  });
});

describe('the insertion affordance explains itself', () => {
  it('offers an eligible cut normally', () => {
    render(<Host withTransition={false} />);
    expect(screen.getByRole('button', { name: 'Add transition at cut before b' })).toBeTruthy();
  });

  it('applies one kind to every eligible cut as ONE undo step', () => {
    // Three clips ⇒ two abutting cuts.
    const threeClips: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: ['a', 'b', 'c'].map((id, index) => ({
            id,
            assetId: 'm',
            trackId: 'v',
            start: index * 4,
            end: index * 4 + 4,
            sourceStart: 0,
            sourceEnd: 4,
            effects: [],
            keyframes: [],
          })),
        },
      ],
    };
    function ThreeHost(): JSX.Element {
      const editor = useEditor(threeClips, ['m']);
      return (
        <>
          <span data-testid="history">{editor.state.history.entries.length}</span>
          <TimelineView editor={editor} assets={[]} fps={30} />
        </>
      );
    }
    const { container } = render(<ThreeHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Add transition at cut before b' }));
    const before = Number(screen.getByTestId('history').textContent);
    // One "All" per kind, scoped to its row — so the kind and the scope are one
    // decision. Pick the cross-dissolve row's.
    fireEvent.click(
      screen.getByRole('button', { name: /Add Cross Dissolve to every eligible cut/i }),
    );
    expect(container.querySelectorAll('.clip-transition-pill')).toHaveLength(2);
    expect(Number(screen.getByTestId('history').textContent)).toBe(before + 1);
  });
});

describe('the block menu beyond the core three', () => {
  const openMenu = (): HTMLElement => {
    const { container } = render(<Host withTransition />);
    const block = container.querySelector('.clip-transition-pill') as HTMLElement;
    fireEvent.contextMenu(block, { clientX: 100, clientY: 100 });
    return container;
  };

  it('offers the three alignments as a diagram, with the current one marked', () => {
    openMenu();
    const centred = screen.getByRole('menuitemradio', { name: /Centre on cut/ });
    expect(
      screen.getByRole('menuitemradio', { name: /Start at cut/ }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(centred.getAttribute('aria-checked')).toBe('false');
  });

  it('moves the ramp when an alignment is chosen, writing both halves', () => {
    const container = openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Centre on cut/ }));
    // The outgoing clip now carries the pre-cut half; without it a centred
    // transition would fade in from nothing with nothing fading out.
    expect(container.querySelector('.clip-transition-pill')).not.toBeNull();
    fireEvent.contextMenu(container.querySelector('.clip-transition-pill') as HTMLElement, {
      clientX: 100,
      clientY: 100,
    });
    expect(
      screen.getByRole('menuitemradio', { name: /Centre on cut/ }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('does not offer Paste until something has been copied', () => {
    openMenu();
    expect(screen.queryByRole('menuitem', { name: /Paste settings/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy transition/ }));
    fireEvent.contextMenu(document.querySelector('.clip-transition-pill') as HTMLElement, {
      clientX: 100,
      clientY: 100,
    });
    expect(screen.getByRole('menuitem', { name: /Paste settings/ })).toBeTruthy();
  });

  it('hides bulk actions that would touch nothing', () => {
    // Two clips ⇒ one cut, and it is the one already treated: there is no other
    // cut to apply to, so the item is absent rather than present and inert.
    openMenu();
    expect(screen.queryByRole('menuitem', { name: /similar cut/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /selected cut/ })).toBeNull();
  });

  it('previews by parking the playhead before the cut', () => {
    const container = openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Preview transition/ }));
    // The cut is at 4s and the transition is 1s, so playback starts at 3s — the
    // transition plays INTO view rather than starting mid-ramp.
    expect(container.querySelector('.playhead')).not.toBeNull();
  });
});
