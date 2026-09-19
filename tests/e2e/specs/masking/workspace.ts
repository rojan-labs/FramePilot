/**
 * One masking end-to-end test's project folder on disk, and the engine calls that act on it.
 *
 * Every spec gets its own folder under `tests/e2e/.tmp-masking-e2e/<name>/` holding a real
 * `project.fp.json`, the media it references (relative paths, as a saved desktop project stores
 * them) and whatever `.framepilot-derived/` artifacts the flow writes. The export, the frame grab
 * and the desktop host modules all read this folder exactly as they would read a user's project.
 *
 * The engine half runs through `engine/python/tests/masking_e2e_engine.py` in a child process
 * (async, so the page's bridge calls keep being served while a render runs). Nothing here talks
 * to a network, and every input is generated, so a run is deterministic.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  readProjectFile,
  writeProjectFile,
} from '../../../../packages/timeline-schema/dist/project-file.js';
import type { Project } from '../../../../packages/timeline-schema/dist/index.js';

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..', '..');
export const ENGINE_DIR = join(REPO, 'engine', 'python');
/** Gitignored: every generated file of every masking spec lives under here. */
export const WORK_ROOT = join(REPO, 'tests', 'e2e', '.tmp-masking-e2e');
/** Where the page reads workspace files from (served from the app's own origin). */
export const MEDIA_ROUTE = '/__masking-e2e/';

/** One engine render or grab on a 640x360 project takes seconds; this bounds a stuck one. */
const ENGINE_TIMEOUT_MS = 5 * 60_000;

export type Rgb3 = readonly [number, number, number];

/** A synthetic sentinel video: a flat colour with a second colour in its top-right quadrant. */
export interface VideoRequest {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seconds: number;
  readonly primary: Rgb3;
  readonly secondary: Rgb3;
}

/** What the `matte` command wrote: the fields a matte mask pins, plus the frame timing. */
export interface WrittenMatte {
  readonly key: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
  readonly width: number;
  readonly height: number;
  readonly coverage: { readonly sourceStart: number; readonly sourceEnd: number };
  readonly timeBase: readonly [number, number];
  readonly pts: readonly number[];
  readonly firstFrame: number;
}

export interface EngineExport {
  readonly state: string;
  readonly error: string | null;
  readonly errorDetail: string | null;
  readonly outputPath: string | null;
  readonly validation?: {
    readonly ok: boolean;
    readonly checks: readonly {
      readonly name: string;
      readonly status: string;
      readonly detail: string | null;
    }[];
  };
  readonly probe?: {
    readonly durationSeconds: number | null;
    readonly formatName: string | null;
    readonly streams: readonly {
      readonly codecType: string;
      readonly codecName: string | null;
      readonly width: number | null;
      readonly height: number | null;
    }[];
  };
  readonly sha256?: string;
}

