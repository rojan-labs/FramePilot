/**
 * SteeringInput tests (P11.4/P12.5): typing + sending queues a message and shows a
 * "queued" note that clears once the run confirms it applied.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SteeringInput } from './SteeringInput.js';

describe('SteeringInput', () => {
  it('is disabled until there is text, and calls onSend with the trimmed message', () => {
    const onSend = vi.fn();
    render(<SteeringInput onSend={onSend} appliedMessages={[]} />);
    const send = screen.getByTestId('ai-steering-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ai-steering-input'), {
      target: { value: '  focus on the outro  ' },
    });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith('focus on the outro');
  });

  it('shows a queued note after sending, naming the message', () => {
    render(<SteeringInput onSend={() => {}} appliedMessages={[]} />);
    fireEvent.change(screen.getByTestId('ai-steering-input'), {
      target: { value: 'slow down the middle' },
    });
    fireEvent.click(screen.getByTestId('ai-steering-send'));
    expect(screen.getByTestId('ai-steering-queued').textContent).toContain('slow down the middle');
    // The input clears so the next message can be typed.
    expect((screen.getByTestId('ai-steering-input') as HTMLInputElement).value).toBe('');
  });

  it('clears the queued note once the run confirms that message applied', () => {
    const { rerender } = render(<SteeringInput onSend={() => {}} appliedMessages={[]} />);
    fireEvent.change(screen.getByTestId('ai-steering-input'), {
      target: { value: 'slow down the middle' },
    });
    fireEvent.click(screen.getByTestId('ai-steering-send'));
    expect(screen.getByTestId('ai-steering-queued')).toBeTruthy();
    rerender(
      <SteeringInput
        onSend={() => {}}
        appliedMessages={['Steering applied: "slow down the middle"']}
      />,
    );
    expect(screen.queryByTestId('ai-steering-queued')).toBeNull();
  });

  it('Enter sends, Shift+Enter is not handled specially (single-line input)', () => {
    const onSend = vi.fn();
    render(<SteeringInput onSend={onSend} appliedMessages={[]} />);
    fireEvent.change(screen.getByTestId('ai-steering-input'), { target: { value: 'nudge' } });
    fireEvent.keyDown(screen.getByTestId('ai-steering-input'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('nudge');
  });
});
