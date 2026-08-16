/**
 * Tests for the drag-to-scrub number field (plan 3.4 Part 4): typing and pointer
 * drag both emit clamped values.
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScrubNumber } from './ScrubNumber.js';

/** jsdom has no pointer capture; stub it for the drag handle. */
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, props: PointerEventInit = {}) {
    super(type, props);
    this.pointerId = props.pointerId ?? 0;
  }
}

beforeEach(() => {
  (globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent =
    FakePointerEvent as unknown as typeof MouseEvent;
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function Host(): JSX.Element {
  const [value, setValue] = useState(0);
  return (
    <ScrubNumber
      label="Gain"
      ariaLabel="gain"
      unit="dB"
      value={value}
      min={-24}
      max={24}
      onChange={setValue}
    />
  );
}

describe('ScrubNumber', () => {
  it('clamps typed values to the range', () => {
    render(<Host />);
    const input = screen.getByLabelText('gain') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-6' } });
    expect(input.value).toBe('-6');
    fireEvent.change(input, { target: { value: '999' } });
    expect(input.value).toBe('24'); // clamped to max
  });

  it('scrubs the value by dragging the label horizontally', () => {
    render(<Host />);
    const handle = screen.getByText('Gain');
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 110, pointerId: 1 }); // +10px ⇒ +10 (step 1)
    fireEvent.pointerUp(handle, { clientX: 110, pointerId: 1 });
    expect((screen.getByLabelText('gain') as HTMLInputElement).value).toBe('10');
  });
});
