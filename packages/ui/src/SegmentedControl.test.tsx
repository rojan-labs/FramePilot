import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl.js';

describe('SegmentedControl', () => {
  it('marks the selected option and commits another value', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        label="Theme"
        value="system"
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        onValueChange={onValueChange}
      />,
    );

    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(onValueChange).toHaveBeenCalledWith('dark');
  });

  it('keeps disabled options non-interactive', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        label="Mode"
        value="manual"
        options={[
          { value: 'manual', label: 'Manual' },
          { value: 'auto', label: 'Auto', disabled: true },
        ]}
        onValueChange={onValueChange}
      />,
    );

    const auto = screen.getByRole('button', { name: 'Auto' }) as HTMLButtonElement;
    expect(auto.disabled).toBe(true);
    fireEvent.click(auto);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
