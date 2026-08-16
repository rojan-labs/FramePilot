import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  CAPTION_FONT_CATALOG,
  DEFAULT_CAPTION_FONT_FAMILY,
} from '@framepilot/timeline-schema/caption-fonts';
import { useEditor } from '../editor/useEditor.js';
import { CaptionEditor } from './CaptionEditor.js';

const transcript = [
  { word: 'hello', start: 0, end: 0.4 },
  { word: 'world', start: 0.4, end: 0.8 },
  { word: 'again', start: 0.8, end: 1.4 },
  { word: 'today', start: 1.4, end: 2 },
];

function timeline(): Timeline {
  return {
    tracks: [
      {
        id: 'captions',
        type: 'caption',
        clips: [
          {
            id: 'cap_a',
            assetId: '__caption__',
            trackId: 'captions',
            start: 0,
            end: 0.8,
            sourceStart: 0,
            sourceEnd: 0.8,
            effects: [],
            keyframes: [],
            captionCue: {
              text: 'hello world',
              words: transcript.slice(0, 2),
            },
          },
          {
            id: 'cap_b',
            assetId: '__caption__',
            trackId: 'captions',
            start: 0.8,
            end: 1.4,
            sourceStart: 0,
            sourceEnd: 0.6,
            effects: [],
            keyframes: [],
            captionCue: {
              text: 'again',
              words: transcript.slice(2, 3),
            },
          },
          {
            id: 'cap_c',
            assetId: '__caption__',
            trackId: 'captions',
            start: 1.4,
            end: 2,
            sourceStart: 0,
            sourceEnd: 0.6,
            effects: [],
            keyframes: [],
            captionCue: {
              text: 'today',
              words: transcript.slice(3),
            },
          },
        ],
      },
      {
        id: 'video',
        type: 'video',
        clips: [
          {
            id: 'video_a',
            assetId: 'asset_a',
            trackId: 'video',
            start: 0,
            end: 2,
            sourceStart: 0,
            sourceEnd: 2,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  };
}

const cue = (text: string): HTMLElement =>
  screen.getByRole('button', { name: `Edit caption "${text}"` });

function Host(): JSX.Element {
  const editor = useEditor(timeline());
  const captions = editor.state.timeline.tracks.find((track) => track.type === 'caption');
  return (
    <>
      <CaptionEditor editor={editor} transcript={transcript} />
      <output data-testid="selection">{editor.state.selectedIds.join(',')}</output>
      <output data-testid="caption-state">{JSON.stringify(captions?.clips ?? [])}</output>
      <output data-testid="caption-track-state">{JSON.stringify(captions ?? null)}</output>
    </>
  );
}

describe('CaptionWorkspace workflow', () => {
  it('searches a long caption transcript without changing the project selection', async () => {
    render(<Host />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search captions' }), {
      target: { value: 'again' },
    });

    await waitFor(() => expect(cue('again')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Edit caption "hello world"' })).toBeNull();
    expect(screen.getByTestId('selection').textContent).toBe('');
  });

  it('supports range selection and communicates the affected scope', () => {
    render(<Host />);
    fireEvent.click(cue('hello world'));
    fireEvent.blur(screen.getByRole('textbox', { name: /Caption text at/ }));
    fireEvent.click(cue('today'), { shiftKey: true });

    expect(screen.getByText('3 selected')).toBeTruthy();
    expect(screen.getByTestId('selection').textContent).toContain('cap_a');
    expect(screen.getByTestId('selection').textContent).toContain('cap_c');
  });

  it('batch deletes selected captions as one workspace action', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));

    expect(screen.getByText('No captions to review')).toBeTruthy();
    expect(screen.getByTestId('caption-state').textContent).toBe('[]');
  });

  it('applies a selected-caption style to every selected cue', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByText('Selected cue style'));
    fireEvent.click(screen.getByRole('button', { name: 'color #ffd84d' }));

    const state = screen.getByTestId('caption-state').textContent ?? '';
    expect(state.match(/#ffd84d/g)?.length).toBe(3);
  });

  it('uses the canonical Select for caption fonts and commits the track choice', () => {
    render(<Host />);
    fireEvent.click(screen.getByText('Typography'));

    const target = CAPTION_FONT_CATALOG.find(
      (font) => font.family !== DEFAULT_CAPTION_FONT_FAMILY,
    );
    expect(target).toBeDefined();

    fireEvent.click(screen.getByRole('combobox', { name: 'Font for all captions' }));
    fireEvent.click(screen.getByRole('option', { name: new RegExp(target!.family, 'i') }));

    expect(screen.getByTestId('caption-track-state').textContent).toContain(
      `"fontFamily":"${target!.family}"`,
    );
  });

  it('commits timing fields once instead of writing on every keystroke', () => {
    render(<Host />);
    fireEvent.click(cue('hello world'));
    fireEvent.blur(screen.getByRole('textbox', { name: /Caption text at/ }));

    const start = screen.getByRole('spinbutton', { name: 'Caption start time' });
    fireEvent.change(start, { target: { value: '0.1' } });
    expect(screen.getByTestId('caption-state').textContent).toContain('"start":0');
    fireEvent.blur(start);
    expect(screen.getByTestId('caption-state').textContent).toContain('"start":0.1');
  });

  it('pauses auto-follow when the user manually navigates the list', () => {
    render(<Host />);
    fireEvent.wheel(screen.getByRole('list', { name: 'caption clips' }).parentElement!);
    expect(screen.getByRole('button', { name: 'Return to current caption' })).toBeTruthy();
  });
});
