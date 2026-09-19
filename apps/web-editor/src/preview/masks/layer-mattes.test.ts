/**
 * MK8.2: the track matte mapping and channels, byte-exact against the engine.
 *
 * `tests/fixtures/mask-raster/layer.json` is written by the engine (`pnpm mask-raster:vectors`):
 * one RGBA source frame, placements from identity to rotated, and per channel the SHA-256 of the
 * float64 value `sampled_channel` puts on the clip's local raster. The CPU twin must produce the
 * same 8 bytes per pixel; the shader (float32) is judged by the PX4 oracle instead.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MaskLayerSchema } from '@framepilot/timeline-schema';

import {
  LAYER_CHANNELS,
  layerMatteAlpha,
  layerMatteRefusal,
  layerMatteUniforms,
  layerSamplePosition,
  type LayerMask,
  type PicturePlacement,
} from './layer-mattes';

const REPO = path.resolve(__dirname, '../../../../..');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'layer.json');

interface LayerDocument {
  frame: { width: number; height: number; rgba: string };
  cases: {
    id: string;
    placement: [number, number, number, number, number, number, number];
    expected: Record<(typeof LAYER_CHANNELS)[number], string>;
  }[];
}

const digest = (values: Float64Array): string =>
  createHash('sha256')
    .update(Buffer.from(values.buffer, values.byteOffset, values.byteLength))
    .digest('hex');

const placementOf = ([
  localWidth,
  localHeight,
  width,
  height,
  rotation,
  x,
  y,
]: LayerDocument['cases'][number]['placement']): PicturePlacement => ({
  localWidth,
  localHeight,
  width,
  height,
  rotation,
  x,
  y,
});

describe('track matte vectors (byte-exact vs the engine)', () => {
  const document = JSON.parse(readFileSync(FIXTURE, 'utf8')) as LayerDocument;
  const frame = {
    width: document.frame.width,
    height: document.frame.height,
    rgba: new Uint8Array(Buffer.from(document.frame.rgba, 'base64')),
  };

  it('reproduces every placement and channel', () => {
    const mismatches: string[] = [];
    for (const vectorCase of document.cases) {
      for (const channel of LAYER_CHANNELS) {
        const actual = digest(layerMatteAlpha(frame, channel, placementOf(vectorCase.placement)));
        if (actual !== vectorCase.expected[channel]) mismatches.push(`${vectorCase.id}/${channel}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(document.cases.length * LAYER_CHANNELS.length).toBe(24);
  });
});

describe('track matte helpers', () => {
  it('maps pixel centres through resize and a counter-clockwise turn', () => {
    const scaled = { localWidth: 4, localHeight: 2, width: 8, height: 4, rotation: 0, x: 0, y: 0 };
    expect(layerSamplePosition(scaled, 0, 0)).toEqual([1, 1]);
    expect(layerSamplePosition(scaled, 3, 1)).toEqual([7, 3]);
    const turned = {
      ...scaled,
      localWidth: 10,
      localHeight: 10,
      width: 10,
      height: 10,
      rotation: 90,
    };
    expect(layerSamplePosition(turned, 9, 0)).toEqual([0, 0]);
    expect(layerMatteUniforms(turned, 'inverted-luma')).toMatchObject({
      rotated: 1,
      channel: 3,
    });
  });

  it('refuses edge controls and morphology the monitor cannot carry', () => {
    const parse = (extra: Record<string, unknown>) =>
      MaskLayerSchema.parse({
        id: 'm',
        kind: 'layer',
        source: { kind: 'clip', clipId: 'c' },
        ...extra,
      }) as LayerMask;
    expect(layerMatteRefusal(parse({}))).toBeNull();
    expect(layerMatteRefusal(parse({ featherOuterPx: 3 }))).toMatch(/takes its edge/);
    expect(layerMatteRefusal(parse({ finesse: { morphOpenPx: 20 } }))).toMatch(/16 px/);
    expect(layerMatteRefusal(parse({ featherModel: 'gaussian-legacy' }))).toMatch(/Distance/);
  });
});
