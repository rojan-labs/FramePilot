/**
 * Which clips sound, and where each reads its source, against the export
 * (`tests/fixtures/audio-mix/envelopes.json` → `reads`, written by `pnpm audio-mix:vectors` from
 * `compiler._subclipped_source` and `compiler._apply_speed`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { resampleAlong, soundingClips, sourceReadOf, type SoundKind } from './clip-audio.js';

interface ReadCase {
  readonly name: string;
  readonly kind: 'audio' | 'video';
  readonly fps: number;
  readonly sourceSeconds: number;
  readonly clip: Clip;
  readonly times: readonly number[];
  readonly sourceTimes: readonly number[];
}

const REPO = path.resolve(__dirname, '../../../../..');
const READS: readonly ReadCase[] = (
  JSON.parse(
    readFileSync(path.join(REPO, 'tests', 'fixtures', 'audio-mix', 'envelopes.json'), 'utf8'),
  ) as { reads: ReadCase[] }
).reads;

/** The export's reader rounds a read to its sample; the vectors carry the unrounded time. */
const RAMP_TOLERANCE = 1e-9;

describe('sourceReadOf matches the export’s time map', () => {
  it.each(READS.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const read = sourceReadOf(testCase.clip, testCase.sourceSeconds, 1 / testCase.fps);
    const sourceAt = (local: number): number => {
      if (read.kind === 'rate') return testCase.clip.sourceStart + local * read.rate;
      if (read.kind === 'mapped') return testCase.clip.sourceStart + read.sourceAt(local);
      throw new Error(`${testCase.name} reads nothing`);
    };
    const worst = testCase.times.reduce(
      (max, t, index) => Math.max(max, Math.abs(sourceAt(t) - testCase.sourceTimes[index]!)),
      0,
    );
    expect(worst).toBeLessThanOrEqual(RAMP_TOLERANCE);
  });

  it('covers a forward speed, both mirrors and a ramp', () => {
    expect(READS.map((testCase) => testCase.name).sort()).toEqual([
      'forward-sped-up',
      'ramp',
      'reverse-audio',
      'reverse-footage-slowed',
    ]);
  });

  it('drops a freeze’s sound, as the export’s `without_audio` does', () => {
    const freeze = { ...READS[0]!.clip, speed: 0 };
    expect(sourceReadOf(freeze, 10, 1 / 30)).toEqual({ kind: 'silent' });
  });
});

describe('soundingClips', () => {
  const clip = (id: string, assetId: string): Clip =>
    ({
      id,
      assetId,
      trackId: 't',
      start: 0,
      end: 2,
      sourceStart: 0,
      sourceEnd: 2,
      effects: [],
      keyframes: [],
    }) as unknown as Clip;
  const kinds: Record<string, SoundKind> = { cam: 'video', song: 'audio', title: 'other' };
  const kindOf = (candidate: Clip): SoundKind => kinds[candidate.assetId] ?? 'other';

  it('follows the export: hidden footage is silent, a hidden audio track still plays', () => {
    const timeline = {
      tracks: [
        { id: 'v-hidden', type: 'video', hidden: true, clips: [clip('shot-hidden', 'cam')] },
        { id: 'v', type: 'video', clips: [clip('shot', 'cam'), clip('card', 'title')] },
        { id: 'a-hidden', type: 'audio', hidden: true, clips: [clip('bed', 'song')] },
        { id: 'a-muted', type: 'audio', clips: [clip('sfx', 'song')] },
      ],
    } as unknown as Timeline;
    const ids = soundingClips(timeline, kindOf, new Set(['a-muted'])).map((s) => s.clip.id);
    expect(ids).toEqual(['shot', 'bed']);
  });
});

describe('resampleAlong', () => {
  it('reads a ramp through linear interpolation and a reverse backwards', () => {
    const rate = 10;
    const channel = Float32Array.from({ length: 50 }, (_, index) => index / rate);
    const reversed = resampleAlong(channel, rate, 1, (local) => 2 - local, 0, 5);
    expect(Array.from(reversed)).toEqual(
      [3, 2.9, 2.8, 2.7, 2.6].map((value) => Math.fround(value)),
    );
    const between = resampleAlong(channel, rate, 0, (local) => local * 0.5, 0, 3);
    expect(between[1]).toBeCloseTo(0.05, 6);
  });

  it('is silent where the map reads outside the file, as the reader is', () => {
    const channel = new Float32Array(20).fill(1);
    const out = resampleAlong(channel, 10, 0, (local) => local - 0.3, 0, 30);
    expect(out[0]).toBe(0);
    expect(out[5]).toBe(1);
    expect(out[29]).toBe(0);
  });
});
