/**
 * The N-layer WebGL2 compositor (PX2.1, `plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md`).
 *
 * Executes the integer raster work `layer-raster.ts` derives from `framePlanAt`, back to front,
 * with the export's own arithmetic at every step:
 *
 *   decode (swscale, scaled or unscaled) → crop → mask alpha → resize (Pillow LANCZOS)
 *   → paste at an integer position (Pillow `alpha_composite`)
 *
 * The finished frame is drawn into this compositor's own WebGL canvas; the engine copies it to
 * the program monitor's 2D canvas (which the parity oracle and every existing hook read).
 * Premultiplication does not happen anywhere: the export composites straight alpha with
 * integer rounding, and so does this.
 *
 * Framebuffer-object pool: every intermediate is a pooled render target returned at the end of
 * the frame, so a steady timeline allocates nothing per frame.
 */
import { createLogger } from '@framepilot/shared-types';
import type { DecodedPicture, I420Picture } from '../decode/decoded-picture.js';
import type { PictureRasterStep, PixelSize } from './layer-raster.js';
import { pilCoefficients } from './raster/pil.js';
import {
  swsFilter,
  swsMatrixOf,
  swsRgbTables,
  swsUnscaledCoefficients,
  SWS_HORIZONTAL_FILTER_ALIGN,
  SWS_HORIZONTAL_ONE,
  SWS_VERTICAL_FILTER_ALIGN,
  SWS_VERTICAL_ONE,
  type SwsFilter,
} from './raster/swscale.js';
import { GlResources, type RenderTarget } from './gl/gl-resources.js';
import {
  COMPOSITE_FRAGMENT,
  COPY_FRAGMENT,
  FILL_FRAGMENT,
  MAX_TAPS,
  PIL_RESAMPLE_FRAGMENT,
  PRESENT_FRAGMENT,
  SWS_HORIZONTAL_FRAGMENT,
  SWS_UNSCALED_FRAGMENT,
  SWS_VERTICAL_RGB_FRAGMENT,
} from './gl/raster-shaders.js';

const log = createLogger('web-editor:preview:layer-compositor');

/** The export composites on opaque black. */
const BACKGROUND: readonly [number, number, number, number] = [0, 0, 0, 1];

/** A picture the compositor can draw a {@link PictureRasterStep} from. */
export type LayerSource =
  | { readonly kind: 'decoded'; readonly key: string; readonly picture: DecodedPicture }
  | {
      readonly kind: 'image';
      readonly key: string;
      readonly image: TexImageSource;
      readonly width: number;
      readonly height: number;
    };

/** One layer of a frame, back to front. */
export type CompositeLayer =
  | { readonly kind: 'picture'; readonly step: PictureRasterStep; readonly source: LayerSource }
  | {
      /** A pre-rasterised RGBA layer (text, captions) placed at an integer position. */
      readonly kind: 'raster';
      readonly key: string;
      readonly image: TexImageSource;
      readonly width: number;
      readonly height: number;
      readonly x: number;
      readonly y: number;
    };

export class LayerCompositorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerCompositorUnavailableError';
  }
}

