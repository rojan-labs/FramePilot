/**
 * Float passes over a single-channel alpha: the matte finesse group as the GPU runs it (MK6.2).
 *
 * WHY its own module (PX5.3): a `key` layer's alpha only ever exists on the GPU, so its finesse
 * chain was written as shader passes inside the compositor. A `matte` layer now runs on the GPU
 * too (`matte-pass.ts`), and it is the SAME chain in the same order — `apply_finesse` of
 * `render/matte_edges.py` — so both kinds share these passes rather than keeping two copies
 * that could drift apart.
 *
 * Every pass writes a fresh pooled float target of the source's size. A key keeps the `rgba32f`
 * targets it has always used; a matte at its artifact's own size (a 4K master is 8.3 M pixels)
 * uses `r32f`, a quarter of the storage for the one channel that is read.
 */
import {
  MASK_BOX_FRAGMENT,
  MASK_DENOISE_FRAGMENT,
  MASK_LEVELS_FRAGMENT,
  MASK_MIX_ALPHA_FRAGMENT,
  MASK_MORPH_FRAGMENT,
} from '../../masks/key-mask.js';
import type { MaskFinesseValues } from '../../masks/matte-edges.js';
import type { GlResources, Program, RenderTarget } from './gl-resources.js';

/** Largest box radius `MASK_BOX_FRAGMENT`'s loop carries (its literal bound). */
export const MAX_ALPHA_BOX_PX = 64;

/** The pointwise tail of a layer: clean levels, in/out ratio, then invert and opacity. */
export interface AlphaTail {
  readonly cleanBlack: number;
  readonly cleanWhite: number;
  /** Apply the clean levels in this pass. */
  readonly levels: boolean;
  readonly ratio: number;
  /** 1 inverts; only read when `layer` is set. */
  readonly invert: number;
  readonly opacity: number;
  /** Apply invert and opacity (`layer_alpha`) in this pass. */
  readonly layer: boolean;
}

/** `blur`'s box radius: three box passes of `round(radius / 3)`. */
export const blurBoxRadius = (radius: number): number => Math.max(1, Math.round(radius / 3));

export class AlphaPasses {
  constructor(
    private readonly resources: GlResources,
    private readonly format: 'rgba32f' | 'r32f',
  ) {}

  /** One pass over an alpha, into a fresh float target of `source`'s size. */
  pass(
    source: RenderTarget,
    name: string,
    fragment: string,
    setup: (program: Program) => void,
    second: RenderTarget | null = null,
  ): RenderTarget {
    const r = this.resources;
    const out = r.target(source.width, source.height, this.format);
    const program = r.program(name, fragment);
    r.gl.useProgram(program.handle);
    r.bind(program, second === null ? 'u_alpha' : 'u_low', 0, source.texture);
    if (second !== null) r.bind(program, 'u_high', 1, second.texture);
    setup(program);
    r.draw(out, out.width, out.height);
    return out;
  }

  /** `_morphology_at`: one integer radius, or the mix of the two a fractional radius sits between. */
  morphology(source: RenderTarget, radius: number, grow: boolean): RenderTarget {
    const magnitude = Math.abs(radius);
    if (magnitude <= 0) return source;
    const low = Math.floor(magnitude);
    const high = Math.ceil(magnitude);
    const at = (size: number): RenderTarget =>
      size <= 0
        ? source
        : this.pass(source, 'mask-morph', MASK_MORPH_FRAGMENT, (program) => {
            program.int('u_radius', size);
            program.int('u_grow', grow ? 1 : 0);
          });
    const lowTarget = at(low);
    if (high === low) return lowTarget;
    return this.pass(
      lowTarget,
      'mask-mix-alpha',
      MASK_MIX_ALPHA_FRAGMENT,
      (program) => this.resources.gl.uniform1f(program.location('u_fraction'), magnitude - low),
      at(high),
    );
  }

  /** `blur`: three box passes of `round(radius / 3)`, each separable. */
  blur(source: RenderTarget, radius: number): RenderTarget {
    if (radius <= 0) return source;
    const box = blurBoxRadius(radius);
    let current = source;
    for (let pass = 0; pass < 3; pass += 1) {
      for (const axis of [0, 1]) {
        current = this.pass(current, 'mask-box', MASK_BOX_FRAGMENT, (program) => {
          program.int('u_radius', box);
          program.int('u_axis', axis);
        });
      }
    }
    return current;
  }

  /**
   * `apply_finesse` up to and including the blur: denoise → clean levels → morph open → morph
   * close → shrink/grow → blur. The in/out ratio is the {@link tail}'s, because a key folds it
   * into the same pass as its invert and opacity.
   */
  finesse(
    source: RenderTarget,
    finesse: MaskFinesseValues,
    levels: readonly [number, number],
  ): RenderTarget {
    const gl = this.resources.gl;
    let current = source;
    if (finesse.denoise > 0) {
      current = this.pass(current, 'mask-denoise', MASK_DENOISE_FRAGMENT, (program) =>
        gl.uniform1f(program.location('u_amount'), Math.min(finesse.denoise, 1)),
      );
    }
    if (levels[0] !== 0 || levels[1] !== 1) {
      current = this.tail(current, {
        cleanBlack: levels[0],
        cleanWhite: levels[1],
        levels: true,
        ratio: 0,
        invert: 0,
        opacity: 1,
        layer: false,
      });
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
    return this.blur(current, finesse.blurPx);
  }

  /** The pointwise tail (`MASK_LEVELS_FRAGMENT`); `layer` false leaves invert and opacity out. */
  tail(source: RenderTarget, stage: AlphaTail): RenderTarget {
    const gl = this.resources.gl;
    return this.pass(source, 'mask-levels', MASK_LEVELS_FRAGMENT, (program) => {
      gl.uniform1f(program.location('u_cleanBlack'), stage.cleanBlack);
      gl.uniform1f(program.location('u_cleanWhite'), stage.cleanWhite);
      gl.uniform1f(program.location('u_ratio'), stage.ratio);
      gl.uniform1f(program.location('u_invert'), stage.layer ? stage.invert : 0);
      gl.uniform1f(program.location('u_opacity'), stage.layer ? stage.opacity : 1);
      program.int('u_levels', stage.levels ? 1 : 0);
    });
  }
}
