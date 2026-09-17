/**
 * WebGL2 plumbing for the layer compositor: programs, a render-target pool, integer data
 * textures. Kept apart from `layer-compositor.ts` so that file reads as the export's pipeline
 * rather than as GL bookkeeping.
 */
import { FULLSCREEN_VERTEX } from './raster-shaders.js';

/** A texture unit no pass samples from: allocations and uploads bind there (see useScratchUnit). */
const SCRATCH_TEXTURE_UNIT = 15;

export type TargetFormat = 'rgba8' | 'r16i' | 'rgba32f';

/** A texture that can be drawn into. */
export interface RenderTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
  readonly format: TargetFormat;
}

/** A compiled program with its uniform locations resolved on first use. */
export class Program {
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly handle: WebGLProgram,
  ) {}

  location(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      this.locations.set(name, this.gl.getUniformLocation(this.handle, name));
    }
    return this.locations.get(name) ?? null;
  }

  int(name: string, value: number): void {
    this.gl.uniform1i(this.location(name), value);
  }

  ivec2(name: string, x: number, y: number): void {
    this.gl.uniform2i(this.location(name), x, y);
  }

  vec4(name: string, value: readonly [number, number, number, number]): void {
    this.gl.uniform4f(this.location(name), value[0], value[1], value[2], value[3]);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL2 could not allocate a shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'unknown error';
    gl.deleteShader(shader);
    throw new Error(`Compositor shader failed to compile: ${info}`);
  }
  return shader;
}

/** Shared GL objects for one context. */
export class GlResources {
  private readonly programs = new Map<string, Program>();
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly free = new Map<string, RenderTarget[]>();
  private readonly dataTextures = new Map<string, WebGLTexture>();
  private readonly planeTextures = new Map<string, WebGLTexture[]>();
  private readonly planeInUse: WebGLTexture[] = [];
  private readonly inUse: RenderTarget[] = [];

  constructor(readonly gl: WebGL2RenderingContext) {
    const vertexArray = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    if (!vertexArray || !vertexBuffer) throw new Error('WebGL2 could not allocate buffers.');
    this.vertexArray = vertexArray;
    this.vertexBuffer = vertexBuffer;
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    // One triangle covering clip space: no seam on the diagonal.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  program(name: string, fragment: string): Program {
    const cached = this.programs.get(name);
    if (cached) return cached;
    const gl = this.gl;
    const handle = gl.createProgram();
    if (!handle) throw new Error('WebGL2 could not allocate a program.');
    const vs = compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(handle, vs);
    gl.attachShader(handle, fs);
    gl.bindAttribLocation(handle, 0, 'a_position');
    gl.linkProgram(handle);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(handle) ?? 'unknown error';
      gl.deleteProgram(handle);
      throw new Error(`Compositor program ${name} failed to link: ${info}`);
    }
    const program = new Program(gl, handle);
    this.programs.set(name, program);
    return program;
  }

  /** A render target for this frame; returned to the pool by {@link endFrame}. */
  target(width: number, height: number, format: TargetFormat): RenderTarget {
    const key = `${width}x${height}:${format}`;
    const pooled = this.free.get(key)?.pop();
    const target = pooled ?? this.createTarget(width, height, format);
    this.inUse.push(target);
    return target;
  }

  private createTarget(width: number, height: number, format: TargetFormat): RenderTarget {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error('WebGL2 could not allocate a render target.');
    this.useScratchUnit();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (format === 'rgba8') {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    } else if (format === 'rgba32f') {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    } else {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16I, width, height);
    }
    setNearest(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error(`Compositor render target ${width}x${height} ${format} is incomplete.`);
    }
    return { texture, framebuffer, width, height, format };
  }

  /** Keep a target alive past {@link endFrame} (the caller releases it with {@link recycle}). */
  retain(target: RenderTarget): void {
    const index = this.inUse.indexOf(target);
    if (index >= 0) this.inUse.splice(index, 1);
  }

  recycle(target: RenderTarget): void {
    const key = `${target.width}x${target.height}:${target.format}`;
    const list = this.free.get(key) ?? [];
    list.push(target);
    this.free.set(key, list);
  }

  /**
   * An 8-bit unsigned single-channel texture holding `data` (a video plane).
   * Pooled by size and released at {@link endFrame}.
   */
  plane(width: number, height: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const key = `${width}x${height}`;
    const pooled = this.planeTextures.get(key)?.pop();
    let texture = pooled;
    if (!texture) {
      const created = gl.createTexture();
      if (!created) throw new Error('WebGL2 could not allocate a plane texture.');
      texture = created;
      this.useScratchUnit();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, width, height);
      setNearest(gl);
    } else {
      this.useScratchUnit();
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    this.planeInUse.push(texture);
    (texture as { __planeKey?: string }).__planeKey = key;
    return texture;
  }

  /** An `RGBA8` render target holding an image, canvas or `VideoFrame` exactly as decoded. */
  imageTarget(source: TexImageSource, width: number, height: number): RenderTarget {
    const gl = this.gl;
    const target = this.target(width, height, 'rgba8');
    this.useScratchUnit();
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return target;
  }

  /**
   * A persistent `R32I` data texture (`width × height`), built once per key: filter tables.
   */
  intTable(key: string, width: number, height: number, build: () => Int32Array): WebGLTexture {
    const cached = this.dataTextures.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL2 could not allocate a data texture.');
    this.useScratchUnit();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32I, width, height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.INT, build());
    setNearest(gl);
    this.dataTextures.set(key, texture);
    // Filter tables are small but one exists per size pair; keep a bound on a long session.
    if (this.dataTextures.size > 256) {
      const oldest = this.dataTextures.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        gl.deleteTexture(this.dataTextures.get(oldest)!);
        this.dataTextures.delete(oldest);
      }
    }
    return texture;
  }

  /** Draw a fullscreen pass into `target` (or the canvas when `null`). */
  draw(target: RenderTarget | null, width: number, height: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vertexArray);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * Make the scratch unit active before binding a texture only to allocate or upload it.
   *
   * Uploading on whatever unit is active replaced a sampler binding a pass had already made
   * (a pooled target allocated after `bind` only on a pool miss, so the first frames of a new
   * size composited another texture: the CI oracle's intermittent garbage reads).
   */
  useScratchUnit(): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + SCRATCH_TEXTURE_UNIT);
  }

  /** Bind `texture` to `unit` and point `name` of `program` at it. */
  bind(program: Program, name: string, unit: number, texture: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    program.int(name, unit);
  }

  /** Return this frame's transient targets and planes to their pools. */
  endFrame(): void {
    for (const target of this.inUse.splice(0)) this.recycle(target);
    for (const texture of this.planeInUse.splice(0)) {
      const key = (texture as { __planeKey?: string }).__planeKey ?? '';
      const list = this.planeTextures.get(key) ?? [];
      list.push(texture);
      this.planeTextures.set(key, list);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const program of this.programs.values()) gl.deleteProgram(program.handle);
    for (const list of this.free.values()) {
      for (const target of list) {
        gl.deleteFramebuffer(target.framebuffer);
        gl.deleteTexture(target.texture);
      }
    }
    for (const target of this.inUse) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    for (const texture of this.dataTextures.values()) gl.deleteTexture(texture);
    for (const list of this.planeTextures.values())
      for (const texture of list) gl.deleteTexture(texture);
    for (const texture of this.planeInUse) gl.deleteTexture(texture);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vertexArray);
    this.programs.clear();
    this.free.clear();
    this.dataTextures.clear();
    this.planeTextures.clear();
  }
}

function setNearest(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
