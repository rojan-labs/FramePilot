/**
 * The transition inspector (revamp Phase 9, F7).
 *
 * Three facts worth a test, because each was a real gap or a real bug:
 *
 *  1. **Only kind-relevant controls render.** The rule the whole section turns on.
 *  2. **A kind swap or a resize does not wipe the look params.** `add_transition`
 *     rebuilds the params bag from scratch, so both routes silently reset direction,
 *     intensity, softness and easing before this phase fixed them.
 *  3. **Reset clears rather than writes defaults**, so a reset transition is
 *     indistinguishable from one never touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Effect, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { Inspector } from './Inspector.js';
import { TRANSITION_LIBRARY_STORAGE_KEYS } from './useTransitionLibrary.js';

afterEach(() => localStorage.clear());

const transitionEffect = (params: Record<string, unknown>): Effect => ({
  id: 'c2__transition',
  type: 'transition',
  params: { fromClipId: 'c1', durationSeconds: 1, ...params },
  keyframes: [],
});

const clip = (id: string, start: number, end: number, effects: Effect[] = []) => ({
  id,
  assetId: 'a',
  trackId: 'v',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects,
  keyframes: [],
});

const timelineWith = (params: Record<string, unknown>): Timeline => ({
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [clip('c1', 0, 4), clip('c2', 4, 8, [transitionEffect(params)])],
    },
  ],
});

/** The transition effect's params as the store currently holds them. */
let latestParams: Record<string, unknown> = {};
/** The lane's clips, for assertions about what a transition wrote on its NEIGHBOUR. */
let latestClips: readonly { id: string; effects: readonly Effect[] }[] = [];

function Host({ timeline }: { readonly timeline: Timeline }): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  const c2 = editor.state.timeline.tracks[0]?.clips.find((c) => c.id === 'c2');
  latestParams = (c2?.effects.find((e) => e.type === 'transition')?.params ?? {}) as Record<
    string,
    unknown
  >;
  latestClips = editor.state.timeline.tracks[0]?.clips ?? [];
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.select('c2')}>
        pick c2
      </button>
      {/*
        c1 first, then c2 with `add`: the store promotes an added clip to PRIMARY,
        and the panel edits the primary — so adding c1 last would swap the section
        onto a clip with no transition and remove it from the screen.
      */}
      <button
        type="button"
        onClick={() => {
          editor.select('c1');
          editor.select('c2', 'add');
        }}
      >
        select both
      </button>
      <span data-testid="history">{editor.history.entries.length}</span>
      <Inspector editor={editor} />
    </SettingsProvider>
  );
}

const open = (params: Record<string, unknown> = { kind: 'push' }) => {
  const view = render(<Host timeline={timelineWith(params)} />);
  fireEvent.click(screen.getByRole('button', { name: 'pick c2' }));
  // The transition controls live under their own category tab (industry inspector
  // panel revamp); the panel defaults to Basic, so every test needs to switch in.
  fireEvent.click(screen.getByRole('tab', { name: 'Transition' }));
  return view;
};

/** Drive the token-styled `Select` (a combobox popover, not a native `<select>`). */
const chooseOption = (name: string, option: string): void => {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(screen.getByRole('option', { name: option }));
};

const historyLength = (): number => Number(screen.getByTestId('history').textContent);

describe('only the controls the render reads', () => {
  it('shows direction and intensity for a push, and no softness', () => {
    open({ kind: 'push' });
    expect(screen.getByRole('combobox', { name: 'transition direction' })).toBeTruthy();
    expect(screen.getByLabelText('transition intensity')).toBeTruthy();
    expect(screen.queryByLabelText('transition softness')).toBeNull();
  });

  it('shows softness for a wipe, and no intensity', () => {
    // A wipe either reveals or it does not — "80% of a reveal" is not renderable.
    open({ kind: 'wipe' });
    expect(screen.getByLabelText('transition softness')).toBeTruthy();
    expect(screen.queryByLabelText('transition intensity')).toBeNull();
  });

  it('shows neither direction nor softness for a dissolve', () => {
    open({ kind: 'cross-dissolve' });
    expect(screen.queryByRole('combobox', { name: 'transition direction' })).toBeNull();
    expect(screen.queryByLabelText('transition softness')).toBeNull();
    expect(screen.getByLabelText('transition intensity')).toBeTruthy();
  });

  it('always shows easing — it shapes every envelope', () => {
    for (const kind of ['fade', 'push', 'wipe', 'blur']) {
      const view = open({ kind });
      expect(screen.getByRole('combobox', { name: 'transition easing' })).toBeTruthy();
      view.unmount();
    }
  });
});

