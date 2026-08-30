/**
 * Tests for the rebuilt Captions panel (schema v11, ADR 0071).
 *
 * Three behaviours matter here and none existed before v11: caption text is
 * editable, a template restyles the WHOLE track in one operation, and cues can be
 * split and merged. Each mutation must be a real, undoable patch — not local
 * state — so the assertions go through `useEditor` and check undo.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { activeCaptionIdAt, CaptionEditor } from './CaptionEditor.js';

const transcript = [
  { word: 'hello', start: 0, end: 0.4 },
  { word: 'world', start: 0.4, end: 0.8 },
  { word: 'again', start: 0.8, end: 1.6 },
];

/**
 * The footage the transcript came from. Required since v12: cues are derived by
 * mapping transcript words through the clips that actually play (ADR 0076), so a
 * timeline with no media has nothing to caption.
 */
const videoTrack = () =>
  ({
    id: 'video_1',
    type: 'video',
    clips: [
      {
        id: 'clip_1',
        assetId: 'asset_1',
        trackId: 'video_1',
        start: 0,
        end: 2,
        sourceStart: 0,
        sourceEnd: 2,
        effects: [],
        keyframes: [],
      },
    ],
  }) satisfies Timeline['tracks'][number];

/** Two cues, each carrying its own text (the v11 shape). */
function captionTimeline(): Timeline {
  return {
    // Caption track first: the test harness reads `tracks[0]` as the cue list.
    tracks: [
      {
        id: 'caption_1',
        type: 'caption',
        clips: [
          {
            id: 'cap_a',
            assetId: '__caption__',
            trackId: 'caption_1',
            start: 0,
            end: 0.8,
            sourceStart: 0,
            sourceEnd: 0.8,
            effects: [],
            keyframes: [],
            captionCue: {
              text: 'hello world',
              words: [
                { word: 'hello', start: 0, end: 0.4 },
                { word: 'world', start: 0.4, end: 0.8 },
              ],
            },
          },
          {
            id: 'cap_b',
            assetId: '__caption__',
            trackId: 'caption_1',
            start: 0.8,
            end: 1.6,
            sourceStart: 0,
            sourceEnd: 0.8,
            effects: [],
            keyframes: [],
            captionCue: { text: 'again', words: [{ word: 'again', start: 0.8, end: 1.6 }] },
          },
        ],
      },
      videoTrack(),
    ],
  };
}

/** The cue row whose text is `text` (rows are labelled by their content). */
const cueButton = (text: string): HTMLElement =>
  screen.getByRole('button', { name: `Edit caption "${text}"` });

it('finds the active cue without scanning a long caption lane', () => {
  const clips = captionTimeline().tracks[0]!.clips;
  expect(activeCaptionIdAt(clips, 0.4)).toBe('cap_a');
  expect(activeCaptionIdAt(clips, 1.2)).toBe('cap_b');
  expect(activeCaptionIdAt(clips, 2)).toBeNull();
});

it('windows a feature-length cue list instead of mounting every caption row', () => {
  const clips = Array.from({ length: 7_200 }, (_, index) => ({
    id: `cap_${index}`,
    assetId: '__caption__',
    trackId: 'caption_long',
    start: index,
    end: index + 1,
    sourceStart: 0,
    sourceEnd: 1,
    effects: [],
    keyframes: [],
    captionCue: { text: `Cue ${index}`, words: [] },
  }));
  function LongCaptionHost(): JSX.Element {
    const editor = useEditor({
      tracks: [{ id: 'caption_long', type: 'caption', clips }, videoTrack()],
    } as Timeline);
    return <CaptionEditor fps={30} editor={editor} transcript={[]} />;
  }

  render(<LongCaptionHost />);
  const mounted = screen.getAllByTestId('caption-cue-row');
  expect(mounted.length).toBeLessThan(50);
  expect(mounted[0]?.getAttribute('aria-setsize')).toBe('7200');
});

