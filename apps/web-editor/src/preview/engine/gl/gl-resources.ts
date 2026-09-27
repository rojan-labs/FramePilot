/**
 * WebGL2 plumbing for the layer compositor: programs, a render-target pool, integer data
 * textures. Kept apart from `layer-compositor.ts` so that file reads as the export's pipeline
 * rather than as GL bookkeeping.
 */
import { FULLSCREEN_VERTEX } from './raster-shaders.js';

/** A texture unit no pass samples from: allocations and uploads bind there (see useScratchUnit). */
const SCRATCH_TEXTURE_UNIT = 15;

export type TargetFormat = 'rgba8' | 'r16i' | 'rgba32f' | 'r32f' | 'r8ui';

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

/** Bytes per texel of each render-target format (for {@link GlResources.poolBytes}). */
const TARGET_FORMAT_BYTES: Record<TargetFormat, number> = {
  rgba8: 4,
  r16i: 2,
  rgba32f: 16,
  r32f: 4,
  r8ui: 1,
};
/**
 * Uploaded source textures kept by key ({@link GlResources.keyedTexture}): two matte frames
 * (alpha + foreground each), enough for the two composites a 60 Hz display runs per frame.
 */
const KEYED_TEXTURE_CAPACITY = 4;
const FLOAT_PLANE_BYTES = 4;

interface KeyedTexture {
  readonly texture: WebGLTexture;
  readonly bytes: number;
  /** Layout and size: which spare list it returns to. */
  readonly shape: string;
}
const INT_TABLE_BYTES = 4;

/**
 * Source uploads kept across frames ({@link GlResources.imageTarget}, {@link GlResources.bytesTarget},
 * {@link GlResources.maskPlane}). A still, a title, caption or shape raster, a mask raster and a
 * frosted chip's coverage are the same object frame after frame, and uploading them again every
 * frame cost more than drawing them: a 12 MP still is 48 MB of texture upload per frame.
 */
const SOURCE_CACHE_BYTES = 256 * 1024 * 1024;
const SOURCE_CACHE_ENTRIES = 64;
/**
 * Pooled targets the frame just drawn did not use are kept up to this many bytes, the least
 * recently used deleted first. An animated scale (a zoom, a title pop) resizes to a new size
 * every frame, and each of those sizes' targets used to stay allocated for the whole session.
 *
 * WHY a byte bound and no idle clock: a target is only deleted in the frame whose working set
 * pushed the idle bytes over it, so a steady timeline's footprint stays flat (PX5 asserts it)
 * instead of dropping at whatever later frame a clock ran out.
 */
const POOL_IDLE_BYTES = 128 * 1024 * 1024;

type SourceFormat = Extract<TargetFormat, 'rgba8' | 'r8ui'>;

/** A source upload kept by the identity of the object it was uploaded from. */
interface KeptUpload {
  readonly target: RenderTarget;
  readonly bytes: number;
  /** The frame it was uploaded in. */
  readonly firstFrame: number;
  /** The last frame that drew it: an upload that frame drew is never evicted during it. */
  lastFrame: number;
}

/**
 * Whether the pixels of `source` can never change under the same object, so an upload of it can
 * be kept by identity. An `ImageBitmap` is immutable, and the rasterisers never write an
 * `ImageData` after handing it over. A canvas or a video element is redrawn in place, and a
 * `VideoFrame` is drawn once per project frame, so keeping it would only evict what repeats.
 */
