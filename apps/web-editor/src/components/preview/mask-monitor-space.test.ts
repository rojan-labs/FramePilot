import { describe, expect, it } from 'vitest';
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { applyAffine, monitorPictureSpace } from './mask-monitor-space.js';

const FRAME = { width: 1280, height: 720 } as const;
const ASSETS: readonly Asset[] = [
  {
    id: 'land',
    path: 'land.mp4',
    kind: 'video',
    durationSeconds: 20,
    media: { width: 1920, height: 1080 },
  },
];

const kf = (property: string, value: number) =>
  ({ id: property, time: 0, property, value, easing: 'linear' }) as const;

function space(keyframes: Clip['keyframes'], crop?: Clip['crop']) {
  const clip: Clip = {
    id: 'c',
    assetId: 'land',
    trackId: 'v',
    start: 0,
    end: 4,
    sourceStart: 0,
    sourceEnd: 4,
    effects: [],
    keyframes,
    ...(crop ? { crop } : {}),
  };
  const timeline: Timeline = { tracks: [{ id: 'v', type: 'video', clips: [clip] }] };
  return monitorPictureSpace(timeline, ASSETS, 1, FRAME, 'c');
}

describe('monitorPictureSpace', () => {
  it('maps a stretched, cropped picture onto the box the frame plan draws', () => {
    const map = space([kf('scale', 0.5), kf('scaleX', 2), kf('scaleY', 0.5), kf('x', 40)], {
      x: 0.25,
      y: 0,
      width: 0.5,
      height: 1,
    });
    expect(map).not.toBeNull();
    // The 960x1080 crop fits 720 high (base 2/3) as 640x720; × 0.5 = 320x360; stretched, 640x180.
    const topLeft = applyAffine(map!.toFrame, { x: 480, y: 0 });
    const bottomRight = applyAffine(map!.toFrame, { x: 1440, y: 1080 });
    expect(topLeft.x).toBeCloseTo(640 + 40 - 320, 9);
    expect(topLeft.y).toBeCloseTo(360 - 90, 9);
    expect(bottomRight.x).toBeCloseTo(640 + 40 + 320, 9);
    expect(bottomRight.y).toBeCloseTo(360 + 90, 9);
    expect(map!.crop).toMatchObject({ x: 480, width: 960, height: 1080 });
    // The inverse takes the pointer back to the same source pixel.
    const back = applyAffine(map!.toSource, bottomRight);
    expect(back.x).toBeCloseTo(1440, 9);
    expect(back.y).toBeCloseTo(1080, 9);
  });

  it('stretches in the picture axes before turning it', () => {
    const map = space([kf('scaleX', 2), kf('rotation', 90)]);
    // Unrotated, the source's right edge would sit 2 × 640 = 1280 px right of the centre; a
    // quarter turn anticlockwise (y-down screen) puts it that far above the centre instead.
    const right = applyAffine(map!.toFrame, { x: 1920, y: 540 });
    expect(right.x).toBeCloseTo(640, 9);
    expect(right.y).toBeCloseTo(360 - 1280, 9);
  });
});
