import { describe, expect, it } from 'vitest';
import type { MaskTargetsResult } from './contracts.js';
import { maskReviewSentence, maskTargetsDigest, maskTargetsForRecall } from './review-report.js';

const candidate = (candidateId: string, x: number) => ({
  candidateId,
  label: 'face' as const,
  score: 0.9,
  box: { x, y: 0.2, width: 0.1, height: 0.2 },
  sourceTime: 2,
  persistence: 1,
});

const result = (over: Partial<MaskTargetsResult>): MaskTargetsResult => ({
  kind: 'mask_targets',
  clipId: 'shot',
  description: 'her face',
  status: 'resolved',
  candidates: [candidate('f48_aaaaaaaa', 0.4)],
  chosenCandidateIds: ['f48_aaaaaaaa'],
  reranker: 'none',
  engine: 'framepilot.subject-intelligence@1.0.0',
  ...over,
});

describe('maskTargetsDigest', () => {
  it('puts the chosen id in the FIRST line, the one that survives as the run’s durable fact', () => {
    const [head, row] = maskTargetsDigest(result({}))!.split('\n');
    expect(head).toContain('f48_aaaaaaaa');
    expect(head).toContain('create_mask');
    expect(row).toContain('CHOSEN');
  });

  it('tells the model to wait, for each way of asking, and never shows a coordinate', () => {
    for (const status of ['ambiguous_target', 'needs_click', 'needs_face_selection'] as const) {
      const digest = maskTargetsDigest(
        result({
          status,
          chosenCandidateIds: [],
          candidates: [candidate('pick.f48_aaaaaaaa', 0.4), candidate('pick.f48_bbbbbbbb', 0.7)],
        }),
      )!;
      expect(digest.split('\n')[0]).toMatch(/Wait for their/);
      expect(digest).toContain('the editor must pick this one');
      expect(digest).not.toMatch(/0\.4|0\.7|width|height/);
    }
    expect(
      maskTargetsDigest(
        result({ status: 'no_candidates', candidates: [], chosenCandidateIds: [] }),
      ),
    ).toContain('do not mask something else');
  });

  it('declines a payload that is not a targets result', () => {
    expect(maskTargetsDigest({ status: 'resolved' })).toBeUndefined();
  });
});

describe('maskTargetsForRecall', () => {
  it('keeps every id the run may need later and drops the boxes it must never handle', () => {
    const recalled = maskTargetsForRecall(result({})) as MaskTargetsResult;
    expect(recalled.chosenCandidateIds).toEqual(['f48_aaaaaaaa']);
    expect(recalled.candidates[0]).toEqual({
      candidateId: 'f48_aaaaaaaa',
      label: 'face',
      score: 0.9,
      sourceTime: 2,
      persistence: 1,
    });
    expect(JSON.stringify(recalled)).not.toContain('box');
  });

  it('passes anything else through untouched', () => {
    expect(maskTargetsForRecall('nope')).toBe('nope');
  });
});

describe('maskReviewSentence', () => {
  it('always states the flagged count and never says the mask is verified', () => {
    for (const flaggedCount of [0, 1, 7]) {
      const sentence = maskReviewSentence({ maskId: 'm1', flaggedCount });
      expect(sentence).toMatch(/do not call (it|the mask) verified/);
      expect(sentence).not.toMatch(/\bis verified\b|\bVerified\b/);
    }
    expect(maskReviewSentence({ maskId: 'm1', flaggedCount: 3 })).toContain(
      '3 moments need a look in the Inspector review list',
    );
    expect(maskReviewSentence({ maskId: 'm1', flaggedCount: 1 })).toContain(
      '1 moment needs a look',
    );
    expect(maskReviewSentence({ maskId: 'm1', flaggedCount: 0 })).toContain('flagged nothing');
  });
});
