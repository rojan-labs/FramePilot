/**
 * What the matte host measures about media itself, independent of anything a worker claims.
 *
 * WHY a separate seam: host verification (BR4.2) and the media re-check (BR4.10) must not
 * trust the pack's descriptor, so they probe, list timestamps and hash decoded frames with
 * the application's own ffprobe/ffmpeg. Tests inject a fake; production spawns the binaries
 * with a fixed argv (`shell: false`). Paths are only ever passed as their own `-i` argument,
 * never interpolated into a filter graph, so a file name cannot change what runs.
 *
 * Frame identity follows the engine (`render/pts_reader.py`): packet pts of the first video
 * stream, discarded (`D`) packets dropped, sorted into presentation order.
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

export interface MatteMediaInspector {
  probeVideo(file: string, signal?: AbortSignal): Promise<MatteVideoProbe>;
  videoTiming(file: string, signal?: AbortSignal): Promise<MatteVideoTiming>;
  /**
   * sha256 of the decoded pixels of frames `indexes` (0-based, decode-output order), in the
   * requested pixel format. Used on host-owned artifact files (FFV1, intra-only).
   */
  frameHashesByIndex(
    file: string,
    indexes: readonly number[],
    pixelFormat: 'gray' | 'rgb24',
    signal?: AbortSignal,
  ): Promise<readonly string[]>;
  /**
   * sha256 of the decoded frame at each exact pts (source stream ticks). Seeks per frame, so
   * sampling a long clip costs a handful of short decodes, not the whole file. A pts whose
   * decoded frame does not come back with that pts yields `undefined` (treated as changed).
   */
  frameHashesByPts(
    file: string,
    timing: MatteVideoTiming,
    pts: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly (string | undefined)[]>;
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

/** ffprobe/ffmpeg output is bounded: a packet list for hours of 60 fps footage fits well inside. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 60_000;
const TIMING_TIMEOUT_MS = 600_000;
const FRAME_HASH_TIMEOUT_MS = 120_000;
/** Most frames one select-by-index call may name; the expression stays small. */
export const MAX_FRAME_HASHES_PER_CALL = 256;

export interface FfmpegMatteMediaInspectorOptions {
  readonly ffprobe: string;
  /** Absent when this build has no ffmpeg; decoded-frame checks then fail closed. */
  readonly ffmpeg?: string;
  readonly run?: CommandRunner;
}

/** Production inspector over the app's ffprobe and ffmpeg binaries. */
export class FfmpegMatteMediaInspector implements MatteMediaInspector {
  private readonly run: CommandRunner;

  public constructor(private readonly options: FfmpegMatteMediaInspectorOptions) {
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
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'csv=p=0', '-i', file],
      { timeoutMs: PROBE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    const packets = await this.run(
      this.options.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,flags', '-of', 'csv=p=0', '-i', file],
      { timeoutMs: TIMING_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    if (header.exitCode !== 0 || packets.exitCode !== 0) throw probeFailed(file);
    return parseTiming(header.stdout, packets.stdout, file);
  }

  public async frameHashesByIndex(
    file: string,
    indexes: readonly number[],
    pixelFormat: 'gray' | 'rgb24',
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const ffmpeg = this.requireFfmpeg();
    if (indexes.length === 0) return [];
    if (
      indexes.length > MAX_FRAME_HASHES_PER_CALL ||
      indexes.some((index) => !Number.isSafeInteger(index) || index < 0)
    ) {
      throw new RangeError('frame indexes must be at most 256 non-negative integers');
    }
    const sorted = [...new Set(indexes)].sort((left, right) => left - right);
    // The expression is built from integers only; the path stays its own argv element.
    const select = `select=${sorted.map((index) => `eq(n\\,${index})`).join('+')}`;
    const result = await this.run(
      ffmpeg,
      [
        '-v', 'error', '-nostdin',
        '-i', file,
        '-map', '0:v:0',
        '-vf', select,
        '-fps_mode', 'passthrough',
        '-pix_fmt', pixelFormat,
        '-f', 'framehash', '-hash', 'sha256', '-',
      ],
      { timeoutMs: FRAME_HASH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
    if (result.exitCode !== 0) throw probeFailed(file);
    const hashes = parseFramehash(result.stdout).map((row) => row.hash);
    if (hashes.length !== sorted.length) throw probeFailed(file);
    const byIndex = new Map(sorted.map((index, position) => [index, hashes[position]!]));
    return indexes.map((index) => byIndex.get(index)!);
  }

  public async frameHashesByPts(
    file: string,
    timing: MatteVideoTiming,
    pts: readonly number[],
    signal?: AbortSignal,
  ): Promise<readonly (string | undefined)[]> {
    const ffmpeg = this.requireFfmpeg();
    const [numerator, denominator] = timing.timeBase;
    const hashes: (string | undefined)[] = [];
    for (const target of pts) {
      if (!Number.isSafeInteger(target)) throw new RangeError('pts must be integers');
      // Seek to half a tick before the frame: the first frame at or after that time is it.
      const seconds = ((target - 0.5) * numerator) / denominator;
      const result = await this.run(
        ffmpeg,
        [
          '-v', 'error', '-nostdin',
          '-copyts',
          '-ss', seconds.toFixed(9),
          '-i', file,
          '-map', '0:v:0',
          '-frames:v', '1',
          '-fps_mode', 'passthrough',
          '-enc_time_base', `${numerator}/${denominator}`,
          '-f', 'framehash', '-hash', 'sha256', '-',
        ],
        { timeoutMs: FRAME_HASH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      );
      if (result.exitCode !== 0) {
        hashes.push(undefined);
        continue;
      }
      const row = parseFramehash(result.stdout)[0];
      hashes.push(row !== undefined && row.pts === target ? row.hash : undefined);
    }
    return hashes;
  }

  private requireFfmpeg(): string {
    if (this.options.ffmpeg === undefined) {
      throw new MatteInspectorError(
        'tool_unavailable',
        'This build has no ffmpeg to check decoded frames with.',
      );
    }
    return this.options.ffmpeg;
  }
}

/**
 * Resolve the app's own ffprobe/ffmpeg: the existing `FRAMEPILOT_FFPROBE`/`FRAMEPILOT_FFMPEG`
 * overrides, then the binaries staged beside the bundled engine, then PATH names.
 */
export function resolveMatteMediaTools(context: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly platform: NodeJS.Platform;
  readonly fileExists: (file: string) => boolean;
}): { readonly ffprobe: string; readonly ffmpeg?: string } {
  const suffix = context.platform === 'win32' ? '.exe' : '';
  const staged = (name: string): string | undefined => {
    if (!context.isPackaged) return undefined;
    const candidate = path.join(context.resourcesPath, 'engine', `${name}${suffix}`);
    return context.fileExists(candidate) ? candidate : undefined;
  };
  const ffprobe =
    nonEmpty(context.env.FRAMEPILOT_FFPROBE) ?? staged('ffprobe') ?? `ffprobe${suffix}`;
  const ffmpeg = nonEmpty(context.env.FRAMEPILOT_FFMPEG) ?? staged('ffmpeg') ??
    (context.isPackaged ? undefined : `ffmpeg${suffix}`);
  return { ffprobe, ...(ffmpeg === undefined ? {} : { ffmpeg }) };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
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

export function parseFramehash(stdout: string): { readonly pts: number; readonly hash: string }[] {
  const rows: { pts: number; hash: string }[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const fields = line.split(',').map((field) => field.trim());
    const hash = fields[5];
    const pts = Number(fields[2]);
    if (hash === undefined || !/^[0-9a-f]{64}$/u.test(hash) || !Number.isSafeInteger(pts)) continue;
    rows.push({ pts, hash });
  }
  return rows;
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
