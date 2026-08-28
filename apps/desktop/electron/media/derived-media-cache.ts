/**
 * Collapses a repeat derivation of an UNCHANGED file into a cache hit.
 *
 * ## The defect
 *
 * A turn's sourcing downloads are acquired concurrently and then committed serially
 * (ADR 0150): the orchestrator warms `add_stock` against a bounded pool, then runs the
 * same call again in order so placement is computed against the advancing project. That
 * design is sound, and it rests on one promise — that the second call "hits the dedupe
 * path at zero bytes and returns immediately".
 *
 * It did not. `materialize` runs on BOTH passes, and it derives. Zero bytes were
 * downloaded and a full derivation was paid for anyway: an ffprobe, a complete waveform
 * decode of the source, five thumbnail extractions and a proxy check, per asset, twice.
 * In the captured 42-download run the dedupe calls still cost 1.5–3.2s each.
 *
 * ## Why a cache is safe here
 *
 * Derivation is a pure function of the file's bytes, and its outputs are content-addressed
 * on disk. So a hit is only served when BOTH still hold:
 *
 *  - the source is byte-for-byte the file that was derived (size + mtime), and
 *  - every artefact the cached result names is still on disk.
 *
 * The second check is what makes this a memo rather than a bet. Clearing
 * `.framepilot-derived` out from under a running app re-derives on the next ask instead
 * of handing back a path that resolves to nothing — the `fp-media://` ENOENT class of
 * bug. Both checks are `stat` calls: microseconds against seconds of ffmpeg.
 *
 * A failed derivation is NEVER cached. Failure here usually means the sidecar was not
 * running, and remembering that would turn a restartable condition into a permanent one.
 *
 * Concurrent callers for the same path share one derivation, so the bounded warm pool
 * cannot start the same work several times over.
 */
import { stat } from 'node:fs/promises';
import { createLogger } from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';
import type { DerivedAssetMedia } from './asset-media-client.js';

const log = createLogger('desktop:derived-media-cache');

/** One derivation function: absolute source path in, derived media (or failure) out. */
export type DeriveAssetMedia = (absolutePath: string) => Promise<DerivedAssetMedia | null>;

/** The identity of a file's bytes, as cheaply as the filesystem will tell us. */
interface SourceStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Bound on remembered derivations. A long editing session touches many files; this keeps
 * the map from tracking every one of them forever. Eviction is oldest-first, and evicting
 * a live entry costs one re-derivation, never a wrong answer.
 */
const DEFAULT_MAX_ENTRIES = 256;

export interface DerivedMediaCacheOptions {
  /** Absolute projects root. Derived paths in a result are relative to it. */
  readonly projectsRoot: string;
  readonly maxEntries?: number;
}

/** The file's identity, or `null` when it is not there. Never throws. */
async function statOrNull(absolutePath: string): Promise<SourceStamp | null> {
  try {
    const info = await stat(absolutePath);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** Every project-relative artefact path a derivation result points at. */
function artefactPaths(derived: DerivedAssetMedia): string[] {
  const paths: string[] = [];
  if (derived.media.proxyPath) paths.push(derived.media.proxyPath);
  for (const thumb of derived.media.thumbnailPaths ?? []) paths.push(thumb);
  return paths;
}

/**
 * Wrap `derive` so a repeat call for an unchanged file is free.
 *
 * Each call site gets its OWN wrapper on purpose: the request that produced a result is
 * part of that result. Music derives with no thumbnails and no proxy, stock derives with
 * both, and one shared cache across the two would let a music-shaped answer be served for
 * a video and silently drop its proxy — reintroducing, from a cache, exactly the bug that
 * made the editor preview 4K originals in the first place.
 *
 * @param derive - The underlying derivation (normally a `importAssetViaSidecar` closure).
 * @param options - Projects root, plus test seams.
 * @returns A drop-in replacement for `derive`.
 */
export function cacheDerivedMedia(
  derive: DeriveAssetMedia,
  options: DerivedMediaCacheOptions,
): DeriveAssetMedia {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const entries = new Map<string, { stamp: SourceStamp; derived: DerivedAssetMedia }>();
  const inFlight = new Map<string, Promise<DerivedAssetMedia | null>>();

  /** True when every artefact the cached result names is still on disk. */
  const artefactsIntact = async (derived: DerivedAssetMedia): Promise<boolean> => {
    for (const relativePath of artefactPaths(derived)) {
      let absolute: string;
      try {
        absolute = resolveWithin(options.projectsRoot, relativePath);
      } catch {
        // A path that no longer resolves inside the root is not one to hand back.
        return false;
      }
      if ((await statOrNull(absolute)) === null) return false;
    }
    return true;
  };

  const remember = (key: string, stamp: SourceStamp, derived: DerivedAssetMedia): void => {
    entries.delete(key);
    entries.set(key, { stamp, derived });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return async (absolutePath: string): Promise<DerivedAssetMedia | null> => {
    const stamp = await statOrNull(absolutePath);
    if (stamp === null) {
      // The source is gone. Let the real derivation report that, rather than inventing
      // an answer here — the caller's error handling is the one that has been reviewed.
      return derive(absolutePath);
    }

    const cached = entries.get(absolutePath);
    if (
      cached &&
      cached.stamp.size === stamp.size &&
      cached.stamp.mtimeMs === stamp.mtimeMs &&
      (await artefactsIntact(cached.derived))
    ) {
      // Refresh recency so a file being worked on is not the one evicted.
      remember(absolutePath, cached.stamp, cached.derived);
      log.debug('derived media reused', { path: absolutePath });
      return cached.derived;
    }
    entries.delete(absolutePath);

    const running = inFlight.get(absolutePath);
    if (running) return running;

    const flight = (async () => {
      const derived = await derive(absolutePath);
      // Only a SUCCESS is remembered, and only against the stamp we validated above.
      if (derived !== null) remember(absolutePath, stamp, derived);
      return derived;
    })();
    inFlight.set(absolutePath, flight);
    try {
      return await flight;
    } finally {
      inFlight.delete(absolutePath);
    }
  };
}
