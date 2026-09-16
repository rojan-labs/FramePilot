/**
 * A clip's mask in the preview, resolved exactly as the export resolves it.
 *
 * WHY: the export has rendered masks since Phase 5 (`render/masks.py` +
 * `compiler.py#_attach_mask`), and a tracked mask now animates its geometry through the
 * mask effect's own keyframes. Neither preview player drew a mask at all, so a mask — and
 * every tracked subject — existed only in the render: the monitor showed the whole frame and
 * the editor had to export to see what they had made.
 *
 * Parity with the engine, point by point:
 * - schema v22 stores masks in source pixels on the source clock (ADR 0178); they are resolved
 *   here into frame fractions exactly as the engine's interim adapter resolves them;
 * - geometry is in FRAME FRACTIONS of the clip's own picture, applied after crop and before
 *   the clip is placed, so the mask moves, scales and rotates WITH the picture;
 * - `x`/`y`/`width`/`height`/`feather`/`opacity` animate through the effect's keyframes
 *   (`mask_spec_at`), evaluated with the same `evaluateKeyframes` the export mirrors;
 * - feather is a blur of `feather × min(frame width, height)`; `invert` keeps the outside;
 *   `opacity` scales the kept region; a polygon needs three points, else it is the bounds box.
 *
 * Pure except {@link paintClipMask}, which only issues 2D-context calls, so every decision is
 * testable without a browser.
 */
import {
  assetDisplaySize,
  hasSpeedRamp,
  maskScalarAt,
  sourceTimeAt,
  type DisplaySize,
} from '@framepilot/editor-core';
import { masksOf, type Asset, type Clip, type MaskLayer } from '@framepilot/timeline-schema';

/** A mask resolved at one instant. Geometry is in frame fractions (0..1). */
export interface PreviewMask {
  readonly shape: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly feather: number;
  readonly opacity: number;
  readonly invert: boolean;
  readonly points: readonly (readonly [number, number])[];
}

/** An axis-aligned box in the drawing space the mask is painted into. */
export interface MaskRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What the preview needs to draw a clip's mask (schema v22, ADR 0178): the clip (its crop and
 * speed map source time), the mask, and the media's measured size (masks are stored in source
 * pixels).
 */
export interface PreviewMaskSource {
  readonly clip: Pick<Clip, 'crop' | 'sourceStart' | 'sourceEnd' | 'speed' | 'speedRamp'>;
  readonly mask: MaskLayer;
  readonly size: DisplaySize | null;
}

/**
 * The clip's drawable mask, or `null` — mirroring the engine's interim adapter
 * (`render/masks.py#legacy_mask_for_clip`): the FIRST enabled alpha-target rectangle, ellipse
 * or path in source space, on media whose size is known (or stored as legacy fractions).
 * The export refuses the stacks this cannot draw; the preview draws none of them rather than
 * showing something the export will not produce.
 */
export function clipMaskSource(
  clip: Clip,
  media: Asset['media'] | DisplaySize | null | undefined,
): PreviewMaskSource | null {
  const enabled = masksOf(clip).filter((mask) => mask.enabled);
  const mask = enabled[0];
  if (enabled.length !== 1 || mask === undefined) return null;
  if (mask.kind !== 'rectangle' && mask.kind !== 'ellipse' && mask.kind !== 'path') return null;
  if (mask.target.kind !== 'alpha' || mask.space !== 'source' || mask.mode !== 'add') return null;
  const size = assetDisplaySize(media);
  if (size === null && mask.units !== 'normalized') return null;
  return { clip, mask, size };
}

/** Clip-relative timeline seconds → asset source seconds, as the export's speed stage plays. */
function sourceTimeForClip(clip: PreviewMaskSource['clip'], clipTime: number): number {
  if (hasSpeedRamp(clip)) {
    return clip.sourceStart + sourceTimeAt(clip.speedRamp!, 0, clipTime, clip.sourceEnd - clip.sourceStart);
  }
  const speed = clip.speed ?? 1;
  if (speed === 0) return clip.sourceStart;
  if (speed < 0) return clip.sourceEnd + clipTime * speed;
  return clip.sourceStart + clipTime * speed;
}

/**
 * Resolve a clip's mask at clip-relative `clipTime` into frame fractions of the clip's own
 * (cropped) picture — the vocabulary `render/masks.py` rasterises in.
 *
 * @param source - From {@link clipMaskSource}.
 * @param clipTime - Seconds from the clip's start.
 */
export function maskAt(source: PreviewMaskSource, clipTime: number): PreviewMask {
  const { clip, mask } = source;
  const s = sourceTimeForClip(clip, clipTime);
  const normalized = mask.units === 'normalized';
  const scaleW = normalized ? 1 : source.size!.width;
  const scaleH = normalized ? 1 : source.size!.height;
  const crop = clip.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const fx = (px: number): number => (px / scaleW - crop.x) / crop.width;
  const fy = (py: number): number => (py / scaleH - crop.y) / crop.height;
  const value = (property: Parameters<typeof maskScalarAt>[1]): number =>
    maskScalarAt(mask, property, s) ?? 0;
  const featherScale = normalized ? 1 : Math.min(crop.width * scaleW, crop.height * scaleH);
  const common = {
    feather: featherScale > 0 ? value('featherOuterPx') / featherScale : 0,
    opacity: value('opacity'),
    invert: mask.invert,
  };
  if (mask.kind === 'path') {
    const coords = mask.pathKeyframes[0]?.points ?? [];
    const points: (readonly [number, number])[] = [];
    for (let i = 0; i + 1 < coords.length; i += 6) points.push([fx(coords[i]!), fy(coords[i + 1]!)]);
    return { shape: 'polygon', x: 0, y: 0, width: 1, height: 1, ...common, points };
  }
  const width = mask.kind === 'ellipse' ? value('rx') * 2 : value('width');
  const height = mask.kind === 'ellipse' ? value('ry') * 2 : value('height');
  return {
    shape: mask.kind,
    x: fx(value('cx') - width / 2),
    y: fy(value('cy') - height / 2),
    width: width / scaleW / crop.width,
    height: height / scaleH / crop.height,
    ...common,
    points: [],
  };
}

