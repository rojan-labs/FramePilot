import { describe, expect, it } from 'vitest';
import { rotateI420, type I420Picture } from './decoded-picture.js';

const picture = (): I420Picture => ({
  kind: 'i420',
  width: 4,
  height: 2,
  // 0 1 2 3
  // 4 5 6 7
  y: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
  u: Uint8Array.from([10, 11]),
  v: Uint8Array.from([20, 21]),
  matrix: 'bt709',
  fullRange: false,
  byteLength: 12,
});

describe('rotateI420 (ffmpeg autorotate, clockwise)', () => {
  it('turns a picture a quarter clockwise: the bottom-left comes to the top-left', () => {
    const turned = rotateI420(picture(), 90);
    expect([turned.width, turned.height]).toEqual([2, 4]);
    expect([...turned.y]).toEqual([4, 0, 5, 1, 6, 2, 7, 3]);
    expect([...turned.u]).toEqual([10, 11]);
  });

  it('turns counter-clockwise for 270 and half-turns for 180', () => {
    expect([...rotateI420(picture(), 270).y]).toEqual([3, 7, 2, 6, 1, 5, 0, 4]);
    expect([...rotateI420(picture(), 180).y]).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(rotateI420(picture(), 0).y).toEqual(picture().y);
  });
});
