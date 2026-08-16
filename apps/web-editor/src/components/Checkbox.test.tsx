/**
 * Tests for the custom Checkbox primitive: it toggles via its (keyboard-operable)
 * native input and exposes the visible label as its accessible name.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Checkbox } from './Checkbox.js';

function Host(): JSX.Element {
  const [on, setOn] = useState(false);
  return (
    <>
      <Checkbox checked={on} onChange={setOn}>
        Burn in
      </Checkbox>
      <output aria-label="state">{on ? 'on' : 'off'}</output>
    </>
  );
}

describe('Checkbox', () => {
  it('toggles its value through the native control', () => {
    render(<Host />);
    const box = screen.getByLabelText('Burn in') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(screen.getByLabelText('state').textContent).toBe('on');
  });
});