function keepableImage(source: TexImageSource): boolean {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    // A closed bitmap reports 0x0. It is never kept, and its upload fails as it always did.
    return source.width > 0 && source.height > 0;
  }
  return typeof ImageData !== 'undefined' && source instanceof ImageData;
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
  private readonly dataTextureBytes = new Map<string, number>();
  private readonly keyedTextures = new Map<string, KeyedTexture>();
  /** Evicted keyed textures by storage shape, re-filled instead of re-created (PX5.3). */
  private readonly spareKeyed = new Map<string, WebGLTexture[]>();
  private allocatedBytes = 0;
  private allocatedTextures = 0;
  /** Frames finished so far ({@link endFrame}): the clock idle targets and kept uploads age by. */
  private frame = 0;
  /** The frame each pooled target was last returned in, for {@link trimIdleTargets}. */
  private readonly lastUsed = new WeakMap<RenderTarget, number>();
  /** Kept uploads by source object. Weak: a source its owner dropped is not held alive here. */
  private keptUploads = new WeakMap<object, KeptUpload>();
  /** The kept uploads, least recently drawn first: what eviction walks. */
  private readonly keptOrder = new Set<KeptUpload>();
  private keptBytes = 0;
  private frameSourceUploads = 0;
  private frameSourceHits = 0;
  private lastFrameSourceUploads = 0;
  private lastFrameSourceHits = 0;

  /**
   * Bytes of texture storage this context holds (pooled targets, kept source uploads, planes and
   * filter tables), by the formats' sizes. On a steady timeline it stops growing once every size
   * the frame needs is allocated; PX5 reads it to show the pools stay bounded.
   */
  get poolBytes(): number {
    return this.allocatedBytes;
  }

  /** Textures behind {@link poolBytes}. */
  get poolTextures(): number {
    return this.allocatedTextures;
  }

  /** Bytes of the source uploads kept across frames (part of {@link poolBytes}). */
  get sourceCacheBytes(): number {
    return this.keptBytes;
  }

  /** Source uploads kept across frames. */
  get sourceCacheEntries(): number {
    return this.keptOrder.size;
  }

  /**
   * Keepable sources (stills, rasters, mask rasters, coverages) the last finished frame uploaded,
   * 0 once a steady timeline's sources are kept, and those it drew from kept uploads instead.
   */
  get lastFrameSources(): { readonly uploads: number; readonly hits: number } {
    return { uploads: this.lastFrameSourceUploads, hits: this.lastFrameSourceHits };
  }

  private account(bytes: number): void {
    this.allocatedBytes += bytes;
    this.allocatedTextures += 1;
  }

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
    const target = this.takeTarget(width, height, format);
    this.inUse.push(target);
    return target;
  }

  /** A pooled target of this size and format, or a new one; the caller owns it. */
  private takeTarget(width: number, height: number, format: TargetFormat): RenderTarget {
    const key = `${width}x${height}:${format}`;
    const list = this.free.get(key);
    const pooled = list?.pop();
    if (list?.length === 0) this.free.delete(key);
    return pooled ?? this.createTarget(width, height, format);
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
    } else if (format === 'r32f') {
      // One float channel (PX5.3): a matte's alpha at its artifact's own size, a quarter of
      // the storage `rgba32f` would hold for the three channels nothing reads.
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, height);
    } else if (format === 'r8ui') {
      // The one integer coverage format the mask shaders sample (`usampler2D u_mask`), so a
      // stack built on the GPU binds exactly where an uploaded CPU raster binds.
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, width, height);
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
    this.account(width * height * TARGET_FORMAT_BYTES[format]);
    return { texture, framebuffer, width, height, format };
  }

  /** Keep a target alive past {@link endFrame} (the caller releases it with {@link recycle}). */
  retain(target: RenderTarget): void {
    const index = this.inUse.indexOf(target);
    if (index >= 0) this.inUse.splice(index, 1);
  }

  recycle(target: RenderTarget): void {
    this.returnToPool(target, this.frame);
  }

  /** Put `target` in the free pool as last used in frame `lastUsed`. */
  private returnToPool(target: RenderTarget, lastUsed: number): void {
    const key = `${target.width}x${target.height}:${target.format}`;
    const list = this.free.get(key) ?? [];
    list.push(target);
    this.free.set(key, list);
    this.lastUsed.set(target, lastUsed);
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
      this.account(width * height);
    } else {
      this.useScratchUnit();
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    this.planeInUse.push(texture);
    (texture as { __planeKey?: string }).__planeKey = key;
    return texture;
  }

  /**
   * A single-channel FLOAT texture holding `data`, for a mask layer that must not be quantised
   * before the stack is combined (MK6.1: the export quantises the stack once, at the end).
   * Pooled by size and released at {@link endFrame}.
   */
  floatPlane(width: number, height: number, data: Float32Array): WebGLTexture {
    const gl = this.gl;
    const key = `f${width}x${height}`;
    const pooled = this.planeTextures.get(key)?.pop();
    let texture = pooled;
    if (!texture) {
      const created = gl.createTexture();
      if (!created) throw new Error('WebGL2 could not allocate a float plane texture.');
      texture = created;
      this.useScratchUnit();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, height);
      setNearest(gl);
      this.account(width * height * FLOAT_PLANE_BYTES);
    } else {
      this.useScratchUnit();
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, data);
    this.planeInUse.push(texture);
    (texture as { __planeKey?: string }).__planeKey = key;
    return texture;
  }

  /**
   * An `RGBA8` render target holding an image, canvas or `VideoFrame` exactly as decoded. An
   * `ImageBitmap` or `ImageData` drawn again in a later frame is served from the upload kept for
   * that object ({@link keptUpload}), the same bytes on the GPU; read it, never draw into it.
   */
  imageTarget(source: TexImageSource, width: number, height: number): RenderTarget {
    const gl = this.gl;
    const upload = (): void =>
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const keepable = keepableImage(source);
    const kept = keepable ? this.keptUpload(source, width, height, 'rgba8', upload) : null;
    if (kept !== null) return kept;
    const target = this.target(width, height, 'rgba8');
    this.useScratchUnit();
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    upload();
    if (keepable) this.frameSourceUploads += 1;
    return target;
  }

  /**
   * An `RGBA8` render target holding straight RGBA bytes, rows top first. Kept by the identity
   * of `data` like {@link imageTarget}, so `data` must not be written after it is handed here.
   */
  bytesTarget(data: Uint8Array, width: number, height: number): RenderTarget {
    const gl = this.gl;
    const upload = (): void =>
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const kept = this.keptUpload(data, width, height, 'rgba8', upload);
    if (kept !== null) return kept;
    const target = this.target(width, height, 'rgba8');
    this.useScratchUnit();
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    upload();
    this.frameSourceUploads += 1;
    return target;
  }

  /**
   * A mask raster's coverage as the `R8UI` texture the mask shaders sample: {@link plane}, but
   * kept by the identity of `data` like {@link imageTarget}. A still mask's raster is the same
   * cached array frame after frame; `data` must not be written after it is handed here.
   */
  maskPlane(width: number, height: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const { RED_INTEGER, UNSIGNED_BYTE } = gl;
    const upload = (): void =>
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, RED_INTEGER, UNSIGNED_BYTE, data);
    const kept = this.keptUpload(data, width, height, 'r8ui', upload);
    if (kept !== null) return kept.texture;
    this.frameSourceUploads += 1;
    return this.plane(width, height, data);
  }

  /**
   * The upload kept for `source`, uploaded into a kept target first when there is none, or
   * `null` when the caller uploads it for this frame only (no room among the uploads this frame
   * has not drawn, or the same object asked for at another size).
   *
   * Kept uploads live in pooled targets the cache owns; an evicted one goes back to the free
   * pool, where the next upload of its size refills it instead of allocating. An upload no later
   * frame draws again (an animated mask's or caption's per-frame raster) is evicted at the end
   * of the next frame ({@link evictUnrepeated}), so those cost what they did before the cache.
   *
   * @param upload - Uploads the pixels into the texture bound on the scratch unit.
   */
  private keptUpload(
    source: object,
    width: number,
    height: number,
    format: SourceFormat,
    upload: () => void,
  ): RenderTarget | null {
    const kept = this.keptUploads.get(source);
    if (kept !== undefined && this.keptOrder.has(kept)) {
      const { target } = kept;
      if (target.width !== width || target.height !== height || target.format !== format) {
        return null;
      }
      kept.lastFrame = this.frame;
      this.keptOrder.delete(kept);
      this.keptOrder.add(kept);
      this.frameSourceHits += 1;
      return target;
    }
    const bytes = width * height * TARGET_FORMAT_BYTES[format];
    if (!this.makeKeptRoom(bytes)) return null;
    const target = this.takeTarget(width, height, format);
    this.useScratchUnit();
    this.gl.bindTexture(this.gl.TEXTURE_2D, target.texture);
    upload();
    const entry: KeptUpload = { target, bytes, firstFrame: this.frame, lastFrame: this.frame };
    this.keptUploads.set(source, entry);
    this.keptOrder.add(entry);
    this.keptBytes += bytes;
    this.frameSourceUploads += 1;
    return target;
  }

  /**
   * Evict kept uploads, least recently drawn first, until `bytes` more fit both bounds. An upload
   * this frame drew is never evicted (a pass may still read it), so this can fail.
   */
  private makeKeptRoom(bytes: number): boolean {
    const fits = (): boolean =>
      this.keptBytes + bytes <= SOURCE_CACHE_BYTES && this.keptOrder.size < SOURCE_CACHE_ENTRIES;
    for (const entry of this.keptOrder) {
      if (fits()) return true;
      // Drawn uploads move to the back, so everything from here on was drawn this frame too.
      if (entry.lastFrame === this.frame) break;
      this.evictKept(entry);
    }
    return fits();
  }

  /** Stop keeping `entry`: its target goes back to the free pool as last used when it was drawn. */
  private evictKept(entry: KeptUpload): void {
    this.keptOrder.delete(entry);
    this.keptBytes -= entry.bytes;
    this.returnToPool(entry.target, entry.lastFrame);
  }

  /** Evict the uploads made in an earlier frame that no frame since has drawn again. */
  private evictUnrepeated(): void {
    for (const entry of this.keptOrder) {
      if (entry.lastFrame === entry.firstFrame && entry.lastFrame < this.frame) {
        this.evictKept(entry);
      }
    }
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
    this.dataTextureBytes.set(key, width * height * INT_TABLE_BYTES);
    this.account(width * height * INT_TABLE_BYTES);
    this.boundDataTextures(key);
    return texture;
  }

  /**
   * An unsigned-integer source texture uploaded ONCE per `key` and kept while it is among the
   * most recently used (PX5.3).
   *
   * WHY not the per-frame plane pool: a matte frame is composited more than once — twice per
   * project frame on a 60 Hz display, and again on every paused repaint — and a 4K master is
   * 8 MB of alpha plus 25 MB of foreground. Uploading that per composite would cost more than
   * the passes that read it. The cache is a fixed handful of frames, so the pool bytes it adds
   * are constant on a steady timeline.
   *
   * @param layout - `r8`/`r16`: one channel; `rgb8`: interleaved R, G, B bytes.
   */
  keyedTexture(
    key: string,
    width: number,
    height: number,
    layout: 'r8' | 'r16' | 'rgb8',
    data: Uint8Array | Uint16Array,
  ): WebGLTexture {
    const cached = this.keyedTextures.get(key);
    if (cached !== undefined) {
      this.keyedTextures.delete(key);
      this.keyedTextures.set(key, cached);
      return cached.texture;
    }
    const gl = this.gl;
    const shape = `${layout}:${width}x${height}`;
    const bytes = width * height * (layout === 'rgb8' ? 3 : layout === 'r16' ? 2 : 1);
    const format =
      layout === 'rgb8'
        ? { internal: gl.RGB8UI, upload: gl.RGB_INTEGER, type: gl.UNSIGNED_BYTE }
        : layout === 'r16'
          ? { internal: gl.R16UI, upload: gl.RED_INTEGER, type: gl.UNSIGNED_SHORT }
          : { internal: gl.R8UI, upload: gl.RED_INTEGER, type: gl.UNSIGNED_BYTE };
    // A matte frame is replaced by the next one of the same shape about 30 times a second.
    // Creating and deleting a 25 MB texture at that rate lets the driver's deferred frees pile
    // up (PX5.3 measured the footprint doing it), so an evicted texture is re-filled instead.
    let texture = this.spareKeyed.get(shape)?.pop() ?? null;
    this.useScratchUnit();
    if (texture === null) {
      texture = gl.createTexture();
      if (!texture) throw new Error('WebGL2 could not allocate a source texture.');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format.internal, width, height);
      setNearest(gl);
      this.account(bytes);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format.upload, format.type, data);
    this.keyedTextures.set(key, { texture, bytes, shape });
    while (this.keyedTextures.size > KEYED_TEXTURE_CAPACITY) {
      const oldest = this.keyedTextures.keys().next().value!;
      const entry = this.keyedTextures.get(oldest)!;
      this.keyedTextures.delete(oldest);
      const spares = this.spareKeyed.get(entry.shape) ?? [];
      if (spares.length < KEYED_TEXTURE_CAPACITY) {
        spares.push(entry.texture);
        this.spareKeyed.set(entry.shape, spares);
      } else {
        gl.deleteTexture(entry.texture);
        this.allocatedBytes -= entry.bytes;
        this.allocatedTextures -= 1;
      }
    }
    return texture;
  }

  /** A persistent `R32F` data texture (`width × height`), built once per key: filter weights. */
  floatTable(key: string, width: number, height: number, build: () => Float32Array): WebGLTexture {
    const name = `f:${key}`;
    const cached = this.dataTextures.get(name);
    if (cached) return cached;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL2 could not allocate a data texture.');
    this.useScratchUnit();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, build());
    setNearest(gl);
    this.dataTextures.set(name, texture);
    this.dataTextureBytes.set(name, width * height * FLOAT_PLANE_BYTES);
    this.account(width * height * FLOAT_PLANE_BYTES);
    this.boundDataTextures(name);
    return texture;
  }

  /** Filter tables are small but one exists per size pair; keep a bound on a long session. */
  private boundDataTextures(justAdded: string): void {
    if (this.dataTextures.size <= 256) return;
    const oldest = this.dataTextures.keys().next().value;
    if (oldest === undefined || oldest === justAdded) return;
    this.gl.deleteTexture(this.dataTextures.get(oldest)!);
    this.dataTextures.delete(oldest);
    this.allocatedBytes -= this.dataTextureBytes.get(oldest) ?? 0;
    this.allocatedTextures -= 1;
    this.dataTextureBytes.delete(oldest);
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

  /**
   * Return this frame's transient targets and planes to their pools, and delete the pooled
   * targets beyond {@link POOL_IDLE_BYTES} that this frame did not use.
   */
  endFrame(): void {
    for (const target of this.inUse.splice(0)) this.recycle(target);
    for (const texture of this.planeInUse.splice(0)) {
      const key = (texture as { __planeKey?: string }).__planeKey ?? '';
      const list = this.planeTextures.get(key) ?? [];
      list.push(texture);
      this.planeTextures.set(key, list);
    }
    this.evictUnrepeated();
    this.trimIdleTargets();
    this.lastFrameSourceUploads = this.frameSourceUploads;
    this.lastFrameSourceHits = this.frameSourceHits;
    this.frameSourceUploads = 0;
    this.frameSourceHits = 0;
    this.frame += 1;
  }

  /**
   * Delete the free targets this frame did not use, least recently used first, until what is
   * left of them fits {@link POOL_IDLE_BYTES}. Only free targets are candidates: one this frame
   * drew with is back in the pool as used now, and a kept upload is not in the pool at all.
   */
  private trimIdleTargets(): void {
    const idle: RenderTarget[] = [];
    let idleBytes = 0;
    for (const list of this.free.values()) {
      for (const target of list) {
        if ((this.lastUsed.get(target) ?? -1) >= this.frame) continue;
        idle.push(target);
        idleBytes += targetBytes(target);
      }
    }
    if (idleBytes <= POOL_IDLE_BYTES) return;
    idle.sort((a, b) => (this.lastUsed.get(a) ?? -1) - (this.lastUsed.get(b) ?? -1));
    const gl = this.gl;
    for (const target of idle) {
      if (idleBytes <= POOL_IDLE_BYTES) break;
      const key = `${target.width}x${target.height}:${target.format}`;
      const list = this.free.get(key)!;
      list.splice(list.indexOf(target), 1);
      if (list.length === 0) this.free.delete(key);
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
      const bytes = targetBytes(target);
      idleBytes -= bytes;
      this.allocatedBytes -= bytes;
      this.allocatedTextures -= 1;
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
    // An evicted upload is in the free pool (deleted above); these are the ones still kept.
    for (const { target } of this.keptOrder) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    this.keptOrder.clear();
    this.keptUploads = new WeakMap();
    this.keptBytes = 0;
    for (const texture of this.dataTextures.values()) gl.deleteTexture(texture);
    for (const entry of this.keyedTextures.values()) gl.deleteTexture(entry.texture);
    this.keyedTextures.clear();
    for (const list of this.spareKeyed.values())
      for (const texture of list) gl.deleteTexture(texture);
    this.spareKeyed.clear();
    for (const list of this.planeTextures.values())
      for (const texture of list) gl.deleteTexture(texture);
    for (const texture of this.planeInUse) gl.deleteTexture(texture);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vertexArray);
    this.programs.clear();
    this.free.clear();
    this.dataTextures.clear();
    this.planeTextures.clear();
    this.dataTextureBytes.clear();
    this.allocatedBytes = 0;
    this.allocatedTextures = 0;
  }
}

function targetBytes(target: RenderTarget): number {
  return target.width * target.height * TARGET_FORMAT_BYTES[target.format];
}

function setNearest(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