describe('CaptionEditor — cue text editing', () => {
  function Host(): JSX.Element {
    const editor = useEditor(captionTimeline());
    return (
      <>
        <CaptionEditor fps={30} editor={editor} transcript={transcript} />
        <span data-testid="undo">{String(editor.canUndo)}</span>
        <button type="button" onClick={() => editor.undo()}>
          undo
        </button>
      </>
    );
  }

  it('shows each cue’s own text', () => {
    render(<Host />);
    expect(cueButton('hello world')).toBeTruthy();
    expect(cueButton('again')).toBeTruthy();
  });

  it('edits a cue’s text and persists it as an undoable patch', () => {
    render(<Host />);
    fireEvent.click(cueButton('hello world'));
    const input = screen.getByRole('textbox', { name: /Caption text at/ });
    fireEvent.change(input, { target: { value: 'goodbye world' } });
    fireEvent.blur(input);

    expect(cueButton('goodbye world')).toBeTruthy();
    expect(screen.getByTestId('undo').textContent).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(cueButton('hello world')).toBeTruthy();
  });

  it('reverts an in-progress edit on Escape without touching the project', () => {
    render(<Host />);
    fireEvent.click(cueButton('hello world'));
    const input = screen.getByRole('textbox', { name: /Caption text at/ });
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(cueButton('hello world')).toBeTruthy();
    // Nothing was applied, so there is nothing to undo.
    expect(screen.getByTestId('undo').textContent).toBe('false');
  });

  it('commits on Ctrl+Enter, leaving plain Enter free for a line break', () => {
    render(<Host />);
    fireEvent.click(cueButton('hello world'));
    const input = screen.getByRole('textbox', { name: /Caption text at/ });
    fireEvent.change(input, { target: { value: 'first\nsecond' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    // The author's line break survives into the cue.
    expect(cueButton('first\nsecond')).toBeTruthy();
  });

  it('does not push an undo entry when the text is unchanged', () => {
    render(<Host />);
    fireEvent.click(cueButton('hello world'));
    fireEvent.blur(screen.getByRole('textbox', { name: /Caption text at/ }));
    expect(screen.getByTestId('undo').textContent).toBe('false');
  });
});

describe('CaptionEditor — split and merge', () => {
  function Host(): JSX.Element {
    const editor = useEditor(captionTimeline());
    return (
      <>
        <button type="button" onClick={() => editor.seek(0.4)}>
          seek-mid
        </button>
        <CaptionEditor fps={30} editor={editor} transcript={transcript} />
        <span data-testid="cues">{String(editor.state.timeline.tracks[0]?.clips.length)}</span>
      </>
    );
  }

  it('splits a cue at the playhead, giving each half its own words', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'seek-mid' }));
    fireEvent.click(screen.getByRole('button', { name: /Split caption at 0:00.00/ }));
    expect(screen.getByTestId('cues').textContent).toBe('3');
    // The words divide by where they are spoken, not by character count.
    expect(cueButton('hello')).toBeTruthy();
    expect(cueButton('world')).toBeTruthy();
  });

  it('merges a cue with the next, joining their text', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /Merge caption at 0:00.00 with the next/ }));
    expect(screen.getByTestId('cues').textContent).toBe('1');
    expect(cueButton('hello world again')).toBeTruthy();
  });

  it('disables merge on the last cue — there is nothing after it', () => {
    render(<Host />);
    expect(
      screen.getByRole('button', { name: /Merge caption at 0:00.80 with the next/ }),
    ).toHaveProperty('disabled', true);
  });

  it('deletes a cue', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /Delete caption at 0:00.00/ }));
    expect(screen.getByTestId('cues').textContent).toBe('1');
  });
});

