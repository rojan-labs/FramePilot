/**
 * Tests for the composer (Phase 11 M8): slash palette, quick-action prefill, context
 * chip removal, reference-tile lifecycle, and the paste / picker / drop attach paths.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PinnedEntity } from '../../ai/composerActions.js';
import type { Attachment, ContextItem } from '../../ai/conversation.js';
import { Composer, type ComposerProps } from './Composer.js';
import type { ContextWindowState } from './ContextWindowIndicator.js';

const context: ContextItem[] = [
  { id: 'timeline', kind: 'timeline', label: 'Current Timeline', removable: false },
];
const contextWindow: ContextWindowState = {
  usedTokens: 20,
  contextWindow: 100,
  estimated: false,
  limitAssumed: false,
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
      { id: 'selection', kind: 'selection', label: 'Selected: 2 clips, 12–18s', removable: true },
      { id: 'timeline', kind: 'timeline', label: 'Current Timeline', removable: false },
    ];
    const props = setup({ contextItems });
    expect(screen.getByText('Selected: 2 clips, 12–18s')).toBeTruthy();
    expect(screen.getByText('Current Timeline')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove Selected: 2 clips, 12–18s'));
    expect(props.onRemoveContext).toHaveBeenCalledWith('selection');
  });

  // P8.2 "knows": the strip is an account of what the AI is actually given, so a chip
  // whose removal would change nothing must not offer to remove it. `Current Timeline`
  // is built from the project snapshot every request carries; the button used to be
  // there and did nothing at all.
  it('offers no remove control on an always-on context fact', () => {
    setup({
      contextItems: [
        { id: 'timeline', kind: 'timeline', label: 'Current Timeline', removable: false },
      ],
    });
    expect(screen.getByText('Current Timeline')).toBeTruthy();
    expect(screen.queryByLabelText('Remove Current Timeline')).toBeNull();
  });

  it('renders the playhead chip the parent supplies into the context strip', () => {
    setup({ playheadChip: <span className="ai-context-chip">Playhead 0:12</span> });
    const strip = screen.getByLabelText('Included context');
    expect(strip.textContent).toContain('Playhead 0:12');
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

  it('imports a pasted file through the same path as drop and the paperclip', () => {
    // It used to mint the attachment itself and never import or analyze it, so the chip
    // looked ordinary while the model was never given the file. One handler, or the
    // quiet entry point drifts again.
    const props = setup({ onAttachFiles: vi.fn() });
    const file = new File(['x'], 'pasted.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Message FramePilot'), {
      clipboardData: { files: [file] },
    });
    expect(props.onAttachFiles).toHaveBeenCalledWith([file]);
  });

  it('takes every pasted file, not just the first', () => {
    const props = setup({ onAttachFiles: vi.fn() });
    const first = new File(['a'], 'a.png', { type: 'image/png' });
    const second = new File(['b'], 'b.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Message FramePilot'), {
      clipboardData: { files: [first, second] },
    });
    expect(props.onAttachFiles).toHaveBeenCalledWith([first, second]);
  });

  it('ignores a pasted file this host cannot measure, and does not swallow the paste', () => {
    const props = setup({ onAttachFiles: vi.fn() });
    const doc = new File(['x'], 'brief.pdf', { type: 'application/pdf' });
    fireEvent.paste(screen.getByLabelText('Message FramePilot'), {
      clipboardData: { files: [doc] },
    });
    expect(props.onAttachFiles).not.toHaveBeenCalled();
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

describe('reference tiles show the reference, not just its name (P3.1)', () => {
  const ready = {
    id: 'ref_1',
    kind: 'video' as const,
    name: 'fast-cut-vertical.mp4',
    role: 'pacing' as const,
    status: 'ready' as const,
    path: 'media/p/fast-cut-vertical.mp4',
    profile: {
      id: 'ref_1',
      role: 'pacing' as const,
      kind: 'video' as const,
      fileName: 'fast-cut-vertical.mp4',
      contentHash: 'abcdef0123456789',
      analyzedAt: '2026-08-29T10:00:00Z',
      constraints: ['Pacing: fast — median shot 0.9s'],
      video: { durationS: 20, shotCount: 25, medianShotS: 0.891667 },
    },
  };

  it('shows the measured runtime of a video beside its role', () => {
    setup({ attachments: [ready] });
    expect(screen.getByText('0:20')).toBeTruthy();
    expect(screen.getByText('pacing')).toBeTruthy();
  });

  it('renders an image reference as its own thumbnail', () => {
    setup({
      attachments: [
        {
          id: 'ref_2',
          kind: 'image' as const,
          name: 'logo.png',
          role: 'brand-logo' as const,
          status: 'ready' as const,
          path: 'media/p/logo.png',
        },
      ],
    });
    const img = document.querySelector('.ai-ref-tile-img') as HTMLImageElement | null;
    // Resolved through `mediaSrc` — a bare path would be fetched against the page
    // origin and blocked by the renderer CSP.
    expect(img?.getAttribute('src')).toBe('fp-media://local/media%2Fp%2Flogo.png');
  });

  it('shows no runtime while the analysis has not measured one', () => {
    const { profile: _pending, ...analyzing } = ready;
    setup({ attachments: [{ ...analyzing, status: 'analyzing' as const }] });
    expect(screen.queryByText('0:20')).toBeNull();
    expect(screen.getByText('analyzing…')).toBeTruthy();
  });
});

describe('dropping a reference on the composer (P3.1)', () => {
  function dataTransfer(files: readonly File[]): unknown {
    return { types: ['Files'], files, dropEffect: 'none' };
  }

  it('takes dropped video and image files and ignores everything else', () => {
    const onAttachFiles = vi.fn();
    setup({ onAttachFiles });
    const shell = document.querySelector('.ai-composer-shell') as HTMLElement;
    const video = new File(['v'], 'ref.mp4', { type: 'video/mp4' });
    const image = new File(['i'], 'logo.png', { type: 'image/png' });
    const pdf = new File(['p'], 'brief.pdf', { type: 'application/pdf' });

    fireEvent.dragEnter(shell, { dataTransfer: dataTransfer([video]) });
    expect(screen.getByText('Drop a reference video or image')).toBeTruthy();
    fireEvent.drop(shell, { dataTransfer: dataTransfer([video, image, pdf]) });

    expect(onAttachFiles).toHaveBeenCalledWith([video, image]);
    expect(screen.queryByText('Drop a reference video or image')).toBeNull();
  });

  it('keeps the drop cue up while the pointer crosses a child element', () => {
    setup({ onAttachFiles: vi.fn() });
    const shell = document.querySelector('.ai-composer-shell') as HTMLElement;
    fireEvent.dragEnter(shell, { dataTransfer: dataTransfer([]) });
    fireEvent.dragEnter(screen.getByLabelText('Message FramePilot'), {
      dataTransfer: dataTransfer([]),
    });
    fireEvent.dragLeave(shell);
    // Two enters, one leave: still over the composer.
    expect(screen.getByText('Drop a reference video or image')).toBeTruthy();
    fireEvent.dragLeave(shell);
    expect(screen.queryByText('Drop a reference video or image')).toBeNull();
  });

  it('does not offer a drop target on a host that cannot take files', () => {
    setup();
    const shell = document.querySelector('.ai-composer-shell') as HTMLElement;
    fireEvent.dragEnter(shell, { dataTransfer: dataTransfer([]) });
    expect(screen.queryByText('Drop a reference video or image')).toBeNull();
  });
});
