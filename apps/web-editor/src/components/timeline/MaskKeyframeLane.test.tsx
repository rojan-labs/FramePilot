/**
 * Mask keyframe lanes (MK4.3): one lane per animated mask, markers at the timeline position of
 * each source instant (through speed), dragged or nudged as one move_mask_keyframes command.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  masksOf,
  type Asset,
  type Clip,
  type Timeline,
} from '@framepilot/timeline-schema';
import { useEditor, type UseEditor } from '../../editor/useEditor.js';
import { MaskKeyframeLane } from './MaskKeyframeLane.js';
import { clipMaskLanes, isAnimated, trackKeyframeLanesHeight } from './keyframe-lanes.js';

const ASSETS: Asset[] = [
  {
    id: 'a1',
    path: 'a.mp4',
    kind: 'video',
    durationSeconds: 20,
    media: { width: 1920, height: 1080 },
  } as Asset,
];

const clipWithMask = (): Clip =>
  ({
    id: 'c1',
    assetId: 'a1',
    trackId: 'v1',
    start: 10,
    end: 14,
    sourceStart: 2,
    sourceEnd: 10,
    speed: 2,
    effects: [],
    keyframes: [],
    masks: [
      MaskLayerSchema.parse({
        kind: 'rectangle',
        id: 'm1',
        name: 'Face',
        cx: 1,
        cy: 1,
        width: 1,
        height: 1,
        keyframes: [
          { id: 'k1', sourceTime: 4, property: 'cx', value: 1 },
          { id: 'k2', sourceTime: 4, property: 'opacity', value: 1 },
          { id: 'k3', sourceTime: 8, property: 'cx', value: 5 },
        ],
      }),
    ],
  }) as unknown as Clip;

let editor: UseEditor;

function Host(): JSX.Element {
  const initial: Timeline = {
    revision: 0,
    tracks: [{ id: 'v1', type: 'video', clips: [clipWithMask()] }],
  } as Timeline;
  editor = useEditor(initial, { assets: ASSETS });
  const clip = editor.state.timeline.tracks[0]!.clips[0]!;
  const lane = clipMaskLanes(clip)[0]!;
  return (
    <MaskKeyframeLane
      editor={editor}
      clip={clip}
      lane={lane}
      row={0}
      pxPerSecond={100}
      fps={25}
      playheadClipTime={null}
    />
  );
}

describe('mask keyframe lanes', () => {
  it('groups a mask keyframes by instant and counts towards the track lane height', () => {
    const clip = clipWithMask();
    expect(clipMaskLanes(clip)).toEqual([
      {
        maskId: 'm1',
        name: 'Face',
        color: '#3b82f6',
        instants: [
          { sourceTime: 4, keyframeIds: ['k1', 'k2'], properties: ['cx', 'opacity'] },
          { sourceTime: 8, keyframeIds: ['k3'], properties: ['cx'] },
        ],
      },
    ]);
    expect(isAnimated(clip)).toBe(true);
    expect(
      trackKeyframeLanesHeight(
        { id: 'v1', type: 'video', clips: [clip] } as never,
        new Set(['c1']),
      ),
    ).toBe(12);
  });

  it('places markers through the clip speed and drags an instant as one command', () => {
    render(<Host />);
    const [first] = screen.getAllByRole('button');
    // Source 4 at 2× from source 2 is clip-local 1 s = 100 px.
    expect((first as HTMLElement).style.left).toBe('100px');
    fireEvent.pointerDown(first!, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(first!, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(first!, { clientX: 150, pointerId: 1 });
    const keyframes = masksOf(editor.state.timeline.tracks[0]!.clips[0]!)[0]!.keyframes;
    // +0.5 clip seconds at 2× is +1 source second.
    expect(
      keyframes
        .filter((keyframe) => keyframe.sourceTime === 5)
        .map((keyframe) => keyframe.id)
        .sort(),
    ).toEqual(['k1', 'k2']);
    expect(editor.history.entries).toHaveLength(1);
  });

  it('nudges one frame with the arrow keys', () => {
    render(<Host />);
    fireEvent.keyDown(screen.getAllByRole('button')[1]!, { key: 'ArrowLeft' });
    const moved = masksOf(editor.state.timeline.tracks[0]!.clips[0]!)[0]!.keyframes.find(
      (keyframe) => keyframe.id === 'k3',
    );
    expect(moved?.sourceTime).toBeCloseTo(8 - 2 / 25, 9);
  });
});
