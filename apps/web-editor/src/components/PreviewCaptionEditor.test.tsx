import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PreviewCaptionEditor } from './PreviewCaptionEditor.js';

describe('PreviewCaptionEditor', () => {
  it('edits caption text in place and commits on blur', () => {
    const onTextCommit = vi.fn();
    render(
      <PreviewCaptionEditor
        clipId="cap_1"
        style={{ xPercent: 50, yPercent: 70 }}
        trackStyle={{ templateId: 'karaoke' }}
        text="original line"
        selected
        onSelect={vi.fn()}
        onStyleCommit={vi.fn()}
        onTextCommit={onTextCommit}
      />,
    );

    fireEvent.doubleClick(screen.getByRole('group', { name: 'caption cap_1' }));
    const input = screen.getByRole('textbox', { name: 'caption text' });
    fireEvent.change(input, { target: { value: 'edited line' } });
    fireEvent.blur(input);
    expect(onTextCommit).toHaveBeenCalledWith('edited line');
  });

  it('uses persisted free placement, width and rotation for the control box', () => {
    render(
      <PreviewCaptionEditor
        clipId="cap_1"
        style={{ xPercent: 34, yPercent: 61, maxWidthPercent: 72, rotation: 12 }}
        trackStyle={undefined}
        text="placed"
        selected
        onSelect={vi.fn()}
        onStyleCommit={vi.fn()}
        onTextCommit={vi.fn()}
      />,
    );
    const box = screen.getByRole('group', { name: 'caption cap_1' });
    expect(box.style.left).toBe('34%');
    expect(box.style.top).toBe('61%');
    expect(box.style.width).toBe('72%');
    expect(box.style.transform).toContain('rotate(12deg)');
  });

  it('keeps an unselected cue directly selectable', () => {
    const onSelect = vi.fn();
    render(
      <PreviewCaptionEditor
        clipId="cap_1"
        style={undefined}
        trackStyle={undefined}
        text="select me"
        selected={false}
        onSelect={onSelect}
        onStyleCommit={vi.fn()}
        onTextCommit={vi.fn()}
      />,
    );
    fireEvent.pointerDown(screen.getByRole('group', { name: 'caption cap_1' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

