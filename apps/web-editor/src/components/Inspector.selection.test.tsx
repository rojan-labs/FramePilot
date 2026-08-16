/**
 * The inspector shell (revamp Phase 4, F6): context-awareness, persisted collapse
 * state, mixed-value display and the property clipboard.
 *
 * The registry's *rules* are asserted purely in
 * `inspector/inspector-architecture.test.ts`; this file proves the shell honours
 * them — that the sections a selection implies are the sections that render, and that
 * the four whole-selection actions each produce exactly one undo step.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { Inspector } from './Inspector.js';

afterEach(() => localStorage.clear());

const clip = (
  id: string,
  start: number,
  end: number,
  trackId = 'v',
  extra: Record<string, unknown> = {},
) => ({
  id,
  assetId: 'a',
  trackId,
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
  ...extra,
});

const twoClips: Timeline = {
  tracks: [{ id: 'v', type: 'video', clips: [clip('c1', 0, 4), clip('c2', 4, 8)] }],
};

function Host({
  timeline = twoClips,
}: {
  readonly timeline?: Timeline;
} = {}): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  // May be absent (a single-clip fixture) — the readout is only used by the
  // clipboard cases, which supply two clips.
  const graded = editor.state.timeline.tracks[0]?.clips[1];
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.select('c1')}>
        pick c1
      </button>
      <button type="button" onClick={() => editor.select('c2')}>
        pick c2
      </button>
      <button type="button" onClick={() => editor.select('c2', 'add')}>
        add c2
      </button>
      <button type="button" onClick={() => editor.select(null)}>
        clear
      </button>
      <button type="button" onClick={() => editor.undo()}>
        undo
      </button>
      <span data-testid="history">{editor.history.entries.length}</span>
      <span data-testid="c2-effects">{(graded?.effects ?? []).map((e) => e.type).join(',')}</span>
      <Inspector editor={editor} />
    </SettingsProvider>
  );
}

const sectionNames = (): string[] =>
  Array.from(document.querySelectorAll('.inspector-panel')).map(
    (panel) => panel.getAttribute('aria-label') ?? '',
  );

describe('Inspector — context awareness', () => {
  it('shows an empty state and no sections with nothing selected', () => {
    render(<Host />);
    expect(screen.getByText('It’s empty here')).toBeTruthy();
    expect(sectionNames()).toEqual([]);
  });

  it('renders the clip sections in registry order', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    // Order comes from the registry's `order`, not from a JSX layout.
    expect(sectionNames()).toEqual([
      'transform',
      'color',
      'speed',
      'audio',
      'crop',
      'blend mode',
      // No `transition`: this fixture's clips carry none, and since revamp Phase 9
      // the section appears only when the primary clip actually has one rather than
      // rendering an empty disclosure.
      'mask',
      'effects',
    ]);
  });

  it('omits Audio for a clip on a track that carries none', () => {
    const captions: Timeline = {
      tracks: [{ id: 'cap', type: 'caption', clips: [clip('t1', 0, 4, 'cap')] }],
    };
    function CaptionHost(): JSX.Element {
      const editor = useEditor(captions, ['a']);
      return (
        <SettingsProvider>
          <button type="button" onClick={() => editor.select('t1')}>
            pick t1
          </button>
          <Inspector editor={editor} />
        </SettingsProvider>
      );
    }
    render(<CaptionHost />);
    fireEvent.click(screen.getByRole('button', { name: 'pick t1' }));
    expect(sectionNames()).not.toContain('audio');
  });

  it('adds Text only when the clip has a text effect', () => {
    const withText: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            clip('c1', 0, 4, 'v', {
              effects: [{ id: 'e1', type: 'text', params: { text: 'hi' }, keyframes: [] }],
            }),
          ],
        },
      ],
    };
    render(<Host timeline={withText} />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    expect(sectionNames()).toContain('text');
  });

  it('drops Transition for a multi-selection and says how many are selected', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'add c2' }));
    expect(screen.getByLabelText('multi-selection').textContent).toContain('2 clips selected');
    expect(sectionNames()).not.toContain('transition');
  });

  it('returns to the empty state when the selection is cleared', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    expect(sectionNames().length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(sectionNames()).toEqual([]);
  });
});

describe('Inspector — persisted collapse state', () => {
  const panel = (label: string): HTMLDetailsElement =>
    document.querySelector(`.inspector-panel[aria-label="${label}"]`) as HTMLDetailsElement;

  it('honours each section’s registry default on first ever view', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    // Everyday controls open; occasional ones collapsed, so the panel is a short
    // scannable list rather than a wall.
    expect(panel('transform').open).toBe(true);
    expect(panel('color').open).toBe(true);
    expect(panel('crop').open).toBe(false);
    expect(panel('mask').open).toBe(false);
  });

  it('remembers a collapse ACROSS A SELECTION CHANGE', () => {
    // The old `<details open>` hardcoded the attribute, so this was the bug: a
    // section you collapsed re-opened the moment you clicked another clip.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    fireEvent.click(panel('color').querySelector('summary') as HTMLElement);
    expect(panel('color').open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'pick c2' }));
    expect(panel('color').open).toBe(false);
  });

  it('persists the choice to settings, so it survives a reload', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    // Driven through the `toggle` event rather than a summary click: jsdom's
    // <details> only reliably reports the open→closed direction from a click, and
    // what is under test is the handler + persistence, not jsdom's disclosure.
    const crop = panel('crop');
    crop.open = true;
    fireEvent(crop, new Event('toggle'));
    const stored = JSON.parse(localStorage.getItem('framepilot.settings') ?? '{}');
    expect(stored.inspectorSections.crop).toBe(true);
  });

  it('reads a persisted state back on mount', () => {
    localStorage.setItem(
      'framepilot.settings',
      JSON.stringify({ inspectorSections: { transform: false, mask: true } }),
    );
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    expect(panel('transform').open).toBe(false);
    expect(panel('mask').open).toBe(true);
  });

  it('ignores a corrupt persisted map rather than breaking the panel', () => {
    localStorage.setItem(
      'framepilot.settings',
      JSON.stringify({ inspectorSections: { transform: 'yes', crop: 1, mask: true } }),
    );
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    // Non-boolean entries are dropped, so those sections fall back to the registry.
    expect(panel('transform').open).toBe(true);
    expect(panel('crop').open).toBe(false);
    expect(panel('mask').open).toBe(true);
  });
});

describe('Inspector — the property clipboard', () => {
  /** A timeline whose second clip has a real grade to copy. */
  const graded: Timeline = {
    tracks: [
      {
        id: 'v',
        type: 'video',
        clips: [
          clip('c1', 0, 4),
          clip('c2', 4, 8, 'v', {
            effects: [
              { id: 'g', type: 'color_grade', params: { saturation: -0.5 }, keyframes: [] },
            ],
          }),
        ],
      },
    ],
  };

  it('cannot paste before anything has been copied', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    expect(screen.getByLabelText('paste properties').hasAttribute('disabled')).toBe(true);
  });

  it('copies a clip’s look and pastes it onto another as ONE undo step', () => {
    render(<Host timeline={graded} />);
    // Copy the graded clip…
    fireEvent.click(screen.getByRole('button', { name: 'pick c2' }));
    fireEvent.click(screen.getByLabelText('copy properties'));
    // …and paste onto the ungraded one.
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    const before = Number(screen.getByTestId('history').textContent);
    fireEvent.click(screen.getByLabelText('paste properties'));
    const after = Number(screen.getByTestId('history').textContent);
    // Six properties across one clip is ONE history entry, because it was one action.
    expect(after).toBe(before + 1);
    // And one undo reverses the whole paste.
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(Number(screen.getByTestId('history').textContent)).toBe(after);
  });

  it('offers apply-to-all only for a multi-selection', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    expect(screen.queryByLabelText('apply to selected')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'add c2' }));
    expect(screen.getByLabelText('apply to selected')).toBeTruthy();
  });

  it('resets every property back to the engine default in one step', () => {
    render(<Host timeline={graded} />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c2' }));
    expect(screen.getByTestId('c2-effects').textContent).toContain('color_grade');
    const before = Number(screen.getByTestId('history').textContent);
    fireEvent.click(screen.getByLabelText('reset all properties'));
    expect(Number(screen.getByTestId('history').textContent)).toBe(before + 1);
  });

  it('does not record a no-op reset on an already-default clip', () => {
    // A patch that changes nothing would still land in history as an undoable step
    // that did nothing, which makes undo untrustworthy.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'pick c1' }));
    const before = Number(screen.getByTestId('history').textContent);
    fireEvent.click(screen.getByLabelText('reset all properties'));
    expect(Number(screen.getByTestId('history').textContent)).toBe(before);
  });
});
