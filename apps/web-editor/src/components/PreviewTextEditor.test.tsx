import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PreviewTextEditor } from './PreviewTextEditor.js';
import { DEFAULT_TEXT_PARAMS } from '../editor/patch-builders.js';

const params = { ...DEFAULT_TEXT_PARAMS, text: 'Hello' };

describe('PreviewTextEditor', () => {
  it('renders the text content and the two width handles', () => {
    render(<PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={() => {}} />);
    expect(screen.getByLabelText('text overlay content').textContent).toBe('Hello');
    expect(screen.getByLabelText('resize text width left')).toBeDefined();
    expect(screen.getByLabelText('resize text width right')).toBeDefined();
  });

  it('double-click enters edit mode and blur commits changed text', () => {
    const onCommit = vi.fn();
    render(<PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={onCommit} />);
    const box = screen.getByLabelText('edit text overlay');
    fireEvent.doubleClick(box);
    const content = screen.getByLabelText('text overlay content');
    expect(content.getAttribute('contenteditable')).toBe('true');
    // Simulate the user typing a new value, then blurring to commit.
    content.textContent = 'Changed';
    fireEvent.blur(content);
    expect(onCommit).toHaveBeenCalledWith({ text: 'Changed' });
  });

  it('does not commit when the text is unchanged on blur', () => {
    const onCommit = vi.fn();
    render(<PreviewTextEditor params={params} timeInClip={1} duration={5} onCommit={onCommit} />);
    fireEvent.doubleClick(screen.getByLabelText('edit text overlay'));
    fireEvent.blur(screen.getByLabelText('text overlay content'));
    expect(onCommit).not.toHaveBeenCalled();
  });
});
