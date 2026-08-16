/**
 * On-canvas transform on the PROGRAM MONITOR (revamp Phase 3).
 *
 * This monitor had no canvas manipulation at all: the select-hit and transform box
 * lived on `PreviewPlayer`, so when WebCodecs became the canvas program-monitor engine
 * the affordance silently left the product. These cases pin the wiring so it cannot
 * leave again.
 *
 * jsdom has no `VideoDecoder`/`AudioContext`, so the compositor itself never starts
 * — the monitor renders its in-place error instead, which is the correct behaviour
 * and does not affect the DOM under test. Pixels are an e2e concern; this is about
 * whether the handles appear for the right clip and commit the right patch.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Timeline } from '@framepilot/timeline-schema';
import { useEditor } from '../editor/useEditor.js';
import { SettingsProvider } from '../editor/useSettings.js';
import { WebCodecsPreviewPlayer } from './WebCodecsPreviewPlayer.js';

const RESOLUTION = { width: 1000, height: 2000 };

const clip = (id: string, start: number, end: number) => ({
  id,
  assetId: 'a',
  trackId: 'v',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const timeline: Timeline = {
  tracks: [{ id: 'v', type: 'video', clips: [clip('c1', 0, 4), clip('c2', 4, 8)] }],
};

const timelineWithText: Timeline = {
  tracks: [
    ...timeline.tracks,
    {
      id: 'overlay',
      type: 'video',
      clips: [
        {
          ...clip('text_1', 0, 4),
          assetId: '__text__',
          trackId: 'overlay',
          effects: [
            {
              id: 'text_effect',
              type: 'text',
              params: { text: 'Title', xPercent: 50, yPercent: 40, boxWidthPercent: 60 },
              keyframes: [],
            },
          ],
        },
      ],
    },
  ],
};

const assets = [{ id: 'a', path: 'blob:a', kind: 'video' as const, durationSeconds: 8 }];

function Host({
  editorTimeline = timeline,
}: { readonly editorTimeline?: Timeline } = {}): JSX.Element {
  const editor = useEditor(editorTimeline, ['a']);
  return (
    <SettingsProvider>
      <button type="button" onClick={() => editor.select('c1')}>
        select c1
      </button>
      <button type="button" onClick={() => editor.select('c2')}>
        select c2
      </button>
      <button type="button" onClick={() => editor.select('text_1')}>
        select text
      </button>
      <button type="button" onClick={() => editor.select(null)}>
        deselect
      </button>
      <button type="button" onClick={() => editor.seek(5)}>
        seek 5
      </button>
      <span data-testid="kf">
        {JSON.stringify(editor.state.timeline.tracks[0]!.clips[0]!.keyframes)}
      </span>
      <span data-testid="selection">{editor.state.selection ?? 'none'}</span>
      <WebCodecsPreviewPlayer editor={editor} assets={assets} fps={30} resolution={RESOLUTION} />
    </SettingsProvider>
  );
}

const box = () => screen.queryByRole('group', { name: 'Transform selected clip' });

describe('program monitor — on-canvas transform', () => {
  it('offers a click-to-select hit target over the shown picture', () => {
    render(<Host />);
    // The route into the handles for a user who has not touched the timeline.
    const hit = screen.getByLabelText('select clip c1 in preview');
    expect(box()).toBeNull();
    fireEvent.click(hit);
    expect(box()).not.toBeNull();
  });

  it('replaces the hit target with the box once selected, so they cannot fight', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select c1' }));
    expect(box()).not.toBeNull();
    expect(screen.queryByLabelText('select clip c1 in preview')).toBeNull();
  });

  it('shows the handles ONLY for the clip the monitor is displaying', () => {
    // A box framing a clip the monitor is not showing would point at nothing.
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select c2' }));
    expect(box()).toBeNull();
    // Move the playhead onto c2 and the same selection now has handles.
    fireEvent.click(screen.getByRole('button', { name: 'seek 5' }));
    expect(box()).not.toBeNull();
  });

  it('withdraws the handles when the selection is cleared', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select c1' }));
    expect(box()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'deselect' }));
    expect(box()).toBeNull();
  });

  it('mirrors a timeline-selected text object into visible on-canvas selection chrome', () => {
    const { container } = render(<Host editorTimeline={timelineWithText} />);
    fireEvent.click(screen.getByRole('button', { name: 'select text' }));

    expect(screen.getByRole('group', { name: 'edit text overlay' })).toBeTruthy();
    expect(container.querySelector('.preview-text-edit')).not.toBeNull();
    expect(box()).toBeNull();
  });

  it('single-clicks through a text object to the background and double-clicks to select it', () => {
    render(<Host editorTimeline={timelineWithText} />);
    const objectHit = screen.getByRole('button', { name: 'select text overlay text_1 in preview' });

    fireEvent.click(objectHit);
    expect(screen.getByTestId('selection').textContent).toBe('c1');

    fireEvent.doubleClick(
      screen.getByRole('button', { name: 'select text overlay text_1 in preview' }),
    );
    expect(screen.getByTestId('selection').textContent).toBe('text_1');
    expect(screen.getByRole('group', { name: 'edit text overlay' })).toBeTruthy();
  });

  it('lets keyboard users select a preview object without a double-click gesture', () => {
    render(<Host editorTimeline={timelineWithText} />);
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'select text overlay text_1 in preview' }),
      {
        key: 'Enter',
      },
    );
    expect(screen.getByTestId('selection').textContent).toBe('text_1');
  });

  it('exposes rotation and resize handles plus reset', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select c1' }));
    expect(screen.getByRole('slider', { name: 'Rotate clip' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Resize handle se' })).toBeTruthy();
    expect(screen.getByLabelText('reset clip transform')).toBeTruthy();
  });

  it('commits a drag as ONE patch of time-0 transform keyframes', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'select c1' }));
    const group = box() as HTMLElement;
    const frame = container.querySelector('.preview-frame') as HTMLElement;
    const rect = { left: 0, top: 0, width: 500, height: 1000, right: 500, bottom: 1000 } as DOMRect;
    frame.getBoundingClientRect = () => rect;
    group.getBoundingClientRect = () => rect;

    // 100px right on a 500px-wide frame over a 1000-wide project = 200 project px.
    // Well past the snap tolerance, so it commits unsnapped.
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 500 });
    fireEvent.pointerMove(group, { pointerId: 1, clientX: 200, clientY: 500 });
    fireEvent.pointerUp(group, { pointerId: 1, clientX: 200, clientY: 500 });

    const keyframes = JSON.parse(screen.getByTestId('kf').textContent ?? '[]') as {
      time: number;
      property: string;
      value: number;
    }[];
    // Every handle-writable property, all at time 0 — the base transform.
    expect(keyframes.every((k) => k.time === 0)).toBe(true);
    expect(keyframes.find((k) => k.property === 'x')?.value).toBeCloseTo(200, 6);
    expect(keyframes.find((k) => k.property === 'y')?.value).toBe(0);
    expect(keyframes.find((k) => k.property === 'scale')?.value).toBe(1);
    // Rotation is written too, now that the preview can composite it.
    expect(keyframes.find((k) => k.property === 'rotation')?.value).toBe(0);
  });

  it('seeds the handles from the clip’s existing base transform', () => {
    const posed: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              ...clip('c1', 0, 4),
              keyframes: [
                { id: 'k1', time: 0, property: 'scale', value: 0.5, easing: 'linear' },
                { id: 'k2', time: 0, property: 'rotation', value: 30, easing: 'linear' },
              ],
            },
            clip('c2', 4, 8),
          ],
        },
      ],
    };
    render(<Host editorTimeline={posed} />);
    fireEvent.click(screen.getByRole('button', { name: 'select c1' }));
    // The box reflects the committed transform rather than starting at identity.
    expect(
      screen.getByRole('slider', { name: 'Resize handle se' }).getAttribute('aria-valuenow'),
    ).toBe('50');
    expect(screen.getByRole('slider', { name: 'Rotate clip' }).getAttribute('aria-valuenow')).toBe(
      '30',
    );
    expect((box() as HTMLElement).style.transform).toBe('rotate(-30deg)');
  });

  it('resets a posed clip back to identity in one patch', () => {
    const posed: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              ...clip('c1', 0, 4),
              keyframes: [{ id: 'k1', time: 0, property: 'scale', value: 0.5, easing: 'linear' }],
            },
          ],
        },
      ],
    };
    render(<Host editorTimeline={posed} />);
    fireEvent.click(screen.getByRole('button', { name: 'select c1' }));
    fireEvent.click(screen.getByLabelText('reset clip transform'));
    const keyframes = JSON.parse(screen.getByTestId('kf').textContent ?? '[]') as {
      property: string;
      value: number;
    }[];
    expect(keyframes.find((k) => k.property === 'scale')?.value).toBe(1);
    expect(keyframes.find((k) => k.property === 'x')?.value).toBe(0);
    expect(keyframes.find((k) => k.property === 'rotation')?.value).toBe(0);
  });
});
