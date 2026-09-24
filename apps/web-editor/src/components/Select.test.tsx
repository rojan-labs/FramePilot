/**
 * Tests for the Select primitive (master-prompt §4): it opens a listbox, marks
 * the active option, commits a choice by click and by keyboard, and closes on
 * Escape.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Select, type SelectOption } from './Select.js';

const OPTIONS: readonly SelectOption[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'plan', label: 'Plan' },
  { value: 'edit', label: 'Edit' },
];

function Host(): JSX.Element {
  const [value, setValue] = useState('chat');
  return (
    <>
      <Select label="mode" value={value} onChange={setValue} options={OPTIONS} />
      <output aria-label="current">{value}</output>
    </>
  );
}

describe('Select', () => {
  it('opens, marks the selected option, and commits on click', () => {
    render(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'mode' });
    expect(trigger.textContent).toContain('Chat');
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Chat/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: /Edit/ }));
    expect(screen.getByLabelText('current').textContent).toBe('edit');
    expect(screen.queryByRole('listbox')).toBeNull(); // closes after commit
  });

  it('navigates and commits with the keyboard, and closes on Escape', () => {
    render(<Host />);
    const trigger = screen.getByRole('combobox', { name: 'mode' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // open
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // → Plan
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByLabelText('current').textContent).toBe('plan');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // open again
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('draws each option label in its own style, and the chosen one on the trigger', () => {
    const fonts: readonly SelectOption[] = [
      { value: 'Anton', label: 'Anton', labelStyle: { fontFamily: 'Anton' } },
      { value: 'Lora', label: 'Lora', labelStyle: { fontFamily: 'Lora' } },
    ];
    render(<Select label="font" value="Lora" onChange={() => {}} options={fonts} />);
    const trigger = screen.getByRole('combobox', { name: 'font' });
    expect(trigger.querySelector<HTMLElement>('.select-value-label')?.style.fontFamily).toBe(
      'Lora',
    );
    fireEvent.click(trigger);
    const anton = screen.getByRole('option', { name: /Anton/ });
    expect(anton.querySelector<HTMLElement>('.select-option-label')?.style.fontFamily).toBe(
      'Anton',
    );
  });

  it('scrolls the highlighted option into view as the keyboard moves it', () => {
    // jsdom has no layout, so no scrollIntoView: install a recorder for the test.
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
      scrolled.push(this.textContent ?? '');
    });
    try {
      render(<Host />);
      const trigger = screen.getByRole('combobox', { name: 'mode' });
      fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // open on Chat
      fireEvent.keyDown(trigger, { key: 'End' }); // → Edit
      expect(scrolled.at(-1)).toContain('Edit');
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