/**
 * True when the mask changes nothing — a full-frame, unfeathered, opaque, non-inverted box.
 * Lets both players skip the masking pass instead of paying for an identity composite.
 */
export function isIdentityMask(mask: PreviewMask): boolean {
  return (
    !isPolygon(mask) &&
    mask.shape !== 'ellipse' &&
    !mask.invert &&
    mask.feather <= 0 &&
    mask.opacity >= 1 &&
    mask.x <= 0 &&
    mask.y <= 0 &&
    mask.x + mask.width >= 1 &&
    mask.y + mask.height >= 1
  );
}

/**
 * The mask as a CSS `mask-image` value for a DOM element that fills the frame.
 *
 * An SVG, because it is the one CSS mask source that expresses all four facts at once:
 * shape, blur feather, inversion and opacity. `preserveAspectRatio="none"` stretches it to
 * the element box, and the view box is the frame's own size so the blur radius is measured
 * in the same units the engine measures it in.
 *
 * @param mask - The resolved mask.
 * @param frame - The frame size (project resolution); only its proportions and scale matter.
 */
export function maskCssImage(
  mask: PreviewMask,
  frame: { readonly width: number; readonly height: number },
): string {
  const w = Math.max(1, Math.round(frame.width));
  const h = Math.max(1, Math.round(frame.height));
  const blur = mask.feather > 0 ? mask.feather * Math.min(w, h) : 0;
  const filter =
    blur > 0
      ? `<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">` +
        `<feGaussianBlur stdDeviation="${num(blur)}"/></filter>`
      : '';
  const filterRef = blur > 0 ? ' filter="url(#f)"' : '';
  const shape = shapeSvg(mask, w, h);
  const opacity = num(clamp01(mask.opacity));
  const body = mask.invert
    ? `<defs>${filter}<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">` +
      `<rect width="${w}" height="${h}" fill="white"/><g fill="black"${filterRef}>${shape}</g>` +
      `</mask></defs><rect width="${w}" height="${h}" fill="white" opacity="${opacity}" mask="url(#m)"/>`
    : `<defs>${filter}</defs><g fill="white" opacity="${opacity}"${filterRef}>${shape}</g>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
    `preserveAspectRatio="none">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The drawing calls {@link paintClipMask} needs — a structural slice of a 2D context. */
export type MaskPaintContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'rect'
  | 'ellipse'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
  | 'fillRect'
> & {
  filter: string;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  fillStyle: string | CanvasGradient | CanvasPattern;
};

/**
 * Mask the picture ALREADY drawn into `ctx`, in the context's current transform.
 *
 * `rect` is the frame box in that space, so a context carrying the picture's translate/
 * rotate/scale masks in the clip's own frame — the export's order. Must run on a layer that
 * holds only this clip's picture: `destination-in` clears everything outside the shape.
 */
export function paintClipMask(ctx: MaskPaintContext, mask: PreviewMask, rect: MaskRect): void {
  const blur = mask.feather > 0 ? mask.feather * Math.min(rect.width, rect.height) : 0;
  const opacity = clamp01(mask.opacity);
  ctx.save();
  // The picture already carries its own opacity; a mask drawn at that alpha would apply it
  // a second time through `destination-in`.
  ctx.globalAlpha = 1;
  ctx.filter = blur > 0.5 ? `blur(${blur.toFixed(2)}px)` : 'none';
  ctx.fillStyle = mask.invert ? 'rgba(0,0,0,1)' : `rgba(0,0,0,${num(opacity)})`;
  ctx.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in';
  traceShape(ctx, mask, rect);
  ctx.fill();
  if (mask.invert && opacity < 1) {
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${num(opacity)})`;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  ctx.restore();
}

function traceShape(ctx: MaskPaintContext, mask: PreviewMask, rect: MaskRect): void {
  ctx.beginPath();
  if (isPolygon(mask)) {
    mask.points.forEach(([px, py], index) => {
      const x = rect.x + px * rect.width;
      const y = rect.y + py * rect.height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    return;
  }
  const x = rect.x + mask.x * rect.width;
  const y = rect.y + mask.y * rect.height;
  const w = Math.max(0, mask.width * rect.width);
  const h = Math.max(0, mask.height * rect.height);
  if (mask.shape === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function shapeSvg(mask: PreviewMask, w: number, h: number): string {
  if (isPolygon(mask)) {
    const points = mask.points.map(([px, py]) => `${num(px * w)},${num(py * h)}`).join(' ');
    return `<polygon points="${points}"/>`;
  }
  const x = mask.x * w;
  const y = mask.y * h;
  const width = Math.max(0, mask.width * w);
  const height = Math.max(0, mask.height * h);
  if (mask.shape === 'ellipse') {
    return (
      `<ellipse cx="${num(x + width / 2)}" cy="${num(y + height / 2)}" ` +
      `rx="${num(width / 2)}" ry="${num(height / 2)}"/>`
    );
  }
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}"/>`;
}

function isPolygon(mask: PreviewMask): boolean {
  return mask.shape === 'polygon' && mask.points.length >= 3;
}

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Short, stable number formatting for markup — no float noise in the SVG. */
function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
