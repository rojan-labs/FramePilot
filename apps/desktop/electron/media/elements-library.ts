/**
 * The Elements library in the main process (plan/elements EL6a.3, 06 §1): puts a sticker's file
 * into a project so it can be placed like any image.
 *
 * The renderer and the agent name a **catalogue id**, never a path; this service resolves it
 * against the bundled catalogue, verifies the shipped bytes against the catalogue's SHA-256, and
 * copies them into the project's media folder (`media/<project>/elements/<library>/<id>.webp`),
 * where imported media already lands — so `fp-media://` and the engine resolve it with nothing
 * broadened. It edits nothing: the caller builds the patch with `buildAddStickerOps`.
 *
 * A sticker is not footage: no derive (its shape is in the catalogue) and no footage enrolment.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import type {
  ElementAssetWire,
  ElementMaterializeRequest,
  ElementMaterializeResult,
  ElementThumbnailResult,
  ElementThumbnailWire,
} from '@framepilot/shared-types';
import { resolveWithin } from '@framepilot/shared-types/safety';
import {
  STICKER_ID_PATTERN,
  stickerSourceUrl,
  type StickerCatalog,
  type StickerItem,
} from '@framepilot/ai-sdk';
import { ELEMENT_PROVIDERS } from '@framepilot/editor-core';
import { mediaRelativeDir } from '../projects/media-import.js';
import { sourcedAssetId } from './sourced-asset-id.js';

const log = createLogger('desktop:elements');

/** The file operations the library performs, injectable so failure paths are testable. */
export interface ElementsLibraryIO {
  readonly readFile: (file: string) => Promise<Buffer>;
  readonly writeFile: (file: string, data: Buffer) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly unlink: (file: string) => Promise<void>;
  readonly mkdir: (dir: string) => Promise<void>;
  readonly exists: (file: string) => Promise<boolean>;
  /** The file's size in bytes, or `null` when there is no such file. */
  readonly size: (file: string) => Promise<number | null>;
  /** The names in a folder; empty when there is no such folder. */
  readonly list: (dir: string) => Promise<readonly string[]>;
  /**
   * A regular file's bytes, refusing (throwing) anything else — a folder, a device, a pipe — and
   * a file larger than `maxBytes`, without reading it. For files outside the app's own archive.
   */
  readonly readBounded: (file: string, maxBytes: number) => Promise<Buffer>;
}

