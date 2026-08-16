/**
 * Heap/CPU guard for the project history panel.
 *
 * The panel used to fold the WHOLE undo stack into one complete project per cursor
 * position, in a memo keyed on the live project — so every committed edit rebuilt
 * every intermediate project and held them all resident. Its `open` check runs after
 * the hooks, so a user who never opened history paid it anyway, on every edit of
 * every AI run. That is quadratic work and hundreds of retained project graphs
 * behind a panel showing nothing.
 *
 * The property that makes it safe: the reconstruction is for the hovered row only,
 * so committing an edit must cost the panel nothing at all — whether it is open or
 * closed, and regardless of how deep the stack is.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import type { Project } from '@framepilot/timeline-schema';

const applyCalls = { count: 0 };

vi.mock('@framepilot/editor-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@framepilot/editor-core')>();
  return {
    ...actual,
    applyProjectPatch: (...args: Parameters<typeof actual.applyProjectPatch>) => {
      applyCalls.count += 1;
      return actual.applyProjectPatch(...args);
    },
  };
});

const { useEditor } = await import('../editor/useEditor.js');
const { trimClipPatch } = await import('../editor/patch-builders.js');
const { HistoryPanel } = await import('./HistoryPanel.js');

const clipTimeline: Timeline = {
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
          end: 40,
          sourceStart: 0,
          sourceEnd: 40,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

const baseProject: Project = {
  id: 'p',
  name: 'Test',
  version: 9,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  transcript: [],
  angleGroups: [],
  aiMemory: {},
  history: [],
  timeline: clipTimeline,
  assets: [],
  folders: [],
  markers: [],
};

/** `panel: 'none'` is the baseline — the store's own cost for one edit. */
function Host({ panel }: { panel: 'open' | 'closed' | 'none' }): JSX.Element {
  const editor = useEditor(clipTimeline, { assetIds: ['a'] });
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          // Each click trims one frame further, so every edit is a fresh valid entry.
          const end = editor.state.timeline.tracks[0]!.clips[0]!.end;
          const patch = trimClipPatch(editor.state.timeline, 'c1', 0, end - 1);
          if (patch) editor.applyPatch(patch);
        }}
      >
        edit
      </button>
      {panel === 'none' ? null : (
        <HistoryPanel
          editor={editor}
          project={baseProject}
          open={panel === 'open'}
          onClose={() => {}}
        />
      )}
    </div>
  );
}

/** Applies `depth` edits, then reports the cost of one more. */
function costOfOneMoreEdit(panel: 'open' | 'closed' | 'none', depth: number): number {
  render(<Host panel={panel} />);
  const button = screen.getAllByRole('button', { name: 'edit' }).at(-1)!;
  for (let index = 0; index < depth; index += 1) fireEvent.click(button);
  applyCalls.count = 0;
  fireEvent.click(button);
  return applyCalls.count;
}

describe('HistoryPanel commit cost', () => {
  it('adds nothing to the cost of committing an edit', () => {
    // Against the no-panel baseline, not against the closed panel: the old memo ran
    // before the `open` check, so a closed panel paid the same fold an open one did
    // and the two would have agreed while both were quadratic.
    const baseline = costOfOneMoreEdit('none', 12);
    expect(costOfOneMoreEdit('closed', 12)).toBe(baseline);
    expect(costOfOneMoreEdit('open', 12)).toBe(baseline);
  });

  it('keeps that cost flat as the stack grows', () => {
    // The old fold was O(entries) per commit, so a deeper stack cost strictly more.
    const shallow = costOfOneMoreEdit('open', 4);
    const deep = costOfOneMoreEdit('open', 20);
    expect(deep).toBe(shallow);
  });
});
