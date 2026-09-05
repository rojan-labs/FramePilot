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
import type { JSX } from 'react';

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

/**
 * `setup` for a test that needs to re-render with a NEW value — the shape flag is
 * recomputed in a layout effect, so proving it goes back needs a second render of the
 * same tree rather than a second mount.
 */
function renderComposer(overrides: Partial<ComposerProps> = {}): {
  rerender: (next: Partial<ComposerProps>) => void;
} {
  const base: ComposerProps = {
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
  const tree = (props: ComposerProps): JSX.Element => (
    <div className="ai-sidebar">
      <header className="ai-sidebar-header">
        <div className="ai-sidebar-header-right" />
      </header>
      <Composer {...props} />
    </div>
  );
  const view = render(tree(base));
  return {
    rerender: (next) => view.rerender(tree({ ...base, ...next })),
  };
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

  it('offers no quick-actions control — "/" is the one prompt-discovery surface', () => {
    setup({ onAttachFiles: vi.fn() });
    expect(screen.queryByLabelText('Quick actions')).toBeNull();
    expect(document.querySelector('.ai-quick')).toBeNull();
    // The paperclip is what is left in the lead cluster, and it must survive the removal.
    expect(screen.getByLabelText('Attach reference video or image')).toBeDefined();
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

/**
 * The writing row's shape and order.
 *
 * jsdom has no layout, so nothing here can assert pixels. What it CAN hold is the
 * contract the last regression broke: the DOM order the CSS grid is written against,
 * and the fact that the message column is the one between the two control clusters.
 * `aef2824` changed that order in one stylesheet's favour while a later-imported
 * stylesheet still described the old one, and the composer rendered with a truncated
 * placeholder for a full commit because nothing asserted the shape at all.
 */
describe('the writing row', () => {
  const row = (): HTMLElement => {
    const element = document.querySelector('.ai-composer');
    if (!element) throw new Error('no composer row');
    return element as HTMLElement;
  };

  it('puts the lead controls, the message and send in that order', () => {
    setup({ onAttachFiles: vi.fn() });
    const children = Array.from(row().children);
    expect(children).toHaveLength(3);
    expect(children[0]?.className).toContain('ai-composer-lead');
    expect(children[1]?.tagName).toBe('TEXTAREA');
    expect(children[2]?.className).toContain('ai-composer-send');
  });

  it('keeps the message between the clusters when the host cannot attach files', () => {
    // The paperclip is absent on a host that cannot import; the lead cluster stays, so
    // the grid still has exactly three children and the columns still line up.
    setup();
    const children = Array.from(row().children);
    expect(children).toHaveLength(3);
    expect(children[1]?.tagName).toBe('TEXTAREA');
  });

  it('swaps send for stop in place while a run is going', () => {
    setup({ running: true, runStatus: 'generating' });
    const children = Array.from(row().children);
    expect(children[2]?.className).toContain('ai-composer-stop');
    expect(document.querySelector('.ai-composer-send')).toBeNull();
  });

  it('keeps the lead cluster as the first column even when it is empty', () => {
    // On a host that cannot attach files it renders nothing — but it still has to
    // occupy column one, or the message shifts left on one host and not the other.
    setup();
    const lead = document.querySelector('.ai-composer-lead');
    expect(lead).not.toBeNull();
    expect(lead?.querySelectorAll('button')).toHaveLength(0);
    expect(Array.from(row().children)).toHaveLength(3);
  });

  it('labels every icon-only control', () => {
    setup({ onAttachFiles: vi.fn() });
    for (const label of ['Attach reference video or image', 'Send']) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });
});

/**
 * Pill while it is one line, rounded rectangle once it is not.
 *
 * The flag is measured from layout rather than read off the text, because a long
 * paragraph wraps without ever containing a newline. jsdom reports `scrollHeight` as 0,
 * so these stub it — what is under test is the THRESHOLD and the fact that the shape
 * follows measured height, not the browser's layout engine.
 */
describe('the shape follows the content', () => {
  const withScrollHeight = (px: number): void => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => px,
    });
  };

  const shell = (): HTMLElement => document.querySelector('.ai-composer-shell') as HTMLElement;

  it('is a pill while empty', () => {
    setup({ value: '' });
    expect(shell().hasAttribute('data-multiline')).toBe(false);
  });

  it('stays a pill for a message that fits on one line', () => {
    // 28px: one 18px line plus the input's 10px of vertical padding.
    withScrollHeight(28);
    setup({ value: 'tighten the intro' });
    expect(shell().hasAttribute('data-multiline')).toBe(false);
  });

  it('becomes a rectangle once the message wraps, with no newline in the value', () => {
    withScrollHeight(64);
    setup({ value: 'a single long paragraph that wraps across several lines on its own' });
    expect(shell().hasAttribute('data-multiline')).toBe(true);
  });

  it('returns to a pill when the message is cleared', () => {
    withScrollHeight(64);
    const { rerender } = renderComposer({ value: 'wrapped\nmessage' });
    expect(shell().hasAttribute('data-multiline')).toBe(true);
    rerender({ value: '' });
    expect(shell().hasAttribute('data-multiline')).toBe(false);
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
