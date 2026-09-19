/**
 * The in-page half of the PX4 preview/export pixel comparison, shared by the parity oracle
 * (`preview-parity-oracle.spec.ts`) and the masking end-to-end specs (`masking-e2e-*.spec.ts`).
 *
 * Moved here verbatim from the oracle so there is ONE comparison: a spec that claims "the
 * preview frame equals the export frame" measures it with the same readback, the same
 * flattening onto the frame background and the same per-channel arithmetic the oracle's gates
 * were set on. The gates themselves stay with each caller.
 */
import type { Page } from '@playwright/test';

export type Rgb = [number, number, number];

/** Per-pixel thresholds the in-page pass needs (the caller owns the gate values). */
export interface CompareGates {
  /** A pixel is "within tolerance" when every channel differs by at most this (0-255). */
  readonly channelTolerance: number;
  /** A pixel "is" a sentinel within this Chebyshev distance. */
  readonly sentinelRadius: number;
}

export interface PageCompare {
  presented: {
    projectTimeSec: number;
    layers: { role: string; sourceId?: string; kind: string; timestampUs: number | null }[];
  } | null;
  width: number;
  height: number;
  engineWidth: number;
  engineHeight: number;
  psnr: number | null;
  withinFraction: number | null;
  maxChannelError: number | null;
  sentinel: {
    engine: Record<string, number>;
    preview: Record<string, number>;
    disagreements: number;
  } | null;
  previewPng: string | null;
  diffPng: string | null;
  diagnostic: Record<string, unknown> | null;
}

/**
 * Seek the live engine to `time`, read the canvas back flattened onto the plan's background
 * (the export frame has no alpha; the monitor shows the canvas over the frame background), and
 * compare with the engine PNG. Runs entirely in the page: the canvas, the PNG decode and the
 * arithmetic all stay where the pixels are, and no image dependency is needed.
 */
