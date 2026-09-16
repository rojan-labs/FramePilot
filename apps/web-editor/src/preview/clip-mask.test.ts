import { describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  maskLayerFromLegacyMaskEffect,
  type Clip,
  type Effect,
} from '@framepilot/timeline-schema';
import {
  clipMaskSource,
  isIdentityMask,
  maskAt,
  maskCssImage,
  paintClipMask,
  type MaskPaintContext,
  type PreviewMaskSource,
} from './clip-mask.js';

const MEDIA = { width: 1080, height: 1920 };

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'clip_a',
  assetId: 'a',
  trackId: 'v',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
  ...over,
});

/**
 * A v21-vocabulary mask converted exactly as the v21 → v22 migration converts it, so these
 * expectations still state what the export draws (schema v22, ADR 0178).
 */
function maskEffect(
  params: Record<string, unknown>,
  keyframes: Effect['keyframes'] = [],
): PreviewMaskSource {
  const host = clip();
  const mask = MaskLayerSchema.parse(
    maskLayerFromLegacyMaskEffect(
      { id: 'clip_a__mask', params, keyframes },
      host as unknown as Record<string, unknown>,
      MEDIA,
    ),
  );
  return { clip: host, mask, size: MEDIA };
}

const box = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };

describe('maskAt mirrors render/masks.py#mask_spec_at', () => {
  it('reads the static params, with the engine defaults for anything absent', () => {
    expect(maskAt(maskEffect({ shape: 'ellipse', bounds: box, feather: 0.1 }), 0)).toEqual({
      shape: 'ellipse',
      ...box,
      feather: 0.1,
      opacity: 1,
      invert: false,
      points: [],
    });
    expect(maskAt(maskEffect({}), 0)).toMatchObject({
      shape: 'rectangle',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it('moves with its keyframes — a tracked mask animates x/y/width/height', () => {
    const tracked = maskEffect({ shape: 'rectangle', bounds: box }, [
      { id: 'k0', property: 'x', time: 0, value: 0.1 },
      { id: 'k1', property: 'x', time: 2, value: 0.5 },
      { id: 'k2', property: 'width', time: 0, value: 0.3 },
    ] as Effect['keyframes']);
    expect(maskAt(tracked, 0).x).toBeCloseTo(0.1);
    expect(maskAt(tracked, 1).x).toBeCloseTo(0.3);
    expect(maskAt(tracked, 5).x).toBeCloseTo(0.5);
    // A property with no keyframes keeps its static value.
    expect(maskAt(tracked, 1).y).toBeCloseTo(0.3);
    expect(maskAt(tracked, 1).width).toBeCloseTo(0.3);
  });

  it('draws only what the export draws: one enabled alpha shape on measured media', () => {
    const { mask } = maskEffect({ shape: 'ellipse' });
    expect(clipMaskSource(clip({ masks: [mask] }), MEDIA)?.mask).toBe(mask);
    expect(clipMaskSource(clip(), MEDIA)).toBeNull();
    expect(clipMaskSource(clip({ masks: [mask] }), null)).toBeNull();
    expect(clipMaskSource(clip({ masks: [mask, { ...mask, id: 'b' }] }), MEDIA)).toBeNull();
    expect(clipMaskSource(clip({ masks: [{ ...mask, mode: 'subtract' }] }), MEDIA)).toBeNull();
  });

  it('reads source-time keyframes at the instant the clip plays at speed 2', () => {
    const source = maskEffect({ shape: 'rectangle', bounds: box }, [
      { id: 'k0', property: 'x', time: 0, value: 0.1, easing: 'linear' },
      { id: 'k1', property: 'x', time: 2, value: 0.5, easing: 'linear' },
    ] as Effect['keyframes']);
    const fast = { ...source, clip: { ...source.clip, speed: 2 } };
    // Clip time 0.5s at 2x plays source 1s, where x is halfway: 0.3.
    expect(maskAt(fast, 0.5).x).toBeCloseTo(0.3);
  });
});

describe('isIdentityMask', () => {
  it('is only a full-frame, hard-edged, opaque, non-inverted box', () => {
    expect(isIdentityMask(maskAt(maskEffect({}), 0))).toBe(true);
    expect(isIdentityMask(maskAt(maskEffect({ bounds: box }), 0))).toBe(false);
    expect(isIdentityMask(maskAt(maskEffect({ invert: true }), 0))).toBe(false);
    expect(isIdentityMask(maskAt(maskEffect({ shape: 'ellipse' }), 0))).toBe(false);
  });
});

describe('maskCssImage', () => {
  const frame = { width: 1080, height: 1920 };

  it('draws the shape in frame pixels with a feather measured like the engine', () => {
    const css = decodeURIComponent(
      maskCssImage(maskAt(maskEffect({ shape: 'ellipse', bounds: box, feather: 0.1 }), 0), frame),
    );
    expect(css).toContain('viewBox="0 0 1080 1920"');
    // x 0.2×1080=216, w 0.4×1080=432 → cx 432; y 0.3×1920=576, h 0.5×1920=960 → cy 1056.
    expect(css).toContain('<ellipse cx="432" cy="1056" rx="216" ry="480"/>');
    // feather × min(width, height) = 0.1 × 1080.
    expect(css).toContain('stdDeviation="108"');
  });

  it('keeps the outside when inverted, scaled by opacity', () => {
    const css = decodeURIComponent(
      maskCssImage(maskAt(maskEffect({ bounds: box, invert: true, opacity: 0.5 }), 0), frame),
    );
    expect(css).toContain('<mask id="m"');
    expect(css).toContain('fill="black"');
    expect(css).toContain('opacity="0.5" mask="url(#m)"');
  });

  it('uses polygon points only when there are at least three', () => {
    const polygon = maskAt(
      maskEffect({ shape: 'polygon', points: [[0, 0], [1, 0], [0.5, 1]] }),
      0,
    );
    expect(decodeURIComponent(maskCssImage(polygon, frame))).toContain(
      '<polygon points="0,0 1080,0 540,1920"/>',
    );
    const degenerate = maskAt(maskEffect({ shape: 'polygon', points: [[0, 0]], bounds: box }), 0);
    expect(decodeURIComponent(maskCssImage(degenerate, frame))).toContain('<rect');
  });
});

describe('paintClipMask', () => {
  function recordingContext(): MaskPaintContext & { calls: string[] } {
    const calls: string[] = [];
    const ctx = {
      calls,
      filter: 'none',
      globalAlpha: 0.4,
      globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
      fillStyle: '#000' as string | CanvasGradient | CanvasPattern,
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      rect: (...args: number[]) => calls.push(`rect ${args.join(',')}`),
      ellipse: (...args: number[]) => calls.push(`ellipse ${args.slice(0, 4).join(',')}`),
      moveTo: (x: number, y: number) => calls.push(`moveTo ${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`lineTo ${x},${y}`),
      closePath: () => calls.push('closePath'),
      fill: () =>
        calls.push(
          `fill ${ctx.globalCompositeOperation} ${String(ctx.fillStyle)} ${ctx.filter} alpha=${ctx.globalAlpha}`,
        ),
      fillRect: (...args: number[]) =>
        calls.push(`fillRect ${ctx.globalCompositeOperation} ${args.join(',')}`),
    };
    return ctx as unknown as MaskPaintContext & { calls: string[] };
  }

  const frameRect = { x: -540, y: -960, width: 1080, height: 1920 };

  it('keeps only the shape, in the frame box of the current transform', () => {
    const ctx = recordingContext();
    paintClipMask(ctx, maskAt(maskEffect({ bounds: box, opacity: 0.8 }), 0), frameRect);
    expect(ctx.calls).toContain('rect -324,-384,432,960');
    // alpha=1: the picture was drawn at its own opacity; the mask must not apply it twice.
    expect(ctx.calls).toContain('fill destination-in rgba(0,0,0,0.8) none alpha=1');
  });

  it('erases the shape when inverted, then applies opacity to what is left', () => {
    const ctx = recordingContext();
    paintClipMask(
      ctx,
      maskAt(maskEffect({ shape: 'ellipse', bounds: box, invert: true, opacity: 0.5 }), 0),
      frameRect,
    );
    expect(ctx.calls.some((c) => c.startsWith('fill destination-out'))).toBe(true);
    expect(ctx.calls).toContain('fillRect destination-in -540,-960,1080,1920');
  });

  it('feathers with a blur of feather × the shorter frame side', () => {
    const ctx = recordingContext();
    paintClipMask(ctx, maskAt(maskEffect({ bounds: box, feather: 0.05 }), 0), frameRect);
    expect(ctx.calls.some((c) => c.includes('blur(54.00px)'))).toBe(true);
  });
});
