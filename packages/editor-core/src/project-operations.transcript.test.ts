import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { diffProject } from './patch.js';
import {
  applyProjectOperation,
  inferredTranscriptAssetId,
  invertProjectOperation,
  type SetTranscriptOp,
} from './project-operations.js';

const word = (assetId: string | null | undefined, value: string, start: number) => ({
  word: value,
  start,
  end: start + 0.4,
  ...(assetId === undefined ? {} : { assetId }),
});

const project = (): Project =>
  ({
    fps: 30,
    assets: [],
    folders: [],
    markers: [],
    transcript: [
      word('asset-a', 'old-a', 0),
      word('asset-b', 'old-b', 0),
      word('asset-b', 'old-b-2', 1),
    ],
    timeline: { revision: 1, tracks: [] },
  }) as Project;

describe('asset-scoped transcript replacement', () => {
  it('infers one attributed asset from a host transcription payload', () => {
    expect(inferredTranscriptAssetId([word('asset-b', 'new', 0)])).toBe('asset-b');
    expect(
      inferredTranscriptAssetId([word('asset-a', 'a', 0), word('asset-b', 'b', 1)]),
    ).toBeNull();
    expect(inferredTranscriptAssetId([word(undefined, 'legacy', 0)])).toBeNull();
    // A payload that starts attributed but drifts into unattributed words is not safely
    // scopable either — replacing "asset-b" with it would silently drop the stray words.
    expect(
      inferredTranscriptAssetId([word('asset-b', 'b', 0), word(undefined, 'stray', 1)]),
    ).toBeNull();
    expect(inferredTranscriptAssetId([word('asset-b', 'b', 0), word('', 'blank', 1)])).toBeNull();
  });

  it('retranscribing asset B preserves asset A', () => {
    const before = project();
    const op: SetTranscriptOp = {
      type: 'set_transcript',
      words: [word('asset-b', 'new-b', 3)],
    };

    const after = applyProjectOperation(before, op);

    expect(after.transcript).toEqual([word('asset-a', 'old-a', 0), word('asset-b', 'new-b', 3)]);
  });

  it('explicit asset scope normalizes every incoming word to that asset', () => {
    const after = applyProjectOperation(project(), {
      type: 'set_transcript',
      assetId: 'asset-b',
      words: [word(undefined, 'provider-omitted-attribution', 4)],
    });
    expect(after.transcript).toEqual([
      word('asset-a', 'old-a', 0),
      word('asset-b', 'provider-omitted-attribution', 4),
    ]);
  });

  it('keeps explicit whole-project replacement for legacy/unattributed data', () => {
    const after = applyProjectOperation(project(), {
      type: 'set_transcript',
      assetId: null,
      words: [word(undefined, 'replacement', 2)],
    });
    expect(after.transcript).toEqual([word(undefined, 'replacement', 2)]);
  });

  it('inverts an asset-scoped replacement to the exact previous project transcript', () => {
    const before = project();
    const op: SetTranscriptOp = {
      type: 'set_transcript',
      words: [word('asset-b', 'new-b', 3)],
    };
    const after = applyProjectOperation(before, op);
    const inverses = invertProjectOperation(before, op);
    const restored = inverses.reduce(applyProjectOperation, after);

    expect(inverses).toHaveLength(1);
    expect(inverses[0]).toMatchObject({ type: 'set_transcript', assetId: null });
    expect(restored.transcript).toEqual(before.transcript);
  });
});

describe('canonical project diffs', () => {
  it('reports a marker-only change', () => {
    const before = project();
    const after = { ...before, markers: [{ id: 'chapter-1', time: 2, label: 'Intro' }] } as Project;
    expect(diffProject(before, after).summary).toEqual(
      expect.arrayContaining([expect.stringMatching(/marker chapter-1 added/i)]),
    );
  });

  it('reports a transcript-only change', () => {
    const before = project();
    const after = {
      ...before,
      transcript: [word('asset-a', 'new-a', 0), word('asset-b', 'old-b', 0)],
    } as Project;
    expect(diffProject(before, after).summary).toEqual(
      expect.arrayContaining([expect.stringMatching(/transcript updated/i)]),
    );
    expect(diffProject(before, after).summary).not.toEqual(['no changes']);
  });
});