export async function seekAndCompare(
  page: Page,
  args: {
    time: number;
    background: Rgb;
    engineUrl: string | null;
    palette: { name: string; rgb: Rgb }[];
    wantImages: boolean;
  },
  gates: CompareGates,
): Promise<PageCompare> {
  return page.evaluate(
    async ({ time, background, engineUrl, palette, wantImages, gates }) => {
      type Engine = {
        seek(t: number): Promise<void>;
        debugPresentedFrame(): PageCompare['presented'];
      };
      const engine = (window as unknown as { __fpPreviewEngine?: Engine }).__fpPreviewEngine;
      const canvas = document.querySelector<HTMLCanvasElement>('.webcodecs-preview-canvas');
      if (!engine || !canvas) throw new Error('WebCodecs engine or canvas missing');
      let presented: PageCompare['presented'] = null;
      let preview: Uint8ClampedArray | null = null;
      for (let attempt = 0; attempt < 8 && preview === null; attempt++) {
        await engine.seek(time);
        const now = engine.debugPresentedFrame();
        // A React effect may re-seek to the same paused time; anything else is a superseded seek.
        if (now && Math.abs(now.projectTimeSec - time) < 1e-9) {
          presented = {
            projectTimeSec: now.projectTimeSec,
            layers: now.layers.map((l) => ({ ...l })),
          };
          preview = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      const width = canvas.width;
      const height = canvas.height;
      const result: PageCompare = {
        presented,
        width,
        height,
        engineWidth: 0,
        engineHeight: 0,
        psnr: null,
        withinFraction: null,
        maxChannelError: null,
        sentinel: null,
        previewPng: null,
        diffPng: null,
        diagnostic: null,
      };
      if (preview === null) return result;
      const [br, bg, bb] = background;
      const flat = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const a = preview[i * 4 + 3]! / 255;
        flat[i * 4] = Math.round(preview[i * 4]! * a + br * (1 - a));
        flat[i * 4 + 1] = Math.round(preview[i * 4 + 1]! * a + bg * (1 - a));
        flat[i * 4 + 2] = Math.round(preview[i * 4 + 2]! * a + bb * (1 - a));
        flat[i * 4 + 3] = 255;
      }
      const toPng = async (
        pixels: Uint8ClampedArray<ArrayBuffer>,
        w: number,
        h: number,
      ): Promise<string> => {
        const out = new OffscreenCanvas(w, h);
        out.getContext('2d')!.putImageData(new ImageData(pixels, w, h), 0, 0);
        const blob = await out.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      };
      if (wantImages) result.previewPng = await toPng(flat, width, height);
      if (engineUrl === null) return result;

      const bitmap = await createImageBitmap(await (await fetch(engineUrl)).blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      result.engineWidth = bitmap.width;
      result.engineHeight = bitmap.height;
      if (bitmap.width !== width || bitmap.height !== height) {
        bitmap.close();
        return result;
      }
      const engineCanvas = new OffscreenCanvas(width, height);
      const engineCtx = engineCanvas.getContext('2d')!;
      engineCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const ref = engineCtx.getImageData(0, 0, width, height).data;

      const n = width * height;
      let squared = 0;
      let within = 0;
      let maxError = 0;
      const diff = wantImages ? new Uint8ClampedArray(n * 4) : null;
      for (let i = 0; i < n; i++) {
        let pixelMax = 0;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(flat[i * 4 + c]! - ref[i * 4 + c]!);
          squared += d * d;
          if (d > pixelMax) pixelMax = d;
        }
        if (pixelMax <= gates.channelTolerance) within++;
        if (pixelMax > maxError) maxError = pixelMax;
        if (diff) {
          // Heat map: within tolerance = dim green scaled by error, beyond = red scaled by error.
          const over = pixelMax > gates.channelTolerance;
          diff[i * 4] = over ? 96 + Math.min(159, pixelMax) : 0;
          diff[i * 4 + 1] = over ? 0 : pixelMax * 8;
          diff[i * 4 + 2] = 0;
          diff[i * 4 + 3] = 255;
        }
      }
      const mse = squared / (n * 3);
      result.psnr = mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
      result.withinFraction = within / n;
      result.maxChannelError = maxError;
      if (diff) result.diffPng = await toPng(diff, width, height);
      if (result.psnr < 20) {
        // Far off: record what was read, then read again without seeking, to tell a blank canvas
        // from a blank reference and a late draw from a wrong one.
        const centre = (width * (height >> 1) + (width >> 1)) * 4;
        const px = (data: ArrayLike<number>, o: number) => [0, 1, 2, 3].map((k) => data[o + k]);
        let opaque = 0;
        for (let i = 0; i < n; i++) if (preview[i * 4 + 3]! > 0) opaque++;
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
        const again = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
        let changed = 0;
        for (let i = 0; i < again.length; i++) if (again[i] !== preview[i]) changed++;
        const later = engine.debugPresentedFrame();
        result.diagnostic = {
          previewCentre: px(preview, centre),
          engineCentre: px(ref, centre),
          previewNonTransparentPx: opaque,
          rereadChangedBytes: changed,
          rereadCentre: px(again, centre),
          canvasConnected: canvas.isConnected,
          canvases: document.querySelectorAll('.webcodecs-preview-canvas').length,
          engineStillHooked:
            (window as unknown as { __fpPreviewEngine?: Engine }).__fpPreviewEngine === engine,
          presentedAfter: later ? later.projectTimeSec : null,
          pictures:
            (
              engine as unknown as { debugPresentedPictures?: () => unknown }
            ).debugPresentedPictures?.() ?? null,
          // BR5.4: how each matte layer resolved (ready / unprocessed / refused, and the index
          // range its artifact holds) — the one fact a matte row's pixels cannot show.
          mattes:
            (
              engine as unknown as { debugPresentedMattes?: () => unknown }
            ).debugPresentedMattes?.() ?? null,
        };
      }

      // Sentinel classes: -1 = no sentinel; a class counts only where its 3x3 block agrees.
      const classify = (px: Uint8ClampedArray): Int16Array => {
        const classes = new Int16Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < palette.length; k++) {
            const [r, g, b] = palette[k]!.rgb;
            if (
              Math.abs(px[i * 4]! - r) <= gates.sentinelRadius &&
              Math.abs(px[i * 4 + 1]! - g) <= gates.sentinelRadius &&
              Math.abs(px[i * 4 + 2]! - b) <= gates.sentinelRadius
            ) {
              classes[i] = k;
              break;
            }
          }
        }
        const solid = new Int16Array(n).fill(-1);
        for (let y = 1; y < height - 1; y++) {
          for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const k = classes[i]!;
            if (k < 0) continue;
            let uniform = true;
            for (let dy = -1; dy <= 1 && uniform; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (classes[i + dy * width + dx] !== k) {
                  uniform = false;
                  break;
                }
              }
            }
            if (uniform) solid[i] = k;
          }
        }
        return solid;
      };
      const engineClasses = classify(ref);
      const previewClasses = classify(flat);
      const count = (classes: Int16Array): Record<string, number> => {
        const counts: Record<string, number> = {};
        for (const k of classes)
          if (k >= 0) counts[palette[k]!.name] = (counts[palette[k]!.name] ?? 0) + 1;
        return counts;
      };
      let disagreements = 0;
      for (let i = 0; i < n; i++) {
        const e = engineClasses[i]!;
        const p = previewClasses[i]!;
        if (e >= 0 && p >= 0 && e !== p) disagreements++;
      }
      result.sentinel = {
        engine: count(engineClasses),
        preview: count(previewClasses),
        disagreements,
      };
      return result;
    },
    { ...args, gates },
  );
}
