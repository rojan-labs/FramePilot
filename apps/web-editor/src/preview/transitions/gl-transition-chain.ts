/**
 * WebGL2 renderer for one transition pass.
 *
 * Three surfaces need to draw the same transition and they must not disagree:
 * the WebCodecs canvas preview (the incoming clip's frame during the ramp), the
 * transitions panel's hover tiles, and the on-cut popover's tiles. All three call
 * this, so "what does Glitch look like" has exactly one answer in the app, and
 * that answer is the same shader family the export mirrors in numpy.
 *
 * ## Why this is not `GlEffectChain`
 *
 * Effect layers stack — the chain ping-pongs between framebuffers and the output
 * is opaque RGB over a composite that is already flattened. A transition is one
 * pass with a MEANINGFUL ALPHA that the 2D compositor then draws over whatever is
 * beneath. Sharing one class would mean an `alpha` flag threaded through every
 * method and a ping-pong loop that never runs more than once.
 *
 * Everything is lazy and failure-tolerant, matching `GlEffectChain`: no context
 * exists until something is actually transitioning, and if creation or a compile
 * fails the caller is told `null` and shows the un-transitioned picture rather
 * than a black frame.
 */
import { createLogger } from '@framepilot/shared-types';
import type { TransitionRenderKind } from '@framepilot/timeline-schema/transition-params';
import {
  MAX_PARAMS,
  TRANSITION_FRAGMENT_EPILOGUE,
  TRANSITION_FRAGMENT_PREAMBLE,
  TRANSITION_VERTEX_SHADER,
} from './glsl-transition-common.js';
import { GLSL_TRANSITIONS } from './glsl-transitions.js';
import {
  directionSign,
  directionVector,
  easedProgress,
  transitionUniforms,
  type ResolvedTransition,
} from './transition-engine.js';

const log = createLogger('web-editor:preview:gl-transitions');

/** Noise clock quantum — must equal the effect chain's, and the engine's. */
const TIME_QUANTUM = 1 / 60;

interface CompiledPass {
  readonly program: WebGLProgram;
  readonly uniforms: {
    readonly tex: WebGLUniformLocation | null;
    readonly resolution: WebGLUniformLocation | null;
    readonly progress: WebGLUniformLocation | null;
    readonly intensity: WebGLUniformLocation | null;
    readonly softness: WebGLUniformLocation | null;
    readonly direction: WebGLUniformLocation | null;
    readonly dirSign: WebGLUniformLocation | null;
    readonly noiseFrame: WebGLUniformLocation | null;
    readonly params: WebGLUniformLocation | null;
  };
}

/** The intrinsic pixel size of a texture source (see `gl-effect-chain.sourceSize`). */
function sourceSize(source: TexImageSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return { width: source.displayWidth, height: source.displayHeight };
  }
  const sized = source as { width?: number; height?: number };
  return { width: Number(sized.width ?? 0), height: Number(sized.height ?? 0) };
}

export class GlTransitionChain {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext | null = null;
  private readonly programs = new Map<TransitionRenderKind, CompiledPass | null>();
  private sourceTexture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private unavailable = false;

  constructor(canvasFactory: () => HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvasFactory();
  }

  get available(): boolean {
    return !this.unavailable && this.ensureContext() !== null;
  }

