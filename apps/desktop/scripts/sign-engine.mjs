/**
 * Code-sign the staged Python engine bundle's Mach-O files (macOS only).
 *
 * WHY: notarization requires every executable/dylib in the app to carry a
 * valid Developer ID signature, but electron-builder only signs the Electron
 * app itself — `extraResources` (our `engine-dist/` → `Resources/engine/`)
 * are copied in unsigned. Signing must therefore happen HERE, at staging
 * time, before electron-builder packages and signs the app; embedded
 * signatures survive the copy.
 *
 * Identity comes from `CSC_NAME` (electron-builder's standard "identity name"
 * env — the same one release CI sets after importing the Developer ID cert
 * into the keychain). Without it this is a no-op: local unsigned builds run
 * fine on the build machine via PyInstaller's own ad-hoc signatures.
 * `CSC_NAME='-'` ad-hoc signs — used to exercise this path without certs.
 *
 * Runs as part of `node scripts/package-engine.mjs`, or standalone:
 * `node scripts/sign-engine.mjs` (re-sign an existing engine-dist/).
 */
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTITLEMENTS = path.join(desktopDir, 'build', 'entitlements.mac.plist');
/** codesign accepts many paths per invocation; batching keeps this fast. */
const SIGN_BATCH_SIZE = 50;

/** Mach-O magic numbers (thin LE/BE for 32/64-bit + fat/universal headers). */
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf]);

async function isMachO(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && MACHO_MAGICS.has(buffer.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

/** All Mach-O files under `dir`, mainExecutable last (sign inner-most first). */
async function collectMachOFiles(dir, mainExecutable) {
  const machos = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    if (await isMachO(filePath)) machos.push(filePath);
  }
  const main = path.resolve(dir, mainExecutable);
  return [...machos.filter((f) => path.resolve(f) !== main), main];
}

/**
 * Sign every Mach-O in the staged engine bundle with hardened runtime.
 * No-op unless on macOS with `CSC_NAME` set.
 */
export async function signEngineBundle(stagedDir) {
  if (process.platform !== 'darwin') return;
  const identity = process.env.CSC_NAME?.trim();
  if (!identity) {
    console.log(
      'sign-engine: CSC_NAME not set — engine bundle left unsigned (fine for local runs; required for notarized releases).',
    );
    return;
  }

  const files = await collectMachOFiles(stagedDir, 'framepilot-engine');
  // --timestamp needs a real signing authority; ad-hoc ('-') has none.
  const timestampArgs = identity === '-' ? [] : ['--timestamp'];
  for (let i = 0; i < files.length; i += SIGN_BATCH_SIZE) {
    const batch = files.slice(i, i + SIGN_BATCH_SIZE);
    await execFileAsync('codesign', [
      '--force',
      '--options',
      'runtime',
      '--entitlements',
      ENTITLEMENTS,
      ...timestampArgs,
      '--sign',
      identity,
      ...batch,
    ]);
  }
  console.log(`sign-engine: signed ${files.length} Mach-O files with identity "${identity}"`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  signEngineBundle(path.join(desktopDir, 'engine-dist')).catch((error) => {
    console.error(`sign-engine: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
