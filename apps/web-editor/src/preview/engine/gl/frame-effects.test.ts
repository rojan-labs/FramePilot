import { describe, expect, it } from 'vitest';
import { hashU32, noise01Cpu } from './frame-effects.js';

describe('frame effect noise (render/frame_effects/deterministic.py values)', () => {
  it('hashes and derives white noise bit-identically to numpy', () => {
    expect(hashU32(12345)).toBe(2435775735);
    expect(noise01Cpu(0, 0, 5, 7)).toBe(0.1457456350326538);
    expect(noise01Cpu(3, 11, 123456, 51)).toBe(0.5628499388694763);
    // value_noise01 at the origin is the corner sample: light-leak's drift.
    expect(noise01Cpu(0, 0, Math.floor(40 / 12), 0)).toBe(0.022319138050079346);
  });
});
