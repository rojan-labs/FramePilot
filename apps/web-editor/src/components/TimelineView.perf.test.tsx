/**
 * Perf regression guard for the timeline lane render on a CAPTION-HEAVY project.
 *
 * The bug this exists to prevent: deciding whether a cut can carry a transition derives
 * the whole timeline's cut structure (a `buildTimelineMap` walk plus a full
 * `listEditBoundaries` pass, each allocating a span per clip). The lane render used to
 * ask that question **per junction, per re-render** — and `add_caption_layer` produces one
 * butt-joined clip per spoken cue, so a few minutes of speech is 150+ junctions on one
 * lane. Every horizontal scroll, zoom, selection change and drag frame therefore cost
 * hundreds of full-timeline walks, to draw affordances on cuts that a caption lane can
 * never take a transition at anyway.
 *
 * Three shape invariants (never wall-clock — a timing assertion in jsdom is a flake
 * generator), one per part of the fix:
 *
 *  1. A caption lane is never asked at all.
 *  2. A re-render that does not change the timeline re-derives nothing.
 *  3. The cut structure is derived once for the whole timeline, not once per junction.
 *
 * And one behaviour guard, because an optimisation that deletes the feature is not one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import type { Clip, Timeline, Track } from '@framepilot/timeline-schema';
import { SettingsProvider } from '../editor/useSettings.js';
import { useEditor } from '../editor/useEditor.js';

const counters = vi.hoisted(() => ({ indexBuilds: 0, eligibilityChecks: 0 }));

vi.mock('@framepilot/editor-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@framepilot/editor-core')>();
  return {
    ...actual,
    buildTransitionBoundaryIndex: (
      ...args: Parameters<typeof actual.buildTransitionBoundaryIndex>
    ) => {
      counters.indexBuilds += 1;
      return actual.buildTransitionBoundaryIndex(...args);
    },
    transitionEligibilityIn: (...args: Parameters<typeof actual.transitionEligibilityIn>) => {
      counters.eligibilityChecks += 1;
      return actual.transitionEligibilityIn(...args);
    },
  };
});

const { TimelineView } = await import('./TimelineView.js');

const CUE_SECONDS = 0.4;

/** Butt-joined cues on one caption lane — the shape `add_caption_layer` produces. */
function captionCues(count: number): Clip[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cue${i}`,
    assetId: 'm',
    trackId: 'c',
    start: i * CUE_SECONDS,
    end: (i + 1) * CUE_SECONDS,
    sourceStart: 0,
    sourceEnd: CUE_SECONDS,
    effects: [],
    keyframes: [],
  }));
}

/** `n` butt-joined media clips on one video lane — `n - 1` real, transitionable cuts. */
function mediaCuts(n: number): Track {
  return {
    id: 'v',
    type: 'video',
    clips: Array.from({ length: n }, (_, i) => ({
      id: `shot${i}`,
      assetId: 'm',
      trackId: 'v',
      start: i * 4,
      end: (i + 1) * 4,
      sourceStart: 0,
      sourceEnd: 4,
      effects: [],
      keyframes: [],
    })),
  };
}

class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props);
    this.pointerId = props.pointerId ?? 0;
  }
}

beforeEach(() => {
  localStorage.clear();
  counters.indexBuilds = 0;
  counters.eligibilityChecks = 0;
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    FakePointerEvent as unknown as typeof MouseEvent;
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  document.elementFromPoint = vi.fn(() => null);
});

function renderTimeline(timeline: Timeline): void {
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

describe('TimelineView perf — caption-heavy timelines', () => {
  it('never asks whether a caption cue can carry a transition', () => {
    // 200 cues ⇒ 199 abutting cuts. The old lane render ran a full-timeline eligibility
    // derivation at every one of them, all to answer "no, captions cannot take one".
    renderTimeline({ tracks: [{ id: 'c', type: 'caption', clips: captionCues(200) }] });
    expect(counters.eligibilityChecks).toBe(0);
    expect(counters.indexBuilds).toBe(0);
  });

  it('re-derives nothing when a re-render does not change the timeline', () => {
    // A selection change rebuilds the lane subtree — the same class of re-render as a
    // horizontal scroll, a zoom tick, or a drag frame, and the reason the old cost was
    // paid continuously rather than once.
    renderTimeline({
      tracks: [mediaCuts(12), { id: 'c', type: 'caption', clips: captionCues(200) }],
    });
    const afterMount = { ...counters };
    expect(afterMount.eligibilityChecks).toBeGreaterThan(0); // the video lane's real cuts

    fireEvent.click(screen.getByLabelText('clip shot3'));

    expect(counters.eligibilityChecks).toBe(afterMount.eligibilityChecks);
    expect(counters.indexBuilds).toBe(afterMount.indexBuilds);
  });

  it('derives the cut structure once for the timeline, not once per cut', () => {
    renderTimeline({ tracks: [mediaCuts(30)] });
    // 29 cuts, each asked exactly once — but sharing ONE prepared index between them.
    expect(counters.eligibilityChecks).toBe(29);
    expect(counters.indexBuilds).toBe(1);
  });

  it('still offers the affordance at a real cut on a video lane', () => {
    renderTimeline({ tracks: [mediaCuts(2)] });
    expect(document.querySelector('.clip-transition-add')).not.toBeNull();
  });
});
