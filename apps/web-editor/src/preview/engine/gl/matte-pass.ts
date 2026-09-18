/**
 * A `matte` mask layer evaluated on the GPU (PX5.3): `matte_alpha` and `decontaminate` of
 * `render/mask_stack.py` / `render/matte_edges.py` as float passes.
 *
 * WHY: the exact float64 twin costs 452 ms of main thread per composite for a 4K matte, so the
 * monitor presented one frame in twenty seconds (`PX5-BUDGETS.md`). Here the decoded samples
 * are uploaded as the integers they are and everything after that is a shader:
 *
 *   alpha:  samples / maximum → edge shift (disc morphology) → finesse → distance feather on the
 *           50 % contour → bicubic to the decoded size → integer crop → invert, opacity
 *   colour: band and band-premultiplied foreground → the same bicubic and crop → mixed into the
 *           picture, rounded half-even to bytes
 *
 * The alpha is returned as FLOAT: the compositor combines the stack in a float accumulator and
 * quantises ONCE (`stack_alpha`), exactly as it does for a `key`.
 *
 * What it cannot carry it does not approximate: {@link MattePass.carries} says no for a radius
 * past a shader loop's bound, and the compositor then draws that layer with the CPU twin.
 */
import type { MatteMask } from '../../masks/mask-stack.js';
import { maskScalar } from '../../masks/mask-stack.js';
import { MAX_KEY_MORPH_PX } from '../../masks/key-mask.js';
import { gaussianFalloffTable, type MaskFalloff } from '../../masks/mask-raster.js';
import {
  cleanLevels,
  cropSlices,
  resampleTaps,
  type CropFractions,
  type MatteFrameData,
  type MattePlanes,
} from '../../masks/matte-edges.js';
import { AlphaPasses, MAX_ALPHA_BOX_PX, blurBoxRadius } from './alpha-passes.js';
import type { GlResources, RenderTarget } from './gl-resources.js';
import {
  MATTE_ALPHA_ACROSS_FRAGMENT,
  MATTE_BAND_FRAGMENT,
  MATTE_CROP_FRAGMENT,
  MATTE_DECONTAMINATE_FRAGMENT,
  MATTE_FEATHER_FRAGMENT,
  MATTE_RESAMPLE_FRAGMENT,
  MATTE_ROW_DISTANCE_FRAGMENT,
  MATTE_TIER_PLANES_FRAGMENT,
  MATTE_TO_FLOAT_FRAGMENT,
  FALLOFF_TABLE_SIDE,
  MAX_MATTE_FEATHER_CAP,
} from './matte-shaders.js';
import { MAX_TAPS } from './raster-shaders.js';

const FALLOFF_INDEX: Readonly<Record<MaskFalloff, number>> = { linear: 0, smooth: 1, gaussian: 2 };
const ALPHA_CEILING = [1, 1, 1, 1] as const;
/** Colour planes clamp at 255, their band weight at 1 (`to_frame(..., ceiling=255.0)`). */
const PLANES_CEILING = [255, 255, 255, 1] as const;

/** Where a matte plane lands on the clip's frame. */
export interface MatteFrameGeometry {
  readonly crop: CropFractions | null | undefined;
  /** The cropped picture the layer is attached to. */
  readonly width: number;
  readonly height: number;
  /** The size the picture was decoded at, before its crop. */
  readonly decodedWidth: number;
  readonly decodedHeight: number;
}

/** A matte layer's edge controls read at one source instant. */
interface MatteEdgeValues {
  readonly shiftPx: number;
  readonly expansion: number;
  readonly featherInner: number;
  readonly featherOuter: number;
  readonly cap: number;
}

/**
 * Whether a matte's source-pixel chain is pointwise at this instant: every step that reads a
 * neighbour (edge shift, denoise, morphology, blur, distance feather) is off, so what is left
 * is clean levels and in/out ratio - `edgeMode: 'sharp'` and the defaults.
 */
function pointwiseChain(finesse: MatteMask['finesse'], edge: MatteEdgeValues): boolean {
  return (
    edge.shiftPx === 0 &&
    edge.cap === 0 &&
    finesse.denoise <= 0 &&
    finesse.morphOpenPx <= 0 &&
    finesse.morphClosePx <= 0 &&
    finesse.shrinkGrowPx === 0 &&
    finesse.blurPx <= 0
  );
}

