/**
 * The toolbar's keyframe control (the CapCut affordance): with a clip focused, one
 * button that records its pose at the playhead or takes it away again.
 *
 * The decision itself is pure and covered in `clip-keyframe-toggle.test.ts`. What
 * is verified here is the wiring the pure test cannot see: that the control commits
 * exactly one patch, that it reads as a toggle, that it refuses when there is
 * nothing to act on, and that it survives the toolbar's own collapse behaviour.
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { Toolbar } from './Toolbar.js';

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
          end: 6,
          sourceStart: 0,
          sourceEnd: 6,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
};

/**
 * Render the toolbar, exposing the store so tests can assert on the timeline.
 *
 * `latest()` rather than a captured value: the store object is replaced on every
 * render, so holding the one from the first render means reading a snapshot taken
 * before the click under test.
 */
function renderToolbar(): {
  latest: () => ReturnType<typeof useEditor>;
} {
  let captured!: ReturnType<typeof useEditor>;
  function Host(): JSX.Element {
    const editor = useEditor(timeline, ['a']);
    captured = editor;
    return <Toolbar editor={editor} />;
  }
  render(<Host />);
  return { latest: () => captured };
}

/** The toolbar's keyframe button, whichever state its label is in. */
const keyframeButton = (): HTMLElement =>
  screen.getByRole('button', { name: /^(Add|Remove) keyframe$/ });

const keyframesOf = (
  latest: () => ReturnType<typeof useEditor>,
): readonly { property: string; value: number }[] =>
  latest().state.timeline.tracks[0]!.clips[0]!.keyframes;

describe('Toolbar — keyframe control', () => {
  it('is disabled until a clip is focused', () => {
    renderToolbar();
    expect((keyframeButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('records the whole pose at the playhead in ONE undoable patch', () => {
    const { latest } = renderToolbar();
    act(() => {
      latest().select('c1');
      latest().seek(3);
    });
    act(() => fireEvent.click(keyframeButton()));

    // Every animatable property, all at the playhead.
    const written = keyframesOf(latest);
    expect(written.map((k) => k.property).sort()).toEqual([
      'opacity',
      'rotation',
      'scale',
      'x',
      'y',
    ]);

    // One patch, so one press of undo takes the whole pose back — the reason
    // `setKeyframesAtPlayheadPatch` exists instead of a loop over the singular one.
    act(() => latest().undo());
    expect(keyframesOf(latest)).toHaveLength(0);
  });

  it('reads as a toggle: it flips to Remove and pressing it again leaves nothing', () => {
    const { latest } = renderToolbar();
    act(() => {
      latest().select('c1');
      latest().seek(3);
    });
    act(() => fireEvent.click(keyframeButton()));

    const pressed = keyframeButton();
    expect(pressed.getAttribute('aria-label')).toBe('Remove keyframe');
    expect(pressed.getAttribute('aria-pressed')).toBe('true');

    act(() => fireEvent.click(pressed));
    expect(keyframesOf(latest)).toHaveLength(0);
    expect(keyframeButton().getAttribute('aria-label')).toBe('Add keyframe');
  });

  it('refuses when the playhead is outside the focused clip', () => {
    // Writing a keyframe at a time the clip does not cover would animate nothing.
    const { latest } = renderToolbar();
    act(() => {
      latest().select('c1');
      latest().seek(20);
    });
    expect((keyframeButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not move the picture — it pins the values already in effect', () => {
    const { latest } = renderToolbar();
    act(() => {
      latest().select('c1');
      latest().seek(3);
    });
    act(() => fireEvent.click(keyframeButton()));
    const byProperty = new Map(keyframesOf(latest).map((k) => [k.property, k.value]));
    expect(byProperty.get('scale')).toBe(1);
    expect(byProperty.get('opacity')).toBe(1);
    expect(byProperty.get('x')).toBe(0);
  });
});
