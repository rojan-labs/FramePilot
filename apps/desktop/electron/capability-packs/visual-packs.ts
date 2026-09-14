/**
 * Main-process resolution of the local perception packs (ADR 0176).
 *
 * The engine never discovers a pack: `/brain/visual/index` and `/brain/visual/search`
 * take a fully resolved JSON handle and refuse to run anything else. Until this module
 * existed the desktop host never built one, so on the surface this product leads with an
 * installed, healthy `framepilot.visual-embed` or `framepilot.visual-describe` pack was
 * never run — the only route to either was an env var nobody sets in a packaged app.
 *
 * The rules are the tracking service's: only the newest `installed` + `healthy` release
 * answers, the entrypoint is resolved INSIDE its install root, and a missing executable
 * means no handle rather than a handle that fails per request.
 */
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  CapabilityPackInstallIdentity,
  InstalledCapabilityPack,
} from '@framepilot/capability-packs';
import { compareSemver, resolveInside } from './pack-paths.js';

export const VISUAL_EMBED_PACK_ID = 'framepilot.visual-embed';
export const VISUAL_DESCRIBE_PACK_ID = 'framepilot.visual-describe';

/** The per-request fields the engine's visual routes read a pack handle from. */
export interface VisualPackHandles {
  readonly visualEmbedPack?: string;
  readonly visualDescribePack?: string;
}

interface VisualPackBinding {
  readonly field: keyof VisualPackHandles;
  readonly packId: string;
  readonly executable: string;
  /** Must match what the engine's `parse_pack_handle(require=…)` asks for. */
  readonly capabilities: readonly string[];
}

const VISUAL_PACK_BINDINGS: readonly VisualPackBinding[] = [
  {
    field: 'visualEmbedPack',
    packId: VISUAL_EMBED_PACK_ID,
    executable: 'framepilot-visual-embed',
    capabilities: ['visual.embed', 'visual.text'],
  },
  {
    field: 'visualDescribePack',
    packId: VISUAL_DESCRIBE_PACK_ID,
    executable: 'framepilot-visual-describe',
    capabilities: ['visual.describe'],
  },
];

export interface ResolveVisualPackHandlesOptions {
  readonly records: readonly InstalledCapabilityPack[];
  /** The Capability Pack storage root every `installRelativePath` is relative to. */
  readonly storageRoot: string;
  /** Writable per-pack cache parent (the embed pack caches its prompt-bank vectors). */
  readonly cacheRoot: string;
  readonly os: 'darwin' | 'win32';
  readonly isFile?: (absolutePath: string) => Promise<boolean>;
  readonly ensureDirectory?: (absolutePath: string) => Promise<void>;
}

/**
 * Build the handles for every local perception pack this machine can actually run.
 *
 * @returns Only the fields whose pack is installed, healthy and complete — an absent field
 *   is the engine's shipped default ("no local pack"), never an error.
 */
export async function resolveVisualPackHandles(
  options: ResolveVisualPackHandlesOptions,
): Promise<VisualPackHandles> {
  const isFile = options.isFile ?? defaultIsFile;
  const ensureDirectory = options.ensureDirectory ?? defaultEnsureDirectory;
  const handles: { -readonly [K in keyof VisualPackHandles]: string } = {};
  for (const binding of VISUAL_PACK_BINDINGS) {
    const record = newestHealthy(options.records, binding.packId);
    if (record === undefined) continue;
    const installRoot = resolveInside(options.storageRoot, record.installRelativePath);
    const entrypoint = resolveInside(installRoot, entrypointFor(binding.executable, options.os));
    if (!(await isFile(entrypoint))) continue;
    const cache = path.join(options.cacheRoot, binding.packId, record.identity.version);
    await ensureDirectory(cache);
    handles[binding.field] = JSON.stringify({
      packId: record.identity.id,
      version: record.identity.version,
      releaseDigest: record.identity.releaseDigest,
      entrypoint,
      capabilities: binding.capabilities,
      root: installRoot,
      cache,
    });
  }
  return handles;
}

/** The install identity behind each field of {@link VisualPackHandles}, when resolved. */
export interface VisualPackIdentities {
  readonly visualEmbedPack?: CapabilityPackInstallIdentity;
  readonly visualDescribePack?: CapabilityPackInstallIdentity;
}

/**
 * Which installed pack each {@link VisualPackHandles} field currently names (R4.3).
 *
 * Uses the EXACT SAME selection as {@link resolveVisualPackHandles} (the newest
 * `installed`+`healthy` release) so the two can never disagree about which pack a handle
 * refers to. Kept separate rather than folded into the handle itself: the handle is what
 * crosses the wire to the engine, and an `InstalledCapabilityPack.identity` — with its
 * `artifactDigest`/platform fields the engine's handle schema does not carry — is what
 * `store.acquireLease` needs to hold that pack open for the run using it
 * (`visual-pack-lease.ts`).
 */
export function resolveVisualPackIdentities(
  records: readonly InstalledCapabilityPack[],
): VisualPackIdentities {
  const identities: { -readonly [K in keyof VisualPackIdentities]: CapabilityPackInstallIdentity } =
    {};
  for (const binding of VISUAL_PACK_BINDINGS) {
    const record = newestHealthy(records, binding.packId);
    if (record !== undefined) identities[binding.field] = record.identity;
  }
  return identities;
}

export type VisualIndexTier = 'measured' | 'labelled' | 'described';

/**
 * The tiers an UNATTENDED import may fill.
 *
 * `measured` is local, keyless and free, and runs for everyone (ADR 0175). A HOSTED tier
 * runs only on consent the user already gave by configuring its key, because it spends
 * their money per asset — which is why `described` never runs hosted from an import.
 * An installed LOCAL pack is the same consent in a different form: the user chose to
 * download it to understand their footage, it costs nothing, and no frame leaves the
 * machine. Leaving its tier out would make the pack inert until the agent happened to
 * call `index_media`. The engine's governor still yields that work to render, export and
 * frame requests.
 */
export function autoEnrolmentTiers(input: {
  readonly hostedLabelsConfigured: boolean;
  readonly handles: VisualPackHandles;
}): readonly VisualIndexTier[] {
  const tiers: VisualIndexTier[] = ['measured'];
  if (input.hostedLabelsConfigured || input.handles.visualEmbedPack !== undefined) {
    tiers.push('labelled');
  }
  if (input.handles.visualDescribePack !== undefined) tiers.push('described');
  return tiers;
}

function newestHealthy(
  records: readonly InstalledCapabilityPack[],
  packId: string,
): InstalledCapabilityPack | undefined {
  return records
    .filter(
      (record) =>
        record.identity.id === packId &&
        record.state === 'installed' &&
        record.health.status === 'healthy',
    )
    .sort((left, right) => compareSemver(right.identity.version, left.identity.version))[0];
}

function entrypointFor(executable: string, os: 'darwin' | 'win32'): string {
  return os === 'win32' ? `bin/${executable}.exe` : `bin/${executable}`;
}

async function defaultIsFile(absolutePath: string): Promise<boolean> {
  try {
    return (await lstat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

async function defaultEnsureDirectory(absolutePath: string): Promise<void> {
  await mkdir(absolutePath, { recursive: true });
}
