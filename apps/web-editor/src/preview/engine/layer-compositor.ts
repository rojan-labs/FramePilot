/**
 * The N-layer WebGL2 compositor (PX2.1, `plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md`).
 *
 * Executes the integer raster work `layer-raster.ts` derives from `framePlanAt`, back to front,
 * with the export's own arithmetic at every step:
 *
 *   decode (swscale, scaled or unscaled) → crop → matte decontamination → effects (with
 *   effect-target masks) → mask alpha → resize (Pillow LANCZOS)
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
import { FrameEffectRenderer, type FrameEffectInstance } from './gl/frame-effects.js';
import {
  directionSign,
  directionVector,
  transitionUniforms,
} from '../transitions/transition-engine.js';
import { pilCoefficients } from './raster/pil.js';
import type { CubeLut } from './raster/cube-lut.js';
import {
  MaskStackRasterCache,
  type MaskStackRaster,
  type MatteStackInputs,
} from '../masks/mask-stack.js';
import { decontaminate } from '../masks/matte-edges.js';
import {
  MASK_VIEW_MODE,
  OVERLAY_TINT_STRENGTH,
  layersForMaskView,
  maskColorRgb,
  type MaskDebugView,
} from '../masks/mask-view.js';
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
import { pilBoxWeights, pilGaussianBoxRadius, pilRotationMatrix } from './raster/pil.js';
import {
  ALPHA_FRAGMENT,
  ROTATE_FRAGMENT,
  PIL_BOX_BLUR_FRAGMENT,
  BLEND_FRAGMENT,
  BLEND_MODE_INDEX,
  GRADE_FRAGMENT,
  LUT_FRAGMENT,
  MASK_MIX_FRAGMENT,
  MASK_VIEW_FRAGMENT,
  CHECKERBOARD_FRAGMENT,
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
const OPAQUE_COVERAGE = new Uint8Array([255]);

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
  | {
      readonly kind: 'picture';
      readonly step: PictureRasterStep;
      readonly source: LayerSource;
      /** MK3.3: a mask debug view for this layer (the selected clip); absent = the program picture. */
      readonly maskView?: MaskDebugView;
      /** BR5.1: decoded matte frames for the clip's `matte` layers at this instant. */
      readonly mattes?: MatteStackInputs;
    }
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

/** Whether the export attaches the clip's alpha-target stack (`_attach_mask`). */
function hasAlphaMask(step: PictureRasterStep): boolean {
  return step.mask !== null && step.mask.stack.alpha.length > 0;
}

export class LayerCompositorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerCompositorUnavailableError';
  }
}

