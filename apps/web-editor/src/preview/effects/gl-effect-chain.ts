/**
 * WebGL2 effect chain for the preview (schema v13, ADR 0088).
 *
 * WHY a GPU stage at all: the preview composites onto a 2D canvas and expresses
 * per-clip looks with `ctx.filter` (CSS filter strings). That can do blur and a
 * grade; it cannot do VHS, glitch, chromatic aberration, halftone, fisheye,
 * mosaic or mirror. Per-pixel JS at 1080p/30 is not close to real time, so the
 * only way to preview the catalog honestly is a shader pass.
 *
 * WHERE it sits: effect layers apply to the COMPOSITED frame, so this runs as a
 * post-process on the finished 2D canvas rather than inside the per-clip draw —
 * `process()` uploads that canvas, runs one program per live layer through a
 * ping-pong pair of framebuffers, and returns its own canvas for the caller to
 * `drawImage` back. That keeps the existing presentation path (whose clock and
 * canvas handling were only just stabilized) completely untouched, and makes the
 * whole stage removable by deleting one call.
 *
 * `drawImage` from a WebGL canvas to a 2D canvas stays on the GPU in every
 * current browser — it is not a `readPixels` round trip.
 *
 * Everything is lazy and failure-tolerant: no GL context is created until a
 * project actually has an effect layer, and if context creation or a shader
 * compile fails the chain reports unavailable and the caller shows the
 * un-effected composite rather than a black frame.
 */
import type { EffectRenderKind } from '@framepilot/timeline-schema';
import { EFFECT_PARAMS } from '@framepilot/timeline-schema/effect-params';
import { createLogger } from '@framepilot/shared-types';
import { FRAGMENT_EPILOGUE, FRAGMENT_PREAMBLE, MAX_PARAMS, VERTEX_SHADER } from './glsl-common.js';
import { GLSL_PASSES } from './glsl-passes.js';

const log = createLogger('web-editor:preview:gl-effects');

/**
 * Noise clock quantum, in seconds. MUST equal the engine's
 * `deterministic.TIME_QUANTUM` — a render steps exact frame times while a
 * preview lands wherever the compositor puts it, and snapping both to the same
 * grid is what makes animated noise agree. Asserted by a parity test.
 */
export const TIME_QUANTUM = 1 / 60;

/** Snap a timestamp onto the shared noise grid. Mirrors `quantize_time`. */
export function quantizeTime(t: number): number {
  return Math.floor(Math.max(0, t) / TIME_QUANTUM);
}

/**
 * What the chain needs from an effect layer.
 *
 * Structurally satisfied by the schema EffectLayer, but stated as its own shape so
 * the preview engine depends on the fields it actually reads rather than on the
 * whole schema type — the same posture `OverlayClip` already takes.
 */
export interface TimedEffectLayer {
  readonly kind: EffectRenderKind;
  readonly start: number;
  readonly end: number;
  readonly params: Readonly<Record<string, number>>;
  readonly intensity?: number | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * The INTRINSIC pixel size of a texture source.
 *
 * Not `source.width`: on an `HTMLVideoElement` that is the presentation
 * *attribute* (0 unless markup sets it), not the decoded frame size — so reading
 * it returned 0 for every `<video>` and the chain bailed out before drawing
 * anything. It happens to be correct for a canvas, which is why the thumbnail
 * grid worked while the video monitor silently rendered nothing.
 */
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

interface CompiledPass {
  readonly program: WebGLProgram;
  readonly uniforms: {
    readonly tex: WebGLUniformLocation | null;
    readonly resolution: WebGLUniformLocation | null;
    readonly localTime: WebGLUniformLocation | null;
    readonly duration: WebGLUniformLocation | null;
    readonly progress: WebGLUniformLocation | null;
    readonly noiseFrame: WebGLUniformLocation | null;
    readonly params: WebGLUniformLocation | null;
    readonly intensity: WebGLUniformLocation | null;
  };
}

/** A ping-pong render target. */
interface Target {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: WebGLTexture;
}

export class GlEffectChain {
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext | null = null;
  /** Compiled lazily per kind — a project using three effects compiles three. */
  private readonly programs = new Map<EffectRenderKind, CompiledPass | null>();
  private sourceTexture: WebGLTexture | null = null;
  private targets: [Target, Target] | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private width = 0;
  private height = 0;
  /** Set once a fatal init failure has been reported, to avoid log spam. */
  private unavailable = false;

  constructor(canvasFactory: () => HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvasFactory();
  }

  /** Whether this chain can run at all (context + base program available). */
  get available(): boolean {
    return !this.unavailable && this.ensureContext() !== null;
  }