export interface EngineFrame {
  readonly time: number;
  readonly renderedTime: number;
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Run one engine command and return its JSON answer.
 *
 * @param command - A `masking_e2e_engine` command (`media`, `matte`, `frames`, `export`, ...).
 * @param request - Its request document; written to a file beside the workspace.
 * @param requestDir - Where to write that file.
 * @returns The parsed last line of the command's stdout.
 */
export async function runEngine<T>(
  command: string,
  request: unknown,
  requestDir: string,
): Promise<T> {
  await mkdir(requestDir, { recursive: true });
  const file = join(
    requestDir,
    `${command}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  await writeFile(file, JSON.stringify(request));
  try {
    const { stdout } = await run(
      'uv',
      ['run', '--quiet', 'python', '-m', 'tests.masking_e2e_engine', command, file],
      {
        cwd: ENGINE_DIR,
        maxBuffer: 64 * 1024 * 1024,
        timeout: ENGINE_TIMEOUT_MS,
        // Software encode (`render/encoders.py`): a hardware encoder is not bit-reproducible,
        // and E2E.5/E2E.7 compare export bytes. CI runners have no hardware encoder anyway.
        env: { ...process.env, FRAMEPILOT_HW_ENCODE: '0' },
      },
    );
    const last = stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(last) as T;
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new Error(
      `engine ${command} failed: ${(detail.stderr ?? detail.message ?? String(error)).slice(-2000)}`,
    );
  }
}

export class Workspace {
  private constructor(
    /** This spec's folder. */
    public readonly root: string,
    /** The project folder (media and `.framepilot-derived/` live here). */
    public readonly projectDir: string,
  ) {}

  /** A fresh, empty workspace named for the test (any previous run's files are removed). */
  public static async create(name: string): Promise<Workspace> {
    const root = join(WORK_ROOT, name.replace(/[^A-Za-z0-9_-]+/g, '-'));
    await rm(root, { recursive: true, force: true });
    const projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });
    return new Workspace(root, projectDir);
  }

  public get projectPath(): string {
    return join(this.projectDir, 'project.fp.json');
  }

  /** The URL path (under {@link MEDIA_ROUTE}) the page reads a workspace file from. */
  public urlPath(absolute: string): string {
    return `${MEDIA_ROUTE}${relative(WORK_ROOT, absolute).split(sep).join('/')}`;
  }

  private get requests(): string {
    return join(this.root, 'requests');
  }

  /** Encode sentinel videos into the project folder (paths relative to it). */
  public async media(videos: readonly VideoRequest[]): Promise<void> {
    await runEngine('media', { outDir: this.projectDir, videos }, this.requests);
  }

  /** Write a synthetic matte artifact into `.framepilot-derived/mattes/<key>/`. */
  public async matte(request: {
    readonly assetPath: string;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
    readonly foreground: Rgb3;
    readonly shape?: 'ramp' | 'disc';
    readonly variant?: string;
    readonly firstFrame?: number;
    readonly lastFrame?: number;
    readonly sourceStart?: number;
    readonly sourceEnd?: number;
  }): Promise<WrittenMatte> {
    return runEngine<WrittenMatte>(
      'matte',
      { projectDir: this.projectDir, ...request },
      this.requests,
    );
  }

  /** Validate and write the project with the app's own writer (schema envelope stamped). */
  public async writeProject(project: Project): Promise<void> {
    await writeProjectFile(this.projectPath, project);
  }

  /** Write raw project text (an older-schema file the app must migrate). */
  public async writeProjectText(text: string): Promise<void> {
    await writeFile(this.projectPath, text);
  }

  /** Read the project as the desktop reads it (migrating, never writing a backup). */
  public async readProject(): Promise<Project> {
    return readProjectFile(this.projectPath);
  }

  public async readProjectText(): Promise<string> {
    return readFile(this.projectPath, 'utf8');
  }

  /** The export's lossless frames at the monitor's canvas size (the PX4 oracle's reference). */
  public async frames(times: readonly number[], prefix: string): Promise<EngineFrame[]> {
    const result = await runEngine<{ frames: EngineFrame[] }>(
      'frames',
      { projectPath: this.projectPath, outDir: join(this.root, 'frames'), times, prefix },
      this.requests,
    );
    return result.frames;
  }

  /** sha256 of each lossless export frame's RGB pixels. */
  public async frameHashes(
    times: readonly number[],
    projectPath: string = this.projectPath,
  ): Promise<{ time: number; width: number; height: number; sha256: string }[]> {
    const result = await runEngine<{
      frames: { time: number; width: number; height: number; sha256: string }[];
    }>('frame-hashes', { projectPath, times }, this.requests);
    return result.frames;
  }

  /**
   * E2E.5's reference: export `projectPath` (the MIGRATED file) with each clip that had a v21
   * `mask` effect in `v21Path` drawn by the v21 renderer's own mask functions.
   */
  public async legacyExport(name: string, v21Path: string): Promise<EngineExport> {
    return runEngine<EngineExport>(
      'legacy-export',
      { projectPath: this.projectPath, v21Path, output: join(this.projectDir, 'exports', name) },
      this.requests,
    );
  }

  /** Render the saved project as the desktop export does, into `exports/<name>`. */
  public async export(
    name: string,
    settings: Record<string, unknown> = {},
    projectPath: string = this.projectPath,
  ): Promise<EngineExport> {
    return runEngine<EngineExport>(
      'export',
      { projectPath, output: join(dirname(projectPath), 'exports', name), settings },
      this.requests,
    );
  }
}
