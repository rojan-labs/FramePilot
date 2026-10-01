/**
 * The timeline revamp's display-only additions (ADR 0198 §6): a track-options button
 * that opens the EXISTING track menu, a speed badge, a bow-tie glyph on a transition,
 * a shield on the playhead head, and row parity for the alternating lane bands.
 *
 * None of these is a new behaviour, so the tests pin two things: that each addition
 * is there and decorative where it should be, and that the controls it sits beside
 * keep their names and their hit targets.
 *
 * jsdom reports zero-origin rects; at the 40 px/s default zoom 1s ⇒ 40px.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Asset, Clip, Effect, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { TimelineView } from './TimelineView.js';

const clip = (overrides: Partial<Clip> & Pick<Clip, 'id' | 'start' | 'end'>): Clip => ({
  assetId: 'a',
  trackId: 'v',
  sourceStart: 0,
  sourceEnd: overrides.end - overrides.start,
  effects: [],
  keyframes: [],
  ...overrides,
});

const fade = (toId: string, fromId: string, durationSeconds: number): Effect => ({
  id: `${toId}__transition`,
  type: 'transition',
  params: { kind: 'fade', durationSeconds, fromClipId: fromId },
  keyframes: [],
});

/** An audio asset, so a lane holding it is named as an audio lane (A1). */
const voiceover: Asset = { id: 'vo', path: '/media/vo.wav', kind: 'audio', durationSeconds: 10 };

function Host({ timeline }: { readonly timeline: Timeline }): JSX.Element {
  const editor = useEditor(timeline, ['a', voiceover.id]);
  return <TimelineView editor={editor} assets={[voiceover]} fps={30} />;
}

/** One video lane (named V1) and one audio lane (named A1). */
const twoLanes: Timeline = {
  tracks: [
    { id: 'v', type: 'video', clips: [clip({ id: 'c1', start: 0, end: 2 })] },
    {
      id: 'au',
      type: 'audio',
      clips: [clip({ id: 'c2', assetId: voiceover.id, trackId: 'au', start: 0, end: 3 })],
    },
  ],
};

describe('track options button', () => {
  it('is a named, keyboard-reachable menu button on every lane header', () => {
    render(<Host timeline={twoLanes} />);
    const v1 = screen.getByRole('button', { name: 'Track options for V1' });
    const a1 = screen.getByRole('button', { name: 'Track options for A1' });
    for (const button of [v1, a1]) {
      // A native <button> in the tab order: Enter and Space activate it for free.
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.tabIndex).toBe(0);
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.closest('.track-head')).not.toBeNull();
    }
  });

  it('opens the same track menu as right-clicking the header', () => {
    render(<Host timeline={twoLanes} />);
    fireEvent.contextMenu(document.querySelector('.track-head')!, { clientX: 12, clientY: 40 });
    const fromRightClick = within(screen.getByRole('menu', { name: 'track actions' }))
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'track actions' })).toBeNull();

    const button = screen.getByRole('button', { name: 'Track options for V1' });
    fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'track actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(fromRightClick);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    // Only the lane it belongs to reports the open menu.
    expect(
      screen.getByRole('button', { name: 'Track options for A1' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('acts on its own lane', () => {
    const { container } = render(<Host timeline={twoLanes} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track options for A1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete track/ }));
    const lanes = [...container.querySelectorAll('[aria-label^="track "]')].map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(lanes).toEqual(['track v']);
  });

  it('leaves the flag controls beside it untouched', () => {
    render(<Host timeline={twoLanes} />);
    const head = screen
      .getByRole('button', { name: 'Track options for V1' })
      .closest('.track-head') as HTMLElement;
    const names = within(head)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual([
      'Collapse lane V1',
      'Hide track',
      'Mute track',
      'Lock track',
      'Solo track',
      'Track options for V1',
    ]);
  });
});

