/**
 * The exact mask stack raster on the two non-GL monitors (MK3.2): the legacy WebCodecs 2D
 * canvas path and the DOM `PreviewPlayer`, both kill-switch paths until RD3 retires them.
 *
 * WHY: they drew today's single-shape masks with canvas/SVG primitives (`clip-mask.ts`,
 * deleted), which disagreed with the export at every edge and ignored every mask after the
 * first. Both now draw the SAME raster the layer compositor uploads (`mask-stack.ts`), turned
 * into an alpha-only image: `destination-in` on a canvas, a CSS `mask-image` on an element.
 * Scaling that image onto the picture is the browser's, so these paths stay approximate at
 * the edge; the parity path is the layer compositor.
 */
import type { MaskStackRaster } from './mask-stack.js';

type MaskCanvas = HTMLCanvasElement | OffscreenCanvas;

const canvases = new WeakMap<MaskStackRaster, MaskCanvas | null>();
const dataUrls = new WeakMap<MaskStackRaster, string | null>();

function createCanvas(width: number, height: number): MaskCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** White pixels whose alpha is the raster's (`alpha8 × scale`, rounded to 8 bits). */
export function maskRasterRgba(raster: MaskStackRaster): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(new ArrayBuffer(raster.width * raster.height * 4));
  for (let i = 0; i < raster.alpha8.length; i += 1) {
    const offset = i * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = Math.round(raster.alpha8[i]! * raster.scale);
  }
  return rgba;
}

/** The raster as an alpha image, built once per raster; `null` where no canvas exists. */
export function maskRasterCanvas(raster: MaskStackRaster): MaskCanvas | null {
  if (canvases.has(raster)) return canvases.get(raster) ?? null;
  const canvas = createCanvas(raster.width, raster.height);
  const ctx = canvas?.getContext('2d') as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
  let result: MaskCanvas | null = null;
  if (canvas && ctx) {
    ctx.putImageData(new ImageData(maskRasterRgba(raster), raster.width, raster.height), 0, 0);
    result = canvas;
  }
  canvases.set(raster, result);
  return result;
}

/** The drawing calls {@link paintMaskRaster} needs: a structural slice of a 2D context. */
export type MaskPaintContext = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'drawImage'> & {
  filter: string;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
};

/**
 * Mask the picture ALREADY drawn into `ctx` (a layer holding only this clip's picture) by the
 * raster stretched over `rect`, in the context's current transform.
 */
export function paintMaskRaster(
  ctx: MaskPaintContext,
  raster: MaskStackRaster,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const image = maskRasterCanvas(raster);
  if (image === null) return;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

/** The raster as a CSS `mask-image` value, or `undefined` where no canvas can encode it. */
export function maskRasterCssImage(raster: MaskStackRaster): string | undefined {
  if (dataUrls.has(raster)) return dataUrls.get(raster) ?? undefined;
  let url: string | null = null;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(new ImageData(maskRasterRgba(raster), raster.width, raster.height), 0, 0);
      url = `url("${canvas.toDataURL('image/png')}")`;
    }
  }
  dataUrls.set(raster, url);
  return url ?? undefined;
}
