/**
 * Tests for the composer (Phase 11 M8): slash palette, quick-action prefill, context
 * chip removal, attachment chip lifecycle, and the paste handler.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PinnedEntity } from '../../ai/composerActions.js';
import type { Attachment, ContextItem } from '../../ai/conversation.js';
import { Composer, type ComposerProps } from './Composer.js';
import type { ContextWindowState } from './ContextWindowIndicator.js';

const context: ContextItem[] = [{ id: 'timeline', kind: 'timeline', label: 'Current Timeline' }];
const contextWindow: ContextWindowState = {
  usedTokens: 20,
  contextWindow: 100,
  estimated: false,
};

const atEntities: PinnedEntity[] = [
  { kind: 'clip', id: 'c1', label: 'intro.mp4 0–5s' },
  { kind: 'asset', id: 'a2', label: 'broll.mp4' },
];

function setup(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    running: false,
    contextWindow,
    contextPhase: 'idle',
    contextItems: context,
    onRemoveContext: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    atEntities,
    onPinEntity: vi.fn(),
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

describe('Composer', () => {
  it('surfaces live run activity beside the message box instead of requiring header state', () => {
    setup({ running: true, runStatus: 'generating' });
    expect(screen.getByRole('status').textContent).toContain('Generating');
    // The indicator is the FramePilot mark itself, animated — ONE moving thing. The old
    // row stacked a pulsing orb, a static label and a bouncing ellipsis that merely
    // repeated the "…" already in the label.
    expect(document.querySelector('.ai-activity-mark img')?.getAttribute('src')).toBe('/logo.png');
    expect(document.querySelector('.ai-activity-dots')).toBeNull();
    expect(document.querySelector('.ai-activity-orb')).toBeNull();
  });
  it('shows the current context window immediately left of Send', () => {
    setup();
    const indicator = screen.getByRole('button', { name: /Context: 20 of 100 tokens/ });
    const send = screen.getByLabelText('Send');
    expect(indicator.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('shows the slash palette for a slash query and inserts the command', () => {
    const props = setup({ value: '/cap' });
    const option = screen.getByRole('option', { name: /add-captions/ });
    fireEvent.click(option);
    expect(props.onChange).toHaveBeenCalledWith('/add-captions ');
  });

  it('toggles quick actions and prefills a prompt', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('Quick actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Trim Silence' }));
    expect(props.onChange).toHaveBeenCalledWith(expect.stringContaining('silent gaps'));
  });

  it('lists context chips and removes them', () => {
    const contextItems: ContextItem[] = [
      { id: 'selection', kind: 'selection', label: 'Selected: 2 clips, 12–18s' },
      { id: 'timeline', kind: 'timeline', label: 'Current Timeline' },
    ];
    const props = setup({ contextItems });
    expect(screen.getByText('Selected: 2 clips, 12–18s')).toBeTruthy();
    expect(screen.getByText('Current Timeline')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove Selected: 2 clips, 12–18s'));
    expect(props.onRemoveContext).toHaveBeenCalledWith('selection');
  });

  it('renders no context row when there are no context items', () => {
    setup({ contextItems: [] });
    expect(screen.queryByLabelText('Included context')).toBeNull();
  });

  it('lists attachment chips and removes them', () => {
    const attachments: Attachment[] = [{ id: 'a1', kind: 'image', name: 'shot.png' }];
    const props = setup({ attachments });
    expect(screen.getByText('shot.png')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove shot.png'));
    expect(props.onRemoveAttachment).toHaveBeenCalledWith('a1');
  });

  it('adds an attachment from a pasted file', () => {
    const props = setup();
    const file = new File(['x'], 'pasted.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Message FramePilot'), {
      clipboardData: { files: [file] },
    });
    expect(props.onAddAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'pasted.png' }),
    );
  });

  it('submits on Enter only when not typing a slash command', () => {
    const submit = vi.fn();
    setup({ value: 'tighten it', onSubmit: submit });
    fireEvent.keyDown(screen.getByLabelText('Message FramePilot'), { key: 'Enter' });
    expect(submit).toHaveBeenCalled();
  });

  it('shows the "@" pin picker for an active query and pins the picked entity (P8.7)', () => {
    const props = setup({ value: 'tighten @bro' });
    const option = screen.getByRole('option', { name: /broll\.mp4/ });
    fireEvent.click(option);
    expect(props.onPinEntity).toHaveBeenCalledWith(atEntities[1]);
    expect(props.onChange).toHaveBeenCalledWith('tighten');
  });

  it('lists every entity for a bare "@" and none outside an "@" query', () => {
    setup({ value: '@' });
    expect(screen.getByRole('option', { name: /intro\.mp4/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /broll\.mp4/ })).toBeTruthy();
  });

  it('does not submit on Enter while typing an "@" query', () => {
    const submit = vi.fn();
    setup({ value: '@bro', onSubmit: submit });
    fireEvent.keyDown(screen.getByLabelText('Message FramePilot'), { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('renders no pin picker when the value has no active "@" query', () => {
    setup({ value: 'tighten it' });
    expect(screen.queryByLabelText('Pin context')).toBeNull();
  });
});
