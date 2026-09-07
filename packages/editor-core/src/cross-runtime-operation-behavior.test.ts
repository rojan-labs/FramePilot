import { readFileSync } from 'node:fs';
import type { Timeline } from '@framepilot/timeline-schema';
import { describe, expect, it } from 'vitest';
import { applyOperation, type AnyOperation } from './operations.js';

interface BehaviorCase {
  readonly name: string;
  readonly operation: Record<string, unknown>;
  readonly expect: Record<string, unknown>;
}

interface BehaviorFixture {
  readonly timeline: Timeline;
  readonly cases: readonly BehaviorCase[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../test/fixtures/cross-runtime-operation-behavior.json', import.meta.url),
    'utf8',
  ),
) as BehaviorFixture;

const findClip = (timeline: Timeline, clipId: string) => {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
};

describe('cross-runtime operation behavior fixture', () => {
  for (const behavior of fixture.cases) {
    it(behavior.name, () => {
      const timeline = applyOperation(fixture.timeline, behavior.operation as AnyOperation);
      const expected = behavior.expect;

      if (Array.isArray(expected.clipIds)) {
        const track = timeline.tracks.find((candidate) => candidate.id === expected.trackId);
        expect(track?.clips.map((clip) => clip.id)).toEqual(expected.clipIds);
        if (typeof expected.boundary === 'number' && track) {
          expect(track.clips[0]?.end).toBe(expected.boundary);
          expect(track.clips[1]?.start).toBe(expected.boundary);
        }
        return;
      }

      if (typeof expected.clipId === 'string') {
        const located = findClip(timeline, expected.clipId);
        expect(located).toBeDefined();
        if (!located) return;
        // A speed CURVE is inverted numerically (bisection over a fixed-step
        // integral), so a case that crosses one states the slack it accepts rather
        // than demanding two languages land on the same last bit.
        const tolerance = typeof expected.tolerance === 'number' ? expected.tolerance : undefined;
        const expectTime = (actual: number | undefined, want: number): void => {
          if (tolerance === undefined) expect(actual).toBe(want);
          else expect(actual ?? Number.NaN).toBeCloseTo(want, -Math.log10(tolerance));
        };
        if (typeof expected.trackId === 'string') expect(located.track.id).toBe(expected.trackId);
        if (typeof expected.start === 'number') expectTime(located.clip.start, expected.start);
        if (typeof expected.end === 'number') expectTime(located.clip.end, expected.end);
        if (typeof expected.sourceStart === 'number')
          expectTime(located.clip.sourceStart, expected.sourceStart);
        if (typeof expected.sourceEnd === 'number')
          expectTime(located.clip.sourceEnd, expected.sourceEnd);
        if (typeof expected.speed === 'number') expect(located.clip.speed).toBe(expected.speed);
        // The re-based speed ramp: source times and rates, in order. A runtime that
        // leaves the original curve on a trimmed or split piece renders the wrong
        // speeds over the wrong footage and the validator rejects the patch.
        if (Array.isArray(expected.speedRamp)) {
          const points = (expected.speedRamp as { sourceTime: number; rate: number }[]).map(
            (point) => point,
          );
          expect(located.clip.speedRamp?.length).toBe(points.length);
          points.forEach((point, index) => {
            const actual = located.clip.speedRamp?.[index];
            expectTime(actual?.sourceTime, point.sourceTime);
            expectTime(actual?.rate, point.rate);
          });
        }
        if (expected.crop !== undefined) expect(located.clip.crop).toEqual(expected.crop);
        if (typeof expected.blendMode === 'string')
          expect(located.clip.blendMode).toBe(expected.blendMode);

        if (typeof expected.effectType === 'string') {
          const effect = located.clip.effects.find(
            (candidate) => candidate.type === expected.effectType,
          );
          expect(effect).toBeDefined();
          if (!effect) return;
          for (const key of [
            'text',
            'shape',
            'feather',
            'opacity',
            'gainDb',
            'fadeInSeconds',
            'muted',
            'kind',
            'durationSeconds',
            'fromClipId',
            'eq',
            'dynamics',
          ] as const) {
            if (expected[key] !== undefined) expect(effect.params[key]).toEqual(expected[key]);
          }
          if (expected.keyframes !== undefined)
            expect(effect.keyframes).toEqual(expected.keyframes);
        }
        return;
      }

      if (typeof expected.trackId === 'string') {
        const track = timeline.tracks.find((candidate) => candidate.id === expected.trackId);
        expect(track).toBeDefined();
        if (!track) return;
        if (typeof expected.locked === 'boolean') expect(track.locked).toBe(expected.locked);
        if (typeof expected.muted === 'boolean') expect(track.muted).toBe(expected.muted);
        if (typeof expected.trackType === 'string') expect(track.type).toBe(expected.trackType);
        if (typeof expected.trackIndex === 'number')
          expect(timeline.tracks.indexOf(track)).toBe(expected.trackIndex);
        // The mix role, which is what `duck_roles` and the role-based ducking
        // controller read. A runtime that drops it on the way in produces a bed
        // nothing can find.
        if (typeof expected.role === 'string') expect(track.role).toBe(expected.role);
      }
    });
  }
});
