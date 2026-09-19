/**
 * PX5: what an animated 200-vertex path mask costs to rasterise per frame, on the thread that
 * rasterises it (the monitor's main thread: `LayerCompositor.stackCoverage`).
 *
 * MK3 shipped the exact CPU rasteriser without a playback number. An ANIMATED mask misses the
 * raster cache on every frame, so its raster is inside every composite, and the composite has
 * one project frame (33.3 ms at 30 fps) for everything. The numbers, the sizes they were taken
 * at and why those sizes are in `plan/background-removal-ai/PX5-BUDGETS.md`.
 *
 * Runs only with FRAMEPILOT_RUN_PERF=1 (never under coverage; see `vite.config.ts`).
 */
import { describe, expect, it } from 'vitest';
import { ClipSchema, type Clip } from '@framepilot/timeline-schema';

import { MaskStackRasterCache, clipMaskStack } from './mask-stack';

const VERTICES = 200;
const SOURCE = { width: 3840, height: 2160 };
const FPS = 30;
const FRAMES = 24;
const WARMUP_FRAMES = 4;

/** A closed 200-vertex outline with curved segments, centred, scaled by `radius`. */
function outline(radius: number, phase: number): number[] {
  const points: number[] = [];
  for (let vertex = 0; vertex < VERTICES; vertex += 1) {
    const angle = (vertex / VERTICES) * Math.PI * 2;
    const wobble = 1 + 0.08 * Math.sin(angle * 9 + phase);
    const x = SOURCE.width / 2 + radius * 1.4 * wobble * Math.cos(angle);
    const y = SOURCE.height / 2 + radius * wobble * Math.sin(angle);
    // Tangent handles along the outline, so every segment is a real cubic.
    const tx = -Math.sin(angle) * 12;
    const ty = Math.cos(angle) * 12;
    points.push(x, y, -tx, -ty, tx, ty);
  }
  return points;
}

function animatedPathClip(feather: { inner: number; outer: number }): Clip {
  return ClipSchema.parse({
    id: 'c',
    assetId: 'a',
    trackId: 'v',
    start: 0,
    end: 10,
    sourceStart: 0,
    sourceEnd: 10,
    effects: [],
    keyframes: [],
    masks: [
      {
        kind: 'path',
        id: 'm',
        featherInnerPx: feather.inner,
        featherOuterPx: feather.outer,
        pathKeyframes: [
          {
            id: 'k0',
            sourceTime: 0,
            points: outline(700, 0),
            vertexTypes: new Array(VERTICES).fill(1),
          },
          {
            id: 'k1',
            sourceTime: 10,
            points: outline(900, 2),
            vertexTypes: new Array(VERTICES).fill(1),
          },
        ],
      },
    ],
  });
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

/** Per-frame raster time over consecutive playback frames (every one a cache miss). */
function measure(clip: Clip, width: number, height: number): { p50: number; p95: number } {
  const stack = clipMaskStack(clip, SOURCE);
  if (stack === null || stack.refusal !== null) throw new Error('perf fixture stack was refused');
  const cache = new MaskStackRasterCache();
  const samples: number[] = [];
  for (let frame = 0; frame < FRAMES + WARMUP_FRAMES; frame += 1) {
    const started = performance.now();
    const raster = cache.raster(stack, { kind: 'alpha' }, width, height, frame / FPS);
    const elapsed = performance.now() - started;
    if (raster === null) throw new Error('perf fixture drew nothing');
    if (frame >= WARMUP_FRAMES) samples.push(elapsed);
  }
  if (cache.drawCount !== FRAMES + WARMUP_FRAMES) {
    throw new Error('an animated mask must miss the raster cache on every frame');
  }
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

const SIZES: readonly (readonly [string, number, number])[] = [
  ['4K source size (the export-equivalent raster; not a size the monitor composites)', 3840, 2160],
  ['monitor canvas, full render scale', 1280, 720],
  ['540p proxy picture', 960, 540],
  ['monitor canvas at the 0.5 load-shed scale', 640, 360],
];

describe('animated 200-vertex path raster cost (PX5)', () => {
  it.each([
    ['hard edge', { inner: 0, outer: 0 }],
    ['feathered 24 px', { inner: 8, outer: 24 }],
  ] as const)('%s', (label, feather) => {
    const clip = animatedPathClip(feather);
    const rows = SIZES.map(([name, width, height]) => {
      const { p50, p95 } = measure(clip, width, height);
      return { name, size: `${width}x${height}`, p50: p50.toFixed(2), p95: p95.toFixed(2) };
    });
    console.info(`[PX5 mask raster] ${label}\n${JSON.stringify(rows, null, 1)}`);
    expect(rows).toHaveLength(SIZES.length);
  });
});
