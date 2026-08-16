import { describe, expect, it } from 'vitest';
import {
  cutSplitsWord,
  evidenceOverlappingRange,
  nearestSafeCutFrame,
  normalizeEditEvidence,
  normalizeEditObservation,
  safeCutWindowsBetweenWords,
} from './edit-evidence.js';

describe('edit evidence normalization', () => {
  it('uses conservative half-open integer-frame ranges', () => {
    expect(
      normalizeEditObservation(
        {
          id: 'word-1',
          kind: 'word',
          assetId: 'asset-1',
          startSeconds: 0.041,
          endSeconds: 0.082,
          text: 'hello',
        },
        30,
      ),
    ).toEqual({
      id: 'word-1',
      kind: 'word',
      assetId: 'asset-1',
      startFrame: 1,
      endFrame: 3,
      startSeconds: 1 / 30,
      endSeconds: 3 / 30,
      text: 'hello',
    });
  });

  it('sorts evidence and rejects duplicate ids', () => {
    const normalized = normalizeEditEvidence(
      [
        {
          id: 'shot-2',
          kind: 'shot',
          assetId: 'asset-1',
          startSeconds: 2,
          endSeconds: 3,
        },
        {
          id: 'shot-1',
          kind: 'shot',
          assetId: 'asset-1',
          startSeconds: 0,
          endSeconds: 2,
        },
      ],
      30,
    );

    expect(normalized.map((item) => item.id)).toEqual(['shot-1', 'shot-2']);
    expect(() =>
      normalizeEditEvidence(
        [
          {
            id: 'same',
            kind: 'silence',
            assetId: 'asset-1',
            startSeconds: 0,
            endSeconds: 1,
          },
          {
            id: 'same',
            kind: 'shot',
            assetId: 'asset-1',
            startSeconds: 1,
            endSeconds: 2,
          },
        ],
        30,
      ),
    ).toThrow('Duplicate evidence id "same".');
  });

  it('finds safe speech gaps and never cuts through a word', () => {
    const words = normalizeEditEvidence(
      [
        {
          id: 'left',
          kind: 'word',
          assetId: 'asset-1',
          startSeconds: 0,
          endSeconds: 0.5,
          text: 'left',
        },
        {
          id: 'right',
          kind: 'word',
          assetId: 'asset-1',
          startSeconds: 1,
          endSeconds: 1.5,
          text: 'right',
        },
      ],
      30,
    );

    expect(safeCutWindowsBetweenWords(words)).toEqual([
      {
        afterWordId: 'left',
        beforeWordId: 'right',
        startFrame: 15,
        endFrame: 30,
        preferredFrame: 22,
        durationFrames: 15,
      },
    ]);
    expect(cutSplitsWord(7, words)).toBe(true);
    expect(cutSplitsWord(15, words)).toBe(false);
  });

  it('snaps a desired cut to the nearest legal evidence boundary', () => {
    const evidence = normalizeEditEvidence(
      [
        {
          id: 'word',
          kind: 'word',
          assetId: 'asset-1',
          startSeconds: 1,
          endSeconds: 2,
        },
        {
          id: 'silence',
          kind: 'silence',
          assetId: 'asset-1',
          startSeconds: 2,
          endSeconds: 2.5,
        },
        {
          id: 'shot',
          kind: 'shot',
          assetId: 'asset-1',
          startSeconds: 2.5,
          endSeconds: 4,
        },
      ],
      30,
    );

    expect(nearestSafeCutFrame(52, evidence)).toBe(60);
    expect(nearestSafeCutFrame(52, evidence, 3)).toBeUndefined();
  });

  it('selects half-open range overlaps without including a touching boundary', () => {
    const evidence = normalizeEditEvidence(
      [
        {
          id: 'first',
          kind: 'visual-event',
          assetId: 'asset-1',
          startSeconds: 0,
          endSeconds: 1,
        },
        {
          id: 'second',
          kind: 'visual-event',
          assetId: 'asset-1',
          startSeconds: 1,
          endSeconds: 2,
        },
      ],
      30,
    );

    expect(evidenceOverlappingRange(evidence, 0, 30).map((item) => item.id)).toEqual(['first']);
  });
});