export const nodeElementsLibraryIO: ElementsLibraryIO = {
  readFile: (file) => readFile(file),
  writeFile: (file, data) => writeFile(file, data),
  rename: (from, to) => rename(from, to),
  unlink: (file) => unlink(file),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  exists: async (file) => {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  },
  size: async (file) => {
    try {
      return (await stat(file)).size;
    } catch {
      return null;
    }
  },
  list: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
  readBounded: async (file, maxBytes) => {
    // Non-blocking, so a pipe planted in the set cannot hang main on open; POSIX only (Windows
    // has no such flag, and no such files).
    const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('not a regular file');
      if (info.size > maxBytes) throw new Error('larger than a sticker file may be');
      // Exactly the size just checked, from the handle checked: a file that grows between the
      // two is read no further.
      const data = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(data, 0, info.size, 0);
      return data.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

export interface ElementsLibraryOptions {
  /** Every write resolves inside it. */
  readonly projectsRoot: string;
  /** The folder holding the bundled sticker files (`full/`, `thumbs/`). */
  readonly bundledRoot: () => string;
  /**
   * The desktop installer's packaged set (EL6b: every sticker the renderer does not ship, with
   * its `manifest.json`), or `null` in a build without it; packaged stickers are then missing.
   */
  readonly packagedRoot?: () => string | null;
  /** The sticker catalogue (the generated one, loaded on first use). */
  readonly catalog: () => Promise<StickerCatalog>;
  readonly io?: ElementsLibraryIO;
  readonly now?: () => Date;
  /** Told how each request ended, for the opt-in local telemetry. Never the project or a path. */
  readonly onOutcome?: (outcome: {
    readonly ok: boolean;
    readonly error?: string;
    readonly deduped?: boolean;
  }) => void;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Tiles one thumbnail request may ask for: a screen of the grid, with room to scroll. */
export const MAX_THUMBNAILS_PER_REQUEST = 96;

/**
 * What a packaged file may weigh. The set lives outside the app's archive, where another process
 * can write, so main never reads more than this of it: the largest sticker is 57 KB and the
 * largest tile 10 KB, so a file past these is not one packaging wrote.
 */
export const MAX_PACKAGED_STICKER_BYTES = 512 * 1024;
export const MAX_PACKAGED_TILE_BYTES = 64 * 1024;
/** A sticker's recorded pixel sizes stay within what a picture may be. */
const MAX_STICKER_EDGE_PX = 8192;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The ids of a `framepilot:elements:thumbnail` request, or `null` when it is not one: an object
 * with a list of strings, no longer than one request may ask for (the renderer batches to that).
 * The length is checked before the entries, so an oversized list is not walked.
 */
export function thumbnailRequestIds(request: unknown): readonly string[] | null {
  const ids = (request as { elementIds?: unknown } | null)?.elementIds;
  if (!Array.isArray(ids) || ids.length > MAX_THUMBNAILS_PER_REQUEST) return null;
  return ids.every((id): id is string => typeof id === 'string') ? ids : null;
}

/** One packaged sticker as the packaging step encoded it (`build_library.py --packaged`). */
interface PackagedEntry {
  readonly file: string;
  readonly thumb: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly thumbBytes: number;
  readonly width: number;
  readonly height: number;
  readonly sharpSize: number;
}

/** A packaged set's manifest: the library commit it was built from, and its files. */
interface PackagedManifest {
  readonly commit: string;
  readonly items: Readonly<Record<string, PackagedEntry>>;
}

/** Where a sticker's file comes from, and what it must be. */
interface StickerSource {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number | undefined;
  readonly width: number | null;
  readonly height: number | null;
  readonly sharpSize: number | null;
  /** Set for a file outside the app's archive: read bounded, a regular file only. */
  readonly maxBytes?: number;
}

const positiveInteger = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;

/**
 * One manifest entry, checked field by field: the files must be the sticker's own, the digest a
 * digest, and every number one packaging could have written. Nothing in it reaches a project
 * unchecked, because the set lives outside the app's archive.
 */
function packagedEntry(id: string, raw: unknown): PackagedEntry | null {
  if (!STICKER_ID_PATTERN.test(id) || typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (entry.file !== bundledFile(id) || entry.thumb !== `thumbs/${id}.webp`) return null;
  if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) return null;
  if (!positiveInteger(entry.bytes, MAX_PACKAGED_STICKER_BYTES)) return null;
  if (!positiveInteger(entry.thumbBytes, MAX_PACKAGED_TILE_BYTES)) return null;
  for (const edge of [entry.width, entry.height, entry.sharpSize]) {
    if (!positiveInteger(edge, MAX_STICKER_EDGE_PX)) return null;
  }
  return entry as unknown as PackagedEntry;
}

/** ENOSPC has one honest answer, and it is not "the copy failed". */
const isDiskFull = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === 'ENOSPC';

export class ElementsLibrary {
  private readonly io: ElementsLibraryIO;
  /** One copy per (project, element) at a time: a double-click or two agent calls copy once. */
  private readonly inFlight = new Map<string, Promise<ElementMaterializeResult>>();
  /** Folders already swept of temporary files an earlier, crashed process left. */
  private readonly swept = new Set<string>();
  /** The packaged set's manifest, read once; `null` when this build has no usable set. */
  private manifest: Promise<PackagedManifest | null> | undefined;

  constructor(private readonly options: ElementsLibraryOptions) {
    this.io = options.io ?? nodeElementsLibraryIO;
  }

  /**
   * Put the sticker `elementId` into the project `projectId` and return the asset to place.
   *
   * @returns the asset (with `deduped: true` when the project already had the file), or a closed
   *   error code: `unknown_element`, `library_missing`, `integrity_failed`, `disk_full`,
   *   `io_failed`.
   */
  materialize(request: ElementMaterializeRequest): Promise<ElementMaterializeResult> {
    const key = `${request.projectId}\u0000${request.elementId}`;
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const started = this.materializeUnshared(request)
      // Nothing thrown reaches the renderer or the model: an error's text can carry paths.
      .catch((error: unknown): ElementMaterializeResult => {
        log.error('materialize: unexpected failure', {
          elementId: request.elementId,
          error: String(error),
        });
        return { ok: false, error: 'io_failed' };
      })
      .then((result) => {
        this.options.onOutcome?.(
          result.ok
            ? { ok: true, deduped: result.asset.deduped }
            : { ok: false, error: result.error },
        );
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  /**
   * Put back the sticker files a project references but no longer has (auto-heal on open,
   * plan/elements EL6a.6b): each is re-copied from the library by its catalogue id to the path
   * the project already records, so it plays again without a relink. A file somewhere else (a
   * project copied from another) is left for the user to relink, and nothing is copied for it.
   *
   * Never throws: a sticker it cannot put back is reported, and the project still opens.
   *
   * @returns the asset ids healed, and those that could not be.
   */
  async heal(project: {
    readonly id: string;
    readonly assets: readonly {
      readonly id: string;
      readonly path: string;
      readonly source?: { readonly provider: string; readonly remoteId: string } | null | undefined;
    }[];
  }): Promise<{ readonly healed: readonly string[]; readonly failed: readonly string[] }> {
    const healed: string[] = [];
    const failed: string[] = [];
    let catalog: StickerCatalog | undefined;
    try {
      catalog = await this.options.catalog();
    } catch (error) {
      log.warn('heal: the sticker catalogue did not load', { error: String(error) });
    }
    // Which sticker files are missing, decided before any is copied back: two assets sharing a
    // file are both missing, and both healed by the one copy.
    const missing: { readonly id: string; readonly path: string; readonly remoteId: string }[] = [];
    for (const asset of project.assets) {
      const source = asset.source;
      if (source === null || source === undefined) continue;
      if (!ELEMENT_PROVIDERS.includes(source.provider)) continue;
      try {
        if (await this.io.exists(resolveWithin(this.options.projectsRoot, asset.path))) continue;
        if (catalog === undefined || source.provider !== catalog.provider) failed.push(asset.id);
        else missing.push({ id: asset.id, path: asset.path, remoteId: source.remoteId });
      } catch (error) {
        log.warn('heal: a sticker file could not be checked', {
          assetId: asset.id,
          error: String(error),
        });
        failed.push(asset.id);
      }
    }
    const copies = new Map<string, Promise<ElementMaterializeResult>>();
    for (const asset of missing) {
      // Only the file's own place in this project is restored; any other is the user's to relink.
      if (asset.path !== stickerPath(project.id, catalog!.library, asset.remoteId)) {
        failed.push(asset.id);
        continue;
      }
      let copy = copies.get(asset.remoteId);
      if (copy === undefined) {
        copy = this.materialize({ projectId: project.id, elementId: asset.remoteId });
        copies.set(asset.remoteId, copy);
      }
      const result = await copy;
      if (result.ok && result.asset.path === asset.path) healed.push(asset.id);
      else failed.push(asset.id);
    }
    if (healed.length > 0 || failed.length > 0) {
      log.action('heal', { projectId: project.id, healed: healed.length, failed: failed.length });
    }
    return { healed, failed };
  }

  private async materializeUnshared(
    request: ElementMaterializeRequest,
  ): Promise<ElementMaterializeResult> {
    const startedAt = Date.now();
    if (!STICKER_ID_PATTERN.test(request.elementId)) {
      return { ok: false, error: 'unknown_element' };
    }
    let catalog: StickerCatalog;
    try {
      catalog = await this.options.catalog();
    } catch (error) {
      log.error('materialize: the sticker catalogue did not load', { error: String(error) });
      return { ok: false, error: 'library_missing' };
    }
    const item = catalog.byId.get(request.elementId);
    if (item === undefined) return { ok: false, error: 'unknown_element' };
    const found = await this.sourceOf(item, catalog);
    if (found === null) return { ok: false, error: 'library_missing' };
    const relativePath = stickerPath(request.projectId, catalog.library, item.id);
    let target: string;
    try {
      target = resolveWithin(this.options.projectsRoot, relativePath);
    } catch {
      // The project's media folder leads outside the projects folder (a link to another drive).
      // The sandbox's message names both paths, so it is logged here and never passed on.
      log.warn('materialize: the project media folder is outside the projects folder', {
        elementId: item.id,
      });
      return { ok: false, error: 'io_failed' };
    }
    const asset = (deduped: boolean): ElementAssetWire => ({
      id: sourcedAssetId('element', catalog.library, item.id),
      path: relativePath,
      kind: 'image',
      media: { width: found.width, height: found.height },
      sharpSize: found.sharpSize,
      source: {
        provider: catalog.provider,
        remoteId: item.id,
        license: catalog.license,
        licenseUrl: catalog.licenseUrl,
        attributionRequired: catalog.attributionRequired,
        attribution: catalog.attribution,
        creator: catalog.creator,
        sourceUrl: stickerSourceUrl(catalog, item),
        fetchedAt: (this.options.now?.() ?? new Date()).toISOString(),
      },
      deduped,
    });

    try {
      // A copy of the wrong size is replaced without reading it.
      const size = await this.io.size(target);
      if (size !== null && (found.bytes === undefined || size === found.bytes)) {
        const present = await this.io.readFile(target);
        if (sha256(present) === found.sha256) {
          log.action('materialize', {
            elementId: item.id,
            deduped: true,
            ms: Date.now() - startedAt,
          });
          return { ok: true, asset: asset(true) };
        }
      }
    } catch (error) {
      log.warn('materialize: could not read the existing copy; copying again', {
        elementId: item.id,
        error: String(error),
      });
    }

    const source = found.path;
    let bytes: Buffer;
    try {
      bytes =
        found.maxBytes === undefined
          ? await this.io.readFile(source)
          : await this.io.readBounded(source, found.maxBytes);
    } catch {
      log.error('materialize: sticker file missing', {
        elementId: item.id,
        availability: item.availability,
      });
      return { ok: false, error: 'library_missing' };
    }
    if (sha256(bytes) !== found.sha256) {
      log.error('materialize: sticker file does not match its record', {
        elementId: item.id,
        availability: item.availability,
      });
      return { ok: false, error: 'integrity_failed' };
    }

    const temp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await this.io.mkdir(path.dirname(target));
      await this.sweep(path.dirname(target));
      await this.io.writeFile(temp, bytes);
      await this.io.rename(temp, target);
    } catch (error) {
      await this.io.unlink(temp).catch(() => undefined);
      if (isDiskFull(error)) return { ok: false, error: 'disk_full' };
      log.error('materialize: copy failed', { elementId: item.id, error: String(error) });
      return { ok: false, error: 'io_failed', detail: path.basename(target) };
    }
    log.action('materialize', {
      elementId: item.id,
      deduped: false,
      bytes: bytes.length,
      ms: Date.now() - startedAt,
    });
    return { ok: true, asset: asset(false) };
  }

  /**
   * Where `item`'s file is and what it must be: a bundled sticker from the renderer's folder,
   * checked against the catalogue; a packaged one from the installer's set, checked against the
   * manifest that set was built with. `null` when this build does not have it (a packaged sticker
   * without the set, a set built for another library) or a record names a file that is not the
   * sticker's own (the generator names every file after its id).
   */
  private async sourceOf(
    item: StickerItem,
    catalog: StickerCatalog,
  ): Promise<StickerSource | null> {
    if (item.availability === 'bundled') {
      if (item.file !== bundledFile(item.id) || item.sha256 === undefined) {
        log.error('materialize: a catalogue entry names a file that is not its own', {
          elementId: item.id,
        });
        return null;
      }
      return {
        path: path.join(this.options.bundledRoot(), item.file),
        sha256: item.sha256,
        bytes: item.bytes,
        width: item.width ?? null,
        height: item.height ?? null,
        sharpSize: item.sharpSize ?? null,
      };
    }
    const manifest = await this.packagedManifest(catalog);
    const entry = manifest?.items[item.id];
    const root = this.options.packagedRoot?.() ?? null;
    if (entry === undefined || root === null) return null;
    let file: string;
    try {
      // The real path: a file linked out of the set is not the sticker's.
      file = resolveWithin(root, entry.file);
    } catch {
      log.error('materialize: a packaged sticker file leads outside the set', {
        elementId: item.id,
      });
      return null;
    }
    return {
      path: file,
      sha256: entry.sha256,
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
      sharpSize: entry.sharpSize,
      maxBytes: entry.bytes,
    };
  }

  /**
   * The packaged set's manifest, read once. `null` when this build has no set, or has one built
   * for another library commit (its files would not be the catalogue's stickers).
   */
  private packagedManifest(catalog: StickerCatalog): Promise<PackagedManifest | null> {
    this.manifest ??= (async (): Promise<PackagedManifest | null> => {
      const root = this.options.packagedRoot?.() ?? null;
      if (root === null) return null;
      try {
        const parsed = JSON.parse(
          (await this.io.readFile(path.join(root, 'manifest.json'))).toString('utf8'),
        ) as { commit?: unknown; items?: unknown };
        if (typeof parsed.items !== 'object' || parsed.items === null) return null;
        if (parsed.commit !== catalog.commit) {
          log.warn('the packaged sticker set was built for another library; it is not used', {});
          return null;
        }
        const items: Record<string, PackagedEntry> = {};
        for (const [id, raw] of Object.entries(parsed.items)) {
          const entry = packagedEntry(id, raw);
          if (entry === null) {
            // One entry packaging could not have written means the manifest is not packaging's.
            log.error('the packaged sticker manifest is malformed; the set is not used', {});
            return null;
          }
          items[id] = entry;
        }
        return { commit: parsed.commit, items };
      } catch {
        return null;
      }
    })();
    return this.manifest;
  }

  /**
   * Packaged stickers' tiles (EL6b), for the Stickers tab to show as `blob:` URLs. Only packaged
   * stickers come this way: a bundled one's tile is a file the renderer ships. An id that is not
   * a packaged sticker in this build is skipped; an empty list asks only whether the set is here.
   */
  async thumbnails(elementIds: readonly string[]): Promise<ElementThumbnailResult> {
    let catalog: StickerCatalog;
    try {
      catalog = await this.options.catalog();
    } catch {
      return { ok: false, error: 'library_missing' };
    }
    const manifest = await this.packagedManifest(catalog);
    const root = this.options.packagedRoot?.() ?? null;
    if (manifest === null || root === null) return { ok: true, packaged: false, thumbs: [] };
    const thumbs: ElementThumbnailWire[] = [];
    for (const elementId of elementIds.slice(0, MAX_THUMBNAILS_PER_REQUEST)) {
      if (!STICKER_ID_PATTERN.test(elementId)) continue;
      if (catalog.byId.get(elementId)?.availability !== 'packaged') continue;
      const entry = manifest.items[elementId];
      if (entry === undefined) continue;
      try {
        // In the set by its real path, a regular file, no larger than the manifest says.
        const data = await this.io.readBounded(resolveWithin(root, entry.thumb), entry.thumbBytes);
        if (data.length !== entry.thumbBytes) throw new Error('not the size packaging wrote');
        thumbs.push({ elementId, webp: new Uint8Array(data) });
      } catch {
        log.warn('thumbnails: a packaged tile is missing or not the one packaging wrote', {
          elementId,
        });
      }
    }
    return { ok: true, packaged: true, thumbs };
  }

  /**
   * Remove the temporary files a crashed copy left in `dir`, once per folder: only another
   * process's (the pid is in the name), so a copy this process is making is never touched.
   */
  private async sweep(dir: string): Promise<void> {
    if (this.swept.has(dir)) return;
    this.swept.add(dir);
    for (const name of await this.io.list(dir)) {
      const parts = name.split('.');
      if (parts.at(-1) !== 'tmp' || parts.length < 4 || parts.at(-3) === String(process.pid)) {
        continue;
      }
      await this.io.unlink(path.join(dir, name)).catch(() => undefined);
    }
  }
}

/** Where a library sticker lives in a project: `media/<project>/elements/<library>/<id>.webp`. */
function stickerPath(projectId: string, library: string, itemId: string): string {
  return path.posix.join(mediaRelativeDir(projectId), 'elements', library, `${itemId}.webp`);
}

/** The bundled file the library build writes for an item. */
function bundledFile(itemId: string): string {
  return `full/${itemId}.webp`;
}

/**
 * Where the packaged sticker set is (EL6b): the installer's `extraResources`
 * (`<resources>/elements/stickers`), or the folder `pnpm build:elements` writes in a development
 * tree (`apps/desktop/elements-packaged`, absent until someone builds it).
 *
 * @param mainDir - The compiled main process's directory (`apps/desktop/dist`).
 * @param resourcesPath - `process.resourcesPath` of the running app.
 */
export function packagedStickersRoot(
  mainDir: string,
  isPackaged: boolean,
  resourcesPath: string,
): string {
  if (isPackaged) return path.join(resourcesPath, 'elements', 'stickers');
  return path.resolve(mainDir, '..', 'elements-packaged');
}

/**
 * Where the bundled sticker files are: inside the packaged renderer (`renderer/elements/stickers`,
 * which electron-builder packs with the renderer), or the web editor's `public/` folder in a
 * development tree.
 *
 * @param mainDir - The compiled main process's directory (`apps/desktop/dist`).
 */
export function bundledStickersRoot(mainDir: string, isPackaged: boolean): string {
  const packaged = path.join(mainDir, '..', 'renderer', 'elements', 'stickers');
  if (isPackaged) return packaged;
  return path.resolve(mainDir, '..', '..', 'web-editor', 'public', 'elements', 'stickers');
}