describe('editing a look param', () => {
  it('writes it as one patch', () => {
    open({ kind: 'push' });
    const before = historyLength();
    chooseOption('transition direction', 'down');
    expect(latestParams.direction).toBe('down');
    expect(historyLength()).toBe(before + 1);
  });

  it('keeps the other params when the KIND is swapped', () => {
    // `add_transition` rebuilds the params bag; routing a swap through it silently
    // discarded everything the user had tuned.
    open({ kind: 'push', intensity: 0.4, easing: 'ease-in' });
    // The kind picker is a grouped NATIVE select now: 78 entries in one flat
    // custom listbox is unusable, and the category is how people think about
    // transitions.
    fireEvent.change(screen.getByLabelText('transition kind'), { target: { value: 'zoom' } });
    expect(latestParams.kind).toBe('zoom');
    expect(latestParams.intensity).toBe(0.4);
    expect(latestParams.easing).toBe('ease-in');
  });

  it('keeps the other params when the DURATION is applied', () => {
    open({ kind: 'push', intensity: 0.4, easing: 'ease-in' });
    fireEvent.change(screen.getByLabelText('transition duration'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply duration' }));
    expect(latestParams.durationSeconds).toBe(0.5);
    expect(latestParams.intensity).toBe(0.4);
    expect(latestParams.easing).toBe('ease-in');
    // Still one undo step, even though it took two operations to stay lossless.
    expect(historyLength()).toBe(1);
  });
});

describe('reset', () => {
  it('CLEARS the params instead of writing their defaults', () => {
    // A stored `intensity: 1` and an absent one render identically today, but only
    // the absent one keeps rendering identically if a default ever changes.
    open({ kind: 'push', intensity: 0.4, direction: 'down' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset look' }));
    expect(latestParams).not.toHaveProperty('intensity');
    expect(latestParams).not.toHaveProperty('direction');
    // The transition itself survives; only its look went back to default.
    expect(latestParams.kind).toBe('push');
    expect(latestParams.durationSeconds).toBe(1);
  });

  it('is unavailable when nothing has been overridden', () => {
    open({ kind: 'push' });
    expect(screen.getByRole('button', { name: 'Reset look' }).hasAttribute('disabled')).toBe(true);
  });

  it('offers a per-row reset only once that row differs from its default', () => {
    const view = open({ kind: 'push' });
    expect(screen.queryByRole('button', { name: 'reset transition intensity' })).toBeNull();
    view.unmount();
    open({ kind: 'push', intensity: 0.4 });
    expect(screen.getByRole('button', { name: 'reset transition intensity' })).toBeTruthy();
  });
});

describe('apply to selected cuts', () => {
  it('is unavailable until more than this clip is selected', () => {
    open({ kind: 'push' });
    const button = screen.getByRole('button', { name: /Apply to 0 selected/ });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('names how many cuts it would affect', () => {
    open({ kind: 'push' });
    fireEvent.click(screen.getByRole('button', { name: 'select both' }));
    expect(screen.getByRole('button', { name: /Apply to 1 selected/ })).toBeTruthy();
  });
});

describe('the kind’s own controls', () => {
  it('renders the render kind’s declared params, and only those', () => {
    // A mosaic has a block size and nothing else; a glitch has four numbers. The
    // section writes neither list — it asks the descriptors the renderers read.
    const view = open({ kind: 'mosaic' });
    expect(screen.getByLabelText('transition blockPx')).toBeTruthy();
    expect(screen.queryByLabelText('transition rgbSplit')).toBeNull();
    view.unmount();
    open({ kind: 'glitch' });
    expect(screen.getByLabelText('transition rgbSplit')).toBeTruthy();
    expect(screen.getByLabelText('transition blocks')).toBeTruthy();
  });

  it('renders a choice param as a menu of words, not of indices', () => {
    open({ kind: 'clock-wipe' });
    // Stored as a numeric index so the wire format stays uniform for the shader
    // and the numpy pass; shown as the word, because "0" is not a sweep direction.
    expect(screen.getByRole('combobox', { name: 'transition reverse' })).toBeTruthy();
  });

  it('writes a kind param as one patch', () => {
    open({ kind: 'mosaic' });
    const before = historyLength();
    fireEvent.change(screen.getByLabelText('transition blockPx'), { target: { value: '80' } });
    expect(latestParams.blockPx).toBe(80);
    expect(historyLength()).toBe(before + 1);
  });
});

describe('alignment', () => {
  it('offers the three placements, with the current one marked', () => {
    open({ kind: 'cross-dissolve' });
    const group = screen.getByRole('radiogroup', { name: 'transition alignment' });
    expect(group).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Start at cut' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('moves the ramp, writing the alignment onto the transition', () => {
    open({ kind: 'cross-dissolve' });
    fireEvent.click(screen.getByRole('radio', { name: 'Centre on cut' }));
    expect(latestParams.alignment).toBe('centre');
  });

  it('drops the alignment key again when it goes back to the default', () => {
    // An absent key and a stored `start` render identically today; only the absent
    // one keeps doing so if the default is ever revisited.
    open({ kind: 'cross-dissolve', alignment: 'centre' });
    fireEvent.click(screen.getByRole('radio', { name: 'Start at cut' }));
    expect(latestParams).not.toHaveProperty('alignment');
  });
});

describe('the duration ceiling', () => {
  it('states the limit rather than only enforcing it', () => {
    // A slider that simply stops has the user wondering whether the app is broken.
    open({ kind: 'cross-dissolve' });
    expect(screen.getByText(/This cut can carry up to/)).toBeTruthy();
  });
});

describe('the audio across the cut', () => {
  const audioOn = (clipId: string) =>
    (latestClips ?? []).find((c) => c.id === clipId)?.effects.find((e) => e.type === 'audio_gain')
      ?.params;

  it('is a hard cut until asked otherwise', () => {
    open({ kind: 'cross-dissolve' });
    expect(screen.getByRole('combobox', { name: 'transition audio' })).toBeTruthy();
    expect(audioOn('c1')).toBeUndefined();
    expect(audioOn('c2')).toBeUndefined();
  });

  it('writes paired fades on both clips, matching the video duration', () => {
    open({ kind: 'cross-dissolve' });
    chooseOption('transition audio', 'Crossfade');
    expect(latestParams.audio).toBe('crossfade');
    expect(audioOn('c1')?.fadeOutSeconds).toBe(1);
    expect(audioOn('c2')?.fadeInSeconds).toBe(1);
  });

  it('carries the curve the mode needs', () => {
    // Linear gain on two clips sums to a dip; equal power is what stops a music
    // crossfade sounding like a hole.
    open({ kind: 'cross-dissolve' });
    chooseOption('transition audio', 'Equal power');
    expect(audioOn('c1')?.fadeCurve).toBe('equal-power');
    expect(audioOn('c2')?.fadeCurve).toBe('equal-power');
  });

  it('takes the fades back off again', () => {
    open({ kind: 'cross-dissolve' });
    chooseOption('transition audio', 'Crossfade');
    chooseOption('transition audio', 'Hard cut');
    expect(latestParams).not.toHaveProperty('audio');
    expect(audioOn('c1')?.fadeOutSeconds).toBe(0);
    expect(audioOn('c2')?.fadeInSeconds).toBe(0);
  });
});

describe('saving a preset', () => {
  it('keeps everything tuned except the cut it was tuned on', () => {
    for (const key of TRANSITION_LIBRARY_STORAGE_KEYS) localStorage.removeItem(key);
    open({ kind: 'push', intensity: 0.4, direction: 'down' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
    fireEvent.change(screen.getByLabelText('preset name'), { target: { value: 'My push' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const saved = JSON.parse(localStorage.getItem('framepilot.transitions.presets') ?? '[]');
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('My push');
    expect(saved[0].kind).toBe('push');
    expect(saved[0].params.intensity).toBe(0.4);
    expect(saved[0].params.direction).toBe('down');
    // `fromClipId` is about THIS cut and is worse than meaningless anywhere else.
    expect(saved[0].params).not.toHaveProperty('fromClipId');
  });

  it('names an unnamed preset after the transition it came from', () => {
    for (const key of TRANSITION_LIBRARY_STORAGE_KEYS) localStorage.removeItem(key);
    open({ kind: 'push' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const saved = JSON.parse(localStorage.getItem('framepilot.transitions.presets') ?? '[]');
    expect(saved[0].name).toBe('Push Left (mine)');
  });
});

describe('comparing with and without', () => {
  it('holds the transition off without losing anything it carries', () => {
    open({ kind: 'push', intensity: 0.4, direction: 'down' });
    fireEvent.click(screen.getByRole('button', { name: 'Compare without' }));
    expect(latestParams.disabled).toBe(true);
    // Every tuned value survives, so turning it back on is not a re-decision.
    expect(latestParams.kind).toBe('push');
    expect(latestParams.intensity).toBe(0.4);
    expect(latestParams.direction).toBe('down');
  });

  it('puts it back, leaving no trace of the comparison', () => {
    open({ kind: 'push' });
    fireEvent.click(screen.getByRole('button', { name: 'Compare without' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show transition' }));
    expect(latestParams).not.toHaveProperty('disabled');
  });
});
