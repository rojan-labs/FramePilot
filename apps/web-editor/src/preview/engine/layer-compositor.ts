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
  drawnMasks,
  type ClipMaskStack,
  type MaskStackTarget,
  maskScalar,
  singleMaskAlpha,
  stackReadsPicture,
  type StackMask,
  type MatteStackInputs,
} from '../masks/mask-stack.js';
import { maskSourceTime } from '@framepilot/editor-core';
import { decontaminate } from '../masks/matte-edges.js';
import {
  MASK_BOX_FRAGMENT,
  MASK_DENOISE_FRAGMENT,
  MASK_DESPILL_FRAGMENT,
  MASK_KEY_FRAGMENT,
  MASK_LEVELS_FRAGMENT,
  MASK_MIX_ALPHA_FRAGMENT,
  MASK_MORPH_FRAGMENT,
  despillingKeys,
  keyUniforms,
  type KeyMask,
} from '../masks/key-mask.js';
import {
  FLAGGED_OUTLINE_PX,
  FLAGGED_RGB,
  MASK_VIEW_MODE,
  OVERLAY_TINT_STRENGTH,
  UNFLAGGED_RGB,
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
import { GlResources, type Program, type RenderTarget } from './gl/gl-resources.js';
import { pilBoxWeights, pilGaussianBoxRadius, pilRotationMatrix } from './raster/pil.js';
import {
  ALPHA_FRAGMENT,
  ROTATE_FRAGMENT,
  PIL_BOX_BLUR_FRAGMENT,
  BLEND_FRAGMENT,
  BLEND_MODE_INDEX,
  GRADE_FRAGMENT,
  LUT_FRAGMENT,
  MASK_COMBINE_FRAGMENT,
  MASK_MIX_FRAGMENT,
  MASK_QUANTIZE_FRAGMENT,
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

/** Combine modes in the order `MASK_COMBINE_FRAGMENT` branches on (`combine`, `mask_raster`). */
const MASK_COMBINE_MODES = [
  'add',
  'subtract',
  'intersect',
  'difference',
  'lighten',
  'darken',
] as const;

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
      /** BR5.2: under the Flagged view, whether this frame is flagged for review. */
      readonly flagged?: boolean;
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
                layer.flagged === true,
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
    flagged = false,
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
      // A key limiting this effect qualifies the effect's INPUT, as `_masked_effect` does.
      const coverage = this.stackCoverage(
        step.mask.stack,
        { kind: 'effect', effectId },
        input.width,
        input.height,
        step.mask.clipTime,
        mattes,
        input,
      );
      if (coverage !== null) current = this.mixByMask(input, current, coverage);
    });
    if (step.blurRadius > 0.5) current = this.pilGaussianBlur(current, step.blurRadius);
    // The picture the alpha stack's key qualifies: the frame as it stands before the cut,
    // which is the frame `_attach_mask` asks its source for.
    const keyed = current;
    const viewMode = MASK_VIEW_MODE[view];
    if (viewMode !== 0 && step.mask !== null) {
      // Overlay and mask-only views draw the stack instead of cutting the picture with it.
      const viewed = this.viewedStack(step, current.width, current.height, mattes, keyed);
      if (viewed !== null) {
        current = this.maskView(current, viewed.coverage, viewMode, viewed.color, flagged);
        if (step.opacity !== null || step.wipe !== null) {
          current = this.alpha(current, { ...step, mask: null }, null);
        }
      }
    } else if (step.opacity !== null || step.wipe !== null || hasAlphaMask(step)) {
      current = this.alpha(current, step, mattes, keyed);
    }
    // MK6.1: despill runs AFTER the stack is attached, because the qualifier has to read the
    // colour the camera recorded (`_apply_key_despill`). A refused stack despills nothing: the
    // export refuses the render outright, so half-applying it here would be a picture neither
    // side would produce.
    const despilling =
      step.mask === null || step.mask.stack.refusal !== null ? [] : despillingKeys(step.mask.stack);
    for (const mask of despilling) {
      current = this.despill(current, mask.despill as 'green' | 'blue');
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
    picture: RenderTarget | null = null,
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
        : this.stackCoverage(
            step.mask.stack,
            { kind: 'alpha' },
            source.width,
            source.height,
            step.mask.clipTime,
            mattes,
            picture,
          );
    gl.uniform1i(program.location('u_hasMask'), mask === null ? 0 : 1);
    gl.uniform1f(program.location('u_maskScale'), mask?.scale ?? 1);
    // An integer sampler must always see an integer texture, even when the branch skips it.
    r.bind(program, 'u_mask', 1, mask === null ? r.plane(1, 1, OPAQUE_COVERAGE) : mask.texture);
    r.draw(out, out.width, out.height);
    return out;
  }

  /**
   * A stack's coverage as the integer texture every mask shader samples, plus its float scale.
   *
   * Two ways in, one way out. A stack of shapes and mattes is rastered on the CPU by the
   * export's own algorithm and uploaded (the exact path, cached while nothing moves). A stack
   * holding a `key` cannot be: the qualifier reads the picture, so it is combined on the GPU —
   * each layer into a FLOAT accumulator, quantised once at the end, as `stack_alpha` quantises
   * once — and lands in `R8UI`, which is the format an uploaded raster lands in too. That is
   * why nothing downstream has to know which way the coverage was made.
   *
   * @param picture - The clip's decoded picture at this instant, which a key qualifies.
   * @returns `null` when the target draws nothing, or when a key stack has no picture to read.
   */
  private stackCoverage(
    stack: ClipMaskStack,
    target: MaskStackTarget,
    width: number,
    height: number,
    clipTime: number,
    mattes: MatteStackInputs | null,
    picture: RenderTarget | null,
  ): { texture: WebGLTexture; scale: number } | null {
    if (stack.refusal !== null || width <= 0 || height <= 0) return null;
    const masks = drawnMasks(stack, target, mattes);
    if (masks.length === 0) return null;
    if (!stackReadsPicture(masks)) {
      const raster = this.maskRasters.raster(stack, target, width, height, clipTime, mattes);
      return raster === null
        ? null
        : { texture: this.resources.plane(width, height, raster.alpha8), scale: raster.scale };
    }
    if (picture === null || picture.width !== width || picture.height !== height) return null;
    // The GPU stack accumulates in float, so it needs the same extension the effect layers do.
    if (!this.floatTargetsAvailable()) return null;
    return {
      texture: this.keyStack(stack, masks, width, height, clipTime, mattes, picture),
      scale: 1,
    };
  }

  /**
   * Whether float render targets exist. A key stack combines in float so it can quantise once,
   * as the export does; without them there is no honest way to build it, and the clip draws
   * uncut rather than with an alpha rounded seven times.
   */
  private floatTargetsAvailable(): boolean {
    if (this.effectsUnavailable) return false;
    if (!FrameEffectRenderer.supported(this.gl)) {
      this.effectsUnavailable = true;
      log.warn('key masks need float render targets, which this GPU lacks; the mask is skipped');
      return false;
    }
    return true;
  }

  /** `stack_alpha` for a stack that reads the picture: combine in float, quantise once. */
  private keyStack(
    stack: ClipMaskStack,
    masks: readonly StackMask[],
    width: number,
    height: number,
    clipTime: number,
    mattes: MatteStackInputs | null,
    picture: RenderTarget,
  ): WebGLTexture {
    const r = this.resources;
    const gl = this.gl;
    const s = maskSourceTime(stack.clip, clipTime);
    let accumulated = r.target(width, height, 'rgba32f');
    let first = true;
    for (const mask of masks) {
      const layer =
        mask.kind === 'key'
          ? this.keyLayer(mask, picture, maskScalar(mask, 'opacity', s))
          : r.floatPlane(
              width,
              height,
              Float32Array.from(singleMaskAlpha(mask, stack, width, height, s, mattes)),
            );
      const out = r.target(width, height, 'rgba32f');
      const program = r.program('mask-combine', MASK_COMBINE_FRAGMENT);
      gl.useProgram(program.handle);
      r.bind(program, 'u_accumulated', 0, accumulated.texture);
      r.bind(program, 'u_layer', 1, layer);
      program.int('u_mode', MASK_COMBINE_MODES.indexOf(mask.mode));
      program.int('u_first', first ? 1 : 0);
      first = false;
      r.draw(out, width, height);
      accumulated = out;
    }
    const quantised = r.target(width, height, 'r8ui');
    const program = r.program('mask-quantize', MASK_QUANTIZE_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_alpha', 0, accumulated.texture);
    r.draw(quantised, width, height);
    return quantised.texture;
  }

  /**
   * One `key` layer's alpha: the qualifier on the picture, then the finesse group, then invert
   * and opacity — `key_alpha` → `apply_finesse` → `layer_alpha`, in that order (MK6.1, MK6.2).
   */
  private keyLayer(mask: KeyMask, picture: RenderTarget, opacity: number): WebGLTexture {
    const r = this.resources;
    const gl = this.gl;
    const qualified = r.target(picture.width, picture.height, 'rgba32f');
    const program = r.program('mask-key', MASK_KEY_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_picture', 0, picture.texture);
    const uniforms = keyUniforms(mask, opacity);
    program.int('u_sampled', uniforms.sampled);
    program.int('u_rangeCount', uniforms.rangeCount);
    program.int('u_sampleCount', uniforms.sampleCount);
    gl.uniform4fv(program.location('u_ranges'), uniforms.ranges);
    gl.uniform4fv(program.location('u_samples'), uniforms.samples);
    gl.uniform1f(program.location('u_tolerance'), uniforms.tolerance);
    gl.uniform1f(program.location('u_shadow'), uniforms.shadowRetention);
    r.draw(qualified, qualified.width, qualified.height);
    return this.keyFinesse(qualified, mask.finesse, uniforms).texture;
  }

  /** One pass over the key's alpha, into a fresh float target. */
  private alphaPass(
    source: RenderTarget,
    name: string,
    fragment: string,
    setup: (program: Program) => void,
    second: RenderTarget | null = null,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba32f');
    const program = r.program(name, fragment);
    this.gl.useProgram(program.handle);
    r.bind(program, second === null ? 'u_alpha' : 'u_low', 0, source.texture);
    if (second !== null) r.bind(program, 'u_high', 1, second.texture);
    setup(program);
    r.draw(out, out.width, out.height);
    return out;
  }

  /** `_morphology_at`: one integer radius, or the mix of the two a fractional radius sits between. */
  private morphology(source: RenderTarget, radius: number, grow: boolean): RenderTarget {
    const magnitude = Math.abs(radius);
    if (magnitude <= 0) return source;
    const low = Math.floor(magnitude);
    const high = Math.ceil(magnitude);
    const at = (size: number): RenderTarget =>
      size <= 0
        ? source
        : this.alphaPass(source, 'mask-morph', MASK_MORPH_FRAGMENT, (program) => {
            program.int('u_radius', size);
            program.int('u_grow', grow ? 1 : 0);
          });
    const lowTarget = at(low);
    if (high === low) return lowTarget;
    return this.alphaPass(
      lowTarget,
      'mask-mix-alpha',
      MASK_MIX_ALPHA_FRAGMENT,
      (program) => this.gl.uniform1f(program.location('u_fraction'), magnitude - low),
      at(high),
    );
  }

  /** `blur`: three box passes of `round(radius / 3)`, each separable. */
  private blurAlpha(source: RenderTarget, radius: number): RenderTarget {
    if (radius <= 0) return source;
    const box = Math.max(1, Math.round(radius / 3));
    let current = source;
    for (let pass = 0; pass < 3; pass += 1) {
      for (const axis of [0, 1]) {
        current = this.alphaPass(current, 'mask-box', MASK_BOX_FRAGMENT, (program) => {
          program.int('u_radius', box);
          program.int('u_axis', axis);
        });
      }
    }
    return current;
  }

  /** `apply_finesse` then `layer_alpha`, in the order `key_mask_alpha` chains them. */
  private keyFinesse(
    qualified: RenderTarget,
    finesse: KeyMask['finesse'],
    uniforms: ReturnType<typeof keyUniforms>,
  ): RenderTarget {
    let current = qualified;
    if (finesse.denoise > 0) {
      current = this.alphaPass(current, 'mask-denoise', MASK_DENOISE_FRAGMENT, (program) =>
        this.gl.uniform1f(program.location('u_amount'), Math.min(finesse.denoise, 1)),
      );
    }
    const levels = uniforms.cleanBlack !== 0 || uniforms.cleanWhite !== 1;
    if (levels) {
      current = this.alphaPass(current, 'mask-levels', MASK_LEVELS_FRAGMENT, (program) =>
        this.levelsUniforms(program, uniforms, { levels: true, ratio: 0, layer: false }),
      );
    }
    if (finesse.morphOpenPx > 0) {
      current = this.morphology(
        this.morphology(current, finesse.morphOpenPx, false),
        finesse.morphOpenPx,
        true,
      );
    }
    if (finesse.morphClosePx > 0) {
      current = this.morphology(
        this.morphology(current, finesse.morphClosePx, true),
        finesse.morphClosePx,
        false,
      );
    }
    if (finesse.shrinkGrowPx !== 0) {
      current = this.morphology(current, Math.abs(finesse.shrinkGrowPx), finesse.shrinkGrowPx > 0);
    }
    current = this.blurAlpha(current, finesse.blurPx);
    return this.alphaPass(current, 'mask-levels', MASK_LEVELS_FRAGMENT, (program) =>
      this.levelsUniforms(program, uniforms, {
        levels: false,
        ratio: finesse.inOutRatio,
        layer: true,
      }),
    );
  }

  /** The pointwise tail's uniforms; `layer` false leaves invert and opacity for the last pass. */
  private levelsUniforms(
    program: Program,
    uniforms: ReturnType<typeof keyUniforms>,
    stage: { levels: boolean; ratio: number; layer: boolean },
  ): void {
    const gl = this.gl;
    gl.uniform1f(program.location('u_cleanBlack'), uniforms.cleanBlack);
    gl.uniform1f(program.location('u_cleanWhite'), uniforms.cleanWhite);
    gl.uniform1f(program.location('u_ratio'), stage.ratio);
    gl.uniform1f(program.location('u_invert'), stage.layer ? uniforms.invert : 0);
    gl.uniform1f(program.location('u_opacity'), stage.layer ? uniforms.opacity : 1);
    program.int('u_levels', stage.levels ? 1 : 0);
  }

  /** The despill limiter on the picture, where `_apply_key_despill` applies it. */
  private despill(source: RenderTarget, colour: 'green' | 'blue'): RenderTarget {
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba8');
    const program = r.program('mask-despill', MASK_DESPILL_FRAGMENT);
    this.gl.useProgram(program.handle);
    r.bind(program, 'u_picture', 0, source.texture);
    program.int('u_colour', colour === 'green' ? 1 : 2);
    r.draw(out, out.width, out.height);
    return out;
  }

  /** The stack a debug view shows: the alpha target, else the first effect target. */
  private viewedStack(
    step: PictureRasterStep,
    width: number,
    height: number,
    mattes: MatteStackInputs | null,
    picture: RenderTarget | null,
  ): { coverage: { texture: WebGLTexture; scale: number }; color: string | undefined } | null {
    const mask = step.mask;
    if (mask === null) return null;
    const { stack, clipTime } = mask;
    const target: MaskStackTarget =
      stack.alpha.length > 0
        ? { kind: 'alpha' }
        : (() => {
            const [effectId] = [...stack.byEffect][0] ?? [];
            return effectId === undefined
              ? { kind: 'alpha' }
              : { kind: 'effect', effectId: effectId };
          })();
    if (stack.alpha.length === 0 && target.kind === 'alpha') return null;
    const coverage = this.stackCoverage(stack, target, width, height, clipTime, mattes, picture);
    if (coverage === null) return null;
    const masks =
      target.kind === 'alpha' ? stack.alpha : (stack.byEffect.get(target.effectId) ?? []);
    return { coverage, color: masks[0]?.color };
  }

  /** MK3.3 overlay (`mode` 1) or mask-only (`mode` 2) view of a stack over its picture. */
  private maskView(
    source: RenderTarget,
    mask: { texture: WebGLTexture; scale: number },
    mode: number,
    color: string | undefined,
    flagged = false,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(source.width, source.height, 'rgba8');
    const program = r.program('mask-view', MASK_VIEW_FRAGMENT);
    const gl = this.gl;
    gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    r.bind(program, 'u_mask', 1, mask.texture);
    program.int('u_mode', mode);
    gl.uniform1f(program.location('u_scale'), mask.scale);
    const rgb = mode === 3 ? (flagged ? FLAGGED_RGB : UNFLAGGED_RGB) : maskColorRgb(color);
    gl.uniform3f(program.location('u_color'), ...rgb);
    program.int('u_outline', mode === 3 && flagged ? FLAGGED_OUTLINE_PX : 0);
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
    mask: { texture: WebGLTexture; scale: number },
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(original.width, original.height, 'rgba8');
    const program = r.program('mask-mix', MASK_MIX_FRAGMENT);
    const gl = this.gl;
    gl.useProgram(program.handle);
    r.bind(program, 'u_original', 0, original.texture);
    r.bind(program, 'u_effected', 1, effected.texture);
    r.bind(program, 'u_mask', 2, mask.texture);
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