  /**
   * Run `layers` over `source` and return the canvas holding the result.
   *
   * Returns `null` when nothing was applied — no layers, no GL, or every layer's
   * shader failed to compile — so the caller can present the untouched
   * composite. Never throws: a preview must degrade, not blank.
   *
   * @param source The composited 2D canvas (or any texture-able image source).
   * @param layers Live layers in apply order — LOWEST track first, matching
   *   `activeEffectLayersAt`. The order is the caller's responsibility because it
   *   is shared with the render engine.
   * @param timelineTime Absolute sequence time, seconds.
   */
  process(
    source: TexImageSource,
    layers: readonly TimedEffectLayer[],
    timelineTime: number,
  ): HTMLCanvasElement | OffscreenCanvas | null {
    if (layers.length === 0) return null;
    const gl = this.ensureContext();
    if (gl === null) return null;

    const { width, height } = sourceSize(source);
    if (width <= 0 || height <= 0) return null;

    this.resize(gl, width, height);
    const targets = this.targets;
    const vao = this.vao;
    if (targets === null || vao === null) return null;

    try {
      this.uploadSource(gl, source);
    } catch (error) {
      // A CROSS-ORIGIN source without CORS taints the canvas and `texImage2D`
      // throws SecurityError. Unguarded, that exception escapes into the caller's
      // animation frame and the preview silently stops updating with no clue why.
      // Reported once and treated as "no effects available" — the caller then
      // shows the untouched picture, which is honest.
      this.unavailable = true;
      log.error('process ← source could not be uploaded; effects disabled', {
        reason: error instanceof Error ? error.message : String(error),
        hint: 'A cross-origin media source needs CORS headers (or crossOrigin="anonymous") to be sampled by WebGL.',
      });
      return null;
    }

    let readTexture = this.sourceTexture;
    let writeIndex = 0;
    let applied = 0;

    gl.bindVertexArray(vao);
    gl.viewport(0, 0, width, height);

    for (const layer of layers) {
      const pass = this.programOf(gl, layer.kind);
      // A layer whose shader failed to compile is skipped, not fatal: the rest of
      // the stack still previews, which is far better than a blank frame.
      if (pass === null) continue;
      const strength = layer.intensity ?? 1;
      if (strength <= 0) continue;

      const target = targets[writeIndex] as Target;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.useProgram(pass.program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTexture);
      gl.uniform1i(pass.uniforms.tex, 0);

      this.setUniforms(gl, pass, layer, timelineTime, width, height, strength);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      readTexture = target.texture;
      writeIndex = writeIndex === 0 ? 1 : 0;
      applied += 1;
    }

    if (applied === 0) return null;

    // Final blit to the default framebuffer so the canvas itself holds the
    // result and the caller can drawImage it.
    const blit = this.programOf(gl, 'blit' as EffectRenderKind);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    if (blit !== null) {
      gl.useProgram(blit.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTexture);
      gl.uniform1i(blit.uniforms.tex, 0);
      gl.uniform2f(blit.uniforms.resolution, width, height);
      gl.uniform1f(blit.uniforms.intensity, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
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
    if (this.targets) {
      for (const target of this.targets) {
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
    }
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.sourceTexture = null;
    this.targets = null;
    this.vao = null;
    this.gl = null;
    this.width = 0;
    this.height = 0;
  }

  // --- internals -----------------------------------------------------------

  private ensureContext(): WebGL2RenderingContext | null {
    if (this.gl !== null) return this.gl;
    if (this.unavailable) return null;
    // `premultipliedAlpha: false` and an opaque drawing buffer: the composite is
    // already flattened over black, and letting the browser premultiply would
    // darken every effected frame's edges.
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      antialias: false,
      depth: false,
      stencil: false,
    }) as WebGL2RenderingContext | null;
    if (gl === null) {
      this.unavailable = true;
      log.warn('ensureContext ← WebGL2 unavailable, effects will not preview');
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

  /** A full-screen triangle pair. One VAO reused by every pass. */
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

  private resize(gl: WebGL2RenderingContext, width: number, height: number): void {
    if (this.width === width && this.height === height && this.targets !== null) return;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.targets !== null) {
      for (const target of this.targets) {
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
      this.targets = null;
    }
    const a = this.createTarget(gl, width, height);
    const b = this.createTarget(gl, width, height);
    this.targets = a !== null && b !== null ? [a, b] : null;
    this.width = width;
    this.height = height;
  }

  private createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target | null {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (texture === null || framebuffer === null) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.setSampling(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, texture };
  }

  /**
   * LINEAR + CLAMP_TO_EDGE on every texture.
   *
   * CLAMP_TO_EDGE is a correctness requirement, not a preference: it matches the
   * engine's `sample_bilinear`, which clamps. `REPEAT` would fold content in from
   * the opposite edge on any geometric effect, so preview and render would
   * disagree at the borders of every fisheye, ripple and kaleidoscope.
   */
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
    // Correct the orientation ONCE, here. A canvas/VideoFrame has its first row
    // at the visual top; a GL texture has row 0 at the bottom. Flipping on upload
    // puts the source into the same convention the framebuffer textures already
    // use, so the vertex shader needs no flip and any number of passes composes
    // without the image ending up upside down. (Doing it in the shader instead
    // re-flips on every pass — that was the bug.)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Reset immediately: the flag is global GL state, and leaving it set would
    // silently flip any future upload made anywhere else on this context.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  private setUniforms(
    gl: WebGL2RenderingContext,
    pass: CompiledPass,
    layer: TimedEffectLayer,
    timelineTime: number,
    width: number,
    height: number,
    strength: number,
  ): void {
    const duration = Math.max(0, layer.end - layer.start);
    // Layer-relative, so moving a layer never changes how its envelope looks —
    // the same contract `EffectContext.local_time` documents on the engine side.
    const localTime = Math.max(0, timelineTime - layer.start);
    const progress = duration > 0 ? Math.min(1, Math.max(0, localTime / duration)) : 0;

    gl.uniform2f(pass.uniforms.resolution, width, height);
    gl.uniform1f(pass.uniforms.localTime, localTime);
    gl.uniform1f(pass.uniforms.duration, duration);
    gl.uniform1f(pass.uniforms.progress, progress);
    // Derived from ABSOLUTE time so scrubbing to 4.0s looks like playing to 4.0s.
    gl.uniform1i(pass.uniforms.noiseFrame, quantizeTime(timelineTime));
    gl.uniform1f(pass.uniforms.intensity, Math.min(1, Math.max(0, strength)));
    gl.uniform1fv(pass.uniforms.params, this.paramVector(layer));
  }

  /**
   * The layer's params packed into the fixed `uParams[8]` slot order.
   *
   * Order comes from `EFFECT_PARAMS[kind]` — the SAME declaration the Inspector
   * builds its sliders from and the engine clamps against — so a shader's
   * `uParams[2]` always means the third declared param of its kind. Missing
   * values fall back to the declared default rather than 0, since 0 is a
   * meaningful value for most params and would silently change the look.
   */
  private paramVector(layer: TimedEffectLayer): Float32Array {
    const out = new Float32Array(MAX_PARAMS);
    const descriptors = EFFECT_PARAMS[layer.kind] ?? [];
    for (let i = 0; i < descriptors.length && i < MAX_PARAMS; i += 1) {
      const descriptor = descriptors[i];
      if (descriptor === undefined) continue;
      const raw = layer.params[descriptor.name];
      const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : descriptor.default;
      out[i] = Math.min(descriptor.max, Math.max(descriptor.min, value));
    }
    return out;
  }

  private programOf(gl: WebGL2RenderingContext, kind: EffectRenderKind): CompiledPass | null {
    const cached = this.programs.get(kind);
    if (cached !== undefined) return cached;
    const body =
      // The internal final-blit program is not a catalog kind; it just samples.
      (kind as string) === 'blit'
        ? 'vec3 effect(vec3 c, vec2 uv) { return c; }'
        : GLSL_PASSES[kind];
    const compiled = body === undefined ? null : this.compile(gl, body, kind);
    this.programs.set(kind, compiled);
    return compiled;
  }

  private compile(gl: WebGL2RenderingContext, body: string, kind: string): CompiledPass | null {
    const vertex = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER, kind);
    const fragment = this.compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `${FRAGMENT_PREAMBLE}\n${body}\n${FRAGMENT_EPILOGUE}`,
      kind,
    );
    if (vertex === null || fragment === null) return null;

    const program = gl.createProgram();
    if (program === null) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    // Shaders are deletable immediately after link — the program keeps its own
    // reference, and holding them would leak one pair per compiled kind.
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
        localTime: gl.getUniformLocation(program, 'uLocalTime'),
        duration: gl.getUniformLocation(program, 'uDuration'),
        progress: gl.getUniformLocation(program, 'uProgress'),
        noiseFrame: gl.getUniformLocation(program, 'uNoiseFrame'),
        params: gl.getUniformLocation(program, 'uParams'),
        intensity: gl.getUniformLocation(program, 'uIntensity'),
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
