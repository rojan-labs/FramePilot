import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROFESSIONAL_EVAL_MEDIA,
  ensureProfessionalEvalMedia,
  expectedBlockLeft,
  professionalEvalMediaDigest,
} from './professional-eval-media.js';

const ffmpegAvailable =
  spawnSync(process.env['FRAMEPILOT_FFMPEG'] ?? 'ffmpeg', ['-hide_banner', '-version'], {
    shell: false,
  }).status === 0;

// Generating media needs ffmpeg. Skipping is honest; faking the files would make
// every rendered proof downstream meaningless.
const withFfmpeg = ffmpegAvailable ? describe : describe.skip;

describe('professional eval media contract', () => {
  it('states the block position as arithmetic, not a pasted measurement', () => {
    expect(expectedBlockLeft(0)).toBe(0);
    expect(expectedBlockLeft(2)).toBe(PROFESSIONAL_EVAL_MEDIA.blockPixelsPerSecond * 2);
  });

  it('has a stable content digest for evidence lineage', () => {
    expect(professionalEvalMediaDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(professionalEvalMediaDigest()).toBe(professionalEvalMediaDigest());
  });
});

withFfmpeg('generated professional eval media', () => {
  it(
    'writes real, non-empty, content-coded media the evals can render',
    async () => {
      const base = mkdtempSync(path.join(tmpdir(), 'eval-media-'));

      const media = await ensureProfessionalEvalMedia(base);

      for (const file of [media.heroPath, media.altPath, media.musicPath]) {
        expect(statSync(file).size).toBeGreaterThan(1_000);
      }
      expect(media.baseDir).toBe(base);
    },
    120_000,
  );

  it(
    'is cached: a second call does not rewrite the files',
    async () => {
      const base = mkdtempSync(path.join(tmpdir(), 'eval-media-'));

      const first = await ensureProfessionalEvalMedia(base);
      const before = statSync(first.heroPath).mtimeMs;
      const second = await ensureProfessionalEvalMedia(base);

      expect(statSync(second.heroPath).mtimeMs).toBe(before);
    },
    120_000,
  );

  it(
    'actually contains a block that moves the stated distance',
    async () => {
      const base = mkdtempSync(path.join(tmpdir(), 'eval-media-'));
      const media = await ensureProfessionalEvalMedia(base);

      const at = (seconds: number): number => brightestColumn(media.heroPath, seconds);
      const start = at(1);
      const later = at(5);

      // The whole point of content coding: the picture must match the formula.
      expect(later - start).toBeGreaterThan(
        PROFESSIONAL_EVAL_MEDIA.blockPixelsPerSecond * 4 - 8,
      );
      expect(later - start).toBeLessThan(PROFESSIONAL_EVAL_MEDIA.blockPixelsPerSecond * 4 + 8);
    },
    120_000,
  );
});

/** Column index of the brightest pixel run in one decoded frame, via ffmpeg. */
function brightestColumn(videoPath: string, seconds: number): number {
  const { width, height } = PROFESSIONAL_EVAL_MEDIA;
  const result = spawnSync(
    process.env['FRAMEPILOT_FFMPEG'] ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(seconds),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ],
    { shell: false, maxBuffer: width * height * 4 },
  );
  const frame = result.stdout;
  expect(frame.byteLength).toBe(width * height);
  const row = Math.floor(height / 2);
  let best = 0;
  let bestValue = -1;
  for (let column = 0; column < width; column += 1) {
    const value = frame[row * width + column]!;
    if (value > bestValue) {
      bestValue = value;
      best = column;
    }
  }
  return best;
}
