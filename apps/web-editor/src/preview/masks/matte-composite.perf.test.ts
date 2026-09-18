/**
 * PX5: what one frame of a 4K matte costs the monitor's MAIN THREAD, by stage.
 *
 * The compositor builds a matte layer's alpha (`matteFrameAlpha`) and its edge decontamination
 * (`decontaminate`) on the CPU in float64, from the 4K artifact frame, inside every composite
 * that shows a new matte frame. In Chrome on the Scale row that composite measured ~450 ms
 * against a 33.3 ms frame (`plan/background-removal-ai/PX5-BUDGETS.md`); this names where it
 * goes, on the real fixture frame, at the size the desktop monitor rasters at (a 540p proxy).
 *
 * Needs `pnpm px5:fixture`; FRAMEPILOT_RUN_PERF=1 only.
 */
import { existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ByteRangeReader } from '../demux/mp4-demuxer';
import { DecoderPool, type PooledDecoderHolder } from '../decode/decoder-pool';
import { MatteDecodeSession } from '../decode/matte-decode-session';
import { decontaminate, matteFrameAlpha, type MatteFrameData } from './matte-edges';

const REPO = path.resolve(__dirname, '../../../../..');
const FIXTURE =
  process.env.FRAMEPILOT_PX5_FIXTURE ?? path.join(REPO, 'tests', 'e2e', '.tmp-px5-scale');
const MANIFEST = path.join(FIXTURE, 'manifest.json');
const TARGET = { width: 960, height: 540 };
const RUNS = 5;

function fileReader(file: string): ByteRangeReader {
  const descriptor = openSync(file, 'r');
  return {
    size: statSync(file).size,
    read(start: number, end: number): Promise<ArrayBuffer> {
      const bytes = new Uint8Array(end - start);
      readSync(descriptor, bytes, 0, bytes.length, start);
      return Promise.resolve(bytes.buffer);
    },
  };
}

async function firstFrame(file: string): Promise<Uint8Array> {
  const session = new MatteDecodeSession(new DecoderPool<PooledDecoderHolder>(), (url) =>
    Promise.resolve(fileReader(url)),
  );
  await session.load(file, null);
  const picture = await session.decode(40);
  session.dispose();
  return picture.data as Uint8Array;
}

const median = (samples: number[]): number =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

function timed(work: () => void): number {
  const samples: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    work();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

describe('4K matte on the main thread, per frame (PX5)', () => {
  it.skipIf(!existsSync(MANIFEST))(
    'matte alpha and decontamination at 960x540',
    async () => {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
        matte: { key: string; root: string };
      };
      const directory = path.join(FIXTURE, manifest.matte.root, manifest.matte.key);
      const frame: MatteFrameData = {
        id: 'px5',
        width: 3840,
        height: 2160,
        maximum: 255,
        alpha: await firstFrame(path.join(directory, 'matte.mkv')),
        foreground: await firstFrame(path.join(directory, 'foreground.mkv')),
      };
      const identityFinesse = {
        denoise: 0,
        morphOpenPx: 0,
        morphClosePx: 0,
        shrinkGrowPx: 0,
        blurPx: 0,
        inOutRatio: 0,
        cleanBlack: 0,
        cleanWhite: 1,
      };
      const alphaMs = timed(() => {
        matteFrameAlpha(
          frame,
          [0.25, 0.75],
          identityFinesse,
          0,
          { expansion: 0, featherInner: 0, featherOuter: 0, falloff: 'linear' },
          null,
          TARGET.width,
          TARGET.height,
          TARGET.width,
          TARGET.height,
        );
      });
      const picture = new Uint8Array(TARGET.width * TARGET.height * 4).fill(90);
      const cleanMs = timed(() => {
        decontaminate(
          picture,
          TARGET.width,
          TARGET.height,
          4,
          frame,
          null,
          TARGET.width,
          TARGET.height,
        );
      });
      console.info(
        `[PX5 matte main thread] 3840x2160 -> ${TARGET.width}x${TARGET.height}, median of ${RUNS}: ` +
          `matteFrameAlpha ${alphaMs.toFixed(0)} ms, decontaminate ${cleanMs.toFixed(0)} ms`,
      );
      expect(alphaMs + cleanMs).toBeGreaterThan(0);
    },
    120_000,
  );
});
