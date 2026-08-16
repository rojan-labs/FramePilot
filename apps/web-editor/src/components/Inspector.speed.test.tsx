/**
 * The speed inspector (revamp Phase 10c, F8) — reverse, freeze, duration-driven
 * speed, and the rule the whole panel turns on: **the resulting duration is shown
 * before the commit**, not discovered afterwards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { Inspector } from './Inspector.js';

afterEach(() => localStorage.clear());

/** A 10s clip consuming 10s of source — 1x, so a speed change visibly moves `end`. */
const baseClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  assetId: 'a',
  trackId: 'v',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
  ...overrides,
});

const timelineWith = (clip: Clip): Timeline => ({
  tracks: [{ id: 'v', type: 'video', clips: [clip] }],
});

/** The clip as the store currently holds it. */
let latest: Clip | undefined;

function Host({ timeline }: { readonly timeline: Timeline }): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  latest = editor.state.timeline.tracks[0]?.clips[0];
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.select('c1')}>
        pick
      </button>
      <span data-testid="history">{editor.history.entries.length}</span>
      <Inspector editor={editor} />
    </SettingsProvider>
  );
}

const open = (clip: Clip = baseClip()) => {
  render(<Host timeline={timelineWith(clip)} />);
  fireEvent.click(screen.getByRole('button', { name: 'pick' }));
  return within(screen.getByLabelText('clip speed'));
};

describe('reverse', () => {
  it('is a separate toggle, not a minus sign in the rate field', () => {
    // A user thinking "play this backwards" is not thinking about a sign, and a
    // stray minus in a scrub field would silently flip the clip.
    const speed = open();
    fireEvent.click(speed.getByRole('button', { name: 'Reverse' }));
    expect(latest?.speed).toBe(-1);
    expect(speed.getByRole('button', { name: 'Reverse' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps the clip the same length, because reverse is a direction not a rate', () => {
    const speed = open();
    fireEvent.click(speed.getByRole('button', { name: 'Reverse' }));
    expect(latest!.end - latest!.start).toBeCloseTo(10, 6);
  });

  it('combines with a rate preset, storing the signed product', () => {
    const speed = open();
    fireEvent.click(speed.getByRole('button', { name: 'Reverse' }));
    fireEvent.click(speed.getByRole('button', { name: '2x' }));
    expect(latest?.speed).toBe(-2);
    expect(latest!.end - latest!.start).toBeCloseTo(5, 6);
  });
});

describe('freeze frame', () => {
  it('sets speed 0 and leaves the clip its length', () => {
    // A held frame's length is SET, not derived — there is no duration to compute
    // from a division by zero, so the clip keeps the span it already occupied.
    const speed = open();
    fireEvent.click(speed.getByRole('button', { name: 'Freeze frame' }));
    expect(latest?.speed).toBe(0);
    expect(latest!.end - latest!.start).toBeCloseTo(10, 6);
  });

  it('says that a frozen clip renders silent, rather than letting it be discovered', () => {
    const speed = open();
    fireEvent.click(speed.getByRole('button', { name: 'Freeze frame' }));
    // Re-queried rather than reusing the bound `within`: the panel re-renders on
    // the patch, and the note is a node that did not exist when `open()` ran.
    expect(within(screen.getByLabelText('clip speed')).getByText(/render silent/)).toBeTruthy();
  });

  it('toggles back off to normal speed', () => {
    const speed = open();
    fireEvent.click(speed.getByRole('button', { name: 'Freeze frame' }));
    fireEvent.click(speed.getByRole('button', { name: 'Freeze frame' }));
    expect(latest?.speed).toBeUndefined();
  });
});

describe('the duration is shown before the commit', () => {
  it('previews the new length while the rate is still uncommitted', () => {
    // A speed control whose effect on the timeline you only learn by pressing it is
    // one you have to undo to understand.
    const speed = open();
    fireEvent.change(speed.getByLabelText('custom speed'), { target: { value: '2' } });
    expect(speed.getByText(/10\.00s → 5\.00s at 2x/)).toBeTruthy();
    // Still uncommitted: the timeline has not moved.
    expect(latest!.end - latest!.start).toBeCloseTo(10, 6);
  });

  it('states the committed length once applied', () => {
    const speed = open();
    fireEvent.change(speed.getByLabelText('custom speed'), { target: { value: '2' } });
    fireEvent.click(speed.getByRole('button', { name: 'Apply speed' }));
    expect(latest!.end - latest!.start).toBeCloseTo(5, 6);
    expect(speed.getByText(/Lasting 5\.00s at 2x/)).toBeTruthy();
  });
});

describe('duration-driven speed', () => {
  it('picks the rate that makes the clip last the requested time', () => {
    // The useful direction for "this shot needs to fill four seconds", and the one
    // a rate field cannot answer without arithmetic in the user's head.
    const speed = open();
    fireEvent.change(speed.getByLabelText('clip duration'), { target: { value: '4' } });
    expect(latest!.end - latest!.start).toBeCloseTo(4, 6);
    expect(latest?.speed).toBeCloseTo(2.5, 6);
  });

  it('preserves reverse — asking for a length is not asking to play forwards', () => {
    const speed = open();
    fireEvent.click(speed.getByRole('button', { name: 'Reverse' }));
    fireEvent.change(speed.getByLabelText('clip duration'), { target: { value: '5' } });
    expect(latest?.speed).toBeCloseTo(-2, 6);
  });
});

describe('a ramped clip', () => {
  const ramped = baseClip({
    end: 5,
    speedRamp: [
      { id: 'p1', sourceTime: 0, rate: 2, easing: 'linear' },
      { id: 'p2', sourceTime: 10, rate: 2, easing: 'linear' },
    ],
  });

  it('reports the curve instead of showing rate controls that would misreport it', () => {
    // Offering the constant controls here would let a stray click flatten a curve
    // the user built.
    const speed = open(ramped);
    expect(speed.getByText(/follows a speed ramp \(2 points\)/)).toBeTruthy();
    expect(speed.queryByLabelText('custom speed')).toBeNull();
    expect(speed.queryByRole('button', { name: '2x' })).toBeNull();
  });

  it('offers a way out, which restores the constant controls', () => {
    const speed = open(ramped);
    fireEvent.click(speed.getByRole('button', { name: 'Remove ramp' }));
    expect(latest?.speedRamp).toBeUndefined();
    expect(within(screen.getByLabelText('clip speed')).getByLabelText('custom speed')).toBeTruthy();
  });
});
