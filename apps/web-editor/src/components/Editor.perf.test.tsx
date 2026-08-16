/**
 * Perf regression guard (plan/PLAN.md Phase 12.1, Slice 1).
 *
 * The playback clock calls `seek` ~60fps and ruler-scrub calls it per
 * pointermove. Before this slice, that churned the `editor` object and, because
 * it was prop-drilled into every panel, re-rendered the whole workspace on every
 * frame. `Editor` now memoises the panels that don't read the live playhead on a
 * key that excludes `playhead`, so a pure seek reuses their elements and React
 * skips those subtrees.
 *
 * This test counts renders of two such panels (MediaBin — always mounted on the
 * default left tab; Toasts — always mounted) across a seek and asserts they do
 * NOT re-render, while the live transport timecode DOES change (proving the seek
 * actually propagated). Mocks live in this dedicated file so the real-panel
 * integration tests in Editor.test.tsx are unaffected.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Editor } from './Editor.js';
import { demoProject } from '../editor/demo.js';

const counters = vi.hoisted(() => ({ media: 0, toasts: 0, toolbar: 0, timeline: 0 }));

// Stub only the component export; keep every other export real so Editor's other
// imports and the render tree are unaffected.
vi.mock('./MediaBin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MediaBin.js')>();
  return {
    ...actual,
    MediaBin: () => {
      counters.media += 1;
      return null;
    },
  };
});
vi.mock('./Toasts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Toasts.js')>();
  return {
    ...actual,
    Toasts: () => {
      counters.toasts += 1;
      return null;
    },
  };
});
vi.mock('./Toolbar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Toolbar.js')>();
  return {
    ...actual,
    Toolbar: () => {
      counters.toolbar += 1;
      return null;
    },
  };
});
vi.mock('./TimelineView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./TimelineView.js')>();
  return {
    ...actual,
    TimelineView: () => {
      counters.timeline += 1;
      return null;
    },
  };
});

describe('Editor perf — seek does not re-render playhead-free panels', () => {
  it('reuses memoised MediaBin/Toasts on a seek while the live timecode updates', () => {
    render(<Editor project={demoProject} />);

    // Mounted at least once (media is the default left tab; Toasts/Toolbar/Timeline
    // are always mounted).
    expect(counters.media).toBeGreaterThan(0);
    expect(counters.toasts).toBeGreaterThan(0);
    expect(counters.toolbar).toBeGreaterThan(0);
    expect(counters.timeline).toBeGreaterThan(0);
    const before = { ...counters };
    const timeBefore = screen.getByLabelText('current time').textContent;

    // ArrowRight nudges the playhead one frame — a pure `seek`, routed through the
    // shortcut registry (independent of any mocked component).
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });

    // Control: the seek reached the live transport, so the timecode changed.
    expect(screen.getByLabelText('current time').textContent).not.toBe(timeBefore);

    // The guard: none of the memoised, playhead-free components re-rendered.
    expect(counters.media).toBe(before.media);
    expect(counters.toasts).toBe(before.toasts);
    expect(counters.toolbar).toBe(before.toolbar);
    expect(counters.timeline).toBe(before.timeline);
  });
});
