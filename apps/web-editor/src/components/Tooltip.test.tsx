/**
 * Tests for the Tooltip primitive (master-prompt §2/§4): it reveals on hover
 * after the delay, shows the shortcut keycap, wires aria-describedby, and works
 * for disabled controls (anchor owns the listeners).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from './Tooltip.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Tooltip', () => {
  it('reveals after the delay and shows the shortcut keycap', () => {
    render(
      <Tooltip label="Split at playhead" shortcut="S" delay={250}>
        <button type="button" aria-label="Split">
          ✂
        </button>
      </Tooltip>,
    );
    const anchor = screen.getByRole('button', { name: 'Split' }).parentElement!;
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(anchor);
    expect(screen.queryByRole('tooltip')).toBeNull(); // not yet — within delay
    act(() => vi.advanceTimersByTime(250));
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Split at playhead');
    expect(tip.textContent).toContain('S');
    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-describedby')).toBe(
      tip.id,
    );
    fireEvent.mouseLeave(anchor);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('still reveals for a disabled control', () => {
    render(
      <Tooltip label="Undo" delay={0}>
        <button type="button" aria-label="Undo" disabled>
          ↶
        </button>
      </Tooltip>,
    );
    const anchor = screen.getByRole('button', { name: 'Undo' }).parentElement!;
    fireEvent.mouseEnter(anchor);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole('tooltip').textContent).toContain('Undo');
  });
});
