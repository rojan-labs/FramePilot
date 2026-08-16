/**
 * Timeline thumbnail-setting and horizontal-windowing tests (production
 * hardening follow-up). Covers:
 *  - the "Show thumbnails on timeline" preference gating the clip filmstrip
 *    (view state only — never a patch, invariant 5);
 *  - sliver clips still drawing at least one filmstrip frame when thumbnails
 *    are on (no minimum-width cutoff for the picture layer);
 *  - horizontal clip windowing: with a measured viewport, only clips whose
 *    span intersects the quantized render window mount (film-scale timelines).
 * The pure window math is covered in `selectors.test`; here we verify wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { TimelineView } from './TimelineView.js';

/** One normal clip, one sliver (0.2s ⇒ 8px at the 40px/s default zoom), and one
 *  far-downstream clip (250s ⇒ 10 000px) for the windowing assertions. */
const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'near',
          assetId: 'm',
          trackId: 'v',
          start: 0,
          end: 2,
          sourceStart: 0,
          sourceEnd: 2,
          effects: [],
          keyframes: [],
        },
        {
          id: 'sliver',
          assetId: 'm',
          trackId: 'v',
          start: 3,
          end: 3.2,
          sourceStart: 0,
          sourceEnd: 0.2,
          effects: [],
          keyframes: [],
        },
        {
          id: 'far',
          assetId: 'm',
          trackId: 'v',
          start: 250,
          end: 252,
          sourceStart: 0,
          sourceEnd: 2,
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

function renderTimeline(): void {
  function Host(): JSX.Element {
    const editor = useEditor(timeline, ['m']);
    return <TimelineView editor={editor} assets={[]} fps={30} />;
  }
  render(
    <SettingsProvider>
      <Host />
    </SettingsProvider>,
  );
}

describe('TimelineView — timeline thumbnails setting', () => {
  it('draws a filmstrip on every video clip by default, including slivers', () => {
    renderTimeline();
    const near = screen.getByLabelText('clip near');
    const sliver = screen.getByLabelText('clip sliver');
    expect(near.querySelector('.clip-filmstrip')).not.toBeNull();
    // A sliver below the old 24px picture cutoff still shows ≥ one frame.
    expect(sliver.querySelector('.clip-filmstrip')).not.toBeNull();
  });

  it('draws no filmstrip when the preference is off', () => {
    localStorage.setItem('framepilot.settings', JSON.stringify({ showTimelineThumbnails: false }));
    renderTimeline();
    expect(document.querySelector('.clip-filmstrip')).toBeNull();
    // The clips themselves still render — only the picture layer is dropped.
    expect(screen.getByLabelText('clip near')).toBeDefined();
  });
});

describe('TimelineView — horizontal clip windowing', () => {
  it('mounts every clip when the lane viewport is unmeasured (jsdom fallback)', () => {
    renderTimeline();
    expect(screen.queryByLabelText('clip near')).not.toBeNull();
    expect(screen.queryByLabelText('clip far')).not.toBeNull();
  });

  it('windows clips to the visible slice once the viewport is measured, and remounts on scroll', () => {
    // Give the lane scroll viewport a real clientWidth so `laneRenderWindow`
    // activates (jsdom reports 0 → the mount-everything fallback).
    const proto = HTMLElement.prototype;
    const real = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('lane-scroll') ? 500 : 0;
      },
    });
    try {
      renderTimeline();
      const laneScroll = document.querySelector('.lane-scroll') as HTMLElement;
      // Sync the viewport mirror (the mount effect ran before our stub in some
      // orders; a scroll event always re-reads scrollLeft/clientWidth).
      act(() => {
        fireEvent.scroll(laneScroll);
      });
      // Window ≈ [0, 1500px] at 40px/s ⇒ clips past ~37.5s unmount.
      expect(screen.queryByLabelText('clip near')).not.toBeNull();
      expect(screen.queryByLabelText('clip far')).toBeNull();
      // Scroll to the far clip (10 000px): it mounts, the near clip unmounts.
      act(() => {
        laneScroll.scrollLeft = 10_000;
        fireEvent.scroll(laneScroll);
      });
      expect(screen.queryByLabelText('clip far')).not.toBeNull();
      expect(screen.queryByLabelText('clip near')).toBeNull();
    } finally {
      if (real) Object.defineProperty(proto, 'clientWidth', real);
      else delete (proto as unknown as Record<string, unknown>).clientWidth;
    }
  });
});
