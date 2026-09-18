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
import type { PreviewTelemetry } from './preview-telemetry.js';
import type { CubeLut } from './raster/cube-lut.js';
import {
  MaskStackRasterCache,
  drawnMasks,
  type ClipMaskStack,
  type MaskStackTarget,
  maskScalar,
  singleMaskAlpha,
  stackReadsPicture,
  type FramePlacement,
  type MatteMask,
  type StackMask,
  type MatteStackInputs,
} from '../masks/mask-stack.js';
import { maskSourceTime, type FramePlanEdgeStyle } from '@framepilot/editor-core';
import {
  EDGE_COLUMN_FRAGMENT,
  EDGE_COMPOSITE_FRAGMENT,
  EDGE_KIND_INDEX,
  EDGE_MAX_STYLES,
  EDGE_PREVIEW_MAX_REACH,
  EDGE_ROW_FRAGMENT,
  edgeDistanceScale,
  edgeReach,
  edgeShift,
  edgeSize,
} from '../masks/edge-styles.js';
import {
  MASK_LAYER_FRAGMENT,
  layerMatteUniforms,
  stackReadsLayers,
  type LayerMask,
  type PicturePlacement,
} from '../masks/layer-mattes.js';
import {
  decontaminate,
  decontaminateFromPlanes,
  planesFit,
  type MatteFrameData,
  type MattePlanes,
} from '../masks/matte-edges.js';
import {
  MASK_DESPILL_FRAGMENT,
  MASK_KEY_FRAGMENT,
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
import { swsUnscaledConverter } from './raster/sws-host.js';
import { GlResources, type Program, type RenderTarget } from './gl/gl-resources.js';
import { AlphaPasses } from './gl/alpha-passes.js';
import { MattePass, type MatteFrameGeometry } from './gl/matte-pass.js';
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
  SWS_UNSCALED_TABLES_FRAGMENT,
  SWS_VERTICAL_RGB_FRAGMENT,
} from './gl/raster-shaders.js';

const log = createLogger('web-editor:preview:layer-compositor');

/** The export composites on opaque black. */
const BACKGROUND: readonly [number, number, number, number] = [0, 0, 0, 1];
/** Transition noise clock quantum — the effect chain's and the engine's. */
const TRANSITION_TIME_QUANTUM = 1 / 60;
const OPAQUE_COVERAGE = new Uint8Array([255]);

