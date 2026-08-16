/**
 * Preview-popup tests (product ask #3) for {@link DiffPreviewModal} — the
 * change-by-change review surface opened from a diff card's "Show preview".
 *
 * These exercise the modal in isolation (the heavy {@link AiReviewPlayer} is
 * stubbed so we can assert the exact `startAt` the popup seeks to, without
 * mounting the real HTML-video preview stack):
 *  - per-operation Keep/Remove re-assembles the applied subset (invariant-safe),
 *  - selecting a change seeks the preview to THAT change (never 0:00),
 *  - a kept subset that can't stand alone fails honestly (no half-apply),
 *  - a decided edit is read-only, and Escape closes.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { DiffNode } from '@framepilot/ai-sdk';
import type { EditResult } from '@framepilot/ai-sdk';
import { DiffPreviewModal } from './DiffPreviewModal.js';

// Stub the real before/after player: it needs the full PreviewPlayer/media stack,
// which isn't what THIS modal is responsible for. Recording its props lets us
// assert the popup seeks the preview to the selected change (`startAt`).
const playerProps: Array<Record<string, unknown>> = [];
vi.mock('../AiReviewPlayer.js', () => ({
  AiReviewPlayer: (props: Record<string, unknown>) => {
    playerProps.push(props);
    return <div data-testid="review-player" data-start-at={String(props['startAt'])} />;
  },
}));

/** A project whose timeline holds the clip/track the fixtures edit, so the
 *  re-assembled subset patches validate cleanly (or fail honestly on purpose). */
const project: Project = parseProject({
  id: 'p',
  name: 'D',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [{ id: 'a', path: '/m.mp4', kind: 'video' }],
  timeline: {
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          {
            id: 'c1',
            assetId: 'a',
            trackId: 'video_1',
            start: 0,
            end: 10,
            sourceStart: 0,
            sourceEnd: 10,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  },
  transcript: [],
  aiMemory: {},
  history: [],
});

/** A two-op edit, both ops independently valid against the project timeline. The
 *  second change starts at 0:08 so seek-to-change is observably non-zero. */
function twoOpNode(): DiffNode {
  const edit = {
    text: 'Tighten the middle and the outro',
    validation: { valid: true, issues: [] },
    diff: { summary: [] },
    patch: {
      patchId: 'p1',
      reason: 'Tighten the middle and the outro',
      operations: [
        { type: 'delete_range', trackId: 'video_1', start: 4, end: 6 },
        { type: 'delete_range', trackId: 'video_1', start: 8, end: 9 },
      ],
    },
  } as unknown as EditResult;
  return { kind: 'diff', id: 'd1', ts: 0, turnId: 't', edit };
}

function renderModal(
  node: DiffNode,
  overrides: {
    variant?: 'review' | 'compare';
    initialSelected?: number;
  } = {},
) {
  const handlers = {
    onClose: vi.fn(),
    onReveal: vi.fn(),
    onSeek: vi.fn(),
  };
  render(<DiffPreviewModal node={node} project={project} fps={30} {...handlers} {...overrides} />);
  return handlers;
}

describe('DiffPreviewModal', () => {
  afterEach(() => {
    playerProps.length = 0;
    vi.clearAllMocks();
  });

  it('lists every operation as a plain-language change with its timecode', () => {
    renderModal(twoOpNode());
    const list = screen.getByRole('list', { name: 'Changes in this edit' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Human labels from describeOperation, not raw op types/ids.
    expect(within(list).getAllByText('Deleted range')).toHaveLength(2);
    // Timecodes anchor each change on the timeline (m:ss), from the op's start.
    expect(within(list).getByText('0:04')).toBeTruthy();
    expect(within(list).getByText('0:08')).toBeTruthy();
  });

  it('seeks the preview to the selected change, never 0:00 (product ask #3)', () => {
    renderModal(twoOpNode());
    // Selecting the second change re-points the preview at its start (0:08 → 8s).
    fireEvent.click(screen.getByRole('button', { name: /Deleted range 0:08/ }));
    const player = screen.getByTestId('review-player');
    expect(player.getAttribute('data-start-at')).toBe('8');
  });

  it('Jump to timeline reveals + seeks the editor to the selected change', () => {
    const props = renderModal(twoOpNode());
    fireEvent.click(screen.getByRole('button', { name: /Deleted range 0:08/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to timeline' }));
    expect(props.onReveal).toHaveBeenCalledWith(expect.objectContaining({ id: 'video_1' }));
    expect(props.onSeek).toHaveBeenCalledWith(8);
    expect(props.onClose).toHaveBeenCalled();
  });

  // The modal is read-only. The keep/remove-a-subset surface and its apply/reject footer
  // belonged to a review step that no longer exists: edits apply as they land, so by the
  // time this can be opened there is nothing to decide. See plan/INSTANT-APPLY.md.
  it('offers no way to keep, remove, apply or reject — it inspects an applied edit', () => {
    renderModal(twoOpNode());
    const rows = screen.getByRole('list', { name: 'Changes in this edit' });
    expect(within(rows).queryAllByRole('button', { name: 'Remove this change' })).toHaveLength(0);
    expect(within(rows).queryAllByRole('button', { name: 'Keep this change' })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();
  });

  it('states that the changes are already on the timeline, and how to take them back', () => {
    renderModal(twoOpNode());
    expect(screen.getByText(/These changes are on your timeline/)).toBeTruthy();
    expect(screen.getByText(/use Undo to revert/i)).toBeTruthy();
  });

  it('previews the whole edit, never a partial subset', () => {
    renderModal(twoOpNode());
    // Every change stays in the preview: there is no longer any way to drop one, so the
    // before/after must always be the edit that actually landed.
    const list = screen.getByRole('list', { name: 'Changes in this edit' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('review-player')).toBeTruthy();
  });

  it('compare variant is read-only before/after, seeked to the chosen change (#11)', () => {
    renderModal(twoOpNode(), { variant: 'compare', initialSelected: 1 });
    // Read-only: no keep/remove, no apply/reject/reject-all.
    expect(screen.queryByRole('button', { name: 'Remove this change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep this change' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();
    // Titled as a comparison, and opened seeked to the initially-selected change (0:08).
    expect(screen.getByText('Before / after')).toBeTruthy();
    expect(screen.getByTestId('review-player').getAttribute('data-start-at')).toBe('8');
    // Jump to timeline stays available (read-only navigation).
    expect(screen.getByRole('button', { name: 'Jump to timeline' })).toBeTruthy();
  });

  it('closes on Escape and on the backdrop', () => {
    const props = renderModal(twoOpNode());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // Clicking the dialog surface itself must NOT close (stopPropagation).
    fireEvent.click(screen.getByRole('dialog'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
