import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SELF_CHECK_NOTICE_REASON, type NoticeNode } from '@framepilot/ai-sdk';
import { SelfCheckGroup } from './SelfCheckGroup.js';
import { groupSelfCheckNotices, type SelfCheckGroupRow } from './selfCheckRows.js';

const notice = (id: string, text: string, level: NoticeNode['level'] = 'info'): NoticeNode => ({
  kind: 'notice',
  id,
  ts: 0,
  turnId: 't1',
  level,
  text,
  reason: SELF_CHECK_NOTICE_REASON,
});

function pass(...notices: NoticeNode[]): SelfCheckGroupRow {
  const [row] = groupSelfCheckNotices(notices);
  if (row?.kind !== 'self_check_group') throw new Error('expected a group row');
  return row;
}

function Harness({ group }: { group: SelfCheckGroupRow }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div role="list">
      <SelfCheckGroup
        group={group}
        expanded={expanded}
        onToggleExpanded={(_id, open) => setExpanded(open)}
        renderNotice={(n) => <p>{n.text}</p>}
      />
    </div>
  );
}

describe('SelfCheckGroup', () => {
  const group = pass(
    notice('v', 'Deterministic self-check: Passed with 2 warning(s).'),
    notice('a', 'Trackers carry motion: 2 of 2 hold no motion', 'warning'),
    notice('b', 'Transcript looks real: looped'),
  );

  it('starts collapsed: the verdict and a count, none of the checks', () => {
    render(<Harness group={group} />);
    const toggle = screen.getByRole('button', { name: /self-check/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Passed with 2 warning(s).');
    expect(toggle.textContent).toContain('2 notes');
    expect(screen.queryByText(/Trackers carry motion/)).toBeNull();
  });

  it('opens and closes the checks from the keyboard-reachable toggle', () => {
    render(<Harness group={group} />);
    const toggle = screen.getByRole('button', { name: /self-check/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'Self-check notes' })).toBeTruthy();
    expect(screen.getByText(/Trackers carry motion/)).toBeTruthy();
    // The verdict is in the header, not repeated as a row underneath.
    expect(screen.getAllByText(/Passed with 2 warning/)).toHaveLength(1);
    fireEvent.click(toggle);
    expect(screen.queryByText(/Trackers carry motion/)).toBeNull();
  });

  it('carries the warning tone while closed when a check failed', () => {
    render(<Harness group={group} />);
    expect(screen.getByRole('listitem').getAttribute('data-tone')).toBe('warning');
  });

  it('a verdict with nothing behind it is not an empty disclosure', () => {
    render(<Harness group={pass(notice('v', 'Deterministic self-check: Passed.'))} />);
    const toggle = screen.getByRole('button', { name: /self-check/i });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
    expect(screen.getByRole('listitem').getAttribute('data-tone')).toBe('idle');
  });
});
