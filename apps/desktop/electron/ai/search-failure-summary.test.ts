/**
 * The agent's search failures must always say something (see the module doc for the run
 * that proved it).
 */
import { describe, expect, it } from 'vitest';
import { musicErrorMessage, stockErrorMessage } from '@framepilot/ai-sdk';
import { agentSearchFailureSummary } from './search-failure-summary.js';

describe('agentSearchFailureSummary', () => {
  it('passes a real provider sentence straight through', () => {
    // The provider's own words are the point: the model must be able to tell a rate limit
    // from an outage, because retrying is right for one and wrong for the other.
    const message = stockErrorMessage('rate_limited');
    expect(agentSearchFailureSummary('search_stock', message, 'rate_limited')).toBe(message);
  });

  it('regression: a cancelled stock search never reaches the model as silence', () => {
    // `stockErrorMessage('cancelled')` is `''` on purpose — the panels render a user's own
    // Stop as silence. A model handed that sees a red cross with no reason and re-asks.
    expect(stockErrorMessage('cancelled')).toBe('');
    const summary = agentSearchFailureSummary('search_stock', '', 'cancelled');
    expect(summary).not.toBe('');
    expect(summary).toContain('search_stock');
    expect(summary).toContain('cancelled');
  });

  it('regression: a cancelled music search never reaches the model as silence', () => {
    expect(musicErrorMessage('cancelled')).toBe('');
    expect(agentSearchFailureSummary('search_music', '', 'cancelled')).toContain('search_music');
  });

  it('names the code, so the run log carries the cause even with no sentence for it', () => {
    // Future-proofing against the whole class, not only today's `cancelled`.
    expect(agentSearchFailureSummary('search_stock', '', 'some_new_code')).toContain(
      'some_new_code',
    );
  });
});
