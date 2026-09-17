/**
 * What the matte host measures about media itself, independent of anything a worker claims.
 *
 * WHY a separate seam: host verification (BR4.2) and the media re-check (BR4.10) must not
 * trust the pack's descriptor. Two sources answer:
 *
 * - **ffprobe** (bundled with the base app): stream facts and the decoded timestamps. Frame
 *   identity follows the engine (`render/pts_reader.py`): packet pts of the first video
 *   stream, discarded (`D`) packets dropped, sorted into presentation order.
 * - **The Python sidecar** (BR4.13), which carries ffmpeg: decoded-frame sha256 by exact pts,
 *   and locked-frame comparison. A packaged build ships no desktop ffmpeg, so these go through
 *   `/mattes/frame-hashes` and `/mattes/locked-frames`. When the sidecar is down or refuses, the
 *   error is typed and every caller fails closed.
 *
 * Paths are only ever passed as their own argv element or JSON field; nothing is interpolated
 * into a filter graph or shell.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

/** First video stream facts, as ffprobe reports them. */
export interface MatteVideoProbe {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  /** Packets read; FFV1 is intra-only, so one packet per frame. */
  readonly frameCount: number;
}

/** Presentation timestamps of every decoded frame, in the stream's own time base. */
export interface MatteVideoTiming {
  readonly timeBase: readonly [number, number];
  readonly pts: readonly number[];
}

export interface LockedFrameVerdicts {
  readonly expected: readonly boolean[];
  readonly carried: readonly boolean[];
}

export interface MatteMediaInspector {
  probeVideo(file: string, signal?: AbortSignal): Promise<MatteVideoProbe>;
  videoTiming(file: string, signal?: AbortSignal): Promise<MatteVideoTiming>;
  /**
   * sha256 of the decoded frame at each exact pts (source stream ticks). A pts whose decoded
   * frame does not come back with that pts yields `undefined` (treated as changed).
   */
  frameHashesByPts(file: string, pts: readonly number[], signal?: AbortSignal): Promise<readonly (string | undefined)[]>;
  /**
   * Whether matte frames (by decode index, 8-bit gray) are bit-identical to expected pixel
   * hashes, and to frames of a previous matte. The previous matte's hashes never cross over.
   */
  compareLockedFrames(
    matteFile: string,
    expected: readonly { readonly index: number; readonly sha256: string }[],
    previous: { readonly file: string; readonly carried: readonly { readonly index: number; readonly previousIndex: number }[] } | undefined,
    signal?: AbortSignal,
  ): Promise<LockedFrameVerdicts>;
}

export class MatteInspectorError extends Error {
  public constructor(
    public readonly code: 'tool_unavailable' | 'probe_failed' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'MatteInspectorError';
  }
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}
export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<CommandResult>;

/** ffprobe output is bounded: a packet list for hours of 60 fps footage fits well inside. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 60_000;
const TIMING_TIMEOUT_MS = 600_000;
/** Mirrors the engine's per-call bound. */
export const MAX_FRAMES_PER_SIDECAR_CALL = 256;
const MAX_LOCK_CHECKS_PER_CALL = 1_024;

export interface MatteMediaInspectorOptions {
  readonly ffprobe: string;
  /** The render sidecar, e.g. `http://127.0.0.1:8799`. */
  readonly sidecarBaseUrl: string;
  readonly fetch: typeof fetch;
  readonly run?: CommandRunner;
  /** Backoff between 503 busy retries; injectable for tests. */
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/** Production inspector: ffprobe for stream facts and timing, the sidecar for decoded pixels. */
export class DesktopMatteMediaInspector implements MatteMediaInspector {
  private readonly run: CommandRunner;

  public constructor(private readonly options: MatteMediaInspectorOptions) {
    this.run = options.run ?? runBounded;
  }