  /**
   * Draw `source` through `transition` at `progress` and return the canvas.
   *
   * The result has a real alpha channel: the caller composites it over the
   * picture beneath with a plain `drawImage`, which is what makes a wipe reveal
   * the outgoing shot rather than punching a hole in the frame.
   *
   * @param source - The INCOMING clip's frame.
   * @param transition - The resolved transition (see `transition-engine.ts`).
   * @param progress - RAW progress 0→1; easing is applied here, once.
   * @returns The canvas holding the result, or `null` when nothing was drawn.
   */
  process(
    source: TexImageSource,
    transition: ResolvedTransition,
    progress: number,
  ): HTMLCanvasElement | OffscreenCanvas | null {
    const gl = this.ensureContext();
    if (gl === null) return null;
    const { width, height } = sourceSize(source);
    if (width <= 0 || height <= 0) return null;

    const pass = this.programOf(gl, transition.renderKind);
    // A kind whose shader failed to compile falls back to the untouched picture
    // rather than to a black frame. One broken pass must not blank the preview.
    if (pass === null) return null;

    this.resize(width, height);
    const vao = this.vao;
    if (vao === null) return null;

    try {
      this.uploadSource(gl, source);
    } catch (error) {
      // A cross-origin source without CORS taints the canvas and texImage2D
      // throws. Unguarded that escapes into the caller's animation frame and the
      // preview silently stops updating with no clue why.
      this.unavailable = true;
      log.error('process ← source could not be uploaded; transitions disabled', {
        reason: error instanceof Error ? error.message : String(error),
        hint: 'A cross-origin media source needs CORS headers to be sampled by WebGL.',
      });
      return null;
    }

    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(pass.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(pass.uniforms.tex, 0);
    this.setUniforms(gl, pass, transition, progress, width, height);
    // The alpha the pass wrote is the answer; blending here would mix it with
    // whatever the previous frame left in the buffer.
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    return this.canvas;
  }

  /** Release every GL resource. Safe to call repeatedly. */
  dispose(): void {
    const gl = this.gl;
    if (gl === null) return;
    for (const pass of this.programs.values()) {
      if (pass !== null) gl.deleteProgram(pass.program);
    }
    this.programs.clear();
    if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.sourceTexture = null;
    this.vao = null;
    this.gl = null;
  }

  // --- internals -----------------------------------------------------------

  private ensureContext(): WebGL2RenderingContext | null {
    if (this.gl !== null) return this.gl;
    if (this.unavailable) return null;
    // `alpha: true` and no premultiply: unlike the effect chain, the whole point
    // here is the alpha channel, and letting the browser premultiply would darken
    // every feathered wipe edge as it was composited a second time.
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      antialias: false,
      depth: false,
      stencil: false,
    }) as WebGL2RenderingContext | null;
    if (gl === null) {
      this.unavailable = true;
      log.warn('ensureContext ← WebGL2 unavailable, transitions will not preview');
      return null;
    }
    this.gl = gl;
    this.vao = this.createQuad(gl);
    if (this.vao === null) {
      this.unavailable = true;
      this.gl = null;
      return null;
    }
    return gl;
  }

  private createQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject | null {
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (vao === null || buffer === null) return null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  private resize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  private setSampling(gl: WebGL2RenderingContext): void {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private uploadSource(gl: WebGL2RenderingContext, source: TexImageSource): void {
    if (this.sourceTexture === null) {
      this.sourceTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
      this.setSampling(gl);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    }
    // Orientation corrected once, here — see gl-effect-chain's note on why this
    // belongs at upload and not in the vertex shader.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  private setUniforms(
    gl: WebGL2RenderingContext,
    pass: CompiledPass,
    transition: ResolvedTransition,
    progress: number,
    width: number,
    height: number,
  ): void {
    const eased = easedProgress(transition, progress);
    const [dx, dy] = directionVector(transition.direction);
    gl.uniform2f(pass.uniforms.resolution, width, height);
    gl.uniform1f(pass.uniforms.progress, eased);
    gl.uniform1f(pass.uniforms.intensity, transition.intensity);
    gl.uniform1f(pass.uniforms.softness, transition.softness);
    // Screen space (y down) flipped ONCE into the shader's y-up UV space. Every
    // other direction consumer in the app stays y-down; this is the seam.
    gl.uniform2f(pass.uniforms.direction, dx, -dy);
    gl.uniform1f(pass.uniforms.dirSign, directionSign(transition.direction));
    // Derived from PROGRESS, not from the wall clock: a transition's animated
    // noise must look the same when scrubbed to as when played through, and the
    // export has no wall clock at all.
    gl.uniform1i(
      pass.uniforms.noiseFrame,
      Math.floor(Math.max(0, eased * transition.duration) / TIME_QUANTUM),
    );
    gl.uniform1fv(pass.uniforms.params, transitionUniforms(transition));
  }

  private programOf(gl: WebGL2RenderingContext, kind: TransitionRenderKind): CompiledPass | null {
    const cached = this.programs.get(kind);
    if (cached !== undefined) return cached;
    const body = GLSL_TRANSITIONS[kind];
    const compiled = body === undefined ? null : this.compile(gl, body, kind);
    this.programs.set(kind, compiled);
    return compiled;
  }

  private compile(gl: WebGL2RenderingContext, body: string, kind: string): CompiledPass | null {
    const vertex = this.compileShader(gl, gl.VERTEX_SHADER, TRANSITION_VERTEX_SHADER, kind);
    const fragment = this.compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `${TRANSITION_FRAGMENT_PREAMBLE}\n${body}\n${TRANSITION_FRAGMENT_EPILOGUE}`,
      kind,
    );
    if (vertex === null || fragment === null) return null;

    const program = gl.createProgram();
    if (program === null) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      log.error('compile ← program link failed', {
        kind,
        info: gl.getProgramInfoLog(program) ?? '',
      });
      gl.deleteProgram(program);
      return null;
    }

    return {
      program,
      uniforms: {
        tex: gl.getUniformLocation(program, 'uTex'),
        resolution: gl.getUniformLocation(program, 'uResolution'),
        progress: gl.getUniformLocation(program, 'uProgress'),
        intensity: gl.getUniformLocation(program, 'uIntensity'),
        softness: gl.getUniformLocation(program, 'uSoftness'),
        direction: gl.getUniformLocation(program, 'uDirection'),
        dirSign: gl.getUniformLocation(program, 'uDirSign'),
        noiseFrame: gl.getUniformLocation(program, 'uNoiseFrame'),
        params: gl.getUniformLocation(program, 'uParams'),
      },
    };
  }

  private compileShader(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
    kind: string,
  ): WebGLShader | null {
    const shader = gl.createShader(type);
    if (shader === null) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      // Logged rather than thrown: one bad shader must not take down the preview,
      // and the message is the only way to find a GLSL typo in CI.
      log.error('compileShader ← shader compile failed', {
        kind,
        stage: type === gl.VERTEX_SHADER ? 'vertex' : 'fragment',
        info: gl.getShaderInfoLog(shader) ?? '',
      });
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
}

/**
 * The one chain shared by every preview surface.
 *
 * A context per surface would exhaust the browser's ~16-context limit the first
 * time someone scrolled the panel, and only one transition is ever being drawn at
 * a time (the hovered tile, or the playhead's own cut).
 */
let shared: GlTransitionChain | null = null;

export function sharedTransitionChain(): GlTransitionChain {
  shared ??= new GlTransitionChain(() => document.createElement('canvas'));
  return shared;
}

export { MAX_PARAMS };
