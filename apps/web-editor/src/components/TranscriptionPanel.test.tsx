/**
 * Tests for the Transcription panel.
 *
 * The behavior that matters to an editor: the words show up grouped by the clip they
 * play over, clicking a line/word seeks, the word under the playhead is marked, footage
 * with no words is listed with a way to transcribe it, and a provider failure is
 * reported honestly instead of leaving a spinner or faking a transcript.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import type { UseEditor } from '../editor/useEditor.js';
import { beginTranscriptionJob, resetTranscriptionJobs } from '../editor/transcriptionJobs.js';
import { TranscriptionPanel } from './TranscriptionPanel.js';

const transcribe = vi.fn();
vi.mock('../editor/bridge.js', () => ({
  transcribeAsset: (req: unknown) => transcribe(req),
}));
vi.mock('../editor/useSettings.js', () => ({
  useSettings: () => ({ settings: { asrProvider: 'local-whisper' }, update: vi.fn() }),
}));

const timeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'interview',
          trackId: 'v',
          start: 0,
          end: 10,
          sourceStart: 0,
          sourceEnd: 10,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

const assets = [
  { id: 'interview', path: '/media/interview.mp4', kind: 'video', durationSeconds: 10 },
  { id: 'broll', path: '/media/broll.mp4', kind: 'video', durationSeconds: 8 },
];

const transcript: readonly TranscriptWord[] = [
  { word: 'hello', start: 0, end: 0.5 },
  { word: 'world', start: 0.6, end: 1.1 },
];

/** A minimal editor whose playhead can be moved to drive the active-word highlight. */
function fakeEditor(words: readonly TranscriptWord[] = transcript): UseEditor & {
  setPlayhead: (t: number) => void;
  applyPatchChecked: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
} {
  let playhead = 0;
  const listeners = new Set<() => void>();
  return {
    state: { timeline, assets, transcript: words } as never,
    seek: vi.fn(),
    applyPatchChecked: vi.fn(() => []),
    getPlayhead: () => playhead,
    subscribePlayhead: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setPlayhead: (t: number) => {
      playhead = t;
      for (const l of listeners) l();
    },
  } as unknown as UseEditor & {
    setPlayhead: (t: number) => void;
    applyPatchChecked: ReturnType<typeof vi.fn>;
    seek: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  transcribe.mockReset();
  resetTranscriptionJobs();
  window.localStorage.clear();
});

describe('TranscriptionPanel', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <TranscriptionPanel editor={fakeEditor()} open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('groups the words under the clip they play over and seeks on click', () => {
    const editor = fakeEditor();
    render(<TranscriptionPanel editor={editor} open onClose={vi.fn()} />);

    expect(screen.getByText('interview.mp4')).toBeTruthy();
    fireEvent.click(screen.getByText('hello'));
    expect(editor.seek).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByLabelText('seek to 0:00'));
    expect(editor.seek).toHaveBeenCalledTimes(2);
  });

  it('marks the word under the playhead', () => {
    const editor = fakeEditor();
    render(<TranscriptionPanel editor={editor} open onClose={vi.fn()} />);
    act(() => editor.setPlayhead(0.7));
    expect(screen.getByText('world').getAttribute('data-active')).toBe('true');
    expect(screen.getByText('hello').getAttribute('data-active')).toBeNull();
  });

  it('filters lines by the search query', () => {
    render(<TranscriptionPanel editor={fakeEditor()} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('search transcription'), {
      target: { value: 'nothing' },
    });
    expect(screen.getByText(/No lines match/)).toBeTruthy();
  });

  it('lists footage with no words and transcribes it through the trusted host', async () => {
    const editor = fakeEditor();
    transcribe.mockResolvedValue({
      ok: true,
      assetId: 'broll',
      words: [{ word: 'later', start: 0, end: 0.4 }],
    });
    render(
      <TranscriptionPanel
        editor={editor}
        open
        onClose={vi.fn()}
        ensureSavedForTranscription={async () => '/tmp/p.fp.json'}
      />,
    );

    expect(screen.getByText('broll.mp4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(() => expect(editor.applyPatchChecked).toHaveBeenCalledTimes(1));
    expect(transcribe.mock.calls[0]?.[0]).toMatchObject({ assetId: 'broll' });
  });

  it('shows progress for an import-triggered job instead of a duplicate action', async () => {
    beginTranscriptionJob('broll', 'whisper-cli');
    render(<TranscriptionPanel editor={fakeEditor()} open onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Transcribe' })).toBeNull();
    expect(await screen.findByRole('progressbar', { name: 'Transcribing broll.mp4' })).toBeTruthy();
  });

  it('reports a provider failure instead of pretending it worked', async () => {
    const editor = fakeEditor();
    transcribe.mockResolvedValue({ ok: false, error: 'Whisper model not installed.' });
    render(
      <TranscriptionPanel
        editor={editor}
        open
        onClose={vi.fn()}
        ensureSavedForTranscription={async () => '/tmp/p.fp.json'}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Whisper model not installed.',
    );
    expect(editor.applyPatchChecked).not.toHaveBeenCalled();
  });

  it('says transcription needs the desktop app when there is no trusted host', async () => {
    render(<TranscriptionPanel editor={fakeEditor()} open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    expect((await screen.findByRole('alert')).textContent).toContain('desktop app');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('is honest when nothing has been transcribed yet', () => {
    render(<TranscriptionPanel editor={fakeEditor([])} open onClose={vi.fn()} />);
    expect(screen.getByText(/Nothing transcribed yet/)).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<TranscriptionPanel editor={fakeEditor()} open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