export class LayerCompositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly resources: GlResources;
  private readonly failedTransitions = new Set<string>();
  /** Exact mask stack rasters (`masks/mask-stack.ts`), cached by semantic signature. */
  private readonly maskRasters = new MaskStackRasterCache();
  private frameEffects: FrameEffectRenderer | null = null;
  private effectsUnavailable = false;
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
  constructor(
    createCanvas: () => HTMLCanvasElement | OffscreenCanvas = () =>
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : document.createElement('canvas'),
  ) {
    this.canvas = createCanvas();
    const gl = (this.canvas as HTMLCanvasElement).getContext('webgl2', {
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
  render(
    size: PixelSize,
    layers: readonly CompositeLayer[],
    output: 'bitmap' | 'pixels' = 'bitmap',
    effects: readonly FrameEffectInstance[] = [],
  ): CanvasImageSource | ImageData {
    if (this.canvas.width !== size.width) this.canvas.width = size.width;
    if (this.canvas.height !== size.height) this.canvas.height = size.height;
    const r = this.resources;
    try {
      let frame = r.target(size.width, size.height, 'rgba8');
      const viewed = layers.find(
        (layer) => layer.kind === 'picture' && (layer.maskView ?? 'off') !== 'off',
      );
      const view: MaskDebugView = viewed?.kind === 'picture' ? (viewed.maskView ?? 'off') : 'off';
      const shown = layersForMaskView(view, layers, (layer) => layer === viewed);
      if (shown.checkerboard) {
        const checker = r.program('checkerboard', CHECKERBOARD_FRAGMENT);
        this.gl.useProgram(checker.handle);
        r.draw(frame, size.width, size.height);
      } else {
        const fill = r.program('fill', FILL_FRAGMENT);
        this.gl.useProgram(fill.handle);
        fill.vec4('u_color', BACKGROUND);
        r.draw(frame, size.width, size.height);
      }

      const decodedMemo = new Map<string, RenderTarget>();
      for (const layer of shown.layers) {
        const placed =
          layer.kind === 'picture'
            ? this.rasterPicture(
                layer.step,
                layer.source,
                decodedMemo,
                layer.maskView ?? 'off',
                layer.mattes ?? null,
              )
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

      // A debug view shows the clip's own mask, not the adjustment lanes above it.
      if (effects.length > 0 && view === 'off') {
        if (this.frameEffects === null) {
          if (!this.effectsUnavailable && !FrameEffectRenderer.supported(this.gl)) {
            this.effectsUnavailable = true;
            log.warn('effect layers need float render targets, which this GPU lacks; skipped');
          }
          if (!this.effectsUnavailable) {
            this.frameEffects = new FrameEffectRenderer(this.gl, this.resources);
          }
        }
        if (this.frameEffects !== null) frame = this.frameEffects.apply(frame, effects);
      }
      if (output === 'pixels') {
        // Synchronous and exact: the frame target's rows are top-first, as ImageData's are. A
        // paused frame is read this way because a bitmap handed across GPU contexts has been
        // measured (CI) to reach the 2D canvas after a read of it.
        const pixels = new Uint8ClampedArray(size.width * size.height * 4);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, frame.framebuffer);
        this.gl.readPixels(
          0,
          0,
          size.width,
          size.height,
          this.gl.RGBA,
          this.gl.UNSIGNED_BYTE,
          pixels,
        );
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        return new ImageData(pixels, size.width, size.height);
      }
      const present = r.program('present', PRESENT_FRAGMENT);
      this.gl.useProgram(present.handle);
      r.bind(present, 'u_frame', 0, frame.texture);
      present.int('u_height', size.height);
      r.draw(null, size.width, size.height);
      // The frame just drawn, not the last one the browser presented: `drawImage` of a WebGL
      // canvas can return the previous drawing buffer (measured on CI: every read lagged one
      // seek). `transferToImageBitmap` hands over exactly this buffer.
      if (typeof OffscreenCanvas !== 'undefined' && this.canvas instanceof OffscreenCanvas) {
        return this.canvas.transferToImageBitmap();
      }
      return this.canvas as HTMLCanvasElement;
    } finally {
      r.endFrame();
    }
  }

  private rasterPicture(
    step: PictureRasterStep,
    source: LayerSource,
    decodedMemo: Map<string, RenderTarget>,
    view: MaskDebugView = 'off',
    mattes: MatteStackInputs | null = null,
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
    if (mattes !== null && step.mask !== null) current = this.decontaminate(current, step, mattes);
    step.effects.forEach((effect, index) => {
      const input = current;
      if (effect.type === 'color_grade') current = this.grade(input, effect.params);
      else if (effect.type === 'lut') current = this.lut(input, effect.params);
      else return;
      // An effect-target mask mixes the effect's output with its input by the stack's alpha,
      // inside the effect application (`_masked_effect`), before any blur or alpha.
      const effectId = step.effectIds[index] ?? null;
      if (step.mask === null || effectId === null || current === input) return;
      const raster = this.maskRasters.raster(
        step.mask.stack,
        { kind: 'effect', effectId },
        input.width,
        input.height,
        step.mask.clipTime,
        mattes,
      );
      if (raster !== null) current = this.mixByMask(input, current, raster);
    });
    if (step.blurRadius > 0.5) current = this.pilGaussianBlur(current, step.blurRadius);
    const viewMode = MASK_VIEW_MODE[view];
    if (viewMode !== 0 && step.mask !== null) {
      // Overlay and mask-only views draw the stack instead of cutting the picture with it.
      const viewed = this.viewedStack(step, current.width, current.height, mattes);
      if (viewed !== null) {
        current = this.maskView(current, viewed.raster, viewMode, viewed.color);
        if (step.opacity !== null || step.wipe !== null) {
          current = this.alpha(current, { ...step, mask: null }, null);
        }
      }
    } else if (step.opacity !== null || step.wipe !== null || hasAlphaMask(step)) {
      current = this.alpha(current, step, mattes);
    }
    for (const half of step.transitions) {
      current = this.transition(current, half);
    }
    if (step.resize !== null) {
      current = this.pilResize(current, step.resize.width, step.resize.height);
    }
    if (step.rotation !== 0) {
      current = this.rotate(current, step.rotation);
      // A clip without a mask rotates as RGB only: the corners it uncovers are opaque black.
      const masked =
        step.assetKind === 'image' ||
        step.opacity !== null ||
        step.wipe !== null ||
        hasAlphaMask(step) ||
        step.transitions.length > 0;
      if (!masked) current = this.copy(current, 0, 0, current.width, current.height, 255);
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

  /** Pillow `GaussianBlur(radius)`: three extended box passes across, then three down. */
  private pilGaussianBlur(source: RenderTarget, radius: number): RenderTarget {
    const { radius: boxRadius, ww, fw } = pilBoxWeights(pilGaussianBoxRadius(radius));
    const r = this.resources;
    const program = r.program('pil-box-blur', PIL_BOX_BLUR_FRAGMENT);
    let current = source;
    for (const axis of [0, 0, 0, 1, 1, 1]) {
      const out = r.target(current.width, current.height, 'rgba8');
      this.gl.useProgram(program.handle);
      r.bind(program, 'u_source', 0, current.texture);
      program.int('u_axis', axis);
      program.int('u_radius', Math.min(512, boxRadius));
      this.gl.uniform1ui(program.location('u_ww'), ww);
      this.gl.uniform1ui(program.location('u_fw'), fw);
      r.draw(out, out.width, out.height);
      current = out;
    }
    return current;
  }

  /**
   * `_apply_matte_decontamination`: each decontaminating matte (bottom of the stack first)
   * replaces the edge band's colour with its foreground estimate, before any effect or alpha.
   * Exact float64 arithmetic, so it runs on the CPU over a read-back of the cropped picture.
   */
  private decontaminate(
    source: RenderTarget,
    step: PictureRasterStep,
    mattes: MatteStackInputs,
  ): RenderTarget {
    const stack = step.mask!.stack;
    const cleaning = [...stack.mattes]
      .reverse()
      .filter((mask) => mask.decontaminate)
      .map((mask) => mattes.frames.get(mask.id) ?? null)
      .filter((frame) => frame !== null && frame.foreground !== null);
    if (cleaning.length === 0) return source;
    const gl = this.gl;
    const pixels = new Uint8Array(source.width * source.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, source.framebuffer);
    gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const frame of cleaning) {
      decontaminate(
        pixels,
        source.width,
        source.height,
        4,
        frame!,
        stack.clip.crop,
        mattes.decodedWidth,
        mattes.decodedHeight,
      );
    }
    return this.resources.bytesTarget(pixels, source.width, source.height);
  }

  private alpha(
    source: RenderTarget,
    step: PictureRasterStep,
    mattes: MatteStackInputs | null,
  ): RenderTarget {
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
    // The clip's alpha-target stack at the cropped picture's own size (`_attach_mask`).
    const mask =
      step.mask === null || step.mask.stack.alpha.length === 0
        ? null
        : this.maskRasters.raster(
            step.mask.stack,
            { kind: 'alpha' },
            source.width,
            source.height,
            step.mask.clipTime,
            mattes,
          );
    gl.uniform1i(program.location('u_hasMask'), mask === null ? 0 : 1);
    gl.uniform1f(program.location('u_maskScale'), mask?.scale ?? 1);
    // An integer sampler must always see an integer texture, even when the branch skips it.
    const texture =
      mask === null
        ? r.plane(1, 1, OPAQUE_COVERAGE)
        : r.plane(source.width, source.height, mask.alpha8);
    r.bind(program, 'u_mask', 1, texture);
    r.draw(out, out.width, out.height);
    return out;
  }

  /** The stack a debug view shows: the alpha target, else the first effect target. */
  private viewedStack(
    step: PictureRasterStep,
    width: number,
    height: number,
    mattes: MatteStackInputs | null,
  ): { raster: MaskStackRaster; color: string | undefined } | null {
    const mask = step.mask;
    if (mask === null) return null;
    const { stack, clipTime } = mask;
    if (stack.alpha.length > 0) {
      const raster = this.maskRasters.raster(
        stack,
        { kind: 'alpha' },
        width,
        height,
        clipTime,
        mattes,
      );
      return raster === null ? null : { raster, color: stack.alpha[0]?.color };
    }
    const [effectId, masks] = [...stack.byEffect][0] ?? [];
    if (effectId === undefined) return null;
    const raster = this.maskRasters.raster(
      stack,
      { kind: 'effect', effectId },
      width,
      height,
      clipTime,
      mattes,
    );
    return raster === null ? null : { raster, color: masks?.[0]?.color };
  }

  /** MK3.3 overlay (`mode` 1) or mask-only (`mode` 2) view of a stack over its picture. */
  private maskView(
    source: RenderTarget,
    mask: MaskStackRaster,
    mode: number,
    color: string | undefined,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba8');
    const program = r.program('mask-view', MASK_VIEW_FRAGMENT);
    const gl = this.gl;
    gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    r.bind(program, 'u_mask', 1, r.plane(mask.width, mask.height, mask.alpha8));
    program.int('u_mode', mode);
    gl.uniform1f(program.location('u_scale'), mask.scale);
    gl.uniform3f(program.location('u_color'), ...maskColorRgb(color));
    gl.uniform1f(program.location('u_strength'), OVERLAY_TINT_STRENGTH);
    r.draw(out, out.width, out.height);
    return out;
  }

  /**
   * `mix_by_alpha(original, effected, alpha)`: `rint(o + (e - o) * alpha)` per RGB channel. A
   * quantised stack (`alpha = q / 255`) never lands on a tie, so the integer form is exact.
   */
  private mixByMask(
    original: RenderTarget,
    effected: RenderTarget,
    mask: MaskStackRaster,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(original.width, original.height, 'rgba8');
    const program = r.program('mask-mix', MASK_MIX_FRAGMENT);
    const gl = this.gl;
    gl.useProgram(program.handle);
    r.bind(program, 'u_original', 0, original.texture);
    r.bind(program, 'u_effected', 1, effected.texture);
    r.bind(program, 'u_mask', 2, r.plane(mask.width, mask.height, mask.alpha8));
    gl.uniform1f(program.location('u_scale'), mask.scale);
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

  /** MoviePy `rotated(angle, expand=False)` → Pillow `rotate` (see {@link pilRotationMatrix}). */
  private rotate(source: RenderTarget, degrees: number): RenderTarget {
    const matrix = pilRotationMatrix(degrees, source.width, source.height);
    if (matrix === null) return source;
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba8');
    const program = r.program('rotate', ROTATE_FRAGMENT);
    const gl = this.gl;
    gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    gl.uniform3f(program.location('u_rowX'), matrix[0], matrix[1], matrix[2]);
    gl.uniform3f(program.location('u_rowY'), matrix[3], matrix[4], matrix[5]);
    r.draw(out, out.width, out.height);
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
      this.resources.useScratchUnit();
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