function edgeValues(mask: MatteMask, s: number): MatteEdgeValues {
  const expansion = maskScalar(mask, 'expansionPx', s);
  const featherInner = Math.max(maskScalar(mask, 'featherInnerPx', s), 0.0);
  const featherOuter = Math.max(maskScalar(mask, 'featherOuterPx', s), 0.0);
  const feathered = expansion !== 0.0 || featherInner !== 0.0 || featherOuter !== 0.0;
  const widest = Math.max(featherOuter + expansion, featherInner - expansion, 0.0);
  return {
    shiftPx: maskScalar(mask, 'edgeShiftPx', s),
    expansion,
    featherInner,
    featherOuter,
    cap: feathered ? Math.ceil(widest) + 2 : 0,
  };
}

/** `resample_taps`' tap count for one axis; 0 when the axis is not resampled. */
function tapCount(source: number, size: number): number {
  return source === size ? 0 : 2 * Math.ceil(2.0 * Math.max(source / size, 1.0));
}

/** Whether every axis of `to_frame` fits the resample shader's tap loop. */
function geometryCarried(sourceW: number, sourceH: number, geometry: MatteFrameGeometry): boolean {
  const { x0, y0, x1, y1 } = cropSlices(
    geometry.crop,
    geometry.decodedWidth,
    geometry.decodedHeight,
  );
  return (
    tapCount(sourceW, geometry.decodedWidth) <= MAX_TAPS &&
    tapCount(sourceH, geometry.decodedHeight) <= MAX_TAPS &&
    tapCount(Math.max(0, x1 - x0), geometry.width) <= MAX_TAPS &&
    tapCount(Math.max(0, y1 - y0), geometry.height) <= MAX_TAPS
  );
}

export class MattePass {
  private readonly alphaPasses: AlphaPasses;
  private maxTextureSize: number | null = null;

  constructor(private readonly resources: GlResources) {
    this.alphaPasses = new AlphaPasses(resources, 'r32f');
  }

  /**
   * Whether the shaders carry `mask` at source instant `s` exactly as written: every morphology
   * radius, box radius, feather cap and resample kernel inside its loop's bound, and the frame
   * inside the GPU's texture limit.
   */
  carries(
    mask: MatteMask,
    frame: MatteFrameData,
    geometry: MatteFrameGeometry,
    s: number,
  ): boolean {
    const edge = edgeValues(mask, s);
    const { morphOpenPx, morphClosePx, shrinkGrowPx, blurPx } = mask.finesse;
    const widestMorph = Math.max(
      Math.abs(edge.shiftPx),
      morphOpenPx,
      morphClosePx,
      Math.abs(shrinkGrowPx),
    );
    if (Math.ceil(widestMorph) > MAX_KEY_MORPH_PX) return false;
    if (blurPx > 0 && blurBoxRadius(blurPx) > MAX_ALPHA_BOX_PX) return false;
    if (edge.cap > MAX_MATTE_FEATHER_CAP) return false;
    return this.carriesFrame(frame, geometry);
  }

  /** Whether `frame`'s decontamination planes fit the texture limit and the resample loop. */
  carriesFrame(frame: MatteFrameData, geometry: MatteFrameGeometry): boolean {
    const limit = this.textureLimit();
    if (frame.width > limit || frame.height > limit) return false;
    return geometryCarried(frame.width, frame.height, geometry);
  }

  /** PX5.3: whether a frame's monitor-tier planes fit the texture limit and the crop's resample. */
  carriesPlanes(
    frame: MatteFrameData & { readonly planes: MattePlanes },
    geometry: MatteFrameGeometry,
  ): boolean {
    const limit = this.textureLimit();
    if (frame.planes.width > limit || 8 * frame.planes.height > limit) return false;
    // The planes are at the decoded size: only the crop's resample can need taps.
    return geometryCarried(frame.planes.width, frame.planes.height, geometry);
  }

  private textureLimit(): number {
    const gl = this.resources.gl;
    this.maxTextureSize ??= gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    return this.maxTextureSize;
  }

