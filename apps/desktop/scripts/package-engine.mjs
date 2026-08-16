/**
 * Build the self-contained Python engine bundle and stage it for electron-builder.
 *
 * WHY: the packaged desktop app cannot assume `uv`, Python, or the repo's
 * `engine/python` on a user machine. This script freezes the engine with
 * PyInstaller (spec: engine/python/framepilot-engine.spec) and stages the
 * resulting onedir bundle at `apps/desktop/engine-dist/`, which
 * `electron-builder.yml` ships as `Resources/engine/`. The sidecar spawner
 * (electron/sidecar/spawn.ts) launches that binary in packaged builds.
 *
 * Requires `uv` on the build machine (dev/CI only — never the end user).
 *
 * Usage: node scripts/package-engine.mjs   (cwd: apps/desktop)
 */
import { spawn } from 'node:child_process';
import { chmod, cp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { signEngineBundle } from './sign-engine.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.resolve(desktopDir, '../../engine/python');
// Build output lives HERE, not under engine/python: `mypy .` / `ruff` walk the
// engine tree and must never see PyInstaller's generated dist/build contents.
const buildDir = path.join(desktopDir, 'engine-build');
const stagedDir = path.join(desktopDir, 'engine-dist');
const bundleName = 'framepilot-engine';

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  // `uv run --extra package` resolves PyInstaller from the engine's `package`
  // extra on the fly — no separate sync step to forget.
  await run(
    'uv',
    [
      'run',
      '--extra',
      'package',
      'pyinstaller',
      '--noconfirm',
      '--distpath',
      path.join(buildDir, 'dist'),
      '--workpath',
      path.join(buildDir, 'work'),
      'framepilot-engine.spec',
    ],
    engineDir,
  );

  const built = path.join(buildDir, 'dist', bundleName);
  const builtBinary = path.join(
    built,
    process.platform === 'win32' ? `${bundleName}.exe` : bundleName,
  );
  try {
    await stat(builtBinary);
  } catch {
    console.error(`package-engine: PyInstaller finished but ${builtBinary} is missing.`);
    process.exit(1);
  }

  await rm(stagedDir, { recursive: true, force: true });
  // verbatimSymlinks: PyInstaller's bundle contains RELATIVE symlinks
  // (_internal/libfoo.dylib -> cv2/.dylibs/libfoo.dylib); the default cp
  // resolves them to ABSOLUTE build-machine paths — codesign rejects the app
  // ("invalid destination for symbolic link in bundle") and every link would
  // dangle on a user's machine.
  await cp(built, stagedDir, { recursive: true, verbatimSymlinks: true });
  console.log(`package-engine: staged ${built} -> ${stagedDir}`);

  await stageFfprobe();

  // Notarized releases: sign the bundle's Mach-O files NOW, before
  // electron-builder copies them into Resources/ (it never signs
  // extraResources itself). No-op without CSC_NAME.
  await signEngineBundle(stagedDir);
}

/**
 * Vendor a static ffprobe next to the engine binary. imageio-ffmpeg (inside
 * the PyInstaller bundle) ships only ffmpeg; media inspect and render
 * validation shell out to ffprobe, which a clean user machine does not have.
 * The sidecar spawner points `FRAMEPILOT_FFPROBE` here (sidecar/spawn.ts).
 */
async function stageFfprobe() {
  const require = createRequire(import.meta.url);
  const { path: ffprobeSource } = require('@ffprobe-installer/ffprobe');
  const target = path.join(stagedDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  await cp(ffprobeSource, target);
  // npm strips the execute bit on some platforms; the sidecar must spawn this.
  await chmod(target, 0o755);
  console.log(`package-engine: staged ffprobe ${ffprobeSource} -> ${target}`);
}

main().catch((error) => {
  console.error(`package-engine: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
