/**
 * Committing a finished background-removal run (BR6.4).
 *
 * The claim under test is the one the plan makes: a selection change does not lose the job. The
 * committer is mounted in the editor shell, not in the Inspector row, so a run that finishes while
 * the editor is looking at a different clip still becomes one reversible edit on the right clip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { masksOf, type Asset, type Timeline } from '@framepilot/timeline-schema';
import { useEditor, type UseEditor } from '../../../editor/useEditor.js';
import { MatteJobStore } from './matteJobStore.js';
import { useMatteJobCommits } from './useMatteJob.js';
import { reviewReasonFor } from './matteReviewReasons.js';

const bridge = vi.hoisted(() => ({
  capabilityPackMatte: vi.fn(),
  capabilityPackCancelMatte: vi.fn(),
  onCapabilityPackMatteProgress: vi.fn(() => () => {}),
}));

vi.mock('../../../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

const KEY = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

const assets: readonly Asset[] = [
  {
    id: 'a1',
    path: 'media/a1.mp4',
    kind: 'video',
    media: { width: 1920, height: 1080 },
  } as unknown as Asset,
];

const timeline: Timeline = {
  revision: 1,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a1',
          trackId: 'v1',
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
} as unknown as Timeline;

let editor: UseEditor;

/** The editor shell: the committer, with no Inspector row anywhere. */
function Shell({ jobs }: { readonly jobs: MatteJobStore }): null {
  editor = useEditor(timeline, { assets });
  useMatteJobCommits(editor, jobs);
  return null;
}

const matte = () =>
  masksOf(editor.state.timeline.tracks[0]!.clips[0]!).find((mask) => mask.kind === 'matte');

afterEach(() => {
  vi.clearAllMocks();
});

const RESULT = {
  ok: true,
  artifact: {
    key: KEY,
    files: [{ name: 'matte.mkv', sha256: SHA }],
    width: 1920,
    height: 1080,
    coverage: { sourceStart: 0, sourceEnd: 6 },
    packId: 'smart-mask',
    packVersion: '1.0.0',
    modelDigests: [SHA],
  },
  summary: { verifiedFrames: 118, flaggedFrames: 2, lockedFrames: 0, selfCorrectionRounds: 1 },
  needsReview: [{ start: 1, end: 1.5, reason: 'occlusion' }],
  executionProvider: 'cpu',
  cacheHit: false,
  projectRevision: 2,
};

describe('useMatteJobCommits', () => {
  it('commits a run that finished with no Inspector row on screen', async () => {
    bridge.capabilityPackMatte.mockResolvedValue(RESULT);
    const jobs = new MatteJobStore();
    render(<Shell jobs={jobs} />);

    await act(async () => {
      await jobs.start({
        assetId: 'a1',
        clipId: 'c1',
        sourceStart: 0,
        sourceEnd: 6,
        prompts: [],
        timelineRevision: 1,
        edgeMode: 'sharp',
      });
    });

    await waitFor(() => expect(matte()).toBeDefined());
    const mask = matte()!;
    expect(mask.kind).toBe('matte');
    if (mask.kind !== 'matte') return;
    expect(mask.artifact.key).toBe(KEY);
    expect(mask.edgeMode).toBe('sharp');
    expect(mask.review.flagged).toEqual([{ start: 1, end: 1.5 }]);
    // One reversible edit, not a silent write.
    expect(editor.history.entries.length).toBe(1);
    // The reason the pipeline gave survives the session, in plain words.
    expect(reviewReasonFor(KEY, 1, 1.5)).toBe('Subject partly hidden');
    expect(jobs.getState().notices.c1?.message).toContain('1 moment');
  });

  it('says nothing changed when the job was cancelled', async () => {
    bridge.capabilityPackMatte.mockResolvedValue({
      ok: false,
      code: 'cancelled',
      error: 'Cancelled.',
      retryable: true,
    });
    const jobs = new MatteJobStore();
    render(<Shell jobs={jobs} />);

    await act(async () => {
      await jobs.start({
        assetId: 'a1',
        clipId: 'c1',
        sourceStart: 0,
        sourceEnd: 6,
        prompts: [],
        timelineRevision: 1,
      });
    });

    await waitFor(() => expect(jobs.getState().notices.c1).toBeDefined());
    expect(jobs.getState().notices.c1!.message).toBe('Stopped. Nothing changed.');
    expect(matte()).toBeUndefined();
    expect(editor.history.entries.length).toBe(0);
  });

  it('asks for a click rather than inventing a subject when the pack needs a prompt', async () => {
    bridge.capabilityPackMatte.mockResolvedValue({ ok: false, code: 'needs_prompt' });
    const jobs = new MatteJobStore();
    render(<Shell jobs={jobs} />);

    await act(async () => {
      await jobs.start({
        assetId: 'a1',
        clipId: 'c1',
        sourceStart: 0,
        sourceEnd: 6,
        prompts: [],
        timelineRevision: 1,
      });
    });

    await waitFor(() => expect(jobs.getState().notices.c1).toBeDefined());
    expect(jobs.getState().notices.c1!.message).toContain('Click the subject');
    expect(matte()).toBeUndefined();
  });
});