/** Track mattes whose source has its own track matte, followed this many levels deep (MK8.2). */
const MAX_MATTE_DEPTH = 4;

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
      /**
       * MK8.2: per `layer` mask id, the layers its source is made of at this instant (back to
       * front) — the frame plan's `matteOnly` layers, composited alone for the matte. An empty
       * list is a source that draws nothing here.
       */
      readonly layerMattes?: ReadonlyMap<string, readonly CompositeLayer[]>;
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
  /** The finesse passes a `key` layer's alpha runs through (shared with the matte pass). */
  private readonly keyPasses: AlphaPasses;
  /** PX5.3: a `matte` layer's alpha and decontamination as float passes. */
  private readonly mattePass: MattePass;
  private readonly failedTransitions = new Set<string>();
  /** Exact mask stack rasters (`masks/mask-stack.ts`), cached by semantic signature. */
  private readonly maskRasters = new MaskStackRasterCache();
  private frameEffects: FrameEffectRenderer | null = null;
  private effectsUnavailable = false;
  private floatTargets: boolean | null = null;
  private readonly lutTextures = new Map<CubeLut, WebGLTexture>();
  private luts: ReadonlyMap<string, CubeLut> = new Map();
  private telemetry: PreviewTelemetry | null = null;
  private readonly syncPixel = new Uint8Array(4);
  /** The frame being composited (a track matte's source is composited at this size, MK8.2). */
  private frameSize: PixelSize = { width: 0, height: 0 };
  /** This frame's shared decodes, so a matte source reuses a picture the frame already decoded. */
  private frameDecodes = new Map<string, RenderTarget>();
  /** The picture layer being rastered: its track matte sources and where it lands (MK8.2). */
  private layerContext: {
    readonly sources: ReadonlyMap<string, readonly CompositeLayer[]>;
    readonly step: PictureRasterStep;
  } | null = null;
  /** How deep track mattes are nested (a matte whose source has its own track matte). */
  private matteDepth = 0;
  /**
   * The picture layer being rastered, whatever its masks: a frame-space clip mask (MK9.1) is read
   * back through where this picture lands, like a track matte.
   */
  private pictureStep: PictureRasterStep | null = null;

  /** Where this compositor reports mask raster, key stack and pool numbers (PX5.1). */
  setTelemetry(telemetry: PreviewTelemetry | null): void {
    this.telemetry = telemetry;
  }

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
    this.keyPasses = new AlphaPasses(this.resources, 'rgba32f');
    this.mattePass = new MattePass(this.resources);
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
      this.frameSize = size;
      this.frameDecodes = decodedMemo;
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
                layer.layerMattes ?? null,
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
      // Measurement mode only: a one-pixel read-back is the round trip that really waits for
      // the GPU. `gl.finish()` does not under Chrome's command buffer (measured on ANGLE/Metal:
      // it returned in 0.0 ms with a dozen float passes queued).
      if (this.telemetry?.gpuSync === true) {
        this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.syncPixel);
      }
      if (typeof OffscreenCanvas !== 'undefined' && this.canvas instanceof OffscreenCanvas) {
        return this.canvas.transferToImageBitmap();
      }
      return this.canvas as HTMLCanvasElement;
    } finally {
      r.endFrame();
      this.telemetry?.gauge('glPoolBytes', r.poolBytes);
      this.telemetry?.gauge('glPoolTargets', r.poolTextures);
    }
  }

  /**
   * One picture layer through the export's steps. A layer with track mattes (MK8.2) makes them
   * the context its stack is built in, restored afterwards, because a matte's source can itself
   * be a picture layer with track mattes of its own.
   */
  private rasterPicture(
    step: PictureRasterStep,
    source: LayerSource,
    decodedMemo: Map<string, RenderTarget>,
    view: MaskDebugView = 'off',
    mattes: MatteStackInputs | null = null,
    flagged = false,
    layerMattes: ReadonlyMap<string, readonly CompositeLayer[]> | null = null,
  ): { target: RenderTarget; x: number; y: number } | null {
    const outer = this.layerContext;
    const outerStep = this.pictureStep;
    this.layerContext = layerMattes === null ? null : { sources: layerMattes, step };
    this.pictureStep = step;
    try {
      return this.rasterPictureSteps(step, source, decodedMemo, view, mattes, flagged);
    } finally {
      this.layerContext = outer;
      this.pictureStep = outerStep;
    }
  }

  private rasterPictureSteps(
    step: PictureRasterStep,
    source: LayerSource,
    decodedMemo: Map<string, RenderTarget>,
    view: MaskDebugView,
    mattes: MatteStackInputs | null,
    flagged: boolean,
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
    // MK9.2: the outline, glow and shadow go under the cut picture, after despill, as
    // `_apply_edge_styles` draws them. Not in the mask views, which show the stack itself.
    if (viewMode === 0 && step.edgeStyles.length > 0 && step.mask !== null) {
      current = this.edgeStyles(current, step, mattes, keyed);
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
    // MK6.4: the converter this host's export runs, so a same-size decode matches it byte for byte.
    if (swsUnscaledConverter() === 'tables') {
      const program = r.program('sws-unscaled-tables', SWS_UNSCALED_TABLES_FRAGMENT);
      gl.useProgram(program.handle);
      r.bind(program, 'u_y', 0, y);
      r.bind(program, 'u_u', 1, u);
      r.bind(program, 'u_v', 2, v);
      this.bindRgbTables(program, picture);
      r.draw(out, out.width, out.height);
      return out;
    }
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
    this.bindRgbTables(program, picture);
    r.draw(out, width, height);
    return out;
  }

  /** The lookup-table uniforms `SWS_RGB_TABLES_GLSL` declares, for this picture's encoding. */
  private bindRgbTables(program: Program, picture: I420Picture): void {
    const tables = swsRgbTables(swsMatrixOf(picture.matrix), picture.fullRange === true);
    program.int('u_crv', tables.crv);
    program.int('u_cbu', tables.cbu);
    program.int('u_cgu', tables.cgu);
    program.int('u_cgv', tables.cgv);
    program.int('u_yOffset', tables.yOffset);
    program.int('u_cy', tables.cy);
    program.int('u_yb', tables.yb);
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
   *
   * PX5.3: on the GPU, because the float64 twin over a read-back of the picture cost 324 ms a
   * frame for a 4K matte. The twin stays for a GPU without float targets and for a plane the
   * shader's resample loop cannot carry, so neither case loses the decontamination. A frame
   * whose monitor-tier planes are at the decoded size is drawn from them (the export's own
   * planes, resampled once by the engine), whether or not its foreground master is also known,
   * so one frame is always drawn one way.
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
      .filter(
        (frame): frame is MatteFrameData =>
          frame !== null &&
          // The masters path needs the samples too (PX5.8: a frame may carry only the tier's
          // alpha plane); the lookup decodes both whenever the planes do not fit.
          ((frame.foreground !== null && frame.alpha !== null) ||
            planesFit(frame, mattes.decodedWidth, mattes.decodedHeight)),
      );
    if (cleaning.length === 0) return source;
    const geometry = this.matteGeometry(stack, source.width, source.height, mattes);
    const fromPlanes = (
      frame: MatteFrameData,
    ): frame is MatteFrameData & { readonly planes: MattePlanes } =>
      planesFit(frame, mattes.decodedWidth, mattes.decodedHeight);
    // Not `floatTargetsAvailable`: that one refuses a key; a matte keeps its CPU twin instead.
    const onGpu =
      this.floatTargetsSupported() &&
      cleaning.every((frame) =>
        fromPlanes(frame)
          ? this.mattePass.carriesPlanes(frame, geometry)
          : this.mattePass.carriesFrame(frame, geometry),
      );
    if (onGpu) {
      const started = performance.now();
      let current = source;
      for (const frame of cleaning) {
        current = fromPlanes(frame)
          ? this.mattePass.decontaminatePlanes(current, frame, geometry)
          : this.mattePass.decontaminate(current, frame, geometry);
      }
      this.telemetry?.record('matteStack', performance.now() - started);
      return current;
    }
    const started = performance.now();
    const gl = this.gl;
    const pixels = new Uint8Array(source.width * source.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, source.framebuffer);
    gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const frame of cleaning) {
      if (planesFit(frame, mattes.decodedWidth, mattes.decodedHeight)) {
        decontaminateFromPlanes(
          pixels,
          source.width,
          source.height,
          4,
          frame.planes,
          stack.clip.crop,
        );
        continue;
      }
      decontaminate(
        pixels,
        source.width,
        source.height,
        4,
        frame,
        stack.clip.crop,
        mattes.decodedWidth,
        mattes.decodedHeight,
      );
    }
    this.telemetry?.record('maskRaster', performance.now() - started);
    return this.resources.bytesTarget(pixels, source.width, source.height);
  }

  /** Where a matte plane of `stack`'s clip lands: its crop, its frame and its decode size. */
  private matteGeometry(
    stack: ClipMaskStack,
    width: number,
    height: number,
    mattes: MatteStackInputs,
  ): MatteFrameGeometry {
    return {
      crop: stack.clip.crop,
      width,
      height,
      decodedWidth: mattes.decodedWidth,
      decodedHeight: mattes.decodedHeight,
    };
  }

  private alpha(
    source: RenderTarget,
    step: PictureRasterStep,
    mattes: MatteStackInputs | null,
    picture: RenderTarget | null = null,
  ): RenderTarget {
    const r = this.resources;
    // The clip's alpha-target stack at the cropped picture's own size (`_attach_mask`). Built
    // BEFORE this pass binds its program: a stack built on the GPU binds and draws its own, and
    // the uniforms below would otherwise land on whichever of them ran last.
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
    const readsPicture = stackReadsPicture(masks);
    // MK8.2: a track matte reads another layer's composited picture, so its stack is built on
    // the GPU too, like a key's.
    const readsLayers = stackReadsLayers(masks);
    // PX5.3: a stack holding a matte is combined on the GPU like one holding a key, so the
    // float64 twin (170 ms of main thread for a 4K matte) never runs during playback. Only a
    // layer whose radii the shaders cannot carry, or a GPU without float targets, keeps it.
    const matteOnGpu =
      !readsPicture &&
      !readsLayers &&
      this.mattesCarried(stack, masks, width, height, maskSourceTime(stack.clip, clipTime), mattes);
    if (!readsPicture && !readsLayers && !matteOnGpu) {
      const drawsBefore = this.maskRasters.drawCount;
      const started = performance.now();
      const raster = this.maskRasters.raster(
        stack,
        target,
        width,
        height,
        clipTime,
        mattes,
        this.framePlacement(width, height),
      );
      if (this.maskRasters.drawCount !== drawsBefore) {
        this.telemetry?.record('maskRaster', performance.now() - started);
      } else if (raster !== null) {
        this.telemetry?.countMaskRasterCacheHit();
      }
      return raster === null
        ? null
        : { texture: this.resources.plane(width, height, raster.alpha8), scale: raster.scale };
    }
    if (readsPicture) {
      if (picture === null || picture.width !== width || picture.height !== height) return null;
      // The GPU stack accumulates in float, so it needs the same extension the effect layers do.
      if (!this.floatTargetsAvailable()) return null;
    }
    if (readsLayers && !this.floatTargetsAvailable()) return null;
    const started = performance.now();
    const texture = this.gpuStack(stack, masks, width, height, clipTime, mattes, picture);
    // Submission time: the GPU runs the chain later. Its real cost is read from the composite
    // channels with and without the chain (`PX5-BUDGETS.md`), not from this sample.
    this.telemetry?.record(readsPicture ? 'keyStack' : 'matteStack', performance.now() - started);
    return { texture, scale: 1 };
  }

  /**
   * The clip's cut-out edge styles under its picture (MK9.2, `render/edge_styles.py`): per style a
   * row and a column distance pass over the alpha stack's coverage, then one composite. Needs
   * float targets; without them the picture is shown without its styles and the log says why.
   */
  private edgeStyles(
    picture: RenderTarget,
    step: PictureRasterStep,
    mattes: MatteStackInputs | null,
    keyed: RenderTarget,
  ): RenderTarget {
    const stack = step.mask!.stack;
    if (stack.size === null || !this.floatTargetsAvailable()) return picture;
    const { width, height } = picture;
    const coverage = this.stackCoverage(
      stack,
      { kind: 'alpha' },
      width,
      height,
      step.mask!.clipTime,
      mattes,
      keyed,
    );
    if (coverage === null) return picture;
    const scale = edgeDistanceScale(stack.clip.crop, stack.size, width, height);
    const r = this.resources;
    const gl = this.gl;
    const drawn: { style: FramePlanEdgeStyle; distance: RenderTarget }[] = [];
    for (const style of step.edgeStyles.slice(0, EDGE_MAX_STYLES)) {
      const reach = edgeReach(style, scale);
      if (reach > EDGE_PREVIEW_MAX_REACH) {
        log.warn('edge style too wide for the monitor; the export still draws it', {
          clipId: stack.clip.id,
          kind: style.kind,
        });
        continue;
      }
      const [dx, dy] = edgeShift(style, scale);
      const row = r.target(width, height, 'r32f');
      const rowProgram = r.program('edge-row', EDGE_ROW_FRAGMENT);
      gl.useProgram(rowProgram.handle);
      r.bind(rowProgram, 'u_mask', 0, coverage.texture);
      gl.uniform1f(rowProgram.location('u_maskScale'), coverage.scale);
      rowProgram.ivec2('u_shift', dx, dy);
      rowProgram.int('u_reach', reach);
      r.draw(row, width, height);
      const column = r.target(width, height, 'r32f');
      const columnProgram = r.program('edge-column', EDGE_COLUMN_FRAGMENT);
      gl.useProgram(columnProgram.handle);
      r.bind(columnProgram, 'u_row', 0, row.texture);
      columnProgram.int('u_reach', reach);
      r.draw(column, width, height);
      drawn.push({ style, distance: column });
    }
    if (drawn.length === 0) return picture;
    const out = r.target(width, height, 'rgba8');
    const program = r.program('edge-composite', EDGE_COMPOSITE_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_picture', 0, picture.texture);
    const kinds = [0, 0, 0];
    const sizes = [0, 0, 0];
    const opacities = [0, 0, 0];
    drawn.forEach(({ style, distance }, index) => {
      r.bind(program, `u_distance${String(index)}`, 1 + index, distance.texture);
      kinds[index] = EDGE_KIND_INDEX[style.kind];
      sizes[index] = edgeSize(style, scale);
      opacities[index] = style.params.opacity ?? 1;
      gl.uniform3f(
        program.location(`u_colour${String(index)}`),
        (style.params.red ?? 0) / 255,
        (style.params.green ?? 0) / 255,
        (style.params.blue ?? 0) / 255,
      );
    });
    // Unused samplers still need a texture of the right kind bound.
    for (let index = drawn.length; index < EDGE_MAX_STYLES; index += 1) {
      r.bind(program, `u_distance${String(index)}`, 1 + index, drawn[0]!.distance.texture);
    }
    program.int('u_count', drawn.length);
    gl.uniform3i(program.location('u_kind'), kinds[0]!, kinds[1]!, kinds[2]!);
    gl.uniform3f(program.location('u_size'), sizes[0]!, sizes[1]!, sizes[2]!);
    gl.uniform3f(program.location('u_opacity'), opacities[0]!, opacities[1]!, opacities[2]!);
    gl.uniform1f(program.location('u_clipOpacity'), step.opacity ?? 1);
    r.draw(out, width, height);
    return out;
  }

  /**
   * Where the picture being rastered lands on the frame, for a `width`×`height` raster of it
   * (`picture_placement_at`): the step's resize, PIL rotation and integer paste, the same
   * numbers a track matte reads through. `null` outside a picture layer.
   */
  private framePlacement(width: number, height: number): FramePlacement | null {
    const step = this.pictureStep;
    if (step === null) return null;
    const placement: PicturePlacement = {
      localWidth: width,
      localHeight: height,
      width: step.resize?.width ?? width,
      height: step.resize?.height ?? height,
      rotation: step.rotation,
      x: step.x,
      y: step.y,
    };
    return {
      placement,
      frameWidth: this.frameSize.width,
      frameHeight: this.frameSize.height,
    };
  }

  /**
   * Whether `masks` holds a matte and every matte in it can be drawn by the GPU pass now: float
   * targets exist and each layer's radii fit the shaders (`MattePass.carries`).
   */
  private mattesCarried(
    stack: ClipMaskStack,
    masks: readonly StackMask[],
    width: number,
    height: number,
    sourceTime: number,
    mattes: MatteStackInputs | null,
  ): boolean {
    if (mattes === null || !masks.some((mask) => mask.kind === 'matte')) return false;
    if (!this.floatTargetsSupported()) return false;
    const geometry = this.matteGeometry(stack, width, height, mattes);
    return masks.every((mask) => {
      if (mask.kind !== 'matte') return true;
      const frame = mattes.frames.get(mask.id) ?? null;
      return frame !== null && this.mattePass.carries(mask, frame, geometry, sourceTime);
    });
  }

  /** One matte layer on the GPU when the pass carries it, `null` for the CPU twin. */
  private matteLayer(
    mask: MatteMask,
    stack: ClipMaskStack,
    width: number,
    height: number,
    sourceTime: number,
    mattes: MatteStackInputs | null,
  ): WebGLTexture | null {
    const frame = mattes?.frames.get(mask.id) ?? null;
    if (mattes === null || frame === null) return null;
    const geometry = this.matteGeometry(stack, width, height, mattes);
    if (!this.mattePass.carries(mask, frame, geometry, sourceTime)) return null;
    return this.mattePass.layer(mask, frame, geometry, sourceTime);
  }

  /** Whether float render targets exist (`EXT_color_buffer_float`), asked once. */
  private floatTargetsSupported(): boolean {
    this.floatTargets ??= FrameEffectRenderer.supported(this.gl);
    return this.floatTargets;
  }

  /**
   * Whether float render targets exist. A key stack combines in float so it can quantise once,
   * as the export does; without them there is no honest way to build it, and the clip draws
   * uncut rather than with an alpha rounded seven times.
   */
  private floatTargetsAvailable(): boolean {
    if (this.effectsUnavailable) return false;
    if (!this.floatTargetsSupported()) {
      this.effectsUnavailable = true;
      log.warn('key masks need float render targets, which this GPU lacks; the mask is skipped');
      return false;
    }
    return true;
  }

  /**
   * `stack_alpha` for a stack built on the GPU: each layer into a float accumulator, quantised
   * once. A key is qualified from `picture`, a matte runs the matte pass (PX5.3), and a shape
   * (or a matte the pass cannot carry) comes from the exact rasteriser as a float plane.
   */
  private gpuStack(
    stack: ClipMaskStack,
    masks: readonly StackMask[],
    width: number,
    height: number,
    clipTime: number,
    mattes: MatteStackInputs | null,
    picture: RenderTarget | null,
  ): WebGLTexture {
    const r = this.resources;
    const gl = this.gl;
    const s = maskSourceTime(stack.clip, clipTime);
    let accumulated = r.target(width, height, 'rgba32f');
    let first = true;
    for (const mask of masks) {
      const layer =
        mask.kind === 'key'
          ? // `stackCoverage` only builds a key stack with the picture it qualifies in hand.
            this.keyLayer(mask, picture!, maskScalar(mask, 'opacity', s))
          : mask.kind === 'layer'
            ? this.layerMatteLayer(mask, width, height, maskScalar(mask, 'opacity', s))
            : ((mask.kind === 'matte'
                ? this.matteLayer(mask, stack, width, height, s, mattes)
                : null) ??
              r.floatPlane(
                width,
                height,
                Float32Array.from(
                  singleMaskAlpha(
                    mask,
                    stack,
                    width,
                    height,
                    s,
                    mattes,
                    this.framePlacement(width, height),
                  ),
                ),
              ));
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

  /**
   * One track matte's alpha (MK8.2): the source composited alone on a transparent frame, read
   * where each of this clip's pixels lands (`MASK_LAYER_FRAGMENT`), then the key's finesse passes
   * and tail — `sampled_channel` → `apply_finesse` → `layer_alpha`, as `layer_mask_alpha` chains.
   */
  private layerMatteLayer(
    mask: LayerMask,
    width: number,
    height: number,
    opacity: number,
  ): WebGLTexture {
    const r = this.resources;
    const gl = this.gl;
    const context = this.layerContext;
    const source = this.matteSourceFrame(context?.sources.get(mask.id) ?? []);
    const step = context?.step;
    const placement: PicturePlacement = {
      localWidth: width,
      localHeight: height,
      width: step?.resize?.width ?? width,
      height: step?.resize?.height ?? height,
      rotation: step?.rotation ?? 0,
      x: step?.x ?? 0,
      y: step?.y ?? 0,
    };
    const uniforms = layerMatteUniforms(placement, mask.channel);
    const qualified = r.target(width, height, 'rgba32f');
    const program = r.program('mask-layer', MASK_LAYER_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_matte', 0, source.texture);
    program.ivec2('u_frameSize', source.width, source.height);
    gl.uniform2f(program.location('u_local'), ...uniforms.local);
    gl.uniform2f(program.location('u_resized'), ...uniforms.resized);
    gl.uniform2f(program.location('u_offset'), ...uniforms.offset);
    program.int('u_rotated', uniforms.rotated);
    gl.uniform2f(program.location('u_rotation'), ...uniforms.rotation);
    program.int('u_channel', uniforms.channel);
    r.draw(qualified, width, height);
    const clamped = opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity;
    const passes = this.keyPasses;
    const cleaned = passes.finesse(qualified, mask.finesse, [
      mask.finesse.cleanBlack,
      mask.finesse.cleanWhite,
    ]);
    return passes.tail(cleaned, {
      cleanBlack: mask.finesse.cleanBlack,
      cleanWhite: mask.finesse.cleanWhite,
      levels: false,
      ratio: mask.finesse.inOutRatio,
      invert: mask.invert ? 1 : 0,
      opacity: clamped,
      layer: true,
    }).texture;
  }

  /**
   * A track matte's source: its layers composited alone, back to front, on a TRANSPARENT frame
   * of the output size — `CompositeVideoClip(layers, size)` with no background, as the export
   * builds it. Nested track mattes are followed (the validator refuses loops); past a depth no
   * real edit reaches, the source draws nothing rather than recursing without end.
   */
  private matteSourceFrame(layers: readonly CompositeLayer[]): RenderTarget {
    const r = this.resources;
    const size = this.frameSize;
    let frame = r.target(size.width, size.height, 'rgba8');
    const fill = r.program('fill', FILL_FRAGMENT);
    this.gl.useProgram(fill.handle);
    fill.vec4('u_color', [0, 0, 0, 0]);
    r.draw(frame, size.width, size.height);
    if (this.matteDepth >= MAX_MATTE_DEPTH) {
      log.warn('track mattes nested too deep; the innermost source draws nothing', {
        depth: this.matteDepth,
      });
      return frame;
    }
    this.matteDepth += 1;
    try {
      for (const layer of layers) {
        const placed =
          layer.kind === 'picture'
            ? this.rasterPicture(
                layer.step,
                layer.source,
                this.frameDecodes,
                'off',
                layer.mattes ?? null,
                false,
                layer.layerMattes ?? null,
              )
            : {
                target: r.imageTarget(layer.image, layer.width, layer.height),
                x: layer.x,
                y: layer.y,
              };
        if (placed === null) continue;
        frame = this.composite(frame, placed.target, placed.x, placed.y, size);
      }
    } finally {
      this.matteDepth -= 1;
    }
    return frame;
  }

  /** `apply_finesse` then `layer_alpha`, in the order `key_mask_alpha` chains them. */
  private keyFinesse(
    qualified: RenderTarget,
    finesse: KeyMask['finesse'],
    uniforms: ReturnType<typeof keyUniforms>,
  ): RenderTarget {
    const passes = this.keyPasses;
    const cleaned = passes.finesse(qualified, finesse, [uniforms.cleanBlack, uniforms.cleanWhite]);
    return passes.tail(cleaned, {
      cleanBlack: uniforms.cleanBlack,
      cleanWhite: uniforms.cleanWhite,
      levels: false,
      ratio: finesse.inOutRatio,
      invert: uniforms.invert,
      opacity: uniforms.opacity,
      layer: true,
    });
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
