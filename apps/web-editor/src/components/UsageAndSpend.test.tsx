/**
 * Tests for Settings → Usage & Spend.
 *
 * These lean on the states rather than the arithmetic — the maths is covered in
 * `usage-ledger.test.ts`. What is asserted here is that the screen tells the truth about
 * money: that a subscription's list-price equivalent is never added into the spend
 * headline, that a missing usage reading is named rather than counted as zero, and that
 * empty-because-new reads differently from empty-because-filtered.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageAndSpend } from './UsageAndSpend.js';
import { recordUsageRun } from '../editor/usageHistory.js';
import type { UsageRunEntry } from '@framepilot/ai-sdk';

const entry = (over: Partial<UsageRunEntry> = {}): UsageRunEntry => ({
  at: new Date(),
  provider: 'anthropic',
  model: 'claude-opus-5',
  projectId: 'p1',
  projectName: 'Launch video',
  tokens: 1_000,
  usd: 1,
  modelCalls: 2,
  ...over,
});

function renderPanel(over: Partial<Parameters<typeof UsageAndSpend>[0]> = {}) {
  const props = {
    trackHistory: true,
    onTrackHistoryChange: vi.fn(),
    maxRunUsd: 2,
    onOpenAiSettings: vi.fn(),
    ...over,
  };
  return { ...render(<UsageAndSpend {...props} />), props };
}

beforeEach(() => localStorage.clear());

describe('empty states', () => {
  it('names what will appear here on first run, rather than "nothing yet"', () => {
    renderPanel();
    expect(screen.getByText('Nothing recorded yet')).toBeTruthy();
    expect(screen.getByText(/what it used shows up here/i)).toBeTruthy();
  });

  it('says history is off, and does not pretend there is nothing to record', () => {
    renderPanel({ trackHistory: false });
    expect(screen.getByText(/Usage history is off/i)).toBeTruthy();
  });

  it('offers to widen the range when the range is empty but history exists', () => {
    // Empty-by-filter is a different screen from empty-by-default: the fix is to widen the
    // range, not to go and do some work.
    const old = new Date();
    old.setDate(old.getDate() - 45);
    recordUsageRun(entry({ at: old }), true);
    renderPanel();

    expect(screen.getByText(/No AI edits in the last 30 days/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all time' }));
    expect(screen.getByLabelText('Summary')).toBeTruthy();
  });
});

describe('the headline', () => {
  it('leads with a sentence carrying spend, edit count and a per-edit figure', () => {
    recordUsageRun(entry({ usd: 1 }), true);
    recordUsageRun(entry({ usd: 3 }), true);
    renderPanel();

    const summary = within(screen.getByLabelText('Summary'));
    expect(summary.getByText('$4.00')).toBeTruthy();
    expect(summary.getByText('2 edits')).toBeTruthy();
    // The per-edit figure: $4.00 over two edits.
    expect(summary.getByText('$2.00')).toBeTruthy();
  });

  it('keeps subscription usage out of the spend figure and frames it as covered', () => {
    // The cost meter prices a subscription run from the same per-tier table as any other,
    // so it arrives carrying dollars that were never billed. Adding them here would invent
    // a bill.
    recordUsageRun(entry({ provider: 'anthropic', usd: 1 }), true);
    recordUsageRun(entry({ provider: 'anthropic', usd: 3 }), true);
    recordUsageRun(entry({ provider: 'claude-agent-sdk', usd: 9 }), true);
    renderPanel();

    const summary = within(screen.getByLabelText('Summary'));
    // $4 spent, not $13: the plan's $9 is reported separately, below.
    expect(summary.getByText('$4.00')).toBeTruthy();
    expect(summary.getByText(/\$9\.00 of usage was covered by your Claude plan/i)).toBeTruthy();
  });

  it('names runs whose usage was never reported instead of counting them as zero', () => {
    recordUsageRun(entry({ usd: 1 }), true);
    recordUsageRun(entry({ tokens: 0, usd: 0, modelCalls: 3 }), true);
    renderPanel();
    expect(screen.getByText(/1 edit ran on a provider that reported no usage/i)).toBeTruthy();
  });
});

describe('budget calibration', () => {
  it('reassures when a typical edit sits well inside the budget', () => {
    recordUsageRun(entry({ usd: 0.1 }), true);
    renderPanel({ maxRunUsd: 2 });
    expect(screen.getByText(/most finish well inside it/i)).toBeTruthy();
  });

  it('warns when a typical edit is close enough to the budget to be cut short', () => {
    recordUsageRun(entry({ usd: 1.8 }), true);
    renderPanel({ maxRunUsd: 2 });
    expect(screen.getByText(/may be stopping early/i)).toBeTruthy();
  });

  it('routes to the AI section, where the budget actually lives', () => {
    recordUsageRun(entry({ usd: 0.1 }), true);
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust budget' }));
    expect(props.onOpenAiSettings).toHaveBeenCalled();
  });
});

describe('breakdowns', () => {
  it('ranks projects by spend and names the provider that did the work', () => {
    recordUsageRun(entry({ projectId: 'a', projectName: 'Small edit', usd: 0.5 }), true);
    recordUsageRun(entry({ projectId: 'b', projectName: 'Big edit', usd: 5 }), true);
    renderPanel();

    const rows = screen.getAllByTitle(/edit$/);
    expect(rows[0]?.textContent).toBe('Big edit');
    expect(rows[1]?.textContent).toBe('Small edit');
  });

  it('collapses a long list behind one control rather than scrolling forever', () => {
    for (let i = 0; i < 8; i += 1) {
      recordUsageRun(
        entry({ projectId: `p${String(i)}`, projectName: `Project ${String(i)}` }),
        true,
      );
    }
    renderPanel();

    expect(screen.getByRole('button', { name: 'Show all (8)' })).toBeTruthy();
    expect(screen.queryByTitle('Project 7')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all (8)' }));
    expect(screen.getByTitle('Project 7')).toBeTruthy();
  });

  it('keeps the same model served by two providers as separate rows', () => {
    // Merging them would produce a figure that is part real spend, part list price.
    recordUsageRun(entry({ provider: 'anthropic', model: 'claude-opus-5' }), true);
    recordUsageRun(entry({ provider: 'claude-agent-sdk', model: 'claude-opus-5' }), true);
    renderPanel();
    expect(screen.getAllByTitle('claude-opus-5')).toHaveLength(2);
  });
});

describe('clearing history', () => {
  it('confirms with a button that names what it destroys', () => {
    // Undo is not on offer because the data cannot be reconstructed — the one case the
    // undo-over-confirm rule exempts.
    recordUsageRun(entry(), true);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: 'Clear all history' })).toBeTruthy();
  });

  it('backs out without destroying anything', () => {
    recordUsageRun(entry(), true);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Summary')).toBeTruthy();
  });

  it('clears, and the screen returns to its first-run state', () => {
    recordUsageRun(entry(), true);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all history' }));
    expect(screen.getByText('Nothing recorded yet')).toBeTruthy();
  });

  it('offers nothing to clear when there is no history', () => {
    renderPanel();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Clear' }).disabled).toBe(true);
  });
});

describe('live updates', () => {
  it('picks up a run that finishes while the panel is open', () => {
    renderPanel();
    expect(screen.getByText('Nothing recorded yet')).toBeTruthy();
    act(() => recordUsageRun(entry(), true));
    expect(screen.getByLabelText('Summary')).toBeTruthy();
  });
});
