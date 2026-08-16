/**
 * The keyframe diamond in place (revamp Phase 5, F5).
 *
 * `keyframe-state.test.ts` proves the state model; this proves the *affordance* —
 * that each state is rendered distinguishably and announced, that clicking toggles
 * the right way round, and above all that the Transform rows obey the phase's central
 * rule: **a static property moves its base, an animated one writes at the playhead.**
 * That branch is the difference between "I nudged scale" and "I accidentally
 * animated my clip", so it is asserted directly rather than left to the reader.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Keyframe, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../../editor/useEditor.js';
import { SettingsProvider } from '../../editor/useSettings.js';
import { Inspector } from '../Inspector.js';

afterEach(() => localStorage.clear());

const kf = (
  property: string,
  time: number,
  value: number,
  easing: Keyframe['easing'] = 'linear',
): Keyframe => ({ id: `${property}_${time}`, property, time, value, easing });

/** One 8s clip, optionally pre-animated. */
const timelineWith = (keyframes: readonly Keyframe[] = []): Timeline => ({
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        {
          id: 'c1',
          assetId: 'a',
          trackId: 'v',
          start: 0,
          end: 8,
          sourceStart: 0,
          sourceEnd: 8,
          effects: [],
          keyframes: [...keyframes],
        },
      ],
    },
  ],
});

function Host({
  timeline,
  at = 0,
}: {
  readonly timeline: Timeline;
  /** Where to put the playhead before the assertions run. */
  readonly at?: number;
}): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.select('c1')}>
        pick
      </button>
      <button type="button" onClick={() => editor.seek(at)}>
        seek
      </button>
      <span data-testid="playhead">{editor.state.playhead}</span>
      <span data-testid="history">{editor.history.entries.length}</span>
      <span data-testid="keyframes">
        {clip.keyframes
          .slice()
          .sort((a, b) => a.property.localeCompare(b.property) || a.time - b.time)
          .map((k) => `${k.property}@${k.time}=${k.value}`)
          .join(' ')}
      </span>
      <Inspector editor={editor} />
    </SettingsProvider>
  );
}

/** Select the clip and put the playhead where the case needs it. */
const setup = (timeline: Timeline, at = 0) => {
  const view = render(<Host timeline={timeline} at={at} />);
  fireEvent.click(screen.getByRole('button', { name: 'pick' }));
  fireEvent.click(screen.getByRole('button', { name: 'seek' }));
  return view;
};

const keyframes = (): string => screen.getByTestId('keyframes').textContent ?? '';
const historyLength = (): number => Number(screen.getByTestId('history').textContent);

describe('Transform rows exist at all', () => {
  it('renders a value field for every property the render composites', () => {
    setup(timelineWith());
    // The real F5 gap: before this phase the inspector had NO transform fields —
    // only a keyframe dump and two forms. There was nowhere to read a clip's scale.
    for (const property of ['scale', 'x', 'y', 'rotation', 'opacity']) {
      expect(screen.getByLabelText(property)).toBeTruthy();
    }
  });

  it('retires the standalone add-keyframe form', () => {
    setup(timelineWith());
    expect(document.querySelector('[aria-label="add-keyframe"]')).toBeNull();
    expect(screen.queryByLabelText('keyframe property')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add keyframe' })).toBeNull();
  });

  it('keeps the punch-in preset, which is a different thing from a keyframe form', () => {
    setup(timelineWith());
    expect(document.querySelector('[aria-label="punch-in"]')).toBeTruthy();
  });
});

describe('the diamond states', () => {
  it('reads `none` for an un-animated property', () => {
    setup(timelineWith());
    const button = screen.getByRole('button', { name: /animate scale/i });
    expect(button.getAttribute('data-status')).toBe('none');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('reads `at-playhead` when a keyframe sits under the playhead', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 4);
    const button = screen.getByRole('button', { name: /remove scale keyframe/i });
    expect(button.getAttribute('data-status')).toBe('at-playhead');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('reads `animated` between keyframes and warns before the commit', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 2);
    const button = screen.getByRole('button', { name: /add scale keyframe/i });
    expect(button.getAttribute('data-status')).toBe('animated');
    expect(button.getAttribute('data-will-create')).toBe('true');
    // Stated in words, not only as a glyph — an em-dash-style hint conveys nothing
    // to a screen reader.
    expect(screen.getByText('editing scale here will add a keyframe')).toBeTruthy();
  });

  it('does not warn when a keyframe is already under the playhead', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 4);
    expect(screen.queryByText('editing scale here will add a keyframe')).toBeNull();
  });

  it('shows the curve value at the playhead, not the base value', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 2);
    // Halfway through a 1→2 linear ramp. Showing 1 here would disagree with the
    // picture in the monitor.
    expect((screen.getByLabelText('scale') as HTMLInputElement).value).toBe('1.5');
  });
});