export class LayerCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly resources: GlResources;
  private warnedRotation = false;

  /**
   * @throws LayerCompositorUnavailableError when the browser has no WebGL2 context (the monitor
   *   shows that in place; it never falls back to a different renderer).
   */
  constructor(createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')) {
    this.canvas = createCanvas();
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new LayerCompositorUnavailableError('WebGL2 is unavailable for the preview.');
    this.gl = gl;
    this.resources = new GlResources(gl);
  }

  /**
   * Composite one frame into {@link canvas}.
   *
   * @param size - The frame, in pixels (the canvas is resized to it).
   * @param layers - Back to front.
   */
  render(size: PixelSize, layers: readonly CompositeLayer[]): void {
    if (this.canvas.width !== size.width) this.canvas.width = size.width;
    if (this.canvas.height !== size.height) this.canvas.height = size.height;
    const r = this.resources;
    try {
      let frame = r.target(size.width, size.height, 'rgba8');
      const fill = r.program('fill', FILL_FRAGMENT);
      this.gl.useProgram(fill.handle);
      fill.vec4('u_color', BACKGROUND);
      r.draw(frame, size.width, size.height);

      const decodedMemo = new Map<string, RenderTarget>();
      for (const layer of layers) {
        const placed =
          layer.kind === 'picture'
            ? this.rasterPicture(layer.step, layer.source, decodedMemo)
            : {
                target: r.imageTarget(layer.image, layer.width, layer.height),
                x: layer.x,
                y: layer.y,
              };
        if (placed === null) continue;
        frame = this.composite(frame, placed.target, placed.x, placed.y, size);
      }

      const present = r.program('present', PRESENT_FRAGMENT);
      this.gl.useProgram(present.handle);
      r.bind(present, 'u_frame', 0, frame.texture);
      present.int('u_height', size.height);
      r.draw(null, size.width, size.height);
    } finally {
      r.endFrame();
    }
  }

  private rasterPicture(
    step: PictureRasterStep,
    source: LayerSource,
    decodedMemo: Map<string, RenderTarget>,
  ): { target: RenderTarget; x: number; y: number } | null {
    // PX2.4: two layers showing the same frame at the same decode size share one decode.
    const decodeKey =
      step.decode.kind === 'scaled'
        ? `${source.key}|${step.decode.width}x${step.decode.height}`
        : `${source.key}|native`;
    let picture = decodedMemo.get(decodeKey);
    if (picture === undefined) {
      picture = this.decode(step, source);
      decodedMemo.set(decodeKey, picture);
    }
    let current = picture;
    if (step.crop !== null || step.alpha8 !== null) {
      const rect = step.crop ?? { x: 0, y: 0, width: current.width, height: current.height };
      if (rect.width <= 0 || rect.height <= 0) return null;
      current = this.copy(current, rect.x, rect.y, rect.width, rect.height, step.alpha8);
    }
    if (step.resize !== null) {
      current = this.pilResize(current, step.resize.width, step.resize.height);
    }
    if (step.rotation !== 0 && !this.warnedRotation) {
      this.warnedRotation = true;
      log.warn('layer rotation is not rasterised yet; drawing unrotated', {
        rotation: step.rotation,
      });
    }
    return { target: current, x: step.x, y: step.y };
  }

  private decode(step: PictureRasterStep, source: LayerSource): RenderTarget {
    const r = this.resources;
    if (source.kind === 'image') {
      const image = r.imageTarget(source.image, source.width, source.height);
      return image;
    }
    const picture = source.picture;
    if (picture.kind === 'frame') {
      const upload = r.imageTarget(picture.frame, picture.width, picture.height);
      return step.decode.kind === 'scaled'
        ? this.pilResize(upload, step.decode.width, step.decode.height)
        : upload;
    }
    return step.decode.kind === 'scaled'
      ? this.swsScaled(picture, step.decode.width, step.decode.height)
      : this.swsUnscaled(picture);
  }

  private swsUnscaled(picture: I420Picture): RenderTarget {
    const r = this.resources;
    const gl = this.gl;
    const chromaWidth = (picture.width + 1) >> 1;
    const chromaHeight = (picture.height + 1) >> 1;
    const y = r.plane(picture.width, picture.height, picture.y);
    const u = r.plane(chromaWidth, chromaHeight, picture.u);
    const v = r.plane(chromaWidth, chromaHeight, picture.v);
    const out = r.target(picture.width, picture.height, 'rgba8');
    const program = r.program('sws-unscaled', SWS_UNSCALED_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_y', 0, y);
    r.bind(program, 'u_u', 1, u);
    r.bind(program, 'u_v', 2, v);
    const c = swsUnscaledCoefficients(swsMatrixOf(picture.matrix), picture.fullRange === true);
    program.int('u_yCoeff', c.yCoeff);
    program.int('u_yOffset', c.yOffset);
    program.int('u_vrCoeff', c.vrCoeff);
    program.int('u_ubCoeff', c.ubCoeff);
    program.int('u_ugCoeff', c.ugCoeff);
    program.int('u_vgCoeff', c.vgCoeff);
    r.draw(out, out.width, out.height);
    return out;
  }

  private filterTexture(prefix: string, filter: SwsFilter): WebGLTexture {
    return this.resources.intTable(
      `${prefix}:${filter.srcSize}:${filter.dstSize}:${filter.size}`,
      filter.dstSize,
      filter.size + 1,
      () => {
        const data = new Int32Array(filter.dstSize * (filter.size + 1));
        for (let i = 0; i < filter.dstSize; i++) {
          data[i] = filter.positions[i]!;
          for (let j = 0; j < filter.size; j++) {
            data[(j + 1) * filter.dstSize + i] = filter.coefficients[i * filter.size + j]!;
          }
        }
        return data;
      },
    );
  }

  private swsHorizontal(
    plane: WebGLTexture,
    height: number,
    filter: SwsFilter,
    prefix: string,
  ): RenderTarget {
    const r = this.resources;
    if (filter.size > MAX_TAPS) {
      throw new Error(
        `swscale filter needs ${filter.size} taps; the compositor supports ${MAX_TAPS}.`,
      );
    }
    const out = r.target(filter.dstSize, height, 'r16i');
    const program = r.program('sws-horizontal', SWS_HORIZONTAL_FRAGMENT);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_plane', 0, plane);
    r.bind(program, 'u_filter', 1, this.filterTexture(prefix, filter));
    program.int('u_size', filter.size);
    r.draw(out, out.width, out.height);
    return out;
  }

  private swsScaled(picture: I420Picture, width: number, height: number): RenderTarget {
    const r = this.resources;
    const gl = this.gl;
    const chromaWidth = (picture.width + 1) >> 1;
    const chromaHeight = (picture.height + 1) >> 1;
    const chromaDstWidth = (width + 1) >> 1;
    const lumaH = swsFilter(picture.width, width, SWS_HORIZONTAL_ONE, SWS_HORIZONTAL_FILTER_ALIGN);
    const chromaH = swsFilter(
      chromaWidth,
      chromaDstWidth,
      SWS_HORIZONTAL_ONE,
      SWS_HORIZONTAL_FILTER_ALIGN,
    );
    const lumaV = swsFilter(picture.height, height, SWS_VERTICAL_ONE, SWS_VERTICAL_FILTER_ALIGN);
    const chromaV = swsFilter(chromaHeight, height, SWS_VERTICAL_ONE, SWS_VERTICAL_FILTER_ALIGN);
    if (lumaV.size > MAX_TAPS || chromaV.size > MAX_TAPS) {
      throw new Error(`swscale vertical filter exceeds ${MAX_TAPS} taps.`);
    }

    const lumaLines = this.swsHorizontal(
      r.plane(picture.width, picture.height, picture.y),
      picture.height,
      lumaH,
      'sws-h',
    );
    const uLines = this.swsHorizontal(
      r.plane(chromaWidth, chromaHeight, picture.u),
      chromaHeight,
      chromaH,
      'sws-h',
    );
    const vLines = this.swsHorizontal(
      r.plane(chromaWidth, chromaHeight, picture.v),
      chromaHeight,
      chromaH,
      'sws-h',
    );

    const out = r.target(width, height, 'rgba8');
    const program = r.program('sws-vertical-rgb', SWS_VERTICAL_RGB_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_lumaLines', 0, lumaLines.texture);
    r.bind(program, 'u_uLines', 1, uLines.texture);
    r.bind(program, 'u_vLines', 2, vLines.texture);
    r.bind(program, 'u_lumaFilter', 3, this.filterTexture('sws-v', lumaV));
    r.bind(program, 'u_chromaFilter', 4, this.filterTexture('sws-v', chromaV));
    program.int('u_lumaSize', lumaV.size);
    program.int('u_chromaSize', chromaV.size);
    const tables = swsRgbTables(swsMatrixOf(picture.matrix), picture.fullRange === true);
    program.int('u_crv', tables.crv);
    program.int('u_cbu', tables.cbu);
    program.int('u_cgu', tables.cgu);
    program.int('u_cgv', tables.cgv);
    program.int('u_yOffset', tables.yOffset);
    program.int('u_cy', tables.cy);
    program.int('u_yb', tables.yb);
    r.draw(out, width, height);
    return out;
  }

  private copy(
    source: RenderTarget,
    x: number,
    y: number,
    width: number,
    height: number,
    alpha8: number | null,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(width, height, 'rgba8');
    const program = r.program('copy', COPY_FRAGMENT);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    program.ivec2('u_origin', x, y);
    program.int('u_alpha8', alpha8 ?? -1);
    r.draw(out, width, height);
    return out;
  }

  /** Pillow `resize(LANCZOS)`: horizontal pass when the width changes, then vertical. */
  private pilResize(source: RenderTarget, width: number, height: number): RenderTarget {
    let current = source;
    if (width !== current.width) current = this.pilAxis(current, width, current.height, 0);
    if (height !== current.height) current = this.pilAxis(current, current.width, height, 1);
    return current;
  }

  private pilAxis(source: RenderTarget, width: number, height: number, axis: 0 | 1): RenderTarget {
    const r = this.resources;
    const inSize = axis === 0 ? source.width : source.height;
    const outSize = axis === 0 ? width : height;
    const coefficients = pilCoefficients(inSize, outSize);
    if (coefficients.ksize > MAX_TAPS) {
      throw new Error(
        `Lanczos resize needs ${coefficients.ksize} taps; the compositor supports ${MAX_TAPS}.`,
      );
    }
    const table = r.intTable(`pil:${inSize}:${outSize}`, outSize, coefficients.ksize + 2, () => {
      const data = new Int32Array(outSize * (coefficients.ksize + 2));
      for (let i = 0; i < outSize; i++) {
        data[i] = coefficients.bounds[i * 2]!;
        data[outSize + i] = coefficients.bounds[i * 2 + 1]!;
        for (let k = 0; k < coefficients.ksize; k++) {
          data[(k + 2) * outSize + i] = coefficients.weights[i * coefficients.ksize + k]!;
        }
      }
      return data;
    });
    const out = r.target(width, height, 'rgba8');
    const program = r.program('pil-resample', PIL_RESAMPLE_FRAGMENT);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    r.bind(program, 'u_coefficients', 1, table);
    program.int('u_axis', axis);
    r.draw(out, width, height);
    return out;
  }

  private composite(
    frame: RenderTarget,
    layer: RenderTarget,
    x: number,
    y: number,
    size: PixelSize,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(size.width, size.height, 'rgba8');
    const program = r.program('composite', COMPOSITE_FRAGMENT);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_frame', 0, frame.texture);
    r.bind(program, 'u_layer', 1, layer.texture);
    program.ivec2('u_position', x, y);
    program.ivec2('u_size', layer.width, layer.height);
    r.draw(out, size.width, size.height);
    return out;
  }

  dispose(): void {
    this.resources.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
