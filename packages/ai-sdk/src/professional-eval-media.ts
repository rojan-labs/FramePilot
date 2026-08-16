/**
 * Shared, content-coded synthetic media for the professional eval suite.
 *
 * The eval fixtures previously referenced paths like `hero.mp4` that never
 * existed, which meant a "rendered" row could only ever fail to acquire. Real
 * files are required, and they must be *content coded*: what is in the picture
 * and in the audio has to be known exactly, or a rendered proof cannot tell a
 * correct edit from a plausible wrong one.
 *
 * The generated media therefore carries measurable structure:
 *
 * - a bright block that moves left to right at a known rate, so motion,
 *   tracking, reframe and follow proofs can measure where it actually ended up;
 * - flat, separated colour bands, so colour proofs can read a channel without
 *   the measurement being contaminated by neighbouring hues;
 * - a tone whose level steps at known times, so audio proofs can measure fades,
 *   normalization and ducking against something with a real shape.
 *
 * Generation is deterministic and cached: the same inputs produce the same
 * files, and a suite run does not pay to rebuild them.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Bumped whenever the generated content changes, so caches cannot go stale. */
export const PROFESSIONAL_EVAL_MEDIA_VERSION = 1;

export const PROFESSIONAL_EVAL_MEDIA = {
  fps: 30,
  width: 640,
  height: 360,
  videoSeconds: 20,
  audioSeconds: 20,
  /** Pixels per second the bright block travels, left to right. */
  blockPixelsPerSecond: 24,
  blockSize: 64,
} as const;

export interface ProfessionalEvalMedia {
  /** Directory holding every generated file; also the project sandbox root. */
  readonly baseDir: string;
  /** Moving-block video with colour bands. */
  readonly heroPath: string;
  /** Second angle, visually distinct, for multi-clip and match-reference cases. */
  readonly altPath: string;
  /** Level-stepped tone. */
  readonly musicPath: string;
}

export class ProfessionalEvalMediaUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProfessionalEvalMediaUnavailableError';
  }
}

function cacheDirectory(): string {
  // Keyed by content version so regenerating is automatic, never manual.
  return path.join(tmpdir(), `framepilot-eval-media-v${PROFESSIONAL_EVAL_MEDIA_VERSION}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function run(executable: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        reject(new Error(`${path.basename(executable)} exited ${String(code)}: ${stderr.trim()}`));
      }
    });
  });
}

async function resolveFfmpeg(): Promise<string> {
  const explicit = process.env['FRAMEPILOT_FFMPEG'];
  if (explicit !== undefined && explicit !== '' && (await exists(explicit))) return explicit;
  try {
    await run('ffmpeg', ['-hide_banner', '-version']);
    return 'ffmpeg';
  } catch {
    throw new ProfessionalEvalMediaUnavailableError(
      'ffmpeg is required to generate professional eval media. Set FRAMEPILOT_FFMPEG or install ffmpeg.',
    );
  }
}

/**
 * The video filter graph: a moving white block over separated colour bands.
 *
 * The block is composited with `overlay`, not drawn with `drawbox`. That is not
 * a style choice: on ffmpeg 8.1 a `drawbox` position expression silently draws
 * nothing at all, which would have produced motionless media for the motion
 * proofs to measure — a fixture that fails open. `overlay` evaluates `t` per
 * frame and was verified to place the block at exactly `speed * t`.
 *
 * The motion is a formula in `t`, so the expected position at any timestamp is
 * arithmetic a test can compute rather than a number measured once and pasted in.
 */
function videoFilterComplex(hue: 'hero' | 'alt'): string {
  const { width, height, blockPixelsPerSecond: speed, blockSize } = PROFESSIONAL_EVAL_MEDIA;
  const bands =
    hue === 'hero' ? ['0x203080', '0x30A050', '0xB04030'] : ['0x802030', '0x2050A0', '0xC0A030'];
  const bandHeight = Math.floor(height / bands.length);
  const draws = bands
    .map(
      (colour, index) =>
        `drawbox=x=0:y=${index * bandHeight}:w=${width}:h=${bandHeight}:color=${colour}:t=fill`,
    )
    .join(',');
  const blockTop = Math.floor(height / 2 - blockSize / 2);
  return `[0:v]${draws}[bands];[bands][1:v]overlay=x=${speed}*t:y=${blockTop}`;
}

/** Level-stepped tone: quiet, loud, quiet again, at known second boundaries. */
function audioFilter(): string {
  return "volume='if(lt(t,5),0.15,if(lt(t,12),0.9,0.3))':eval=frame";
}

async function generate(ffmpeg: string, media: ProfessionalEvalMedia): Promise<void> {
  const { fps, width, height, videoSeconds, audioSeconds, blockSize } = PROFESSIONAL_EVAL_MEDIA;
  for (const [target, hue] of [
    [media.heroPath, 'hero'],
    [media.altPath, 'alt'],
  ] as const) {
    if (await exists(target)) continue;
    await run(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${width}x${height}:r=${fps}:d=${videoSeconds}`,
      '-f',
      'lavfi',
      '-i',
      `color=c=white:s=${blockSize}x${blockSize}:r=${fps}:d=${videoSeconds}`,
      '-filter_complex',
      videoFilterComplex(hue),
      '-pix_fmt',
      'yuv420p',
      // Deterministic encode: no threading nondeterminism, fixed GOP.
      '-threads',
      '1',
      '-g',
      String(fps),
      target,
    ]);
  }
  if (!(await exists(media.musicPath))) {
    await run(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`,
      '-af',
      audioFilter(),
      '-threads',
      '1',
      media.musicPath,
    ]);
  }
}

/**
 * Ensure the shared eval media exists on disk and return its paths.
 *
 * Throws {@link ProfessionalEvalMediaUnavailableError} when ffmpeg is missing, so
 * a caller reports "could not acquire" rather than quietly scoring a row that
 * never rendered anything.
 */
export async function ensureProfessionalEvalMedia(
  baseDirectory = cacheDirectory(),
): Promise<ProfessionalEvalMedia> {
  const baseDir = path.resolve(baseDirectory);
  await mkdir(baseDir, { recursive: true });
  const media: ProfessionalEvalMedia = {
    baseDir,
    heroPath: path.join(baseDir, 'hero.mp4'),
    altPath: path.join(baseDir, 'alt.mp4'),
    musicPath: path.join(baseDir, 'music.wav'),
  };
  const ffmpeg = await resolveFfmpeg();
  await generate(ffmpeg, media);
  return media;
}

/** Where the bright block's left edge is, in pixels, at a given media second. */
export function expectedBlockLeft(seconds: number): number {
  return PROFESSIONAL_EVAL_MEDIA.blockPixelsPerSecond * seconds;
}

/** Stable identity of the generated content, for evidence lineage. */
export function professionalEvalMediaDigest(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: PROFESSIONAL_EVAL_MEDIA_VERSION,
        media: PROFESSIONAL_EVAL_MEDIA,
        hero: videoFilterComplex('hero'),
        alt: videoFilterComplex('alt'),
        audio: audioFilter(),
      }),
    )
    .digest('hex');
}
