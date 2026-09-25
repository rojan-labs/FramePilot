/**
 * The preview's clip mix against the export's own (`tests/fixtures/audio-mix/envelopes.json`,
 * written by `pnpm audio-mix:vectors` from `compiler._apply_audio_effects`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import { clipMix, sampleClipMix } from './mix-envelope.js';

interface VectorCase {
  readonly name: string;
  readonly timeline: Timeline;
  readonly clipId: string;
  readonly times: readonly number[];
  readonly expected: readonly number[];
}

const REPO = path.resolve(__dirname, '../../../../..');
const CASES: readonly VectorCase[] = (
  JSON.parse(
    readFileSync(path.join(REPO, 'tests', 'fixtures', 'audio-mix', 'envelopes.json'), 'utf8'),
  ) as { cases: VectorCase[] }
).cases;

/** Float64 against float64, through different but equivalent arithmetic orderings. */
const TOLERANCE = 1e-9;

function subjectOf(testCase: VectorCase) {
  const clip = testCase.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === testCase.clipId);
  if (!clip) throw new Error(`vector case ${testCase.name} has no clip ${testCase.clipId}`);
  return clip;
}

describe('clipMix matches the export', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const mix = clipMix(subjectOf(testCase), testCase.timeline.tracks);
    const worst = testCase.times.reduce((max, t, index) => {
      const error = Math.abs(mix.gainAt(t) - testCase.expected[index]!);
      return Math.max(max, error);
    }, 0);
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
  });

  it('covers every case the generator writes', () => {
    expect(CASES.map((testCase) => testCase.name)).toContain('lane-eased-with-fades-and-duck');
    expect(CASES.length).toBeGreaterThanOrEqual(12);
  });
});

describe('clipMix flags', () => {
  const byName = new Map(CASES.map((testCase) => [testCase.name, testCase]));
  const mixOf = (name: string) => {
    const testCase = byName.get(name)!;
    return clipMix(subjectOf(testCase), testCase.timeline.tracks);
  };

  it('reads a muted clip as silent, and a plain fader as constant', () => {
    expect(mixOf('muted')).toMatchObject({ muted: true, varies: false });
    expect(mixOf('fader-cut')).toMatchObject({ muted: false, varies: false });
    expect(mixOf('no-mix').gainAt(1.3)).toBe(1);
  });

  it('marks fades, ducks and lanes as varying', () => {
    for (const name of ['fades-linear', 'duck-under-speech', 'lane-linear']) {
      expect(mixOf(name).varies).toBe(true);
    }
    // A sidechain that is not on the timeline ducks nothing, as the export's lookup finds none.
    expect(mixOf('duck-missing-track').varies).toBe(false);
  });
});

describe('sampleClipMix', () => {
  it('spans the requested range with its last point on the end', () => {
    const testCase = CASES.find((candidate) => candidate.name === 'fades-linear')!;
    const mix = clipMix(subjectOf(testCase), testCase.timeline.tracks);
    const curve = sampleClipMix(mix, 1, 4, 0.001);
    expect(curve.length).toBe(3001);
    expect(curve[0]).toBeCloseTo(mix.gainAt(1), 6);
    expect(curve[curve.length - 1]).toBe(0);
  });

  it('always yields a usable curve, even for an empty span', () => {
    const testCase = CASES[0]!;
    const curve = sampleClipMix(clipMix(subjectOf(testCase), []), 2, 2, 0.001);
    expect(curve.length).toBe(2);
  });
});

describe('the duck lookup', () => {
  it('equals the engine’s minimum over every span, on a busy overlapping sidechain', () => {
    // A deterministic scatter of 400 dialogue clips, some overlapping, some nested.
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const dialogue = Array.from({ length: 400 }, (_, index) => {
      const start = random() * 590;
      return {
        id: `vo-${index}`,
        assetId: 'tone',
        trackId: 'speech',
        start,
        end: start + 0.05 + random() * (index % 17 === 0 ? 40 : 3),
        sourceStart: 0,
        sourceEnd: 1,
        effects: [],
        keyframes: [],
      };
    });
    const bed = {
      id: 'bed',
      assetId: 'tone',
      trackId: 'music',
      start: 5,
      end: 600,
      sourceStart: 0,
      sourceEnd: 595,
      keyframes: [],
      effects: [
        {
          id: 'mix',
          type: 'audio_gain',
          params: { duckUnderTrackId: 'speech', duckAmountDb: -15 },
          keyframes: [],
        },
      ],
    };
    const tracks = [
      { id: 'music', type: 'audio', clips: [bed] },
      { id: 'speech', type: 'audio', clips: dialogue },
    ] as unknown as Timeline['tracks'];
    const mix = clipMix(tracks[0]!.clips[0]!, tracks);
    const reduced = 10 ** (-15 / 20);
    const bruteForce = (local: number): number => {
      let gain = 1;
      for (const span of dialogue) {
        const start = span.start - bed.start;
        const end = span.end - bed.start;
        const attack = Math.min(1, Math.max(0, (local - (start - 0.15)) / 0.15));
        const release = Math.min(1, Math.max(0, (end + 0.15 - local) / 0.15));
        gain = Math.min(
          gain,
          1 - Math.min(1, Math.max(0, Math.min(attack, release))) * (1 - reduced),
        );
      }
      return gain;
    };
    let worst = 0;
    for (let local = -1; local < 596; local += 0.0137) {
      worst = Math.max(worst, Math.abs(mix.gainAt(local) - bruteForce(local)));
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });
});
