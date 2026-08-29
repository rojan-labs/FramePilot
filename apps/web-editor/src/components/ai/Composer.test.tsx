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
  render(
    <div className="ai-sidebar" data-testid="ai-sidebar">
      <header className="ai-sidebar-header">
        <div className="ai-sidebar-header-right" data-testid="header-actions" />
      </header>
      <Composer {...props} />
    </div>,
  );
  return props;
}

describe('Composer', () => {
  it('surfaces BeautifulUI-style live run activity beside the message box', () => {
    setup({ running: true, runStatus: 'generating' });
    expect(screen.getByRole('status').textContent).toContain('Generating');

    const loader = document.querySelector('.ai-pixel-loader');
    expect(loader).toBeTruthy();
    expect(loader?.querySelectorAll('.ai-loader-pixel')).toHaveLength(9);
    expect(document.querySelector('.ai-activity-elapsed')?.getAttribute('aria-hidden')).toBe(
      'true',
    );

    expect(document.querySelector('.ai-activity-mark')).toBeNull();
    expect(document.querySelector('.ai-activity-dots')).toBeNull();
    expect(document.querySelector('.ai-activity-orb')).toBeNull();
  });

  it('ports context usage to the AI header as a circular progress control', () => {
    setup();
    const indicator = screen.getByRole('button', { name: /Context: 20 of 100 tokens.*20% used/ });
    const header = screen.getByTestId('header-actions');
    const composer = screen.getByLabelText('Message FramePilot').closest('.ai-composer');

    expect(header.contains(indicator)).toBe(true);
    expect(indicator.querySelector('.ai-context-ring')).toBeTruthy();
    expect(composer?.contains(indicator)).toBe(false);
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

describe('Composer reference attachments (plan/system-mission P3.1)', () => {
  it('offers a file picker only when the host can take files, and hands the files over', () => {
    const onAttachFiles = vi.fn();
    setup({ onAttachFiles });
    const button = screen.getByRole('button', { name: 'Attach reference video or image' });
    expect(button).toBeTruthy();
    const input = screen.getByLabelText('Reference files') as HTMLInputElement;
    expect(input.accept).toBe('video/*,image/*');
    const file = new File(['x'], 'ref.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAttachFiles).toHaveBeenCalledWith([file]);
  });

  it('shows the role and the analysis state on a reference chip', () => {
    const attachments: Attachment[] = [
      { id: 'r1', kind: 'video', name: 'ref.mp4', role: 'pacing', status: 'analyzing' },
      { id: 'r2', kind: 'image', name: 'logo.png', role: 'brand-logo', status: 'ready' },
      {
        id: 'r3',
        kind: 'image',
        name: 'bad.png',
        role: 'style',
        status: 'failed',
        error: 'ffmpeg exploded',
      },
    ];
    setup({ attachments, onAttachFiles: vi.fn() });
    expect(screen.getByText('pacing')).toBeTruthy();
    expect(screen.getByText('analyzing…')).toBeTruthy();
    expect(screen.getByText('brand-logo')).toBeTruthy();
    expect(screen.queryByText('ready')).toBeNull();
    expect(screen.getByTitle('ffmpeg exploded').textContent).toBe('failed');
  });

  it('has no picker when the host cannot take files', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Attach reference video or image' })).toBeNull();
  });
});

describe('reference tiles (P3.6)', () => {
  const ready = {
    id: 'ref_1',
    kind: 'video' as const,
    name: 'fast-cut.mp4',
    role: 'pacing' as const,
    status: 'ready' as const,
    path: 'media/p/fast-cut.mp4',
    profile: {
      id: 'ref_1',
      role: 'pacing' as const,
      kind: 'video' as const,
      fileName: 'fast-cut.mp4',
      contentHash: 'abcdef0123456789',
      analyzedAt: '2026-08-29T10:00:00Z',
      constraints: ['Pacing: fast — median shot 1.1s', 'Cuts on the beat'],
    },
  };

  it('shows what the AI read from the reference, not just that it was attached', () => {
    setup({ attachments: [ready] });
    // Closed by default: the chip is a chip until someone asks.
    expect(screen.queryByText('Pacing: fast — median shot 1.1s')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /What FramePilot learned from/ }));
    expect(screen.getByText('Pacing: fast — median shot 1.1s')).toBeTruthy();
    expect(screen.getByText('Cuts on the beat')).toBeTruthy();
  });

  it('lets the editor correct the guessed role and re-measure', () => {
    const onChangeAttachmentRole = vi.fn();
    const onReanalyzeAttachment = vi.fn();
    setup({ attachments: [ready], onChangeAttachmentRole, onReanalyzeAttachment });
    fireEvent.click(screen.getByRole('button', { name: /What FramePilot learned from/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Role for fast-cut.mp4' }), {
      target: { value: 'color' },
    });
    expect(onChangeAttachmentRole).toHaveBeenCalledWith('ref_1', 'color');
    fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));
    expect(onReanalyzeAttachment).toHaveBeenCalledWith('ref_1');
  });

  it('states why an analysis failed on the tile, with the retry next to it', () => {
    const onReanalyzeAttachment = vi.fn();
    const { profile: _dropped, ...withoutProfile } = ready;
    setup({
      attachments: [
        { ...withoutProfile, status: 'failed' as const, error: 'Unsupported codec (prores 4444).' },
      ],
      onReanalyzeAttachment,
    });
    fireEvent.click(screen.getByRole('button', { name: /What FramePilot learned from/ }));
    expect(screen.getByText('Unsupported codec (prores 4444).')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-analyze' })).toBeTruthy();
  });

  it('offers no disclosure while the reference is still being analyzed', () => {
    const { profile: _unused, ...pending } = ready;
    setup({ attachments: [{ ...pending, status: 'analyzing' as const }] });
    expect(screen.queryByRole('button', { name: /What FramePilot learned from/ })).toBeNull();
    expect(screen.getByText('analyzing…')).toBeTruthy();
  });
});
