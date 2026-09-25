/**
 * The queued-message card: shows the one message waiting behind a live run, and lets the
 * reviewer edit it in place or remove it before it goes out.
 */
import { useState, type JSX } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueuedMessage, type QueuedMessageProps } from './QueuedMessage.js';

function setup(overrides: Partial<QueuedMessageProps> = {}): QueuedMessageProps {
  const props: QueuedMessageProps = {
    text: 'then add captions',
    attachmentCount: 0,
    running: true,
    editing: false,
    onStartEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<QueuedMessage {...props} />);
  return props;
}

/** The card with its `editing` flag owned by a real parent, the way the sidebar does. */
function Harness(props: { onSave: (text: string) => void; text?: string }): JSX.Element {
  const [editing, setEditing] = useState(false);
  return (
    <QueuedMessage
      text={props.text ?? 'then add captions'}
      attachmentCount={0}
      running
      editing={editing}
      onStartEdit={() => setEditing(true)}
      onSaveEdit={(text) => {
        setEditing(false);
        props.onSave(text);
      }}
      onCancelEdit={() => setEditing(false)}
      onRemove={() => {}}
    />
  );
}

describe('QueuedMessage', () => {
  it('shows the queued text and when it will be sent', () => {
    setup();
    expect(screen.getByText('then add captions')).toBeTruthy();
    expect(screen.getByText('Sends when the run finishes')).toBeTruthy();
  });

  it('says how many references travel with it', () => {
    setup({ attachmentCount: 2 });
    expect(screen.getByText('2 references attached')).toBeTruthy();
  });

  it('removes on request', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }));
    expect(props.onRemove).toHaveBeenCalledTimes(1);
  });

  it('edits in place: the field starts from the queued text and Save commits the change', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    const field = screen.getByLabelText('Queued message text') as HTMLTextAreaElement;
    expect(field.value).toBe('then add captions');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: '  then add bold captions  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('then add bold captions');
    expect(screen.queryByLabelText('Queued message text')).toBeNull();
  });

  it('saves on Enter and cancels on Escape', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    let field = screen.getByLabelText('Queued message text');
    fireEvent.change(field, { target: { value: 'discarded edit' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Queued message text')).toBeNull();

    // Reopening starts from what is queued, not from the abandoned edit.
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    field = screen.getByLabelText('Queued message text');
    expect((field as HTMLTextAreaElement).value).toBe('then add captions');
    fireEvent.change(field, { target: { value: 'kept edit' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('kept edit');
  });

  it('keeps Shift+Enter as a newline rather than a save', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    fireEvent.keyDown(screen.getByLabelText('Queued message text'), {
      key: 'Enter',
      shiftKey: true,
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('tells the reviewer it waits for them once the run is over', () => {
    setup({ running: false, editing: true });
    expect(screen.getByText('Sends when you finish editing')).toBeTruthy();
  });
});