describe('clicking the diamond', () => {
  it('adds a keyframe at the playhead pinning the CURRENT value', () => {
    setup(timelineWith(), 3);
    fireEvent.click(screen.getByRole('button', { name: /animate scale/i }));
    // Pins 1 (the identity base) at 3s — clicking the diamond records where the
    // picture is, it never moves it.
    expect(keyframes()).toBe('scale@3=1');
  });

  it('removes the keyframe under the playhead', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 4);
    fireEvent.click(screen.getByRole('button', { name: /remove scale keyframe/i }));
    expect(keyframes()).toBe('scale@0=1');
  });

  it('is one undo step either way', () => {
    setup(timelineWith(), 3);
    const before = historyLength();
    fireEvent.click(screen.getByRole('button', { name: /animate scale/i }));
    expect(historyLength()).toBe(before + 1);
  });
});

describe('the chevrons navigate without editing', () => {
  it('seeks to the neighbouring keyframe in TIMELINE time', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 0);
    const before = historyLength();
    fireEvent.click(screen.getByRole('button', { name: 'next scale keyframe' }));
    // Clip starts at 0 here, so clip-relative 4 is timeline 4.
    expect(screen.getByTestId('playhead').textContent).toBe('4');
    // Navigation is not an edit.
    expect(historyLength()).toBe(before);
  });

  it('disables the chevron with nowhere to go', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 0);
    expect(
      (screen.getByRole('button', { name: 'previous scale keyframe' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'next scale keyframe' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('editing a value — the rule the phase turns on', () => {
  it('moves the BASE when the property is not animated, whatever the playhead', () => {
    setup(timelineWith(), 5);
    fireEvent.change(screen.getByLabelText('scale'), { target: { value: '1.5' } });
    // Time 0, NOT 5. Nudging a static property at a scrubbed playhead must not
    // silently start an animation.
    expect(keyframes()).toBe('scale@0=1.5');
  });

  it('writes AT THE PLAYHEAD when the property is animated', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 2);
    fireEvent.change(screen.getByLabelText('scale'), { target: { value: '3' } });
    expect(keyframes()).toBe('scale@0=1 scale@2=3 scale@4=2');
  });

  it('rewrites in place when a keyframe is already under the playhead', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 4);
    fireEvent.change(screen.getByLabelText('scale'), { target: { value: '3' } });
    expect(keyframes()).toBe('scale@0=1 scale@4=3');
  });

  it('leaves other properties untouched', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 2);
    fireEvent.change(screen.getByLabelText('opacity'), { target: { value: '0.5' } });
    expect(keyframes()).toBe('opacity@0=0.5 scale@0=1 scale@4=2');
  });
});

describe('resetting a property', () => {
  it('clears the animation as well as the base, in one patch', () => {
    setup(timelineWith([kf('scale', 0, 1.5), kf('scale', 4, 2)]), 0);
    const before = historyLength();
    fireEvent.click(screen.getByRole('button', { name: 'reset scale' }));
    // Leaving a curve behind would make the reset appear not to have worked as soon
    // as the playhead moved.
    expect(keyframes()).toBe('');
    expect(historyLength()).toBe(before + 1);
  });

  it('offers no reset on a property that is already at its identity', () => {
    setup(timelineWith());
    expect(screen.queryByRole('button', { name: 'reset scale' })).toBeNull();
  });

  it('offers a reset on an animated property even when its base is the identity', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('scale', 4, 2)]), 0);
    expect(screen.getByRole('button', { name: 'reset scale' })).toBeTruthy();
  });
});

describe('the animated-properties summary', () => {
  it('names what is moving, and nothing when nothing is', () => {
    setup(timelineWith([kf('scale', 0, 1), kf('opacity', 2, 0.5)]));
    expect(screen.getByLabelText('animated properties').textContent).toBe(
      'Animated: scale, opacity',
    );
  });

  it('is absent for a still clip', () => {
    setup(timelineWith());
    expect(screen.queryByLabelText('animated properties')).toBeNull();
  });
});
