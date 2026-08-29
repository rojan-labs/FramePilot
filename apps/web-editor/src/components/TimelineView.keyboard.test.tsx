/**
 * Keyboard reachability of the timeline (P8.5 G1/G2/G7/G13).
 *
 * Three things are asserted here that the pointer tests cannot see: the clips are
 * ONE tab stop rather than one per clip, everything inside a clip is reached from
 * the clip's own keydown instead of from the tab ring, and the fade handles —
 * which have announced themselves as sliders since H8 — actually respond to the
 * arrows instead of letting them fall through to the playhead.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { TimelineView } from './TimelineView.js';

/** Two wide video clips on one track, plus an animated one to expose the lanes toggle. */
const timeline: Timeline = {
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
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [{ id: 'kf1', time: 1, property: 'opacity', value: 0.5, easing: 'linear' }],
        },
        {
          id: 'c2',
          assetId: 'a',
          trackId: 'v',
          start: 4,
          end: 8,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

const audioTimeline: Timeline = {
  tracks: [
    {
      id: 'a1',
      type: 'audio',
      clips: [
        {
          id: 'c1',
          assetId: 'snd',
          trackId: 'a1',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

function Host(): JSX.Element {
  const editor = useEditor(timeline, ['a']);
  return <TimelineView editor={editor} assets={[]} fps={30} />;
}

function AudioHost(): JSX.Element {
  const editor = useEditor(audioTimeline, ['snd']);
  return (
    <TimelineView
      editor={editor}
      assets={[{ id: 'snd', path: 'media/song.mp3', kind: 'audio' }]}
      fps={30}
    />
  );
}

const clip = (id: string): HTMLElement => screen.getByLabelText(`clip ${id}`);
const fadeInWidth = (): string =>
  (clip('c1').querySelector('.clip-fade-overlay-in') as HTMLElement).style.width;

describe('timeline keyboard reachability', () => {
  it('gives the clips one tab stop, and it rides the selection', () => {
    render(<Host />);
    // Nothing selected: the first clip in timeline order holds the stop, so the
    // timeline is reachable at all before anything is clicked.
    expect(clip('c1').tabIndex).toBe(0);
    expect(clip('c2').tabIndex).toBe(-1);

    fireEvent.click(clip('c2'));
    expect(clip('c1').tabIndex).toBe(-1);
    expect(clip('c2').tabIndex).toBe(0);
  });

  it('keeps every control inside a clip out of the tab ring', () => {
    render(<Host />);
    const c1 = clip('c1');
    expect((c1.querySelector('.clip-menu-btn') as HTMLElement).tabIndex).toBe(-1);
    expect((c1.querySelector('.clip-lanes-toggle') as HTMLElement).tabIndex).toBe(-1);
  });

  it('opens the clip menu with Shift+F10 on the focused clip', () => {
    render(<Host />);
    fireEvent.keyDown(clip('c1'), { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: 'clip actions' })).toBeDefined();
  });

  it('toggles the keyframe lanes with D on the focused clip', () => {
    render(<Host />);
    const toggle = clip('c1').querySelector('.clip-lanes-toggle') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(clip('c1'), { key: 'd' });
    expect(
      (clip('c1').querySelector('.clip-lanes-toggle') as HTMLElement).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('describes a clip by its visible name while its label stays the id', () => {
    render(<Host />);
    const label = clip('c1').querySelector('.clip-label') as HTMLElement;
    expect(clip('c1').getAttribute('aria-describedby')).toBe(label.id);
    expect(label.id).toBe('c1-label');
  });
});

describe('fade handle keyboard', () => {
  it('is out of the tab ring and is entered with F from the clip', () => {
    render(<AudioHost />);
    const handle = clip('c1').querySelector('.clip-fade-handle-in') as HTMLElement;
    expect(handle.tabIndex).toBe(-1);
    fireEvent.keyDown(clip('c1'), { key: 'f' });
    expect(document.activeElement).toBe(handle);
  });

  it('adjusts the fade with the arrows, Shift+arrow and End', () => {
    render(<AudioHost />);
    const handle = clip('c1').querySelector('.clip-fade-handle-in') as HTMLElement;
    expect(fadeInWidth()).toBe('0px');

    // Shift+Arrow is the coarse step: +0.5s ⇒ 20px at the 40px/s test zoom.
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(fadeInWidth()).toBe('20px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(fadeInWidth()).toBe('0px');

    // End goes to the cap, which is the clip's own length when that is shorter
    // than FADE_MAX_SECONDS (4s here, 160px).
    fireEvent.keyDown(handle, { key: 'End' });
    expect(fadeInWidth()).toBe('160px');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(fadeInWidth()).toBe('0px');
  });

  it('grows the out fade leftwards, the way its drag does', () => {
    render(<AudioHost />);
    const handle = clip('c1').querySelector('.clip-fade-handle-out') as HTMLElement;
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect((clip('c1').querySelector('.clip-fade-overlay-out') as HTMLElement).style.width).toBe(
      '20px',
    );
  });

  it('returns focus to the clip on Escape', () => {
    render(<AudioHost />);
    const handle = clip('c1').querySelector('.clip-fade-handle-in') as HTMLElement;
    handle.focus();
    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(document.activeElement).toBe(clip('c1'));
  });
});