  public async probeVideo(file: string, signal?: AbortSignal): Promise<MatteVideoProbe> {
    const result = await this.run(
      this.options.ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_packets',
        '-show_entries', 'stream=width,height,pix_fmt,nb_read_packets',
        '-of', 'json',
        ...hardenedInput(file),
        '-i', file,
      ],
      { timeoutMs: PROBE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    if (result.exitCode !== 0) throw probeFailed(file);
    return parseProbe(result.stdout, file);
  }

  public async videoTiming(file: string, signal?: AbortSignal): Promise<MatteVideoTiming> {
    const header = await this.run(
      this.options.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'csv=p=0', ...hardenedInput(file), '-i', file],
      { timeoutMs: PROBE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    const packets = await this.run(
      this.options.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,flags', '-of', 'csv=p=0', ...hardenedInput(file), '-i', file],
      { timeoutMs: TIMING_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    if (header.exitCode !== 0 || packets.exitCode !== 0) throw probeFailed(file);
    return parseTiming(header.stdout, packets.stdout, file);
  }

  public async frameHashesByPts(
    file: string,
    pts: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly (string | undefined)[]> {
    if (pts.some((value) => !Number.isSafeInteger(value))) throw new RangeError('pts must be integers');
    const out: (string | undefined)[] = [];
    for (let start = 0; start < pts.length; start += MAX_FRAMES_PER_SIDECAR_CALL) {
      const body = await this.post(
        '/mattes/frame-hashes',
        { input_path: file, pts: pts.slice(start, start + MAX_FRAMES_PER_SIDECAR_CALL), pixel_format: 'native' },
        signal,
        sidecarTimeoutMs({ ptsCount: Math.min(MAX_FRAMES_PER_SIDECAR_CALL, pts.length - start) }),
      );
      const hashes = (body as { hashes?: unknown }).hashes;
      if (!Array.isArray(hashes) || hashes.length !== Math.min(MAX_FRAMES_PER_SIDECAR_CALL, pts.length - start)) {
        throw new MatteInspectorError('probe_failed', 'The engine returned a malformed frame hash list.');
      }
      for (const hash of hashes) out.push(typeof hash === 'string' && /^[0-9a-f]{64}$/u.test(hash) ? hash : undefined);
    }
    return out;
  }

  public async compareLockedFrames(
    matteFile: string,
    expected: readonly { readonly index: number; readonly sha256: string }[],
    previous: { readonly file: string; readonly carried: readonly { readonly index: number; readonly previousIndex: number }[] } | undefined,
    signal?: AbortSignal,
  ): Promise<LockedFrameVerdicts> {
    const carried = previous?.carried ?? [];
    if (expected.length > MAX_LOCK_CHECKS_PER_CALL || carried.length > MAX_LOCK_CHECKS_PER_CALL) {
      throw new RangeError('at most 1024 locked-frame checks per call');
    }
    const body = await this.post(
      '/mattes/locked-frames',
      {
        matte_path: matteFile,
        expected: expected.map((item) => ({ index: item.index, sha256: item.sha256 })),
        ...(previous === undefined
          ? {}
          : {
              previous_matte_path: previous.file,
              carried: carried.map((item) => ({ index: item.index, previous_index: item.previousIndex })),
            }),
      },
      signal,
      sidecarTimeoutMs({
        highestFrame: Math.max(0, ...expected.map((item) => item.index), ...carried.map((item) => Math.max(item.index, item.previousIndex))),
      }),
    );
    const verdicts = body as { expected?: unknown; carried?: unknown };
    const booleans = (value: unknown, length: number): boolean[] => {
      if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === 'boolean')) {
        throw new MatteInspectorError('probe_failed', 'The engine returned a malformed locked-frame verdict.');
      }
      return value as boolean[];
    };
    return { expected: booleans(verdicts.expected, expected.length), carried: booleans(verdicts.carried, carried.length) };
  }

  /** POST JSON to the sidecar. Down, refused or malformed → a typed error; callers fail closed. */
  /**
   * POST JSON to the sidecar. A 503 "busy" (one check per route at a time) is retried with bounded
   * backoff; down, refused, still busy after the retries, or malformed answers are typed errors and
   * callers fail closed.
   */
  private async post(route: string, payload: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    const delays = this.options.retryDelaysMs ?? SIDECAR_BUSY_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      if (isAborted(signal)) throw new MatteInspectorError('cancelled', 'Media check cancelled.');
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        response = await this.options.fetch(new URL(route, this.options.sidecarBaseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: combined,
        });
      } catch {
        // The caller's signal may have aborted during the await.
        if (isAborted(signal)) throw new MatteInspectorError('cancelled', 'Media check cancelled.');
        throw new MatteInspectorError('tool_unavailable', 'The FramePilot engine is not running, so frames cannot be checked.');
      }
      if (response.status === 503 && attempt < delays.length) {
        await (this.options.sleep ?? sleep)(delays[attempt]!, signal);
        continue;
      }
      if (response.status === 503 || response.status === 502) {
        throw new MatteInspectorError('tool_unavailable', 'The FramePilot engine cannot check frames right now.');
      }
      if (response.status === 504) {
        throw new MatteInspectorError('tool_unavailable', 'The frame check ran out of time.');
      }
      if (!response.ok) {
        // 400/404/422: outside the projects folder, missing or undecodable. Never "unchanged".
        throw new MatteInspectorError('probe_failed', `The engine could not check frames (HTTP ${response.status}).`);
      }
      try {
        return await response.json();
      } catch {
        throw new MatteInspectorError('probe_failed', 'The engine returned malformed JSON.');
      }
    }
  }
}

/** Retries for a 503 busy route: 5 attempts over about 15 s. */
export const SIDECAR_BUSY_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * The client-side budget for one sidecar check, a minute beyond the engine's own deadline
 * (`matte_route_deadline` in service.py: 600 s + 30 s per pts + 0.05 s per frame up to the highest
 * index, capped at 6 h), so the engine always answers first with a typed 504.
 */
export function sidecarTimeoutMs(work: { readonly ptsCount?: number; readonly highestFrame?: number }): number {
  const engineSeconds = Math.min(6 * 60 * 60, 600 + 30 * (work.ptsCount ?? 0) + 0.05 * (work.highestFrame ?? 0));
  return Math.ceil((engineSeconds + 60) * 1_000);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Resolve the app's own ffprobe: the existing `FRAMEPILOT_FFPROBE` override, then the binary
 * staged beside the bundled engine, then the PATH name.
 */
export function resolveMatteFfprobe(context: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform: NodeJS.Platform;
  readonly fileExists: (file: string) => boolean;
}): string {
  const suffix = context.platform === 'win32' ? '.exe' : '';
  const override = context.env.FRAMEPILOT_FFPROBE?.trim();
  if (override !== undefined && override !== '') return override;
  if (context.isPackaged) {
    const staged = path.join(context.resourcesPath, 'engine', `ffprobe${suffix}`);
    if (context.fileExists(staged)) return staged;
  }
  return `ffprobe${suffix}`;
}

export function parseProbe(stdout: string, file: string): MatteVideoProbe {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw probeFailed(file);
  }
  const stream = (document as { streams?: unknown[] } | null)?.streams?.[0] as
    | Record<string, unknown>
    | undefined;
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const frameCount = Number(stream?.nb_read_packets ?? 0);
  const pixelFormat = stream?.pix_fmt;
  if (
    !Number.isSafeInteger(width) || width <= 0 ||
    !Number.isSafeInteger(height) || height <= 0 ||
    !Number.isSafeInteger(frameCount) || frameCount < 0 ||
    typeof pixelFormat !== 'string'
  ) {
    throw probeFailed(file);
  }
  return { width, height, pixelFormat, frameCount };
}

export function parseTiming(headerStdout: string, packetStdout: string, file: string): MatteVideoTiming {
  const match = /^(\d+)\/(\d+)\s*$/mu.exec(headerStdout.trim());
  const numerator = Number(match?.[1]);
  const denominator = Number(match?.[2]);
  if (!(numerator > 0) || !(denominator > 0)) throw probeFailed(file);
  const pts: number[] = [];
  for (const line of packetStdout.split(/\r?\n/u)) {
    const [ptsText, flags = ''] = line.split(',', 2);
    if (ptsText === undefined || ptsText === '' || ptsText === 'N/A' || flags.includes('D')) continue;
    const value = Number(ptsText);
    if (!Number.isSafeInteger(value)) throw probeFailed(file);
    pts.push(value);
  }
  if (pts.length === 0) throw probeFailed(file);
  pts.sort((left, right) => left - right);
  return { timeBase: [numerator, denominator], pts };
}

/**
 * Mirrors the engine's `frame_hashes.py` (BR4.12 M3): only local files, only real media
 * containers (a playlist or ffconcat renamed to `.mp4` cannot open another file), and the
 * Matroska demuxer forced for the host's own `matte.mkv`.
 */
export const MEDIA_FORMAT_WHITELIST =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,flv,mxf,ogg,asf,dv,ivf,gif,image2,png_pipe,jpeg_pipe,webp_pipe,tiff_pipe,bmp_pipe';

export function hardenedInput(file: string): string[] {
  return [
    '-protocol_whitelist', 'file',
    '-format_whitelist', MEDIA_FORMAT_WHITELIST,
    ...(path.basename(file) === 'matte.mkv' || path.basename(file) === 'foreground.mkv' ? ['-f', 'matroska'] : []),
  ];
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function probeFailed(file: string): MatteInspectorError {
  // The base name only: logs and errors never carry a full media path.
  return new MatteInspectorError('probe_failed', `Could not read ${path.basename(file)}.`);
}

const runBounded: CommandRunner = (executable, args, options) =>
  new Promise<CommandResult>((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new MatteInspectorError('cancelled', 'Media check cancelled.'));
      return;
    }
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const kill = (): void => {
      child.kill('SIGKILL');
    };
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    const finish = (error: Error | undefined, result?: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      if (options.signal?.aborted === true) reject(new MatteInspectorError('cancelled', 'Media check cancelled.'));
      else if (error !== undefined) reject(error);
      else resolve(result!);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_STDOUT_BYTES) {
        kill();
        finish(new MatteInspectorError('probe_failed', 'Media check output exceeded its bound.'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new MatteInspectorError(
          error.code === 'ENOENT' ? 'tool_unavailable' : 'probe_failed',
          `Could not run ${path.basename(executable)}.`,
        ),
      ),
    );
    child.on('close', (exitCode) =>
      finish(undefined, { exitCode, stdout: Buffer.concat(chunks).toString('utf8') }),
    );
  });