describe('CaptionEditor — styling scope', () => {
  function Host(): JSX.Element {
    const editor = useEditor(captionTimeline());
    return (
      <>
        <CaptionEditor fps={30} editor={editor} transcript={transcript} />
        <span data-testid="track-template">
          {String(editor.state.timeline.tracks[0]?.captionStyle?.templateId)}
        </span>
        <span data-testid="clip-style">
          {JSON.stringify(editor.state.timeline.tracks[0]?.clips[0]?.captionStyle ?? null)}
        </span>
        <span data-testid="track-style">
          {JSON.stringify(editor.state.timeline.tracks[0]?.captionStyle ?? null)}
        </span>
      </>
    );
  }

  it('applies a template to the WHOLE track in one operation', () => {
    // The v10 panel styled one clip at a time, so restyling a finished set meant
    // clicking every cue.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /One word/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Impact\./ }));
    expect(screen.getByTestId('track-template').textContent).toBe('impact');
    // No per-clip style was written — the track carries the look.
    expect(screen.getByTestId('clip-style').textContent).toBe('null');
  });

  it('keeps per-cue overrides scoped to the selected cue', () => {
    render(<Host />);
    fireEvent.click(screen.getByText('Selected cue style (select a cue)'));
    fireEvent.click(cueButton('hello world'));
    fireEvent.blur(screen.getByRole('textbox', { name: /Caption text at/ }));
    fireEvent.click(screen.getByRole('button', { name: 'color #ffd84d' }));
    expect(screen.getByTestId('clip-style').textContent).toContain('#ffd84d');
    // The track default is untouched by a per-cue override.
    expect(screen.getByTestId('track-template').textContent).toBe('undefined');
  });

  it('disables the per-cue controls until a cue is selected', () => {
    render(<Host />);
    fireEvent.click(screen.getByText('Selected cue style (select a cue)'));
    expect(screen.getByRole('button', { name: 'color #ffd84d' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'top' })).toHaveProperty('disabled', true);
  });

  it('applies visible keyword emphasis to the whole track on blur', () => {
    render(<Host />);
    fireEvent.click(screen.getByText('Timing and emphasis'));
    const input = screen.getByRole('textbox', { name: 'keywords' });
    fireEvent.change(input, { target: { value: 'world' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('track-style').textContent).toContain(
      '"accent":{"mode":"keywords","keywords":["world"],"color":"#ffd60a","fontScale":1.18}',
    );
    expect(
      cueButton('hello world').querySelector('[data-highlight="true"]')?.textContent,
    ).toContain('world');
  });

  it('offers one-click semantic auto emphasis and persists its anchors', () => {
    function ImpactHost(): JSX.Element {
      const editor = useEditor(captionTimeline());
      const impactTranscript = [
        { word: 'biggest', start: 0, end: 0.4 },
        { word: 'mistake', start: 0.4, end: 0.8 },
        { word: 'avoid', start: 0.8, end: 1.6 },
      ];
      return (
        <>
          <CaptionEditor fps={30} editor={editor} transcript={impactTranscript} />
          <span data-testid="track-style">
            {JSON.stringify(editor.state.timeline.tracks[0]?.captionStyle ?? null)}
          </span>
        </>
      );
    }
    render(<ImpactHost />);
    fireEvent.click(screen.getByText('Timing and emphasis'));
    const action = screen.getByRole('button', { name: 'Auto emphasis' });
    expect(action.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(action);
    expect(screen.getByTestId('track-style').textContent).toContain('"mode":"keywords"');
  });

  it('uses the injected AI analyzer and labels the result truthfully', async () => {
    const analyzeEmphasis = vi.fn(async () => ({
      keywords: ['world'],
      source: 'ai' as const,
      rationale: 'The payoff word.',
    }));
    function AiHost(): JSX.Element {
      const editor = useEditor(captionTimeline());
      return (
        <CaptionEditor fps={30} editor={editor} transcript={transcript} analyzeEmphasis={analyzeEmphasis} />
      );
    }
    render(<AiHost />);
    fireEvent.click(screen.getByText('Timing and emphasis'));
    fireEvent.click(screen.getByRole('button', { name: 'Auto emphasis' }));
    expect(screen.getByRole('button', { name: 'Analyzing…' })).toHaveProperty('disabled', true);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('AI emphasis applied.'),
    );
    expect(screen.getByRole('button', { name: 'Auto emphasis' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('textbox', { name: 'keywords' })).toHaveProperty('value', 'world');
    expect(analyzeEmphasis).toHaveBeenCalledOnce();
  });

  it('persists direct-layout controls on the selected cue', () => {
    render(<Host />);
    fireEvent.click(screen.getByText('Selected cue style (select a cue)'));
    fireEvent.click(cueButton('hello world'));
    fireEvent.blur(screen.getByRole('textbox', { name: /Caption text at/ }));
    const rotation = screen.getByRole('spinbutton', { name: 'caption rotation' });
    fireEvent.change(rotation, {
      target: { value: '14' },
    });
    fireEvent.blur(rotation);
    fireEvent.click(screen.getByRole('button', { name: 'left' }));
    expect(screen.getByTestId('clip-style').textContent).toContain('"rotation":14');
    expect(screen.getByTestId('clip-style').textContent).toContain('"textAlign":"left"');
  });

  it('commits a continuous caption control once when the gesture ends', () => {
    render(<Host />);
    fireEvent.click(screen.getByText('Selected cue style (select a cue)'));
    fireEvent.click(cueButton('hello world'));
    fireEvent.blur(screen.getByRole('textbox', { name: /Caption text at/ }));
    const size = screen.getByRole('slider', { name: 'caption size' });

    fireEvent.change(size, { target: { value: '1.2' } });
    fireEvent.change(size, { target: { value: '1.4' } });
    fireEvent.change(size, { target: { value: '1.6' } });
    expect(screen.getByTestId('clip-style').textContent).toBe('null');

    fireEvent.pointerUp(size);
    expect(screen.getByTestId('clip-style').textContent).toContain('"fontScale":1.6');
  });

  it('offers 20+ bundled creative fonts and persists the selected face', () => {
    render(<Host />);
    fireEvent.click(screen.getByText('Typography'));
    const trackPicker = screen.getByRole('combobox', { name: 'Font for all captions' });
    fireEvent.click(trackPicker);
    expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(20);
    fireEvent.click(screen.getByRole('option', { name: /^Montserrat\b/i }));
    expect(screen.getByTestId('track-style').textContent).toContain('"fontFamily":"Montserrat"');

    fireEvent.click(screen.getByText('Selected cue style (select a cue)'));
    fireEvent.click(cueButton('hello world'));
    fireEvent.blur(screen.getByRole('textbox', { name: /Caption text at/ }));
    const picker = screen.getByRole('combobox', { name: 'Font for selected cue' });
    fireEvent.click(picker);
    expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(20);
    fireEvent.click(screen.getByRole('option', { name: /^Playfair Display\b/i }));
    expect(screen.getByTestId('clip-style').textContent).toContain(
      '"fontFamily":"Playfair Display"',
    );
  });
});

describe('CaptionEditor — template gallery', () => {
  function Host(): JSX.Element {
    const editor = useEditor(captionTimeline());
    return <CaptionEditor fps={30} editor={editor} transcript={transcript} />;
  }

  it('starts with All and exposes every category with style counts', () => {
    render(<Host />);
    const categories = screen.getByRole('group', { name: 'caption style categories' });
    expect(categories.textContent).toContain('All');
    expect(categories.textContent).toContain('One word');
    expect(screen.getByRole('button', { name: /All/, pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Punchline\./ })).toBeTruthy();
  });

  it('shows 12 styles initially and loads 8 more without changing the filter', () => {
    render(<Host />);
    const gallery = screen.getByRole('group', { name: 'caption styles' });
    expect(within(gallery).getAllByRole('button')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Load 8 more' }));
    expect(within(gallery).getAllByRole('button')).toHaveLength(20);
    expect(screen.getByRole('button', { name: /All/, pressed: true })).toBeTruthy();
  });

  it('filtering by category swaps the style set', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /One word/ }));
    expect(screen.getByRole('button', { name: /^Punchline\./ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Glow\./ })).toBeNull();
  });

  it('searches style names and behavior, with a recoverable empty state', () => {
    render(<Host />);
    const search = screen.getByRole('searchbox', { name: 'Search caption styles' });
    fireEvent.change(search, { target: { value: 'word by word' } });
    expect(screen.getByRole('button', { name: /^Punchline\./ })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'no-style-has-this-name' } });
    expect(screen.getByRole('status').textContent).toContain('No caption styles match');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('focuses style search with the slash shortcut', () => {
    render(<Host />);
    fireEvent.keyDown(screen.getByRole('region', { name: 'caption editor' }), { key: '/' });
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Search caption styles' }),
    );
  });

  it('tiles animate the canned phrase through CaptionOverlay', () => {
    const { container } = render(<Host />);
    const tile = container.querySelector('.caption-template-tile .caption-overlay');
    expect(tile).not.toBeNull();
    expect(tile?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('runs a preview clock only for the style being inspected', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    render(<Host />);
    const baselineRequests = requestFrame.mock.calls.length;
    const baselineCancels = cancelFrame.mock.calls.length;

    fireEvent.mouseEnter(screen.getByRole('button', { name: /^Punchline\./ }));
    expect(requestFrame).toHaveBeenCalledTimes(baselineRequests + 1);
    fireEvent.mouseLeave(screen.getByRole('button', { name: /^Punchline\./ }));
    expect(cancelFrame.mock.calls.slice(baselineCancels)).toContainEqual([1]);

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });
});

describe('CaptionEditor — generation', () => {
  function GenHost(): JSX.Element {
    const editor = useEditor({
      // Empty caption track plus the footage to caption — without media there is
      // nothing to derive cues from (ADR 0076).
      tracks: [{ id: 'caption_1', type: 'caption', clips: [] }, videoTrack()],
    } as unknown as Timeline);
    return (
      <>
        <CaptionEditor fps={30} editor={editor} transcript={transcript} />
        <span data-testid="cues">{String(editor.state.timeline.tracks[0]?.clips.length)}</span>
        <span data-testid="track-template">
          {String(editor.state.timeline.tracks[0]?.captionStyle?.templateId)}
        </span>
      </>
    );
  }

  it('previews the cues it will produce before committing', () => {
    render(<GenHost />);
    // The preview runs the real segmenter with the real config, so it cannot
    // drift from the result.
    expect(screen.getByLabelText('caption preview')).toBeTruthy();
  });

  it('generates cues and stamps the chosen template on the track', () => {
    render(<GenHost />);
    fireEvent.click(screen.getByRole('button', { name: /One word/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Stamp\./ }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    // A one-word template gives one cue per word.
    expect(screen.getByTestId('cues').textContent).toBe('3');
    expect(screen.getByTestId('track-template').textContent).toBe('stamp');
  });

  it('waits for AI emphasis and feeds its anchors into generation', async () => {
    const analyzeEmphasis = vi.fn(async () => ({
      keywords: ['world'],
      source: 'ai' as const,
    }));
    function AiGenHost(): JSX.Element {
      const editor = useEditor({
        tracks: [{ id: 'caption_1', type: 'caption', clips: [] }, videoTrack()],
      } as unknown as Timeline);
      return (
        <>
          <CaptionEditor
            editor={editor}
            transcript={transcript}
            fps={30}
            analyzeEmphasis={analyzeEmphasis}
          />
          <span data-testid="cues">{String(editor.state.timeline.tracks[0]?.clips.length)}</span>
          <span data-testid="track-style">
            {JSON.stringify(editor.state.timeline.tracks[0]?.captionStyle ?? null)}
          </span>
        </>
      );
    }
    render(<AiGenHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    expect(screen.getByRole('button', { name: 'Analyzing…' })).toHaveProperty('disabled', true);
    await waitFor(() => expect(screen.getByTestId('cues').textContent).not.toBe('0'));
    expect(screen.getByTestId('track-style').textContent).toContain('"keywords":["world"]');
    expect(analyzeEmphasis).toHaveBeenCalledOnce();
  });

  it('offers Regenerate once cues exist, and warns that it replaces them', () => {
    render(<GenHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    expect(screen.getByRole('button', { name: 'Regenerate captions' })).toBeTruthy();
    expect(screen.getByText(/Regenerating replaces all/)).toBeTruthy();
  });

  it('regenerating replaces rather than appending', () => {
    // The v10 generator derived ids from an index, so a second Generate collided
    // on every id.
    render(<GenHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }));
    const first = screen.getByTestId('cues').textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate captions' }));
    expect(screen.getByTestId('cues').textContent).toBe(first);
  });

  it('disables generation without a transcript', () => {
    function Empty(): JSX.Element {
      const editor = useEditor({
        tracks: [{ id: 'caption_1', type: 'caption', clips: [] }],
      } as unknown as Timeline);
      return <CaptionEditor fps={30} editor={editor} transcript={[]} />;
    }
    render(<Empty />);
    expect(screen.getByRole('button', { name: 'Generate captions' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
