import { describe, expect, it } from 'vitest';
import type { Clip } from '@framepilot/timeline-schema';
import { clipSpeedBadge } from './clip-speed-badge.js';

type SpeedFields = Pick<Clip, 'speed' | 'speedRamp'>;

const ramp: NonNullable<Clip['speedRamp']> = [
  { id: 'p1', sourceTime: 0, rate: 1, easing: 'linear' },
  { id: 'p2', sourceTime: 2, rate: 3, easing: 'linear' },
] as NonNullable<Clip['speedRamp']>;

describe('clipSpeedBadge', () => {
  it('draws nothing for a clip at normal speed, stored or defaulted', () => {
    expect(clipSpeedBadge({})).toBeNull();
    expect(clipSpeedBadge({ speed: 1 })).toBeNull();
  });

  it.each<[SpeedFields, string, string]>([
    [{ speed: 2 }, '2×', 'Speed 2×'],
    [{ speed: 1.3 }, '1.3×', 'Speed 1.3×'],
    [{ speed: 0.25 }, '0.25×', 'Speed 0.25×'],
    // Float noise from a duration-driven rate is not printed.
    [{ speed: 1.3333333 }, '1.33×', 'Speed 1.33×'],
  ])('shows the rate for %o', (clip, text, title) => {
    expect(clipSpeedBadge(clip)).toEqual({ text, title });
  });

  it('spells out reverse instead of printing a minus sign', () => {
    expect(clipSpeedBadge({ speed: -1 })).toEqual({ text: 'Rev 1×', title: 'Speed 1×, reversed' });
    expect(clipSpeedBadge({ speed: -2 })).toEqual({ text: 'Rev 2×', title: 'Speed 2×, reversed' });
  });

  it('names a freeze frame', () => {
    expect(clipSpeedBadge({ speed: 0 })).toEqual({ text: 'Freeze', title: 'Freeze frame' });
  });

  it('prefers the ramp over the constant rate, which no longer describes the clip', () => {
    expect(clipSpeedBadge({ speed: 1, speedRamp: ramp })).toEqual({
      text: 'Ramp',
      title: 'Speed ramp',
    });
    // An empty curve is not a ramp.
    expect(clipSpeedBadge({ speed: 2, speedRamp: [] })).toEqual({ text: '2×', title: 'Speed 2×' });
  });
});
