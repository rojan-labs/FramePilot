import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MaskReviewCard, maskReviewLine, maskReviewSummary } from './MaskReviewCard.js';

const result = (over: Record<string, unknown> = {}) => ({
  kind: 'mask_review',
  tool: 'remove_background',
  clipId: 'shot',
  maskId: 'shot__mask',
  needsReview: [],
  flaggedCount: 0,
  validator: { valid: true, issues: [] },
  ...over,
});

describe('maskReviewSummary', () => {
  it('reads a masking result, and nothing else', () => {
    expect(maskReviewSummary(result({ flaggedCount: 3 }))).toEqual({
      clipId: 'shot',
      maskId: 'shot__mask',
      flaggedCount: 3,
    });
    expect(
      maskReviewSummary(result({ spotCheck: { verdict: 'unsure', reason: 'x', frames: [1] } }))
        ?.spotCheck,
    ).toBe('unsure');
    expect(maskReviewSummary({ kind: 'mask_targets' })).toBeNull();
    expect(maskReviewSummary(result({ flaggedCount: 'many' }))).toBeNull();
    expect(maskReviewSummary(null)).toBeNull();
  });
});

describe('the words on the card', () => {
  it('always states the count and never says verified, whatever the result', () => {
    for (const flaggedCount of [0, 1, 12]) {
      for (const spotCheck of [undefined, 'yes', 'unsure', 'not_run'] as const) {
        const line = maskReviewLine({
          clipId: 'c',
          maskId: 'm',
          flaggedCount,
          ...(spotCheck ? { spotCheck } : {}),
        });
        expect(line).not.toMatch(/verified/i);
        expect(line).toMatch(
          flaggedCount === 0 ? /flagged nothing/ : new RegExp(`^${String(flaggedCount)} moment`),
        );
      }
    }
    expect(maskReviewLine({ clipId: 'c', maskId: 'm', flaggedCount: 1 })).toBe(
      '1 moment needs a look on this mask.',
    );
  });

  it('says so when a look could not tell, and keeps quiet about a look that agreed', () => {
    expect(
      maskReviewLine({ clipId: 'c', maskId: 'm', flaggedCount: 2, spotCheck: 'unsure' }),
    ).toContain('could not tell');
    // A model agreeing is a second opinion: it must not read as reassurance on the card.
    expect(maskReviewLine({ clipId: 'c', maskId: 'm', flaggedCount: 0, spotCheck: 'yes' })).toBe(
      maskReviewLine({ clipId: 'c', maskId: 'm', flaggedCount: 0 }),
    );
  });
});

describe('MaskReviewCard', () => {
  it('opens the Inspector review list for the clip the mask is on', () => {
    const requestReview = vi.fn();
    render(
      <MaskReviewCard
        summary={maskReviewSummary(result({ flaggedCount: 4 }))!}
        store={{ requestReview }}
      />,
    );
    expect(screen.getByRole('group', { name: 'mask review' }).textContent).toContain(
      '4 moments need a look',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open review list' }));
    expect(requestReview).toHaveBeenCalledWith('shot');
  });

  it('still leads to the Inspector when nothing was flagged', () => {
    const requestReview = vi.fn();
    render(<MaskReviewCard summary={maskReviewSummary(result())!} store={{ requestReview }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Inspector' }));
    expect(requestReview).toHaveBeenCalledWith('shot');
  });
});