  /**
   * `matte_alpha`: the layer's float alpha (after invert and opacity) on the clip's frame.
   *
   * @param s - The mask's source time (`maskSourceTime`).
   * @returns A `geometry.width × geometry.height` float texture, first channel.
   */
  layer(
    mask: MatteMask,
    frame: MatteFrameData,
    geometry: MatteFrameGeometry,
    s: number,
  ): WebGLTexture {
    const r = this.resources;
    const gl = r.gl;
    const edge = edgeValues(mask, s);
    const samples = r.keyedTexture(
      `${frame.id}|alpha`,
      frame.width,
      frame.height,
      frame.alpha instanceof Uint16Array ? 'r16' : 'r8',
      frame.alpha,
    );
    const levels = cleanLevels(mask);
    const placed = pointwiseChain(mask.finesse, edge)
      ? this.pointwiseToFrame(samples, frame, geometry, levels, mask.finesse.inOutRatio)
      : this.toFrame(
          this.sourceChain(samples, frame, mask, edge, levels),
          geometry,
          'r32f',
          ALPHA_CEILING,
        );
    const opacity = maskScalar(mask, 'opacity', s);
    const out = r.target(geometry.width, geometry.height, 'r32f');
    const program = r.program('matte-crop', MATTE_CROP_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, placed.target.texture);
    program.ivec2('u_origin', placed.x, placed.y);
    program.int('u_layer', 1);
    gl.uniform1f(program.location('u_invert'), mask.invert ? 1 : 0);
    gl.uniform1f(program.location('u_opacity'), opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity);
    r.draw(out, out.width, out.height);
    return out.texture;
  }

  /**
   * The chain in the artifact's source pixels, as float passes: to-float, edge shift, finesse,
   * in/out ratio, distance feather.
   */
  private sourceChain(
    samples: WebGLTexture,
    frame: MatteFrameData,
    mask: MatteMask,
    edge: MatteEdgeValues,
    levels: readonly [number, number],
  ): RenderTarget {
    const r = this.resources;
    const gl = r.gl;
    const passes = this.alphaPasses;
    let alpha = r.target(frame.width, frame.height, 'r32f');
    const toFloat = r.program('matte-to-float', MATTE_TO_FLOAT_FRAGMENT);
    gl.useProgram(toFloat.handle);
    r.bind(toFloat, 'u_matte', 0, samples);
    gl.uniform1f(toFloat.location('u_maximum'), frame.maximum);
    r.draw(alpha, alpha.width, alpha.height);
    // `edge_shift` takes the extremum of the integer samples and divides after; dividing first
    // is the same value, because `x / maximum` is monotonic.
    alpha = passes.morphology(alpha, Math.abs(edge.shiftPx), edge.shiftPx > 0);
    alpha = passes.finesse(alpha, mask.finesse, levels);
    if (mask.finesse.inOutRatio !== 0) {
      alpha = passes.tail(alpha, {
        cleanBlack: 0,
        cleanWhite: 1,
        levels: false,
        ratio: mask.finesse.inOutRatio,
        invert: 0,
        opacity: 1,
        layer: false,
      });
    }
    return edge.cap > 0 ? this.feather(alpha, edge, mask.falloff) : alpha;
  }

