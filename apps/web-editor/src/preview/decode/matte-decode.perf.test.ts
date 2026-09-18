/**
 * PX5: what one 4K matte frame costs the preview to decode.
 *
 * The monitor plays the lossless FFV1 masters (`masks/matte-source.ts`, "Proxy decision"), and
 * Chromium has no FFV1 decoder, so `ffv1/ffv1-decoder.ts` decodes them in the decode worker. A
 * matte is stored at the SOURCE's display size whatever proxy the picture plays from, so on the
 * Scale row that is 3840x2160 per frame, plus a 4K RGB foreground when the mask decontaminates.
 * To hold 30 fps the pair has to decode inside 33.3 ms. This measures them through the real
 * session (`MatteDecodeSession`: Matroska index, range reads, contiguous decode).
 *
 * Needs the generated fixture (`pnpm px5:fixture`, or FRAMEPILOT_PX5_FIXTURE=<dir>); skips with
 * a message when it is absent. Runs only with FRAMEPILOT_RUN_PERF=1. Numbers and their meaning:
 * `plan/background-removal-ai/PX5-BUDGETS.md`.
 */
import { existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ByteRangeReader } from '../demux/mp4-demuxer';
import { DecoderPool, type PooledDecoderHolder } from './decoder-pool';
import { MatteDecodeSession } from './matte-decode-session';

const REPO = path.resolve(__dirname, '../../../../..');
const FIXTURE =
  process.env.FRAMEPILOT_PX5_FIXTURE ?? path.join(REPO, 'tests', 'e2e', '.tmp-px5-scale');
const MANIFEST = path.join(FIXTURE, 'manifest.json');
const FRAMES = 24;
const WARMUP_FRAMES = 3;

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

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

async function measure(file: string): Promise<{ format: string; p50: number; p95: number }> {
  const session = new MatteDecodeSession(new DecoderPool<PooledDecoderHolder>(), (url) =>
    Promise.resolve(fileReader(url)),
  );
  const info = await session.load(file, null);
  expect([info.width, info.height]).toEqual([3840, 2160]);
  const samples: number[] = [];
  for (let frame = 0; frame < FRAMES + WARMUP_FRAMES; frame += 1) {
    const started = performance.now();
    await session.decode(frame);
    if (frame >= WARMUP_FRAMES) samples.push(performance.now() - started);
  }
  session.dispose();
  return { format: info.format, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

describe('4K matte frame decode cost (PX5)', () => {
  it.skipIf(!existsSync(MANIFEST))(
    'matte.mkv and foreground.mkv, contiguous frames',
    async () => {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
        matte: { key: string; root: string };
      };
      const directory = path.join(FIXTURE, manifest.matte.root, manifest.matte.key);
      const rows = [];
      for (const name of ['matte.mkv', 'foreground.mkv']) {
        const { format, p50, p95 } = await measure(path.join(directory, name));
        rows.push({ name, format, p50: p50.toFixed(1), p95: p95.toFixed(1) });
      }
      console.info(`[PX5 matte decode] 3840x2160, ms per frame\n${JSON.stringify(rows, null, 1)}`);
      expect(rows).toHaveLength(2);
    },
    120_000,
  );

  it.runIf(!existsSync(MANIFEST))('reports that the fixture is missing', () => {
    console.info(`[PX5 matte decode] not measured: no fixture at ${FIXTURE} (pnpm px5:fixture)`);
  });
});
