import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch.js';

describe('Switch', () => {
  it('exposes switch state and toggles through the shared callback', () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        checked={false}
        label="Follow playhead"
        onCheckedChange={onCheckedChange}
      />,
    );

    const control = screen.getByRole('switch', { name: 'Follow playhead' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.getAttribute('data-state')).toBe('off');

    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('does not change while disabled', () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        checked
        disabled
        label="Reduce motion"
        onCheckedChange={onCheckedChange}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Reduce motion' }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