  /**
   * PX5.3: `to_frame` of a pointwise chain ({@link pointwiseChain}) without a source-size float
   * plane: the horizontal resample reads the integer samples and applies the chain per tap
   * (`MATTE_ALPHA_ACROSS_FRAGMENT`), then down and the crop as for any plane.
   */
  private pointwiseToFrame(
    samples: WebGLTexture,
    frame: MatteFrameData,
    geometry: MatteFrameGeometry,
    levels: readonly [number, number],
    ratio: number,
  ): { target: RenderTarget; x: number; y: number } {
    const r = this.resources;
    const gl = r.gl;
    const across = r.target(geometry.decodedWidth, frame.height, 'r32f');
    const program = r.program('matte-alpha-across', MATTE_ALPHA_ACROSS_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_matte', 0, samples);
    r.bind(program, 'u_taps', 1, this.tapsTable(frame.width, geometry.decodedWidth));
    program.int('u_tapCount', tapCount(frame.width, geometry.decodedWidth));
    gl.uniform1f(program.location('u_maximum'), frame.maximum);
    // `AlphaPasses.finesse` applies the levels only when they are not the identity.
    program.int('u_levels', levels[0] !== 0 || levels[1] !== 1 ? 1 : 0);
    gl.uniform1f(program.location('u_cleanBlack'), levels[0]);
    gl.uniform1f(program.location('u_cleanWhite'), levels[1]);
    gl.uniform1f(program.location('u_ratio'), ratio);
    r.draw(across, across.width, across.height);
    const decoded = this.resampleAxis(across, geometry.decodedHeight, 1, 'r32f', ALPHA_CEILING);
    return this.cropToFrame(decoded, geometry, 'r32f', ALPHA_CEILING);
  }

  /**
   * `decontaminate`: `picture` with the matte's soft band recoloured from its foreground.
   *
   * @param picture - The cropped picture (`rgba8`), before any effect.
   * @returns A fresh `rgba8` target, or `picture` when the frame carries no foreground.
   */
  decontaminate(
    picture: RenderTarget,
    frame: MatteFrameData,
    geometry: MatteFrameGeometry,
  ): RenderTarget {
    const foreground = frame.foreground;
    if (foreground === null) return picture;
    const r = this.resources;
    const gl = r.gl;
    const samples = r.keyedTexture(
      `${frame.id}|alpha`,
      frame.width,
      frame.height,
      frame.alpha instanceof Uint16Array ? 'r16' : 'r8',
      frame.alpha,
    );
    const colour = r.keyedTexture(
      `${frame.id}|foreground`,
      frame.width,
      frame.height,
      'rgb8',
      foreground,
    );
    // Across first, with the band computed per tap from the integer masters.
    const across = r.target(geometry.decodedWidth, frame.height, 'rgba32f');
    const band = r.program('matte-band', MATTE_BAND_FRAGMENT);
    gl.useProgram(band.handle);
    r.bind(band, 'u_matte', 0, samples);
    r.bind(band, 'u_foreground', 1, colour);
    const taps = tapCount(frame.width, geometry.decodedWidth);
    r.bind(band, 'u_taps', 2, this.tapsTable(frame.width, geometry.decodedWidth));
    band.int('u_tapCount', taps);
    gl.uniform1ui(band.location('u_maximum'), frame.maximum);
    r.draw(across, across.width, across.height);

    const decoded = this.resampleAxis(across, geometry.decodedHeight, 1, 'rgba32f', PLANES_CEILING);
    const placed = this.cropToFrame(decoded, geometry, 'rgba32f', PLANES_CEILING);
    const out = r.target(picture.width, picture.height, 'rgba8');
    const program = r.program('matte-decontaminate', MATTE_DECONTAMINATE_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_picture', 0, picture.texture);
    r.bind(program, 'u_planes', 1, placed.target.texture);
    program.ivec2('u_origin', placed.x, placed.y);
    r.draw(out, out.width, out.height);
    return out;
  }

  /**
   * `decontaminate` from the monitor tier's planes (PX5.3): the planes the export would resample
   * to the decoded size, already resampled by the engine, then the same crop and mix as
   * {@link decontaminate}. One 4 MB upload per frame at 540p instead of a 25 MB 4K foreground.
   *
   * @param picture - The cropped picture (`rgba8`), before any effect.
   */
  decontaminatePlanes(
    picture: RenderTarget,
    frame: MatteFrameData & { readonly planes: MattePlanes },
    geometry: MatteFrameGeometry,
  ): RenderTarget {
    const r = this.resources;
    const gl = r.gl;
    const planes = frame.planes;
    const stacked = r.keyedTexture(
      `${frame.id}|planes`,
      planes.width,
      8 * planes.height,
      'r8',
      planes.data,
    );
    const decoded = r.target(planes.width, planes.height, 'rgba32f');
    const convert = r.program('matte-tier-planes', MATTE_TIER_PLANES_FRAGMENT);
    gl.useProgram(convert.handle);
    r.bind(convert, 'u_planes', 0, stacked);
    convert.int('u_height', planes.height);
    r.draw(decoded, decoded.width, decoded.height);
    const placed = this.cropToFrame(decoded, geometry, 'rgba32f', PLANES_CEILING);
    const out = r.target(picture.width, picture.height, 'rgba8');
    const program = r.program('matte-decontaminate', MATTE_DECONTAMINATE_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_picture', 0, picture.texture);
    r.bind(program, 'u_planes', 1, placed.target.texture);
    program.ivec2('u_origin', placed.x, placed.y);
    r.draw(out, out.width, out.height);
    return out;
  }

  /** `distance_feather`: two passes, along the rows and then down the columns. */
  private feather(alpha: RenderTarget, edge: MatteEdgeValues, falloff: MaskFalloff): RenderTarget {
    const r = this.resources;
    const gl = r.gl;
    const rows = this.alphaPasses.pass(
      alpha,
      'matte-row-distance',
      MATTE_ROW_DISTANCE_FRAGMENT,
      (program) => program.int('u_cap', edge.cap),
    );
    const out = r.target(alpha.width, alpha.height, 'r32f');
    const program = r.program('matte-feather', MATTE_FEATHER_FRAGMENT);
    gl.useProgram(program.handle);
    r.bind(program, 'u_alpha', 0, alpha.texture);
    r.bind(program, 'u_rows', 1, rows.texture);
    r.bind(program, 'u_table', 2, this.falloffTable());
    program.int('u_cap', edge.cap);
    gl.uniform1f(program.location('u_expansion'), edge.expansion);
    gl.uniform1f(program.location('u_inner'), edge.featherInner);
    gl.uniform1f(program.location('u_outer'), edge.featherOuter);
    program.int('u_falloff', FALLOFF_INDEX[falloff]);
    r.draw(out, out.width, out.height);
    return out;
  }

  /** `to_frame`: resample to the decoded size (across, then down), then the crop. */
  private toFrame(
    plane: RenderTarget,
    geometry: MatteFrameGeometry,
    format: 'r32f' | 'rgba32f',
    ceiling: readonly [number, number, number, number],
  ): { target: RenderTarget; x: number; y: number } {
    const across = this.resampleAxis(plane, geometry.decodedWidth, 0, format, ceiling);
    const decoded = this.resampleAxis(across, geometry.decodedHeight, 1, format, ceiling);
    return this.cropToFrame(decoded, geometry, format, ceiling);
  }

  /**
   * The clip's integer crop of a decoded-size plane. When the crop already is the frame (always,
   * for a picture the compositor cropped itself) it is returned as an origin for the next pass
   * to read through; only a crop that disagrees with the frame is copied out and resampled.
   */
  private cropToFrame(
    decoded: RenderTarget,
    geometry: MatteFrameGeometry,
    format: 'r32f' | 'rgba32f',
    ceiling: readonly [number, number, number, number],
  ): { target: RenderTarget; x: number; y: number } {
    const { x0, y0, x1, y1 } = cropSlices(geometry.crop, decoded.width, decoded.height);
    const width = Math.max(0, x1 - x0);
    const height = Math.max(0, y1 - y0);
    if (width === geometry.width && height === geometry.height) {
      return { target: decoded, x: x0, y: y0 };
    }
    const r = this.resources;
    const cropped = r.target(Math.max(1, width), Math.max(1, height), format);
    const program = r.program('matte-crop', MATTE_CROP_FRAGMENT);
    r.gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, decoded.texture);
    program.ivec2('u_origin', x0, y0);
    program.int('u_layer', 0);
    r.draw(cropped, cropped.width, cropped.height);
    const across = this.resampleAxis(cropped, geometry.width, 0, format, ceiling);
    return { target: this.resampleAxis(across, geometry.height, 1, format, ceiling), x: 0, y: 0 };
  }

  /** `_resample_axis`: identity when the axis already has `size` samples. */
  private resampleAxis(
    source: RenderTarget,
    size: number,
    axis: 0 | 1,
    format: 'r32f' | 'rgba32f',
    ceiling: readonly [number, number, number, number],
  ): RenderTarget {
    const from = axis === 0 ? source.width : source.height;
    if (from === size) return source;
    const r = this.resources;
    const out =
      axis === 0 ? r.target(size, source.height, format) : r.target(source.width, size, format);
    const program = r.program('matte-resample', MATTE_RESAMPLE_FRAGMENT);
    r.gl.useProgram(program.handle);
    r.bind(program, 'u_source', 0, source.texture);
    r.bind(program, 'u_taps', 1, this.tapsTable(from, size));
    program.int('u_tapCount', tapCount(from, size));
    program.int('u_axis', axis);
    program.vec4('u_ceiling', ceiling);
    r.draw(out, out.width, out.height);
    return out;
  }

  /**
   * The bicubic's taps for `source → size` as a float texture, `(taps + 1) × size`: column 0 the
   * first source index, then the weights `resampleTaps` normalised in float64.
   */
  private tapsTable(source: number, size: number): WebGLTexture {
    const taps = tapCount(source, size);
    // An identity axis still binds a sampler; one texel satisfies it.
    if (taps === 0)
      return this.resources.floatTable('matte-taps:none', 1, 1, () => new Float32Array(1));
    return this.resources.floatTable(`matte-taps:${source}>${size}`, taps + 1, size, () => {
      const { weights } = resampleTaps(source, size);
      const table = new Float32Array((taps + 1) * size);
      const scale = source / size;
      const stretch = Math.max(scale, 1.0);
      for (let i = 0; i < size; i += 1) {
        const centre = (i + 0.5) * scale - 0.5;
        table[i * (taps + 1)] = Math.floor(centre - 2.0 * stretch) + 1;
        for (let tap = 0; tap < taps; tap += 1) {
          table[i * (taps + 1) + 1 + tap] = weights[i * taps + tap]!;
        }
      }
      return table;
    });
  }

  private falloffTable(): WebGLTexture {
    const table = gaussianFalloffTable();
    return this.resources.floatTable('matte-falloff', FALLOFF_TABLE_SIDE, FALLOFF_TABLE_SIDE, () =>
      Float32Array.from(table),
    );
  }
}