describe('speed badge', () => {
  const speedTimeline = (speed: number | undefined, end = 2): Timeline => ({
    tracks: [
      {
        id: 'v',
        type: 'video',
        clips: [
          clip({
            id: 'c1',
            start: 0,
            end,
            // Source span = timeline span × |speed|, so the clip is self-consistent.
            sourceEnd: end * Math.abs(speed ?? 1),
            ...(speed === undefined ? {} : { speed }),
          }),
        ],
      },
    ],
  });

  const badgeOf = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('.clip-speed-badge');

  it('shows the rate on a clip that is not at 1×, as decoration', () => {
    const { container } = render(<Host timeline={speedTimeline(2)} />);
    const badge = badgeOf(container);
    expect(badge?.textContent).toBe('2×');
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
    expect(badge?.getAttribute('title')).toBe('Speed 2×');
    expect(badge?.closest('[aria-label="clip c1"]')).not.toBeNull();
    // The clip's accessible name does not change.
    expect(screen.getByRole('button', { name: 'clip c1' })).toBeDefined();
  });

  it('is absent at normal speed', () => {
    expect(badgeOf(render(<Host timeline={speedTimeline(undefined)} />).container)).toBeNull();
  });

  it('hides on a clip too narrow to carry it, like the effect badges', () => {
    // 1s at 40 px/s = 40px, under the 72px badge cutoff.
    expect(badgeOf(render(<Host timeline={speedTimeline(2, 1)} />).container)).toBeNull();
  });
});

describe('transition bow-tie', () => {
  /** Two clips cut at 4s, with a fade of `seconds` on the cut. */
  const cutTimeline = (seconds: number): Timeline => ({
    tracks: [
      {
        id: 'v',
        type: 'video',
        clips: [
          clip({ id: 'a', start: 0, end: 4, sourceEnd: 8 }),
          clip({
            id: 'b',
            start: 4,
            end: 10,
            sourceStart: 2,
            sourceEnd: 8,
            effects: [fade('b', 'a', seconds)],
          }),
        ],
      },
    ],
  });

  it.each([
    // 1s ⇒ 40px: icon density.
    [1, 'icon'],
    // 0.2s ⇒ 8px, widened to the 10px minimum: marker density, where the old arrow
    // did not fit and nothing was drawn.
    [0.2, 'marker'],
  ])('draws a decorative glyph on a %ss block (%s density)', (seconds, density) => {
    const { container } = render(<Host timeline={cutTimeline(seconds)} />);
    const block = container.querySelector('.clip-transition-pill') as HTMLElement;
    expect(block.getAttribute('data-density')).toBe(density);
    const glyph = block.querySelector('svg.clip-transition-bowtie');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    // The block's name and its two resize edges are unchanged.
    expect(block.getAttribute('aria-label')).toBe(`Fade transition, ${seconds.toFixed(2)}s`);
    expect(block.querySelectorAll('.clip-transition-pill-edge')).toHaveLength(2);
  });
});

describe('playhead shield', () => {
  it('draws the shield inside the existing, still-named head button', () => {
    render(<Host timeline={twoLanes} />);
    const head = screen.getByRole('button', { name: 'playhead handle' });
    expect(head.classList.contains('playhead-head')).toBe(true);
    const shield = head.querySelector('svg.playhead-shield');
    expect(shield).not.toBeNull();
    expect(shield?.getAttribute('aria-hidden')).toBe('true');
    // The time bubble stays in the DOM (shown on hover/drag/focus by CSS).
    expect(head.querySelector('.playhead-bubble')).not.toBeNull();
  });
});

describe('lane row parity', () => {
  it('alternates by row index, for the banded lanes', () => {
    const { container } = render(<Host timeline={twoLanes} />);
    const parity = [...container.querySelectorAll('li.track')].map((row) =>
      row.getAttribute('data-row-parity'),
    );
    expect(parity).toEqual(['even', 'odd']);
  });
});
