/**
 * BR5.1: a clip's matte layers evaluate to the same float64 alpha, and decontaminate to the same
 * bytes, as the export (`tests/fixtures/mask-raster/matte-clips.json`, `pnpm mask-raster:vectors`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClipSchema } from '@framepilot/timeline-schema';

import { decontaminate, type MatteFrameData } from './matte-edges';
import {
  clipMaskStack,
  stackAlphaAt,
  type MaskStackTarget,
  type MatteStackInputs,
} from './mask-stack';

const REPO = path.resolve(__dirname, '../../../../..');

interface MatteCase {
  id: string;
  clip: unknown;
  media: { width: number; height: number };
  maximum: number;
  matte: string;
  foreground: string;
  effects?: string[];
  expected: ({
    decoded: [number, number];
    width: number;
    height: number;
    time: number;
    alpha: string | null;
    decontaminated: string;
  } & Record<string, unknown>)[];
}

const document = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'matte-clips.json'), 'utf8'),
) as { cases: MatteCase[] };

const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));

const digest = (data: ArrayBufferView | null): string | null =>
  data === null
    ? null
    : createHash('sha256')
        .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        .digest('hex');

/** `matte_picture(width, height)` of the vector generator. */
function picture(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      out[i] = (x * 13 + y * 7) & 255;
      out[i + 1] = (x * 5 + y * 3 + 40) & 255;
      out[i + 2] = (x ^ y) & 255;
    }
  }
  return out;
}

function frameOf(vector: MatteCase): MatteFrameData {
  const raw = bytes(vector.matte);
  const alpha =
    vector.maximum > 255
      ? new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      : raw;
  return {
    id: `${vector.id}@0`,
    width: vector.media.width,
    height: vector.media.height,
    maximum: vector.maximum,
    alpha,
    foreground: bytes(vector.foreground),
  };
}

describe('matte layer vectors (float64-exact vs the export)', () => {
  it('reproduces every matte clip at every decode size and time', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const vector of document.cases) {
      const clip = ClipSchema.parse(vector.clip);
      const stack = clipMaskStack(clip, vector.media);
      expect(stack?.refusal ?? null, vector.id).toBeNull();
      const frame = frameOf(vector);
      for (const expected of vector.expected) {
        const mattes: MatteStackInputs = {
          decodedWidth: expected.decoded[0],
          decodedHeight: expected.decoded[1],
          frames: new Map(stack!.mattes.map((mask) => [mask.id, frame])),
        };
        const targets: [string, MaskStackTarget][] = [
          ['alpha', { kind: 'alpha' }],
          ...(vector.effects ?? []).map((effectId): [string, MaskStackTarget] => [
            `effect:${effectId}`,
            { kind: 'effect', effectId },
          ]),
        ];
        const where = `${vector.id} @${expected.decoded.join('x')} t=${expected.time}`;
        for (const [field, target] of targets) {
          const actual = digest(
            stackAlphaAt(stack!, target, expected.width, expected.height, expected.time, mattes),
          );
          if (actual !== expected[field]) mismatches.push(`${where} ${field}`);
          checked += 1;
        }
        const cleaned = picture(expected.width, expected.height);
        for (const mask of [...stack!.mattes].reverse()) {
          if (!mask.decontaminate) continue;
          decontaminate(
            cleaned,
            expected.width,
            expected.height,
            3,
            frame,
            clip.crop,
            expected.decoded[0],
            expected.decoded[1],
          );
        }
        if (digest(cleaned) !== expected.decontaminated) mismatches.push(`${where} decontaminated`);
        checked += 1;
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  });

  it('leaves a matte whose frame is still processing out of the stack', () => {
    const vector = document.cases.find((c) => c.id === 'matte/cropped-minus-rectangle')!;
    const clip = ClipSchema.parse(vector.clip);
    const stack = clipMaskStack(clip, vector.media)!;
    const processing: MatteStackInputs = {
      decodedWidth: 48,
      decodedHeight: 27,
      frames: new Map([['m', null]]),
    };
    // Only the subtracted rectangle remains: nothing is added, so the stack keeps nothing.
    const alpha = stackAlphaAt(stack, { kind: 'alpha' }, 34, 20, 0, processing)!;
    expect(Math.max(...alpha)).toBe(0);
    const alone = clipMaskStack(
      ClipSchema.parse({
        ...(vector.clip as object),
        masks: [(vector.clip as { masks: unknown[] }).masks[0]],
      }),
      vector.media,
    )!;
    expect(stackAlphaAt(alone, { kind: 'alpha' }, 34, 20, 0, processing)).toBeNull();
  });

  it('refuses matte finesse the export cannot draw', () => {
    const vector = document.cases[0]!;
    const raw = structuredClone(vector.clip) as { masks: Record<string, unknown>[] };
    raw.masks[0]!.finesse = { blurPx: 2 };
    const stack = clipMaskStack(ClipSchema.parse(raw), vector.media)!;
    expect(stack.refusal?.task).toBe('MK6');
  });
});
