/**
 * Sampling a colour off the program monitor for a `key` mask (MK6.1).
 *
 * The monitor's visible canvas is a 2D context that the compositor's finished frame is drawn
 * into, so a sample is a `getImageData` of one pixel — the same RGB the key qualifies, because
 * it is the same frame the key was evaluated on. Nothing is read from the GL context: its
 * drawing buffer is not preserved, and a read from it would be a frame behind or blank.
 *
 * What a sample BECOMES depends on the mask's model, and that choice is the useful part of an
 * eyedropper: a `3d` key collects the colours themselves, while a range model gets ranges
 * centred on what was picked, wide enough to be a starting point an editor then tightens.
 */
import type { MaskPropertyValue } from '@framepilot/editor-core';
import { channelValues, type KeyMask } from './key-mask.js';

/** One sampled pixel, in `[0, 1]`. */
export interface SampledColour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** How wide a range the eyedropper opens around a sampled value, per channel. */
const SAMPLE_WIDTH = { hue: 0.06, saturation: 0.25, luma: 0.25, channel: 0.18 } as const;
/** The softness a fresh range carries, so the first pick already has an edge to work with. */
const SAMPLE_SOFTNESS = { hue: 0.04, saturation: 0.15, luma: 0.15, channel: 0.12 } as const;
/** The tolerance a fresh `3d` key carries (RGB units). */
export const SAMPLE_TOLERANCE = 0.18;

/**
 * The colour under a pointer event, or `null` when the monitor has not drawn a frame.
 *
 * @param canvas - The monitor's 2D canvas (`.webcodecs-preview-canvas`).
 * @param clientX - Pointer position in CSS pixels.
 * @param clientY - Pointer position in CSS pixels.
 */
export function sampleCanvasColour(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): SampledColour | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return null;
  const x = Math.floor(((clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.floor(((clientY - rect.top) / rect.height) * canvas.height);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;
  const { data } = context.getImageData(x, y, 1, 1);
  return { r: data[0]! / 255, g: data[1]! / 255, b: data[2]! / 255 };
}

/** A range the eyedropper opens around `value`, clamped into `[0, 1]` (hue wraps instead). */
function around(
  channel: 'hue' | 'saturation' | 'luma' | 'red' | 'green' | 'blue',
  value: number,
): { channel: typeof channel; low: number; high: number; softness: number } {
  const wide =
    channel === 'hue'
      ? SAMPLE_WIDTH.hue
      : channel === 'saturation'
        ? SAMPLE_WIDTH.saturation
        : channel === 'luma'
          ? SAMPLE_WIDTH.luma
          : SAMPLE_WIDTH.channel;
  const soft =
    channel === 'hue'
      ? SAMPLE_SOFTNESS.hue
      : channel === 'saturation'
        ? SAMPLE_SOFTNESS.saturation
        : channel === 'luma'
          ? SAMPLE_SOFTNESS.luma
          : SAMPLE_SOFTNESS.channel;
  if (channel === 'hue') {
    // Hue wraps, so a pick near 0 or 1 opens an arc through the wrap rather than a clipped band.
    const low = value - wide - Math.floor(value - wide);
    const high = value + wide - Math.floor(value + wide);
    return { channel, low, high, softness: soft };
  }
  return {
    channel,
    low: Math.max(0, value - wide),
    high: Math.min(1, value + wide),
    softness: soft,
  };
}

/** The mask fields one sample produces, ready for `set_mask_properties`. */
export type KeySampleChanges = Readonly<Record<string, MaskPropertyValue>>;

/**
 * What a sampled colour changes on `mask`.
 *
 * @param mask - The key being edited.
 * @param colour - The sampled pixel.
 * @param add - True to widen the key with this colour (Shift-click), false to start again from
 *   it. Adding is what makes a backing with a hot spot and a shadow keyable in three clicks.
 */
export function keySampleChanges(
  mask: KeyMask,
  colour: SampledColour,
  add: boolean,
): KeySampleChanges {
  const [hue, saturation, luma] = channelValues(colour.r, colour.g, colour.b);
  if (mask.model === '3d') {
    const sample: [number, number, number] = [colour.r, colour.g, colour.b];
    return {
      samples3d: add ? [...mask.samples3d, sample] : [sample],
      ...(mask.softness > 0 ? {} : { softness: SAMPLE_TOLERANCE }),
    };
  }
  const ranges =
    mask.model === 'luma'
      ? [around('luma', luma!)]
      : mask.model === 'rgb'
        ? [around('red', colour.r), around('green', colour.g), around('blue', colour.b)]
        : [around('hue', hue!), around('saturation', saturation!)];
  if (!add) return { ranges };
  // Adding widens what is already there rather than stacking a second range on the same
  // channel: two ranges on one channel would multiply to their intersection, which is the
  // opposite of "also include this colour".
  const merged = mask.ranges.map((existing) => {
    const fresh = ranges.find((candidate) => candidate.channel === existing.channel);
    if (fresh === undefined) return existing;
    if (existing.channel === 'hue') {
      // A wrapping arc cannot be widened by min/max; the fresh arc replaces it.
      return existing.low > existing.high || fresh.low > fresh.high
        ? fresh
        : {
            ...existing,
            low: Math.min(existing.low, fresh.low),
            high: Math.max(existing.high, fresh.high),
          };
    }
    return {
      ...existing,
      low: Math.min(existing.low, fresh.low),
      high: Math.max(existing.high, fresh.high),
    };
  });
  const added = ranges.filter(
    (fresh) => !mask.ranges.some((existing) => existing.channel === fresh.channel),
  );
  return { ranges: [...merged, ...added] };
}
