/**
 * Sidecar spawn-command resolution (plan Phase 8 "Desktop packaging completeness").
 *
 * WHY this exists: dev machines run the engine from source via `uv run`, but a
 * packaged app cannot assume `uv`, Python, or this repo on the user's machine —
 * it ships a self-contained PyInstaller bundle under `Resources/engine/`
 * (electron-builder `extraResources`; built by scripts/package-engine.mjs).
 * This module decides which of the two to launch. It is pure — every input
 * (env, packaged flag, resources path, platform) is injected — so the decision
 * table is fully unit-testable without Electron.
 *
 * Resolution order:
 *  1. `FRAMEPILOT_ENGINE_DIR` set → dev-style `uv run` in that directory, even
 *     when packaged (explicit override for debugging a packaged shell against
 *     a source engine).
 *  2. Packaged app → the bundled `framepilot-engine` binary under
 *     `<resourcesPath>/engine/`.
 *  3. Otherwise (dev) → `uv run framepilot serve` in the repo's engine/python.
 */
import path from 'node:path';

/** The fully resolved command `main.ts` hands to `child_process.spawn`. */
export interface SidecarCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * Environment ADDITIONS (merged over `process.env` by the caller): the
 * bundled engine ships its own ffprobe. Heavy optional runtimes such as
 * whisper-cli arrive through signed Capability Packs and are injected by main
   * (engine/python .../media/ffmpeg.py, audio/asr.py). Empty in dev — the
   * source engine uses PATH / imageio-ffmpeg as always.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Which resolution branch fired — logged so a wrong engine is diagnosable. */
  readonly source: 'engine-dir-override' | 'bundled' | 'dev-uv';
}

/** Environment facts the resolver needs — injected, never read from globals. */
export interface SidecarSpawnContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `app.isPackaged` — true only in a built/installed app. */
  readonly isPackaged: boolean;
  /** `process.resourcesPath` — the packaged app's Resources directory. */
  readonly resourcesPath: string;
  /** `process.platform` — the bundled binary carries `.exe` on Windows. */
  readonly platform: NodeJS.Platform;
  /** Directory of the compiled main bundle (`dist/`); the dev engine dir is relative to it. */
  readonly moduleDir: string;
  /**
   * Existence probe for staged helper binaries (`fs.existsSync` in main.ts;
   * a stub in tests). Injected so the decision table stays pure: a helper env
   * var is only set when the staged file is really there — a dangling
   * `FRAMEPILOT_FFPROBE` would break the engine's PATH fallback for users who
   * have their own ffprobe.
   */
  readonly fileExists: (filePath: string) => boolean;
}

/** Bundle directory name under Resources; must match electron-builder.yml `extraResources.to`. */
const BUNDLED_ENGINE_DIR = 'engine';
/** Binary name; must match the PyInstaller spec's EXE/COLLECT `name`. */
const BUNDLED_ENGINE_BINARY = 'framepilot-engine';
/**
 * Helper binaries staged next to the engine and handed to it via env. Only
 * ffprobe is part of the base application; heavyweight intelligence stays in
 * on-demand Capability Packs.
 */
const BUNDLED_TOOL_ENV = [
  { envVar: 'FRAMEPILOT_FFPROBE', binary: 'ffprobe' },
] as const;

const serveArgs = (host: string, port: number): string[] => [
  'serve',
  '--host',
  host,
  '--port',
  String(port),
];

/** Resolve the command that starts the render sidecar for this environment. */
export function resolveSidecarCommand(
  host: string,
  port: number,
  context: SidecarSpawnContext,
): SidecarCommand {
  const overrideDir = context.env.FRAMEPILOT_ENGINE_DIR?.trim();
  if (overrideDir) {
    return {
      command: 'uv',
      args: ['run', 'framepilot', ...serveArgs(host, port)],
      cwd: overrideDir,
      env: {},
      source: 'engine-dir-override',
    };
  }

  if (context.isPackaged) {
    const bundleDir = path.join(context.resourcesPath, BUNDLED_ENGINE_DIR);
    const suffix = context.platform === 'win32' ? '.exe' : '';
    return {
      command: path.join(bundleDir, `${BUNDLED_ENGINE_BINARY}${suffix}`),
      args: serveArgs(host, port),
      // cwd inside the bundle keeps any relative writes out of the user's cwd.
      cwd: bundleDir,
      env: bundledToolEnv(bundleDir, suffix, context),
      source: 'bundled',
    };
  }

  return {
    command: 'uv',
    args: ['run', 'framepilot', ...serveArgs(host, port)],
    cwd: path.resolve(context.moduleDir, '../../../engine/python'),
    env: {},
    source: 'dev-uv',
  };
}

/**
 * Env additions pointing the bundled engine at its staged helper binaries.
 * A user-supplied value for the same var always wins (never overridden), and
 * a helper that was not staged sets nothing so the engine's own PATH fallback
 * stays intact.
 */
function bundledToolEnv(
  bundleDir: string,
  suffix: string,
  context: SidecarSpawnContext,
): Record<string, string> {
  const additions: Record<string, string> = {};
  for (const tool of BUNDLED_TOOL_ENV) {
    if (context.env[tool.envVar]?.trim()) continue;
    const staged = path.join(bundleDir, `${tool.binary}${suffix}`);
    if (context.fileExists(staged)) {
      additions[tool.envVar] = staged;
    }
  }
  return additions;
}
