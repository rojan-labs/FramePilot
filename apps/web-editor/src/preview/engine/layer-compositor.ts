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
import type { LayerTransition, PictureRasterStep, PixelSize } from './layer-raster.js';
import { transitionPassSource } from './gl/transition-pass.js';
import {
  directionSign,
  directionVector,
  transitionUniforms,
} from '../transitions/transition-engine.js';
import { pilCoefficients } from './raster/pil.js';
import type { CubeLut } from './raster/cube-lut.js';
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
  ALPHA_FRAGMENT,
  BLEND_FRAGMENT,
  BLEND_MODE_INDEX,
  GRADE_FRAGMENT,
  LUT_FRAGMENT,
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
/** Transition noise clock quantum — the effect chain's and the engine's. */
const TRANSITION_TIME_QUANTUM = 1 / 60;

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
  private readonly failedTransitions = new Set<string>();
  private readonly lutTextures = new Map<CubeLut, WebGLTexture>();
  private luts: ReadonlyMap<string, CubeLut> = new Map();

  /** Loaded LUTs by the `lut` effect's stored path. */
  setLuts(luts: ReadonlyMap<string, CubeLut>): void {
    this.luts = luts;
  }

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
        const mode = layer.kind === 'picture' ? (BLEND_MODE_INDEX[layer.step.blendMode] ?? 0) : 0;
        frame =
          mode === 0
            ? this.composite(frame, placed.target, placed.x, placed.y, size)
            : this.blend(frame, placed.target, placed.x, placed.y, size, mode);
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
    if (step.crop !== null) {
      const rect = step.crop;
      if (rect.width <= 0 || rect.height <= 0) return null;
      current = this.copy(current, rect.x, rect.y, rect.width, rect.height, null);
    }
    for (const effect of step.effects) {
      if (effect.type === 'color_grade') current = this.grade(current, effect.params);
      else if (effect.type === 'lut') current = this.lut(current, effect.params);
    }
    if (step.opacity !== null || step.wipe !== null) {
      current = this.alpha(current, step);
    }
    for (const half of step.transitions) {
      current = this.transition(current, half);
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

  private alpha(source: RenderTarget, step: PictureRasterStep): RenderTarget {
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba8');
    const program = r.program('alpha', ALPHA_FRAGMENT);
    const gl = this.gl;
    gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    gl.uniform1f(program.location('u_opacity'), step.opacity ?? 1);
    const wipe = step.wipe;
    program.int('u_wipeAxis', wipe === null ? 0 : wipe.axis === 'x' ? 1 : 2);
    gl.uniform1i(program.location('u_wipeInverted'), wipe?.inverted ? 1 : 0);
    gl.uniform1f(program.location('u_wipeEdge'), wipe?.edge ?? 1);
    gl.uniform1f(program.location('u_wipeFeather'), wipe?.feather ?? 1);
    r.draw(out, out.width, out.height);
    return out;
  }

  private transition(source: RenderTarget, half: LayerTransition): RenderTarget {
    const r = this.resources;
    const gl = this.gl;
    const kind = half.transition.renderKind;
    const fragment = transitionPassSource(kind);
    if (fragment === null) return source;
    let program;
    try {
      program = r.program(`transition:${kind}`, fragment);
    } catch (error) {
      if (!this.failedTransitions.has(kind)) {
        this.failedTransitions.add(kind);
        log.error('transition pass failed to compile; drawing the clip untransitioned', {
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return source;
    }
    const out = r.target(source.width, source.height, 'rgba8');
    gl.useProgram(program.handle);
    // The passes sample between texels exactly as the numpy `sample_bilinear` does.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    program.int('uTex', 0);
    r.bind(program, 'uAlphaSource', 1, source.texture);
    const t = half.transition;
    gl.uniform2f(program.location('uResolution'), source.width, source.height);
    gl.uniform1f(program.location('uProgress'), half.eased);
    gl.uniform1f(program.location('uIntensity'), t.intensity);
    gl.uniform1f(program.location('uSoftness'), t.softness);
    const [dx, dy] = directionVector(t.direction);
    gl.uniform2f(program.location('uDirection'), dx, -dy);
    gl.uniform1f(program.location('uDirSign'), directionSign(t.direction));
    gl.uniform1i(
      program.location('uNoiseFrame'),
      Math.floor(Math.max(0, half.eased * t.duration) / TRANSITION_TIME_QUANTUM),
    );
    gl.uniform1fv(program.location('uParams'), transitionUniforms(t));
    program.int('uRole', half.role === 'in' ? 0 : 1);
    r.draw(out, out.width, out.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return out;
  }

  private grade(source: RenderTarget, params: Readonly<Record<string, unknown>>): RenderTarget {
    const value = (name: string): number => {
      const raw = params[name];
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;
      return Number.isFinite(number) ? number : 0;
    };
    const names = [
      'exposure',
      'contrast',
      'saturation',
      'temperature',
      'tint',
      'shadows',
      'highlights',
    ] as const;
    if (names.every((name) => value(name) === 0)) return source;
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba8');
    const program = r.program('grade', GRADE_FRAGMENT);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    for (const name of names) {
      this.gl.uniform1f(program.location(`u_${name}`), value(name));
    }
    r.draw(out, out.width, out.height);
    return out;
  }

  private lut(source: RenderTarget, params: Readonly<Record<string, unknown>>): RenderTarget {
    const path = typeof params.path === 'string' ? params.path : '';
    const table = this.luts.get(path);
    if (table === undefined) return source;
    const gl = this.gl;
    let texture = this.lutTextures.get(table);
    if (texture === undefined) {
      const created = gl.createTexture();
      if (!created) return source;
      texture = created;
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGB32F, table.size, table.size, table.size);
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        0,
        table.size,
        table.size,
        table.size,
        gl.RGB,
        gl.FLOAT,
        table.table,
      );
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.lutTextures.set(table, texture);
    }
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba8');
    const program = r.program('lut', LUT_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    program.int('u_table', 1);
    program.int('u_size', table.size);
    gl.uniform3f(program.location('u_domainMin'), ...table.domainMin);
    gl.uniform3f(program.location('u_domainMax'), ...table.domainMax);
    r.draw(out, out.width, out.height);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, null);
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

  private blend(
    frame: RenderTarget,
    layer: RenderTarget,
    x: number,
    y: number,
    size: PixelSize,
    mode: number,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(size.width, size.height, 'rgba8');
    const program = r.program('blend', BLEND_FRAGMENT);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_frame', 0, frame.texture);
    r.bind(program, 'u_layer', 1, layer.texture);
    program.ivec2('u_position', x, y);
    program.ivec2('u_size', layer.width, layer.height);
    program.int('u_mode', mode);
    r.draw(out, size.width, size.height);
    return out;
  }

  dispose(): void {
    for (const texture of this.lutTextures.values()) this.gl.deleteTexture(texture);
    this.lutTextures.clear();
    this.resources.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
